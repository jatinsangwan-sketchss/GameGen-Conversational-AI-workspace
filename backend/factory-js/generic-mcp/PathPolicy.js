/**
 * PathPolicy
 * -----------------------------------------------------------------------------
 * Generic provenance + existence policy for path-like args.
 *
 * Existing refs and new paths are different categories:
 * - Existing refs (`must_exist`) should be resolved against project index.
 * - Synthesized/create-intent paths (`may_not_exist_yet`) are output targets and
 *   must not fail resolution just because they do not exist before execution.
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

function firstNonEmpty(...vals) {
  for (const v of vals) {
    const s = safeString(v).trim();
    if (s) return s;
  }
  return null;
}

export function hasCreationIntent(args) {
  const a = isPlainObject(args) ? args : {};
  const c = isPlainObject(a.creationIntent) ? a.creationIntent : {};
  const requestedName = firstNonEmpty(
    a.requestedName,
    a.requested_name,
    a.sceneName,
    a.fileName,
    a.resourceName,
    c.requestedName,
    c.name
  );
  const targetFolder = firstNonEmpty(a.targetFolder, a.target_folder, a.folder, a.directory, c.targetFolder, c.folder);
  const resourceKind = firstNonEmpty(a.resourceKind, a.resource_kind, a.kind, c.resourceKind, c.kind);
  const rootNodeType = firstNonEmpty(a.rootNodeType, a.root_node_type, c.rootNodeType, c.root_node_type);
  const hasCreateFlag =
    a.create === true ||
    a.isCreate === true ||
    a.isNew === true ||
    c.create === true ||
    c.isCreate === true ||
    c.isNew === true;
  // Keep this generic: creation intent is inferred from semantic creation fields,
  // not from tool names. `name` alone is intentionally excluded to avoid treating
  // node/property names as create-path intent.
  return Boolean(requestedName || targetFolder || resourceKind || rootNodeType || hasCreateFlag);
}

export function isPathLikeArg(argKey) {
  const nk = normalizeKey(argKey);
  if (!nk) return false;
  if (nk.includes("nodepath") || nk.includes("parentpath") || nk.includes("targetnode")) return false;
  return nk.endsWith("path") || nk.includes("filepath") || nk.includes("scenepath") || nk.includes("resourcepath") || nk.includes("scriptpath");
}

export function defaultPathPolicyForArg(argKey, args, { synthesized = false, sessionInjected = false } = {}) {
  const nk = normalizeKey(argKey);
  if (sessionInjected) {
    return { provenance: "session_injected", existencePolicy: "must_exist" };
  }
  if (synthesized) {
    return { provenance: "synthesized_new_path", existencePolicy: "may_not_exist_yet" };
  }
  if (!isPathLikeArg(nk)) {
    return { provenance: "user_supplied_exact_path", existencePolicy: "must_exist" };
  }
  if (hasCreationIntent(args)) {
    return { provenance: "user_supplied_exact_path", existencePolicy: "may_not_exist_yet" };
  }
  return { provenance: "user_supplied_exact_path", existencePolicy: "must_exist" };
}

