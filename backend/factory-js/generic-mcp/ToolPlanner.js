/**
 * ToolPlanner
 * -----------------------------------------------------------------------------
 * LLM-first planner for Generic MCP requests.
 *
 * Responsibilities:
 * - consume raw user request + live tool inventory + optional session context
 * - ask model to pick tools only from live inventory (1..6 max)
 * - return structured plan states: ready | missing_args | ambiguous | unsupported
 *
 * Creation intent: for create/new requests, `tools[].args` should carry semantic fields
 * (`requestedName`, `targetFolder`, `resourceKind`, `rootNodeType`, nested `creationIntent`, …)
 * rather than inventing final `scenePath` / `filePath` values — downstream synthesis fills paths.
 *
 * Out of scope:
 * - tool execution
 * - argument/path resolution (see ArgumentResolver + PathSynthesizer)
 * - result presentation
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { classifyToolArgs, semanticArgCandidates, semanticSlotForArg } from "./ArgRoleClassifier.js";
import { synthesizeMissingCreationPath } from "./PathSynthesizer.js";
import { narrowPlannerCatalog } from "./PlannerCandidateRanker.js";

function safeString(value) {
  return value == null ? "" : String(value);
}

function isPlainObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function clampToolCalls(value, min = 1, max = 6) {
  const n = Number(value);
  if (!Number.isFinite(n)) return max;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function parseJsonObjectLoose(text) {
  const raw = safeString(text).trim();
  if (!raw) throw new Error("Model response is empty.");
  try {
    return JSON.parse(raw);
  } catch {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(raw.slice(start, end + 1));
    }
    throw new Error("Model response is not valid JSON.");
  }
}

function normalizePlannerEntry(entry) {
  const raw = isPlainObject(entry) ? entry : {};
  const name = safeString(raw.name).trim();
  if (!name) return null;
  const summary = safeString(raw.summary).trim() || null;
  const requiredSlots = Array.isArray(raw.requiredSlots)
    ? raw.requiredSlots.map((k) => safeString(k).trim()).filter(Boolean)
    : [];
  const tags = Array.isArray(raw.tags)
    ? raw.tags.map((k) => safeString(k).trim()).filter(Boolean).slice(0, 8)
    : [];
  return {
    name,
    summary,
    requiredSlots,
    tags,
    verb: safeString(raw.verb).trim() || null,
    category: safeString(raw.category).trim() || null,
  };
}
function isLikelyJsonParseFailure(error) {
  const text = safeString(error?.message ?? error).toLowerCase();
  if (!text) return false;
  return (
    text.includes("not valid json") ||
    text.includes("unexpected token") ||
    text.includes("json.parse") ||
    text.includes("property name")
  );
}
function buildJsonRepairPrompt(prompt) {
  const base = safeString(prompt).trim();
  return [
    base,
    "",
    "IMPORTANT: Return ONLY one valid JSON object.",
    "Do not include markdown fences, comments, prose, or any text before/after JSON.",
  ].join("\n");
}

function normalizeMissingArgs(args) {
  return Array.isArray(args)
    ? args.map((x) => safeString(x).trim()).filter(Boolean)
    : [];
}

function normalizeAmbiguities(items) {
  if (!Array.isArray(items)) return [];
  return items
    .map((item) => {
      if (typeof item === "string") return item.trim();
      if (isPlainObject(item) && safeString(item.message).trim()) return safeString(item.message).trim();
      return null;
    })
    .filter(Boolean);
}

function normalizeRefToken(token) {
  return safeString(token).trim().replace(/^["'`]+|["'`]+$/g, "").replace(/^res:\/\//i, "").replace(/^\/+/, "").replace(/\\/g, "/");
}

function extractResourceRefHints(request) {
  const text = safeString(request);
  const hints = [];
  const seen = new Set();
  // Generic file/resource mention extraction (works for "in scene X", "inside X", "for scene X", etc.).
  const regex = /(?:\b(?:in|inside|for|from|on|at)\s+(?:scene|file|resource|script)\s+)?(?:(?:res:\/\/)?[A-Za-z0-9_./-]+\.(?:tscn|gd|tres|res|png|jpg|jpeg|webp|shader|gdshader))/gi;
  for (const match of text.matchAll(regex)) {
    const raw = safeString(match[0]);
    const pathMatch = raw.match(/((?:res:\/\/)?[A-Za-z0-9_./-]+\.(?:tscn|gd|tres|res|png|jpg|jpeg|webp|shader|gdshader))/i);
    const ref = normalizeRefToken(pathMatch?.[1] ?? "");
    if (!ref || seen.has(ref.toLowerCase())) continue;
    seen.add(ref.toLowerCase());
    const ext = ref.includes(".") ? ref.slice(ref.lastIndexOf(".")).toLowerCase() : null;
    hints.push({ ref, ext, source: "user_phrase" });
  }
  // Bare semantic refs (extensionless), e.g. "in NewScene, add node..."
  // Keep generic to scene/file/resource/script mention patterns.
  const stopwords = new Set(["scene", "file", "resource", "script", "root", "node", "new", "add", "create", "attach", "set"]);
  const pushBareHint = (raw, kind = null, source = "bare_phrase") => {
    const ref = normalizeRefToken(raw);
    if (!ref) return;
    if (ref.includes("/") || ref.includes(".")) return;
    if (stopwords.has(ref.toLowerCase())) return;
    const key = `${kind || "any"}:${ref.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    hints.push({ ref, ext: null, kind, source });
  };
  const bareByKeyword = /\b(?:scene|file|resource|script)\s+([A-Za-z0-9_-]{2,})\b/gi;
  for (const match of text.matchAll(bareByKeyword)) {
    const kind = safeString(match[0]).toLowerCase().includes("scene")
      ? "scene"
      : safeString(match[0]).toLowerCase().includes("script")
        ? "script"
        : safeString(match[0]).toLowerCase().includes("resource")
          ? "resource"
          : "file";
    pushBareHint(match[1], kind, "keyword_phrase");
  }
  const bareByPreposition = /\b(?:in|inside|from|for|on|at)\s+([A-Za-z0-9_-]{2,})(?!\.)(?=[\s,.;:!?]|$)/gi;
  for (const match of text.matchAll(bareByPreposition)) {
    pushBareHint(match[1], null, "preposition_phrase");
  }
  const preferredSceneRef = hints.find((h) => h.ext === ".tscn")?.ref ?? null;
  return { hints, preferredSceneRef };
}

function inferExpectedExtFromArgKey(argKey) {
  const k = safeString(argKey).toLowerCase().replace(/[^a-z0-9_]/g, "");
  if (k.includes("scenepath")) return ".tscn";
  if (k.includes("scriptpath")) return ".gd";
  if (k.includes("resourcepath")) return ".tres";
  if (k.includes("texturepath")) return ".png";
  return null;
}

function valueAt(obj, key) {
  if (!isPlainObject(obj)) return null;
  return obj[key];
}

function hasNonEmpty(args, key) {
  const v = valueAt(args, key);
  return v != null && safeString(v).trim() !== "";
}

function mapCreationSynthesisReasonToMissingField(reason, fallbackSlot) {
  const r = safeString(reason).trim().toLowerCase();
  if (r === "missing_requested_name") return "requestedName";
  if (r === "missing_target_folder" || r === "missing_folder") return "targetFolder";
  if (r === "resourcekind_required_for_generic_file_path" || r === "cannot_infer_extension") return "resourceKind";
  return fallbackSlot || "creationIntent";
}

function compactSemanticSummaryForVerify(sessionContext) {
  const wf = isPlainObject(sessionContext?.workflowState) ? sessionContext.workflowState : {};
  const semanticState = isPlainObject(wf?.semanticState) ? wf.semanticState : {};
  const semanticIntent = isPlainObject(wf?.semanticIntent) ? wf.semanticIntent : {};
  const generatedPreview =
    safeString(
      semanticState?.generatedContent?.content ||
      semanticState?.generatedCode ||
      ""
    ).slice(0, 160);
  return {
    goal: safeString(semanticState.goal || semanticIntent.goalText).trim() || null,
    artifactIntent: safeString(semanticState.artifactIntent || wf?.artifactOperation?.mode).trim() || null,
    creationIntent: isPlainObject(semanticState.creationIntent)
      ? semanticState.creationIntent
      : (isPlainObject(semanticIntent.creationIntent) ? semanticIntent.creationIntent : {}),
    targetRefs: isPlainObject(semanticState.targetRefs)
      ? semanticState.targetRefs
      : (isPlainObject(semanticIntent.refs) ? semanticIntent.refs : {}),
    contentIntent: safeString(semanticState.contentIntent || semanticIntent.contentIntent).trim() || null,
    codeIntent: safeString(semanticIntent.codeIntent).trim() || null,
    pendingSemanticGaps: Array.isArray(semanticState.pendingSemanticGaps) ? semanticState.pendingSemanticGaps : [],
    hasGeneratedContent: Boolean(safeString(semanticState?.generatedContent?.content).trim()),
    hasGeneratedCode: Boolean(safeString(semanticState?.generatedCode).trim()),
    hasCompiledPayload: isPlainObject(semanticState?.compiledPayload) && Object.keys(semanticState.compiledPayload).length > 0,
    generatedPreview,
  };
}

export class ToolPlanner {
  constructor({ toolInventory, modelClient, promptPath = null, maxTools = 6, candidateLadder = null, debug = false } = {}) {
    this._toolInventory = toolInventory ?? null;
    this._modelClient = modelClient ?? null;
    this._debug =
      Boolean(debug) ||
      Boolean(modelClient?._debug) ||
      safeString(process.env.DEBUG_GENERIC_MCP_VERIFY).trim().toLowerCase() === "true";
    this._maxTools = clampToolCalls(maxTools, 1, 6);
    this._candidateLadder = Array.isArray(candidateLadder) && candidateLadder.length > 0
      ? candidateLadder
      : [12, 28, "full"];
    this._promptPath =
      promptPath ??
      path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        "prompts",
        "tool_planner.md"
      );
    this._promptTemplateCache = null;
  }

  async plan({ userRequest, sessionContext = null } = {}) {
    const request = safeString(userRequest).trim();
    if (!request) {
      return this._unsupported("userRequest is required.");
    }

    const inventory = await this._resolveInventory();
    if (!inventory.ok) {
      return this._unsupported(`Tool inventory unavailable: ${inventory.error}`);
    }
    const tools = inventory.inventory?.tools ?? [];
    const plannerCatalog = inventory.plannerCatalog ?? [];
    if (!Array.isArray(tools) || tools.length === 0) {
      return this._unsupported("No tools available in live inventory.");
    }
    if (!Array.isArray(plannerCatalog) || plannerCatalog.length === 0) {
      return this._unsupported("Planner catalog unavailable from live inventory.");
    }

    const sessionCtx = isPlainObject(sessionContext) ? sessionContext : {};
    const attemptCatalogs = this._buildCandidateAttempts({
      plannerCatalog,
      userRequest: request,
      sessionContext: sessionCtx,
    });
    let lastError = null;
    for (let i = 0; i < attemptCatalogs.length; i += 1) {
      const cat = attemptCatalogs[i];
      const promptContext = await this.getPromptContext({
        userRequest: request,
        sessionContext: sessionCtx,
        plannerCatalog: cat,
      });
      const semanticSummary = compactSemanticSummaryForVerify(promptContext.sessionContext);
      if (this._debug) {
        console.log("[VERIFY][planner-input-summary]", {
          userRequest: request,
          hasContentIntent: Boolean(safeString(semanticSummary.contentIntent).trim()),
          hasCodeIntent: Boolean(safeString(semanticSummary.codeIntent).trim()),
          hasGeneratedContent: Boolean(semanticSummary.hasGeneratedContent),
          hasGeneratedCode: Boolean(semanticSummary.hasGeneratedCode),
          hasCompiledPayload: Boolean(semanticSummary.hasCompiledPayload),
          generatedPreview: safeString(semanticSummary.generatedPreview).slice(0, 160),
          semanticStateSummary: semanticSummary,
          candidateTools: cat.map((x) => safeString(x?.name).trim()).filter(Boolean).slice(0, 30),
        });
      }
      const modelOutput = await this._runModel(promptContext.prompt);
      if (!modelOutput.ok) {
        lastError = modelOutput.error ?? "Planner model call failed.";
        continue;
      }
      if (this._debug) {
        console.log("[VERIFY][planner-raw-output]", modelOutput.rawResponse ?? modelOutput.rawText ?? modelOutput.parsed ?? null);
      }
      const validated = this.validatePlan(modelOutput.parsed, tools, {
        sessionContext: promptContext.sessionContext,
      });
      if (!validated.ok) {
        lastError = validated.error ?? "Planner output validation failed.";
        continue;
      }
      const enriched = this._enrichPlanWithExtractedRefs(validated.plan, tools, request);
      const cleaned = this._stripSessionInjectedArgsFromPlan(enriched, tools);
      if (this._debug) {
        console.log("[VERIFY][planner-final-plan]", {
          status: safeString(cleaned?.status).trim() || null,
          tools: Array.isArray(cleaned?.tools)
            ? cleaned.tools.map((t) => ({ name: safeString(t?.name).trim() || null, args: isPlainObject(t?.args) ? t.args : {} }))
            : [],
          step: isPlainObject(cleaned?.step)
            ? {
              tool: safeString(cleaned.step.tool).trim() || null,
              args: isPlainObject(cleaned.step.args) ? cleaned.step.args : {},
              reason: safeString(cleaned.step.reason).trim() || null,
            }
            : null,
          missingArgs: Array.isArray(cleaned?.missingArgs) ? cleaned.missingArgs : [],
          ambiguities: Array.isArray(cleaned?.ambiguities) ? cleaned.ambiguities : [],
          reason: safeString(cleaned?.reason).trim() || null,
        });
      }
      
      const isFinalAttempt = i === attemptCatalogs.length - 1;
      const shouldEscalate = !isFinalAttempt && this._shouldEscalateAttempt(cleaned);
      if (shouldEscalate) continue;
      // console.log("[ToolPlanner] ", cleaned);
      return cleaned;
    }
    return this._unsupported(lastError || "Planner could not produce a valid plan.");
  }

  async getPromptContext({ userRequest, sessionContext = null, plannerCatalog = [] } = {}) {
    const promptTemplate = await this._readPromptTemplate();
    const compactTools = plannerCatalog
      .map(normalizePlannerEntry)
      .filter(Boolean)
      .slice(0, 200);

    const refHints = extractResourceRefHints(userRequest);
    const sessionCtx = isPlainObject(sessionContext) ? { ...sessionContext } : {};
    sessionCtx.resourceRefHints = refHints.hints;
    sessionCtx.preferredSceneRef = refHints.preferredSceneRef;

    const prompt = promptTemplate
      .replace("{MAX_TOOLS}", String(this._maxTools))
      .replace("{USER_REQUEST}", JSON.stringify(safeString(userRequest).trim()))
      .replace("{SESSION_CONTEXT_JSON}", JSON.stringify(sessionCtx, null, 2))
      .replace("{WORKFLOW_STATE_JSON}", JSON.stringify(isPlainObject(sessionCtx.workflowState) ? sessionCtx.workflowState : {}, null, 2))
      .replace("{TOOL_INVENTORY_JSON}", JSON.stringify(compactTools, null, 2));

    return {
      prompt,
      toolCount: compactTools.length,
      sessionContext: sessionCtx,
    };
  }

  _enrichPlanWithExtractedRefs(plan, tools, request) {
    const base = isPlainObject(plan) ? plan : this._unsupported("Invalid plan object.");
    if (!["ready", "missing_args", "next_step"].includes(base.status)) return base;
    const toolsByName = new Map((Array.isArray(tools) ? tools : []).map((t) => [safeString(t?.name).trim(), t]));
    const refHints = extractResourceRefHints(request);
    if (this._debug && refHints.hints.length > 0) {
      console.error("[generic-mcp][planner] extracted file refs", refHints.hints);
    }
    if (!Array.isArray(refHints.hints) || refHints.hints.length === 0) return base;

    const targetTools =
      base.status === "next_step"
        ? [{ name: safeString(base.step?.tool).trim(), args: isPlainObject(base.step?.args) ? base.step.args : {} }]
        : (Array.isArray(base.tools) ? base.tools : []);
    const patchedTools = targetTools.map((entry) => {
      const name = safeString(entry?.name).trim();
      const args = isPlainObject(entry?.args) ? { ...entry.args } : {};
      const tool = toolsByName.get(name);
      const schema = isPlainObject(tool?.inputSchema) ? tool.inputSchema : {};
      const roleInfo = classifyToolArgs({ toolName: name, inputSchema: schema, args });
      const required = roleInfo.required;
      for (const key of required) {
        const current = safeString(args[key]).trim();
        if (current) continue;
        const role = safeString(roleInfo.rolesByArg?.[key]?.role).trim();
        // Only semantic refs may be patched from extracted user ref hints.
        if (role !== "semantic_ref") continue;
        const expectedExt = inferExpectedExtFromArgKey(key);
        const semanticSlot = semanticSlotForArg(key);
        const slotKind = safeString(semanticSlot).toLowerCase().includes("scene")
          ? "scene"
          : safeString(semanticSlot).toLowerCase().includes("script")
            ? "script"
            : safeString(semanticSlot).toLowerCase().includes("resource")
              ? "resource"
              : safeString(semanticSlot).toLowerCase().includes("file")
                ? "file"
                : null;
        // If we cannot infer semantic kind/extension for this arg, do not apply
        // arbitrary bare hints. This avoids poisoning non-ref/session args.
        if (!expectedExt && !slotKind) continue;
        const match = refHints.hints.find((h) => (expectedExt && h.ext === expectedExt)) ??
          refHints.hints.find((h) => !h.ext && slotKind && (!h.kind || h.kind === slotKind)) ??
          null;
        if (!match?.ref) continue;
        if (semanticSlot && semanticSlot !== key) {
          if (!safeString(args[semanticSlot]).trim()) args[semanticSlot] = match.ref;
        } else {
          args[key] = match.ref;
        }
      }
      return { name, args };
    });
    if (base.status === "next_step") {
      const step = patchedTools[0] ?? { name: safeString(base.step?.tool).trim(), args: {} };
      return { ...base, step: { ...(isPlainObject(base.step) ? base.step : {}), tool: step.name, args: step.args } };
    }
    return { ...base, tools: patchedTools };
  }

  validatePlan(parsedPlan, tools, { sessionContext = null } = {}) {
    const parsed = isPlainObject(parsedPlan) ? parsedPlan : null;
    if (!parsed) return { ok: false, error: "Planner output must be an object." };

    const status = safeString(parsed.status).trim();
    const allowed = new Set(["ready", "next_step", "done", "needs_input", "missing_args", "ambiguous", "unsupported"]);
    if (!allowed.has(status)) return { ok: false, error: `Invalid planner status: ${status || "<empty>"}` };

    const knownTools = new Set(
      tools.map((t) => safeString(t?.name).trim()).filter(Boolean)
    );

    const rawTools = Array.isArray(parsed.tools) ? parsed.tools : [];
    if (rawTools.length > this._maxTools) {
      return { ok: false, error: `Planner selected too many tools (${rawTools.length} > ${this._maxTools}).` };
    }

    const normalizedTools = rawTools.map((t) => {
      const name = safeString(t?.name).trim();
      const args = isPlainObject(t?.args) ? t.args : {};
      return { name, args };
    });
    for (const t of normalizedTools) {
      if (!t.name) return { ok: false, error: "Planner tools[] entries require name." };
      if (!knownTools.has(t.name)) {
        return { ok: false, error: `Planner selected unknown tool: ${t.name}` };
      }
    }

    const missingArgs = normalizeMissingArgs(parsed.missingArgs);
    const ambiguities = normalizeAmbiguities(parsed.ambiguities);
    const reason = safeString(parsed.reason).trim() || null;

    const stepTool = safeString(parsed?.step?.tool || parsed?.step?.name).trim();
    const stepArgs = isPlainObject(parsed?.step?.args) ? parsed.step.args : {};

    // State-shape guardrails for stable downstream consumers.
    if (status === "ready" && normalizedTools.length < 1) {
      return { ok: false, error: "ready status requires at least one tool." };
    }
    if (status === "next_step" && !stepTool) {
      return { ok: false, error: "next_step status requires step.tool." };
    }
    if (status === "next_step" && !knownTools.has(stepTool)) {
      return { ok: false, error: `Planner selected unknown step tool: ${stepTool}` };
    }
    if (status === "missing_args" && missingArgs.length < 1) {
      return { ok: false, error: "missing_args status requires non-empty missingArgs." };
    }
    if (status === "ambiguous" && ambiguities.length < 1) {
      return { ok: false, error: "ambiguous status requires non-empty ambiguities." };
    }
    if (status === "unsupported" && !reason) {
      return { ok: false, error: "unsupported status requires reason." };
    }

    const plan = {
      status,
      tools: status === "ready" || status === "missing_args" ? normalizedTools : [],
      step: status === "next_step" ? { tool: stepTool, args: stepArgs, reason: safeString(parsed?.step?.reason).trim() || null } : null,
      missingArgs: status === "missing_args" || status === "needs_input" ? missingArgs : [],
      ambiguities: status === "ambiguous" || status === "needs_input" ? ambiguities : [],
      reason: reason,
    };
    if (status === "ready" || status === "missing_args" || status === "next_step") {
      return { ok: true, plan: this._reconcilePlannerMissingArgs(plan, tools, sessionContext) };
    }
    return { ok: true, plan };
  }

  _hasSessionProjectPath(sessionContext) {
    const sc = isPlainObject(sessionContext) ? sessionContext : {};
    const candidates = [
      sc.connectedProjectPath,
      sc.projectPath,
      sc.projectRoot,
      sc?.sessionStatus?.connectedProjectPath,
      sc?.sessionStatus?.projectPath,
      sc?.sessionStatus?.projectRoot,
      sc?.sessionStatus?.desiredProjectRoot,
      sc?.status?.connectedProjectPath,
      sc?.status?.projectPath,
      sc?.status?.projectRoot,
      sc?.status?.desiredProjectRoot,
      sc?.session?.connectedProjectPath,
      sc?.session?.projectPath,
      sc?.session?.projectRoot,
    ];
    return candidates.some((value) => Boolean(safeString(value).trim()));
  }

  _shouldEscalateAttempt(plan) {
    const status = safeString(plan?.status).trim();
    if (status === "unsupported") return true;
    if (status === "ready" && (!Array.isArray(plan?.tools) || plan.tools.length < 1)) return true;
    return false;
  }

  _buildCandidateAttempts({ plannerCatalog, userRequest, sessionContext }) {
    const full = Array.isArray(plannerCatalog) ? [...plannerCatalog] : [];
    if (full.length <= 1) return [full];
    const attempts = [];
    const seen = new Set();
    for (const rung of this._candidateLadder) {
      let subset;
      if (rung === "full") {
        subset = full;
      } else {
        subset = narrowPlannerCatalog({
          plannerCatalog: full,
          userRequest,
          sessionContext,
          limit: Number(rung) || full.length,
        });
      }
      const key = JSON.stringify(subset.map((x) => x?.name ?? ""));
      if (seen.has(key)) continue;
      seen.add(key);
      attempts.push(subset);
    }
    const fullKey = JSON.stringify(full.map((x) => x?.name ?? ""));
    if (!seen.has(fullKey)) attempts.push(full);
    return attempts.filter((x) => Array.isArray(x) && x.length > 0);
  }

  _reconcilePlannerMissingArgs(plan, tools, sessionContext) {
    const p = isPlainObject(plan) ? plan : {};
    const entries =
      p.status === "next_step"
        ? [{ name: safeString(p.step?.tool).trim(), args: isPlainObject(p.step?.args) ? p.step.args : {} }]
        : (Array.isArray(p.tools) ? p.tools : []);
    if (entries.length < 1) return p;
    const toolsByName = new Map((Array.isArray(tools) ? tools : []).map((t) => [safeString(t?.name).trim(), t]));
    const hasSessionPath = this._hasSessionProjectPath(sessionContext);
    const hintList = Array.isArray(sessionContext?.resourceRefHints) ? sessionContext.resourceRefHints : [];
    const missing = new Set();

    for (const item of entries) {
      const toolName = safeString(item?.name).trim();
      const args = isPlainObject(item?.args) ? item.args : {};
      const tool = toolsByName.get(toolName);
      const schema = isPlainObject(tool?.inputSchema) ? tool.inputSchema : {};
      const roleInfo = classifyToolArgs({ toolName, inputSchema: schema, args });
      for (const key of roleInfo.required) {
        const roleMeta = roleInfo.rolesByArg[key];
        const role = safeString(roleMeta?.role).trim();
        const slot = safeString(roleMeta?.semanticSlot).trim() || key;
        const candidateKeys = semanticArgCandidates(key, slot);
        let hasValue = candidateKeys.some((k) => hasNonEmpty(args, k));

        if (role === "session_injected") {
          if (!hasSessionPath) missing.add(slot);
          continue;
        }
        if (role === "semantic_ref") {
          if (!hasValue && hintList.length > 0) {
            const slotKind = safeString(slot).toLowerCase().includes("scene")
              ? "scene"
              : safeString(slot).toLowerCase().includes("script")
                ? "script"
                : safeString(slot).toLowerCase().includes("resource")
                  ? "resource"
                  : safeString(slot).toLowerCase().includes("file")
                    ? "file"
                    : null;
            const hint = slotKind
              ? (hintList.find((h) => !h?.ext && (!h?.kind || h.kind === slotKind)) ?? null)
              : null;
            if (hint?.ref && slotKind) {
              args[slot] = hint.ref;
              hasValue = true;
            }
          }
          if (!hasValue) missing.add(slot);
          continue;
        }
        if (role === "creation_intent_derived") {
          if (hasValue) continue;
          const syn = synthesizeMissingCreationPath(key, args);
          if (!syn?.ok) {
            missing.add(mapCreationSynthesisReasonToMissingField(syn?.reason, slot));
          }
          continue;
        }
        if (role === "direct_user_value") {
          if (!hasValue) missing.add(slot);
        }
      }
    }

    if (missing.size > 0) {
      return this._stripSessionInjectedArgsFromPlan({
        ...p,
        status: "missing_args",
        missingArgs: [...missing],
        ambiguities: [],
      }, tools);
    }
    return this._stripSessionInjectedArgsFromPlan({
      ...p,
      status: p.status === "next_step" ? "next_step" : "ready",
      missingArgs: [],
    }, tools);
  }

  _stripSessionInjectedArgsFromPlan(plan, tools) {
    const p = isPlainObject(plan) ? plan : {};
    if (!["ready", "missing_args", "next_step"].includes(safeString(p.status).trim())) return p;
    const toolsByName = new Map((Array.isArray(tools) ? tools : []).map((t) => [safeString(t?.name).trim(), t]));
    const entries =
      p.status === "next_step"
        ? [{ name: safeString(p.step?.tool).trim(), args: isPlainObject(p.step?.args) ? p.step.args : {} }]
        : (Array.isArray(p.tools) ? p.tools : []);
    const patchedTools = entries.map((entry) => {
      const name = safeString(entry?.name).trim();
      const args = isPlainObject(entry?.args) ? { ...entry.args } : {};
      const tool = toolsByName.get(name);
      const schema = isPlainObject(tool?.inputSchema) ? tool.inputSchema : {};
      const roleInfo = classifyToolArgs({ toolName: name, inputSchema: schema, args });
      for (const [key, meta] of Object.entries(roleInfo.rolesByArg ?? {})) {
        if (safeString(meta?.role).trim() !== "session_injected") continue;
        if (Object.prototype.hasOwnProperty.call(args, key)) delete args[key];
      }
      return { name, args };
    });
    if (p.status === "next_step") {
      const step = patchedTools[0] ?? { name: safeString(p.step?.tool).trim(), args: {} };
      return { ...p, step: { ...(isPlainObject(p.step) ? p.step : {}), tool: step.name, args: step.args } };
    }
    return { ...p, tools: patchedTools };
  }

  async _resolveInventory() {
    if (!this._toolInventory) {
      return { ok: false, error: "ToolPlanner requires toolInventory." };
    }
    if (typeof this._toolInventory.load !== "function" || typeof this._toolInventory.getInventory !== "function") {
      return { ok: false, error: "toolInventory must expose load() and getInventory()." };
    }
    const loaded = await this._toolInventory.load();
    if (!loaded?.ok) {
      return { ok: false, error: safeString(loaded?.error || "tool inventory load failed") };
    }
    const inventory = this._toolInventory.getInventory();
    const plannerCatalog =
      typeof this._toolInventory.getPlannerCatalog === "function"
        ? this._toolInventory.getPlannerCatalog()
        : [];
    return { ok: true, inventory, plannerCatalog };
  }

  async _runModel(prompt) {
    if (!this._modelClient || typeof this._modelClient.generate !== "function") {
      return { ok: false, error: "Model client is not configured. Expected modelClient.generate({ prompt })." };
    }
    const requestPlannerJson = async (plannerPrompt, phase = "primary") => {
      if (this._debug) {
        console.log("[generic-mcp][tool-planner][model-input]", {
          phase,
          responseFormat: "json_object",
          promptPreview: safeString(plannerPrompt).slice(0, 4000),
        });
      }
      const res = await this._modelClient.generate({
        prompt: plannerPrompt,
        responseFormat: "json_object",
      });
      const text = safeString(res?.text ?? res).trim();
      const parsed = parseJsonObjectLoose(text);
      return { parsed, rawText: text, rawResponse: res };
    };
    try {
      const primary = await requestPlannerJson(prompt, "primary");
      return { ok: true, ...primary };
    } catch (err) {
      if (!isLikelyJsonParseFailure(err)) {
        return { ok: false, error: safeString(err?.message ?? err) || "Planner model call failed." };
      }
      try {
        const repaired = await requestPlannerJson(buildJsonRepairPrompt(prompt), "json_repair");
        return { ok: true, ...repaired };
      } catch (retryErr) {
        return { ok: false, error: safeString(retryErr?.message ?? retryErr) || "Planner model call failed." };
      }
    }
  }

  async _readPromptTemplate() {
    if (this._promptTemplateCache) return this._promptTemplateCache;
    const text = await fs.readFile(this._promptPath, "utf-8");
    this._promptTemplateCache = text;
    return text;
  }

  _unsupported(reason) {
    return {
      status: "unsupported",
      tools: [],
      missingArgs: [],
      ambiguities: [],
      reason: safeString(reason).trim() || "Unsupported request.",
    };
  }
}
