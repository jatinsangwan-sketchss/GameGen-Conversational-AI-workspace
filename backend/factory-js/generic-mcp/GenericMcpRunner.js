/**
 * GenericMcpRunner
 * -----------------------------------------------------------------------------
 * End-to-end orchestrator for the isolated Generic MCP pipeline.
 *
 * Pipeline:
 * 1) Session readiness
 * 2) Live tool inventory
 * 3) LLM-first planning
 * 4) Argument resolution
 * 5) Execution (only when resolved status=ready)
 * 6) Presentation
 *
 * This runner exists to wire the new Generic MCP modules together without any
 * dependency on old runtime/source-of-truth/curated factory paths.
 */
import { SessionManager } from "./SessionManager.js";
import { ToolInventory } from "./ToolInventory.js";
import { ToolPlanner } from "./ToolPlanner.js";
import { ArgumentResolver } from "./ArgumentResolver.js";
import { Executor } from "./Executor.js";
import { ResultPresenter } from "./ResultPresenter.js";
import { LiveModelClient } from "./LiveModelClient.js";
import { ProjectFileIndex } from "./ProjectFileIndex.js";
import { ResourceResolver } from "./ResourceResolver.js";
import { NodeResolver } from "./NodeResolver.js";
import { ArtifactRegistry } from "./ArtifactRegistry.js";
import { buildRuntimeState, extractSemanticArgs, toSemanticField } from "./RuntimeStateModel.js";
import { interpretGoalIntent, synthesizeCodeArtifact } from "./GoalIntentInterpreter.js";
import {
  buildArtifactOperationState,
  checkOperationDrift,
  updateObservedEffects,
} from "./ArtifactOperationModel.js";
import { compactStepVerification } from "./PostconditionVerifier.js";
import { ensureGeneratedContentForStep } from "./ContentGenerationStage.js";
import {
  buildSemanticWorkflowState,
  seedArgsFromSemanticState,
  updateSemanticStateFromStep,
  refreshPendingSemanticGaps,
  hasSemanticFieldValue,
  firstPendingSemanticGap,
} from "./SemanticWorkflowState.js";

function safeString(value) {
  return value == null ? "" : String(value);
}

function isPlainObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function normalizeFieldName(value) {
  return safeString(value).trim().replace(/\s*\(.*$/, "");
}

function isLikelyMarkerToken(value) {
  const v = safeString(value).trim().toLowerCase();
  return v === "called" || v === "named" || v === "node" || v === "script" || v === "scene";
}

function extractNamedEntityFromRequest(request) {
  const text = safeString(request);
  if (!text) return null;
  const patterns = [
    /\b(?:called|named)\s+`([^`]+)`/i,
    /\b(?:called|named)\s+"([^"]+)"/i,
    /\b(?:called|named)\s+'([^']+)'/i,
    /\b(?:called|named)\s+([A-Za-z0-9_.\/-]+)/i,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    const candidate = safeString(m?.[1]).trim();
    if (!candidate || isLikelyMarkerToken(candidate)) continue;
    return candidate;
  }
  return null;
}

function normalizeArtifactOpMode(value) {
  const v = safeString(value).trim().toLowerCase();
  if (!v) return null;
  const allowed = new Set([
    "create_new",
    "modify_existing",
    "attach_existing",
    "create_then_attach",
    "create_then_modify",
    "modify_then_attach",
  ]);
  return allowed.has(v) ? v : null;
}

function questionForField(field) {
  const f = safeString(field).toLowerCase();
  if (f.includes("scene")) return "Which scene should I use?";
  if (f.includes("node")) return "Which node should I use?";
  if (f.includes("artifact")) return "Which existing artifact should I use?";
  if (f.includes("script")) return "Which existing script should I use?";
  if (f.includes("file")) return "Which file should I use?";
  if (f.includes("resource")) return "Which resource should I use?";
  return field ? `Can you provide ${field}?` : "Can you clarify the missing information?";
}

function semanticResolvedArgCandidates(field) {
  const f = safeString(field).trim();
  if (!f) return [];
  const lower = f.toLowerCase();
  const out = new Set();
  if (lower === "sceneref" || lower.includes("scene")) out.add("scenePath");
  if (lower === "noderef" || lower.includes("node")) {
    out.add("nodePath");
    out.add("targetNode");
    out.add("targetNodePath");
    out.add("parentPath");
  }
  if (lower === "fileref" || lower.includes("file")) {
    out.add("filePath");
    out.add("path");
  }
  if (lower === "resourceref" || lower.includes("resource")) out.add("resourcePath");
  if (lower === "scriptref" || lower.includes("script")) out.add("scriptPath");
  if (lower === "textureref" || lower.includes("texture")) out.add("texturePath");
  if (f.endsWith("Ref")) out.add(`${f.slice(0, -3)}Path`);
  return [...out];
}

export class GenericMcpRunner {
  constructor({
    sessionManager = null,
    toolInventory = null,
    toolPlanner = null,
    argumentResolver = null,
    executor = null,
    resultPresenter = null,
    /** When omitted, resolved from resourceResolver / injected ArgumentResolver, or a new index is created. */
    fileIndex = null,
    /** When omitted, resolved from injected ArgumentResolver or created with shared fileIndex. */
    resourceResolver = null,
    modelClient = null,
    mcpConfig = null,
    pageSize = 100,
    maxSteps = 6,
    maxQueuedTasks = 12,
    allowContentFallback = true,
    debug = false,
  } = {}) {
    this._provided = {
      sessionManager,
      toolInventory,
      toolPlanner,
      argumentResolver,
      executor,
      resultPresenter,
      fileIndex,
      resourceResolver,
    };
    this._modelClient = modelClient ?? null;
    this._mcpConfig = mcpConfig ?? null;
    this._pageSize = pageSize;
    this._maxSteps = Number.isFinite(Number(maxSteps)) ? Math.max(1, Math.min(20, Number(maxSteps))) : 6;
    this._maxQueuedTasks = Number.isFinite(Number(maxQueuedTasks))
      ? Math.max(1, Math.min(50, Math.floor(Number(maxQueuedTasks))))
      : 12;
    this._allowContentFallback = Boolean(allowContentFallback);
    this._debug = Boolean(debug);

    this._modules = {
      sessionManager: sessionManager ?? null,
      toolInventory: toolInventory ?? null,
      toolPlanner: toolPlanner ?? null,
      argumentResolver: argumentResolver ?? null,
      executor: executor ?? null,
      resultPresenter: resultPresenter ?? null,
      fileIndex: null,
      resourceResolver: null,
      nodeResolver: null,
      artifactRegistry: null,
    };
  }

  async run({ userRequest, projectRoot = null, mcpConfig = null, sessionContext = null, resumeNeedsInput = null } = {}) {
    const request = safeString(userRequest).trim();
    if (!request) {
      return this._buildRunResult({
        ok: false,
        status: "needs_input",
        reason: "userRequest is required.",
        presentation: "Unsupported request: userRequest is required.",
      });
    }

    const resumedQueue = this._extractQueuedResumeState(resumeNeedsInput);
    const initialQueue = resumedQueue ?? this._buildTaskQueueFromRequest(request);
    if (!initialQueue?.ok) {
      return this._buildRunResult({
        ok: false,
        status: "unsupported",
        reason: safeString(initialQueue?.error).trim() || "Unable to build task queue.",
        presentation: safeString(initialQueue?.error).trim() || "Unsupported request.",
      });
    }

    if (!initialQueue.isQueueExecution) {
      return this._runSingleTask({
        userRequest: request,
        projectRoot,
        mcpConfig,
        sessionContext,
        resumeNeedsInput,
      });
    }

    return this._runTaskQueue({
      userRequest: request,
      projectRoot,
      mcpConfig,
      sessionContext,
      queueState: initialQueue.queueState,
      queueResumeState: resumedQueue,
    });
  }

  async _runSingleTask({ userRequest, projectRoot = null, mcpConfig = null, sessionContext = null, resumeNeedsInput = null } = {}) {
    const request = safeString(userRequest).trim();
    if (!request) {
      return this._buildRunResult({
        ok: false,
        status: "needs_input",
        reason: "userRequest is required.",
        presentation: "Unsupported request: userRequest is required.",
      });
    }

    await this._ensureModules({ mcpConfig: mcpConfig ?? this._mcpConfig, projectRoot });
    const { sessionManager, toolInventory, toolPlanner, argumentResolver, executor, resultPresenter } = this._modules;

    const sessionInit = await sessionManager.initialize(projectRoot);
    const readyRes = await sessionManager.ensureReady(projectRoot);
    const sessionStatus = sessionManager.getStatus();
    if (!sessionInit?.ok && !readyRes?.ok) {
      const text = `Session unavailable: ${safeString(sessionInit?.error || readyRes?.error || sessionStatus?.lastError || "unknown error")}`;
      return this._buildRunResult({
        ok: false,
        status: "failed",
        reason: text,
        sessionStatus,
        presentation: text,
      });
    }

    const inventoryLoad = await toolInventory.load();
    let inventory = toolInventory.getInventory();
    if (!inventoryLoad?.ok) {
      const text = `Inventory load failed: ${safeString(inventoryLoad?.error || "unknown error")}`;
      return this._buildRunResult({
        ok: false,
        status: "failed",
        reason: text,
        sessionStatus,
        inventorySummary: { toolCount: inventory?.toolCount ?? 0, fetchedAt: inventory?.fetchedAt ?? null },
        presentation: text,
      });
    }

    const activeProjectRoot =
      safeString(sessionStatus?.connectedProjectPath).trim() ||
      safeString(projectRoot).trim() ||
      null;
    if (this._modules.fileIndex && activeProjectRoot) {
      await this._modules.fileIndex.build(activeProjectRoot);
    }

    const baseSessionContext = isPlainObject(sessionContext) ? sessionContext : { projectRoot, sessionStatus };
    const workflowState = this._initWorkflowState({ userRequest: request, resumeNeedsInput });
    this._ensureCanonicalSemanticState(workflowState);
    let seedDecision = this._buildResumePlan(resumeNeedsInput, request);
    let lastPlanning = null;
    let lastResolved = null;
    const allStepResults = [];

    for (let stepIndex = 0; stepIndex < this._maxSteps; stepIndex += 1) {
      this._ensureCanonicalSemanticState(workflowState);
      const verifySemanticState = isPlainObject(workflowState?.semanticState) ? workflowState.semanticState : {};
      const verifySemanticIntent = isPlainObject(workflowState?.semanticIntent) ? workflowState.semanticIntent : {};
      const lastHistory = Array.isArray(workflowState?.history) && workflowState.history.length > 0
        ? workflowState.history[workflowState.history.length - 1]
        : null;
      // console.log("[VERIFY][pre-planner-state]", {
      //   goal: safeString(verifySemanticState.goal || verifySemanticIntent.goalText || workflowState?.goal).trim() || null,
      //   artifactIntent: safeString(verifySemanticState.artifactIntent || workflowState?.artifactOperation?.mode).trim() || null,
      //   creationIntent: isPlainObject(verifySemanticState.creationIntent)
      //     ? verifySemanticState.creationIntent
      //     : (isPlainObject(verifySemanticIntent.creationIntent) ? verifySemanticIntent.creationIntent : {}),
      //   targetRefs: isPlainObject(verifySemanticState.targetRefs)
      //     ? verifySemanticState.targetRefs
      //     : (isPlainObject(verifySemanticIntent.refs) ? verifySemanticIntent.refs : {}),
      //   contentIntent: safeString(verifySemanticState.contentIntent || verifySemanticIntent.contentIntent).trim() || null,
      //   codeIntent: safeString(verifySemanticIntent.codeIntent).trim() || null,
      //   pendingSemanticGaps: Array.isArray(verifySemanticState.pendingSemanticGaps) ? verifySemanticState.pendingSemanticGaps : [],
      //   knownTool: safeString(lastHistory?.tool || lastPlanning?.step?.tool || lastPlanning?.tools?.[0]?.name).trim() || null,
      // });
      const contentInvariant = await this._ensureContentGenerationInvariant({ workflowState });
      if (!contentInvariant.ok) {
        if (safeString(contentInvariant.kind).trim() === "needs_input") {
          return this._buildNeedsInputResult({
            sessionStatus,
            inventory,
            planningResult: {
              status: "missing_args",
              tools: [],
              missingArgs: [contentInvariant.field || "contentIntent"],
              ambiguities: [],
              reason: safeString(contentInvariant.reason).trim() || null,
            },
            resolvedPlan: {
              status: "missing_args",
              tools: [],
              missingArgs: [contentInvariant.field || "contentIntent"],
              ambiguities: [],
              reason: safeString(contentInvariant.reason).trim() || null,
            },
            workflowState,
          });
        }
        return this._buildRunResult({
          ok: false,
          status: "failed",
          reason: safeString(contentInvariant.reason).trim() || "Content generation is required but unavailable.",
          sessionStatus,
          inventorySummary: { toolCount: inventory.toolCount, fetchedAt: inventory.fetchedAt },
          planningResult: lastPlanning,
          resolvedPlan: lastResolved,
          executionResult: { ok: false, results: allStepResults, error: "content_generation_required" },
          presentation: safeString(contentInvariant.reason).trim() || "Stopped: content generation required before execution.",
          workflowState,
          runtimeState: this._runtimeWithWorkflow({
            planningResult: lastPlanning,
            resolvedPlan: lastResolved,
            inventory,
            workflowState,
          }),
        });
      }
      const planning =
        seedDecision ??
        (await toolPlanner.plan({
          userRequest: request,
          sessionContext: {
            ...baseSessionContext,
            workflowState: {
              ...this._compactWorkflowForPlanner(workflowState),
              semanticIntent: isPlainObject(workflowState?.semanticIntent) ? workflowState.semanticIntent : {},
              semanticState: isPlainObject(workflowState?.semanticState) ? workflowState.semanticState : {},
              generatedArtifacts: Array.isArray(workflowState?.generatedArtifacts) ? workflowState.generatedArtifacts.slice(-3) : [],
            },
          },
        }));
      seedDecision = null;
      lastPlanning = planning;
      const decisionStatus = safeString(planning?.status).trim();

      if (decisionStatus === "done") {
        const effectState = this._refreshEffectState(workflowState);
        if (this._isContentBearingWorkflow(workflowState) && !this._hasGeneratedOrCompiledContent(workflowState)) {
          return this._buildRunResult({
            ok: false,
            status: "failed",
            reason: "Partial completion: content intent exists but no generated/compiled content artifact was produced.",
            sessionStatus,
            inventorySummary: { toolCount: inventory.toolCount, fetchedAt: inventory.fetchedAt },
            planningResult: planning,
            resolvedPlan: lastResolved,
            executionResult: { ok: false, results: allStepResults, error: "content_artifact_missing" },
            presentation: "Stopped with partial completion: content intent exists but no generated implementation artifact was produced.",
            workflowState,
            runtimeState: this._runtimeWithWorkflow({
              planningResult: planning,
              resolvedPlan: lastResolved,
              inventory,
              workflowState,
              }),
          });
        }
        const remainingEffects = Array.isArray(effectState?.remainingEffects) ? effectState.remainingEffects : [];
        if (remainingEffects.length > 0) {
          workflowState.unmetPostconditions = remainingEffects;
          workflowState.doneWithoutPostconditionCount = Number(workflowState.doneWithoutPostconditionCount || 0) + 1;
          if (workflowState.doneWithoutPostconditionCount >= 2) {
            return this._buildRunResult({
              ok: false,
              status: "failed",
              reason: `Partial completion: unmet expected effects remain (${remainingEffects.join(", ")}).`,
              sessionStatus,
              inventorySummary: { toolCount: inventory.toolCount, fetchedAt: inventory.fetchedAt },
              planningResult: planning,
              resolvedPlan: lastResolved,
              executionResult: { ok: false, results: allStepResults, error: "postcondition_unmet" },
              presentation: `Stopped with partial completion. Unmet expected effects: ${remainingEffects.join(", ")}`,
              workflowState,
              runtimeState: this._runtimeWithWorkflow({
                planningResult: planning,
                resolvedPlan: lastResolved,
                inventory,
                workflowState,
              }),
            });
          }
          continue;
        }
        workflowState.doneWithoutPostconditionCount = 0;
        const executionResult = {
          ok: true,
          results: allStepResults,
          error: null,
          artifacts: this._modules.artifactRegistry?.getAll?.() ?? [],
        };
        const presentation =
          allStepResults.length > 0
            ? resultPresenter.present(executionResult)
            : "Done.";
        return this._buildRunResult({
          ok: true,
          status: "completed",
          reason: null,
          sessionStatus,
          inventorySummary: { toolCount: inventory.toolCount, fetchedAt: inventory.fetchedAt },
          planningResult: planning,
          resolvedPlan: lastResolved,
          executionResult,
          presentation,
          workflowState,
          runtimeState: this._runtimeWithWorkflow({
            planningResult: planning,
            resolvedPlan: lastResolved,
            inventory,
            workflowState,
          }),
        });
      }

      if (["needs_input", "missing_args", "ambiguous", "unsupported"].includes(decisionStatus)) {
        if (decisionStatus === "unsupported") {
          return this._buildRunResult({
            ok: false,
            status: "unsupported",
            reason: safeString(planning?.reason).trim() || "Unsupported request.",
            sessionStatus,
            inventorySummary: { toolCount: inventory.toolCount, fetchedAt: inventory.fetchedAt },
            planningResult: planning,
            resolvedPlan: null,
            executionResult: null,
            presentation: `Unsupported request: ${safeString(planning?.reason).trim() || "no supported plan"}`,
            workflowState,
            runtimeState: this._runtimeWithWorkflow({
              planningResult: planning,
              resolvedPlan: null,
              inventory,
              workflowState,
            }),
          });
        }
        return this._buildNeedsInputResult({
          sessionStatus,
          inventory,
          planningResult: planning,
          resolvedPlan: {
            status: decisionStatus === "needs_input" ? "missing_args" : decisionStatus,
            tools: Array.isArray(planning?.tools) ? planning.tools : [],
            missingArgs: Array.isArray(planning?.missingArgs) ? planning.missingArgs : [],
            ambiguities: Array.isArray(planning?.ambiguities) ? planning.ambiguities : [],
            reason: safeString(planning?.reason).trim() || null,
          },
          workflowState,
        });
      }

      const planForResolver =
        decisionStatus === "next_step"
          ? {
              status: "ready",
              tools: [{ name: safeString(planning?.step?.tool).trim(), args: isPlainObject(planning?.step?.args) ? planning.step.args : {} }],
              missingArgs: [],
              ambiguities: [],
              reason: null,
            }
          : planning;
      this._mergePlanningSemanticIntoState(workflowState, planForResolver);
      this._ensureCanonicalSemanticState(workflowState);
      const semSeededPlanForResolver = this._seedPlanFromSemanticState({
        plan: planForResolver,
        workflowState,
      });
      const legacyOneShot = decisionStatus === "ready";
      const resolvedPlan = await argumentResolver.resolve(semSeededPlanForResolver, {
        sessionStatus,
        toolInventory,
        workflowState,
      });
      lastResolved = resolvedPlan;

      if (resolvedPlan.status !== "ready") {
        refreshPendingSemanticGaps(workflowState?.semanticState, workflowState?.artifactOperation);
        return this._buildNeedsInputResult({
          sessionStatus,
          inventory,
          planningResult: semSeededPlanForResolver,
          resolvedPlan,
          workflowState,
        });
      }
      await this._ensureGeneratedContentStage({
        resolvedPlan,
        workflowState,
        sessionContext: baseSessionContext,
      });
      const gatedReadyPlan = resolvedPlan;

      const sig = this._stepSignature(gatedReadyPlan.tools?.[0]);
      const repeated = this._markAndCheckRepeat(workflowState, sig);
      if (repeated) {
        return this._buildRunResult({
          ok: false,
          status: "failed",
          reason: "Step loop stopped: repeated unproductive step detected.",
          sessionStatus,
          inventorySummary: { toolCount: inventory.toolCount, fetchedAt: inventory.fetchedAt },
          planningResult: planning,
          resolvedPlan: gatedReadyPlan,
          executionResult: { ok: false, results: allStepResults, error: "repeated_step_detected" },
          presentation: "Stopped safely: repeated unproductive step detected.",
          workflowState,
          runtimeState: this._runtimeWithWorkflow({
            planningResult: semSeededPlanForResolver,
            resolvedPlan: gatedReadyPlan,
            inventory,
            workflowState,
          }),
        });
      }
      const drift = checkOperationDrift({
        operationState: workflowState?.artifactOperation,
        stepTool: gatedReadyPlan.tools?.[0],
      });
      if (!drift.ok) {
        return this._buildRunResult({
          ok: false,
          status: "needs_input",
          reason: drift.reason,
          sessionStatus,
          inventorySummary: { toolCount: inventory.toolCount, fetchedAt: inventory.fetchedAt },
          planningResult: semSeededPlanForResolver,
          resolvedPlan: gatedReadyPlan,
          executionResult: null,
          presentation: drift.reason,
          needsInput: {
            status: "needs_input",
            kind: "missing_args",
            tool: safeString(gatedReadyPlan.tools?.[0]?.name).trim() || null,
            question: "Should I create a new artifact or modify the existing one?",
            missing: ["artifactOperationChoice"],
            field: "artifactOperationChoice",
            options: [],
            attemptedValue: null,
            partialPlan: {
              tool: safeString(gatedReadyPlan.tools?.[0]?.name).trim() || null,
              args: extractSemanticArgs({
                toolName: safeString(gatedReadyPlan.tools?.[0]?.name).trim(),
                args: gatedReadyPlan.tools?.[0]?.args,
                inventory,
              }),
            },
            raw: {
              plannerStatus: safeString(planning?.status).trim() || null,
              resolverStatus: safeString(gatedReadyPlan?.status).trim() || null,
            },
          },
          workflowState,
          runtimeState: this._runtimeWithWorkflow({
            planningResult: semSeededPlanForResolver,
            resolvedPlan: gatedReadyPlan,
            inventory,
            workflowState,
          }),
        });
      }
      const liveInventoryValidation = await this._refreshAndValidateExecutionTools({
        toolInventory,
        resolvedPlan: gatedReadyPlan,
      });
      inventory = liveInventoryValidation.inventory ?? inventory;
      if (!liveInventoryValidation.ok) {
        return this._buildRunResult({
          ok: false,
          status: "failed",
          reason: liveInventoryValidation.error,
          sessionStatus,
          inventorySummary: { toolCount: inventory.toolCount, fetchedAt: inventory.fetchedAt },
          planningResult: planning,
          resolvedPlan: gatedReadyPlan,
          executionResult: { ok: false, results: allStepResults, error: "live_inventory_validation_failed" },
          presentation: liveInventoryValidation.error,
          workflowState,
          runtimeState: this._runtimeWithWorkflow({
            planningResult: semSeededPlanForResolver,
            resolvedPlan: gatedReadyPlan,
            inventory,
            workflowState,
          }),
        });
      }

      const artifactsBefore = Array.isArray(this._modules.artifactRegistry?.getAll?.())
        ? this._modules.artifactRegistry.getAll().length
        : 0;
      const executionResult = await executor.execute(gatedReadyPlan, {
        sessionStatus,
        inventory: toolInventory,
        artifactRegistry: this._modules.artifactRegistry,
        workflowState,
      });
      const artifactsAfter = Array.isArray(this._modules.artifactRegistry?.getAll?.())
        ? this._modules.artifactRegistry.getAll().length
        : artifactsBefore;
      if (Array.isArray(executionResult?.results)) {
        allStepResults.push(...executionResult.results);
      }
      this._recordWorkflowStep(workflowState, { planning, resolvedPlan: gatedReadyPlan, executionResult });
      workflowState.lastVerification = compactStepVerification({
        stepTool: gatedReadyPlan.tools?.[0],
        executionResult,
      });
      updateObservedEffects({
        operationState: workflowState?.artifactOperation,
        stepTool: gatedReadyPlan.tools?.[0],
        executionResult,
        artifactCountBefore: artifactsBefore,
        artifactCountAfter: artifactsAfter,
      });
      this._refreshSemanticStateFromStep(workflowState, gatedReadyPlan, executionResult);
      this._ensureCanonicalSemanticState(workflowState);
      workflowState.doneWithoutPostconditionCount = 0;

      if (executionResult?.ok && this._isContentBearingWorkflow(workflowState)) {
        if (!isPlainObject(workflowState.semanticState)) workflowState.semanticState = {};
        workflowState.semanticState.contentApplication = {
          status: "applied",
          tool: safeString(gatedReadyPlan.tools?.[0]?.name).trim() || null,
        };
      }

      if (!executionResult?.ok) {
        const presentation = resultPresenter.present(executionResult);
        return this._buildRunResult({
          ok: false,
          status: "failed",
          reason: safeString(executionResult?.error || "Execution failed."),
          sessionStatus,
          inventorySummary: { toolCount: inventory.toolCount, fetchedAt: inventory.fetchedAt },
          planningResult: planning,
          resolvedPlan: gatedReadyPlan,
          executionResult,
          presentation,
          workflowState,
          runtimeState: this._runtimeWithWorkflow({
            planningResult: semSeededPlanForResolver,
            resolvedPlan: gatedReadyPlan,
            inventory,
            workflowState,
          }),
        });
      }

      if (legacyOneShot) {
        const combined = {
          ok: true,
          results: allStepResults,
          error: null,
          artifacts: this._modules.artifactRegistry?.getAll?.() ?? [],
        };
        const presentation = resultPresenter.present(combined);
        return this._buildRunResult({
          ok: true,
          status: "completed",
          reason: null,
          sessionStatus,
          inventorySummary: { toolCount: inventory.toolCount, fetchedAt: inventory.fetchedAt },
          planningResult: planning,
          resolvedPlan: gatedReadyPlan,
          executionResult: combined,
          presentation,
          workflowState,
          runtimeState: this._runtimeWithWorkflow({
            planningResult: semSeededPlanForResolver,
            resolvedPlan: gatedReadyPlan,
            inventory,
            workflowState,
          }),
        });
      }
    }

    return this._buildRunResult({
      ok: false,
      status: "failed",
      reason: `Step loop reached safety bound (${this._maxSteps}).`,
      sessionStatus,
      inventorySummary: { toolCount: inventory.toolCount, fetchedAt: inventory.fetchedAt },
      planningResult: lastPlanning,
      resolvedPlan: lastResolved,
      executionResult: { ok: false, results: allStepResults, error: "max_steps_reached" },
      presentation: `Stopped safely after ${this._maxSteps} step(s).`,
      workflowState,
      runtimeState: this._runtimeWithWorkflow({
        planningResult: lastPlanning,
        resolvedPlan: lastResolved,
        inventory,
        workflowState,
      }),
    });
  }

  _extractQueuedResumeState(resumeNeedsInput) {
    const previous = isPlainObject(resumeNeedsInput) ? resumeNeedsInput : null;
    if (!previous) return null;
    if (safeString(previous.status).trim() !== "paused") return null;
    const q = isPlainObject(previous.taskQueue) ? previous.taskQueue : null;
    if (!q) return null;
    const tasks = Array.isArray(q.tasks)
      ? q.tasks.map((t) => safeString(t).trim()).filter(Boolean)
      : [];
    if (tasks.length < 1) return null;
    const currentTaskIndex = Number.isFinite(Number(q.currentTaskIndex))
      ? Math.max(0, Math.min(tasks.length - 1, Math.floor(Number(q.currentTaskIndex))))
      : 0;
    const completedTasks = Array.isArray(q.completedTasks)
      ? q.completedTasks.filter((entry) => isPlainObject(entry))
      : [];
    const pausedTask = isPlainObject(q.pausedTask) ? q.pausedTask : null;
    const pauseReason = safeString(q.pauseReason).trim().toLowerCase() === "needs_input" ? "needs_input" : "failed";
    return {
      ok: true,
      isQueueExecution: true,
      queueState: {
        originalRequest: safeString(q.originalRequest).trim() || safeString(previous.reason).trim() || null,
        tasks,
        currentTaskIndex,
        completedTasks,
        pausedTask,
        pauseReason,
      },
    };
  }

  _buildTaskQueueFromRequest(request) {
    const tasks = this._splitUserRequestIntoTasks(request);
    if (tasks.length < 1) {
      return { ok: false, error: "No executable task found in user request.", isQueueExecution: false, queueState: null };
    }
    if (tasks.length > this._maxQueuedTasks) {
      return {
        ok: false,
        error: `Task queue exceeds limit (${tasks.length} > ${this._maxQueuedTasks}).`,
        isQueueExecution: false,
        queueState: null,
      };
    }
    return {
      ok: true,
      isQueueExecution: tasks.length > 1,
      queueState: {
        originalRequest: safeString(request).trim() || null,
        tasks,
        currentTaskIndex: 0,
        completedTasks: [],
        pausedTask: null,
        pauseReason: null,
      },
    };
  }

  _splitUserRequestIntoTasks(request) {
    const text = safeString(request).trim();
    if (!text) return [];
    const normalizeTask = (segment) =>
      safeString(segment)
        .trim()
        .replace(/^[-*•]\s+/, "")
        .replace(/^\d+\s*[\)\.\-:]\s+/, "")
        .replace(/\s+/g, " ")
        .trim();

    const lineTasks = text
      .split(/\r?\n+/)
      .map(normalizeTask)
      .filter(Boolean);
    if (lineTasks.length > 1) return lineTasks;

    const semicolonTasks = text
      .split(/\s*;\s+/)
      .map(normalizeTask)
      .filter(Boolean);
    if (semicolonTasks.length > 1) return semicolonTasks;

    const connectorTasks = text
      .split(/\s*(?:,\s*then\s+|,\s*next\s+|\band then\b\s+|\bthen\b\s+)/i)
      .map(normalizeTask)
      .filter(Boolean);
    if (connectorTasks.length > 1) return connectorTasks;

    return [text];
  }

  _interpretFailedTaskResumeInput(input) {
    const text = safeString(input).trim();
    const normalized = text.toLowerCase();
    if (!text || ["retry", "resume", "continue", "again"].includes(normalized)) {
      return { type: "retry_original" };
    }
    if (["skip", "next", "skip task", "skip this task"].includes(normalized)) {
      return { type: "skip" };
    }
    return { type: "replace_task", task: text };
  }

  _toCompletedQueueTaskEntry({ index, task, result }) {
    const r = isPlainObject(result) ? result : {};
    return {
      index,
      task: safeString(task).trim() || null,
      ok: Boolean(r.ok),
      status: safeString(r.status).trim() || (r.ok ? "completed" : "failed"),
      reason: r.reason ?? null,
      presentation: safeString(r.presentation).trim() || "",
      result: r,
    };
  }

  _queueSummaryPresentation(completedTasks = []) {
    const completed = Array.isArray(completedTasks) ? completedTasks : [];
    const lines = [`Completed ${completed.length} queued task(s) sequentially.`];
    for (const entry of completed) {
      const i = Number.isFinite(Number(entry?.index)) ? Number(entry.index) + 1 : null;
      const task = safeString(entry?.task).trim() || "(task)";
      const status = safeString(entry?.status).trim() || (entry?.ok ? "completed" : "failed");
      lines.push(`${i != null ? `${i}. ` : ""}${task} -> ${status}`);
    }
    return lines.join("\n");
  }

  _latestArtifactByKind(kind) {
    const registry = this._modules?.artifactRegistry;
    if (!registry || typeof registry.getAll !== "function") return null;
    const all = Array.isArray(registry.getAll()) ? registry.getAll() : [];
    const targetKind = safeString(kind).trim().toLowerCase();
    for (let i = all.length - 1; i >= 0; i -= 1) {
      const item = all[i];
      if (!isPlainObject(item)) continue;
      if (safeString(item.kind).trim().toLowerCase() !== targetKind) continue;
      return item;
    }
    return null;
  }

  _applyQueueCarryoverArtifacts(taskText) {
    let next = safeString(taskText).trim();
    if (!next) return next;
    const hasExplicitScript = /\.(?:gd)\b/i.test(next);
    const hasExplicitScene = /\.(?:tscn)\b/i.test(next);
    const hasScriptPronoun = /\b(?:this|that|the)\s+script\b/i.test(next);
    const hasScenePronoun = /\b(?:this|that|the)\s+scene\b/i.test(next);

    if (hasScriptPronoun && !hasExplicitScript) {
      const scriptArtifact = this._latestArtifactByKind("script");
      const scriptRef =
        safeString(scriptArtifact?.godotPath).trim() ||
        safeString(scriptArtifact?.relativePath).trim() ||
        safeString(scriptArtifact?.filename).trim() ||
        null;
      if (scriptRef) {
        next = next.replace(/\b(?:this|that|the)\s+script\b/i, `script ${scriptRef}`);
      }
    }
    if (hasScenePronoun && !hasExplicitScene) {
      const sceneArtifact = this._latestArtifactByKind("scene");
      const sceneRef =
        safeString(sceneArtifact?.godotPath).trim() ||
        safeString(sceneArtifact?.relativePath).trim() ||
        safeString(sceneArtifact?.filename).trim() ||
        null;
      if (sceneRef) {
        next = next.replace(/\b(?:this|that|the)\s+scene\b/i, `scene ${sceneRef}`);
      }
    }
    return next;
  }

  async _runTaskQueue({
    userRequest,
    projectRoot = null,
    mcpConfig = null,
    sessionContext = null,
    queueState = null,
    queueResumeState = null,
  } = {}) {
    const q = isPlainObject(queueState) ? queueState : {};
    const tasks = Array.isArray(q.tasks) ? q.tasks.map((t) => safeString(t).trim()).filter(Boolean) : [];
    if (tasks.length < 1) {
      return this._buildRunResult({
        ok: false,
        status: "unsupported",
        reason: "No queued tasks available for execution.",
        presentation: "Unsupported request: no queued tasks found.",
      });
    }
    let completedTasks = Array.isArray(q.completedTasks) ? [...q.completedTasks] : [];
    let currentTaskIndex = Number.isFinite(Number(q.currentTaskIndex))
      ? Math.max(0, Math.min(tasks.length - 1, Math.floor(Number(q.currentTaskIndex))))
      : 0;
    let pausedTask = isPlainObject(q.pausedTask) ? q.pausedTask : null;
    let pauseReason = safeString(q.pauseReason).trim().toLowerCase() === "needs_input" ? "needs_input" : "failed";
    const isResume = Boolean(queueResumeState?.isQueueExecution);

    for (let taskIndex = currentTaskIndex; taskIndex < tasks.length; taskIndex += 1) {
      const originalTaskText = tasks[taskIndex];
      let singleTaskRequest = originalTaskText;
      let singleTaskResumeState = null;

      if (isResume && taskIndex === currentTaskIndex && pausedTask) {
        if (pauseReason === "needs_input") {
          singleTaskRequest = safeString(userRequest).trim();
          singleTaskResumeState = pausedTask.result ?? null;
        } else {
          const action = this._interpretFailedTaskResumeInput(userRequest);
          if (action.type === "skip") {
            completedTasks.push({
              index: taskIndex,
              task: originalTaskText,
              ok: true,
              status: "skipped",
              reason: "Skipped by user request.",
              presentation: "Skipped.",
              result: null,
            });
            pausedTask = null;
            continue;
          }
          if (action.type === "replace_task") {
            singleTaskRequest = safeString(action.task).trim() || originalTaskText;
          }
        }
      }
      if (!singleTaskResumeState) {
        singleTaskRequest = this._applyQueueCarryoverArtifacts(singleTaskRequest);
      }

      const taskResult = await this._runSingleTask({
        userRequest: singleTaskRequest,
        projectRoot,
        mcpConfig,
        sessionContext,
        resumeNeedsInput: singleTaskResumeState,
      });
      const status = safeString(taskResult?.status).trim();
      if (taskResult?.ok && status === "completed") {
        completedTasks.push(
          this._toCompletedQueueTaskEntry({
            index: taskIndex,
            task: originalTaskText,
            result: taskResult,
          })
        );
        pausedTask = null;
        pauseReason = null;
        continue;
      }

      const queuePauseReason = status === "needs_input" ? "needs_input" : "failed";
      const remainingTasks = tasks.slice(taskIndex + 1);
      const queuePresentation =
        queuePauseReason === "needs_input"
          ? safeString(taskResult?.question).trim() ||
            `Task ${taskIndex + 1} needs more input before queue execution can continue.`
          : `Task ${taskIndex + 1} failed and queue execution is paused. Reply with \"retry\" to retry this task, \"skip\" to skip it, or provide replacement task text.`;

      return {
        ok: false,
        status: "paused",
        reason: queuePauseReason === "needs_input" ? "queue_paused_needs_input" : "queue_paused_failed",
        session: taskResult?.session ?? null,
        inventory: taskResult?.inventory ?? null,
        planning: taskResult?.planning ?? null,
        resolved: taskResult?.resolved ?? null,
        execution: taskResult?.execution ?? null,
        presentation: queuePresentation,
        runtime: taskResult?.runtime ?? null,
        workflow: taskResult?.workflow ?? null,
        pauseReason: queuePauseReason,
        question: queuePauseReason === "needs_input"
          ? queuePresentation
          : "What should I do with the paused task?",
        options: queuePauseReason === "needs_input"
          ? []
          : ["retry", "skip", "replace_task_text"],
        pausedTaskStatus: status || null,
        pausedTaskResult: taskResult,
        taskQueue: {
          mode: "sequential",
          status: "paused",
          originalRequest: safeString(q.originalRequest).trim() || null,
          totalTasks: tasks.length,
          currentTaskIndex: taskIndex,
          completedTasks,
          tasks,
          pendingTasks: tasks.slice(taskIndex),
          remainingTasks,
          pauseReason: queuePauseReason,
          pausedTask: {
            index: taskIndex,
            task: originalTaskText,
            result: taskResult,
          },
        },
      };
    }

    const last = completedTasks.length > 0 ? completedTasks[completedTasks.length - 1]?.result : null;
    return {
      ok: true,
      status: "completed",
      reason: null,
      session: last?.session ?? null,
      inventory: last?.inventory ?? null,
      planning: last?.planning ?? null,
      resolved: last?.resolved ?? null,
      execution: last?.execution ?? null,
      runtime: last?.runtime ?? null,
      workflow: last?.workflow ?? null,
      presentation: this._queueSummaryPresentation(completedTasks),
      taskQueue: {
        mode: "sequential",
        status: "completed",
        originalRequest: safeString(q.originalRequest).trim() || null,
        totalTasks: tasks.length,
        currentTaskIndex: tasks.length,
        completedTasks,
        tasks,
        pendingTasks: [],
        remainingTasks: [],
        pauseReason: null,
        pausedTask: null,
      },
    };
  }

  async _ensureModules({ mcpConfig = null, projectRoot = null } = {}) {
    const hasProvidedSession = this._provided.sessionManager != null;
    const activeConfig = mcpConfig ?? this._mcpConfig;

    if (!this._modules.sessionManager || (!hasProvidedSession && activeConfig && this._modules.sessionManager.getStatus()?.mcpConfig !== activeConfig)) {
      this._modules.sessionManager = this._provided.sessionManager ?? new SessionManager({ mcpConfig: activeConfig });
    }

    if (!this._modules.toolInventory) {
      this._modules.toolInventory =
        this._provided.toolInventory ??
        new ToolInventory({
          sessionManager: this._modules.sessionManager,
          pageSize: this._pageSize,
        });
    }
    if (!this._modules.toolPlanner) {
      const modelClient = this._modelClient ?? new LiveModelClient();
      this._modules.toolPlanner =
        this._provided.toolPlanner ??
        new ToolPlanner({
          toolInventory: this._modules.toolInventory,
          modelClient,
        });
    }
    if (!this._modules.fileIndex) {
      const pFi = this._provided.fileIndex;
      const rr = this._provided.resourceResolver;
      const fromRr = rr && typeof rr.getFileIndex === "function" ? rr.getFileIndex() : null;
      const ar0 = this._provided.argumentResolver;
      const fromAr = ar0 && typeof ar0.getFileIndex === "function" ? ar0.getFileIndex() : null;
      this._modules.fileIndex = pFi ?? fromRr ?? fromAr ?? new ProjectFileIndex({ debug: this._debug });
    }
    if (!this._modules.resourceResolver) {
      const rrProvided = this._provided.resourceResolver;
      const ar1 = this._provided.argumentResolver;
      const fromArFr = ar1 && typeof ar1.getFileResolver === "function" ? ar1.getFileResolver() : null;
      this._modules.resourceResolver =
        rrProvided ??
        fromArFr ??
        new ResourceResolver({
          fileIndex: this._modules.fileIndex,
          debug: this._debug,
        });
    }
    if (!this._modules.nodeResolver) {
      this._modules.nodeResolver = new NodeResolver({
        sessionManager: this._modules.sessionManager,
        inventory: this._modules.toolInventory,
      });
    }
    if (!this._modules.argumentResolver) {
      this._modules.argumentResolver =
        this._provided.argumentResolver ??
        new ArgumentResolver({
          sessionManager: this._modules.sessionManager,
          fileResolver: this._modules.resourceResolver,
          nodeResolver: this._modules.nodeResolver,
          toolInventory: this._modules.toolInventory,
          debug: this._debug,
        });
    }
    if (!this._modules.executor) {
      this._modules.executor =
        this._provided.executor ??
        new Executor({
          sessionManager: this._modules.sessionManager,
          toolInventory: this._modules.toolInventory,
          fileIndex: this._modules.fileIndex,
          debug: this._debug,
        });
    }
    if (!this._modules.resultPresenter) {
      this._modules.resultPresenter =
        this._provided.resultPresenter ??
        new ResultPresenter({ debug: this._debug });
    }
    if (!this._modules.artifactRegistry) {
      this._modules.artifactRegistry = new ArtifactRegistry();
    }

    void projectRoot;
  }

  _presentNonReadyState(resolvedPlan) {
    const status = safeString(resolvedPlan?.status).trim() || "unsupported";
    if (status === "missing_args") {
      const missing = Array.isArray(resolvedPlan?.missingArgs) ? resolvedPlan.missingArgs : [];
      return `Missing arguments: ${missing.join(", ") || "(none listed)"}`;
    }
    if (status === "not_found") {
      return `Not found: ${safeString(resolvedPlan?.reason).trim() || "referenced resource does not exist"}`;
    }
    if (status === "ambiguous") {
      const items = Array.isArray(resolvedPlan?.ambiguities) ? resolvedPlan.ambiguities : [];
      return `Ambiguous request: ${items.join(" | ") || "multiple possible interpretations"}`;
    }
    if (status === "uncompilable") {
      return `Uncompilable request: ${safeString(resolvedPlan?.reason).trim() || "could not compile executable payload"}`;
    }
    return `Unsupported request: ${safeString(resolvedPlan?.reason).trim() || "no supported plan"}`;
  }

  _buildNeedsInputResult({ sessionStatus, inventory, planningResult, resolvedPlan, workflowState = null }) {
    const rs = safeString(resolvedPlan?.status).trim() || "unsupported";
    const ps = safeString(planningResult?.status).trim() || null;
    if (rs === "uncompilable") {
      const presentation = this._presentNonReadyState(resolvedPlan);
      return this._buildRunResult({
        ok: false,
        status: "uncompilable",
        reason: safeString(resolvedPlan?.reason).trim() || "uncompilable",
        sessionStatus,
        inventorySummary: { toolCount: inventory.toolCount, fetchedAt: inventory.fetchedAt },
        planningResult,
        resolvedPlan,
        executionResult: null,
        presentation,
        runtimeState: buildRuntimeState({
          planningResult,
          resolvedPlan,
          needsInput: null,
          inventory,
        }),
        workflowState,
      });
    }
    const kind = ["missing_args", "ambiguous", "not_found", "unsupported", "invalid_args", "not_ready"].includes(rs)
      ? rs
      : ["missing_args", "ambiguous", "unsupported"].includes(ps)
        ? ps
        : "unsupported";

    const candidateTool = resolvedPlan?.tools?.[0] ?? planningResult?.tools?.[0] ?? null;
    const toolName = safeString(candidateTool?.name).trim() || null;
    const semanticArgs = extractSemanticArgs({
      toolName,
      args: isPlainObject(planningResult?.tools?.[0]?.args) ? planningResult.tools[0].args : candidateTool?.args,
      inventory,
    });

    let field = null;
    let options = [];
    let attemptedValue = null;
    let missing = [];
    const semanticState = isPlainObject(workflowState?.semanticState) ? workflowState.semanticState : {};
    const semanticIntent = isPlainObject(workflowState?.semanticIntent) ? workflowState.semanticIntent : {};
    const hasTargetedEdits = Array.isArray(semanticState?.targetedEdits) && semanticState.targetedEdits.length > 0;
    const targetRefPreference = ["scriptRef", "fileRef", "resourceRef", "artifactRef"].find((k) => {
      const fromState = safeString(semanticState?.targetRefs?.[k]).trim();
      const fromIntent = safeString(semanticIntent?.refs?.[k]).trim();
      const fromArgs = safeString(semanticArgs?.[k]).trim();
      return Boolean(fromState || fromIntent || fromArgs);
    }) || "artifactRef";

    if (kind === "missing_args" || kind === "not_ready") {
      missing = Array.isArray(resolvedPlan?.missingArgs) ? resolvedPlan.missingArgs : [];
      const semanticMissing = missing
        .map((m) => normalizeFieldName(toSemanticField(m)))
        .filter(Boolean)
        .filter((m) => !hasSemanticFieldValue(workflowState?.semanticState, m));
      field = semanticMissing[0] ?? normalizeFieldName(toSemanticField(missing[0] ?? null));
      if (semanticMissing.length > 0) missing = semanticMissing;
      const asksForBroadContent =
        safeString(field).trim() === "contentIntent" ||
        safeString(field).trim() === "codeIntent" ||
        missing.some((m) => {
          const n = normalizeFieldName(toSemanticField(m));
          return n === "contentIntent" || n === "codeIntent";
        });
      if (hasTargetedEdits && asksForBroadContent) {
        field = targetRefPreference;
        missing = [targetRefPreference];
      }
    } else if (kind === "ambiguous") {
      options = Array.isArray(resolvedPlan?.ambiguities) ? resolvedPlan.ambiguities : [];
      const first = safeString(options[0]).trim();
      const m = first.match(/^([a-zA-Z0-9_]+)\s*[:=]/);
      field = normalizeFieldName(toSemanticField(m?.[1] ?? null));
    } else if (kind === "not_found") {
      const reason = safeString(resolvedPlan?.reason).trim();
      const m = reason.match(/([a-zA-Z0-9_]+)\s*\(not_found:\s*([^)]+)\)/i);
      field = normalizeFieldName(toSemanticField(m?.[1] ?? null));
      attemptedValue = safeString(m?.[2]).trim() || null;
    }
    // For create-oriented flows, asking for an existing artifact ref is misleading.
    const opMode = safeString(workflowState?.artifactOperation?.mode).trim().toLowerCase();
    const isCreateMode = opMode.startsWith("create_");
    const knownRequestedName =
      safeString(workflowState?.semanticState?.creationIntent?.requestedName).trim() ||
      safeString(workflowState?.semanticIntent?.creationIntent?.requestedName).trim() ||
      safeString(semanticArgs?.requestedName).trim() ||
      "";
    if (isCreateMode && /ref$/i.test(safeString(field)) && !knownRequestedName) {
      field = "requestedName";
      missing = ["requestedName"];
    }
    if (kind === "missing_args" && hasSemanticFieldValue(workflowState?.semanticState, field)) {
      const semanticGap = firstPendingSemanticGap(workflowState?.semanticState);
      if (semanticGap) {
        field = semanticGap;
        missing = [semanticGap];
      }
    }

    const question =
      kind === "ambiguous"
        ? (field ? `I found multiple matches for ${field}. Which one should I use?` : "I found multiple possible matches. Which one should I use?")
        : kind === "not_found"
          ? (field ? `I could not find ${field}. Can you provide an exact path or filename?` : "I could not find the referenced item. Can you provide an exact path or filename?")
          : kind === "not_ready"
            ? (safeString(resolvedPlan?.reason).trim() || "The selected tool arguments are not executable yet.")
          : kind === "unsupported"
            ? (safeString(resolvedPlan?.reason || planningResult?.reason).trim() || "This request is not supported by current live tools.")
            : questionForField(field);

    const presentation = this._presentNonReadyState(resolvedPlan);
    return this._buildRunResult({
      ok: false,
      status: "needs_input",
      reason: safeString(resolvedPlan?.reason).trim() || kind,
      sessionStatus,
      inventorySummary: { toolCount: inventory.toolCount, fetchedAt: inventory.fetchedAt },
      planningResult,
      resolvedPlan,
      executionResult: null,
      presentation,
      needsInput: {
        status: "needs_input",
        kind,
        tool: toolName,
        question,
        missing,
        field,
        options,
        attemptedValue,
        partialPlan: {
          tool: toolName,
          args: {
            ...seedArgsFromSemanticState({}, workflowState?.semanticState),
            ...semanticArgs,
          },
        },
        raw: {
          plannerStatus: ps,
          resolverStatus: rs,
        },
      },
      runtimeState: buildRuntimeState({
        planningResult,
        resolvedPlan,
        needsInput: {
          status: "needs_input",
          kind,
          field,
          options,
          attemptedValue,
        },
        inventory,
      }),
      workflowState,
    });
  }

  _buildResumePlan(needsInput, answer) {
    const ni = isPlainObject(needsInput) ? needsInput : null;
    if (!ni) return null;
    const pp = isPlainObject(ni.partialPlan) ? ni.partialPlan : null;
    const tool = safeString(pp?.tool).trim();
    const semanticArgs = isPlainObject(pp?.args) ? { ...pp.args } : null;
    const field = normalizeFieldName(toSemanticField(ni.field));
    const response = safeString(answer).trim();
    if (!tool || !semanticArgs || !field || !response) return null;

    // Resume updates semantic state only; resolver rebuilds execution args.
    semanticArgs[field] = response;
    if (field === "artifactOperationChoice") {
      semanticArgs.operationMode = response;
    }
    for (const key of semanticResolvedArgCandidates(field)) {
      if (Object.prototype.hasOwnProperty.call(semanticArgs, key)) {
        delete semanticArgs[key];
      }
    }
    return {
      status: "ready",
      tools: [{ name: tool, args: semanticArgs }],
      missingArgs: [],
      ambiguities: [],
      reason: null,
    };
  }

  _buildRunResult({
    ok,
    status = null,
    reason = null,
    sessionStatus = null,
    inventorySummary = null,
    planningResult = null,
    resolvedPlan = null,
    executionResult = null,
    presentation = "",
    needsInput = null,
    runtimeState = null,
    workflowState = null,
  } = {}) {
    const s = safeString(status).trim() || (ok ? "completed" : "failed");
    return {
      ok: Boolean(ok),
      status: s,
      reason: reason ?? null,
      session: sessionStatus ?? null,
      inventory: inventorySummary ?? null,
      planning: planningResult ?? null,
      resolved: resolvedPlan ?? null,
      execution: executionResult ?? null,
      presentation: safeString(presentation),
      ...(isPlainObject(runtimeState) ? { runtime: runtimeState } : {}),
      ...(isPlainObject(workflowState) ? { workflow: this._compactWorkflowForPlanner(workflowState) } : {}),
      ...(isPlainObject(needsInput) ? needsInput : {}),
    };
  }

  _initWorkflowState({ userRequest, resumeNeedsInput }) {
    const prior = isPlainObject(resumeNeedsInput?.workflow) ? resumeNeedsInput.workflow : null;
    const priorIntent = isPlainObject(prior?.semanticIntent) ? prior.semanticIntent : null;
    const semanticIntent = this._sanitizeSemanticIntent({
      semanticIntent: interpretGoalIntent({ userRequest, prior: priorIntent }),
      userRequest,
    });
    const artifactOperation =
      isPlainObject(prior?.artifactOperation)
        ? {
            ...prior.artifactOperation,
            observedEffects: isPlainObject(prior.artifactOperation.observedEffects)
              ? { ...prior.artifactOperation.observedEffects }
              : { artifactCreated: false, artifactModified: false, artifactAttached: false },
          }
        : buildArtifactOperationState({ semanticIntent });
    const generatedArtifacts = Array.isArray(prior?.generatedArtifacts) ? [...prior.generatedArtifacts] : [];
    const artifact = synthesizeCodeArtifact({ semanticIntent });
    if (artifact) generatedArtifacts.push(artifact);
    const priorSemanticState = isPlainObject(prior?.semanticState) ? prior.semanticState : null;
    const semanticState = buildSemanticWorkflowState({
      semanticIntent,
      artifactOperation,
      priorSemanticState,
    });
    const workflowState = {
      goal: safeString(userRequest).trim(),
      history: Array.isArray(prior?.history) ? [...prior.history] : [],
      stepSignatures: new Map(),
      stepCount: Number(prior?.stepCount) || 0,
      semanticIntent,
      semanticState,
      artifactOperation,
      generatedArtifacts: generatedArtifacts.slice(-6),
      doneWithoutPostconditionCount: Number(prior?.doneWithoutPostconditionCount) || 0,
      unmetPostconditions: Array.isArray(prior?.unmetPostconditions) ? [...prior.unmetPostconditions] : [],
    };
    this._refreshEffectState(workflowState);
    this._ensureCanonicalSemanticState(workflowState);
    return workflowState;
  }

  _ensureCanonicalSemanticState(workflowState) {
    if (!isPlainObject(workflowState)) return;
    if (!isPlainObject(workflowState.semanticIntent)) workflowState.semanticIntent = {};
    if (!isPlainObject(workflowState.semanticState)) workflowState.semanticState = {};
    const semanticIntent = workflowState.semanticIntent;
    const semanticState = workflowState.semanticState;
    const opMode =
      normalizeArtifactOpMode(semanticState.operationMode) ||
      normalizeArtifactOpMode(workflowState?.artifactOperation?.mode) ||
      normalizeArtifactOpMode(semanticState.artifactIntent) ||
      null;
    if (opMode) semanticState.operationMode = opMode;

    const intentRefs = isPlainObject(semanticIntent.refs) ? semanticIntent.refs : {};
    const stateRefs = isPlainObject(semanticState.targetRefs) ? semanticState.targetRefs : {};
    const refKeys = ["sceneRef", "nodeRef", "targetNodeRef", "scriptRef", "fileRef", "resourceRef", "artifactRef"];
    const mergedRefs = {};
    for (const key of refKeys) {
      const fromState = safeString(stateRefs[key]).trim();
      const fromIntent = safeString(intentRefs[key]).trim();
      const merged = fromState || fromIntent || null;
      mergedRefs[key] = merged && !isLikelyMarkerToken(merged) ? merged : null;
    }
    const targetConcept =
      safeString(semanticState.targetConcept).trim() ||
      safeString(semanticIntent.targetConcept).trim() ||
      null;
    const mode = safeString(semanticState.operationMode || workflowState?.artifactOperation?.mode).trim().toLowerCase();
    const isAttachIntent = mode.includes("attach");
    if (isAttachIntent && !safeString(mergedRefs.targetNodeRef).trim() && targetConcept && !isLikelyMarkerToken(targetConcept)) {
      mergedRefs.targetNodeRef = targetConcept;
    }
    semanticState.targetRefs = mergedRefs;
    semanticIntent.refs = { ...intentRefs, ...mergedRefs };

    const ci = isPlainObject(semanticState.creationIntent) ? semanticState.creationIntent : {};
    semanticState.creationIntent = {
      requestedName: safeString(ci.requestedName || semanticIntent?.creationIntent?.requestedName).trim() || null,
      resourceKind: safeString(ci.resourceKind || semanticIntent?.creationIntent?.resourceKind).trim() || null,
      targetFolder: safeString(ci.targetFolder || semanticIntent?.creationIntent?.targetFolder).trim() || null,
    };
    if (!Array.isArray(semanticState.targetedEdits)) {
      semanticState.targetedEdits = Array.isArray(semanticIntent.targetedEdits) ? [...semanticIntent.targetedEdits] : [];
    }
    semanticState.contentIntent =
      safeString(semanticState.contentIntent).trim() ||
      safeString(semanticIntent.contentIntent).trim() ||
      null;
    semanticState.generatedContent = isPlainObject(semanticState.generatedContent) ? semanticState.generatedContent : null;
    semanticState.generatedCode = safeString(semanticState.generatedCode).trim() || null;
    semanticState.knownFacts = isPlainObject(semanticState.knownFacts) ? semanticState.knownFacts : {};
    semanticState.completedEffects = Array.isArray(semanticState.completedEffects) ? semanticState.completedEffects : [];
    const remaining = Array.isArray(workflowState?.effectState?.remainingEffects) ? workflowState.effectState.remainingEffects : [];
    const satisfied = Array.isArray(workflowState?.effectState?.satisfiedEffects) ? workflowState.effectState.satisfiedEffects : [];
    semanticState.knownFacts.remainingEffects = remaining;
    semanticState.completedEffects = [...new Set([...semanticState.completedEffects, ...satisfied])];
  }

  _sanitizeSemanticIntent({ semanticIntent, userRequest }) {
    const base = isPlainObject(semanticIntent) ? { ...semanticIntent } : {};
    const refs = isPlainObject(base.refs) ? { ...base.refs } : {};
    const inferredNamedTarget = extractNamedEntityFromRequest(userRequest);
    for (const key of Object.keys(refs)) {
      if (!/ref$/i.test(key)) continue;
      const current = safeString(refs[key]).trim();
      if (!isLikelyMarkerToken(current)) continue;
      if (inferredNamedTarget) refs[key] = inferredNamedTarget;
      else delete refs[key];
    }
    base.refs = refs;
    return base;
  }

  _compactWorkflowForPlanner(workflowState) {
    const wf = isPlainObject(workflowState) ? workflowState : {};
    const artifacts = this._modules.artifactRegistry?.getAll?.() ?? [];
    return {
      goal: safeString(wf.goal).trim(),
      stepCount: Number(wf.stepCount) || 0,
      history: Array.isArray(wf.history) ? wf.history.slice(-8) : [],
      artifactCount: Array.isArray(artifacts) ? artifacts.length : 0,
      semanticIntent: isPlainObject(wf.semanticIntent) ? wf.semanticIntent : {},
      semanticState: isPlainObject(wf.semanticState) ? wf.semanticState : {},
      contentApplication: isPlainObject(wf.semanticState?.contentApplication) ? wf.semanticState.contentApplication : null,
      contentConsumerSelection: isPlainObject(wf.semanticState?.contentConsumerSelection)
        ? wf.semanticState.contentConsumerSelection
        : null,
      artifactOperation: isPlainObject(wf.artifactOperation) ? wf.artifactOperation : {},
      generatedArtifacts: Array.isArray(wf.generatedArtifacts) ? wf.generatedArtifacts.slice(-3) : [],
      unmetPostconditions: Array.isArray(wf.unmetPostconditions) ? wf.unmetPostconditions : [],
      effectState: isPlainObject(wf.effectState) ? wf.effectState : {
        expectedEffects: [],
        satisfiedEffects: [],
        remainingEffects: [],
      },
    };
  }

  _recordWorkflowStep(workflowState, { planning, resolvedPlan, executionResult }) {
    if (!isPlainObject(workflowState)) return;
    const tool = safeString(resolvedPlan?.tools?.[0]?.name || planning?.step?.tool || planning?.tools?.[0]?.name).trim() || null;
    const args = isPlainObject(resolvedPlan?.tools?.[0]?.args) ? resolvedPlan.tools[0].args : {};
    const res0 = Array.isArray(executionResult?.results) ? executionResult.results[0] : null;
    const compact = {
      tool,
      ok: Boolean(res0?.ok),
      args: this._compactArgsForHistory(args),
      summary: this._compactResultSummary(res0?.rawResult),
    };
    workflowState.history = Array.isArray(workflowState.history) ? workflowState.history : [];
    workflowState.history.push(compact);
    workflowState.stepCount = Number(workflowState.stepCount || 0) + 1;
    this._updateSemanticIntentFromStep(workflowState, args);
  }

  _mergePlanningSemanticIntoState(workflowState, plan) {
    if (!isPlainObject(workflowState) || !isPlainObject(plan)) return;
    const toolArgs = isPlainObject(plan?.tools?.[0]?.args)
      ? plan.tools[0].args
      : isPlainObject(plan?.step?.args)
        ? plan.step.args
        : {};
    updateSemanticStateFromStep({
      semanticState: workflowState.semanticState,
      resolvedArgs: toolArgs,
      stepToolName: safeString(plan?.tools?.[0]?.name || plan?.step?.tool).trim(),
      executionResult: null,
      artifactOperation: workflowState.artifactOperation,
    });
    refreshPendingSemanticGaps(workflowState.semanticState, workflowState.artifactOperation);
  }

  _seedPlanFromSemanticState({ plan, workflowState }) {
    const p = isPlainObject(plan) ? plan : {};
    if (safeString(p.status).trim() !== "ready") return p;
    const tools = Array.isArray(p.tools) ? p.tools : [];
    if (tools.length < 1) return p;
    const patchedTools = tools.map((t) => {
      const name = safeString(t?.name).trim();
      const args = seedArgsFromSemanticState(t?.args, workflowState?.semanticState);
      return { name, args };
    });
    return { ...p, tools: patchedTools };
  }

  _compactArgsForHistory(args) {
    const input = isPlainObject(args) ? args : {};
    const out = {};
    const keys = Object.keys(input).slice(0, 8);
    for (const k of keys) {
      const v = input[k];
      out[k] = typeof v === "string" ? v.slice(0, 120) : v;
    }
    return out;
  }

  _compactResultSummary(rawResult) {
    if (!isPlainObject(rawResult)) return safeString(rawResult).slice(0, 180) || null;
    if (rawResult.error != null) return safeString(rawResult.error).slice(0, 180);
    const text = Array.isArray(rawResult.content)
      ? rawResult.content.map((c) => safeString(c?.text).trim()).filter(Boolean).join(" ")
      : "";
    if (text) return text.slice(0, 220);
    try {
      return JSON.stringify(rawResult).slice(0, 220);
    } catch {
      return null;
    }
  }

  _stepSignature(stepTool) {
    const name = safeString(stepTool?.name).trim();
    const args = isPlainObject(stepTool?.args) ? stepTool.args : {};
    const keys = Object.keys(args).sort();
    const compact = {};
    for (const k of keys) compact[k] = args[k];
    return `${name}::${JSON.stringify(compact)}`;
  }

  _markAndCheckRepeat(workflowState, signature) {
    if (!signature || !isPlainObject(workflowState)) return false;
    if (!(workflowState.stepSignatures instanceof Map)) workflowState.stepSignatures = new Map();
    const next = Number(workflowState.stepSignatures.get(signature) || 0) + 1;
    workflowState.stepSignatures.set(signature, next);
    return next >= 3;
  }

  async _refreshAndValidateExecutionTools({ toolInventory, resolvedPlan } = {}) {
    const inventoryApi = toolInventory ?? this._modules.toolInventory;
    if (!inventoryApi || typeof inventoryApi.refresh !== "function" || typeof inventoryApi.getInventory !== "function") {
      return {
        ok: false,
        inventory: this._modules.toolInventory?.getInventory?.() ?? { toolCount: 0, tools: [], fetchedAt: null },
        error: "Live inventory validation failed: tool inventory does not support refresh/getInventory.",
      };
    }
    const refreshed = await inventoryApi.refresh();
    const liveInventory = inventoryApi.getInventory();
    if (!refreshed?.ok) {
      return {
        ok: false,
        inventory: liveInventory,
        error: `Live inventory refresh failed before execution: ${safeString(refreshed?.error || "unknown error")}`,
      };
    }

    const plannedTools = Array.isArray(resolvedPlan?.tools) ? resolvedPlan.tools : [];
    const liveNames = Array.isArray(liveInventory?.tools)
      ? liveInventory.tools.map((tool) => safeString(tool?.name).trim()).filter(Boolean)
      : [];
    const liveNameSet = new Set(liveNames);
    const missingNames = [];
    const driftHints = [];
    for (const stepTool of plannedTools) {
      const name = safeString(stepTool?.name).trim();
      if (!name) continue;
      if (liveNameSet.has(name)) continue;
      missingNames.push(name);
      const aliasCandidates = this._findLikelyAliasCandidates(name, liveNames);
      if (aliasCandidates.length > 0) {
        driftHints.push(`${name} -> ${aliasCandidates.join(", ")}`);
      }
    }
    if (missingNames.length > 0) {
      const driftText = driftHints.length > 0
        ? ` Potential alias drift: ${driftHints.join("; ")}.`
        : "";
      return {
        ok: false,
        inventory: liveInventory,
        error: `Planned tool name(s) not found in current live inventory: ${missingNames.join(", ")}.${driftText} Re-plan against the current live tool inventory and retry.`,
      };
    }
    return { ok: true, inventory: liveInventory, error: null };
  }

  _findLikelyAliasCandidates(plannedName, liveNames = []) {
    const planned = safeString(plannedName).trim();
    if (!planned) return [];
    const plannedNormalized = this._normalizeToolNameIdentity(planned);
    const plannedSignature = this._toolTokenSignature(planned);
    const out = [];
    for (const name of liveNames) {
      const candidate = safeString(name).trim();
      if (!candidate || candidate === planned) continue;
      const sameIdentity = this._normalizeToolNameIdentity(candidate) === plannedNormalized;
      const sameTokenSet = this._toolTokenSignature(candidate) === plannedSignature;
      if (sameIdentity || sameTokenSet) out.push(candidate);
      if (out.length >= 3) break;
    }
    return out;
  }

  _normalizeToolNameIdentity(value) {
    return safeString(value).toLowerCase().replace(/[^a-z0-9]/g, "");
  }

  _toolTokenSignature(value) {
    const tokens = safeString(value).toLowerCase().match(/[a-z0-9]+/g) ?? [];
    if (tokens.length < 1) return "";
    return [...tokens].sort().join("|");
  }

  async _ensureGeneratedContentStage({ resolvedPlan, workflowState, sessionContext = null }) {
    const rp = isPlainObject(resolvedPlan) ? resolvedPlan : {};
    if (safeString(rp.status).trim() !== "ready") return;
    const firstTool = rp?.tools?.[0] ?? null;
    const toolName = safeString(firstTool?.name).trim();
    if (!toolName) return;
    const args = isPlainObject(firstTool?.args) ? firstTool.args : {};
    const semanticState = isPlainObject(workflowState?.semanticState) ? workflowState.semanticState : {};
    const semanticIntent = isPlainObject(workflowState?.semanticIntent) ? workflowState.semanticIntent : {};
    const hasIntent = Boolean(
      safeString(args?.contentIntent).trim() ||
      safeString(args?.codeIntent).trim() ||
      safeString(semanticState?.contentIntent).trim() ||
      safeString(semanticState?.codeIntent).trim() ||
      safeString(semanticIntent?.contentIntent).trim() ||
      safeString(semanticIntent?.codeIntent).trim() ||
      safeString(semanticIntent?.behaviorIntent).trim()
    );
    if (!hasIntent) return;

    const generated = await ensureGeneratedContentForStep({
      toolName,
      args,
      workflowState,
      modelClient: this._modelClient,
      allowFallback: this._allowContentFallback,
      sessionContext,
    });
    if (isPlainObject(generated?.generationContext)) {
      if (!isPlainObject(workflowState.semanticState)) workflowState.semanticState = {};
      workflowState.semanticState.generationContext = { ...generated.generationContext };
    }
    if (safeString(generated?.status).trim() !== "ready" || !isPlainObject(generated?.generatedContent)) return generated;
    if (!isPlainObject(workflowState.semanticState)) workflowState.semanticState = {};
    workflowState.semanticState.generatedContent = { ...generated.generatedContent };
    workflowState.semanticState.generatedCode = safeString(generated.generatedContent.content).trim() || null;
    workflowState.semanticState.contentApplication = {
      status: "pending",
      intent: safeString(generated.generatedContent.intent).trim() || null,
      contextReadiness: safeString(generated.generatedContent.contextReadiness).trim() || null,
    };
    if (!safeString(workflowState.semanticState.contentIntent).trim()) {
      workflowState.semanticState.contentIntent = safeString(generated.generatedContent.intent).trim() || null;
    }
    console.log("[VERIFY][post-contentgen-state]", {
      hasGeneratedContent: Boolean(safeString(workflowState?.semanticState?.generatedContent?.content).trim()),
      hasGeneratedCode: Boolean(safeString(workflowState?.semanticState?.generatedCode).trim()),
      hasCompiledPayload:
        isPlainObject(workflowState?.semanticState?.compiledPayload) &&
        Object.keys(workflowState.semanticState.compiledPayload).length > 0,
      generatedContent: workflowState?.semanticState?.generatedContent ?? null,
      generatedCode: workflowState?.semanticState?.generatedCode ?? null,
      generatedPreview: safeString(
        workflowState?.semanticState?.generatedContent?.content ||
        workflowState?.semanticState?.generatedCode ||
        ""
      ).slice(0, 300),
    });
    return generated;
  }

  _isContentBearingWorkflow(workflowState) {
    const semanticState = isPlainObject(workflowState?.semanticState) ? workflowState.semanticState : {};
    const semanticIntent = isPlainObject(workflowState?.semanticIntent) ? workflowState.semanticIntent : {};
    return Boolean(
      safeString(semanticState.contentIntent).trim() ||
      safeString(semanticIntent.contentIntent).trim() ||
      safeString(semanticIntent.codeIntent).trim() ||
      safeString(semanticIntent.behaviorIntent).trim()
    );
  }

  _hasGeneratedOrCompiledContent(workflowState) {
    const semanticState = isPlainObject(workflowState?.semanticState) ? workflowState.semanticState : {};
    return Boolean(
      safeString(semanticState?.generatedCode).trim() ||
      safeString(semanticState?.generatedContent?.content).trim() ||
      (isPlainObject(semanticState?.compiledPayload) && Object.keys(semanticState.compiledPayload).length > 0)
    );
  }

  async _ensureContentGenerationInvariant({ workflowState }) {
    if (!this._isContentBearingWorkflow(workflowState)) return { ok: true, reason: null };
    if (this._hasGeneratedOrCompiledContent(workflowState)) return { ok: true, reason: null };
    const semanticState = isPlainObject(workflowState?.semanticState) ? workflowState.semanticState : {};
    const semanticIntent = isPlainObject(workflowState?.semanticIntent) ? workflowState.semanticIntent : {};
    const hasSemanticContentIntent = Boolean(
      safeString(semanticState?.contentIntent).trim() ||
      safeString(semanticState?.codeIntent).trim() ||
      safeString(semanticIntent?.contentIntent).trim() ||
      safeString(semanticIntent?.codeIntent).trim() ||
      safeString(semanticIntent?.behaviorIntent).trim()
    );
    if (!hasSemanticContentIntent) {
      return {
        ok: false,
        kind: "needs_input",
        field: "contentIntent",
        reason: "I need the desired behavior/content to generate an implementation.",
      };
    }
    const seedPlan = {
      status: "ready",
      tools: [{ name: "content-generation", args: seedArgsFromSemanticState({}, workflowState?.semanticState) }],
    };
    const generated = await this._ensureGeneratedContentStage({
      resolvedPlan: seedPlan,
      workflowState,
      sessionContext: null,
    });
    if (safeString(generated?.status).trim() === "ready" && this._hasGeneratedOrCompiledContent(workflowState)) {
      return { ok: true, reason: null };
    }
    const missingField = normalizeFieldName(toSemanticField(generated?.missingSemanticField || null));
    if (missingField) {
      return {
        ok: false,
        kind: "needs_input",
        field: missingField,
        reason: safeString(generated?.reason).trim() || "More semantic intent is needed to generate content.",
      };
    }
    return {
      ok: false,
      reason: safeString(generated?.reason).trim() || "content_generation_required_but_not_available",
    };
  }

  _updateSemanticIntentFromStep(workflowState, args) {
    if (!isPlainObject(workflowState) || !isPlainObject(args)) return;
    const intent = isPlainObject(workflowState.semanticIntent) ? workflowState.semanticIntent : {};
    const refs = isPlainObject(intent.refs) ? intent.refs : {};
    const keyMap = [
      ["sceneRef", "sceneRef"],
      ["nodeRef", "nodeRef"],
      ["targetNodeRef", "targetNodeRef"],
      ["scriptRef", "scriptRef"],
      ["fileRef", "fileRef"],
      ["resourceRef", "resourceRef"],
      ["scenePath", "sceneRef"],
      ["nodePath", "nodeRef"],
      ["scriptPath", "scriptRef"],
      ["filePath", "fileRef"],
      ["resourcePath", "resourceRef"],
    ];
    for (const [k, outKey] of keyMap) {
      const v = safeString(args[k]).trim();
      if (!v) continue;
      refs[outKey] = v;
    }
    workflowState.semanticIntent = {
      ...intent,
      refs,
    };
  }

  _refreshSemanticStateFromStep(workflowState, resolvedPlan, executionResult) {
    if (!isPlainObject(workflowState)) return;
    const args = isPlainObject(resolvedPlan?.tools?.[0]?.args) ? resolvedPlan.tools[0].args : {};
    updateSemanticStateFromStep({
      semanticState: workflowState.semanticState,
      resolvedArgs: args,
      stepToolName: safeString(resolvedPlan?.tools?.[0]?.name).trim(),
      executionResult,
      artifactOperation: workflowState.artifactOperation,
    });
    refreshPendingSemanticGaps(workflowState.semanticState, workflowState.artifactOperation);
    this._refreshEffectState(workflowState);
  }

  _refreshEffectState(workflowState) {
    if (!isPlainObject(workflowState)) {
      return { expectedEffects: [], satisfiedEffects: [], remainingEffects: [] };
    }
    const op = isPlainObject(workflowState.artifactOperation) ? workflowState.artifactOperation : {};
    const expectedMap = isPlainObject(op.expectedEffects) ? op.expectedEffects : {};
    const observedMap = isPlainObject(op.observedEffects) ? op.observedEffects : {};
    const expectedEffects = Object.entries(expectedMap)
      .filter(([, v]) => Boolean(v))
      .map(([k]) => k);
    const satisfiedEffects = expectedEffects.filter((k) => Boolean(observedMap[k]));
    const remainingEffects = expectedEffects.filter((k) => !Boolean(observedMap[k]));
    workflowState.effectState = {
      expectedEffects,
      satisfiedEffects,
      remainingEffects,
    };
    return workflowState.effectState;
  }

  _runtimeWithWorkflow({ planningResult, resolvedPlan, inventory, workflowState }) {
    return {
      ...buildRuntimeState({
        planningResult,
        resolvedPlan,
        needsInput: null,
        inventory,
      }),
      workflow: this._compactWorkflowForPlanner(workflowState),
    };
  }
}
