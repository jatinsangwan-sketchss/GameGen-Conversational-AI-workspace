/**
 * PathSynthesizer
 * -----------------------------------------------------------------------------
 * Generic synthesis for **new resource paths** (create/new operations).
 *
 * Distinction (ArgumentResolver uses both):
 * - **Existing resource refs** — resolve against project index / fuzzy match.
 * - **New resource path args** — `scenePath` / `filePath` / `resourcePath` etc. are
 *   outputs of creation intent (name + folder + inferred extension), not lookups.
 *
 * No per-tool Godot handlers: rules are driven by argument name patterns, optional
 * `resourceKind`, and schema-agnostic `creationIntent` / flat intent fields.
 */

function safeString(value) {
  return value == null ? "" : String(value);
}

function isPlainObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

export function normalizeArgKey(key) {
  return safeString(key).toLowerCase().replace(/[^a-z0-9_]/g, "");
}

function firstNonEmpty(...vals) {
  for (const v of vals) {
    const s = safeString(v).trim();
    if (s) return s;
  }
  return null;
}

function inferResourceKindFromRequestedName(requestedName) {
  const raw = safeString(requestedName).trim().toLowerCase();
  if (!raw) return null;
  const normalized = raw.replace(/\\/g, "/");
  if (normalized.endsWith(".gd")) return "script";
  if (normalized.endsWith(".tscn")) return "scene";
  if (normalized.endsWith(".tres") || normalized.endsWith(".res")) return "resource";
  return null;
}

/**
 * Structured creation intent from planner args (flat and/or nested `creationIntent`).
 */
export function extractCreationIntent(args) {
  const a = isPlainObject(args) ? args : {};
  const c = isPlainObject(a.creationIntent) ? a.creationIntent : {};
  const requestedName = firstNonEmpty(
    a.requestedName,
    a.requested_name,
    a.name,
    a.sceneName,
    a.fileName,
    a.resourceName,
    c.requestedName,
    c.requested_name,
    c.name
  );
  const explicitKind =
    firstNonEmpty(a.resourceKind, a.resource_kind, a.kind, c.resourceKind, c.kind)?.toLowerCase() ?? null;
  return {
    requestedName,
    targetFolder: firstNonEmpty(a.targetFolder, a.target_folder, a.folder, a.directory, c.targetFolder, c.folder),
    resourceKind: explicitKind || inferResourceKindFromRequestedName(requestedName),
    rootNodeType: firstNonEmpty(a.rootNodeType, a.root_node_type, c.rootNodeType) ?? null,
  };
}

/** Maps resourceKind hints to extension + optional default folder segment. */
const KIND_TO_SPEC = {
  scene: { ext: ".tscn", defaultFolder: "scenes" },
  script: { ext: ".gd", defaultFolder: "scripts" },
  resource: { ext: ".tres", defaultFolder: null },
};

/**
 * Infer extension and folder policy from a normalized arg key and optional resourceKind.
 * `needsExplicitFolder` means: no generic default folder — caller must have targetFolder.
 */
export function inferCreationPathSpec(normalizedKey, resourceKind) {
  const nk = safeString(normalizedKey).trim();
  const kind = resourceKind ? safeString(resourceKind).trim().toLowerCase() : null;
  const isNodeOrProjectPathArg =
    nk.includes("nodepath") ||
    nk.includes("noderef") ||
    nk.includes("targetnode") ||
    nk.includes("parentpath") ||
    nk.includes("parentnode") ||
    nk.includes("projectpath") ||
    nk.includes("projectroot") ||
    nk.includes("projectref");
  if (isNodeOrProjectPathArg) return null;

  if (kind && KIND_TO_SPEC[kind]) {
    const canUseKindFallback =
      nk === "path" ||
      nk.includes("filepath") ||
      nk.includes("artifactpath") ||
      nk.includes("scriptpath") ||
      nk.includes("resourcepath") ||
      nk.includes("texturepath") ||
      nk.includes("scenepath");
    if (!canUseKindFallback) return null;
    return {
      ...KIND_TO_SPEC[kind],
      needsExplicitFolder: KIND_TO_SPEC[kind].defaultFolder == null,
      source: "resourceKind",
    };
  }

  // console.log("nk", nk);

  if (nk.includes("scenepath") || (nk.includes("scene") && nk.endsWith("path"))) {
    return { ext: ".tscn", defaultFolder: "scenes", needsExplicitFolder: false, source: "argKey" };
  }
  if (nk.includes("scriptpath")) {
    return { ext: ".gd", defaultFolder: "scripts", needsExplicitFolder: false, source: "argKey" };
  }
  if (nk.includes("texturepath")) {
    return { ext: ".png", defaultFolder: null, needsExplicitFolder: true, source: "argKey" };
  }
  if (nk.includes("resourcepath")) {
    return { ext: ".tres", defaultFolder: null, needsExplicitFolder: true, source: "argKey" };
  }
  if (nk === "filepath" || nk.endsWith("filepath")) {
    if (kind && KIND_TO_SPEC[kind]) {
      return { ...KIND_TO_SPEC[kind], needsExplicitFolder: KIND_TO_SPEC[kind].defaultFolder == null, source: "resourceKind+argKey" };
    }
    return { ext: null, defaultFolder: null, needsExplicitFolder: true, source: "argKey", needsResourceKind: true };
  }

  if (nk.endsWith("path") && !nk.includes("node") && !nk.includes("project") && !nk.includes("parent")) {
    if (kind && KIND_TO_SPEC[kind]) {
      return { ...KIND_TO_SPEC[kind], needsExplicitFolder: KIND_TO_SPEC[kind].defaultFolder == null, source: "resourceKind+argKey" };
    }
    return null;
  }

  return null;
}

export function sanitizeFileStem(raw) {
  const base = safeString(raw).trim().split(/[/\\]/).pop();
  if (!base) return null;
  let stem = base;
  const lastDot = stem.lastIndexOf(".");
  if (lastDot > 0) stem = stem.slice(0, lastDot);
  stem = stem.replace(/[^a-zA-Z0-9._-]/g, "_").replace(/^[._]+|[._]+$/g, "");
  return stem || null;
}

function normalizeFolderSegment(folder) {
  const s = safeString(folder).trim().replace(/^\/+/, "").replace(/\\/g, "/");
  if (!s) return null;
  return s.replace(/\/+$/, "");
}

function joinRelative(folder, fileName) {
  const f = normalizeFolderSegment(folder);
  const name = safeString(fileName).trim();
  if (!name) return null;
  if (!f) return name;
  return `${f}/${name}`;
}

/**
 * Attempt to build a project-relative path for a missing creation-path argument.
 */
export function synthesizeMissingCreationPath(pathArgKey, args) {
  const nk = normalizeArgKey(pathArgKey);
  const intent = extractCreationIntent(args);
  const spec = inferCreationPathSpec(nk, intent.resourceKind);

  // console.log("spec", spec);

  if (!spec) {
    return { ok: false, reason: "path_arg_not_eligible_for_creation_synthesis", meta: { pathArgKey: nk } };
  }
  if (spec.needsResourceKind && !intent.resourceKind) {
    return { ok: false, reason: "resourceKind_required_for_generic_file_path", meta: { pathArgKey: nk } };
  }
  if (!spec.ext) {
    return { ok: false, reason: "cannot_infer_extension", meta: { pathArgKey: nk } };
  }

  const stem = sanitizeFileStem(intent.requestedName);
  if (!stem) {
    return { ok: false, reason: "missing_requested_name", meta: { pathArgKey: nk } };
  }

  let folder = normalizeFolderSegment(intent.targetFolder);
  if (!folder && spec.defaultFolder) {
    folder = spec.defaultFolder;
  }
  if (!folder && spec.needsExplicitFolder) {
    return { ok: false, reason: "missing_target_folder", meta: { pathArgKey: nk, spec } };
  }
  if (!folder) {
    return { ok: false, reason: "missing_folder", meta: { pathArgKey: nk } };
  }

  const fileName = stem + spec.ext;
  const relativePath = joinRelative(folder, fileName);
  if (!relativePath) {
    return { ok: false, reason: "join_failed", meta: { pathArgKey: nk } };
  }

  return {
    ok: true,
    relativePath,
    meta: {
      pathArgKey,
      sources: {
        requestedName: intent.requestedName,
        targetFolder: intent.targetFolder,
        resourceKind: intent.resourceKind,
        defaultFolderUsed: !normalizeFolderSegment(intent.targetFolder) && spec.defaultFolder ? spec.defaultFolder : null,
      },
      ext: spec.ext,
      finalPath: relativePath,
    },
  };
}

/**
 * Whether this arg name may be filled by creation synthesis (not session project keys).
 */
export function isCreatablePathArgName(key) {
  // console.log("key", key);
  const nk = normalizeArgKey(key);
  if (!nk) return false;
  if (nk.includes("projectpath") || nk.includes("projectroot")) return false;
  return inferCreationPathSpec(nk, null) != null;
}
