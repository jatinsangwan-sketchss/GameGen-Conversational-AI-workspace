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

function getGeneratedContentValue({ args = null, workflowState = null } = {}) {
  const a = isPlainObject(args) ? args : {};
  const ss = isPlainObject(workflowState?.semanticState) ? workflowState.semanticState : {};
  const candidates = [
    a.content,
    a.body,
    a.source,
    a.text,
    a.code,
    a.snippet,
    a.generatedCode,
    ss.generatedCode,
    ss.generatedContent?.content,
  ];
  for (const c of candidates) {
    if (hasText(c)) return safeString(c);
  }
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
  if (directKeys.length < 1) {
    return {
      args: out,
      mapped: false,
      selectedContentField: null,
      availableContentFields: [],
      reason: "no_direct_content_sink",
    };
  }

  const required = getRequired(schema);
  const requiredDirectKeys = required.filter((k) => directKeys.includes(k));
  const selectedContentField =
    pickPreferredKey(requiredDirectKeys) ||
    pickPreferredKey(directKeys);
  const existingField = directKeys.find((k) => hasText(out[k])) || null;
  const contentValue = getGeneratedContentValue({ args: out, workflowState });

  if (!hasText(contentValue)) {
    return {
      args: out,
      mapped: false,
      selectedContentField,
      availableContentFields: directKeys,
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

  return {
    args: out,
    mapped,
    selectedContentField,
    availableContentFields: directKeys,
    reason: mapped ? null : "already_mapped_or_present",
  };
}
