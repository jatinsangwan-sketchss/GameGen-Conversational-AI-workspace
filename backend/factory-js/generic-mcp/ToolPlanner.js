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
 * - argument/path resolution (see ArgumentResolver)
 * - result presentation
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { classifyToolArgs, semanticArgCandidates, semanticSlotForArg } from "./ArgRoleClassifier.js";

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

function compactToolSchemaForPrompt(tool = {}) {
  const t = isPlainObject(tool) ? tool : {};
  const name = safeString(t?.name).trim();
  if (!name) return null;
  const description = safeString(t?.description).trim() || null;
  const inputSchema = isPlainObject(t?.inputSchema) ? t.inputSchema : {};
  const required = Array.isArray(inputSchema?.required)
    ? inputSchema.required.map((k) => safeString(k).trim()).filter(Boolean)
    : [];
  const properties = isPlainObject(inputSchema?.properties) ? inputSchema.properties : {};
  const compactProps = {};
  for (const [key, value] of Object.entries(properties)) {
    if (!isPlainObject(value)) continue;
    const type = safeString(value.type).trim() || null;
    const descriptionText = safeString(value.description).trim() || null;
    const enumVals = Array.isArray(value.enum) ? value.enum.map((x) => safeString(x).trim()).filter(Boolean).slice(0, 30) : undefined;
    compactProps[key] = {
      type,
      description: descriptionText,
      ...(enumVals ? { enum: enumVals } : {}),
    };
  }
  return {
    name,
    description,
    inputSchema: {
      type: safeString(inputSchema?.type).trim() || "object",
      required,
      properties: compactProps,
    },
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

function buildCriticPrompt({ userRequest = "", sessionContext = {}, workflowState = {}, toolInventory = [], candidatePlan = {} } = {}) {
  return [
    "You are the Generic MCP Planner Critic.",
    "Return ONLY one JSON object matching the planner schema.",
    "Validate candidate plan against tool inventory and request.",
    "Hard rules:",
    "- Keep tool names exactly as inventory.",
    "- Do not invent args not in tool schema.",
    "- Ensure all required args are present unless session-injected projectPath.",
    "- Preserve explicit user flags/values when clearly stated (e.g. debug=true).",
    "- If plan is not executable, return missing_args/ambiguous/unsupported with reason.",
    "",
    `User request: ${JSON.stringify(safeString(userRequest).trim())}`,
    `Session context: ${JSON.stringify(sessionContext, null, 2)}`,
    `Workflow state: ${JSON.stringify(workflowState, null, 2)}`,
    `Tool inventory: ${JSON.stringify(toolInventory, null, 2)}`,
    `Candidate plan: ${JSON.stringify(candidatePlan, null, 2)}`,
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

function extractUnsupportedMissingArgClaim(reason = "") {
  const text = safeString(reason).trim();
  if (!text) return null;
  const m1 = text.match(/does not support\s+([A-Za-z0-9_]+)/i);
  if (m1?.[1]) return safeString(m1[1]).trim();
  const m2 = text.match(/cannot\s+set\s+([A-Za-z0-9_]+)/i);
  if (m2?.[1]) return safeString(m2[1]).trim();
  const m3 = text.match(/missing capability.*?([A-Za-z0-9_]+)/i);
  if (m3?.[1]) return safeString(m3[1]).trim();
  return null;
}

function normalizeConfidence(value, fallback = 0.5) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(1, n));
}

function normalizeIntent(intent = "") {
  const raw = safeString(intent).trim().toLowerCase();
  const allowed = new Set(["create", "update", "read", "delete", "connect", "configure", "run", "unknown"]);
  if (allowed.has(raw)) return raw;
  return "unknown";
}

function inferIntentFromToolName(toolName = "") {
  const t = safeString(toolName).trim().toLowerCase();
  if (/\b(get|read|list|show|find|inspect|query|fetch|describe)\b/.test(t)) return "read";
  if (/\b(create|new|add|generate)\b/.test(t)) return "create";
  if (/\b(delete|remove)\b/.test(t)) return "delete";
  if (/\b(connect|link|bind)\b/.test(t)) return "connect";
  if (/\b(export|run|execute|build)\b/.test(t)) return "run";
  if (/\b(set|update|modify|edit|patch|assign)\b/.test(t)) return "update";
  return "unknown";
}

function hasRequiredArgValue(value) {
  if (value == null) return false;
  if (typeof value === "string") return safeString(value).trim() !== "";
  return true;
}

function toolSchemaForName(tools = [], toolName = "") {
  const map = new Map((Array.isArray(tools) ? tools : []).map((t) => [safeString(t?.name).trim(), t]));
  const tool = map.get(safeString(toolName).trim());
  return isPlainObject(tool?.inputSchema) ? tool.inputSchema : {};
}

function buildRequiredArgsCheck({ toolName = "", args = {}, tools = [] } = {}) {
  const schema = toolSchemaForName(tools, toolName);
  const required = Array.isArray(schema?.required) ? schema.required.map((k) => safeString(k).trim()).filter(Boolean) : [];
  const missing = required.filter((k) => !hasRequiredArgValue(args?.[k]));
  return { missing, mismatchedType: [], notes: [] };
}

function buildArgBindings(args = {}) {
  const out = {};
  for (const [key, value] of Object.entries(isPlainObject(args) ? args : {})) {
    out[key] = {
      value,
      source: "planned",
      confidence: 0.8,
    };
  }
  return out;
}

function buildExpectedEffects({ toolName = "", intent = "unknown" } = {}) {
  const effectMap = {
    create: "artifactCreated",
    update: "propertyUpdated",
    read: "readPerformed",
    delete: "artifactDeleted",
    connect: "connectionAdded",
    configure: "propertyUpdated",
    run: "actionExecuted",
    unknown: "unknown",
  };
  return [
    {
      effect: effectMap[intent] || "unknown",
      target: safeString(toolName).trim() || "unknown",
      predicate: `tool:${safeString(toolName).trim()} completed with expected observable effect`,
    },
  ];
}

function buildVerificationPlan({ toolName = "", intent = "unknown" } = {}) {
  if (intent === "read" || intent === "run" || intent === "unknown") {
    return {
      mode: "none",
      readTool: null,
      readArgs: {},
      assertions: [],
      whyNone: "No generic read-back verifier selected at planning stage.",
    };
  }
  return {
    mode: "read_tool",
    readTool: null,
    readArgs: {},
    assertions: [`verify effect of ${safeString(toolName).trim()}`],
    whyNone: null,
  };
}

function normalizeStepV2(step = {}, tools = []) {
  const tool = safeString(step?.tool || step?.name).trim();
  const args = isPlainObject(step?.args) ? step.args : {};
  const intent = normalizeIntent(step?.intent) === "unknown" ? inferIntentFromToolName(tool) : normalizeIntent(step?.intent);
  const requiredArgsCheck = isPlainObject(step?.requiredArgsCheck)
    ? {
        missing: normalizeMissingArgs(step.requiredArgsCheck.missing),
        mismatchedType: normalizeMissingArgs(step.requiredArgsCheck.mismatchedType),
        notes: Array.isArray(step.requiredArgsCheck.notes)
          ? step.requiredArgsCheck.notes.map((x) => safeString(x).trim()).filter(Boolean)
          : [],
      }
    : buildRequiredArgsCheck({ toolName: tool, args, tools });
  const expectedEffects = Array.isArray(step?.expectedEffects) && step.expectedEffects.length > 0
    ? step.expectedEffects
    : buildExpectedEffects({ toolName: tool, intent });
  const verificationPlan = isPlainObject(step?.verificationPlan)
    ? step.verificationPlan
    : buildVerificationPlan({ toolName: tool, intent });
  return {
    id: safeString(step?.id).trim() || null,
    tool,
    intent,
    targetRefs: isPlainObject(step?.targetRefs) ? step.targetRefs : {},
    argBindings: isPlainObject(step?.argBindings) ? step.argBindings : buildArgBindings(args),
    requiredArgsCheck,
    expectedEffects,
    verificationPlan,
    fallbackPolicy: isPlainObject(step?.fallbackPolicy)
      ? step.fallbackPolicy
      : {
          allowTextEditFallback: true,
          constraints: ["targeted_ops_only", "transactional_write", "blocking_validation"],
        },
    args,
  };
}

function normalizeKeyForMatch(value = "") {
  return safeString(value).trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

function extractExplicitBooleanArgsFromRequest(request = "", schema = {}) {
  const out = {};
  const text = safeString(request);
  const properties = isPlainObject(schema?.properties) ? schema.properties : {};
  for (const [key, meta] of Object.entries(properties)) {
    if (safeString(meta?.type).trim().toLowerCase() !== "boolean") continue;
    const normalized = normalizeKeyForMatch(key);
    const keyPattern = normalized.replace(/_/g, "[_\\s-]*");
    const patterns = [
      new RegExp(`\\b${keyPattern}\\b\\s*(?:=|to|as)\\s*(true|false)\\b`, "i"),
      new RegExp(`\\bwith\\s+${keyPattern}\\s*(true|false)\\b`, "i"),
      new RegExp(`\\b${keyPattern}\\s+(true|false)\\b`, "i"),
      new RegExp(`--${keyPattern}\\b`, "i"),
    ];
    const condensed = text.toLowerCase().replace(/[^a-z0-9]+/g, " ");
    for (const p of patterns) {
      const m = condensed.match(p);
      if (m?.[1]) {
        out[key] = m[1].toLowerCase() === "true";
        break;
      }
      if (!m && /--/.test(p.source || "") && new RegExp(`--${keyPattern}\\b`, "i").test(text)) {
        out[key] = true;
        break;
      }
    }
  }
  return out;
}

function findPrimaryRequestVerb(request = "") {
  const text = safeString(request).toLowerCase();
  const verbs = ["export", "create", "add", "set", "connect", "delete", "remove", "update", "modify", "read", "get", "list", "run", "build"];
  let best = null;
  for (const verb of verbs) {
    const idx = text.search(new RegExp(`\\b${verb}\\b`, "i"));
    if (idx < 0) continue;
    if (!best || idx < best.index) best = { verb, index: idx };
  }
  return best?.verb || null;
}

function toolNameSupportsVerb(toolName = "", verb = "") {
  const name = safeString(toolName).toLowerCase();
  const v = safeString(verb).toLowerCase();
  if (!name || !v) return false;
  if (name.includes(v)) return true;
  const alias = {
    get: ["read", "fetch", "list", "show", "describe"],
    read: ["get", "fetch", "list", "show", "describe"],
    update: ["set", "modify", "edit", "patch", "assign"],
    modify: ["set", "update", "edit", "patch", "assign"],
    set: ["update", "modify", "assign", "configure"],
    export: ["build", "package"],
    create: ["new", "add", "generate"],
    add: ["create", "new"],
    delete: ["remove"],
    remove: ["delete"],
    run: ["execute"],
    build: ["export", "package"],
  };
  return (alias[v] || []).some((a) => name.includes(a));
}

function hasSequencingHint(request = "") {
  const text = safeString(request).toLowerCase();
  return /\b(first|before|then|after|next|followed by)\b/.test(text);
}

function scoreToolForRequest(toolName = "", request = "", schema = {}) {
  const nameTokens = tokenize(toolName);
  const reqTokens = tokenize(request);
  const schemaTokens = [
    ...(Array.isArray(schema?.required) ? schema.required : []),
    ...(isPlainObject(schema?.properties) ? Object.keys(schema.properties) : []),
  ].flatMap((x) => tokenize(x));
  const reqSet = new Set(reqTokens);
  let score = 0;
  for (const t of nameTokens) {
    if (reqSet.has(t)) score += 4;
  }
  for (const t of schemaTokens) {
    if (reqSet.has(t)) score += 1;
  }
  return score;
}

function extractPathLikeHintFromRequest(request = "") {
  const text = safeString(request);
  const byOutput = text.match(/\boutput\s+([A-Za-z0-9_./-]+\.[A-Za-z0-9_]+)/i);
  if (byOutput?.[1]) return byOutput[1];
  const anyPath = text.match(/\b(?:res:\/\/)?[A-Za-z0-9_./-]+\.[A-Za-z0-9_]+\b/i);
  return anyPath?.[0] ?? null;
}

function extractPresetHintFromRequest(request = "", schema = {}) {
  const text = safeString(request);
  const byPreset = text.match(/\bpreset\s+([A-Za-z0-9 _-]{2,40})/i);
  const raw = safeString(byPreset?.[1]).trim();
  if (!raw) return null;
  const cleaned = raw.replace(/[.,;:!?`"'()]+$/g, "").trim();
  const properties = isPlainObject(schema?.properties) ? schema.properties : {};
  const presetKey = Object.keys(properties).find((k) => normalizeKeyForMatch(k) === "preset" || normalizeKeyForMatch(k).includes("preset"));
  const enumVals = Array.isArray(properties?.[presetKey]?.enum) ? properties[presetKey].enum.map((x) => safeString(x).trim()).filter(Boolean) : [];
  if (enumVals.length < 1) return cleaned;
  const hit = enumVals.find((v) => v.toLowerCase() === cleaned.toLowerCase()) ??
    enumVals.find((v) => cleaned.toLowerCase().includes(v.toLowerCase()) || v.toLowerCase().includes(cleaned.toLowerCase())) ??
    null;
  return hit || cleaned;
}

function fillArgsFromRequestBySchema({ request = "", schema = {}, args = {} } = {}) {
  const inArgs = isPlainObject(args) ? args : {};
  const out = {};
  const properties = isPlainObject(schema?.properties) ? schema.properties : {};
  for (const key of Object.keys(properties)) {
    if (Object.prototype.hasOwnProperty.call(inArgs, key)) out[key] = inArgs[key];
  }
  const pathHint = extractPathLikeHintFromRequest(request);
  const presetHint = extractPresetHintFromRequest(request, schema);
  for (const key of Object.keys(properties)) {
    if (hasRequiredArgValue(out[key])) continue;
    const nk = normalizeKeyForMatch(key);
    const isSessionProjectPath =
      nk.includes("projectpath") ||
      nk.includes("projectroot") ||
      nk.includes("project_path") ||
      nk.includes("project_root");
    if (nk.includes("preset") && presetHint) {
      out[key] = presetHint;
      continue;
    }
    if (!isSessionProjectPath && (nk.includes("output") || nk.includes("destination") || nk.includes("exportpath")) && pathHint) {
      out[key] = pathHint.replace(/^res:\/\//i, "");
      continue;
    }
    const enumVals = Array.isArray(properties?.[key]?.enum) ? properties[key].enum.map((x) => safeString(x).trim()).filter(Boolean) : [];
    if (enumVals.length > 0) {
      const found = enumVals.find((v) => new RegExp(`\\b${v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(request));
      if (found) out[key] = found;
    }
  }
  return out;
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

function hasNonEmpty(args, key) {
  const v = valueAtFlexible(args, key);
  return v != null && safeString(v).trim() !== "";
}

function valueAtFlexible(args, key) {
  if (!isPlainObject(args)) return null;
  if (Object.prototype.hasOwnProperty.call(args, key)) return args[key];
  const wanted = normalizeKeyForMatch(key);
  if (!wanted) return null;
  for (const [k, v] of Object.entries(args)) {
    if (normalizeKeyForMatch(k) === wanted) return v;
  }
  return null;
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

function tokenize(input) {
  return safeString(input)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

function asSet(items) {
  return new Set(Array.isArray(items) ? items : []);
}

function overlapScore(aSet, bSet) {
  let hits = 0;
  for (const t of aSet) {
    if (bSet.has(t)) hits += 1;
  }
  return hits;
}

function hintTokensFromContext(sessionContext) {
  const hints = Array.isArray(sessionContext?.resourceRefHints)
    ? sessionContext.resourceRefHints
    : [];
  const out = [];
  for (const h of hints) {
    out.push(...tokenize(h?.ref));
    out.push(...tokenize(h?.kind));
  }
  return out;
}

function scoreEntry(entry, requestTokens, hintTokenSet) {
  const nameTokens = asSet(tokenize(entry?.name));
  const summaryTokens = asSet(tokenize(entry?.summary));
  const tagTokens = asSet((Array.isArray(entry?.tags) ? entry.tags : []).flatMap((x) => tokenize(x)));
  const slotTokens = asSet((Array.isArray(entry?.requiredSlots) ? entry.requiredSlots : []).flatMap((x) => tokenize(x)));
  const verbTokens = asSet(tokenize(entry?.verb));
  const categoryTokens = asSet(tokenize(entry?.category));

  let score = 0;
  score += overlapScore(nameTokens, requestTokens) * 4;
  score += overlapScore(tagTokens, requestTokens) * 3;
  score += overlapScore(summaryTokens, requestTokens) * 2;
  score += overlapScore(slotTokens, requestTokens) * 2;
  score += overlapScore(verbTokens, requestTokens) * 2;
  score += overlapScore(categoryTokens, requestTokens) * 2;
  score += overlapScore(nameTokens, hintTokenSet) * 2;
  score += overlapScore(tagTokens, hintTokenSet);

  const requiredSlots = Array.isArray(entry?.requiredSlots) ? entry.requiredSlots : [];
  for (const slot of requiredSlots) {
    const slotSet = asSet(tokenize(slot));
    if (overlapScore(slotSet, requestTokens) > 0 || overlapScore(slotSet, hintTokenSet) > 0) {
      score += 1;
    }
  }

  return score;
}

function narrowPlannerCatalog({ plannerCatalog = [], userRequest = "", sessionContext = null, limit = 12 } = {}) {
  const requestTokenSet = asSet(tokenize(userRequest));
  const hintTokenSet = asSet(hintTokensFromContext(sessionContext));
  const ranked = (Array.isArray(plannerCatalog) ? plannerCatalog : [])
    .map((entry, index) => ({
      entry,
      index,
      score: scoreEntry(entry, requestTokenSet, hintTokenSet),
    }))
    .sort((a, b) => (b.score - a.score) || (a.index - b.index));
  const n = Math.max(1, Math.min(Number(limit) || 1, ranked.length || 1));
  return ranked.slice(0, n).map((x) => x.entry);
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
        tools,
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
        userRequest: request,
      });
      if (!validated.ok) {
        lastError = validated.error ?? "Planner output validation failed.";
        continue;
      }
      const enriched = this._enrichPlanWithExtractedRefs(validated.plan, tools, request);
      const cleaned = this._stripSessionInjectedArgsFromPlan(enriched, tools);
      const critiqued = await this._runCriticPass({
        candidatePlan: cleaned,
        userRequest: request,
        sessionContext: promptContext.sessionContext,
        workflowState: isPlainObject(promptContext.sessionContext?.workflowState) ? promptContext.sessionContext.workflowState : {},
        plannerCatalog: cat,
        promptToolInventory: promptContext.promptToolInventory,
        tools,
      });
      if (!critiqued.ok) {
        lastError = critiqued.error || "Planner critic rejected candidate.";
        continue;
      }
      const postCriticPlan = this._guardAgainstCriticRegression({
        candidatePlan: cleaned,
        critiquedPlan: critiqued.plan,
        tools,
        sessionContext: promptContext.sessionContext,
      });
      if (this._debug) {
        console.log("[VERIFY][planner-final-plan]", {
          status: safeString(postCriticPlan?.status).trim() || null,
          tools: Array.isArray(postCriticPlan?.tools)
            ? postCriticPlan.tools.map((t) => ({ name: safeString(t?.name).trim() || null, args: isPlainObject(t?.args) ? t.args : {} }))
            : [],
          step: isPlainObject(postCriticPlan?.step)
            ? {
              tool: safeString(postCriticPlan.step.tool).trim() || null,
              args: isPlainObject(postCriticPlan.step.args) ? postCriticPlan.step.args : {},
              reason: safeString(postCriticPlan.step.reason).trim() || null,
            }
            : null,
          missingArgs: Array.isArray(postCriticPlan?.missingArgs) ? postCriticPlan.missingArgs : [],
          ambiguities: Array.isArray(postCriticPlan?.ambiguities) ? postCriticPlan.ambiguities : [],
          reason: safeString(postCriticPlan?.reason).trim() || null,
          confidence: normalizeConfidence(postCriticPlan?.confidence, 0.5),
        });
      }
      
      const isFinalAttempt = i === attemptCatalogs.length - 1;
      const shouldEscalate = !isFinalAttempt && this._shouldEscalateAttempt(postCriticPlan);
      if (shouldEscalate) continue;
      return postCriticPlan;
    }
    return this._unsupported(lastError || "Planner could not produce a valid plan.");
  }

  async getPromptContext({ userRequest, sessionContext = null, plannerCatalog = [], tools = [] } = {}) {
    const promptTemplate = await this._readPromptTemplate();
    const compactTools = plannerCatalog.map(normalizePlannerEntry).filter(Boolean).slice(0, 200);
    const candidateNames = new Set(compactTools.map((x) => safeString(x?.name).trim()).filter(Boolean));
    const fullToolInventory = (Array.isArray(tools) ? tools : [])
      .filter((t) => candidateNames.has(safeString(t?.name).trim()))
      .map((t) => compactToolSchemaForPrompt(t))
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
      .replace("{TOOL_INVENTORY_JSON}", JSON.stringify(fullToolInventory, null, 2));

    return {
      prompt,
      toolCount: fullToolInventory.length,
      sessionContext: sessionCtx,
      promptToolInventory: fullToolInventory,
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

  validatePlan(parsedPlan, tools, { sessionContext = null, userRequest = "" } = {}) {
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

    const canonicalTools =
      status === "next_step"
        ? [{ name: stepTool, args: stepArgs }]
        : normalizedTools;
    const plan = {
      status,
      tools: status === "ready" || status === "missing_args" || status === "next_step" ? canonicalTools : [],
      step: status === "next_step" ? { tool: stepTool, args: stepArgs, reason: safeString(parsed?.step?.reason).trim() || null } : null,
      missingArgs: status === "missing_args" || status === "needs_input" ? missingArgs : [],
      ambiguities: status === "ambiguous" || status === "needs_input" ? ambiguities : [],
      reason: reason,
      confidence: normalizeConfidence(parsed?.confidence, status === "ready" || status === "next_step" ? 0.8 : 0.6),
    };
    if (status === "ready" || status === "missing_args" || status === "next_step") {
      const reconciled = this._reconcilePlannerMissingArgs(plan, tools, sessionContext);
      const arbiterPlan = this._arbiterRealignPrimaryStep({
        plan: reconciled,
        tools,
        userRequest,
      });
      const explicitArgCheck = this._enforceExplicitUserArgs({
        plan: arbiterPlan,
        tools,
        userRequest,
      });
      if (!explicitArgCheck.ok) return explicitArgCheck;
      const reconciledAfterArbiter = this._reconcilePlannerMissingArgs(arbiterPlan, tools, sessionContext);
      return { ok: true, plan: this._attachPlannerV2Metadata(reconciledAfterArbiter, tools) };
    }
    if (status === "unsupported") {
      const unsupportedClaimCheck = this._rejectFalseUnsupportedCapability({
        plan,
        tools,
      });
      if (!unsupportedClaimCheck.ok) return unsupportedClaimCheck;
    }
    return { ok: true, plan };
  }

  _rejectFalseUnsupportedCapability({ plan = null, tools = [] } = {}) {
    const p = isPlainObject(plan) ? plan : {};
    const reason = safeString(p.reason).trim();
    const claimedArg = extractUnsupportedMissingArgClaim(reason);
    if (!claimedArg) return { ok: true };
    const claimNorm = normalizeKeyForMatch(claimedArg);
    for (const tool of Array.isArray(tools) ? tools : []) {
      const schema = isPlainObject(tool?.inputSchema) ? tool.inputSchema : {};
      const props = isPlainObject(schema?.properties) ? Object.keys(schema.properties) : [];
      const hasArg = props.some((k) => normalizeKeyForMatch(k) === claimNorm);
      if (hasArg) {
        return {
          ok: false,
          error: `Unsupported capability claim conflicts with live schema: ${safeString(tool?.name).trim()} supports ${claimedArg}.`,
        };
      }
    }
    return { ok: true };
  }

  _attachPlannerV2Metadata(plan, tools) {
    const p = isPlainObject(plan) ? { ...plan } : {};
    const entries = safeString(p.status).trim() === "next_step"
      ? [{ id: "step_1", tool: safeString(p?.step?.tool).trim(), args: isPlainObject(p?.step?.args) ? p.step.args : {} }]
      : (Array.isArray(p.tools) ? p.tools.map((t, i) => ({ id: `step_${i + 1}`, tool: safeString(t?.name).trim(), args: isPlainObject(t?.args) ? t.args : {} })) : []);
    const v2Steps = entries
      .filter((s) => safeString(s.tool).trim())
      .map((s) => normalizeStepV2(s, tools));
    return {
      ...p,
      plannerV2: {
        confidence: normalizeConfidence(p?.confidence, 0.5),
        steps: v2Steps,
      },
    };
  }

  _isExecutablePlannerStep(plan) {
    const p = isPlainObject(plan) ? plan : {};
    const status = safeString(p.status).trim();
    if (!["ready", "next_step"].includes(status)) return false;
    const entries = status === "next_step"
      ? [{ name: safeString(p?.step?.tool).trim(), args: isPlainObject(p?.step?.args) ? p.step.args : {} }]
      : (Array.isArray(p.tools) ? p.tools : []);
    if (entries.length < 1) return false;
    return entries.every((entry) => {
      const name = safeString(entry?.name).trim();
      const args = isPlainObject(entry?.args) ? entry.args : {};
      return Boolean(name) && Object.keys(args).length > 0;
    });
  }

  _guardAgainstCriticRegression({ candidatePlan = null, critiquedPlan = null, tools = [], sessionContext = null } = {}) {
    const candidate = isPlainObject(candidatePlan) ? candidatePlan : {};
    const critiqued = isPlainObject(critiquedPlan) ? critiquedPlan : {};
    const candidateReconciled = this._reconcilePlannerMissingArgs(candidate, tools, sessionContext);
    const critiquedReconciled = this._reconcilePlannerMissingArgs(critiqued, tools, sessionContext);
    const candidateExecutable = this._isExecutablePlannerStep(candidateReconciled);
    const critiquedStatus = safeString(critiquedReconciled?.status).trim();
    const critiquedDegraded = ["missing_args", "needs_input", "ambiguous", "unsupported"].includes(critiquedStatus);
    if (candidateExecutable && critiquedDegraded) {
      if (this._debug) {
        console.log("[VERIFY][planner-critic-regression-guard]", {
          candidateStatus: safeString(candidateReconciled?.status).trim() || null,
          critiquedStatus: critiquedStatus || null,
          critiquedMissingArgs: Array.isArray(critiquedReconciled?.missingArgs) ? critiquedReconciled.missingArgs : [],
          critiquedReason: safeString(critiquedReconciled?.reason).trim() || null,
        });
      }
      return candidateReconciled;
    }
    return critiquedReconciled;
  }

  _enforceExplicitUserArgs({ plan = null, tools = [], userRequest = "" } = {}) {
    const p = isPlainObject(plan) ? plan : {};
    const status = safeString(p.status).trim();
    if (!["ready", "next_step", "missing_args"].includes(status)) return { ok: true };
    const entries = status === "next_step"
      ? [{ name: safeString(p?.step?.tool).trim(), args: isPlainObject(p?.step?.args) ? p.step.args : {} }]
      : (Array.isArray(p.tools) ? p.tools : []);
    for (const entry of entries) {
      const toolName = safeString(entry?.name).trim();
      if (!toolName) continue;
      const args = isPlainObject(entry?.args) ? entry.args : {};
      const schema = toolSchemaForName(tools, toolName);
      const explicitBooleans = extractExplicitBooleanArgsFromRequest(userRequest, schema);
      for (const [key, value] of Object.entries(explicitBooleans)) {
        if (!Object.prototype.hasOwnProperty.call(args, key)) args[key] = value;
        if (typeof args[key] !== "boolean") {
          args[key] = Boolean(args[key]);
        }
        if (args[key] !== value) {
          args[key] = value;
        }
      }
    }
    return { ok: true };
  }

  _arbiterRealignPrimaryStep({ plan = null, tools = [], userRequest = "" } = {}) {
    const p = isPlainObject(plan) ? plan : {};
    const status = safeString(p.status).trim();
    if (status !== "next_step") return p;
    if (hasSequencingHint(userRequest)) return p;
    const primaryVerb = findPrimaryRequestVerb(userRequest);
    if (!primaryVerb) return p;
    const stepTool = safeString(p?.step?.tool).trim();
    if (!stepTool) return p;
    if (toolNameSupportsVerb(stepTool, primaryVerb)) return p;
    const candidates = (Array.isArray(tools) ? tools : [])
      .filter((t) => toolNameSupportsVerb(safeString(t?.name).trim(), primaryVerb))
      .map((t) => ({
        tool: t,
        score: scoreToolForRequest(safeString(t?.name).trim(), userRequest, isPlainObject(t?.inputSchema) ? t.inputSchema : {}),
      }))
      .sort((a, b) => b.score - a.score);
    const best = candidates[0]?.tool ?? null;
    if (!best) return p;
    const bestName = safeString(best?.name).trim();
    const bestSchema = isPlainObject(best?.inputSchema) ? best.inputSchema : {};
    const originalArgs = isPlainObject(p?.step?.args) ? p.step.args : {};
    const remappedArgs = fillArgsFromRequestBySchema({
      request: userRequest,
      schema: bestSchema,
      args: originalArgs,
    });
    const adjusted = {
      ...p,
      step: {
        ...(isPlainObject(p.step) ? p.step : {}),
        tool: bestName,
        args: remappedArgs,
        reason: safeString(p?.step?.reason).trim() || `Arbiter realigned step to primary intent "${primaryVerb}".`,
      },
      tools: [{ name: bestName, args: remappedArgs }],
    };
    if (this._debug) {
      console.log("[VERIFY][planner-arbiter-realign]", {
        primaryVerb,
        originalTool: stepTool,
        selectedTool: bestName,
        remappedArgs,
      });
    }
    return adjusted;
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
        const slotLower = safeString(slot).toLowerCase();
        const slotLooksRef =
          slotLower.includes("scene") ||
          slotLower.includes("script") ||
          slotLower.includes("resource") ||
          slotLower.includes("file") ||
          slotLower.includes("node") ||
          slotLower.includes("artifact") ||
          slotLower.includes("texture") ||
          slotLower.endsWith("ref");
        if (role === "semantic_ref" || slotLooksRef) {
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
        if (!hasValue) missing.add(slot);
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
        // console.log("[generic-mcp][tool-planner][model-input]", {
        //   phase,
        //   responseFormat: "json_object",
        //   promptPreview: safeString(plannerPrompt).slice(0, 4000),
        // });
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

  async _runCriticPass({ candidatePlan = null, userRequest = "", sessionContext = {}, workflowState = {}, plannerCatalog = [], promptToolInventory = [], tools = [] } = {}) {
    const candidate = isPlainObject(candidatePlan) ? candidatePlan : null;
    if (!candidate) return { ok: false, error: "Planner critic requires candidate plan." };
    const prompt = buildCriticPrompt({
      userRequest,
      sessionContext,
      workflowState,
      toolInventory: Array.isArray(promptToolInventory) && promptToolInventory.length > 0
        ? promptToolInventory
        : (Array.isArray(plannerCatalog) ? plannerCatalog : []),
      candidatePlan: candidate,
    });
    const criticRaw = await this._runModel(prompt);
    if (!criticRaw.ok) {
      const fallback = this.validatePlan(candidate, tools, { sessionContext, userRequest });
      if (!fallback.ok) return { ok: false, error: fallback.error || "Planner critic failed and fallback validation rejected candidate." };
      return { ok: true, plan: fallback.plan };
    }
    const validated = this.validatePlan(criticRaw.parsed, tools, { sessionContext, userRequest });
    if (!validated.ok) {
      const fallback = this.validatePlan(candidate, tools, { sessionContext, userRequest });
      if (!fallback.ok) return { ok: false, error: validated.error || "Planner critic produced invalid plan." };
      return { ok: true, plan: fallback.plan };
    }
    return { ok: true, plan: validated.plan };
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
