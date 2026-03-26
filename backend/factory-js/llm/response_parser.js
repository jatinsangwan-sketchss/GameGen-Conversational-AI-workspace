/**
 * Parse raw LLM output into a JSON object.
 *
 * Supports:
 * - plain JSON objects
 * - fenced JSON blocks: ```json { ... } ```
 * - JSON embedded in surrounding text (first {...} to last {...})
 */

export class ResponseParseError extends Error {
  constructor({ code, message, rawText }) {
    super(message);
    this.code = code;
    this.rawText = rawText;
  }

  toJSON() {
    return { code: this.code, message: this.message, raw_text: this.rawText };
  }
}

const JSON_BLOCK_RE = /```(?:json)?\s*(\{.*\})\s*```/s;

export function parseJsonObject(rawText) {
  if (typeof rawText !== "string") {
    throw new ResponseParseError({
      code: "invalid_type",
      message: `Expected rawText to be str, got ${typeof rawText}.`,
      rawText: String(rawText),
    });
  }

  const text = rawText.trim();
  if (!text) {
    throw new ResponseParseError({
      code: "empty_output",
      message: "Model output is empty.",
      rawText,
    });
  }

  const candidate = extractJsonPayload(text);
  let parsed;
  try {
    parsed = JSON.parse(candidate);
  } catch (err) {
    throw new ResponseParseError({
      code: "invalid_json",
      message: `Failed to decode JSON: ${err}`,
      rawText,
    });
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ResponseParseError({
      code: "non_object_json",
      message: "JSON output must be an object.",
      rawText,
    });
  }

  return parsed;
}

export function parseJsonPayloadFromText(text) {
  // Convenience alias to keep BaseLLMClient JSON parsing small.
  return parseJsonObject(text);
}

function extractJsonPayload(text) {
  const fencedMatch = text.match(JSON_BLOCK_RE);
  if (fencedMatch && fencedMatch[1]) return fencedMatch[1];

  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || start >= end) {
    throw new ResponseParseError({
      code: "json_not_found",
      message: "Could not find JSON object braces in model output.",
      rawText: text,
    });
  }
  return text.slice(start, end + 1);
}

