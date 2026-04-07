import { extractToolSchema, listDirectContentArgKeys } from "./ContentConsumerSelector.js";

function safeString(value) {
  return value == null ? "" : String(value);
}

function isPlainObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function hasText(value) {
  return safeString(value).trim().length > 0;
}

function looksLikeCodePayload(value) {
  const text = safeString(value);
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (trimmed.includes("```")) return true;
  if (/[{};]/.test(trimmed) && /[=()]/.test(trimmed)) return true;
  if (/\n/.test(trimmed) && /(^|\n)\s*(extends|class_name|func|var|const|if|for|while|return|pass)\b/i.test(trimmed)) {
    return true;
  }
  if (/\n/.test(trimmed) && /(^|\n)\s*(def|class|function|import|from)\b/i.test(trimmed)) {
    return true;
  }
  return false;
}

function getRequired(schema) {
  return Array.isArray(schema?.required)
    ? schema.required.map((x) => safeString(x).trim()).filter(Boolean)
    : [];
}

function normalizeKey(value) {
  return safeString(value).toLowerCase().replace(/[^a-z0-9]/g, "");
}

function schemaAllowsStringContent(propSchema) {
  const schema = isPlainObject(propSchema) ? propSchema : {};
  const directType = schema.type;
  if (typeof directType === "string") {
    return directType.trim().toLowerCase() === "string";
  }
  if (Array.isArray(directType)) {
    return directType.some((entry) => safeString(entry).trim().toLowerCase() === "string");
  }
  const unionKeys = ["anyOf", "oneOf", "allOf"];
  for (const key of unionKeys) {
    const variants = Array.isArray(schema[key]) ? schema[key] : [];
    for (const variant of variants) {
      if (!isPlainObject(variant)) continue;
      if (schemaAllowsStringContent(variant)) return true;
    }
  }
  return false;
}

function inferFallbackContentArgKeys(schema = {}) {
  const props = isPlainObject(schema?.properties) ? schema.properties : {};
  const out = [];
  for (const [key, propSchema] of Object.entries(props)) {
    if (!schemaAllowsStringContent(propSchema)) continue;
    const nk = normalizeKey(key);
    if (!nk) continue;
    if (
      nk.includes("path") ||
      nk.endsWith("ref") ||
      nk.includes("project") ||
      nk.includes("folder") ||
      nk.includes("directory") ||
      nk.includes("scene") ||
      nk.includes("node") ||
      nk.includes("target") ||
      nk.includes("resource") ||
      nk.includes("artifact") ||
      nk.includes("requestedname") ||
      nk === "name" ||
      nk.includes("reason") ||
      nk.includes("status") ||
      nk.includes("intent") ||
      nk.includes("mode") ||
      nk.includes("kind") ||
      nk.includes("type")
    ) {
      continue;
    }
    if (
      nk === "script" ||
      nk.includes("content") ||
      nk.includes("body") ||
      nk.includes("source") ||
      nk.includes("text") ||
      nk.includes("code") ||
      nk.includes("snippet") ||
      nk.includes("template") ||
      nk.includes("payload")
    ) {
      out.push(key);
    }
  }
  return out;
}

function rankKey(key) {
  const k = safeString(key).trim().toLowerCase();
  const priority = [
    "content",
    "body",
    "source",
    "text",
    "code",
    "snippet",
    "sourcecode",
    "filecontent",
    "raw",
    "data",
  ];
  const i = priority.indexOf(k);
  return i >= 0 ? i : priority.length + 1;
}

function pickPreferredKey(keys = []) {
  return [...keys]
    .map((k) => safeString(k).trim())
    .filter(Boolean)
    .sort((a, b) => rankKey(a) - rankKey(b))[0] || null;
}
function scoreContentCandidate(value) {
  const text = safeString(value).trim();
  if (!text) return -1;
  const codeBoost = looksLikeCodePayload(text) ? 100000 : 0;
  return codeBoost + text.length;
}
function pickBestContentValue(values = []) {
  let best = null;
  let bestScore = -1;
  for (const value of values) {
    if (!hasText(value)) continue;
    const score = scoreContentCandidate(value);
    if (score > bestScore) {
      bestScore = score;
      best = safeString(value);
    }
  }
  return best;
}

function getGeneratedContentValue({ args = null, workflowState = null } = {}) {
  const a = isPlainObject(args) ? args : {};
  const ss = isPlainObject(workflowState?.semanticState) ? workflowState.semanticState : {};
  const generatedCandidates = [
    ss.generatedContent?.content,
    ss.generatedCode,
    a.generatedCode,
    a.generatedContent?.content,
  ];
  const directCodeCandidates = [
    a.content,
    a.body,
    a.source,
    a.text,
    a.code,
    a.snippet,
  ].filter((v) => hasText(v) && looksLikeCodePayload(v));
  const best = pickBestContentValue([...generatedCandidates, ...directCodeCandidates]);
  if (hasText(best)) return safeString(best);
  const intentCandidates = [
    a.codeIntent,
    a.contentIntent,
    ss.codeIntent,
    ss.contentIntent,
    workflowState?.semanticIntent?.codeIntent,
    workflowState?.semanticIntent?.contentIntent,
  ];
  for (const c of intentCandidates) {
    if (looksLikeCodePayload(c)) return safeString(c);
  }
  return null;
}

export function mapGeneratedContentIntoInlineSink({
  toolName,
  args = null,
  inventory = null,
  workflowState = null,
} = {}) {
  const out = isPlainObject(args) ? { ...args } : {};
  const schema = extractToolSchema(toolName, inventory);
  const directKeys = listDirectContentArgKeys(schema);
  const fallbackKeys = inferFallbackContentArgKeys(schema);
  const sinkKeys = directKeys.length > 0 ? directKeys : fallbackKeys;
  if (sinkKeys.length < 1) {
    return {
      args: out,
      mapped: false,
      selectedContentField: null,
      availableContentFields: [],
      reason: "no_direct_content_sink",
    };
  }

  const required = getRequired(schema);
  const requiredDirectKeys = required.filter((k) => sinkKeys.includes(k));
  const selectedContentField =
    pickPreferredKey(requiredDirectKeys) ||
    pickPreferredKey(sinkKeys);
  const existingField = sinkKeys.find((k) => hasText(out[k])) || null;
  const contentValue = getGeneratedContentValue({ args: out, workflowState });

  if (!hasText(contentValue)) {
    return {
      args: out,
      mapped: false,
      selectedContentField,
      availableContentFields: sinkKeys,
      reason: "no_generated_content_value",
    };
  }

  let mapped = false;
  if (selectedContentField && !hasText(out[selectedContentField])) {
    out[selectedContentField] = contentValue;
    mapped = true;
  }

  for (const k of requiredDirectKeys) {
    if (!hasText(out[k])) {
      out[k] = contentValue;
      mapped = true;
    }
  }

  // If planner/model supplied a non-schema content alias (for example `body`) while
  // schema requires another key (for example `content`), we keep original key and
  // mirror into required/selected sink so execution gets the accepted field.
  if (existingField && selectedContentField && existingField !== selectedContentField && !hasText(out[selectedContentField])) {
    out[selectedContentField] = safeString(out[existingField]);
    mapped = true;
  }

  const populatedDirectValues = sinkKeys
    .map((k) => out[k])
    .filter((v) => hasText(v));
  const canonicalValue = pickBestContentValue([contentValue, ...populatedDirectValues]);
  if (selectedContentField && hasText(canonicalValue) && safeString(out[selectedContentField]) !== safeString(canonicalValue)) {
    out[selectedContentField] = canonicalValue;
    mapped = true;
  }
  for (const k of sinkKeys) {
    if (k === selectedContentField) continue;
    if (requiredDirectKeys.includes(k)) continue;
    if (!hasText(out[k])) continue;
    delete out[k];
    mapped = true;
  }

  return {
    args: out,
    mapped,
    selectedContentField,
    availableContentFields: sinkKeys,
    reason: mapped ? null : "already_mapped_or_present",
  };
}
