/**
 * PropertyValueCoercer
 * -----------------------------------------------------------------------------
 * Converts loosely-typed planner/property payload values into Godot-friendly
 * structured values when possible (vectors, colors, resources).
 *
 * This helper is pure and side-effect free. It does not read files or call MCP.
 */

function safeString(value) {
  return value == null ? "" : String(value);
}
function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function parseNumericMaybe(value) {
  if (isFiniteNumber(value)) return value;
  const text = safeString(value).trim();
  if (!text) return null;
  const num = Number(text);
  return Number.isFinite(num) ? num : null;
}

function parseVectorLiteral(raw) {
  const text = safeString(raw).trim();
  const m = text.match(/^Vector([2-4])\s*\(([^)]*)\)$/i);
  if (!m) return null;
  const dim = Number(m[1]);
  const parts = safeString(m[2]).split(",").map((p) => parseNumericMaybe(p.trim()));
  if (parts.length !== dim || parts.some((p) => p == null)) return null;
  const keys = ["x", "y", "z", "w"].slice(0, dim);
  const out = { type: `Vector${dim}` };
  for (let i = 0; i < keys.length; i += 1) {
    out[keys[i]] = parts[i];
  }
  return out;
}

function normalizeVectorObject(value) {
  if (!isPlainObject(value)) return null;
  const keys = Object.keys(value);
  const numericKeys = ["x", "y", "z", "w"].filter((k) => Object.prototype.hasOwnProperty.call(value, k));
  if (numericKeys.length < 2 || numericKeys.length > 4) return null;
  if (!numericKeys.every((k) => parseNumericMaybe(value[k]) != null)) return null;
  const sorted = [...numericKeys].sort().join(",");
  let dim = 0;
  if (sorted === "x,y") dim = 2;
  else if (sorted === "x,y,z") dim = 3;
  else if (sorted === "w,x,y,z") dim = 4;
  if (!dim) return null;
  const out = {};
  const extras = keys.filter((k) => !["x", "y", "z", "w", "type"].includes(k));
  if (extras.length > 0) return null;
  const type = safeString(value.type).trim();
  out.type = type || `Vector${dim}`;
  for (const k of ["x", "y", "z", "w"].slice(0, dim)) {
    out[k] = parseNumericMaybe(value[k]);
  }
  return out;
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
  const normalizedVectorObject = normalizeVectorObject(value);
  if (normalizedVectorObject) return normalizedVectorObject;
  if (hasResourceShape(value)) {
    const p = toGodotPath(value.path);
    if (!p) return value;
    return { type: "Resource", path: p };
  }
  if (typeof value !== "string") return value;
  const raw = safeString(value).trim();
  if (!raw) return value;
  const vectorLiteral = parseVectorLiteral(raw);
  if (vectorLiteral) return vectorLiteral;

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
