function safeString(value) {
  return value == null ? "" : String(value);
}

function isPlainObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function hasText(v) {
  return safeString(v).trim().length > 0;
}

function anyRef(intent) {
  const refs = isPlainObject(intent?.refs) ? intent.refs : {};
  return (
    safeString(refs.scriptRef).trim() ||
    safeString(refs.fileRef).trim() ||
    safeString(refs.resourceRef).trim() ||
    safeString(refs.artifactRef).trim() ||
    null
  );
}

function hasCreateSignal(text) {
  return /\b(create|new|generate|scaffold)\b/i.test(text);
}

function hasModifySignal(text) {
  return /\b(modify|edit|update|change|patch|rewrite|write code|add code|implement)\b/i.test(text);
}

function hasAttachSignal(text) {
  return /\b(attach|assign|link|bind)\b/i.test(text) || /\buse\b[\s\S]{0,80}\b(on|to)\b/i.test(text);
}
function looksLikeArtifactPath(ref) {
  const value = safeString(ref).trim();
  if (!value) return false;
  return /[\\/]/.test(value) || /\.(gd|tscn|tres|res|png|jpg|jpeg|webp|gdshader|shader)$/i.test(value);
}
function hasCreateArtifactSignal(text) {
  const t = safeString(text);
  if (!t.trim()) return false;
  return /\b(create|new|generate|scaffold)\b[\s\S]{0,48}\b(script|scene|file|resource|shader|texture|singleton|autoload)\b/i.test(t);
}

export function buildArtifactOperationState({ semanticIntent = null } = {}) {
  const intent = isPlainObject(semanticIntent) ? semanticIntent : {};
  const text = safeString(intent.goalText).trim();
  const goalType = safeString(intent?.goalType).trim().toLowerCase();
  const existingTargetRef = anyRef(intent);
  const hasNamedCreationIntent = hasText(intent?.creationIntent?.requestedName);
  const createArtifactSignal = hasCreateArtifactSignal(text);
  const createArtifactIntent = createArtifactSignal || hasNamedCreationIntent;
  const createTargetRefLikelyOutput = Boolean(existingTargetRef) && createArtifactIntent && looksLikeArtifactPath(existingTargetRef);
  const wantsCreate =
    goalType === "create" ||
    (hasCreateSignal(text) && goalType !== "modify") ||
    (hasText(intent?.creationIntent?.requestedName) && !existingTargetRef && goalType !== "modify");
  const wantsModify = hasModifySignal(text) || hasText(intent?.contentIntent) || hasText(intent?.codeIntent) || hasText(intent?.behaviorIntent);
  const wantsAttach =
    hasAttachSignal(text) ||
    (hasText(intent?.refs?.targetNodeRef) && hasText(existingTargetRef));
  const createMode = wantsCreate && (!existingTargetRef || createTargetRefLikelyOutput);
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
    expectedEffects: {
      artifactCreated: mode.startsWith("create_"),
      artifactModified: wantsModify,
      artifactAttached: wantsAttach,
    },
    observedEffects: {
      artifactCreated: false,
      artifactModified: false,
      artifactAttached: false,
    },
  };
}

function classifyStepAction({ toolName, args }) {
  const t = safeString(toolName).toLowerCase();
  const a = isPlainObject(args) ? args : {};
  const hasRichPayload = ["modifications", "operations", "edits", "patches", "changes"].some((k) => Object.prototype.hasOwnProperty.call(a, k));
  const hasAttachTarget = ["targetNode", "targetNodeRef", "targetRef", "nodeRef", "targetNodePath", "nodePath", "parentPath"].some((k) => hasText(a[k]));
  const hasArtifactRef = ["artifactRef", "scriptRef", "scriptPath", "fileRef", "filePath", "resourceRef", "resourcePath", "path"].some((k) => hasText(a[k]));
  if (hasRichPayload) return "modify";
  if (/\b(create|new|generate|scaffold)\b/.test(t)) return "create";
  if (/\b(edit|modify|patch|update|change)\b/.test(t)) return "modify";
  if ((hasAttachTarget && /\b(attach|assign|link|use|set)\b/.test(t)) || (hasAttachTarget && hasArtifactRef)) return "attach";
  return "other";
}

function hasImplementationPayload(args) {
  const a = isPlainObject(args) ? args : {};
  const directKeys = [
    "content",
    "body",
    "source",
    "code",
    "snippet",
    "text",
    "scriptBody",
    "fileContent",
    "sourceCode",
  ];
  if (directKeys.some((k) => hasText(a[k]))) return true;
  const richKeys = ["modifications", "operations", "edits", "patches", "changes"];
  return richKeys.some((k) => Array.isArray(a[k]) ? a[k].length > 0 : false);
}

export function checkOperationDrift({ operationState = null, stepTool = null }) {
  const op = isPlainObject(operationState) ? operationState : null;
  if (!op) return { ok: true, reason: null };
  const action = classifyStepAction({ toolName: stepTool?.name, args: stepTool?.args });
  const mode = safeString(op.mode).trim();
  if (mode === "modify_existing" && action === "create") {
    return { ok: false, reason: "Existing artifact modification intent drifted into create step." };
  }
  if (mode === "attach_existing" && action === "create") {
    return { ok: false, reason: "Attach-existing intent drifted into create step." };
  }
  return { ok: true, reason: null };
}

export function updateObservedEffects({ operationState = null, stepTool = null, executionResult = null, artifactCountBefore = 0, artifactCountAfter = 0 }) {
  const op = isPlainObject(operationState) ? operationState : null;
  if (!op) return null;
  const action = classifyStepAction({ toolName: stepTool?.name, args: stepTool?.args });
  const ok = Boolean(executionResult?.ok);
  if (!ok) return op;
  const args = isPlainObject(stepTool?.args) ? stepTool.args : {};
  const hasCreatedRefHint = ["scriptPath", "filePath", "resourcePath", "path", "scriptRef", "fileRef", "resourceRef", "artifactRef"]
    .some((k) => hasText(args[k]));
  // Creation confirmation can come from strong inventory-independent hints:
  // registry growth, or a successful create-like call carrying canonical path/ref-like output intent.
  if (action === "create" && (artifactCountAfter > artifactCountBefore || hasCreatedRefHint)) {
    op.observedEffects.artifactCreated = true;
    if (hasImplementationPayload(args)) {
      op.observedEffects.artifactModified = true;
    }
  }
  if (action === "modify") op.observedEffects.artifactModified = true;
  if (action === "attach") op.observedEffects.artifactAttached = true;
  return op;
}

export function unmetExpectedEffects(operationState) {
  const op = isPlainObject(operationState) ? operationState : {};
  const out = [];
  const expected = isPlainObject(op.expectedEffects) ? op.expectedEffects : {};
  const observed = isPlainObject(op.observedEffects) ? op.observedEffects : {};
  for (const [k, v] of Object.entries(expected)) {
    if (v && !observed[k]) out.push(k);
  }
  return out;
}
