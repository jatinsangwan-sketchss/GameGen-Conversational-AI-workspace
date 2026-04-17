/**
 * ArgRoleClassifier
 * -----------------------------------------------------------------------------
 * Generic planner/resolver boundary metadata for live MCP tool arguments.
 *
 * Roles:
 * - session_injected  : supplied by active session context (e.g. projectPath)
 * - semantic_ref      : user-provided semantic reference (sceneRef/nodeRef/fileRef/...)
 * - direct_user_value : user must provide concrete value directly
 * - optional          : not required by MCP schema
 */

function safeString(value) {
  return value == null ? "" : String(value);
}

function isPlainObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function normalizeKey(key) {
  // Canonical key identity for schema/planner/resolver matching.
  // We intentionally drop underscores so `node_ref`, `nodeRef`, and `node-ref`
  // collapse to the same token family (`noderef`).
  return safeString(key).toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isSessionInjectedKey(nk) {
  return (
    nk.includes("projectpath") ||
    nk.includes("projectroot") ||
    nk.includes("projectref") ||
    nk.includes("project_root") ||
    nk.includes("project_path") ||
    nk.includes("project_ref")
  );
}

function isNodeTargetKey(nk) {
  return (
    nk.includes("nodepath") ||
    nk.includes("noderef") ||
    nk.includes("targetnode") ||
    nk.includes("parentpath")
  );
}

function isSemanticRefKey(nk) {
  if (!nk) return false;
  if (isSessionInjectedKey(nk)) return false;
  if (isNodeTargetKey(nk)) return false;
  if (
    nk.includes("sceneref") ||
    nk.includes("scriptref") ||
    nk.includes("resourceref") ||
    nk.includes("textureref") ||
    nk.includes("fileref") ||
    nk.includes("artifactref")
  ) {
    return true;
  }
  return nk.endsWith("ref");
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

export function semanticSlotForArg(argName) {
  const raw = safeString(argName).trim();
  const nk = normalizeKey(raw);
  if (!nk) return raw;
  if (isSessionInjectedKey(nk)) return "projectPath";
  if (nk.includes("sceneref")) return "sceneRef";
  if (nk.includes("scenepath")) return "sceneRef";
  if (nk.includes("parentnoderef")) return "parentNodeRef";
  if (nk.includes("parentpath")) return "parentNodeRef";
  if (nk.includes("targetnoderef")) return "targetNodeRef";
  if (nk.includes("targetnode")) return "targetNodeRef";
  if (nk.includes("noderef")) return "nodeRef";
  if (nk.includes("nodepath")) return "nodeRef";
  if (nk.includes("scriptref")) return "scriptRef";
  if (nk.includes("scriptpath")) return "scriptRef";
  if (nk.includes("resourceref")) return "resourceRef";
  if (nk.includes("resourcepath")) return "resourceRef";
  if (nk.includes("textureref")) return "textureRef";
  if (nk.includes("texturepath")) return "textureRef";
  if (nk.includes("artifactref")) return "artifactRef";
  if (nk.includes("fileref")) return "fileRef";
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
  if (lowerSlot === "sceneref") {
    out.add("sceneRef");
    out.add("scenePath");
    out.add("scene_path");
  }
  if (lowerSlot === "noderef") {
    out.add("nodeRef");
    out.add("targetNodeRef");
    out.add("parentNodeRef");
    out.add("nodePath");
    out.add("targetNodePath");
    out.add("parentPath");
    out.add("node_path");
    out.add("target_node_path");
    out.add("parent_path");
  }
  if (lowerSlot === "targetnoderef") {
    out.add("targetNodeRef");
    out.add("nodeRef");
    out.add("parentNodeRef");
    out.add("targetNodePath");
    out.add("nodePath");
    out.add("parentPath");
    out.add("target_node_path");
    out.add("node_path");
    out.add("parent_path");
  }
  if (lowerSlot === "parentnoderef") {
    out.add("parentNodeRef");
    out.add("nodeRef");
    out.add("targetNodeRef");
    out.add("parentPath");
    out.add("nodePath");
    out.add("targetNodePath");
    out.add("parent_path");
    out.add("node_path");
    out.add("target_node_path");
  }
  if (lowerSlot === "fileref") {
    out.add("fileRef");
    out.add("filePath");
    out.add("path");
    out.add("file_path");
  }
  if (lowerSlot === "resourceref") {
    out.add("resourceRef");
    out.add("resourcePath");
    out.add("resource_path");
  }
  if (lowerSlot === "scriptref") {
    out.add("scriptRef");
    out.add("scriptPath");
    out.add("script_path");
  }
  if (lowerSlot === "textureref") {
    out.add("textureRef");
    out.add("texturePath");
    out.add("texture_path");
  }
  if (lowerSlot === "propertymap") {
    out.add("propertyMap");
    out.add("properties");
    out.add("props");
    out.add("property_map");
  }
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
  if (isSemanticRefKey(nk)) {
    return { argName: raw, normalizedName: nk, required: true, role: "semantic_ref", semanticSlot: semanticSlotForArg(raw) };
  }
  if (isPathLikeKey(nk) || isNodeTargetKey(nk)) {
    return { argName: raw, normalizedName: nk, required: true, role: "semantic_ref", semanticSlot: semanticSlotForArg(raw) };
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
