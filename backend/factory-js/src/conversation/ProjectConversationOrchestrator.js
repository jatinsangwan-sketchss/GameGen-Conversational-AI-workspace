/**
 * ProjectConversationOrchestrator
 * --------------------------------
 * Edit-mode orchestrator for conversation-driven modifications of an
 * existing generated Godot project.
 *
 * Difference vs `FactoryRunner`:
 * - FactoryRunner: spec ingest -> planning -> scaffolding -> generation -> validation
 * - This orchestrator: open existing workspace -> plan a structured change -> execute it
 *
 * This module intentionally does NOT implement planning logic, MCP logic,
 * or file mutation logic. It only coordinates existing modules and
 * optionally emits live progress/debug/error events.
 */

import { SourceOfTruthManager } from "./SourceOfTruthManager.js";
import { loadProjectWorkspace } from "./ProjectLoader.js";
import { planChange } from "./ChangePlanner.js";
import { executeChangePlan } from "./ChangeExecutor.js";

const EVENT_TYPES = Object.freeze({
  progress: "progress",
  debug: "debug",
  error: "error",
  final: "final_result",
});

function isoNow() {
  return new Date().toISOString();
}

function safeString(v) {
  return v == null ? "" : String(v);
}

function serializeError(err) {
  if (err == null) return { message: "Unknown error" };
  if (typeof err !== "object") return { message: safeString(err) };
  return {
    name: err?.name ?? "Error",
    message: err?.message ?? safeString(err),
    stack: err?.stack ?? null,
  };
}

function makeEvent({ type, stage, message, data = undefined }) {
  return {
    type,
    stage,
    message,
    timestamp: isoNow(),
    ...(data !== undefined ? { data } : {}),
  };
}

function emit(onEvent, event) {
  if (typeof onEvent !== "function") return;
  try {
    onEvent(event);
  } catch {
    // Never allow event handlers to break execution.
  }
}

function beginTimer() {
  return { startedAt: Date.now() };
}

function endTimer(timer) {
  return { duration_ms: Date.now() - timer.startedAt };
}

export async function runProjectConversationEdit({
  // Project identification / location
  projectId = null,
  projectRoot = null,
  sourceOfTruthDir = null,
  artifactsRoot = null,
  runId = null,

  // Conversation input
  userRequestText,

  // Planning LLM
  llmClient = null,
  llmConfig = null,
  modelName = "gpt-oss:20b",

  // Execution dependencies
  executor,
  validator = null,

  // Validation settings
  boundedValidationSeconds = 5,
  strictValidation = false,

  // Controls
  validateNormalizedAndRecipe = true,
  requireProjectState = true,

  // Live events
  onEvent = null,
} = {}) {
  const overallLogs = [];
  const stageTimings = {};

  function debug(stage, message, data = undefined) {
    overallLogs.push({ timestamp: isoNow(), stage, message, data });
    emit(onEvent, makeEvent({ type: EVENT_TYPES.debug, stage, message, data }));
  }

  function progress(stage, message, data = undefined) {
    emit(onEvent, makeEvent({ type: EVENT_TYPES.progress, stage, message, data }));
  }

  function error(stage, message, err = undefined, data = undefined) {
    const serialized = serializeError(err);
    if (data === undefined) {
      data = { error: serialized };
    } else {
      data = { ...data, error: serialized };
    }
    emit(onEvent, makeEvent({ type: EVENT_TYPES.error, stage, message, data }));
  }

  // -----------------------------
  // Stage 1: Load existing workspace
  // -----------------------------
  const loadTimer = beginTimer();
  progress("load_workspace", "Loading existing project workspace");

  const workspaceRes = await loadProjectWorkspace({
    projectId,
    projectRoot,
    sourceOfTruthDir,
    artifactsRoot,
    runId,
    validateNormalizedAndRecipe,
    requireProjectState,
  });

  stageTimings.load_workspace = endTimer(loadTimer);
  if (!workspaceRes?.ok) {
    error("load_workspace", "Failed to load project workspace", workspaceRes?.error);
    return {
      ok: false,
      error: workspaceRes?.error ?? "Failed to load workspace",
      errors: [{ stage: "load_workspace", error: workspaceRes?.error }],
      workspace: workspaceRes,
      stageResults: { load_workspace: workspaceRes },
      stageTimings,
    };
  }

  debug("load_workspace", "Workspace loaded", {
    project_root: workspaceRes.project_root,
    source_of_truth_dir: workspaceRes.source_of_truth_dir,
  });

  // -----------------------------
  // Stage 2: Plan the change (no mutation here)
  // -----------------------------
  const planTimer = beginTimer();
  progress("plan_change", "Planning conversational edit");

  const planRes = await planChange({
    workspace: {
      project_root: workspaceRes.project_root,
      projectRoot: workspaceRes.project_root,
      source_of_truth_dir: workspaceRes.source_of_truth_dir,
      normalizedGameSpec: workspaceRes.normalizedGameSpec,
      generationRecipe: workspaceRes.generationRecipe,
      projectState: workspaceRes.projectState,
    },
    userRequestText,
    llmClient,
    llmConfig,
    modelName,
    boundedValidationSeconds,
    strictValidation: strictValidation,
  });

  stageTimings.plan_change = endTimer(planTimer);
  if (!planRes?.ok) {
    error("plan_change", "Failed to plan change", planRes?.error, { details: planRes?.details });
    return {
      ok: false,
      error: planRes?.error ?? "Failed to plan change",
      errors: [{ stage: "plan_change", error: planRes?.error }],
      workspace: workspaceRes,
      plan: planRes?.plan ?? null,
      stageResults: { load_workspace: workspaceRes, plan_change: planRes },
      stageTimings,
    };
  }

  debug("plan_change", "Change plan created", {
    intent_summary: planRes.plan?.intent_summary ?? null,
    affected_project_files: planRes.plan?.affected_project_files ?? [],
  });

  // -----------------------------
  // Stage 3: Execute the plan (updates + validation)
  // -----------------------------
  const execTimer = beginTimer();
  progress("execute_change", "Executing structured change plan");

  const sotManager = new SourceOfTruthManager({
    sourceOfTruthDir: workspaceRes.source_of_truth_dir,
  });

  const execRes = await executeChangePlan({
    workspace: {
      project_root: workspaceRes.project_root,
      projectRoot: workspaceRes.project_root,
      normalizedGameSpec: workspaceRes.normalizedGameSpec,
      generationRecipe: workspaceRes.generationRecipe,
      projectState: workspaceRes.projectState,
    },
    changePlan: planRes.plan,
    sourceOfTruthManager: sotManager,
    executor,
    validator,
    boundedValidationSeconds,
    strictValidation,
  });

  stageTimings.execute_change = endTimer(execTimer);
  if (!execRes?.ok) {
    error("execute_change", "Change execution failed", execRes?.error, {
      execution: execRes?.execution ?? null,
    });
    return {
      ok: false,
      error: execRes?.error ?? "Change execution failed",
      errors: execRes?.errors ?? [{ stage: "execute_change", error: execRes?.error }],
      workspace: workspaceRes,
      plan: planRes.plan,
      execution: execRes,
      stageResults: { load_workspace: workspaceRes, plan_change: planRes, execute_change: execRes },
      stageTimings,
    };
  }

  debug("execute_change", "Change executed successfully", {
    validation_status: execRes?.validation_result?.validation_report?.status ?? null,
  });

  emit(onEvent, makeEvent({ type: EVENT_TYPES.final, stage: "run", message: "Edit mode completed", data: { ok: true } }));

  return {
    ok: true,
    workspace: workspaceRes,
    plan: planRes.plan,
    execution: execRes,
    stageResults: { load_workspace: workspaceRes, plan_change: planRes, execute_change: execRes },
    stageTimings,
  };
}

