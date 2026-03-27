/**
 * ChangeExecutor
 * ----------------
 * Applies a structured change plan to an existing generated Godot project.
 *
 * Execution ordering is deliberate:
 * 1) Update canonical source-of-truth artifacts (json only).
 * 2) Apply file-level project mutations that must mirror canonical artifacts.
 * 3) Execute requested MCP actions (Godot-specific editing, if any).
 * 4) Execute requested CLI actions (bounded runtime, if any).
 * 5) Run v1 validation and return a structured result.
 *
 * This module contains no planning logic. It only consumes a plan produced
 * by `ChangePlanner` (or a compatible plan producer).
 */

import { validateProject } from "../validation/validator.js";
import { updateProjectGodotProjectName } from "./ProjectMetadataUpdater.js";
import fs from "node:fs";
import path from "node:path";
import { SourceOfTruthManager } from "./SourceOfTruthManager.js";

import crypto from "node:crypto";

function isPlainObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function safeString(v) {
  return v == null ? "" : String(v);
}

function extractProjectRoot(workspace) {
  return workspace?.project_root ?? workspace?.projectRoot ?? workspace?.projectRootPath ?? null;
}

function extractSpecAndRecipe(workspace, sourceOfTruthManager) {
  // Prefer already-loaded workspace artifacts, but reload from SoT if provided.
  const normalizedGameSpec =
    workspace?.normalizedGameSpec ??
    workspace?.normalized_game_spec ??
    workspace?.normalized_spec ??
    null;

  const generationRecipe =
    workspace?.generationRecipe ??
    workspace?.generation_recipe ??
    workspace?.generationRecipe ??
    null;

  return { normalizedGameSpec, generationRecipe };
}

function extractProjectRootAndValidate(workspace) {
  const projectRoot = extractProjectRoot(workspace);
  if (!projectRoot) return null;
  return path.resolve(String(projectRoot));
}

function toAbsolutePath(projectRoot, relPath) {
  // Plan paths are expected to be project-relative.
  return path.resolve(projectRoot, String(relPath));
}

function safeRelPath(relPath) {
  return String(relPath ?? "").replace(/^(\.\.\/)+/g, "");
}

function isLikelyTextFileSize(sizeBytes) {
  // Avoid expensive hashing for huge files.
  return Number.isFinite(sizeBytes) && sizeBytes >= 0 && sizeBytes <= 2_000_000;
}

function sha1OfFile(absPath) {
  const buf = fs.readFileSync(absPath);
  return crypto.createHash("sha1").update(buf).digest("hex");
}

function fileSnapshot(absPath) {
  try {
    if (!fs.existsSync(absPath)) return { exists: false };
    const st = fs.statSync(absPath);
    const snap = { exists: true, mtimeMs: st.mtimeMs, size: st.size };
    if (isLikelyTextFileSize(st.size)) {
      snap.sha1 = sha1OfFile(absPath);
    }
    return snap;
  } catch {
    return { exists: false };
  }
}

function diffSnapshots({ pre, post }) {
  const created = Boolean(post?.exists) && !Boolean(pre?.exists);
  const modified =
    Boolean(post?.exists) &&
    Boolean(pre?.exists) &&
    ((pre?.mtimeMs ?? null) !== (post?.mtimeMs ?? null) ||
      (pre?.size ?? null) !== (post?.size ?? null) ||
      (pre?.sha1 ?? null) !== (post?.sha1 ?? null));
  return { created, modified };
}

function ensureParentDirForFile(absPath) {
  const parent = path.dirname(absPath);
  fs.mkdirSync(parent, { recursive: true });
}

function writeTextFile({ absPath, content }) {
  ensureParentDirForFile(absPath);
  fs.writeFileSync(absPath, String(content ?? ""), "utf-8");
}

function normalizeResPath(scriptRelPath) {
  // Godot expects `res://...` paths.
  const p = String(scriptRelPath ?? "").trim();
  if (!p) return null;
  if (p.startsWith("res://")) return p;
  return `res://${p.replace(/^[./]+/, "")}`;
}

function applySceneAttachScriptTextPatch({ sceneAbsPath, nodeName, scriptRelPath }) {
  const scriptResPath = normalizeResPath(scriptRelPath);
  if (!scriptResPath) throw new Error("scene_attach_script missing scriptRelPath.");

  const original = fs.readFileSync(sceneAbsPath, "utf-8");
  const already =
    original.includes(`script = "${scriptResPath}"`) ||
    original.includes(`script = ExtResource`) ||
    original.includes(`path=\"${scriptResPath}\"`);

  if (already) return { changed: false };

  const lines = original.split("\n");

  // Find the node block line; insert after it.
  const nodeLineIdx =
    nodeName != null
      ? lines.findIndex((ln) => ln.includes(`[node name="${nodeName}"`))
      : -1;
  const idx = nodeLineIdx >= 0 ? nodeLineIdx : lines.findIndex((ln) => ln.startsWith("[node "));
  if (idx < 0) throw new Error(`Could not find a [node ...] line in scene: ${sceneAbsPath}`);

  // Insert property right after node header line.
  const insertion = `script = "${scriptResPath}"`;

  // Avoid inserting if a `script =` line already exists near the node.
  const window = lines.slice(idx, Math.min(idx + 10, lines.length)).join("\n");
  if (window.includes("script =")) return { changed: false };

  lines.splice(idx + 1, 0, insertion);
  const patched = lines.join("\n");
  fs.writeFileSync(sceneAbsPath, patched, "utf-8");
  return { changed: true };
}

function getBoundedValidationParams({ plan, boundedValidationSeconds, strictValidation }) {
  const steps = Array.isArray(plan?.validation_steps) ? plan.validation_steps : [];
  const boundedStep = steps.find((s) => s && s.type === "bounded_validation");

  const params = boundedStep?.params ?? {};
  const boundedRunSeconds =
    params.boundedRunSeconds ?? params.timeoutSeconds ?? boundedValidationSeconds ?? 5;
  const strict = params.strict ?? strictValidation ?? false;

  return {
    boundedRunSeconds: Number(boundedRunSeconds),
    strict: Boolean(strict),
  };
}

function normalizePlanInput(changePlanOrWrapper) {
  // ChangePlanner returns: { ok: true, plan: <plan> }
  if (!changePlanOrWrapper) return null;
  if (isPlainObject(changePlanOrWrapper) && changePlanOrWrapper.plan) {
    return changePlanOrWrapper.plan;
  }
  return changePlanOrWrapper;
}

function resolveSchemaPath(schemaPath) {
  const p = path.resolve(String(schemaPath));
  if (fs.existsSync(p)) return p;

  // Many schema paths in this factory are stored as:
  //   "factory-js/schemas/<name>.schema.json"
  // but depend on process.cwd().
  const alt = path.resolve("backend", String(schemaPath));
  if (fs.existsSync(alt)) return alt;

  return p;
}

function ensureSourceOfTruthManagerSchemas(sourceOfTruthManager) {
  if (!sourceOfTruthManager) return null;

  const normalizedSchema = sourceOfTruthManager.normalizedSpecSchemaPath;
  const recipeSchema = sourceOfTruthManager.generationRecipeSchemaPath;

  // If the manager's CURRENT schema paths resolve already, keep as-is.
  const normalizedOriginalResolved = path.resolve(String(normalizedSchema));
  const recipeOriginalResolved = path.resolve(String(recipeSchema));
  const normalizedOriginalOk = fs.existsSync(normalizedOriginalResolved);
  const recipeOriginalOk = fs.existsSync(recipeOriginalResolved);
  if (normalizedOriginalOk && recipeOriginalOk) return sourceOfTruthManager;

  const normalizedResolved = resolveSchemaPath(normalizedSchema);
  const recipeResolved = resolveSchemaPath(recipeSchema);

  // Otherwise, recreate with corrected absolute schema paths.
  const sotDir = path.dirname(String(sourceOfTruthManager.normalizedSpecPath));
  return new SourceOfTruthManager({
    sourceOfTruthDir: sotDir,
    normalizedSpecSchemaPath: normalizedResolved,
    generationRecipeSchemaPath: recipeResolved,
  });
}

function pushError(errors, err, context) {
  const message = err?.message ? err.message : safeString(err);
  errors.push({ context, error: message });
}

function getExecutorMethodForMcpAction(executor, action) {
  if (!executor || !action) return null;
  const name = String(action);

  // Canonical handoff contract:
  // ChangeExecutor should pass one object shape to executor boundary:
  // { action: "<canonical_action>", params: { ...canonical_params } }
  // This prevents snake_case params from being dropped by legacy method signatures.
  if (typeof executor.executeOperation === "function") {
    return {
      fn: (params) => executor.executeOperation({ action: name, params }),
      method: "executeOperation",
    };
  }

  if (typeof executor[name] === "function") return { fn: executor[name], method: name };

  // Expected action naming convention (snake_case) in plans.
  const map = {
    analyze_project: "analyzeProject",
    create_scene: "createScene",
    add_node: "addNode",
    attach_script: "attachScript",
    save_scene: "saveScene",
  };

  const candidate = map[name] ?? null;
  if (candidate && typeof executor[candidate] === "function") {
    return { fn: executor[candidate].bind(executor), method: candidate };
  }

  // Also allow camelCase incoming names.
  const camelMap = {
    analyzeProject: "analyzeProject",
    createScene: "createScene",
    addNode: "addNode",
    attachScript: "attachScript",
    saveScene: "saveScene",
  };
  const camel = camelMap[name] ?? null;
  if (camel && typeof executor[camel] === "function") {
    return { fn: executor[camel].bind(executor), method: camel };
  }

  return null;
}

function normalizeMcpActionName(action) {
  const a = safeString(action).trim();
  const aliases = {
    createScene: "create_scene",
    addNode: "add_node",
    saveScene: "save_scene",
    attachScript: "attach_script",
  };
  return aliases[a] ?? a;
}

function toCapabilityOperationKey(action) {
  const normalized = normalizeMcpActionName(action);
  if (normalized === "attach_script") return "attach_script_to_scene_root";
  return normalized;
}

async function resolveSupportedMcpActionSet(executor) {
  if (!executor || typeof executor.getSupportedOperations !== "function") return null;
  try {
    const res = await executor.getSupportedOperations();
    if (!res?.ok) return null;
    const ops = Array.isArray(res?.output?.operations) ? res.output.operations : [];
    const enabled = ops.filter((o) => o?.enabled).map((o) => safeString(o?.operation).trim()).filter(Boolean);
    const rawTools = Array.isArray(res?.output?.raw_tools) ? res.output.raw_tools : [];
    return {
      enabledActionSet: new Set(enabled),
      discoveredRawTools: rawTools,
      supportedOperations: ops,
    };
  } catch {
    return null;
  }
}

async function maybeAwait(value) {
  return value && typeof value.then === "function" ? value : value;
}

function extractCliActionArgs(actionObj) {
  const cliArgs = actionObj?.cliArgs ?? [];
  const timeoutSeconds =
    actionObj?.timeoutSeconds ??
    actionObj?.params?.timeoutSeconds ??
    actionObj?.params?.timeout_seconds ??
    null;

  return { cliArgs: Array.isArray(cliArgs) ? cliArgs : [], timeoutSeconds };
}

function prettyForLog(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function validateMcpActionArgs(action, params) {
  const p = isPlainObject(params) ? params : {};
  const get = (...keys) => {
    for (const key of keys) {
      if (p[key] != null) return p[key];
    }
    return null;
  };
  const errors = [];
  if (action === "create_scene") {
    if (!isNonEmptyString(get("scene_path", "scenePath"))) errors.push("scene_path is required");
    if (!isNonEmptyString(get("root_node_name", "rootName", "root_name"))) errors.push("root_node_name is required");
    if (!isNonEmptyString(get("root_node_type", "rootType", "root_type"))) errors.push("root_node_type is required");
  } else if (action === "add_node") {
    if (!isNonEmptyString(get("scene_path", "scenePath"))) errors.push("scene_path is required");
    if (!isNonEmptyString(get("node_name", "nodeName"))) errors.push("node_name is required");
    if (!isNonEmptyString(get("node_type", "nodeType"))) errors.push("node_type is required");
  } else if (action === "save_scene") {
    if (!isNonEmptyString(get("scene_path", "scenePath"))) errors.push("scene_path is required");
  } else if (action === "attach_script") {
    if (!isNonEmptyString(get("scene_path", "scenePath"))) errors.push("scene_path is required");
    if (!isNonEmptyString(get("script_path", "scriptPath"))) errors.push("script_path is required");
  }
  return {
    ok: errors.length === 0,
    errors,
    error: errors.length ? `Invalid ${action} arguments: ${errors.join(", ")}` : null,
  };
}

function sanitizeCanonicalMcpParams(action, rawParams) {
  const p = isPlainObject(rawParams) ? { ...rawParams } : {};
  // Canonical boundary: map legacy aliases into canonical fields, then drop aliases
  // so executor handoff is stable and registry-aligned.
  if (action === "create_scene") {
    if (p.scene_path == null && p.path != null) p.scene_path = p.path;
    if (p.root_node_name == null && p.root_name != null) p.root_node_name = p.root_name;
    if (p.root_node_type == null && p.root_type != null) p.root_node_type = p.root_type;
    if (p.root_node_name == null && p.rootName != null) p.root_node_name = p.rootName;
    if (p.root_node_type == null && p.rootType != null) p.root_node_type = p.rootType;
    delete p.path;
    delete p.root_name;
    delete p.root_type;
    delete p.rootName;
    delete p.rootType;
    delete p.scenePath;
  } else if (action === "add_node") {
    if (p.scene_path == null && p.path != null) p.scene_path = p.path;
    delete p.path;
    delete p.scenePath;
  } else if (action === "save_scene") {
    if (p.scene_path == null && p.path != null) p.scene_path = p.path;
    delete p.path;
    delete p.scenePath;
  } else if (action === "attach_script" || action === "attach_script_to_scene_root") {
    if (p.scene_path == null && p.path != null) p.scene_path = p.path;
    if (p.script_path == null && p.scriptPath != null) p.script_path = p.scriptPath;
    delete p.path;
    delete p.scenePath;
    delete p.scriptPath;
  }
  return p;
}

async function applySourceOfTruthUpdates({ sourceOfTruthManager, plan }) {
  const updates = plan?.source_of_truth_updates ?? {};

  const results = {
    normalized_game_spec: null,
    generation_recipe: null,
    project_state: null,
    errors: [],
  };

  // Update canonical normalized spec (schema-validating on write).
  if (updates.normalized_game_spec_patch != null) {
    try {
      results.normalized_game_spec = sourceOfTruthManager.updateNormalizedSpec(
        updates.normalized_game_spec_patch,
        { createIfMissing: false }
      );
    } catch (err) {
      results.normalized_game_spec = { ok: false, error: safeString(err?.message ?? err) };
      results.errors.push({ artifact: "normalized_game_spec", error: safeString(err?.message ?? err) });
    }
    if (!results.normalized_game_spec?.ok) return results;
  }

  // Update canonical generation recipe (schema-validating on write).
  if (updates.generation_recipe_patch != null) {
    try {
      results.generation_recipe = sourceOfTruthManager.updateGenerationRecipe(
        updates.generation_recipe_patch,
        { createIfMissing: false }
      );
    } catch (err) {
      results.generation_recipe = { ok: false, error: safeString(err?.message ?? err) };
      results.errors.push({ artifact: "generation_recipe", error: safeString(err?.message ?? err) });
    }
    if (!results.generation_recipe?.ok) return results;
  }

  // Update conversation runtime state (no schema validation on patch).
  if (updates.project_state_patch != null) {
    try {
      results.project_state = sourceOfTruthManager.updateProjectState(updates.project_state_patch, {
        createIfMissing: true,
      });
    } catch (err) {
      results.project_state = { ok: false, error: safeString(err?.message ?? err) };
      results.errors.push({ artifact: "project_state", error: safeString(err?.message ?? err) });
    }
    if (!results.project_state?.ok) return results;
  }

  return results;
}

function extractPlannedFileChanges(plan) {
  const fileChanges = Array.isArray(plan?.file_changes) ? plan.file_changes : [];
  return fileChanges.filter((fc) => fc && isPlainObject(fc) && fc.path);
}

function isSceneLikeFileChange(fc, relPath) {
  const rel = safeString(relPath).trim().toLowerCase();
  const notes = safeString(fc?.notes).trim().toLowerCase();
  return rel.endsWith(".tscn") || rel.includes("scene") || notes.includes("scene");
}

function shouldDeferFileChangeToActionPath({ fileChange, relPath, hasExecutableActionPath }) {
  if (!hasExecutableActionPath) return false;
  const type = safeString(fileChange?.type).trim().toLowerCase();
  if (!["edit", "modify", "scene_attach_script", "scene_node_update"].includes(type)) return false;
  return isSceneLikeFileChange(fileChange, relPath);
}

function looksLikeRawSceneCreateFileChange(fileChange) {
  const fc = isPlainObject(fileChange) ? fileChange : {};
  const type = safeString(fc?.type).trim().toLowerCase();
  const relPath = safeString(fc?.path).trim().toLowerCase();
  const notes = safeString(fc?.notes).trim().toLowerCase();
  const isSceneFile = relPath.endsWith(".tscn") || relPath.includes("scene");
  if (!isSceneFile) return false;
  const creationType = ["create_scene", "scene_create", "create", "add", "script_create"].includes(type);
  const noteHint = notes.includes("create scene") || notes.includes("new scene") || notes.includes("scene create");
  return creationType || noteHint;
}

function hasCreateSceneMcpAction(plan) {
  const actions = Array.isArray(plan?.required_mcp_actions)
    ? plan.required_mcp_actions
    : Array.isArray(plan?.mcp_actions)
      ? plan.mcp_actions
      : [];
  return actions.some((a) => normalizeMcpActionName(a?.action) === "create_scene");
}

function detectInvalidSceneCreatePlanningShape({ plan, supportedActionSet }) {
  const createSceneSupported = Boolean(supportedActionSet && supportedActionSet.has("create_scene"));
  if (!createSceneSupported) return null;
  if (hasCreateSceneMcpAction(plan)) return null;

  const fileChanges = extractPlannedFileChanges(plan);
  const offenders = fileChanges.filter((fc) => looksLikeRawSceneCreateFileChange(fc));
  if (offenders.length === 0) return null;

  return {
    error:
      "Invalid planning shape: raw .tscn scene creation in file_changes while MCP create_scene is supported. Use mcp_actions.create_scene.",
    offenders: offenders.map((fc) => ({
      type: safeString(fc?.type),
      path: safeString(fc?.path),
      notes: safeString(fc?.notes),
    })),
  };
}

async function applyFileMutations({ workspace, sourceOfTruthManager, plan }) {
  const projectRoot = extractProjectRootAndValidate(workspace);
  const affected = Array.isArray(plan?.affected_project_files) ? plan.affected_project_files : [];
  const fileChanges = extractPlannedFileChanges(plan);
  const mcpActions = Array.isArray(plan?.required_mcp_actions)
    ? plan.required_mcp_actions
    : Array.isArray(plan?.mcp_actions)
      ? plan.mcp_actions
      : [];
  const cliActions = Array.isArray(plan?.required_cli_actions)
    ? plan.required_cli_actions
    : Array.isArray(plan?.cli_actions)
      ? plan.cli_actions
      : [];
  const hasMcpAttachScript = mcpActions.some((a) => a && a.action === "attach_script");
  const hasExecutableActionPath = mcpActions.length > 0 || cliActions.length > 0;

  const hasAnyMutationIntent = affected.length > 0 || fileChanges.length > 0;
  if (!hasAnyMutationIntent) return { ok: true, mutations: [], file_change_results: [], skipped: true };

  const mutations = [];
  const errors = [];
  const fileChangeResults = [];

  // At v1, we only support reflecting canonical project name into project.godot.
  if (affected.includes("project.godot")) {
    const specRes = sourceOfTruthManager.loadNormalizedSpec({ required: true });
    if (!specRes.ok) {
      return { ok: false, errors: [{ artifact: "normalized_game_spec", error: specRes.error }], mutations };
    }

    const projectRoot = extractProjectRoot(workspace);
    const updRes = updateProjectGodotProjectName({
      projectRoot,
      normalizedGameSpec: specRes.data,
    });

    if (!updRes.ok) {
      errors.push({ file: "project.godot", error: updRes.error });
      return { ok: false, errors, mutations };
    }

    mutations.push({ file: "project.godot", action: "reflect_config_name", result: updRes });
  }

  // Apply v2+ file-level edits from planner.
  // These are expected to be concrete script/scene modifications.
  for (const fc of fileChanges) {
    const rel = safeRelPath(fc.path);
    const absPath = projectRoot ? toAbsolutePath(projectRoot, rel) : null;
    try {
      if (!absPath) throw new Error("Cannot resolve project root for file_changes.");

      const type = String(fc.type ?? "");
      if (type === "script_create") {
        if (typeof fc.content !== "string" || fc.content.length === 0) {
          throw new Error(`script_create missing non-empty content for ${rel}`);
        }
        // Traceability: this is a concrete disk mutation the plan requests.
        // eslint-disable-next-line no-console
        console.log(`[ChangeExecutor] script_file_write start: ${rel}`);
        writeTextFile({ absPath, content: fc.content });
        // eslint-disable-next-line no-console
        console.log(`[ChangeExecutor] script_file_write done: ${rel}`);
        fileChangeResults.push({ type, path: rel, ok: true });
        continue;
      }

      if (type === "scene_attach_script" || type === "scene_node_update") {
        const target = isPlainObject(fc.target) ? fc.target : {};
        const nodeName = target?.nodeName ?? null;
        const scriptRelPath = target?.scriptPath ?? null;
        if (!scriptRelPath) throw new Error(`${type} missing target.scriptPath for ${rel}`);
        if (!fs.existsSync(absPath)) throw new Error(`Scene file does not exist: ${rel}`);
        if (hasMcpAttachScript) {
          // Gold-standard: when MCP attach_script is planned, avoid doing the
          // scene edit via direct text patching. Otherwise we could report
          // success even if MCP didn't attach the script.
          fileChangeResults.push({
            type,
            path: rel,
            ok: true,
            skipped: true,
            reason: "MCP attach_script planned; scene text patch skipped.",
          });
        } else {
          applySceneAttachScriptTextPatch({
            sceneAbsPath: absPath,
            nodeName,
            scriptRelPath,
          });
          fileChangeResults.push({ type, path: rel, ok: true });
        }
        continue;
      }

      if (shouldDeferFileChangeToActionPath({ fileChange: fc, relPath: rel, hasExecutableActionPath })) {
        // Scene mutations are MCP-driven here; avoid failing at file mutation stage
        // when planner emits generic scene edit/modify placeholders.
        // eslint-disable-next-line no-console
        console.log(
          `[ChangeExecutor] file_change deferred to MCP/CLI: type=${type} path=${rel}`
        );
        fileChangeResults.push({
          type,
          path: rel,
          ok: true,
          skipped: true,
          deferred_to_actions: true,
          reason: `Scene ${type} entry deferred; mutation expected via mcp_actions/cli_actions.`,
        });
        continue;
      }

      if (hasExecutableActionPath) {
        // Do not fail early when actionable MCP/CLI path exists; record explicit skip.
        // eslint-disable-next-line no-console
        console.log(
          `[ChangeExecutor] file_change unsupported but execution will continue: type=${type} path=${rel}`
        );
        fileChangeResults.push({
          type,
          path: rel,
          ok: true,
          skipped: true,
          unsupported: true,
          reason: "Unsupported file_changes.type; deferred to mcp_actions/cli_actions.",
        });
        continue;
      }

      // No executable path remains for this mutation intent.
      throw new Error(`Unsupported file_changes.type with no MCP/CLI fallback: ${type}`);
    } catch (err) {
      errors.push({ file_change: fc?.path, error: safeString(err?.message ?? err) });
      fileChangeResults.push({ type: fc?.type, path: fc?.path, ok: false, error: safeString(err?.message ?? err) });
      return { ok: false, errors, mutations, file_change_results: fileChangeResults };
    }
  }

  return { ok: errors.length === 0, errors, mutations, file_change_results: fileChangeResults };
}

async function applyMcpActions({ executor, plan }) {
  const mcpActions = Array.isArray(plan?.required_mcp_actions) ? plan.required_mcp_actions : [];
  const results = [];
  const errors = [];
  const capabilitySnapshot = await resolveSupportedMcpActionSet(executor);
  const supportedActionSet = capabilitySnapshot?.enabledActionSet ?? null;
  if (supportedActionSet) {
    // eslint-disable-next-line no-console
    console.log(`[ChangeExecutor] discovered GoPeak capabilities`, {
      discovered_raw_tool_count: Array.isArray(capabilitySnapshot?.discoveredRawTools)
        ? capabilitySnapshot.discoveredRawTools.length
        : 0,
      enabled_operations: Array.from(supportedActionSet),
    });
  }

  for (const actionObj of mcpActions) {
    // Boundary trace: this is the raw canonical action object before handoff.
    // eslint-disable-next-line no-console
    console.log("[ChangeExecutor] canonical handoff raw action object", prettyForLog(actionObj));
    const action = normalizeMcpActionName(actionObj?.action);
    const capabilityKey = toCapabilityOperationKey(action);
    const rawParams = actionObj?.params ?? {};
    const params = sanitizeCanonicalMcpParams(action, rawParams);
    // eslint-disable-next-line no-console
    console.log("[ChangeExecutor] canonical handoff cleaned action object", prettyForLog({
      action,
      params,
    }));
    const argValidation = validateMcpActionArgs(action, params);
    if (!argValidation.ok) {
      errors.push({
        action,
        capability: capabilityKey,
        error: argValidation.error,
        invalid_args: argValidation.errors,
        local_validation: true,
      });
      // eslint-disable-next-line no-console
      console.log("[ChangeExecutor] invalid MCP action args rejected before execution", {
        action,
        capability_key: capabilityKey,
        errors: argValidation.errors,
        params,
      });
      return { ok: false, errors, results };
    }
    if (supportedActionSet && !supportedActionSet.has(capabilityKey)) {
      const msg = `Unsupported MCP action for current GoPeak toolset: ${safeString(action)} (capability=${capabilityKey})`;
      errors.push({ action, capability: capabilityKey, error: msg, unsupported: true });
      // eslint-disable-next-line no-console
      console.log(`[ChangeExecutor] unsupported action rejected`, {
        requested_action: action,
        capability_key: capabilityKey,
      });
      return { ok: false, errors, results };
    }
    const method = getExecutorMethodForMcpAction(executor, action);

    if (!method) {
      const msg = `Executor does not support MCP action: ${safeString(action)}`;
      errors.push({ action, error: msg });
      return { ok: false, errors, results };
    }

    try {
      const stepName =
        action === "attach_script"
          ? "mcp_attach_script"
          : action === "save_scene"
            ? "mcp_save_scene"
            : "mcp_action";
      // eslint-disable-next-line no-console
      console.log(`[ChangeExecutor] ${stepName} start: ${action}`);
      // eslint-disable-next-line no-console
      console.log(
        `[ChangeExecutor] ${stepName} request`,
        prettyForLog({
          raw_action_object: actionObj,
          cleaned_canonical_action_object: { action, params },
          requested_action: action,
          capability_key: capabilityKey,
          resolved_method: method.method,
          params,
        })
      );
      const res = await maybeAwait(method.fn(params));
      // eslint-disable-next-line no-console
      console.log(`[ChangeExecutor] ${stepName} raw/normalized response`, prettyForLog(res));
      results.push({ action: method.method, requested_action: action, result: res });
      if (res && res.ok === false) {
        const mcpTrace = isPlainObject(res?.output) ? res.output?.mcp_trace ?? null : null;
        errors.push({
          action,
          error: res.error ?? "Unknown MCP failure",
          timed_out: Boolean(res?.output?.timed_out),
          timeout_ms: res?.output?.timeout_ms ?? null,
          executor_result: res,
          mcp_trace: mcpTrace,
        });
        // eslint-disable-next-line no-console
        console.log(`[ChangeExecutor] ${stepName} failed: ${action}`);
        return { ok: false, errors, results };
      }
      // eslint-disable-next-line no-console
      console.log(`[ChangeExecutor] ${stepName} done: ${action}`);
    } catch (err) {
      const errMessage = safeString(err?.message ?? err);
      const errStack = typeof err?.stack === "string" ? err.stack : null;
      errors.push({
        action,
        error: errMessage,
        timed_out: err?.code === "ETIMEDOUT" || err?.timeoutMs != null,
        timeout_ms: err?.timeoutMs ?? null,
        exception: {
          message: errMessage,
          stack: errStack,
          code: err?.code ?? null,
        },
      });
      // eslint-disable-next-line no-console
      console.log(
        `[ChangeExecutor] mcp_action exception: ${action}`,
        prettyForLog({ message: errMessage, code: err?.code ?? null, stack: errStack })
      );
      return { ok: false, errors, results };
    }
  }

  return { ok: errors.length === 0, errors, results };
}

async function applyCliActions({ executor, plan }) {
  const cliActions = Array.isArray(plan?.required_cli_actions) ? plan.required_cli_actions : [];
  const results = [];
  const errors = [];

  for (const actionObj of cliActions) {
    const action = actionObj?.action;
    const { cliArgs, timeoutSeconds } = extractCliActionArgs(actionObj);

    if (!executor || typeof executor.runCli !== "function") {
      const msg = "Executor does not expose runCli for CLI actions.";
      errors.push({ action, error: msg });
      return { ok: false, errors, results };
    }

    try {
      // eslint-disable-next-line no-console
      console.log(`[ChangeExecutor] cli_action start: ${action}`);
      const res = await executor.runCli({ action, cliArgs, timeoutSeconds });
      results.push({ action, cliArgs, timeoutSeconds, result: res });
      if (res && res.ok === false) {
        errors.push({
          action,
          error: res.error ?? "Unknown CLI failure",
          timed_out: Boolean(res?.output?.timed_out),
          timeout_seconds: res?.output?.timeout_seconds ?? null,
          executor_result: res,
        });
        // eslint-disable-next-line no-console
        console.log(`[ChangeExecutor] cli_action failed: ${action}`);
        return { ok: false, errors, results };
      }
      // eslint-disable-next-line no-console
      console.log(`[ChangeExecutor] cli_action done: ${action}`);
    } catch (err) {
      errors.push({
        action,
        error: safeString(err?.message ?? err),
        timed_out: err?.code === "ETIMEDOUT",
        timeout_seconds: timeoutSeconds ?? null,
      });
      return { ok: false, errors, results };
    }
  }

  return { ok: errors.length === 0, errors, results };
}

async function runValidationAfterExecution({
  validator,
  workspace,
  sourceOfTruthManager,
  executor,
  plan,
  boundedRunSeconds,
  strict,
}) {
  const projectRoot = extractProjectRoot(workspace);
  if (!projectRoot) {
    return { ok: false, error: "workspace.project_root/projectRoot is required for validation." };
  }

  const specRes = sourceOfTruthManager.loadNormalizedSpec({ required: true });
  const recipeRes = sourceOfTruthManager.loadGenerationRecipe({ required: true });
  if (!specRes.ok) return { ok: false, error: `Cannot validate: ${specRes.error}` };
  if (!recipeRes.ok) return { ok: false, error: `Cannot validate: ${recipeRes.error}` };

  const projectName = specRes.data?.project_name ?? workspace?.project_name ?? "unknown_project";
  const stateRes = sourceOfTruthManager.loadProjectState({ required: true });
  if (!stateRes.ok) {
    return { ok: false, error: `Cannot validate: ${stateRes.error}` };
  }

  const validateFn =
    validator?.validateProject ??
    validator?.default ??
    validator?.runValidation ??
    validator ??
    validateProject;

  const result = await validateFn({
    projectName,
    projectRoot,
    generationRecipe: recipeRes.data,
    executor,
    boundedRunSeconds,
    strict,
    artifactsDir: null,
    schemaPath: resolveSchemaPath("factory-js/schemas/validation_report.schema.json"),
    projectState: stateRes?.ok ? stateRes.data : null,
  });

  return result;
}

function buildMutationTargetsFromPlan(plan) {
  const targets = [];
  const affected = Array.isArray(plan?.affected_project_files) ? plan.affected_project_files : [];
  for (const a of affected) {
    if (typeof a === "string" && a.trim()) targets.push(a.trim());
  }

  const fileChanges = extractPlannedFileChanges(plan);
  for (const fc of fileChanges) {
    if (typeof fc.path === "string" && fc.path.trim()) targets.push(fc.path.trim());
  }

  // Best-effort: infer touched paths from MCP action params.
  const mcpActions = Array.isArray(plan?.required_mcp_actions)
    ? plan.required_mcp_actions
    : Array.isArray(plan?.mcp_actions)
      ? plan.mcp_actions
      : [];
  for (const actionObj of mcpActions) {
    if (!actionObj || !isPlainObject(actionObj)) continue;
    const action = String(actionObj.action ?? actionObj?.method ?? "");
    const params = isPlainObject(actionObj.params) ? actionObj.params : {};

    // Common convention in plans: `scenePath` and `scriptPath` are project-relative.
    if (["create_scene", "add_node", "save_scene", "attach_script"].includes(action)) {
      if (typeof params.scenePath === "string" && params.scenePath.trim()) targets.push(params.scenePath.trim());
    }
    if (action === "attach_script") {
      if (typeof params.scriptPath === "string" && params.scriptPath.trim()) targets.push(params.scriptPath.trim());
    }
  }

  // De-dup while preserving order.
  return [...new Set(targets)];
}

function planIndicatesProjectMutation(plan) {
  const affected = Array.isArray(plan?.affected_project_files) ? plan.affected_project_files : [];
  const fileChanges = Array.isArray(plan?.file_changes) ? plan.file_changes : [];
  const hasMcp = Array.isArray(plan?.required_mcp_actions) ? plan.required_mcp_actions.length > 0 : false;
  const hasCli = Array.isArray(plan?.required_cli_actions) ? plan.required_cli_actions.length > 0 : false;

  // Success gating: only require disk mutation when the plan intends one.
  return affected.length > 0 || fileChanges.length > 0 || hasMcp || hasCli;
}

function requiredMutationWasAchieved({ preSnapshots, postSnapshots }) {
  for (const relPath of Object.keys(postSnapshots)) {
    const pre = preSnapshots[relPath];
    const post = postSnapshots[relPath];
    const { created, modified } = diffSnapshots({ pre, post });
    if (created || modified) return true;
  }
  return false;
}

export async function executeChangePlan({
  workspace,
  changePlan,
  sourceOfTruthManager,
  executor,
  validator = null,
  boundedValidationSeconds = 5,
  strictValidation = false,
} = {}) {
  const normalizedWorkspace = workspace ?? {};
  const plan = normalizePlanInput(changePlan);

  if (!plan || !isPlainObject(plan)) {
    return { ok: false, error: "changePlan must be a plan object produced by ChangePlanner." };
  }
  if (!sourceOfTruthManager) {
    return { ok: false, error: "sourceOfTruthManager is required." };
  }
  if (!executor) {
    return { ok: false, error: "executor is required to execute MCP/CLI and to run validation." };
  }

  const errors = [];
  const stageResults = {};
  const step_trace = [];
  const capabilitySnapshot = await resolveSupportedMcpActionSet(executor);
  const supportedActionSet = capabilitySnapshot?.enabledActionSet ?? null;

  function beginStepTrace(step) {
    const startedAt = Date.now();
    // eslint-disable-next-line no-console
    console.log(`[ChangeExecutor] step start: ${step}`);
    const item = { step, startedAt, duration_ms: null, ok: null };
    step_trace.push(item);
    return item;
  }

  function endStepTrace(stepItem, ok, data = undefined) {
    stepItem.duration_ms = Date.now() - stepItem.startedAt;
    stepItem.ok = Boolean(ok);
    if (data !== undefined) stepItem.data = data;
    // eslint-disable-next-line no-console
    console.log(
      `[ChangeExecutor] step ${stepItem.step} ${ok ? "done" : "failed"} (${stepItem.duration_ms}ms)`
    );
  }

  function failWithStep({ failed_step, timeout_info, error, execution, validation_result, errors, created_files, modified_files }) {
    const mcp_debug = failed_step === "mcp_actions" ? execution?.mcp ?? stageResults?.mcp ?? null : null;
    return {
      ok: false,
      error: error ?? "Change execution failed.",
      failed_step: failed_step ?? null,
      timeout_info: timeout_info ?? null,
      errors: errors ?? [],
      execution: execution ?? stageResults,
      validation_result: validation_result ?? stageResults.validation,
      created_files: created_files ?? [],
      modified_files: modified_files ?? [],
      ...(mcp_debug != null ? { mcp_debug } : {}),
      step_trace,
    };
  }

  function extractTimeoutInfoFromStage(stage) {
    // We only need best-effort: find any `timed_out`/`timeout_*` fields
    // inside the stage output and return them.
    if (!stage || typeof stage !== "object") return null;
    if (stage?.timed_out || stage?.timeout_ms || stage?.timeout_seconds) {
      return {
        timed_out: Boolean(stage?.timed_out),
        timeout_ms: stage?.timeout_ms ?? null,
        timeout_seconds: stage?.timeout_seconds ?? null,
      };
    }
    const walk = (obj) => {
      if (!obj || typeof obj !== "object") return null;
      if (obj?.timed_out || obj?.timeout_ms || obj?.timeout_seconds) {
        return {
          timed_out: Boolean(obj?.timed_out),
          timeout_ms: obj?.timeout_ms ?? null,
          timeout_seconds: obj?.timeout_seconds ?? null,
        };
      }
      if (Array.isArray(obj)) {
        for (const it of obj) {
          const found = walk(it);
          if (found) return found;
        }
      } else {
        for (const v of Object.values(obj)) {
          const found = walk(v);
          if (found) return found;
        }
      }
      return null;
    };
    return walk(stage);
  }

  // Ensure schema paths resolve correctly regardless of process.cwd().
  const sot = ensureSourceOfTruthManagerSchemas(sourceOfTruthManager);
  if (!sot) {
    return { ok: false, error: "Failed to initialize sourceOfTruthManager schemas." };
  }

  const projectRoot = extractProjectRootAndValidate(normalizedWorkspace);
  const mutationTargets = buildMutationTargetsFromPlan(plan);
  const shouldGateOnProjectMutation = planIndicatesProjectMutation(plan) && mutationTargets.length > 0;

  const invalidSceneCreateShape = detectInvalidSceneCreatePlanningShape({
    plan,
    supportedActionSet,
  });
  if (invalidSceneCreateShape) {
    // Guardrail: prevent executor from attempting raw scene-file creation when
    // discovery says MCP create_scene is available. This catches planner-shape drift early.
    // eslint-disable-next-line no-console
    console.log("[ChangeExecutor] invalid scene-creation plan shape rejected", prettyForLog(invalidSceneCreateShape));
    return failWithStep({
      failed_step: "planning_shape_guard",
      error: invalidSceneCreateShape.error,
      execution: stageResults,
      errors: [
        {
          stage: "planning_shape_guard",
          error: invalidSceneCreateShape.error,
          offenders: invalidSceneCreateShape.offenders,
        },
      ],
      created_files: [],
      modified_files: [],
    });
  }

  const preSnapshots = {};
  if (projectRoot && mutationTargets.length > 0) {
    for (const rel of mutationTargets) {
      const abs = toAbsolutePath(projectRoot, rel);
      preSnapshots[rel] = fileSnapshot(abs);
    }
  }

  // Filled only after all execution stages complete; early returns use empties.
  const created_files = [];
  const modified_files = [];

  // Stage 1: Source of truth updates first.
  const step1 = beginStepTrace("source_of_truth_updates");
  stageResults.source_of_truth = await applySourceOfTruthUpdates({ sourceOfTruthManager: sot, plan });
  if (stageResults.source_of_truth?.errors?.length) {
    errors.push(...stageResults.source_of_truth.errors);
  }
  const step1Ok =
    stageResults.source_of_truth &&
    stageResults.source_of_truth.normalized_game_spec?.ok !== false &&
    stageResults.source_of_truth.generation_recipe?.ok !== false &&
    stageResults.source_of_truth.project_state?.ok !== false;
  if (!step1Ok) {
    endStepTrace(step1, false);
    return failWithStep({
      failed_step: "source_of_truth_updates",
      error: "Source-of-truth update failed.",
      execution: stageResults,
      errors,
      created_files,
      modified_files,
    });
  }
  endStepTrace(step1, true);

  // Stage 2: Apply file-level project mutations (write concrete files).
  const step2 = beginStepTrace("file_mutations");
  stageResults.file_mutations = await applyFileMutations({
    workspace: normalizedWorkspace,
    sourceOfTruthManager: sot,
    plan,
  });
  if (!stageResults.file_mutations?.ok) {
    endStepTrace(step2, false);
    return failWithStep({
      failed_step: "file_mutations",
      error: "File mutation stage failed.",
      execution: stageResults,
      errors: stageResults.file_mutations.errors ?? errors,
      timeout_info: extractTimeoutInfoFromStage(stageResults.file_mutations),
      created_files,
      modified_files,
    });
  }
  endStepTrace(step2, true, { file_change_results: stageResults.file_mutations.file_change_results ?? [] });

  // Stage 3: MCP actions (optional).
  const step3 = beginStepTrace("mcp_actions");
  stageResults.mcp = await applyMcpActions({ executor, plan });
  if (!stageResults.mcp?.ok) {
    endStepTrace(step3, false);
    return failWithStep({
      failed_step: "mcp_actions",
      error: "MCP action stage failed.",
      execution: stageResults,
      errors: stageResults.mcp.errors ?? errors,
      timeout_info: extractTimeoutInfoFromStage(stageResults.mcp),
      created_files,
      modified_files,
    });
  }
  endStepTrace(step3, true);

  // Stage 4: CLI actions (optional).
  const step4 = beginStepTrace("cli_actions");
  stageResults.cli = await applyCliActions({ executor, plan });
  if (!stageResults.cli?.ok) {
    endStepTrace(step4, false);
    return failWithStep({
      failed_step: "cli_actions",
      error: "CLI action stage failed.",
      execution: stageResults,
      errors: stageResults.cli.errors ?? errors,
      timeout_info: extractTimeoutInfoFromStage(stageResults.cli),
      created_files,
      modified_files,
    });
  }
  endStepTrace(step4, true);

  // Stage 5: Validation (required after execution).
  const step5 = beginStepTrace("validation");
  const { boundedRunSeconds, strict } = getBoundedValidationParams({
    plan,
    boundedValidationSeconds,
    strictValidation,
  });

  stageResults.validation = await runValidationAfterExecution({
    validator,
    workspace: normalizedWorkspace,
    sourceOfTruthManager: sot,
    executor,
    plan,
    boundedRunSeconds,
    strict,
  });
  endStepTrace(step5, Boolean(stageResults.validation?.ok));

  // Stage 6: Mutation verification gating.
  // If the plan indicates project mutation, do not report success unless at least
  // one expected target file actually changed on disk.
  const postSnapshots = {};
  if (projectRoot && mutationTargets.length > 0) {
    for (const rel of mutationTargets) {
      const abs = toAbsolutePath(projectRoot, rel);
      postSnapshots[rel] = fileSnapshot(abs);
    }
  }

  const mutationAchieved = shouldGateOnProjectMutation
    ? requiredMutationWasAchieved({ preSnapshots, postSnapshots })
    : true;

  // Compute disk diffs only at the end, once all stages have run.
  created_files.length = 0;
  modified_files.length = 0;
  for (const rel of mutationTargets) {
    const pre = preSnapshots[rel];
    const post = postSnapshots[rel];
    const { created, modified } = diffSnapshots({ pre, post });
    if (created) created_files.push(rel);
    else if (modified) modified_files.push(rel);
  }

  const ok = Boolean(stageResults.validation?.ok);
  const validationFailed = !ok;
  const mutationGateFailed = !mutationAchieved;

  if (validationFailed || mutationGateFailed) {
    const mutationErrors =
      mutationGateFailed && shouldGateOnProjectMutation
        ? [
            {
              mutation_gate: true,
              message:
                "Plan indicated project mutation, but none of the expected target files changed on disk.",
              targets: mutationTargets,
              created_files,
              modified_files,
            },
          ]
        : [];

    const failed_step = mutationGateFailed ? "mutation_gate" : "validation";
    return {
      ok: false,
      error: mutationGateFailed
        ? "No expected project mutations were detected on disk."
        : "Validation failed after applying the change plan.",
      failed_step,
      timeout_info: extractTimeoutInfoFromStage(stageResults.validation),
      errors: [
        ...(stageResults.validation?.validation_report?.errors ?? []),
        ...mutationErrors,
        ...(validationFailed ? errors : []),
      ],
      execution: stageResults,
      validation_result: stageResults.validation,
      created_files,
      modified_files,
      step_trace,
    };
  }

  return {
    ok: true,
    execution: stageResults,
    validation_result: stageResults.validation,
    created_files,
    modified_files,
    step_trace,
  };
}

