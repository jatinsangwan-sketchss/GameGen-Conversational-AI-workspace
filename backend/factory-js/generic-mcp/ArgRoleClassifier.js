/**
 * ArgRoleClassifier
 * -----------------------------------------------------------------------------
 * Generic planner/resolver boundary metadata for live MCP tool arguments.
 *
 * Roles:
 * - session_injected         : supplied by active session context (e.g. projectPath)
 * - semantic_ref             : user-provided semantic reference (sceneRef/nodeRef/fileRef/...)
 * - creation_intent_derived  : output path that can be derived from creation intent
 * - direct_user_value        : user must provide concrete value directly
 * - optional                 : not required by MCP schema
 */

function safeString(value) {
  return value == null ? "" : String(value);
}

function isPlainObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function normalizeKey(key) {
  return safeString(key).toLowerCase().replace(/[^a-z0-9_]/g, "");
}

function words(input) {
  return safeString(input)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

function isSessionInjectedKey(nk) {
  return (
    nk.includes("projectpath") ||
    nk.includes("projectroot") ||
    nk.includes("project_root") ||
    nk.includes("project_path")
  );
}

function isNodeTargetKey(nk) {
  return (
    nk.includes("nodepath") ||
    nk.includes("targetnode") ||
    nk.includes("parentpath")
  );
}

function isPathLikeKey(nk) {
  if (!nk) return false;
  return (
    nk.includes("scenepath") ||
    nk.includes("scriptpath") ||
    nk.includes("resourcepath") ||
    nk.includes("texturepath") ||
    nk.includes("filepath") ||
    nk === "path" ||
    nk.endsWith("path")
  );
}

function toolHints(toolName, inputSchema) {
  const toks = [
    ...words(toolName),
    ...words(inputSchema?.title),
    ...words(inputSchema?.description),
  ];
  const tokenSet = new Set(toks);
  const createLike = toks.some((t) =>
    ["create", "new", "save", "write", "generate", "export", "scaffold", "init"].includes(t)
  );
  return {
    createLike,
    mentionsScene: tokenSet.has("scene") || tokenSet.has("scenes"),
    mentionsNode: tokenSet.has("node") || tokenSet.has("nodes"),
    tokens: tokenSet,
  };
}

function shouldTreatAsCreationOutputPath(nk, hints) {
  if (!hints.createLike) return false;
  if (nk.includes("scriptpath")) return true;
  if (nk.includes("resourcepath")) return true;
  if (nk.includes("texturepath")) return true;
  if (nk.includes("filepath") || nk === "path") return true;
  if (nk.includes("scenepath")) {
    // Scene paths are derivable for create/new/save scene flows, but not for
    // node-edit flows that happen "in scene X".
    if (!hints.mentionsScene) return false;
    if (hints.mentionsNode && !hints.tokens.has("save")) return false;
    return true;
  }
  return nk.endsWith("path") && !isNodeTargetKey(nk) && !isSessionInjectedKey(nk);
}

export function semanticSlotForArg(argName) {
  const raw = safeString(argName).trim();
  const nk = normalizeKey(raw);
  if (!nk) return raw;
  if (isSessionInjectedKey(nk)) return "projectPath";
  if (nk.includes("scenepath")) return "sceneRef";
  if (nk.includes("parentpath")) return "parentNodeRef";
  if (nk.includes("targetnode")) return "targetNodeRef";
  if (nk.includes("nodepath")) return "nodeRef";
  if (nk.includes("scriptpath")) return "scriptRef";
  if (nk.includes("resourcepath")) return "resourceRef";
  if (nk.includes("texturepath")) return "textureRef";
  if (nk.includes("filepath") || nk === "path") return "fileRef";
  if (nk.endsWith("path")) return `${raw.replace(/Path$/i, "").replace(/_path$/i, "")}Ref`;
  if (nk.includes("nodetype")) return "nodeType";
  if (nk === "name" || nk.endsWith("name")) return "name";
  if (nk.includes("properties")) return "propertyMap";
  return raw;
}

export function semanticArgCandidates(argName, semanticSlot) {
  const out = new Set();
  const arg = safeString(argName).trim();
  const slot = safeString(semanticSlot).trim();
  if (arg) out.add(arg);
  if (slot) out.add(slot);
  const lowerSlot = slot.toLowerCase();
  if (lowerSlot === "sceneref") out.add("sceneRef");
  if (lowerSlot === "noderef") {
    out.add("nodeRef");
    out.add("targetNodeRef");
    out.add("parentNodeRef");
  }
  if (lowerSlot === "targetnoderef") {
    out.add("targetNodeRef");
    out.add("nodeRef");
  }
  if (lowerSlot === "parentnoderef") {
    out.add("parentNodeRef");
    out.add("nodeRef");
  }
  if (lowerSlot === "fileref") out.add("fileRef");
  if (lowerSlot === "resourceref") out.add("resourceRef");
  if (lowerSlot === "scriptref") out.add("scriptRef");
  if (lowerSlot === "textureref") out.add("textureRef");
  if (lowerSlot === "name") out.add("requestedName");
  return [...out].filter(Boolean);
}

export function classifyArgRole({ argName, required = false, toolName = "", inputSchema = null } = {}) {
  const raw = safeString(argName).trim();
  const nk = normalizeKey(raw);
  if (!raw) {
    return { argName: raw, normalizedName: nk, required: Boolean(required), role: "optional", semanticSlot: raw };
  }
  if (!required) {
    return { argName: raw, normalizedName: nk, required: false, role: "optional", semanticSlot: semanticSlotForArg(raw) };
  }
  if (isSessionInjectedKey(nk)) {
    return { argName: raw, normalizedName: nk, required: true, role: "session_injected", semanticSlot: "projectPath" };
  }
  if (isPathLikeKey(nk) || isNodeTargetKey(nk)) {
    const hints = toolHints(toolName, inputSchema);
    const role = shouldTreatAsCreationOutputPath(nk, hints)
      ? "creation_intent_derived"
      : "semantic_ref";
    return { argName: raw, normalizedName: nk, required: true, role, semanticSlot: semanticSlotForArg(raw) };
  }
  return { argName: raw, normalizedName: nk, required: true, role: "direct_user_value", semanticSlot: semanticSlotForArg(raw) };
}

export function classifyToolArgs({ toolName = "", inputSchema = null, args = null } = {}) {
  const schema = isPlainObject(inputSchema) ? inputSchema : {};
  const required = Array.isArray(schema.required)
    ? schema.required.map((k) => safeString(k).trim()).filter(Boolean)
    : [];
  const propKeys = isPlainObject(schema.properties) ? Object.keys(schema.properties) : [];
  const argKeys = isPlainObject(args) ? Object.keys(args) : [];
  const keySet = new Set([...required, ...propKeys, ...argKeys]);
  const requiredSet = new Set(required);
  const rolesByArg = {};
  for (const key of keySet) {
    rolesByArg[key] = classifyArgRole({
      argName: key,
      required: requiredSet.has(key),
      toolName,
      inputSchema: schema,
    });
  }
  return {
    required,
    rolesByArg,
  };
}

export function isNodeRefSlot(slot) {
  const s = safeString(slot).toLowerCase();
  return s.includes("noderef");
}
