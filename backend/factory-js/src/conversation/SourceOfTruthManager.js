/**
 * SourceOfTruthManager
 * ---------------------
 * Manages the canonical JSON artifacts used to represent the current
 * “source of truth” for a generated game project during conversation-driven
 * edits.
 *
 * Canonical artifacts (v1):
 * - `normalized_game_spec.json` (derived/produced by spec ingest)
 * - `generation_recipe.json` (derived/produced by planning)
 * - `project_state.json` (conversation runtime state; minimal semantics)
 *
 * Notes:
 * - This module is intentionally storage-focused and does not implement any
 *   planning logic (no LLM prompts, no change planning, no repair logic).
 * - It supports a conservative patch/update flow for the JSON artifacts.
 * - `normalized_game_spec.json` and `generation_recipe.json` are validated
 *   on write against the existing factory JSON schemas.
 */

import fs from "node:fs";
import path from "node:path";

import { loadJsonSchema, validateDataAgainstSchema } from "../../schema_utils.js";

export const DEFAULT_NORMALIZED_SPEC_FILENAME = "normalized_game_spec.json";
export const DEFAULT_GENERATION_RECIPE_FILENAME = "generation_recipe.json";
export const DEFAULT_PROJECT_STATE_FILENAME = "project_state.json";

export const DEFAULT_NORMALIZED_SPEC_SCHEMA_PATH =
  "factory-js/schemas/normalized_game_spec.schema.json";
export const DEFAULT_GENERATION_RECIPE_SCHEMA_PATH =
  "factory-js/schemas/generation_recipe.schema.json";

function isPlainObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function safeString(v) {
  return v == null ? "" : String(v);
}

function deepCloneJson(value) {
  // Artifacts are JSON-only in this factory layer.
  return JSON.parse(JSON.stringify(value));
}

function ensureDirForFile(filePath) {
  const dir = path.dirname(String(filePath));
  fs.mkdirSync(dir, { recursive: true });
}

function readJsonFile(filePath) {
  const resolved = path.resolve(String(filePath));
  const raw = fs.readFileSync(resolved, "utf-8");
  const parsed = JSON.parse(raw);
  return parsed;
}

function writeJsonFile(filePath, data) {
  ensureDirForFile(filePath);
  const resolved = path.resolve(String(filePath));
  fs.writeFileSync(resolved, JSON.stringify(data, null, 2), "utf-8");
  return resolved;
}

/**
 * Conservative JSON “merge patch” implementation (RFC 7396-like):
 * - When patch value is `null`, the key is deleted.
 * - Objects are merged recursively.
 * - Arrays are replaced wholesale.
 *
 * This is suitable for small conversational updates without complex diffing.
 */
function applyMergePatch(target, patch) {
  // Root-level deletion/replacement is not expected for our artifacts,
  // but we handle it for robustness.
  if (patch === null) return null;
  if (!isPlainObject(patch)) return patch;

  const base = isPlainObject(target) ? deepCloneJson(target) : {};

  for (const [key, patchValue] of Object.entries(patch)) {
    if (patchValue === null) {
      delete base[key];
      continue;
    }

    const baseValue = base[key];
    if (isPlainObject(baseValue) && isPlainObject(patchValue)) {
      base[key] = applyMergePatch(baseValue, patchValue);
      continue;
    }

    // Arrays and primitives: replace.
    base[key] = patchValue;
  }

  return base;
}

export class SourceOfTruthManager {
  constructor({
    sourceOfTruthDir,
    normalizedSpecPath = null,
    generationRecipePath = null,
    projectStatePath = null,
    normalizedSpecSchemaPath = DEFAULT_NORMALIZED_SPEC_SCHEMA_PATH,
    generationRecipeSchemaPath = DEFAULT_GENERATION_RECIPE_SCHEMA_PATH,
  } = {}) {
    if (!sourceOfTruthDir) {
      throw new Error("SourceOfTruthManager requires 'sourceOfTruthDir'.");
    }

    const dir = path.resolve(String(sourceOfTruthDir));
    this.normalizedSpecPath =
      normalizedSpecPath ?? path.join(dir, DEFAULT_NORMALIZED_SPEC_FILENAME);
    this.generationRecipePath =
      generationRecipePath ?? path.join(dir, DEFAULT_GENERATION_RECIPE_FILENAME);
    this.projectStatePath =
      projectStatePath ?? path.join(dir, DEFAULT_PROJECT_STATE_FILENAME);

    this.normalizedSpecSchemaPath = normalizedSpecSchemaPath;
    this.generationRecipeSchemaPath = generationRecipeSchemaPath;

    /** @type {null | { normalized: any, recipe: any }} */
    this._cachedSchemas = null;
  }

  static fromIntermediateDir(intermediateDir) {
    // In the current v1 pipeline, both normalized spec and generation recipe
    // are saved under the `intermediate/` folder.
    return new SourceOfTruthManager({ sourceOfTruthDir: intermediateDir });
  }

  _loadSchemasIfNeeded() {
    if (this._cachedSchemas) return this._cachedSchemas;
    const normalized = loadJsonSchema(this.normalizedSpecSchemaPath);
    const recipe = loadJsonSchema(this.generationRecipeSchemaPath);
    this._cachedSchemas = { normalized, recipe };
    return this._cachedSchemas;
  }

  // -----------------------------
  // Generic read/save helpers
  // -----------------------------

  _result({ ok, artifact, path: artifactPath, data = undefined, error = undefined }) {
    return {
      ok,
      artifact,
      path: artifactPath,
      ...(data !== undefined ? { data } : {}),
      ...(error !== undefined ? { error } : {}),
    };
  }

  loadNormalizedSpec({ required = true } = {}) {
    return this._loadArtifact({
      artifact: "normalized_game_spec",
      filePath: this.normalizedSpecPath,
      required,
    });
  }

  loadGenerationRecipe({ required = true } = {}) {
    return this._loadArtifact({
      artifact: "generation_recipe",
      filePath: this.generationRecipePath,
      required,
    });
  }

  loadProjectState({ required = false } = {}) {
    const artifact = "project_state";
    const filePath = this.projectStatePath;

    try {
      if (!fs.existsSync(filePath)) {
        if (required) {
          return this._result({
            ok: false,
            artifact,
            path: filePath,
            error: `Missing ${artifact} file.`,
          });
        }
        // Absent state is treated as empty state.
        return this._result({ ok: true, artifact, path: filePath, data: {} });
      }

      const parsed = readJsonFile(filePath);
      if (!isPlainObject(parsed)) {
        return this._result({
          ok: false,
          artifact,
          path: filePath,
          error: `${artifact} must be a JSON object.`,
        });
      }

      return this._result({ ok: true, artifact, path: filePath, data: parsed });
    } catch (err) {
      return this._result({
        ok: false,
        artifact,
        path: filePath,
        error: safeString(err?.message ?? err),
      });
    }
  }

  _loadArtifact({ artifact, filePath, required }) {
    try {
      if (!fs.existsSync(filePath)) {
        if (required) {
          return this._result({
            ok: false,
            artifact,
            path: filePath,
            error: `Missing ${artifact} file at: ${filePath}`,
          });
        }
        return this._result({ ok: true, artifact, path: filePath, data: null });
      }

      const parsed = readJsonFile(filePath);
      return this._result({ ok: true, artifact, path: filePath, data: parsed });
    } catch (err) {
      return this._result({
        ok: false,
        artifact,
        path: filePath,
        error: safeString(err?.message ?? err),
      });
    }
  }

  saveNormalizedSpec(spec) {
    return this._saveArtifactWithValidation({
      artifact: "normalized_game_spec",
      filePath: this.normalizedSpecPath,
      schemaKey: "normalized",
      data: spec,
    });
  }

  saveGenerationRecipe(recipe) {
    return this._saveArtifactWithValidation({
      artifact: "generation_recipe",
      filePath: this.generationRecipePath,
      schemaKey: "recipe",
      data: recipe,
    });
  }

  saveProjectState(state) {
    const artifact = "project_state";
    const filePath = this.projectStatePath;
    try {
      if (!isPlainObject(state)) {
        return this._result({
          ok: false,
          artifact,
          path: filePath,
          error: `${artifact} must be a JSON object.`,
        });
      }
      const savedPath = writeJsonFile(filePath, state);
      return this._result({ ok: true, artifact, path: savedPath, data: state });
    } catch (err) {
      return this._result({
        ok: false,
        artifact,
        path: filePath,
        error: safeString(err?.message ?? err),
      });
    }
  }

  _saveArtifactWithValidation({ artifact, filePath, schemaKey, data }) {
    try {
      const schemas = this._loadSchemasIfNeeded();
      const schema = schemaKey === "normalized" ? schemas.normalized : schemas.recipe;

      const parsed = data;
      const isObject = isPlainObject(parsed) || Array.isArray(parsed);
      if (!isObject) {
        return this._result({
          ok: false,
          artifact,
          path: filePath,
          error: `${artifact} must be a JSON value.`,
        });
      }

      // Validate against schema on write.
      const validation = validateDataAgainstSchema(parsed, schema);
      if (!validation.is_valid) {
        return this._result({
          ok: false,
          artifact,
          path: filePath,
          error: `${artifact} schema validation failed: ${JSON.stringify(
            validation.errors ?? [],
            null,
            2
          )}`,
        });
      }

      const savedPath = writeJsonFile(filePath, parsed);
      return this._result({ ok: true, artifact, path: savedPath, data: parsed });
    } catch (err) {
      return this._result({
        ok: false,
        artifact,
        path: filePath,
        error: safeString(err?.message ?? err),
      });
    }
  }

  // -----------------------------
  // Patch/update flows
  // -----------------------------

  /**
   * Patch normalized spec and re-validate before saving.
   *
   * @param {object} patch - JSON merge patch (objects merge, arrays replace).
   */
  updateNormalizedSpec(patch, { createIfMissing = false } = {}) {
    const artifact = "normalized_game_spec";
    const filePath = this.normalizedSpecPath;

    const loaded = createIfMissing
      ? this.loadNormalizedSpec({ required: false })
      : this.loadNormalizedSpec({ required: true });

    if (!loaded.ok) return loaded;
    const base = loaded.data ?? {};
    if (!isPlainObject(base)) {
      return this._result({
        ok: false,
        artifact,
        path: filePath,
        error: `${artifact} root must be an object for patching.`,
      });
    }

    if (!isPlainObject(patch)) {
      return this._result({
        ok: false,
        artifact,
        path: filePath,
        error: "patch must be a JSON object.",
      });
    }

    const updated = applyMergePatch(base, patch);
    return this.saveNormalizedSpec(updated);
  }

  /**
   * Patch generation recipe and re-validate before saving.
   *
   * @param {object} patch - JSON merge patch (objects merge, arrays replace).
   */
  updateGenerationRecipe(patch, { createIfMissing = false } = {}) {
    const artifact = "generation_recipe";
    const filePath = this.generationRecipePath;

    const loaded = createIfMissing
      ? this.loadGenerationRecipe({ required: false })
      : this.loadGenerationRecipe({ required: true });

    if (!loaded.ok) return loaded;
    const base = loaded.data ?? {};
    if (!isPlainObject(base)) {
      return this._result({
        ok: false,
        artifact,
        path: filePath,
        error: `${artifact} root must be an object for patching.`,
      });
    }

    if (!isPlainObject(patch)) {
      return this._result({
        ok: false,
        artifact,
        path: filePath,
        error: "patch must be a JSON object.",
      });
    }

    const updated = applyMergePatch(base, patch);
    return this.saveGenerationRecipe(updated);
  }

  /**
   * Patch project state without schema validation (simple object semantics).
   */
  updateProjectState(patch, { createIfMissing = true } = {}) {
    const artifact = "project_state";
    const filePath = this.projectStatePath;

    const loaded = createIfMissing
      ? this.loadProjectState({ required: false })
      : this.loadProjectState({ required: true });

    if (!loaded.ok) return loaded;
    const base = loaded.data ?? {};
    if (!isPlainObject(base)) {
      return this._result({
        ok: false,
        artifact,
        path: filePath,
        error: `${artifact} root must be an object for patching.`,
      });
    }

    if (!isPlainObject(patch)) {
      return this._result({
        ok: false,
        artifact,
        path: filePath,
        error: "patch must be a JSON object.",
      });
    }

    const updated = applyMergePatch(base, patch);
    return this.saveProjectState(updated);
  }
}

