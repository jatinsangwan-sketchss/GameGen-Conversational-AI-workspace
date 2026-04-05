function safeString(value) {
  return value == null ? "" : String(value);
}

function isPlainObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function hasText(value) {
  return safeString(value).trim().length > 0;
}

function firstText(...values) {
  for (const v of values) {
    const t = safeString(v).trim();
    if (t) return t;
  }
  return null;
}

function inferRuntimeHint({ refs = null, knownFacts = null } = {}) {
  const explicit = firstText(knownFacts?.runtime, knownFacts?.platform, knownFacts?.engine);
  if (explicit) return explicit;
  const candidates = [];
  const r = isPlainObject(refs) ? refs : {};
  for (const key of ["sceneRef", "scriptRef", "fileRef", "resourceRef", "artifactRef"]) {
    if (hasText(r[key])) candidates.push(safeString(r[key]).trim().toLowerCase());
  }
  if (candidates.some((v) => v.endsWith(".tscn") || v.endsWith(".gd") || v.endsWith(".tres"))) return "godot";
  if (candidates.some((v) => v.endsWith(".unity") || v.endsWith(".cs"))) return "unity";
  return null;
}

function pickResolvedArtifactRef(targetRefs) {
  const refs = isPlainObject(targetRefs) ? targetRefs : {};
  return firstText(refs.artifactRef, refs.scriptRef, refs.fileRef, refs.resourceRef);
}

function pickResolvedNodeRef(targetRefs) {
  const refs = isPlainObject(targetRefs) ? targetRefs : {};
  return firstText(refs.targetNodeRef, refs.nodeRef);
}

export function buildGenerationContext({
  workflowState = null,
  args = null,
  toolName = null,
  sessionContext = null,
} = {}) {
  const semanticState = isPlainObject(workflowState?.semanticState) ? workflowState.semanticState : {};
  const semanticIntent = isPlainObject(workflowState?.semanticIntent) ? workflowState.semanticIntent : {};
  const op = isPlainObject(workflowState?.artifactOperation) ? workflowState.artifactOperation : {};
  const knownFacts = isPlainObject(semanticState?.knownFacts) ? semanticState.knownFacts : {};
  const refs = isPlainObject(semanticState?.targetRefs) ? semanticState.targetRefs : {};
  const creation = isPlainObject(semanticState?.creationIntent) ? semanticState.creationIntent : {};
  const inputArgs = isPlainObject(args) ? args : {};
  const resolvedTargetRefs = {
    sceneRef: firstText(refs.sceneRef, inputArgs.sceneRef),
    nodeRef: firstText(refs.nodeRef, inputArgs.nodeRef),
    targetNodeRef: firstText(refs.targetNodeRef, inputArgs.targetNodeRef, inputArgs.targetNode),
    scriptRef: firstText(refs.scriptRef, inputArgs.scriptRef),
    fileRef: firstText(refs.fileRef, inputArgs.fileRef, inputArgs.path),
    resourceRef: firstText(refs.resourceRef, inputArgs.resourceRef),
    artifactRef: firstText(refs.artifactRef, inputArgs.artifactRef, refs.scriptRef, refs.fileRef, refs.resourceRef),
  };
  return {
    runtime: inferRuntimeHint({ refs: resolvedTargetRefs, knownFacts }),
    toolName: safeString(toolName).trim() || null,
    artifactKind: firstText(creation.resourceKind, semanticIntent?.creationIntent?.resourceKind),
    operationMode: firstText(op.mode, semanticState.artifactIntent, "general"),
    targetConcept: firstText(refs.targetConcept, semanticIntent?.targetConcept),
    resolvedTargetRefs,
    resolvedTargetFacts: isPlainObject(knownFacts?.resolvedTargetFacts)
      ? { ...knownFacts.resolvedTargetFacts }
      : (isPlainObject(knownFacts?.lastResolvedRefs) ? { ...knownFacts.lastResolvedRefs } : {}),
    behaviorIntent: firstText(semanticIntent?.behaviorIntent),
    contentIntent: firstText(
      inputArgs.contentIntent,
      inputArgs.codeIntent,
      semanticState.contentIntent,
      semanticIntent.contentIntent,
      semanticIntent.codeIntent
    ),
    creationIntent: {
      requestedName: firstText(creation.requestedName, semanticIntent?.creationIntent?.requestedName),
      resourceKind: firstText(creation.resourceKind, semanticIntent?.creationIntent?.resourceKind),
      targetFolder: firstText(creation.targetFolder, semanticIntent?.creationIntent?.targetFolder),
    },
    hasExistingContentContext: hasText(knownFacts?.existingContentPreview),
    sessionProjectRoot: firstText(sessionContext?.projectRoot, sessionContext?.sessionStatus?.connectedProjectPath),
  };
}

export function evaluateGenerationTargetReadiness(context = null) {
  const ctx = isPlainObject(context) ? context : {};
  const mode = safeString(ctx.operationMode).trim().toLowerCase();
  const artifactRef = pickResolvedArtifactRef(ctx.resolvedTargetRefs);
  const nodeRef = pickResolvedNodeRef(ctx.resolvedTargetRefs);
  const targetConcept = safeString(ctx.targetConcept).trim();

  const needsArtifactRef = new Set(["modify_existing", "attach_existing", "modify_then_attach"]);
  if (needsArtifactRef.has(mode) && !artifactRef) {
    return {
      status: targetConcept ? "generate_with_partial_context" : "needs_input",
      missingSemanticField: targetConcept ? null : "artifactRef",
      reason: targetConcept
        ? "Generating with partial context: concrete artifact target is unresolved."
        : "I need the target artifact reference before generating target-grounded content.",
    };
  }

  if (!artifactRef && !nodeRef && targetConcept) {
    return {
      status: "generate_with_partial_context",
      missingSemanticField: null,
      reason: "Generating with partial context: semantic target concept is present but not fully resolved.",
    };
  }

  return {
    status: "ready_to_generate",
    missingSemanticField: null,
    reason: null,
  };
}
