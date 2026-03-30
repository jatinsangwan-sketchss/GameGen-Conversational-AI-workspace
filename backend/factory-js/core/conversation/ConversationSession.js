/**
 * ConversationSession
 * -------------------
 * In-memory state for a repeated edit-mode conversational interaction on an
 * existing generated Godot project.
 *
 * Kept intentionally simple:
 * - no persistence/logging to disk
 * - no planning/execution logic (handled by orchestrator/executor)
 * - stores latest loaded workspace + latest source-of-truth snapshots
 * - stores recent conversation turns so the terminal/orchestrator can build
 *   context for subsequent requests
 */

import path from "node:path";

function isoNow() {
  return new Date().toISOString();
}

function isPlainObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function shallowClone(obj) {
  if (!isPlainObject(obj)) return obj;
  return { ...obj };
}

function coerceArray(v) {
  return Array.isArray(v) ? v : [];
}

/**
 * @typedef {object} ConversationTurn
 * @property {string} user_request_text
 * @property {string} created_at
 * @property {object|null} [plan]
 * @property {object|null} [execution]
 * @property {object|null} [validation]
 * @property {object|null} [metadata]
 */

export class ConversationSession {
  /**
   * @param {object} params
   * @param {object} params.workspace - The workspace returned by `ProjectLoader`.
   * @param {string|null} [params.sessionId]
   * @param {number} [params.maxTurns=20] - In-memory turn limit.
   */
  constructor({ workspace, sessionId = null, maxTurns = 20 } = {}) {
    if (!workspace || !isPlainObject(workspace)) {
      throw new Error("ConversationSession requires `workspace` as an object.");
    }

    this.sessionId = sessionId ?? null;
    this.createdAt = isoNow();
    this.updatedAt = this.createdAt;
    this.maxTurns = Number(maxTurns) > 0 ? Number(maxTurns) : 20;

    /** @type {object} */
    this.workspace = shallowClone(workspace);

    // Source-of-truth references (paths) and latest snapshots (in memory).
    // Canonical artifacts: normalized_game_spec.json, generation_recipe.json, project_state.json
    this.sourceOfTruthRefs = {
      source_of_truth_dir: workspace.source_of_truth_dir ?? null,
      normalized_game_spec_path: workspace.normalized_game_spec_path ?? null,
      generation_recipe_path: workspace.generation_recipe_path ?? null,
      project_state_path: workspace.project_state_path ?? null,
    };

    // Latest source-of-truth snapshots (can be updated by executor).
    this.sourceOfTruth = {
      normalized_game_spec: workspace.normalizedGameSpec ?? null,
      generation_recipe: workspace.generationRecipe ?? null,
      project_state: workspace.projectState ?? null,
    };

    /** @type {ConversationTurn[]} */
    this.turns = [];

    // Latest validation result (from validator/executeChangePlan).
    this.latestValidation = null;
  }

  // -----------------------------
  // Workspace / project metadata
  // -----------------------------

  getWorkspace() {
    return shallowClone(this.workspace);
  }

  getProjectRoot() {
    return this.workspace.project_root ?? this.workspace.projectRoot ?? null;
  }

  getSourceOfTruthRefs() {
    return shallowClone(this.sourceOfTruthRefs);
  }

  getSourceOfTruthSnapshot() {
    return {
      normalized_game_spec: this.sourceOfTruth.normalized_game_spec,
      generation_recipe: this.sourceOfTruth.generation_recipe,
      project_state: this.sourceOfTruth.project_state,
    };
  }

  // -----------------------------
  // Validation state
  // -----------------------------

  getLatestValidation() {
    return this.latestValidation;
  }

  setLatestValidation(validationResult) {
    this.latestValidation = validationResult ?? null;
    this.updatedAt = isoNow();
    return this.latestValidation;
  }

  // -----------------------------
  // Source-of-truth state
  // -----------------------------

  /**
   * Update in-memory canonical artifacts after an executor successfully
   * applied changes.
   *
   * @param {object} params
   * @param {object|null} [params.normalizedGameSpec]
   * @param {object|null} [params.generationRecipe]
   * @param {object|null} [params.projectState]
   */
  updateSourceOfTruth({ normalizedGameSpec = undefined, generationRecipe = undefined, projectState = undefined } = {}) {
    if (normalizedGameSpec !== undefined) this.sourceOfTruth.normalized_game_spec = normalizedGameSpec;
    if (generationRecipe !== undefined) this.sourceOfTruth.generation_recipe = generationRecipe;
    if (projectState !== undefined) this.sourceOfTruth.project_state = projectState;

    this.updatedAt = isoNow();
    return this.getSourceOfTruthSnapshot();
  }

  /**
   * Update in-memory canonical artifacts *by referencing* paths only.
   * This is useful if the caller already loaded the latest JSON elsewhere.
   */
  updateSourceOfTruthRefs({
    source_of_truth_dir = undefined,
    normalized_game_spec_path = undefined,
    generation_recipe_path = undefined,
    project_state_path = undefined,
  } = {}) {
    if (source_of_truth_dir !== undefined) this.sourceOfTruthRefs.source_of_truth_dir = source_of_truth_dir;
    if (normalized_game_spec_path !== undefined) this.sourceOfTruthRefs.normalized_game_spec_path = normalized_game_spec_path;
    if (generation_recipe_path !== undefined) this.sourceOfTruthRefs.generation_recipe_path = generation_recipe_path;
    if (project_state_path !== undefined) this.sourceOfTruthRefs.project_state_path = project_state_path;
    this.updatedAt = isoNow();
    return this.getSourceOfTruthRefs();
  }

  // -----------------------------
  // Conversation turns
  // -----------------------------

  /**
   * Add a conversation turn in memory.
   *
   * Note: the orchestrator/executor typically builds plan and execution
   * results; this method only stores them so the next turn can reference
   * history.
   *
   * @param {object} params
   * @param {string} params.userRequestText
   * @param {object|null} [params.plan]
   * @param {object|null} [params.execution]
   * @param {object|null} [params.validation]
   * @param {object|null} [params.metadata]
   */
  addTurn({
    userRequestText,
    plan = null,
    execution = null,
    validation = null,
    metadata = null,
  } = {}) {
    const text = typeof userRequestText === "string" ? userRequestText : "";
    if (!text.trim()) {
      throw new Error("addTurn requires non-empty `userRequestText`.");
    }

    /** @type {ConversationTurn} */
    const turn = {
      user_request_text: text,
      created_at: isoNow(),
      plan: plan ?? null,
      execution: execution ?? null,
      validation: validation ?? null,
      metadata: metadata ?? null,
    };

    this.turns.push(turn);
    // Drop old turns to keep memory bounded.
    if (this.turns.length > this.maxTurns) {
      this.turns = this.turns.slice(-this.maxTurns);
    }

    // Keep latest validation in sync with last turn when provided.
    if (validation != null) {
      this.latestValidation = validation;
    }

    this.updatedAt = isoNow();
    return turn;
  }

  getRecentTurns({ limit = 10 } = {}) {
    const n = Number(limit);
    const safe = Number.isFinite(n) && n > 0 ? Math.floor(n) : 10;
    return coerceArray(this.turns).slice(-safe);
  }

  clearTurns() {
    this.turns = [];
    this.updatedAt = isoNow();
  }
}

