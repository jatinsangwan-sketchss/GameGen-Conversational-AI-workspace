/**
 * Structured output parsing + one repair attempt.
 *
 * Flow:
 * 1) Parse raw text -> JSON object
 * 2) Validate JSON object against schema
 * 3) If invalid, run one repair prompt via llm_client.generateText
 * 4) Re-parse + re-validate
 */

import { loadJsonSchema, validateDataAgainstSchema } from "../schema_utils.js";
import { PromptBuilder } from "./prompt_builder.js";
import { parseJsonObject, ResponseParseError } from "./response_parser.js";

export const DEFAULT_REPAIR_PROMPT_PATH = "specs/fix_invalid_json_prompt.md";

function parseAndValidateJsonOutput({ rawOutput, schema }) {
  const [parsed, parseErr] = tryParse(rawOutput);
  if (parseErr) {
    return {
      ok: false,
      data: null,
      parse_error: parseErr,
      validation: { is_valid: false, errors: [] },
      repaired: false,
      repair_error: undefined,
    };
  }

  const validation = validateDataAgainstSchema(parsed, schema);
  return {
    ok: validation.is_valid,
    data: parsed,
    parse_error: null,
    validation,
    repaired: false,
    repair_error: undefined,
  };
}

export async function parseValidateWithOneRepair({
  rawOutput,
  schemaPath,
  llmClient,
  model,
  promptValues,
  repairPromptPath = DEFAULT_REPAIR_PROMPT_PATH,
  promptsRoot = "factory/prompts",
  temperature = 0.0,
  maxTokens = undefined,
}) {
  const schema = loadJsonSchema(schemaPath);

  const first = parseAndValidateJsonOutput({ rawOutput, schema });
  if (first.ok) return toResultDict(first);

  const repairPrompt = buildRepairPrompt({
    promptValues,
    firstPass: first,
    repairPromptPath,
    promptsRoot,
  });

  const repairedResp = await llmClient.generateText({
    prompt: repairPrompt,
    model,
    temperature,
    maxTokens,
  });

  const repairedPass = parseAndValidateJsonOutput({ rawOutput: repairedResp.text, schema });
  if (repairedPass.ok) {
    return {
      ok: true,
      data: repairedPass.data,
      parse_error: null,
      validation: repairedPass.validation,
      repaired: true,
      repair_error: undefined,
    };
  }

  return {
    ok: false,
    data: repairedPass.data,
    parse_error: repairedPass.parse_error,
    validation: repairedPass.validation,
    repaired: true,
    repair_error: "Repair attempt completed but output is still invalid.",
  };
}

function toResultDict(result) {
  return {
    ok: result.ok,
    data: result.data,
    parse_error: result.parse_error,
    validation: result.validation,
    repaired: result.repaired,
    repair_error: result.repair_error,
  };
}

function tryParse(rawOutput) {
  try {
    const parsed = parseJsonObject(rawOutput);
    return [parsed, null];
  } catch (err) {
    if (err instanceof ResponseParseError) {
      return [null, { code: err.code, message: err.message, raw_text: err.rawText }];
    }
    throw err;
  }
}

function buildRepairPrompt({ promptValues, firstPass, repairPromptPath, promptsRoot }) {
  const builder = new PromptBuilder({ promptsRoot });
  const schemaErrors = formatSchemaErrors(firstPass.validation);
  const previousJson = formatPreviousJson(firstPass);

  const values = { ...promptValues };
  values.schema_errors = schemaErrors;
  values.previous_json = previousJson;

  return builder.loadAndRender(repairPromptPath, values);
}

function formatSchemaErrors(validation) {
  const errors = validation?.errors;
  if (!Array.isArray(errors) || errors.length === 0) return "No schema errors available.";

  const lines = [];
  for (const err of errors) {
    if (!err || typeof err !== "object") continue;
    const pathArr = Array.isArray(err.path) ? err.path : [];
    const path = pathArr.join(".");
    const message = String(err.message ?? "unknown validation error");
    lines.push(path ? `- ${path}: ${message}` : `- ${message}`);
  }
  return lines.length ? lines.join("\n") : "No schema errors available.";
}

function formatPreviousJson(firstPass) {
  if (firstPass.data != null) return JSON.stringify(firstPass.data, null, 2);
  if (firstPass.parse_error) return String(firstPass.parse_error.raw_text ?? "");
  return "";
}

