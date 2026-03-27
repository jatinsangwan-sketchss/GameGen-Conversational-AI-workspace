/**
 * Main factory orchestration entrypoint (WIP).
 *
 * For the migration:
 * - We already ported: spec_ingest + planner + the LLM/prompt/structured-output plumbing.
 * - We now port the execution pipeline stages in JS:
 *   scaffolding -> generation -> validation -> optional repair.
 *
 * This runner:
 * - creates predictable artifact folders
 * - runs the full v1 pipeline (with bounded validation + conservative repair)
 */

import fs from "node:fs";
import path from "node:path";

import { ingestNormalizedSpec } from "../../spec_ingest.js";
import { buildGenerationRecipe } from "../../planner.js";
import { scaffoldProject } from "../../project_scaffolder.js";
import { createLLMClient } from "../../llm/client.js";
import { generateProjectFromRecipe } from "../../generator.js";
import { validateProject } from "../validation/validator.js";
import { GodotExecutor } from "../godot/GodotExecutor.js";
import { runRepairLoop } from "../repair/RepairLoop.js";

const EVENT_TYPES = Object.freeze({
  progress: "progress",
  debug: "debug",
  artifact: "artifact_creation",
  error: "error",
  final: "final_result",
});

function isoNow() {
  return new Date().toISOString();
}

function serializeError(err) {
  if (err == null) return { message: "Unknown error" };
  if (typeof err !== "object") return { message: String(err) };
  return {
    name: err?.name ?? "Error",
    message: err?.message ?? String(err),
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

export function runFactory({
  projectName,
  prdPath,
  gddPath,
  uiSpecPath,
  // Included for API completeness; current v1 pipeline only needs `uiSpecPath`.
  uiGenerationOutputs = null,
  starterTemplate,
  targetOutputPath,
  platform,
  orientation = null,
  overwrite = false,
  milestone = null,
  constraints = null,
  artifactsRoot = null,
  runId = null,
  modelName = "gpt-oss-20b",
  llmConfig = null,
  llmClient = null,
  executor = null,
  // Execution stages (WIP)
  enableRepair = false,
  maxRepairAttempts = 3,
  boundedValidationSeconds = 5,
  strictValidation = false,
  dryRun = false,
  onEvent = null,
  persistLogs = false,
  consoleEvents = true,
} = {}) {
  const failures = [];
  const runLogs = [];
  const runEvents = [];
  /** @type {Record<string, { started_at: string, ended_at: string, duration_ms: number }>} */
  const stageTimings = {};

  // Edit-mode depends on a single coherent on-disk run layout:
  //   run_root/
  //     project/
  //     intermediate/   (normalized_game_spec.json, generation_recipe.json, project_state.json)
  //     reports/
  //     logs/
  //
  // We therefore derive the generated project root and the canonical
  // artifact roots from the *same* run root.
  let runRoot = null;
  let projectRoot = null;
  let artifactDirs = null;
  let intermediateDir = null;
  let reportsDir = null;
  let logsDir = null;

  const artifactsRootToUse =
    artifactsRoot != null
      ? artifactsRoot
      : // Infer a stable artifacts parent from the requested target path.
        // This keeps scaffolding + canonical artifacts under one coherent tree.
        path.dirname(path.resolve(String(targetOutputPath)));

  artifactDirs = ensureRunArtifactDirs({
    projectName,
    artifactsRoot: artifactsRootToUse,
    runId,
  });

  runRoot = artifactDirs.runArtifactsDir;
  intermediateDir = artifactDirs.intermediateDir;
  reportsDir = artifactDirs.reportsDir;
  logsDir = artifactDirs.logsDir;
  projectRoot = path.join(runRoot, "project");
  // Canonical source-of-truth artifacts required by edit-mode.
  // ProjectLoader expects these filenames under this directory.
  const sourceOfTruthDir = intermediateDir;
  const normalizedGameSpecPath = path.join(sourceOfTruthDir, "normalized_game_spec.json");
  const generationRecipePath = path.join(sourceOfTruthDir, "generation_recipe.json");
  const projectStatePath = path.join(sourceOfTruthDir, "project_state.json");

  function writeJsonFile(filePath, data) {
    fs.mkdirSync(path.dirname(String(filePath)), { recursive: true });
    fs.writeFileSync(path.resolve(String(filePath)), JSON.stringify(data, null, 2), "utf-8");
  }

  function buildProjectState({
    projectId,
    projectNameForState,
    projectRoot,
    platform,
    orientation,
    runId,
    currentStatus,
    latestValidationStatus,
  }) {
    const now = isoNow();
    return {
      project_id: projectId,
      project_name: projectNameForState,
      project_root: projectRoot,
      platform,
      orientation: orientation ?? null,
      run_id: runId ?? null,
      current_status: currentStatus,
      latest_validation_status: latestValidationStatus ?? null,
      artifact_paths: {
        normalized_game_spec_path: normalizedGameSpecPath,
        generation_recipe_path: generationRecipePath,
        project_state_path: projectStatePath,
      },
      created_at: now,
      updated_at: now,
    };
  }

  function updateProjectState(partial) {
    let existing = null;
    if (fs.existsSync(projectStatePath)) {
      try {
        existing = JSON.parse(fs.readFileSync(projectStatePath, "utf-8"));
      } catch {
        existing = null;
      }
    }
    const base = existing ?? buildProjectState({
      projectId: projectName,
      projectNameForState: projectName,
      projectRoot,
      platform,
      orientation,
      runId,
      currentStatus: "unknown",
      latestValidationStatus: null,
    });

    const now = isoNow();
    const merged = {
      ...base,
      ...partial,
      updated_at: now,
    };

    writeJsonFile(projectStatePath, merged);
    return merged;
  }

  function projectGodotPathForRoot(root) {
    return path.join(root, "project.godot");
  }

  function assertScaffoldingProducedProject() {
    const godotPath = projectGodotPathForRoot(projectRoot);
    if (!fs.existsSync(godotPath)) {
      throw new Error(
        `Scaffolding produced no Godot project: missing 'project.godot' at ${godotPath}`
      );
    }
    if (!fs.statSync(godotPath).isFile()) {
      throw new Error(
        `Scaffolding produced no Godot project: 'project.godot' is not a file at ${godotPath}`
      );
    }
  }

  function assertGenerationProducedAtLeastOneAsset({ generationRecipe }) {
    // Conservative check: ensure Godot project exists and at least one
    // recipe-driven file exists on disk (or that generation was not a dry-run).
    assertScaffoldingProducedProject();

    const candidates = [];

    for (const entry of Array.isArray(generationRecipe?.scenes_to_create)
      ? generationRecipe.scenes_to_create
      : []) {
      const p = entry?.path;
      if (typeof p === "string" && p.trim()) candidates.push(p.trim());
    }
    for (const entry of Array.isArray(generationRecipe?.scripts_to_create)
      ? generationRecipe.scripts_to_create
      : []) {
      const p = entry?.path;
      if (typeof p === "string" && p.trim()) candidates.push(p.trim());
    }
    for (const entry of Array.isArray(generationRecipe?.systems_to_create)
      ? generationRecipe.systems_to_create
      : []) {
      const p = entry?.path;
      if (typeof p === "string" && p.trim()) candidates.push(p.trim());
    }

    if (candidates.length === 0) {
      // If the recipe is empty, we can't verify file creation. Fail to be safe.
      throw new Error("Generation produced no assets: generation_recipe contains no file targets.");
    }

    const anyExists = candidates.some((relPath) => {
      const abs = path.join(projectRoot, relPath);
      return fs.existsSync(abs);
    });

    if (!anyExists) {
      throw new Error(
        "Generation produced no project assets: none of the expected recipe paths were created. " +
          "Check dryRun, executor behavior, or recipe contents."
      );
    }
  }

  const emitEvent = (event) => {
    runEvents.push(event);
    if (consoleEvents) {
      // Live visibility during development.
      // Keep it structured for downstream tools; do not persist by default.
      console.log(JSON.stringify(event));
    }
    if (typeof onEvent !== "function") return;
    try {
      onEvent(event);
    } catch {
      // Never allow a caller's onEvent handler to crash the pipeline.
    }
  };

  const pushLog = ({ level = "info", stage, message, data = undefined }) => {
    const entry = {
      timestamp: isoNow(),
      level,
      stage,
      message,
      ...(data !== undefined ? { data } : {}),
    };
    runLogs.push(entry);
  };

  const beginStage = (stageName) => {
    pushLog({ level: "info", stage: stageName, message: `Starting stage: ${stageName}` });
    emitEvent(
      makeEvent({
        type: EVENT_TYPES.progress,
        stage: stageName,
        message: `Starting stage`,
      })
    );
    return { stageName, startedAt: Date.now(), startedIso: isoNow() };
  };

  const endStage = (stageCtx, message, extraData = undefined) => {
    const durationMs = Date.now() - stageCtx.startedAt;
    const endedIso = isoNow();
    stageTimings[stageCtx.stageName] = {
      started_at: stageCtx.startedIso,
      ended_at: endedIso,
      duration_ms: durationMs,
    };
    pushLog({
      level: "info",
      stage: stageCtx.stageName,
      message: message || `Completed stage`,
      data: extraData,
    });
    emitEvent(
      makeEvent({
        type: EVENT_TYPES.progress,
        stage: stageCtx.stageName,
        message: message || "Stage completed",
        data: { duration_ms: durationMs, ...(extraData || {}) },
      })
    );
  };

  const failStage = (stageCtx, err, stageMessage = "Stage failed") => {
    const durationMs = Date.now() - stageCtx.startedAt;
    const endedIso = isoNow();
    stageTimings[stageCtx.stageName] = {
      started_at: stageCtx.startedIso,
      ended_at: endedIso,
      duration_ms: durationMs,
    };
    const serialized = serializeError(err);
    pushLog({
      level: "error",
      stage: stageCtx.stageName,
      message: stageMessage,
      data: serialized,
    });
    emitEvent(
      makeEvent({
        type: EVENT_TYPES.error,
        stage: stageCtx.stageName,
        message: stageMessage,
        data: { duration_ms: durationMs, error: serialized },
      })
    );
  };

  // Emit artifact events for deterministic directories we create.
  emitEvent(makeEvent({ type: EVENT_TYPES.artifact, stage: "artifacts", message: "Created intermediate dir", data: { path: intermediateDir } }));
  emitEvent(makeEvent({ type: EVENT_TYPES.artifact, stage: "artifacts", message: "Created reports dir", data: { path: reportsDir } }));
  emitEvent(makeEvent({ type: EVENT_TYPES.artifact, stage: "artifacts", message: "Created logs dir", data: { path: logsDir } }));

  return (async () => {
    // LLM resolution is async in this WIP backend.
    let resolvedLLMClient = llmClient;
    if (!resolvedLLMClient) {
      let llmStageCtx = null;
      try {
        const cfg =
          llmConfig ||
          ({ backend: "llama", llama: { host: "127.0.0.1", port: 11434, timeout_seconds: 120 } });
        llmStageCtx = beginStage("llm_config");
        resolvedLLMClient = await createLLMClient(cfg);
        endStage(llmStageCtx, "Resolved LLM client");
      } catch (err) {
        failures.push({ stage: "llm_config", message: String(err) });
        if (llmStageCtx) failStage(llmStageCtx, err, "LLM configuration failed");
        return finalize({
          projectName,
          projectRoot,
          runId,
          ok: false,
          failures,
          artifactDirs,
          stages: {},
          logs: runLogs,
          events: runEvents,
          stageTimings,
          emitEvent,
          persistLogs,
          reportsDir,
          runRoot,
          sourceOfTruthDir,
        });
      }
    }

    // Stage 1: spec ingest
    let specIngestResult;
    let specIngestStageCtx = null;
    try {
      specIngestStageCtx = beginStage("spec_ingest");
      specIngestResult = await ingestNormalizedSpec({
        projectName,
        prdPath,
        gddPath,
        uiSpecPath,
        platform,
        orientation,
        constraints,
        llmClient: resolvedLLMClient,
        modelName,
        artifactsDir: intermediateDir,
      });
      if (!specIngestResult.ok) {
        throw new Error(
          `spec_ingest schema validation failed: ${JSON.stringify(specIngestResult.validation)}`
        );
      }
      endStage(specIngestStageCtx, "Spec ingest completed", {
        output_path: specIngestResult.output_path ?? null,
      });

      // Persist canonical normalized spec for edit-mode.
      // Even if the spec ingest module already persisted it, we overwrite
      // the expected filename to ensure stable edit-mode paths.
      if (specIngestResult.normalized_spec != null) {
        writeJsonFile(normalizedGameSpecPath, specIngestResult.normalized_spec);
      }

      if (specIngestResult.output_path) {
        emitEvent(
          makeEvent({
            type: EVENT_TYPES.artifact,
            stage: "spec_ingest",
            message: "Persisted normalized spec",
            data: { path: specIngestResult.output_path },
          })
        );
      }
      emitEvent(
        makeEvent({
          type: EVENT_TYPES.debug,
          stage: "spec_ingest",
          message: "Spec ingest summary",
          data: {
            repaired: specIngestResult.repaired ?? null,
            parse_error_present: specIngestResult.parse_error != null,
            normalized_spec_type: specIngestResult.normalized_spec
              ? typeof specIngestResult.normalized_spec
              : null,
          },
        })
      );
    } catch (err) {
      if (specIngestStageCtx) failStage(specIngestStageCtx, err, "Spec ingest failed");
      failures.push({ stage: "spec_ingest", message: String(err) });
      return finalize({
        projectName,
        projectRoot,
        runId,
        ok: false,
        failures,
        artifactDirs,
        stages: { spec_ingest: specIngestResult },
        logs: runLogs,
        events: runEvents,
        stageTimings,
        emitEvent,
        persistLogs,
        reportsDir,
        runRoot,
        sourceOfTruthDir,
      });
    }

    // Stage 2: planning -> generation recipe
    let plannerResult;
    let plannerStageCtx = null;
    try {
      plannerStageCtx = beginStage("planner");
      plannerResult = await buildGenerationRecipe({
        normalizedSpec: specIngestResult.normalized_spec,
        starterTemplate,
        targetPath: projectRoot,
        milestone,
        constraints,
        llmClient: resolvedLLMClient,
        modelName,
        artifactsDir: intermediateDir,
      });
      if (!plannerResult.ok) {
        throw new Error(
          `planner schema validation failed: ${JSON.stringify(plannerResult.validation)}`
        );
      }
      endStage(plannerStageCtx, "Planning completed", {
        output_path: plannerResult.output_path ?? null,
      });

      // Persist canonical generation recipe for edit-mode.
      if (plannerResult.generation_recipe != null) {
        writeJsonFile(generationRecipePath, plannerResult.generation_recipe);
      }

      // Create initial project state snapshot so edit-mode can open early
      // and later update after validation completes.
      updateProjectState({
        current_status: "planned",
        latest_validation_status: null,
      });

      if (plannerResult.output_path) {
        emitEvent(
          makeEvent({
            type: EVENT_TYPES.artifact,
            stage: "planner",
            message: "Persisted generation recipe",
            data: { path: plannerResult.output_path },
          })
        );
      }
      const recipe = plannerResult.generation_recipe ?? {};
      emitEvent(
        makeEvent({
          type: EVENT_TYPES.debug,
          stage: "planner",
          message: "Generation recipe summary",
          data: {
            scenes_to_create_count: Array.isArray(recipe.scenes_to_create)
              ? recipe.scenes_to_create.length
              : 0,
            scripts_to_create_count: Array.isArray(recipe.scripts_to_create)
              ? recipe.scripts_to_create.length
              : 0,
            systems_to_create_count: Array.isArray(recipe.systems_to_create)
              ? recipe.systems_to_create.length
              : 0,
            config_files_to_create_count: Array.isArray(recipe.config_files_to_create)
              ? recipe.config_files_to_create.length
              : 0,
          },
        })
      );
    } catch (err) {
      if (plannerStageCtx) failStage(plannerStageCtx, err, "Planning failed");
      failures.push({ stage: "planner", message: String(err) });
      return finalize({
        projectName,
        projectRoot,
        runId,
        ok: false,
        failures,
        artifactDirs,
        stages: { spec_ingest: specIngestResult, planning: plannerResult },
        logs: runLogs,
        events: runEvents,
        stageTimings,
        emitEvent,
        persistLogs,
        reportsDir,
        runRoot,
        sourceOfTruthDir,
      });
    }

    // Stage 3: scaffolding
    let scaffoldResult = null;
    let scaffoldStageCtx = null;
    try {
      scaffoldStageCtx = beginStage("scaffolding");
      scaffoldResult = scaffoldProject({
        starterTemplate,
        targetPath: projectRoot,
        projectName,
        overwrite,
        artifactsRoot: artifactsRootToUse,
        runId,
        saveSummary: true,
      });

      // Ensure scaffolding actually produced a real Godot workspace.
      assertScaffoldingProducedProject();

      endStage(scaffoldStageCtx, "Scaffolding completed", {
        summary_path: scaffoldResult?.summary_path ?? null,
      });
      if (scaffoldResult?.summary_path) {
        emitEvent(
          makeEvent({
            type: EVENT_TYPES.artifact,
            stage: "scaffolding",
            message: "Persisted scaffold summary",
            data: { path: scaffoldResult.summary_path },
          })
        );
      }
      emitEvent(
        makeEvent({
          type: EVENT_TYPES.debug,
          stage: "scaffolding",
          message: "Scaffolding summary",
          data: {
            overwrite_used: scaffoldResult?.overwrite_used ?? null,
            run_id: scaffoldResult?.run_id ?? null,
            artifacts_root: scaffoldResult?.artifacts?.artifacts_root ?? null,
          },
        })
      );
    } catch (err) {
      if (scaffoldStageCtx) failStage(scaffoldStageCtx, err, "Scaffolding failed");
      failures.push({ stage: "scaffolding", message: String(err) });
      return finalize({
        projectName,
        projectRoot,
        runId,
        ok: false,
        failures,
        artifactDirs,
        stages: {
          spec_ingest: specIngestResult,
          planning: plannerResult,
          scaffolding: scaffoldResult,
        },
        logs: runLogs,
        events: runEvents,
        stageTimings,
        emitEvent,
        persistLogs,
        reportsDir,
        runRoot,
        sourceOfTruthDir,
      });
    }

    // Resolve executor once (used by generation/validation/repair).
    const resolvedExecutor =
      executor ||
      GodotExecutor.fromConfig({
        config: { project_root: projectRoot },
        mcpClient: null,
      });

    // Stage 4: generation
    let generationResult = null;
    let generationStageCtx = null;
    try {
      generationStageCtx = beginStage("generation");
      generationResult = generateProjectFromRecipe({
        projectName,
        projectRoot,
        generationRecipe: plannerResult.generation_recipe,
        executor: resolvedExecutor,
        modelName,
        dryRun,
        artifactsDir: intermediateDir,
        saveResult: true,
      });

      // Ensure generation wrote something under the generated project root.
      assertGenerationProducedAtLeastOneAsset({
        generationRecipe: plannerResult.generation_recipe,
      });

      endStage(generationStageCtx, "Generation completed", {
        result_path: generationResult?.result_path ?? null,
      });
      if (generationResult?.result_path) {
        emitEvent(
          makeEvent({
            type: EVENT_TYPES.artifact,
            stage: "generation",
            message: "Persisted generation result",
            data: { path: generationResult.result_path },
          })
        );
      }
      emitEvent(
        makeEvent({
          type: EVENT_TYPES.debug,
          stage: "generation",
          message: "Generation summary",
          data: {
            ok: generationResult?.ok ?? null,
            total_created_paths: generationResult?.summary?.total_created_paths ?? null,
            total_errors: generationResult?.summary?.total_errors ?? null,
          },
        })
      );
    } catch (err) {
      if (generationStageCtx) failStage(generationStageCtx, err, "Generation failed");
      failures.push({ stage: "generation", message: String(err) });
      return finalize({
        projectName,
        projectRoot,
        runId,
        ok: false,
        failures,
        artifactDirs,
        stages: {
          spec_ingest: specIngestResult,
          planning: plannerResult,
          scaffolding: scaffoldResult,
          generation: generationResult,
        },
        logs: runLogs,
        events: runEvents,
        stageTimings,
        emitEvent,
        persistLogs,
        reportsDir,
        runRoot,
        sourceOfTruthDir,
      });
    }

    // Stage 5: validator
    let validatorResult = null;
    let validationStageCtx = null;
    try {
      validationStageCtx = beginStage("validation");
      validatorResult = await validateProject({
        projectName,
        projectRoot,
        generationRecipe: plannerResult.generation_recipe,
        executor: resolvedExecutor,
        boundedRunSeconds: boundedValidationSeconds,
        strict: strictValidation,
        artifactsDir: reportsDir,
      });
      endStage(validationStageCtx, validatorResult?.ok ? "Validation passed" : "Validation failed", {
        output_path: validatorResult?.output_path ?? null,
        status: validatorResult?.ok ? "pass" : "fail",
      });

      // Update canonical project state after validation completes.
      const latestValidationStatus =
        validatorResult?.validation_report?.status ?? null;
      updateProjectState({
        current_status: validatorResult?.ok ? "validated_pass" : "validated_fail",
        latest_validation_status: latestValidationStatus,
      });

      if (validatorResult?.output_path) {
        emitEvent(
          makeEvent({
            type: EVENT_TYPES.artifact,
            stage: "validation",
            message: "Persisted validation report",
            data: { path: validatorResult.output_path },
          })
        );
      }
      emitEvent(
        makeEvent({
          type: EVENT_TYPES.debug,
          stage: "validation",
          message: "Validation summary",
          data: {
            ok: validatorResult?.ok ?? null,
            runtime_result_ok: validatorResult?.runtime_result?.ok ?? null,
            runtime_stderr_present: Boolean(
              validatorResult?.runtime_result?.output &&
                typeof validatorResult.runtime_result.output === "object" &&
                validatorResult.runtime_result.output.stderr
            ),
          },
        })
      );

      if (validatorResult && !validatorResult.ok) {
        const report = validatorResult.validation_report;
        const errorCount = Array.isArray(report?.errors) ? report.errors.length : 0;
        const warningCount = Array.isArray(report?.warnings) ? report.warnings.length : 0;
        emitEvent(
          makeEvent({
            type: EVENT_TYPES.error,
            stage: "validation",
            message: "Validation reported errors",
            data: { error_count: errorCount, warning_count: warningCount },
          })
        );
      }
    } catch (err) {
      if (validationStageCtx) failStage(validationStageCtx, err, "Validation failed with exception");
      failures.push({ stage: "validation", message: String(err) });

      // Best-effort state update for edit-mode diagnostics.
      try {
        updateProjectState({
          current_status: "validation_exception",
          latest_validation_status: "unknown",
        });
      } catch {
        // ignore state update errors
      }

      return finalize({
        projectName,
        projectRoot,
        runId,
        ok: false,
        failures,
        artifactDirs,
        stages: {
          spec_ingest: specIngestResult,
          planning: plannerResult,
          scaffolding: scaffoldResult,
          generation: generationResult,
          validation: validatorResult,
        },
        logs: runLogs,
        events: runEvents,
        stageTimings,
        emitEvent,
        persistLogs,
        reportsDir,
        runRoot,
        sourceOfTruthDir,
      });
    }

    // Stage 6: repair (optional)
    let repairResult = null;
    let finalValidation = validatorResult;
    if (enableRepair && !validatorResult.ok) {
      let repairStageCtx = null;
      try {
        repairStageCtx = beginStage("repair");
        repairResult = await runRepairLoop({
          projectName,
          projectRoot,
          generationRecipe: plannerResult.generation_recipe,
          validationReport: validatorResult.validation_report,
          executor: resolvedExecutor,
          maxAttempts: maxRepairAttempts,
          strict: strictValidation,
          boundedRunSeconds: boundedValidationSeconds,
          artifactsDir: reportsDir,
        });

        endStage(repairStageCtx, "Repair loop completed", {
          result_status: repairResult?.result_status ?? null,
          output_path: repairResult?.output_path ?? null,
        });
      emitEvent(
        makeEvent({
          type: EVENT_TYPES.debug,
          stage: "repair",
          message: "Repair summary",
          data: {
            result_status: repairResult?.result_status ?? null,
            attempted_repairs_count: Array.isArray(repairResult?.repairs_attempted)
              ? repairResult.repairs_attempted.length
              : 0,
          },
        })
      );
        if (repairResult?.output_path) {
          emitEvent(
            makeEvent({
              type: EVENT_TYPES.artifact,
              stage: "repair",
              message: "Persisted repair report",
              data: { path: repairResult.output_path },
            })
          );
        }

        // Re-run validation to produce a definitive outcome (parity with Python runner).
        const validationAfterRepairCtx = beginStage("validation_after_repair");
        finalValidation = await validateProject({
          projectName,
          projectRoot,
          generationRecipe: plannerResult.generation_recipe,
          executor: resolvedExecutor,
          boundedRunSeconds: boundedValidationSeconds,
          strict: strictValidation,
          artifactsDir: reportsDir,
        });
        endStage(validationAfterRepairCtx, finalValidation?.ok ? "Validation passed after repair" : "Validation failed after repair", {
          output_path: finalValidation?.output_path ?? null,
          status: finalValidation?.ok ? "pass" : "fail",
        });
        if (finalValidation?.output_path) {
          emitEvent(
            makeEvent({
              type: EVENT_TYPES.artifact,
              stage: "validation_after_repair",
              message: "Persisted repaired validation report",
              data: { path: finalValidation.output_path },
            })
          );
        }
        if (finalValidation && !finalValidation.ok) {
          const report = finalValidation.validation_report;
          const errorCount = Array.isArray(report?.errors) ? report.errors.length : 0;
          const warningCount = Array.isArray(report?.warnings) ? report.warnings.length : 0;
          emitEvent(
            makeEvent({
              type: EVENT_TYPES.error,
              stage: "validation_after_repair",
              message: "Validation reported errors after repair",
              data: { error_count: errorCount, warning_count: warningCount },
            })
          );
        }
      } catch (err) {
        if (repairStageCtx) failStage(repairStageCtx, err, "Repair failed");
        failures.push({ stage: "repair", message: String(err) });
        return finalize({
          projectName,
          projectRoot,
          runId,
          ok: false,
          failures,
          artifactDirs,
          stages: {
            spec_ingest: specIngestResult,
            planning: plannerResult,
            scaffolding: scaffoldResult,
            generation: generationResult,
            validation: validatorResult,
            repair: repairResult,
          },
          logs: runLogs,
        events: runEvents,
          stageTimings,
          emitEvent,
        persistLogs,
          reportsDir,
          runRoot,
          sourceOfTruthDir,
        });
      }
    }

    return finalize({
      projectName,
      projectRoot,
      runId,
      ok: finalValidation.ok,
      failures,
      artifactDirs,
      stages: {
        spec_ingest: specIngestResult,
        planning: plannerResult,
        scaffolding: scaffoldResult,
        generation: generationResult,
        validation: finalValidation,
        repair: repairResult,
      },
      logs: runLogs,
      events: runEvents,
      stageTimings,
      emitEvent,
      persistLogs,
      reportsDir,
      runRoot,
      sourceOfTruthDir,
    });
  })();
}

function ensureRunArtifactDirs({ projectName, artifactsRoot, runId }) {
  const root = artifactsRoot ? path.resolve(String(artifactsRoot)) : path.resolve("artifacts");
  const projectArtifactsDir = path.join(root, projectName);
  const runArtifactsDir = runId ? path.join(projectArtifactsDir, runId) : path.join(projectArtifactsDir, "latest");

  const intermediateDir = path.join(runArtifactsDir, "intermediate");
  const reportsDir = path.join(runArtifactsDir, "reports");
  const logsDir = path.join(runArtifactsDir, "logs");

  fs.mkdirSync(intermediateDir, { recursive: true });
  fs.mkdirSync(reportsDir, { recursive: true });
  fs.mkdirSync(logsDir, { recursive: true });

  return {
    artifactsRoot: root,
    projectArtifactsDir,
    runArtifactsDir,
    intermediateDir,
    reportsDir,
    logsDir,
  };
}

function finalize({
  projectName,
  projectRoot,
  runId,
  ok,
  failures,
  artifactDirs,
  stages,
  logs,
  events,
  stageTimings,
  emitEvent,
  persistLogs,
  reportsDir,
  runRoot,
  sourceOfTruthDir,
}) {
  const finalSummary = {
    project_name: projectName,
    run_id: runId,
    project_root: projectRoot,
    run_root: runRoot,
    source_of_truth_dir: sourceOfTruthDir,
    reports_dir: reportsDir,
    generated_project_root: projectRoot,
    ok,
    failures,
    artifacts: artifactDirs,
    stages,
    stage_timings: stageTimings,
    logs,
    events,
  };

  fs.mkdirSync(reportsDir, { recursive: true });
  fs.writeFileSync(
    path.join(reportsDir, "run_summary.json"),
    JSON.stringify(finalSummary, null, 2),
    "utf-8"
  );

  if (persistLogs && artifactDirs?.logsDir) {
    const logsDir = path.resolve(String(artifactDirs.logsDir));
    fs.mkdirSync(logsDir, { recursive: true });
    const logsPath = path.join(logsDir, "run_logs.json");
    fs.writeFileSync(logsPath, JSON.stringify(logs, null, 2), "utf-8");
    if (typeof emitEvent === "function") {
      emitEvent(
        makeEvent({
          type: EVENT_TYPES.artifact,
          stage: "finalize",
          message: "Persisted run logs",
          data: { path: logsPath },
        })
      );
    }
  }

  if (typeof emitEvent === "function") {
    emitEvent(
      makeEvent({
        type: EVENT_TYPES.final,
        stage: "run",
        message: "Run completed",
        data: { ok, failures_count: failures.length, stage_timings: stageTimings },
      })
    );
  }

  return finalSummary;
}

function parseArg(flag) {
  const idx = process.argv.indexOf(flag);
  if (idx === -1) return null;
  return process.argv[idx + 1] ?? null;
}

function hasFlag(flag) {
  return process.argv.includes(flag);
}

function main() {
  const platform = parseArg("--platform");
  if (!platform) {
    console.error("Missing required: --platform android|ios|pc|web");
    process.exit(1);
  }
  const required = [
    "--project-name",
    "--prd-path",
    "--gdd-path",
    "--ui-spec-path",
    "--starter-template",
    "--target-output-path",
  ];
  for (const flag of required) {
    if (!parseArg(flag)) {
      console.error(`Missing required: ${flag}`);
      process.exit(1);
    }
  }
  const allowedPlatforms = new Set(["android", "ios", "pc", "web"]);
  if (!allowedPlatforms.has(platform)) {
    console.error("--platform must be one of: android | ios | pc | web");
    process.exit(1);
  }

  const resultPromise = runFactory({
    projectName: parseArg("--project-name"),
    prdPath: parseArg("--prd-path"),
    gddPath: parseArg("--gdd-path"),
    uiSpecPath: parseArg("--ui-spec-path"),
    starterTemplate: parseArg("--starter-template"),
    targetOutputPath: parseArg("--target-output-path"),
    platform,
    orientation: parseArg("--orientation"),
    overwrite: hasFlag("--overwrite"),
    artifactsRoot: parseArg("--artifacts-root"),
    runId: parseArg("--run-id"),
    modelName: parseArg("--model-name") || "gpt-oss-20b",
    llmConfig: {
      backend: parseArg("--llm-backend") || "llama",
      llama: {
        host: parseArg("--llm-host") || "127.0.0.1",
        port: Number(parseArg("--llm-port") || 11434),
        timeout_seconds: Number(parseArg("--llm-timeout-seconds") || 120),
      },
    },
    enableRepair: hasFlag("--enable-repair"),
    maxRepairAttempts: Number(parseArg("--max-repair-attempts") || 3),
    boundedValidationSeconds: Number(parseArg("--bounded-validation-seconds") || 5),
    strictValidation: hasFlag("--strict-validation"),
    dryRun: hasFlag("--dry-run"),
  });

  resultPromise
    .then((res) => {
      console.log(JSON.stringify(res, null, 2));
      process.exit(res.ok ? 0 : 2);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

