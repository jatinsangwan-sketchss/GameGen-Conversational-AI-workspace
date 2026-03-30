/**
 * GoPeakArgumentBuilders
 * ----------------------
 * Canonical operation params -> raw execution argument builders.
 *
 * Canonical params are planner/executor contract fields (e.g. scene_path).
 * Raw args are backend/tool-specific shapes for MCP tools, filesystem actions,
 * CLI actions, and composed operation steps.
 *
 * This file is intentionally translation-only:
 * - no discovery logic
 * - no planning logic
 * - no MCP transport calls
 */

import path from "node:path";

function safeString(v) {
  return v == null ? "" : String(v);
}

function isPlainObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function normalizeResPath(value) {
  const p = safeString(value).trim();
  if (!p) return null;
  if (p.startsWith("res://")) return p;
  return `res://${p.replace(/^\.?\//, "")}`;
}

function normalizeFsPath(value, base = process.cwd()) {
  const p = safeString(value).trim();
  if (!p) return null;
  return path.resolve(base, p);
}

function assertRequiredString(params, key) {
  const val = params?.[key];
  if (!isNonEmptyString(val)) {
    throw new Error(`Missing required parameter: ${key}`);
  }
  return String(val).trim();
}

function withOptionalString(target, key, value) {
  if (isNonEmptyString(value)) target[key] = String(value).trim();
  return target;
}

function getInjectedProjectPath(executionContext = {}) {
  const v =
    executionContext?.projectPath ??
    executionContext?.connectedProjectPath ??
    executionContext?.connected_project_path ??
    executionContext?.project_root ??
    executionContext?.projectRoot ??
    null;
  if (!isNonEmptyString(v)) {
    throw new Error("Missing required injected context: projectPath");
  }
  return String(v).trim();
}

function buildCreateSceneArgs(canonicalParams = {}, executionContext = {}) {
  // Canonical params (registry/planner):
  // - scene_path (planner uses res:// form)
  // - root_node_name (planner intent; GoPeak create-scene tool does NOT expose a root name field)
  // - root_node_type (planner intent)
  //
  // Raw GoPeak `create-scene` MCP contract (from tools/list):
  // - projectPath (required, absolute filesystem path)
  // - scenePath   (required, project-relative path; not res://)
  // - rootNodeType (optional, Godot class name; default Node)
  //
  // Note: root node name cannot be set via this tool contract, so we do NOT
  // attempt to send a name field into the raw args.
  const debug = executionContext?.debug === true || String(process.env.DEBUG_GOPEAK_ARGUMENT_BUILDERS ?? "").toLowerCase() === "true";
  const projectPath = getInjectedProjectPath(executionContext);

  const sceneResPath = normalizeResPath(assertRequiredString(canonicalParams, "scene_path"));
  const sceneFsRel = String(sceneResPath).replace(/^res:\/\//, "").replace(/^\/+/, "");

  const rootNodeType = assertRequiredString(canonicalParams, "root_node_type");
  // Keep canonical root_node_name validation (planner contract), but do not send it.
  void assertRequiredString(canonicalParams, "root_node_name");

  const out = {
    projectPath,
    scenePath: sceneFsRel,
    rootNodeType,
  };

  if (debug) {
    // eslint-disable-next-line no-console
    console.log("[GoPeakArgumentBuilders] buildCreateSceneArgs canonical -> raw", {
      canonical_params: {
        scene_path: canonicalParams?.scene_path ?? null,
        root_node_name: canonicalParams?.root_node_name ?? null,
        root_node_type: canonicalParams?.root_node_type ?? null,
      },
      execution_context: {
        projectPath,
        isBridgeReady: executionContext?.isBridgeReady ?? null,
      },
      raw_args: out,
    });
  }
  return out;
}

function buildAddNodeArgs(canonicalParams = {}, executionContext = {}) {
  const scenePath = normalizeResPath(assertRequiredString(canonicalParams, "scene_path"));
  const nodeName = assertRequiredString(canonicalParams, "node_name");
  const nodeType = assertRequiredString(canonicalParams, "node_type");
  const parentPath = isNonEmptyString(canonicalParams.parent_path)
    ? String(canonicalParams.parent_path).trim()
    : ".";
  const projectPath = getInjectedProjectPath(executionContext);
  const sceneFsRel = String(scenePath).replace(/^res:\/\//, "").replace(/^\/+/, "");
  return {
    // Raw add-node MCP contract uses camelCase payload keys.
    // Keep inspect-first resolved parent path explicit via `parentPath`.
    scenePath: sceneFsRel,
    nodeName,
    nodeType,
    parentPath,
    projectPath,
  };
}

function buildSetNodePropertiesArgs(canonicalParams = {}, executionContext = {}) {
  const scenePath = normalizeResPath(assertRequiredString(canonicalParams, "scene_path"));
  const nodePath = assertRequiredString(canonicalParams, "node_path");
  const properties = canonicalParams.properties;
  if (!isPlainObject(properties) || Object.keys(properties).length === 0) {
    throw new Error("Missing required parameter: properties (non-empty object)");
  }
  const projectPath = getInjectedProjectPath(executionContext);
  return {
    scene_path: scenePath,
    node_path: nodePath,
    properties,
    projectPath,
  };
}

function buildSaveSceneArgs(canonicalParams = {}, executionContext = {}) {
  const scenePath = normalizeResPath(assertRequiredString(canonicalParams, "scene_path"));
  const projectPath = getInjectedProjectPath(executionContext);
  return { scene_path: scenePath, projectPath };
}

function buildAttachScriptSetPropertyParams(canonicalParams = {}) {
  const scenePath = normalizeResPath(assertRequiredString(canonicalParams, "scene_path"));
  const scriptPath = normalizeResPath(assertRequiredString(canonicalParams, "script_path"));
  const nodePath = isNonEmptyString(canonicalParams.node_path)
    ? String(canonicalParams.node_path).trim()
    : ".";
  return {
    scene_path: scenePath,
    node_path: nodePath,
    properties: { script: scriptPath },
  };
}

function buildAttachScriptSaveSceneParams(canonicalParams = {}) {
  // Composed operation helper:
  // Return canonical `save_scene` params only (scene_path).
  // Raw tool args (including projectPath) must be injected inside
  // GodotExecutor when translating the canonical operation.
  const scenePath = normalizeResPath(assertRequiredString(canonicalParams, "scene_path"));
  return { scene_path: scenePath };
}

function buildCreateScriptFileArgs(canonicalParams = {}, { projectRoot = null } = {}) {
  const scriptPath = assertRequiredString(canonicalParams, "script_path");
  const content = assertRequiredString(canonicalParams, "content");
  const fsPath = projectRoot ? normalizeFsPath(scriptPath, projectRoot) : normalizeFsPath(scriptPath);
  return {
    script_path: normalizeResPath(scriptPath),
    script_fs_path: fsPath,
    content,
  };
}

function buildModifyScriptFileArgs(canonicalParams = {}, { projectRoot = null } = {}) {
  const scriptPath = assertRequiredString(canonicalParams, "script_path");
  const content = assertRequiredString(canonicalParams, "content");
  const replaceMode = isNonEmptyString(canonicalParams.replace_mode)
    ? String(canonicalParams.replace_mode).trim()
    : "replace_full";
  const fsPath = projectRoot ? normalizeFsPath(scriptPath, projectRoot) : normalizeFsPath(scriptPath);
  return {
    script_path: normalizeResPath(scriptPath),
    script_fs_path: fsPath,
    content,
    replace_mode: replaceMode,
  };
}

function buildRunProjectArgs(canonicalParams = {}) {
  const out = {};
  if (canonicalParams.headless != null) out.headless = Boolean(canonicalParams.headless);
  if (Array.isArray(canonicalParams.extra_args)) out.extra_args = canonicalParams.extra_args.map((a) => String(a));
  if (canonicalParams.timeout_seconds != null) out.timeout_seconds = Number(canonicalParams.timeout_seconds);
  withOptionalString(out, "main_scene_path", canonicalParams.main_scene_path);
  return out;
}

function buildRunProjectCliArgs(canonicalParams = {}, { projectRoot = null } = {}) {
  const args = [];
  if (canonicalParams.headless === true) args.push("--headless");
  args.push("--quit");
  const root = projectRoot ? normalizeFsPath(projectRoot) : null;
  if (root) args.push("--path", root);
  if (isNonEmptyString(canonicalParams.main_scene_path)) {
    args.push("--main-scene", String(canonicalParams.main_scene_path).trim());
  }
  if (Array.isArray(canonicalParams.extra_args)) {
    args.push(...canonicalParams.extra_args.map((a) => String(a)));
  }
  return args;
}

function buildGetDebugOutputArgs(canonicalParams = {}) {
  const n = canonicalParams.last_n ?? canonicalParams.lastN ?? 10;
  const last_n = Number(n);
  if (!Number.isFinite(last_n) || last_n < 1) {
    throw new Error("Invalid parameter: last_n must be >= 1");
  }
  return { last_n };
}

export {
  normalizeResPath,
  normalizeFsPath,
  buildCreateSceneArgs,
  buildAddNodeArgs,
  buildSetNodePropertiesArgs,
  buildSaveSceneArgs,
  buildAttachScriptSetPropertyParams,
  buildAttachScriptSaveSceneParams,
  buildCreateScriptFileArgs,
  buildModifyScriptFileArgs,
  buildRunProjectArgs,
  buildRunProjectCliArgs,
  buildGetDebugOutputArgs,
};

