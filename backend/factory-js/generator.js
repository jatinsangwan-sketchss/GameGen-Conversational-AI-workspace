/**
 * Recipe-driven project generator (v1 skeleton).
 *
 * Responsibilities:
 * - Load generation recipe from dict or file
 * - Execute sections:
 *   - scenes_to_create
 *   - scripts_to_create
 *   - systems_to_create
 *   - ui_to_create
 *   - config_files_to_create (optional)
 * - Delegate low-level scene actions to an optional executor
 * - Otherwise use deterministic filesystem stubs
 *
 * No planning logic lives here.
 */

import fs from "node:fs";
import path from "node:path";

export function generateProjectFromRecipe({
  projectName,
  projectRoot,
  generationRecipe = null,
  generationRecipePath = null,
  executor = null,
  modelName = null,
  dryRun = false,
  artifactsDir = null,
  saveResult = false,
}) {
  const recipe = resolveRecipe({ generationRecipe, generationRecipePath });
  const root = path.resolve(String(projectRoot));

  if (!fs.existsSync(root)) throw new Error(`Project root not found: ${root}`);
  if (!fs.statSync(root).isDirectory()) {
    throw new Error(`Project root must be a directory: ${root}`);
  }

  const sceneResult = processScenes({
    projectRoot: root,
    scenes: safeList(recipe.scenes_to_create),
    executor,
    dryRun,
  });

  const scriptsResult = processScriptLike({
    projectRoot: root,
    entries: safeList(recipe.scripts_to_create),
    fallbackDir: "scripts",
    dryRun,
  });

  const systemsResult = processScriptLike({
    projectRoot: root,
    entries: safeList(recipe.systems_to_create),
    fallbackDir: "systems",
    dryRun,
  });

  const uiResult = processUIEntries({
    projectRoot: root,
    entries: safeList(recipe.ui_to_create),
    executor,
    dryRun,
  });

  const configResult = processConfigEntries({
    projectRoot: root,
    entries: safeList(recipe.config_files_to_create),
    dryRun,
  });

  const createdPaths = [
    ...sceneResult.createdPaths,
    ...scriptsResult.createdPaths,
    ...systemsResult.createdPaths,
    ...uiResult.createdPaths,
    ...configResult.createdPaths,
  ];

  const errors = [
    ...sceneResult.errors,
    ...scriptsResult.errors,
    ...systemsResult.errors,
    ...uiResult.errors,
    ...configResult.errors,
  ];

  const result = {
    ok: errors.length === 0,
    project_name: projectName,
    project_root: root,
    model_name: modelName,
    dry_run: dryRun,
    summary: {
      scenes_processed: sceneResult.processed,
      scripts_processed: scriptsResult.processed,
      systems_processed: systemsResult.processed,
      ui_processed: uiResult.processed,
      config_files_processed: configResult.processed,
      total_created_paths: createdPaths.length,
      total_errors: errors.length,
    },
    created_paths: createdPaths,
    errors,
    steps: {
      scenes: sceneResult.steps,
      scripts: scriptsResult.steps,
      systems: systemsResult.steps,
      ui: uiResult.steps,
      config_files: configResult.steps,
    },
  };

  if (saveResult) {
    if (!artifactsDir) throw new Error("artifactsDir is required when saveResult=true");
    const outPath = saveGenerationResult({ result, artifactsDir });
    result.result_path = outPath;
  }

  return result;
}

function resolveRecipe({ generationRecipe, generationRecipePath }) {
  if (generationRecipe != null) {
    if (!isPlainObject(generationRecipe)) throw new Error("'generationRecipe' must be an object.");
    return generationRecipe;
  }
  if (!generationRecipePath) {
    throw new Error("Provide either generationRecipe or generationRecipePath.");
  }
  const filePath = path.resolve(String(generationRecipePath));
  if (!fs.existsSync(filePath)) throw new Error(`Generation recipe file not found: ${filePath}`);
  const raw = fs.readFileSync(filePath, "utf-8");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Invalid JSON in generation recipe file '${filePath}': ${err}`);
  }
  if (!isPlainObject(parsed)) throw new Error("Generation recipe root must be an object.");
  return parsed;
}

function processScenes({ projectRoot, scenes, executor, dryRun }) {
  const createdPaths = [];
  const steps = [];
  const errors = [];

  for (const entry of scenes) {
    if (!isPlainObject(entry)) {
      errors.push({ stage: "scenes", message: "Invalid scene entry type." });
      continue;
    }

    const sceneRelPath = String(entry.path ?? "").trim();
    const rootType = String(entry.root_type ?? "Node").trim() || "Node";
    const rootName = String(entry.root_name ?? "Root").trim() || "Root";
    const nodes = safeList(entry.nodes);

    if (!sceneRelPath) {
      errors.push({ stage: "scenes", message: "Scene entry missing 'path'." });
      continue;
    }

    const step = { scene_path: sceneRelPath, status: "ok", actions: [] };
    try {
      createScene({
        projectRoot,
        sceneRelPath,
        rootType,
        rootName,
        executor,
        dryRun,
      });
      step.actions.push("create_scene");

      for (const node of nodes) {
        if (!isPlainObject(node)) continue;
        const nodeName = String(node.name ?? "").trim();
        const nodeType = String(node.type ?? "Node").trim() || "Node";
        const parent = String(node.parent ?? ".").trim() || ".";
        const scriptPath = String(node.script_path ?? "").trim();
        if (!nodeName) continue;

        addSceneNode({
          projectRoot,
          sceneRelPath,
          nodeName,
          nodeType,
          parent,
          scriptPath: scriptPath || null,
          executor,
          dryRun,
        });
        step.actions.push(`add_node:${nodeName}`);
      }

      createdPaths.push(path.resolve(path.join(projectRoot, sceneRelPath)));
    } catch (err) {
      step.status = "error";
      errors.push({ stage: "scenes", path: sceneRelPath, message: String(err) });
    }

    steps.push(step);
  }

  return { processed: scenes.length, createdPaths, steps, errors };
}

function processScriptLike({ projectRoot, entries, fallbackDir, dryRun }) {
  const createdPaths = [];
  const steps = [];
  const errors = [];

  for (const entry of entries) {
    if (!isPlainObject(entry)) {
      errors.push({ stage: fallbackDir, message: "Invalid entry type." });
      continue;
    }

    let relPath = String(entry.path ?? "").trim();
    const role = String(entry.role ?? "").trim();

    if (!relPath) {
      errors.push({ stage: fallbackDir, message: "Entry missing 'path'." });
      continue;
    }

    if (!relPath.includes("/")) relPath = `${fallbackDir}/${relPath}`;

    const absPath = path.join(projectRoot, relPath);
    try {
      if (!dryRun) {
        fs.mkdirSync(path.dirname(absPath), { recursive: true });
        fs.writeFileSync(absPath, scriptStubContent(role), "utf-8");
      }
      createdPaths.push(path.resolve(absPath));
      steps.push({ path: relPath, status: "ok" });
    } catch (err) {
      errors.push({ stage: fallbackDir, path: relPath, message: String(err) });
      steps.push({ path: relPath, status: "error" });
    }
  }

  return { processed: entries.length, createdPaths, steps, errors };
}

function processUIEntries({ projectRoot, entries, executor, dryRun }) {
  const createdPaths = [];
  const steps = [];
  const errors = [];

  for (const entry of entries) {
    if (!isPlainObject(entry)) {
      errors.push({ stage: "ui", message: "Invalid UI entry type." });
      continue;
    }

    const scenePath = String(entry.scene_path ?? "").trim();
    if (!scenePath) {
      errors.push({ stage: "ui", message: "UI entry missing 'scene_path'." });
      continue;
    }

    try {
      createScene({
        projectRoot,
        sceneRelPath: scenePath,
        rootType: "CanvasLayer",
        rootName: "UIScreen",
        executor,
        dryRun,
      });
      createdPaths.push(path.resolve(path.join(projectRoot, scenePath)));
      steps.push({ scene_path: scenePath, status: "ok" });
    } catch (err) {
      errors.push({ stage: "ui", path: scenePath, message: String(err) });
      steps.push({ scene_path: scenePath, status: "error" });
    }
  }

  return { processed: entries.length, createdPaths, steps, errors };
}

function processConfigEntries({ projectRoot, entries, dryRun }) {
  const createdPaths = [];
  const steps = [];
  const errors = [];

  for (const entry of entries) {
    if (!isPlainObject(entry)) {
      errors.push({ stage: "config_files", message: "Invalid config entry type." });
      continue;
    }

    const relPath = String(entry.path ?? "").trim();
    const purpose = String(entry.purpose ?? "").trim();
    if (!relPath) {
      errors.push({ stage: "config_files", message: "Config entry missing 'path'." });
      continue;
    }

    const absPath = path.join(projectRoot, relPath);
    try {
      if (!dryRun) {
        fs.mkdirSync(path.dirname(absPath), { recursive: true });
        const content = { purpose, generated_by: "factory.generator" };
        fs.writeFileSync(absPath, JSON.stringify(content, null, 2), "utf-8");
      }
      createdPaths.push(path.resolve(absPath));
      steps.push({ path: relPath, status: "ok" });
    } catch (err) {
      errors.push({ stage: "config_files", path: relPath, message: String(err) });
      steps.push({ path: relPath, status: "error" });
    }
  }

  return { processed: entries.length, createdPaths, steps, errors };
}

function createScene({ projectRoot, sceneRelPath, rootType, rootName, executor, dryRun }) {
  if (dryRun) return;

  const absPath = path.join(projectRoot, sceneRelPath);
  const canUseExecutor =
    executor &&
    typeof executor.createScene === "function" &&
    typeof executor.saveScene === "function";
  if (canUseExecutor) {
    try {
      const createRes = executor.createScene({
        scenePath: sceneRelPath,
        rootType,
        rootName,
      });
      const saveRes = executor.saveScene({ scenePath: sceneRelPath });

      const createOk =
        typeof createRes === "object" && createRes
          ? createRes.ok !== false
          : true;
      const saveOk =
        typeof saveRes === "object" && saveRes ? saveRes.ok !== false : true;

      // If the executor couldn't actually create the file (e.g. MCP missing),
      // fall back to deterministic filesystem stubs.
      if (createOk && saveOk && fs.existsSync(absPath)) return;
    } catch {
      // Fall back to deterministic filesystem stubs.
    }
  }

  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, sceneStubContent({ rootType, rootName }), "utf-8");
}

function addSceneNode({
  projectRoot,
  sceneRelPath,
  nodeName,
  nodeType,
  parent,
  scriptPath,
  executor,
  dryRun,
}) {
  if (dryRun) return;

  const canUseExecutor =
    executor &&
    typeof executor.addNode === "function" &&
    typeof executor.saveScene === "function";
  if (canUseExecutor) {
    try {
      const addRes = executor.addNode({
        scenePath: sceneRelPath,
        nodeName,
        nodeType,
        parentPath: parent,
      });
      let attachRes = null;
      if (scriptPath && typeof executor.attachScript === "function") {
        attachRes = executor.attachScript({
          scenePath: sceneRelPath,
          nodeName,
          scriptPath,
        });
      }
      const saveRes = executor.saveScene({ scenePath: sceneRelPath });

      const addOk = typeof addRes === "object" && addRes ? addRes.ok !== false : true;
      const attachOk =
        attachRes == null ||
        (typeof attachRes === "object" && attachRes ? attachRes.ok !== false : true);
      const saveOk =
        typeof saveRes === "object" && saveRes ? saveRes.ok !== false : true;

      if (addOk && attachOk && saveOk) return;
    } catch {
      // Fall back to placeholder marker.
    }
  }

  // Without executor we keep minimal marker logging for traceability.
  const markerPath = path.join(projectRoot, ".factory_scene_nodes.log");
  const line = `${sceneRelPath}|${parent}|${nodeName}|${nodeType}|${scriptPath ?? ""}\n`;
  fs.appendFileSync(markerPath, line, "utf-8");
}

function sceneStubContent({ rootType, rootName }) {
  return [
    "[gd_scene format=3]",
    "",
    `[node name="${rootName}" type="${rootType}"]`,
    "",
  ].join("\n");
}

function scriptStubContent(role) {
  const roleNote = role || "TODO: implement role-specific behavior";
  return [
    "extends Node",
    "",
    `# ${roleNote}`,
    "func _ready() -> void:",
    "    pass",
    "",
  ].join("\n");
}

function saveGenerationResult({ result, artifactsDir }) {
  const outDir = path.resolve(String(artifactsDir));
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, "generation_result.json");
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2), "utf-8");
  return outPath;
}

function safeList(value) {
  return Array.isArray(value) ? value : [];
}

function isPlainObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

