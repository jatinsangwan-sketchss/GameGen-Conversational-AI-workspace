import { classifyToolArgs, semanticSlotForArg } from "./ArgRoleClassifier.js";

function safeString(value) {
  return value == null ? "" : String(value);
}

function isPlainObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function hasText(value) {
  return safeString(value).trim().length > 0;
}

function normalizeKey(key) {
  return safeString(key).toLowerCase().replace(/[^a-z0-9_]/g, "");
}

function isExecutionPathLikeKey(key) {
  const nk = normalizeKey(key);
  return nk.endsWith("path") || nk.includes("projectpath");
}

function isSemanticSlotName(name) {
  return /ref$/i.test(safeString(name).trim());
}

function getToolSchemaFromInventory(toolName, inventory) {
  const tools = Array.isArray(inventory?.tools) ? inventory.tools : [];
  const tool = tools.find((t) => safeString(t?.name).trim() === safeString(toolName).trim()) ?? null;
  return isPlainObject(tool?.inputSchema) ? tool.inputSchema : {};
}

export function toSemanticField(field) {
  const f = safeString(field).trim();
  if (!f) return null;
  const lower = f.toLowerCase();
  if (["modifications", "operations", "edits", "patches", "changes"].includes(lower)) return "contentIntent";
  if (lower === "codeintent") return "contentIntent";
  const slot = safeString(semanticSlotForArg(f)).trim();
  if (slot && slot !== f) return slot;
  if (/path$/i.test(f)) return f.replace(/path$/i, "Ref");
  return f;
}

export function extractSemanticArgs({ toolName, args, inventory = null } = {}) {
  const input = isPlainObject(args) ? args : {};
  const schema = getToolSchemaFromInventory(toolName, inventory);
  const roleInfo = classifyToolArgs({ toolName, inputSchema: schema, args: input });
  const out = {};

  for (const [key, value] of Object.entries(input)) {
    const role = safeString(roleInfo.rolesByArg?.[key]?.role).trim();
    if (role === "session_injected") continue;
    if (isExecutionPathLikeKey(key)) {
      const slot = toSemanticField(key);
      if (slot && isSemanticSlotName(slot)) {
        if (!Object.prototype.hasOwnProperty.call(out, slot)) out[slot] = value;
      }
      continue;
    }
    out[key] = value;
  }

  for (const [key, meta] of Object.entries(roleInfo.rolesByArg ?? {})) {
    const role = safeString(meta?.role).trim();
    if (role !== "semantic_ref") continue;
    const slot = toSemanticField(key);
    if (!slot || !isSemanticSlotName(slot)) continue;
    if (Object.prototype.hasOwnProperty.call(out, slot)) continue;
    if (!Object.prototype.hasOwnProperty.call(input, key)) continue;
    out[slot] = input[key];
  }

  return out;
}

export function buildRuntimeState({ planningResult = null, resolvedPlan = null, needsInput = null, inventory = null } = {}) {
  const planning = isPlainObject(planningResult) ? planningResult : {};
  const resolved = isPlainObject(resolvedPlan) ? resolvedPlan : {};
  const pending = isPlainObject(needsInput) ? needsInput : {};
  const planTool = planning?.tools?.[0] ?? resolved?.tools?.[0] ?? null;
  const tool = safeString(planTool?.name).trim() || null;
  const semanticArgs = extractSemanticArgs({
    toolName: tool,
    args: isPlainObject(planning?.tools?.[0]?.args) ? planning.tools[0].args : planTool?.args,
    inventory,
  });
  const resolvedArgs = isPlainObject(resolved?.tools?.[0]?.args) ? { ...resolved.tools[0].args } : {};

  return {
    semantic: {
      tool,
      args: semanticArgs,
      status: safeString(planning?.status).trim() || null,
    },
    resolved: {
      tool: safeString(resolved?.tools?.[0]?.name).trim() || tool,
      args: resolvedArgs,
      status: safeString(resolved?.status).trim() || null,
    },
    clarification: {
      status: safeString(pending?.status).trim() || null,
      kind: safeString(pending?.kind).trim() || null,
      field: safeString(pending?.field).trim() || null,
      options: Array.isArray(pending?.options) ? pending.options : [],
      attemptedValue: safeString(pending?.attemptedValue).trim() || null,
    },
  };
}

function normalizeRefToken(token) {
  return safeString(token)
    .trim()
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/^res:\/\//i, "")
    .replace(/^\/+/, "")
    .replace(/\\/g, "/");
}

function pickFirstRegex(text, re) {
  const m = text.match(re);
  return m?.[1] ? m[1].trim() : null;
}

function inferGoalType(text) {
  const t = text.toLowerCase();
  if (/\bcreate|new|generate|scaffold\b/.test(t)) return "create";
  if (/\bmodify|edit|update|change|patch|rewrite\b/.test(t)) return "modify";
  if (/\binspect|analyze|check|look at|review\b/.test(t)) return "inspect";
  if (/\battach|assign|link|use\b/.test(t)) return "attach";
  if (/\blist|get|find|show\b/.test(t)) return "query";
  return "general";
}

function hasCreateVerb(text) {
  return /\b(create|new|generate|scaffold)\b/i.test(safeString(text));
}

function inferCodeIntent(text) {
  const lower = text.toLowerCase();
  const shouldPart = pickFirstRegex(text, /\bshould\s+(.+?)(?:[.!?]|$)/i);
  if (shouldPart) return shouldPart;
  const codePart = pickFirstRegex(text, /\b(?:write|add|implement|create)\s+(?:code|logic)\s+(?:to|for)\s+(.+?)(?:[.!?]|$)/i);
  if (codePart) return codePart;
  if (/\bprint\b/.test(lower)) {
    const payload = pickFirstRegex(text, /\bprint\s+(.+?)(?:[.!?]|$)/i);
    return payload ? `print ${payload}` : "print message";
  }
  if (/\bjump\b/.test(lower) && /\btap|touch|click\b/.test(lower)) {
    return "make player jump on tap input";
  }
  return null;
}

function inferBehaviorIntent(text) {
  const t = text.toLowerCase();
  if (/\bjump\b/.test(t)) return "jump";
  if (/\bmove\b/.test(t)) return "move";
  if (/\bshoot\b/.test(t)) return "shoot";
  if (/\bprint\b/.test(t)) return "print";
  return null;
}

function inferTargetConcept(text) {
  const fromCodeFor = pickFirstRegex(text, /\b(?:write|add|implement|create)\s+(?:code|logic)\s+for\s+([A-Za-z0-9_-]{2,})\b/i);
  if (fromCodeFor) return fromCodeFor;
  const fromAttach =
    pickFirstRegex(text, /\b(?:attach|assign|link)\b.*?\bto\s+(?:the\s+)?`([^`]+)`(?:\s+node)?\b/i) ??
    pickFirstRegex(text, /\b(?:attach|assign|link)\b.*?\bto\s+(?:the\s+)?"([^"]+)"(?:\s+node)?\b/i) ??
    pickFirstRegex(text, /\b(?:attach|assign|link)\b.*?\bto\s+(?:the\s+)?'([^']+)'(?:\s+node)?\b/i) ??
    pickFirstRegex(text, /\b(?:attach|assign|link)\b.*?\bto\s+(?:the\s+)?([A-Za-z0-9_-]{2,})(?:\s+node)?\b/i);
  return fromAttach || null;
}

function parseTypedLiteral(raw) {
  const t = safeString(raw).trim().replace(/^["'`]+|["'`]+$/g, "");
  if (!t) return null;
  const vector = t.match(/^Vector([2-4])\s*\(([^)]*)\)$/i);
  if (vector) {
    const dim = Number(vector[1]);
    const parts = safeString(vector[2]).split(",").map((x) => Number(safeString(x).trim()));
    if (parts.length === dim && parts.every((n) => Number.isFinite(n))) {
      const keys = ["x", "y", "z", "w"].slice(0, dim);
      const out = { type: `Vector${dim}` };
      for (let i = 0; i < keys.length; i += 1) out[keys[i]] = parts[i];
      return out;
    }
  }
  if (/^-?\d+(?:\.\d+)?$/.test(t)) return Number(t);
  if (/^(true|false)$/i.test(t)) return /^true$/i.test(t);
  return t;
}

function decorateFieldWithNode(field, nodeName) {
  const f = safeString(field).trim();
  const n = safeString(nodeName).trim();
  if (!f) return "";
  if (!n) return f;
  if (f.includes(".")) return f;
  return `${n}.${f}`;
}

function extractNodeContext(text) {
  return (
    pickFirstRegex(text, /\bon\s+node\s+`([^`]+)`/i) ??
    pickFirstRegex(text, /\bon\s+node\s+"([^"]+)"/i) ??
    pickFirstRegex(text, /\bon\s+node\s+'([^']+)'/i) ??
    pickFirstRegex(text, /\bon\s+node\s+([A-Za-z0-9_#./-]{2,})\b/i) ??
    pickFirstRegex(text, /\bnode\s+`([^`]+)`/i) ??
    pickFirstRegex(text, /\bnode\s+"([^"]+)"/i) ??
    pickFirstRegex(text, /\bnode\s+'([^']+)'/i) ??
    pickFirstRegex(text, /\bnode\s+([A-Za-z0-9_#./-]{2,})\b/i) ??
    null
  );
}

function inferTargetedEdits(text) {
  const out = [];
  const seen = new Set();
  const push = (edit) => {
    if (!edit || !edit.field) return;
    const key = `${safeString(edit.field).toLowerCase()}::${JSON.stringify(edit.newValue)}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(edit);
  };
  const segments = safeString(text)
    .split(/[.;!?]\s+/)
    .map((s) => safeString(s).trim())
    .filter(Boolean);
  for (const segment of segments) {
    const nodeCtx = extractNodeContext(segment);
    const changeRe = /\b(?:change|update|set)\s+([A-Za-z0-9_./-]{2,})(?:\s+(?:value|property))?\s+(?:to|as)\s+(.+?)(?:\s+from\s+(.+?))?(?=(?:\s+\b(?:change|update|set)\b)|(?:,\s*and\s+[A-Za-z0-9_./-]{2,}\s+to\b)|[.;!?]|$)/gi;
    for (const m of segment.matchAll(changeRe)) {
      push({ kind: "set_value", field: decorateFieldWithNode(safeString(m[1]).trim(), nodeCtx), newValue: parseTypedLiteral(m[2]), oldValue: parseTypedLiteral(m[3]) });
    }
    const fromToRe = /\b([A-Za-z0-9_./-]{2,})\s+from\s+([A-Za-z0-9_.:"'`-]+)\s+to\s+([A-Za-z0-9_.:"'`-]+)/gi;
    for (const m of segment.matchAll(fromToRe)) {
      push({ kind: "set_value", field: decorateFieldWithNode(safeString(m[1]).trim(), nodeCtx), newValue: parseTypedLiteral(m[3]), oldValue: parseTypedLiteral(m[2]) });
    }
    const chainRe = /(?:^|,\s*and\s+|\band\s+)([A-Za-z][A-Za-z0-9_./-]{1,})\s+to\s+(.+?)(?=(?:,\s*and\s+[A-Za-z][A-Za-z0-9_./-]{1,}\s+to\b)|[.;!?]|$)/gi;
    for (const m of segment.matchAll(chainRe)) {
      const field = safeString(m[1]).trim();
      if (!field || /^(node|scene|script|called|named)$/i.test(field)) continue;
      push({ kind: "set_value", field: decorateFieldWithNode(field, nodeCtx), newValue: parseTypedLiteral(m[2]), oldValue: null });
    }
  }
  return out;
}

function extractSemanticRefs(text) {
  const refs = {};
  const createVerb = hasCreateVerb(text);
  const scenePath = pickFirstRegex(text, /\b([A-Za-z0-9_./-]+\.tscn)\b/i);
  const scriptPath = pickFirstRegex(text, /\b([A-Za-z0-9_./-]+\.gd)\b/i);
  const bareScriptByCalled = createVerb ? null : pickFirstRegex(text, /\bscript\s+called\s+([A-Za-z0-9_.-]{2,})\b/i);
  const bareScriptByNamed = createVerb ? null : pickFirstRegex(text, /\bscript\s+named\s+([A-Za-z0-9_.-]{2,})\b/i);
  const bareScene = pickFirstRegex(text, /\bin\s+([A-Za-z0-9_-]{2,})(?:\s|,|\.|$)/i);
  const nodeTarget =
    pickFirstRegex(text, /\b(?:under|inside|within|below)\s+(?:the\s+)?node\s+`([^`]+)`/i) ??
    pickFirstRegex(text, /\b(?:under|inside|within|below)\s+(?:the\s+)?node\s+\"([^\"]+)\"/i) ??
    pickFirstRegex(text, /\b(?:under|inside|within|below)\s+(?:the\s+)?node\s+'([^']+)'/i) ??
    pickFirstRegex(text, /\b(?:under|inside|within|below)\s+(?:the\s+)?node\s+([A-Za-z0-9_-]{2,})\b/i) ??
    pickFirstRegex(text, /\b(?:to|on|at)\s+(?:the\s+)?`([^`]+)`\s+node\b/i) ??
    pickFirstRegex(text, /\b(?:to|on|at)\s+(?:the\s+)?"([^"]+)"\s+node\b/i) ??
    pickFirstRegex(text, /\b(?:to|on|at)\s+(?:the\s+)?'([^']+)'\s+node\b/i) ??
    pickFirstRegex(text, /\b(?:to|on|at)\s+(?:the\s+)?([A-Za-z0-9_-]{2,})\s+node\b/i);
  const rootNode = /\broot node\b/i.test(text) ? "root node" : null;
  const blockedSceneTokens = new Set(["this", "that", "it", "script", "node", "scene"]);
  const isUsableBareScene = bareScene && !blockedSceneTokens.has(safeString(bareScene).trim().toLowerCase());
  if (scenePath) refs.sceneRef = normalizeRefToken(scenePath);
  else if (isUsableBareScene && !/\.(?:gd|tscn|tres|res)$/i.test(bareScene)) refs.sceneRef = bareScene;
  if (scriptPath) refs.scriptRef = normalizeRefToken(scriptPath);
  else if (bareScriptByCalled) refs.scriptRef = normalizeRefToken(bareScriptByCalled);
  else if (bareScriptByNamed) refs.scriptRef = normalizeRefToken(bareScriptByNamed);
  if (nodeTarget) refs.targetNodeRef = safeString(nodeTarget).trim();
  else if (rootNode) refs.targetNodeRef = rootNode;
  return refs;
}

function extractCreationIntent(text) {
  const shouldCaptureName = hasCreateVerb(text);
  const requestedName = shouldCaptureName
    ? (
      pickFirstRegex(text, /\bcalled\s+`([^`]+)`/i) ??
      pickFirstRegex(text, /\bnamed\s+`([^`]+)`/i) ??
      pickFirstRegex(text, /\bcalled\s+"([^"]+)"/i) ??
      pickFirstRegex(text, /\bnamed\s+"([^"]+)"/i) ??
      pickFirstRegex(text, /\bcalled\s+'([^']+)'/i) ??
      pickFirstRegex(text, /\bnamed\s+'([^']+)'/i) ??
      pickFirstRegex(text, /\bcalled\s+([A-Za-z0-9_.-]+)/i) ??
      pickFirstRegex(text, /\bnamed\s+([A-Za-z0-9_.-]+)/i)
    )
    : null;
  const scriptHint = /\bgdscript|script\b/i.test(text) ? "script" : null;
  const sceneHint = /\bscene\b/i.test(text) ? "scene" : null;
  return { requestedName: requestedName || null, resourceKind: scriptHint || sceneHint || null };
}

export function interpretGoalIntent({ userRequest = "", prior = null } = {}) {
  const text = safeString(userRequest).trim();
  const base = prior && typeof prior === "object" ? { ...prior } : {};
  if (!text) return base;
  const refs = extractSemanticRefs(text);
  const creation = extractCreationIntent(text);
  const codeIntent = inferCodeIntent(text);
  const priorCreation = base.creationIntent && typeof base.creationIntent === "object" ? base.creationIntent : {};
  const mergedCreation = { ...priorCreation, ...creation };
  if (!safeString(creation.requestedName).trim() && safeString(priorCreation.requestedName).trim()) mergedCreation.requestedName = priorCreation.requestedName;
  if (!safeString(creation.resourceKind).trim() && safeString(priorCreation.resourceKind).trim()) mergedCreation.resourceKind = priorCreation.resourceKind;
  const contentIntent = (codeIntent ?? safeString(base.contentIntent).trim()) || null;
  const targetConcept = (inferTargetConcept(text) ?? safeString(base.targetConcept).trim()) || null;
  const targetedEdits = inferTargetedEdits(text);
  return {
    ...base,
    goalText: text,
    goalType: inferGoalType(text),
    behaviorIntent: inferBehaviorIntent(text),
    contentIntent,
    codeIntent: contentIntent,
    targetConcept,
    refs: { ...(base.refs ?? {}), ...refs },
    targetedEdits: targetedEdits.length > 0 ? targetedEdits : (Array.isArray(base.targetedEdits) ? base.targetedEdits : []),
    creationIntent: mergedCreation,
  };
}

export function synthesizeCodeArtifact({ semanticIntent = null } = {}) {
  const codeIntent = safeString(semanticIntent?.contentIntent).trim() || safeString(semanticIntent?.codeIntent).trim();
  if (!codeIntent) return null;
  const lower = codeIntent.toLowerCase();
  if (lower.includes("print")) {
    return { kind: "code_snippet", intent: codeIntent, content: 'print("Hello world")' };
  }
  if (lower.includes("jump") && lower.includes("tap")) {
    return {
      kind: "code_snippet",
      intent: codeIntent,
      content: ["func _unhandled_input(event):", "  if event is InputEventScreenTouch and event.pressed:", "    jump()"].join("\n"),
    };
  }
  return { kind: "code_snippet", intent: codeIntent, content: `# TODO: implement ${codeIntent}` };
}

function anyRef(intent) {
  const refs = isPlainObject(intent?.refs) ? intent.refs : {};
  return safeString(refs.scriptRef).trim() || safeString(refs.fileRef).trim() || safeString(refs.resourceRef).trim() || safeString(refs.artifactRef).trim() || null;
}

function hasCreateSignal(text) { return /\b(create|new|generate|scaffold)\b/i.test(text); }
function hasModifySignal(text) { return /\b(modify|edit|update|change|patch|rewrite|write code|add code|implement)\b/i.test(text); }
function hasSceneMutationSignal(text) {
  const t = safeString(text);
  const hasMutationVerb = /\b(add|remove|delete|duplicate|reparent|set)\b/i.test(t);
  const hasMutableTarget = /\b(node|property|scene|child|children|parent)\b/i.test(t);
  return hasMutationVerb && hasMutableTarget;
}
function hasAttachSignal(text) {
  const t = safeString(text);
  if (/\b(attach|assign|link|bind)\b/i.test(t)) return true;
  return /\buse\b[\s\S]{0,80}\b(script|resource|file|artifact)\b[\s\S]{0,80}\b(on|to|under)\b/i.test(t);
}
function looksLikeArtifactPath(ref) {
  const value = safeString(ref).trim();
  return /[\\/]/.test(value) || /\.(gd|tscn|tres|res|png|jpg|jpeg|webp|gdshader|shader)$/i.test(value);
}
function hasCreateArtifactSignal(text) {
  return /\b(create|new|generate|scaffold)\b[\s\S]{0,48}\b(script|scene|file|resource|shader|texture|singleton|autoload)\b/i.test(safeString(text));
}

export function buildArtifactOperationState({ semanticIntent = null } = {}) {
  const intent = isPlainObject(semanticIntent) ? semanticIntent : {};
  const text = safeString(intent.goalText).trim();
  const goalType = safeString(intent?.goalType).trim().toLowerCase();
  const existingTargetRef = anyRef(intent);
  const hasNamedCreationIntent = hasText(intent?.creationIntent?.requestedName);
  const sceneMutationIntent = hasSceneMutationSignal(text);
  const createArtifactSignal = hasCreateArtifactSignal(text);
  const createArtifactIntent = createArtifactSignal || (hasNamedCreationIntent && !sceneMutationIntent);
  const createTargetRefLikelyOutput = Boolean(existingTargetRef) && createArtifactIntent && looksLikeArtifactPath(existingTargetRef);
  const wantsCreate = goalType === "create" || (hasCreateSignal(text) && goalType !== "modify") || (hasNamedCreationIntent && !existingTargetRef && goalType !== "modify" && !sceneMutationIntent);
  const wantsModify = hasModifySignal(text) || hasSceneMutationSignal(text) || hasText(intent?.contentIntent) || hasText(intent?.codeIntent) || hasText(intent?.behaviorIntent);
  const wantsAttach = hasAttachSignal(text) || (hasText(intent?.refs?.targetNodeRef) && hasText(existingTargetRef));
  const createMode = createArtifactIntent && wantsCreate && (!existingTargetRef || createTargetRefLikelyOutput);
  let mode = "general";
  if (createMode && wantsAttach && wantsModify) mode = "create_then_modify_then_attach";
  else if (createMode && wantsAttach) mode = "create_then_attach";
  else if (createMode && wantsModify) mode = "create_then_modify";
  else if (createMode) mode = "create_new";
  else if (existingTargetRef && wantsModify && wantsAttach) mode = "modify_then_attach";
  else if (existingTargetRef && wantsModify) mode = "modify_existing";
  else if (existingTargetRef && wantsAttach) mode = "attach_existing";

  return {
    mode,
    targetArtifactRef: existingTargetRef,
    attachTargetRef: safeString(intent?.refs?.targetNodeRef).trim() || null,
    creationIntent: isPlainObject(intent?.creationIntent) ? { ...intent.creationIntent } : {},
    contentIntent: safeString(intent?.contentIntent).trim() || safeString(intent?.codeIntent).trim() || safeString(intent?.behaviorIntent).trim() || null,
    expectedEffects: { artifactCreated: mode.startsWith("create_"), artifactModified: wantsModify, artifactAttached: wantsAttach },
    observedEffects: { artifactCreated: false, artifactModified: false, artifactAttached: false },
  };
}

function classifyStepAction({ toolName, args }) {
  const t = safeString(toolName).toLowerCase();
  const a = isPlainObject(args) ? args : {};
  const hasRichPayload = ["modifications", "operations", "edits", "patches", "changes"].some((k) => Object.prototype.hasOwnProperty.call(a, k));
  const hasAttachTarget = ["targetNode", "targetNodeRef", "targetRef", "nodeRef", "targetNodePath", "nodePath", "parentPath"].some((k) => hasText(a[k]));
  const hasSceneTarget = hasText(a.scenePath) || hasText(a.sceneRef);
  const hasPropertyPayload = isPlainObject(a.properties) || isPlainObject(a.propertyMap) || isPlainObject(a.props) || hasText(a.properties) || hasText(a.propertyMap) || hasText(a.props);
  const hasArtifactRef = ["artifactRef", "scriptRef", "scriptPath", "fileRef", "filePath", "resourceRef", "resourcePath", "path"].some((k) => hasText(a[k]));
  if (hasRichPayload) return "modify";
  if (/\b(create|new|generate|scaffold)\b/.test(t)) return "create";
  if (/\b(add|remove|delete|duplicate|reparent|set)\b/.test(t) && (hasAttachTarget || hasSceneTarget || hasPropertyPayload)) return "modify";
  if (/\bnode\b/.test(t) && /\b(add|delete|remove|duplicate|set|property)\b/.test(t)) return "modify";
  if (/\b(edit|modify|patch|update|change)\b/.test(t)) return "modify";
  if ((hasAttachTarget && /\b(attach|assign|link|use|set)\b/.test(t)) || (hasAttachTarget && hasArtifactRef)) return "attach";
  return "other";
}

function hasImplementationPayload(args) {
  const a = isPlainObject(args) ? args : {};
  const directKeys = ["content", "body", "source", "code", "snippet", "text", "scriptBody", "fileContent", "sourceCode"];
  if (directKeys.some((k) => hasText(a[k]))) return true;
  const richKeys = ["modifications", "operations", "edits", "patches", "changes"];
  return richKeys.some((k) => Array.isArray(a[k]) ? a[k].length > 0 : false);
}

export function checkOperationDrift({ operationState = null, stepTool = null }) {
  const op = isPlainObject(operationState) ? operationState : null;
  if (!op) return { ok: true, reason: null };
  const action = classifyStepAction({ toolName: stepTool?.name, args: stepTool?.args });
  const mode = safeString(op.mode).trim();
  if (mode === "modify_existing" && action === "create") return { ok: false, reason: "Existing artifact modification intent drifted into create step." };
  if (mode === "attach_existing" && action === "create") return { ok: false, reason: "Attach-existing intent drifted into create step." };
  return { ok: true, reason: null };
}

export function updateObservedEffects({ operationState = null, stepTool = null, executionResult = null, artifactCountBefore = 0, artifactCountAfter = 0 }) {
  const op = isPlainObject(operationState) ? operationState : null;
  if (!op) return null;
  const action = classifyStepAction({ toolName: stepTool?.name, args: stepTool?.args });
  if (!Boolean(executionResult?.ok)) return op;
  const args = isPlainObject(stepTool?.args) ? stepTool.args : {};
  const hasCreatedRefHint = ["scriptPath", "filePath", "resourcePath", "path", "scriptRef", "fileRef", "resourceRef", "artifactRef"].some((k) => hasText(args[k]));
  if (action === "create" && (artifactCountAfter > artifactCountBefore || hasCreatedRefHint)) {
    op.observedEffects.artifactCreated = true;
    if (hasImplementationPayload(args)) op.observedEffects.artifactModified = true;
  }
  if (action === "modify") op.observedEffects.artifactModified = true;
  if (action === "attach") op.observedEffects.artifactAttached = true;
  return op;
}

export function unmetExpectedEffects(operationState) {
  const op = isPlainObject(operationState) ? operationState : {};
  const expected = isPlainObject(op.expectedEffects) ? op.expectedEffects : {};
  const observed = isPlainObject(op.observedEffects) ? op.observedEffects : {};
  const out = [];
  for (const [k, v] of Object.entries(expected)) if (v && !observed[k]) out.push(k);
  return out;
}

export function verifyWorkflowPostconditions({ operationState = null, workflowState = null } = {}) {
  const op = isPlainObject(operationState)
    ? operationState
    : isPlainObject(workflowState?.artifactOperation)
      ? workflowState.artifactOperation
      : null;
  if (!op) return { ok: true, unmet: [], summary: "no_operation_constraints" };
  const unmet = unmetExpectedEffects(op);
  if (unmet.length === 0) return { ok: true, unmet: [], summary: "all_expected_effects_observed" };
  return { ok: false, unmet, summary: `Unmet expected effects: ${unmet.join(", ")}` };
}

export function compactStepVerification({ stepTool = null, executionResult = null } = {}) {
  const tool = safeString(stepTool?.name).trim();
  const ok = Boolean(executionResult?.ok);
  return { tool, ok, verified: ok };
}

function cloneObject(value) {
  return isPlainObject(value) ? { ...value } : {};
}

function normalizeContentIntent(intent = null) {
  if (hasText(intent?.contentIntent)) return safeString(intent.contentIntent).trim();
  if (hasText(intent?.codeIntent)) return safeString(intent.codeIntent).trim();
  if (hasText(intent?.behaviorIntent)) return safeString(intent.behaviorIntent).trim();
  return null;
}

function deriveArtifactIntent({ semanticIntent = null, artifactOperation = null } = {}) {
  const mode = safeString(artifactOperation?.mode).trim();
  if (mode) return mode;
  const goalType = safeString(semanticIntent?.goalType).trim().toLowerCase();
  if (goalType === "create") return "create_new";
  if (goalType === "modify") return "modify_existing";
  if (goalType === "attach") return "attach_existing";
  return "general";
}

export function buildSemanticWorkflowState({ semanticIntent = null, artifactOperation = null, priorSemanticState = null } = {}) {
  const prior = cloneObject(priorSemanticState);
  const refs = cloneObject(semanticIntent?.refs);
  const creation = cloneObject(semanticIntent?.creationIntent);
  const contentIntent = (normalizeContentIntent(semanticIntent) ?? safeString(prior.contentIntent).trim()) || null;
  const targetConcept = hasText(semanticIntent?.targetConcept)
    ? safeString(semanticIntent.targetConcept).trim()
    : safeString(prior?.targetRefs?.targetConcept).trim() || null;

  const targetRefs = { ...cloneObject(prior.targetRefs), ...refs, ...(targetConcept ? { targetConcept } : {}) };
  const requestedName = hasText(creation.requestedName) ? safeString(creation.requestedName).trim() : safeString(prior?.creationIntent?.requestedName).trim() || null;
  const resourceKind = hasText(creation.resourceKind) ? safeString(creation.resourceKind).trim() : safeString(prior?.creationIntent?.resourceKind).trim() || null;

  const creationIntent = { ...cloneObject(prior.creationIntent), ...creation, requestedName, resourceKind };

  const semanticState = {
    goal: safeString(semanticIntent?.goalText).trim() || safeString(prior.goal).trim() || null,
    artifactIntent: deriveArtifactIntent({ semanticIntent, artifactOperation }) || safeString(prior.artifactIntent).trim() || "general",
    targetRefs,
    creationIntent,
    contentIntent,
    targetedEdits: Array.isArray(semanticIntent?.targetedEdits) ? [...semanticIntent.targetedEdits] : (Array.isArray(prior.targetedEdits) ? [...prior.targetedEdits] : []),
    knownFacts: cloneObject(prior.knownFacts),
    completedEffects: cloneObject(prior.completedEffects),
    generatedContent: isPlainObject(prior.generatedContent) ? { ...prior.generatedContent } : null,
    pendingSemanticGaps: Array.isArray(prior.pendingSemanticGaps) ? [...prior.pendingSemanticGaps] : [],
  };
  return refreshPendingSemanticGaps(semanticState, artifactOperation);
}

function setIfEmpty(target, key, value) {
  if (!isPlainObject(target)) return;
  if (Object.prototype.hasOwnProperty.call(target, key) && hasText(target[key])) return;
  if (!hasText(value)) return;
  target[key] = safeString(value).trim();
}

export function seedArgsFromSemanticState(args = null, semanticState = null) {
  const out = isPlainObject(args) ? { ...args } : {};
  const ss = isPlainObject(semanticState) ? semanticState : {};
  const refs = isPlainObject(ss.targetRefs) ? ss.targetRefs : {};
  const creation = isPlainObject(ss.creationIntent) ? ss.creationIntent : {};

  setIfEmpty(out, "sceneRef", refs.sceneRef);
  setIfEmpty(out, "nodeRef", refs.nodeRef);
  setIfEmpty(out, "targetNodeRef", refs.targetNodeRef);
  setIfEmpty(out, "fileRef", refs.fileRef);
  setIfEmpty(out, "resourceRef", refs.resourceRef);
  setIfEmpty(out, "artifactRef", refs.artifactRef);
  setIfEmpty(out, "scriptRef", refs.scriptRef);
  setIfEmpty(out, "targetConcept", refs.targetConcept);
  setIfEmpty(out, "requestedName", creation.requestedName);
  setIfEmpty(out, "resourceKind", creation.resourceKind);
  setIfEmpty(out, "targetFolder", creation.targetFolder);
  setIfEmpty(out, "contentIntent", ss.contentIntent);
  setIfEmpty(out, "codeIntent", ss.contentIntent);
  if (!Array.isArray(out.targetedEdits) && Array.isArray(ss.targetedEdits) && ss.targetedEdits.length > 0) out.targetedEdits = [...ss.targetedEdits];
  return out;
}

function markEffect(completedEffects, key, value) {
  if (!isPlainObject(completedEffects)) return;
  completedEffects[key] = Boolean(value) || Boolean(completedEffects[key]);
}

function normalizeNodeToken(value) {
  return safeString(value).trim().toLowerCase();
}

function toNodeLeaf(value) {
  const raw = safeString(value).trim();
  if (!raw) return "";
  const parts = raw.split("/").map((x) => safeString(x).trim()).filter(Boolean);
  return safeString(parts[parts.length - 1]).trim();
}

function extractObjectMaybe(raw) {
  if (isPlainObject(raw)) return raw;
  const text = safeString(raw).trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function collectAppliedPropertyKeys(args = {}) {
  const out = new Set();
  for (const key of ["propertyMap", "properties", "props"]) {
    const obj = extractObjectMaybe(args[key]);
    if (!isPlainObject(obj)) continue;
    for (const k of Object.keys(obj)) {
      const nk = safeString(k).trim();
      if (nk) out.add(nk.toLowerCase());
    }
  }
  const singularKey = safeString(args.property || args.propertyName || args.settingName).trim();
  if (singularKey) out.add(singularKey.toLowerCase());
  return out;
}

function executionStepSucceeded(executionResult) {
  if (executionResult?.ok === true) return true;
  const first = Array.isArray(executionResult?.results) ? executionResult.results[0] : null;
  return Boolean(first?.ok);
}

function looksLikeNodePropertyMutationStep(stepToolName, args = {}) {
  const tool = safeString(stepToolName).trim().toLowerCase();
  const hasNodeTarget = Boolean(safeString(args.nodePath).trim() || safeString(args.nodeRef).trim() || safeString(args.targetNodePath).trim() || safeString(args.targetNodeRef).trim() || safeString(args.targetNode).trim());
  const hasPropertyPayload = isPlainObject(extractObjectMaybe(args.propertyMap)) || isPlainObject(extractObjectMaybe(args.properties)) || isPlainObject(extractObjectMaybe(args.props)) || Boolean(safeString(args.property || args.propertyName || args.settingName).trim());
  if (hasNodeTarget && hasPropertyPayload) return true;
  return tool.includes("node") && tool.includes("propert") && (tool.includes("set") || tool.includes("update") || tool.includes("change") || tool.includes("edit"));
}

function consumeAppliedTargetedEdits({ targetedEdits = [], args = {}, stepToolName = "", executionResult = null } = {}) {
  const edits = Array.isArray(targetedEdits) ? targetedEdits : [];
  if (edits.length < 1) return edits;
  if (!executionStepSucceeded(executionResult)) return edits;
  if (!looksLikeNodePropertyMutationStep(stepToolName, args)) return edits;
  const nodeCandidatesRaw = [args.nodePath, args.nodeRef, args.targetNodePath, args.targetNodeRef, args.targetNode].map((x) => safeString(x).trim()).filter(Boolean);
  if (nodeCandidatesRaw.length < 1) return edits;
  const nodeCandidates = new Set(nodeCandidatesRaw.map((x) => normalizeNodeToken(x)));
  const nodeLeafCandidates = new Set(nodeCandidatesRaw.map((x) => normalizeNodeToken(toNodeLeaf(x))).filter(Boolean));
  const propertyKeys = collectAppliedPropertyKeys(args);
  if (propertyKeys.size < 1) return edits;

  return edits.filter((edit) => {
    const field = safeString(edit?.field).trim();
    if (!field || !field.includes(".")) return true;
    const nodePart = safeString(field.split(".")[0]).trim();
    const propPartRaw = safeString(field.slice(nodePart.length + 1)).trim();
    const propPart = propPartRaw.toLowerCase();
    const nodeNorm = normalizeNodeToken(nodePart);
    const nodeLeafNorm = normalizeNodeToken(toNodeLeaf(nodePart));
    const nodeMatches = nodeCandidates.has(nodeNorm) || nodeLeafCandidates.has(nodeNorm) || nodeCandidates.has(nodeLeafNorm) || nodeLeafCandidates.has(nodeLeafNorm);
    if (!nodeMatches) return true;
    const propertyMatches = [...propertyKeys].some((k) => propPart === k || propPart.startsWith(`${k}.`));
    return !propertyMatches;
  });
}

export function updateSemanticStateFromStep({ semanticState = null, resolvedArgs = null, stepToolName = null, executionResult = null, artifactOperation = null } = {}) {
  const ss = isPlainObject(semanticState) ? semanticState : {};
  const args = isPlainObject(resolvedArgs) ? resolvedArgs : {};
  const nestedCreation = isPlainObject(args.creationIntent) ? args.creationIntent : {};
  const nestedRefs = isPlainObject(args.targetRefs) ? args.targetRefs : {};
  ss.targetRefs = isPlainObject(ss.targetRefs) ? ss.targetRefs : {};
  ss.creationIntent = isPlainObject(ss.creationIntent) ? ss.creationIntent : {};
  ss.knownFacts = isPlainObject(ss.knownFacts) ? ss.knownFacts : {};
  ss.completedEffects = isPlainObject(ss.completedEffects) ? ss.completedEffects : {};

  const refMap = [["sceneRef", "sceneRef"],["scenePath", "sceneRef"],["nodeRef", "nodeRef"],["nodePath", "nodeRef"],["targetNodeRef", "targetNodeRef"],["targetNode", "targetNodeRef"],["fileRef", "fileRef"],["filePath", "fileRef"],["resourceRef", "resourceRef"],["resourcePath", "resourceRef"],["artifactRef", "artifactRef"],["scriptRef", "scriptRef"],["scriptPath", "scriptRef"],["path", "fileRef"]];
  for (const [k, outKey] of refMap) if (hasText(args[k])) ss.targetRefs[outKey] = safeString(args[k]).trim();
  for (const [k, v] of Object.entries(nestedRefs)) if (hasText(v)) ss.targetRefs[k] = safeString(v).trim();

  if (hasText(args.targetConcept)) ss.targetRefs.targetConcept = safeString(args.targetConcept).trim();
  if (hasText(args.requestedName)) ss.creationIntent.requestedName = safeString(args.requestedName).trim();
  if (hasText(args.resourceKind)) ss.creationIntent.resourceKind = safeString(args.resourceKind).trim();
  if (hasText(args.targetFolder)) ss.creationIntent.targetFolder = safeString(args.targetFolder).trim();
  if (hasText(nestedCreation.requestedName)) ss.creationIntent.requestedName = safeString(nestedCreation.requestedName).trim();
  if (hasText(nestedCreation.resourceKind)) ss.creationIntent.resourceKind = safeString(nestedCreation.resourceKind).trim();
  if (hasText(nestedCreation.targetFolder)) ss.creationIntent.targetFolder = safeString(nestedCreation.targetFolder).trim();
  if (hasText(args.contentIntent)) ss.contentIntent = safeString(args.contentIntent).trim();
  else if (hasText(args.codeIntent)) ss.contentIntent = safeString(args.codeIntent).trim();
  if (Array.isArray(args.targetedEdits) && args.targetedEdits.length > 0) ss.targetedEdits = [...args.targetedEdits];
  if (Array.isArray(ss.targetedEdits) && ss.targetedEdits.length > 0) {
    ss.targetedEdits = consumeAppliedTargetedEdits({ targetedEdits: ss.targetedEdits, args, stepToolName, executionResult });
  }

  ss.knownFacts.lastTool = safeString(stepToolName).trim() || ss.knownFacts.lastTool || null;
  ss.knownFacts.lastExecutionOk = Boolean(executionResult?.ok);
  ss.knownFacts.lastResolvedRefs = {
    sceneRef: ss.targetRefs.sceneRef ?? null,
    nodeRef: ss.targetRefs.nodeRef ?? null,
    targetNodeRef: ss.targetRefs.targetNodeRef ?? null,
    artifactRef: ss.targetRefs.artifactRef ?? ss.targetRefs.scriptRef ?? ss.targetRefs.fileRef ?? ss.targetRefs.resourceRef ?? null,
  };

  const observed = isPlainObject(artifactOperation?.observedEffects) ? artifactOperation.observedEffects : {};
  markEffect(ss.completedEffects, "artifact_created", observed.artifactCreated);
  markEffect(ss.completedEffects, "artifact_modified", observed.artifactModified);
  markEffect(ss.completedEffects, "artifact_attached", observed.artifactAttached);

  return ss;
}

export function refreshPendingSemanticGaps(semanticState = null, artifactOperation = null) {
  const ss = isPlainObject(semanticState) ? semanticState : {};
  const gaps = new Set();
  const intent = safeString(ss.artifactIntent).trim().toLowerCase();
  const contentIntent = safeString(ss.contentIntent).trim();
  const hasTargetedEdits = Array.isArray(ss.targetedEdits) && ss.targetedEdits.length > 0;
  const hasArtifactRef = hasText(ss?.targetRefs?.artifactRef) || hasText(ss?.targetRefs?.scriptRef) || hasText(ss?.targetRefs?.fileRef) || hasText(ss?.targetRefs?.resourceRef);

  if (intent.startsWith("create") && !hasText(ss?.creationIntent?.requestedName) && !hasArtifactRef) gaps.add("requestedName");
  if (intent.includes("modify") && !contentIntent && !hasTargetedEdits) gaps.add("contentIntent");
  if (intent.includes("attach") && !hasText(ss?.targetRefs?.targetNodeRef) && !hasText(ss?.targetRefs?.targetConcept)) gaps.add("targetNodeRef");

  const expectedModify = Boolean(artifactOperation?.expectedEffects?.artifactModified);
  if (expectedModify && !contentIntent && !hasTargetedEdits) gaps.add("contentIntent");

  ss.pendingSemanticGaps = [...gaps];
  return ss;
}

export function hasSemanticFieldValue(semanticState = null, field = null) {
  const f = safeString(field).trim();
  const ss = isPlainObject(semanticState) ? semanticState : {};
  if (!f) return false;
  if (f === "contentIntent" || f === "codeIntent") return hasText(ss.contentIntent);
  if (Object.prototype.hasOwnProperty.call(ss, f)) return hasText(ss[f]);
  if (isPlainObject(ss.targetRefs) && Object.prototype.hasOwnProperty.call(ss.targetRefs, f)) return hasText(ss.targetRefs[f]);
  if (isPlainObject(ss.creationIntent) && Object.prototype.hasOwnProperty.call(ss.creationIntent, f)) return hasText(ss.creationIntent[f]);
  if (isPlainObject(ss.knownFacts) && Object.prototype.hasOwnProperty.call(ss.knownFacts, f)) return hasText(ss.knownFacts[f]);
  return false;
}

export function firstPendingSemanticGap(semanticState = null) {
  const gaps = Array.isArray(semanticState?.pendingSemanticGaps) ? semanticState.pendingSemanticGaps : [];
  return safeString(gaps[0]).trim() || null;
}
