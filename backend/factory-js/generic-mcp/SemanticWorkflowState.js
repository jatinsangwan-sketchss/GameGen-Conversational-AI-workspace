function safeString(value) {
  return value == null ? "" : String(value);
}

function isPlainObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function hasText(value) {
  return safeString(value).trim().length > 0;
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

export function buildSemanticWorkflowState({
  semanticIntent = null,
  artifactOperation = null,
  priorSemanticState = null,
} = {}) {
  const prior = cloneObject(priorSemanticState);
  const refs = cloneObject(semanticIntent?.refs);
  const creation = cloneObject(semanticIntent?.creationIntent);
  const contentIntent = (normalizeContentIntent(semanticIntent) ?? safeString(prior.contentIntent).trim()) || null;
  const targetConcept = hasText(semanticIntent?.targetConcept)
    ? safeString(semanticIntent.targetConcept).trim()
    : safeString(prior?.targetRefs?.targetConcept).trim() || null;

  const targetRefs = {
    ...cloneObject(prior.targetRefs),
    ...refs,
    ...(targetConcept ? { targetConcept } : {}),
  };

  const requestedName =
    hasText(creation.requestedName)
      ? safeString(creation.requestedName).trim()
      : safeString(prior?.creationIntent?.requestedName).trim() || null;
  const resourceKind =
    hasText(creation.resourceKind)
      ? safeString(creation.resourceKind).trim()
      : safeString(prior?.creationIntent?.resourceKind).trim() || null;

  const creationIntent = {
    ...cloneObject(prior.creationIntent),
    ...creation,
    requestedName,
    resourceKind,
  };

  const semanticState = {
    goal: safeString(semanticIntent?.goalText).trim() || safeString(prior.goal).trim() || null,
    artifactIntent: deriveArtifactIntent({ semanticIntent, artifactOperation }) || safeString(prior.artifactIntent).trim() || "general",
    targetRefs,
    creationIntent,
    contentIntent,
    targetedEdits: Array.isArray(semanticIntent?.targetedEdits)
      ? [...semanticIntent.targetedEdits]
      : (Array.isArray(prior.targetedEdits) ? [...prior.targetedEdits] : []),
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
  // Backward-compatible semantic alias for components that still read codeIntent.
  setIfEmpty(out, "codeIntent", ss.contentIntent);
  if (!Array.isArray(out.targetedEdits) && Array.isArray(ss.targetedEdits) && ss.targetedEdits.length > 0) {
    out.targetedEdits = [...ss.targetedEdits];
  }
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
  const hasNodeTarget = Boolean(
    safeString(args.nodePath).trim() ||
    safeString(args.nodeRef).trim() ||
    safeString(args.targetNodePath).trim() ||
    safeString(args.targetNodeRef).trim() ||
    safeString(args.targetNode).trim()
  );
  const hasPropertyPayload =
    isPlainObject(extractObjectMaybe(args.propertyMap)) ||
    isPlainObject(extractObjectMaybe(args.properties)) ||
    isPlainObject(extractObjectMaybe(args.props)) ||
    Boolean(safeString(args.property || args.propertyName || args.settingName).trim());
  if (hasNodeTarget && hasPropertyPayload) return true;
  return (
    tool.includes("node") &&
    tool.includes("propert") &&
    (tool.includes("set") || tool.includes("update") || tool.includes("change") || tool.includes("edit"))
  );
}

function consumeAppliedTargetedEdits({ targetedEdits = [], args = {}, stepToolName = "", executionResult = null } = {}) {
  const edits = Array.isArray(targetedEdits) ? targetedEdits : [];
  if (edits.length < 1) return edits;
  if (!executionStepSucceeded(executionResult)) return edits;
  if (!looksLikeNodePropertyMutationStep(stepToolName, args)) return edits;
  const nodeCandidatesRaw = [
    args.nodePath,
    args.nodeRef,
    args.targetNodePath,
    args.targetNodeRef,
    args.targetNode,
  ]
    .map((x) => safeString(x).trim())
    .filter(Boolean);
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
    const nodeMatches =
      nodeCandidates.has(nodeNorm) ||
      nodeLeafCandidates.has(nodeNorm) ||
      nodeCandidates.has(nodeLeafNorm) ||
      nodeLeafCandidates.has(nodeLeafNorm);
    if (!nodeMatches) return true;
    const propertyMatches = [...propertyKeys].some((k) => propPart === k || propPart.startsWith(`${k}.`));
    return !propertyMatches;
  });
}

export function updateSemanticStateFromStep({
  semanticState = null,
  resolvedArgs = null,
  stepToolName = null,
  executionResult = null,
  artifactOperation = null,
} = {}) {
  const ss = isPlainObject(semanticState) ? semanticState : {};
  const args = isPlainObject(resolvedArgs) ? resolvedArgs : {};
  const nestedCreation = isPlainObject(args.creationIntent) ? args.creationIntent : {};
  const nestedRefs = isPlainObject(args.targetRefs) ? args.targetRefs : {};
  ss.targetRefs = isPlainObject(ss.targetRefs) ? ss.targetRefs : {};
  ss.creationIntent = isPlainObject(ss.creationIntent) ? ss.creationIntent : {};
  ss.knownFacts = isPlainObject(ss.knownFacts) ? ss.knownFacts : {};
  ss.completedEffects = isPlainObject(ss.completedEffects) ? ss.completedEffects : {};

  const refMap = [
    ["sceneRef", "sceneRef"],
    ["scenePath", "sceneRef"],
    ["nodeRef", "nodeRef"],
    ["nodePath", "nodeRef"],
    ["targetNodeRef", "targetNodeRef"],
    ["targetNode", "targetNodeRef"],
    ["fileRef", "fileRef"],
    ["filePath", "fileRef"],
    ["resourceRef", "resourceRef"],
    ["resourcePath", "resourceRef"],
    ["artifactRef", "artifactRef"],
    ["scriptRef", "scriptRef"],
    ["scriptPath", "scriptRef"],
    ["path", "fileRef"],
  ];
  for (const [k, outKey] of refMap) {
    if (hasText(args[k])) ss.targetRefs[outKey] = safeString(args[k]).trim();
  }
  for (const [k, v] of Object.entries(nestedRefs)) {
    if (!hasText(v)) continue;
    ss.targetRefs[k] = safeString(v).trim();
  }

  if (hasText(args.targetConcept)) ss.targetRefs.targetConcept = safeString(args.targetConcept).trim();
  if (hasText(args.requestedName)) ss.creationIntent.requestedName = safeString(args.requestedName).trim();
  if (hasText(args.resourceKind)) ss.creationIntent.resourceKind = safeString(args.resourceKind).trim();
  if (hasText(args.targetFolder)) ss.creationIntent.targetFolder = safeString(args.targetFolder).trim();
  if (hasText(nestedCreation.requestedName)) ss.creationIntent.requestedName = safeString(nestedCreation.requestedName).trim();
  if (hasText(nestedCreation.resourceKind)) ss.creationIntent.resourceKind = safeString(nestedCreation.resourceKind).trim();
  if (hasText(nestedCreation.targetFolder)) ss.creationIntent.targetFolder = safeString(nestedCreation.targetFolder).trim();
  if (hasText(args.contentIntent)) ss.contentIntent = safeString(args.contentIntent).trim();
  else if (hasText(args.codeIntent)) ss.contentIntent = safeString(args.codeIntent).trim();
  if (Array.isArray(args.targetedEdits) && args.targetedEdits.length > 0) {
    ss.targetedEdits = [...args.targetedEdits];
  }
  if (Array.isArray(ss.targetedEdits) && ss.targetedEdits.length > 0) {
    ss.targetedEdits = consumeAppliedTargetedEdits({
      targetedEdits: ss.targetedEdits,
      args,
      stepToolName,
      executionResult,
    });
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
  const hasArtifactRef =
    hasText(ss?.targetRefs?.artifactRef) ||
    hasText(ss?.targetRefs?.scriptRef) ||
    hasText(ss?.targetRefs?.fileRef) ||
    hasText(ss?.targetRefs?.resourceRef);

  if (intent.startsWith("create") && !hasText(ss?.creationIntent?.requestedName) && !hasArtifactRef) {
    gaps.add("requestedName");
  }
  if (intent.includes("modify") && !contentIntent && !hasTargetedEdits) {
    gaps.add("contentIntent");
  }
  if (intent.includes("attach") && !hasText(ss?.targetRefs?.targetNodeRef) && !hasText(ss?.targetRefs?.targetConcept)) {
    gaps.add("targetNodeRef");
  }

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
