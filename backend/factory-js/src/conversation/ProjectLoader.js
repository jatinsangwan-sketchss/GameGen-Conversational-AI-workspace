/**
 * ProjectLoader
 * --------------
 * Loads an existing generated Godot project workspace for conversation edit mode.
 *
 * What this returns (single structured object):
 * - `projectRoot`: absolute path to the Godot workspace (contains `project.godot`)
 * - `sourceOfTruthDir`: directory containing canonical JSON artifacts
 * - `normalizedGameSpec`: contents of `normalized_game_spec.json`
 * - `generationRecipe`: contents of `generation_recipe.json`
 * - `projectState`: contents of `project_state.json`
 *
 * This module intentionally does NOT execute or re-run the factory pipeline.
 * It only loads artifacts so downstream conversation components can plan and
 * execute edits.
 */

import fs from "node:fs";
import path from "node:path";

import { loadJsonSchema, validateDataAgainstSchema } from "../../schema_utils.js";
import { SourceOfTruthManager } from "./SourceOfTruthManager.js";

function isLikelyDir(p) {
  if (p == null) return false;
  const s = String(p);
  if (!s.trim()) return false;
  try {
    return fs.existsSync(s) && fs.statSync(s).isDirectory();
  } catch {
    return false;
  }
}

function asProjectRoot({ projectRoot, projectId } = {}) {
  if (projectRoot) return path.resolve(String(projectRoot));

  // If the identifier already looks like a path to a directory, treat it as such.
  if (projectId && isLikelyDir(projectId)) return path.resolve(String(projectId));

  return null;
}

function resolveSourceOfTruthDir({
  sourceOfTruthDir,
  artifactsRoot,
  projectId,
  runId,
} = {}) {
  if (sourceOfTruthDir) return path.resolve(String(sourceOfTruthDir));

  if (artifactsRoot && projectId) {
    // Match the factory's artifact directory layout:
    // artifacts_root/<projectName>/<runId|latest>/intermediate/
    const runFolder = runId ? String(runId) : "latest";
    return path.resolve(String(artifactsRoot), String(projectId), runFolder, "intermediate");
  }

  return null;
}

function projectGodotPath(projectRoot) {
  return path.join(projectRoot, "project.godot");
}

function validateLoadedArtifact({ artifactName, data, schemaPath }) {
  // The factory schemaPath values are often stored as relative paths like:
  //   "factory-js/schemas/<name>.schema.json"
  // Their resolution depends on process.cwd().
  // Make this loader robust by trying a couple candidate absolute paths.
  let resolvedSchemaPath = path.resolve(String(schemaPath));
  if (!fs.existsSync(resolvedSchemaPath)) {
    const s = String(schemaPath);
    if (s.startsWith("factory-js/")) {
      const alt = path.resolve("backend", s);
      if (fs.existsSync(alt)) resolvedSchemaPath = alt;
    }
  }

  const schema = loadJsonSchema(resolvedSchemaPath);
  const validation = validateDataAgainstSchema(data, schema);
  if (validation.is_valid) {
    return { ok: true };
  }
  return {
    ok: false,
    artifact: artifactName,
    error: `${artifactName} schema validation failed`,
    details: validation.errors ?? [],
    schemaPath,
  };
}

export async function loadProjectWorkspace({
  projectId = null,
  projectRoot = null,
  sourceOfTruthDir = null,
  artifactsRoot = null,
  runId = null,
  validateNormalizedAndRecipe = true,
  requireProjectState = true,
} = {}) {
  const resolvedProjectRoot = asProjectRoot({ projectRoot, projectId });
  if (!resolvedProjectRoot) {
    return {
      ok: false,
      error:
        "projectRoot is required (or projectId must be a path to a directory).",
      project_root: projectRoot ?? null,
    };
  }

  const godotPath = projectGodotPath(resolvedProjectRoot);
  if (!fs.existsSync(godotPath)) {
    return {
      ok: false,
      error: `project.godot missing at: ${godotPath}`,
      project_root: resolvedProjectRoot,
      project_godot_path: godotPath,
    };
  }
  if (!fs.statSync(godotPath).isFile()) {
    return {
      ok: false,
      error: `project.godot path is not a file: ${godotPath}`,
      project_root: resolvedProjectRoot,
      project_godot_path: godotPath,
    };
  }

  const resolvedSourceOfTruthDir = resolveSourceOfTruthDir({
    sourceOfTruthDir,
    artifactsRoot,
    projectId: projectId ?? path.basename(resolvedProjectRoot),
    runId,
  });

  if (!resolvedSourceOfTruthDir) {
    return {
      ok: false,
      error:
        "sourceOfTruthDir is required (or provide artifactsRoot + projectId so the loader can resolve it).",
      project_root: resolvedProjectRoot,
    };
  }

  const manager = new SourceOfTruthManager({
    sourceOfTruthDir: resolvedSourceOfTruthDir,
  });

  // Load canonical artifacts.
  const normalizedRes = manager.loadNormalizedSpec({ required: true });
  if (!normalizedRes.ok) {
    return {
      ok: false,
      error: normalizedRes.error,
      artifact: normalizedRes.artifact,
      artifact_path: normalizedRes.path,
      project_root: resolvedProjectRoot,
      source_of_truth_dir: resolvedSourceOfTruthDir,
    };
  }

  const recipeRes = manager.loadGenerationRecipe({ required: true });
  if (!recipeRes.ok) {
    return {
      ok: false,
      error: recipeRes.error,
      artifact: recipeRes.artifact,
      artifact_path: recipeRes.path,
      project_root: resolvedProjectRoot,
      source_of_truth_dir: resolvedSourceOfTruthDir,
    };
  }

  const stateRes = manager.loadProjectState({ required: Boolean(requireProjectState) });
  if (!stateRes.ok) {
    return {
      ok: false,
      error: stateRes.error,
      artifact: stateRes.artifact,
      artifact_path: stateRes.path,
      project_root: resolvedProjectRoot,
      source_of_truth_dir: resolvedSourceOfTruthDir,
    };
  }

  const normalizedGameSpec = normalizedRes.data;
  const generationRecipe = recipeRes.data;
  const projectState = stateRes.data;

  // Optionally validate loaded spec + recipe (schema validity matters for edits).
  if (validateNormalizedAndRecipe) {
    const specValidation = validateLoadedArtifact({
      artifactName: "normalized_game_spec",
      data: normalizedGameSpec,
      schemaPath: manager.normalizedSpecSchemaPath,
    });
    if (!specValidation.ok) {
      return {
        ok: false,
        error: specValidation.error,
        artifact: specValidation.artifact,
        details: specValidation.details,
        schema_path: specValidation.schemaPath,
        project_root: resolvedProjectRoot,
        source_of_truth_dir: resolvedSourceOfTruthDir,
      };
    }

    const recipeValidation = validateLoadedArtifact({
      artifactName: "generation_recipe",
      data: generationRecipe,
      schemaPath: manager.generationRecipeSchemaPath,
    });
    if (!recipeValidation.ok) {
      return {
        ok: false,
        error: recipeValidation.error,
        artifact: recipeValidation.artifact,
        details: recipeValidation.details,
        schema_path: recipeValidation.schemaPath,
        project_root: resolvedProjectRoot,
        source_of_truth_dir: resolvedSourceOfTruthDir,
      };
    }
  }

  return {
    ok: true,
    project_root: resolvedProjectRoot,
    project_godot_path: godotPath,
    source_of_truth_dir: resolvedSourceOfTruthDir,
    normalized_game_spec_path: manager.normalizedSpecPath,
    generation_recipe_path: manager.generationRecipePath,
    project_state_path: manager.projectStatePath,
    normalizedGameSpec,
    generationRecipe,
    projectState,
  };
}

