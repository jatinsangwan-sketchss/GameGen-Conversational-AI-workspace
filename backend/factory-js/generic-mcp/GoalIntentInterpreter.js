function safeString(value) {
  return value == null ? "" : String(value);
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
  const fromAttach = pickFirstRegex(text, /\b(?:attach|assign|link)\b.*?\bto\s+(?:the\s+)?([A-Za-z0-9_-]{2,})\b/i);
  if (fromAttach) return fromAttach;
  return null;
}

function parseTypedLiteral(raw) {
  const t = safeString(raw).trim().replace(/^["'`]+|["'`]+$/g, "");
  if (!t) return null;
  if (/^-?\d+(?:\.\d+)?$/.test(t)) return Number(t);
  if (/^(true|false)$/i.test(t)) return /^true$/i.test(t);
  return t;
}

function inferTargetedEdits(text) {
  const out = [];
  const seen = new Set();
  const push = (edit) => {
    if (!edit || !edit.field) return;
    const key = `${safeString(edit.field).toLowerCase()}::${String(edit.newValue)}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(edit);
  };

  const changeRe = /\b(?:change|update|set)\s+([A-Za-z0-9_.-]{2,})(?:\s+(?:value|property))?\s+(?:to|as)\s+([A-Za-z0-9_.:"'`-]+)(?:\s+from\s+([A-Za-z0-9_.:"'`-]+))?/gi;
  for (const m of text.matchAll(changeRe)) {
    push({
      kind: "set_value",
      field: safeString(m[1]).trim(),
      newValue: parseTypedLiteral(m[2]),
      oldValue: parseTypedLiteral(m[3]),
    });
  }

  const fromToRe = /\b([A-Za-z0-9_.-]{2,})\s+from\s+([A-Za-z0-9_.:"'`-]+)\s+to\s+([A-Za-z0-9_.:"'`-]+)/gi;
  for (const m of text.matchAll(fromToRe)) {
    push({
      kind: "set_value",
      field: safeString(m[1]).trim(),
      newValue: parseTypedLiteral(m[3]),
      oldValue: parseTypedLiteral(m[2]),
    });
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
  const rootNode = /\broot node\b/i.test(text) ? "root node" : null;
  if (scenePath) refs.sceneRef = normalizeRefToken(scenePath);
  else if (bareScene && !/\.(?:gd|tscn|tres|res)$/i.test(bareScene)) refs.sceneRef = bareScene;
  if (scriptPath) refs.scriptRef = normalizeRefToken(scriptPath);
  else if (bareScriptByCalled) refs.scriptRef = normalizeRefToken(bareScriptByCalled);
  else if (bareScriptByNamed) refs.scriptRef = normalizeRefToken(bareScriptByNamed);
  if (rootNode) refs.targetNodeRef = rootNode;
  return refs;
}

function extractCreationIntent(text) {
  const shouldCaptureName = hasCreateVerb(text);
  const requestedName = shouldCaptureName
    ? (
      pickFirstRegex(text, /\bcalled\s+([A-Za-z0-9_.-]+)/i) ??
      pickFirstRegex(text, /\bnamed\s+([A-Za-z0-9_.-]+)/i)
    )
    : null;
  const scriptHint = /\bgdscript|script\b/i.test(text) ? "script" : null;
  const sceneHint = /\bscene\b/i.test(text) ? "scene" : null;
  return {
    requestedName: requestedName || null,
    resourceKind: scriptHint || sceneHint || null,
  };
}

export function interpretGoalIntent({ userRequest = "", prior = null } = {}) {
  const text = safeString(userRequest).trim();
  const base = prior && typeof prior === "object" ? { ...prior } : {};
  if (!text) return base;
  const refs = extractSemanticRefs(text);
  const creation = extractCreationIntent(text);
  const codeIntent = inferCodeIntent(text);
  const priorCreation = base.creationIntent && typeof base.creationIntent === "object" ? base.creationIntent : {};
  const mergedCreation = {
    ...priorCreation,
    ...creation,
  };
  if (!safeString(creation.requestedName).trim() && safeString(priorCreation.requestedName).trim()) {
    mergedCreation.requestedName = priorCreation.requestedName;
  }
  if (!safeString(creation.resourceKind).trim() && safeString(priorCreation.resourceKind).trim()) {
    mergedCreation.resourceKind = priorCreation.resourceKind;
  }
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
    refs: {
      ...(base.refs ?? {}),
      ...refs,
    },
    targetedEdits: targetedEdits.length > 0
      ? targetedEdits
      : (Array.isArray(base.targetedEdits) ? base.targetedEdits : []),
    creationIntent: mergedCreation,
  };
}

export function synthesizeCodeArtifact({ semanticIntent = null } = {}) {
  const codeIntent = safeString(semanticIntent?.contentIntent).trim() || safeString(semanticIntent?.codeIntent).trim();
  if (!codeIntent) return null;
  const lower = codeIntent.toLowerCase();
  if (lower.includes("print")) {
    return {
      kind: "code_snippet",
      intent: codeIntent,
      content: 'print("Hello world")',
    };
  }
  if (lower.includes("jump") && lower.includes("tap")) {
    return {
      kind: "code_snippet",
      intent: codeIntent,
      content: [
        "func _unhandled_input(event):",
        "  if event is InputEventScreenTouch and event.pressed:",
        "    jump()",
      ].join("\n"),
    };
  }
  return {
    kind: "code_snippet",
    intent: codeIntent,
    content: `# TODO: implement ${codeIntent}`,
  };
}
