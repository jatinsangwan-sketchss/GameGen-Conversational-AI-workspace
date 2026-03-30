/**
 * LLM-based spec ingest for normalized game specs.
 *
 * Stage flow:
 * 1) Read PRD/GDD/UI source docs
 * 2) Build prompts from versioned template files under factory/prompts/specs/
 * 3) Call shared LLM client
 * 4) Parse/validate via shared structured-output helper (one repair attempt)
 * 5) Optionally persist normalized_game_spec.json artifact
 */

import fs from "node:fs";
import path from "node:path";

import { createLLMClient } from "./llm/client.js";
import { loadSystemUserPrompts } from "./llm/prompt_builder.js";
import { parseValidateWithOneRepair } from "./llm/structured_output.js";
import { loadJsonSchema } from "./schema_utils.js";

export const DEFAULT_SCHEMA_PATH = "factory-js/schemas/normalized_game_spec.schema.json";
export const DEFAULT_MODEL_NAME = "gpt-oss-20b";
export const DEFAULT_OUTPUT_FILENAME = "normalized_game_spec.json";
export const DEFAULT_PROMPTS_ROOT = "factory-js/prompts";

// Support both folder names, with "specs" preferred.
const DEFAULT_SYSTEM_PROMPT_PATH = "specs/normalized_game_spec_system.md";
const DEFAULT_USER_PROMPT_PATH = "specs/normalized_game_spec_prompt.md";
const FALLBACK_SYSTEM_PROMPT_PATH = "spec/normalized_game_spec_system.md";
const FALLBACK_USER_PROMPT_PATH = "spec/normalized_game_spec_prompt.md";

const DEFAULT_LLM_CONFIG = {
  backend: "llama",
  llama: { host: "127.0.0.1", port: 11434, timeout_seconds: 120 },
};

export async function ingestNormalizedSpec({
  projectName,
  prdPath,
  gddPath,
  uiSpecPath,
  platform,
  orientation = null,
  constraints = null,
  llmClient = null,
  llmConfig = null,
  modelName = DEFAULT_MODEL_NAME,
  schemaPath = DEFAULT_SCHEMA_PATH,
  promptsRoot = DEFAULT_PROMPTS_ROOT,
  systemPromptPath = null,
  userPromptPath = null,
  artifactsDir = null,
}) {
  const docs = readSourceDocuments({ prdPath, gddPath, uiSpecPath });
  const resolvedLLMClient =
    llmClient || (await createLLMClient(llmConfig || DEFAULT_LLM_CONFIG));

  const promptPair = resolvePromptPair({
    projectName,
    platform,
    orientation,
    constraints,
    docs,
    promptsRoot,
    systemPromptPath,
    userPromptPath,
  });

  const combinedPrompt = combinePromptsForSingleMessage({
    systemPrompt: promptPair.system_prompt,
    userPrompt: promptPair.user_prompt,
  });

  const llmResp = await resolvedLLMClient.generateText({
    prompt: combinedPrompt,
    model: modelName,
    temperature: 0.0,
  });

  const structured = await parseValidateWithOneRepair({
    rawOutput: llmResp.text,
    schemaPath,
    llmClient: resolvedLLMClient,
    model: modelName,
    promptValues: {
      prd_text: docs.prd_text,
      gdd_text: docs.gdd_text,
      ui_spec_text: docs.ui_spec_text,
    },
  });

  const normalizedSpec = structured.data;
  const validationResult =
    structured.validation || { is_valid: false, errors: [] };

  let outputPath = null;
  if (artifactsDir != null && normalizedSpec && typeof normalizedSpec === "object") {
    outputPath = saveNormalizedSpec({
      normalizedSpec,
      artifactsDir,
      filename: DEFAULT_OUTPUT_FILENAME,
    });
  }

  return {
    ok: Boolean(structured.ok),
    normalized_spec: normalizedSpec,
    validation: validationResult,
    parse_error: structured.parse_error,
    repaired: Boolean(structured.repaired),
    repair_error: structured.repair_error,
    output_path: outputPath,
  };
}

export function buildNormalizedSpec(params) {
  return ingestNormalizedSpec(params);
}

export function saveNormalizedSpec({ normalizedSpec, artifactsDir, filename }) {
  const outDir = path.resolve(String(artifactsDir));
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, filename);
  fs.writeFileSync(outPath, JSON.stringify(normalizedSpec, null, 2), "utf-8");
  return outPath;
}

function readSourceDocuments({ prdPath, gddPath, uiSpecPath }) {
  return {
    prd_text: readTextFile(prdPath, "PRD"),
    gdd_text: readTextFile(gddPath, "GDD"),
    ui_spec_text: readTextFile(uiSpecPath, "UI spec"),
  };
}

function readTextFile(filePath, label) {
  const resolved = path.resolve(String(filePath));
  if (!fs.existsSync(resolved)) throw new Error(`${label} file not found: ${resolved}`);
  const stat = fs.statSync(resolved);
  if (!stat.isFile()) throw new Error(`${label} path is not a file: ${resolved}`);
  const content = fs.readFileSync(resolved, "utf-8").trim();
  if (!content) throw new Error(`${label} file is empty: ${resolved}`);
  return content;
}

function resolvePromptPair({
  projectName,
  platform,
  orientation,
  constraints,
  docs,
  promptsRoot,
  systemPromptPath,
  userPromptPath,
}) {
  const values = {
    project_name: projectName,
    platform,
    orientation: orientation ?? "",
    constraints: JSON.stringify(constraints || {}, null, 2),
    ...docs,
  };

  const resolved = resolvePromptPaths({
    promptsRoot,
    systemPromptPath,
    userPromptPath,
  });

  return loadSystemUserPrompts({
    promptsRoot,
    systemTemplatePath: resolved.systemPrompt,
    userTemplatePath: resolved.userPrompt,
    values,
  });
}

function resolvePromptPaths({ promptsRoot, systemPromptPath, userPromptPath }) {
  if (systemPromptPath && userPromptPath) {
    return { systemPrompt: systemPromptPath, userPrompt: userPromptPath };
  }

  const root = path.resolve(String(promptsRoot));
  const defaultSystem = path.join(root, DEFAULT_SYSTEM_PROMPT_PATH);
  const defaultUser = path.join(root, DEFAULT_USER_PROMPT_PATH);
  if (fs.existsSync(defaultSystem) && fs.existsSync(defaultUser)) {
    return { systemPrompt: DEFAULT_SYSTEM_PROMPT_PATH, userPrompt: DEFAULT_USER_PROMPT_PATH };
  }

  const fallbackSystem = path.join(root, FALLBACK_SYSTEM_PROMPT_PATH);
  const fallbackUser = path.join(root, FALLBACK_USER_PROMPT_PATH);
  if (fs.existsSync(fallbackSystem) && fs.existsSync(fallbackUser)) {
    return { systemPrompt: FALLBACK_SYSTEM_PROMPT_PATH, userPrompt: FALLBACK_USER_PROMPT_PATH };
  }

  throw new Error(
    `Could not resolve spec prompt templates under prompts root '${root}'. Expected either ` +
      `'${DEFAULT_SYSTEM_PROMPT_PATH}' + '${DEFAULT_USER_PROMPT_PATH}' or ` +
      `'${FALLBACK_SYSTEM_PROMPT_PATH}' + '${FALLBACK_USER_PROMPT_PATH}'.`
  );
}

function combinePromptsForSingleMessage({ systemPrompt, userPrompt }) {
  return (
    "SYSTEM INSTRUCTIONS:\n" +
    systemPrompt.trim() +
    "\n\nUSER REQUEST:\n" +
    userPrompt.trim()
  );
}

