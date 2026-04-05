function safeString(value) {
  return value == null ? "" : String(value);
}

function isPlainObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function normalizeRef(input) {
  const s = safeString(input)
    .trim()
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/^res:\/\//i, "")
    .replace(/^\/+/, "")
    .replace(/\\/g, "/");
  return s || null;
}

function toGodotPath(ref) {
  const n = normalizeRef(ref);
  return n ? `res://${n}` : null;
}

function looksLikePathLikeString(value) {
  const s = normalizeRef(value);
  if (!s) return false;
  return /[./\\]/.test(s) || /\.[a-z0-9]{2,8}$/i.test(s);
}

function parseMaybeJsonObject(raw) {
  const text = safeString(raw).trim();
  if (!text) return { ok: false, value: null };
  try {
    const parsed = JSON.parse(text);
    if (!isPlainObject(parsed)) return { ok: false, value: null };
    return { ok: true, value: parsed };
  } catch {
    return { ok: false, value: null };
  }
}

function looksLikePropertyMutationTool(toolName, args) {
  const t = safeString(toolName).toLowerCase();
  const hasProps = ["properties", "propertyMap", "props"].some((k) => Object.prototype.hasOwnProperty.call(args, k));
  const hasValueAndProperty = Object.prototype.hasOwnProperty.call(args, "value") && (
    Object.prototype.hasOwnProperty.call(args, "property") ||
    Object.prototype.hasOwnProperty.call(args, "propertyName") ||
    Object.prototype.hasOwnProperty.call(args, "settingName")
  );
  if (hasProps || hasValueAndProperty) return true;
  return ["set", "update", "edit", "assign", "attach", "change"].some((w) => t.includes(w));
}

function hasResourceShape(value) {
  if (!isPlainObject(value)) return false;
  const type = safeString(value.type).trim().toLowerCase();
  const path = safeString(value.path).trim();
  return Boolean(path) && (type === "resource" || type === "resourceref" || type === "");
}

function findResourceHintInArgs(propertyKey, args) {
  const target = safeString(propertyKey).trim();
  if (!target) return false;
  for (const v of Object.values(isPlainObject(args) ? args : {})) {
    if (!isPlainObject(v)) continue;
    const direct = v[target];
    if (hasResourceShape(direct)) return true;
  }
  return false;
}

function resourceLikePropertyName(propertyKey) {
  const k = safeString(propertyKey).toLowerCase().replace(/[^a-z0-9_]/g, "");
  return ["resource", "script", "texture", "material", "mesh", "font", "shader", "audio", "scene"].some((t) => k.includes(t));
}

function toTypedResource(pathRef) {
  const godotPath = toGodotPath(pathRef);
  if (!godotPath) return null;
  return { type: "Resource", path: godotPath };
}

function coerceSingleValue({ propertyKey = "", value, args, artifactRegistry }) {
  if (hasResourceShape(value)) {
    const p = toGodotPath(value.path);
    if (!p) return value;
    return { type: "Resource", path: p };
  }
  if (typeof value !== "string") return value;
  const raw = safeString(value).trim();
  if (!raw) return value;

  const fromArtifacts = artifactRegistry?.resolveRef?.(raw) ?? { status: "not_found" };
  if (fromArtifacts.status === "resolved" && fromArtifacts.artifact?.godotPath) {
    return { type: "Resource", path: fromArtifacts.artifact.godotPath };
  }

  if (!looksLikePathLikeString(raw)) return value;
  if (!resourceLikePropertyName(propertyKey) && !findResourceHintInArgs(propertyKey, args)) return value;

  return toTypedResource(raw) ?? value;
}

export function coercePropertyLikeArgs({ toolName, args, artifactRegistry = null } = {}) {
  const input = isPlainObject(args) ? args : {};
  if (!looksLikePropertyMutationTool(toolName, input)) {
    return { args: input, changed: false, coercions: [] };
  }
  const out = { ...input };
  const coercions = [];
  let changed = false;

  for (const key of ["properties", "propertyMap", "props"]) {
    if (!Object.prototype.hasOwnProperty.call(out, key)) continue;
    const raw = out[key];
    const wasString = typeof raw === "string";
    const parsed = wasString ? parseMaybeJsonObject(raw) : { ok: isPlainObject(raw), value: raw };
    if (!parsed.ok || !isPlainObject(parsed.value)) continue;
    const mapped = { ...parsed.value };
    for (const [propKey, propVal] of Object.entries(mapped)) {
      const coerced = coerceSingleValue({
        propertyKey: propKey,
        value: propVal,
        args: input,
        artifactRegistry,
      });
      if (coerced !== propVal) {
        mapped[propKey] = coerced;
        changed = true;
        coercions.push({ key, property: propKey, from: propVal, to: coerced });
      }
    }
    out[key] = wasString ? JSON.stringify(mapped) : mapped;
  }

  if (
    Object.prototype.hasOwnProperty.call(out, "value") &&
    (Object.prototype.hasOwnProperty.call(out, "property") ||
      Object.prototype.hasOwnProperty.call(out, "propertyName") ||
      Object.prototype.hasOwnProperty.call(out, "settingName"))
  ) {
    const propertyKey = safeString(out.property || out.propertyName || out.settingName).trim();
    const before = out.value;
    const after = coerceSingleValue({
      propertyKey,
      value: before,
      args: input,
      artifactRegistry,
    });
    if (after !== before) {
      out.value = after;
      changed = true;
      coercions.push({ key: "value", property: propertyKey, from: before, to: after });
    }
  }

  return { args: out, changed, coercions };
}

