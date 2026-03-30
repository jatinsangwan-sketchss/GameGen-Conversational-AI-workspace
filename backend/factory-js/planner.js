/**
 * LLM-driven planner for generation recipe creation.
 *
 * Stage flow:
 * 1) Read normalized game spec input (dict or JSON file)
 * 2) Build planning prompts from factory/prompts/planning/
 * 3) Call shared LLM client
 * 4) Parse/validate through structured-output helper (one repair try)
 * 5) Optionally persist generation_recipe.json
 */

import fs from "node:fs";
import path from "node:path";

import { createLLMClient } from "./llm/client.js";
import { loadSystemUserPrompts } from "./llm/prompt_builder.js";
import { parseValidateWithOneRepair } from "./llm/structured_output.js";

export const DEFAULT_RECIPE_SCHEMA_PATH =
  "factory-js/schemas/generation_recipe.schema.json";
export const DEFAULT_RECIPE_FILENAME = "generation_recipe.json";
export const DEFAULT_PROMPTS_ROOT = "factory-js/prompts";

const DEFAULT_SYSTEM_PROMPT_PATH = "planning/generation_recipe_system.md";
const DEFAULT_USER_PROMPT_PATH = "planning/generation_recipe_prompt.md";

const DEFAULT_LLM_CONFIG = {
  backend: "llama",
  llama: { host: "127.0.0.1", port: 11434, timeout_seconds: 120 },
};

const DEFAULT_MODEL_NAME = "gpt-oss-20b";

export async function buildGenerationRecipe({
  normalizedSpec = null,
  normalizedSpecPath = null,
  starterTemplate,
  targetPath,
  milestone = null,
  constraints = null,
  llmClient = null,
  llmConfig = null,
  modelName = DEFAULT_MODEL_NAME,
  schemaPath = DEFAULT_RECIPE_SCHEMA_PATH,
  promptsRoot = DEFAULT_PROMPTS_ROOT,
  systemPromptPath = null,
  userPromptPath = null,
  artifactsDir = null,
}) {
  const spec = resolveNormalizedSpec({ normalizedSpec, normalizedSpecPath });
  const resolvedLLMClient =
    llmClient || (await createLLMClient(llmConfig || DEFAULT_LLM_CONFIG));

  const promptPair = loadPlanningPrompts({
    promptsRoot,
    normalizedSpec: spec,
    starterTemplate,
    targetPath,
    milestone,
    constraints,
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

  // Reuse the generic repair prompt by injecting planner context
  const repairPromptValues = {
    prd_text: JSON.stringify(
      { starter_template: starterTemplate, target_path: targetPath, normalized_spec: spec },
      null,
      2
    ),
    gdd_text: "",
    ui_spec_text: "",
  };

  const structured = await parseValidateWithOneRepair({
    rawOutput: llmResp.text,
    schemaPath,
    llmClient: resolvedLLMClient,
    model: modelName,
    promptValues: repairPromptValues,
  });

  const recipe = structured.data;
  const validation = structured.validation || { is_valid: false, errors: [] };

  let outputPath = null;
  if (artifactsDir != null && recipe && typeof recipe === "object") {
    outputPath = saveGenerationRecipe({
      recipe,
      artifactsDir,
      filename: DEFAULT_RECIPE_FILENAME,
    });
  }

  return {
    ok: Boolean(structured.ok),
    generation_recipe: recipe,
    validation,
    parse_error: structured.parse_error,
    repaired: Boolean(structured.repaired),
    repair_error: structured.repair_error,
    output_path: outputPath,
  };
}

export function saveGenerationRecipe({ recipe, artifactsDir, filename }) {
  const outDir = path.resolve(String(artifactsDir));
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, filename);
  fs.writeFileSync(outPath, JSON.stringify(recipe, null, 2), "utf-8");
  return outPath;
}

function resolveNormalizedSpec({ normalizedSpec, normalizedSpecPath }) {
  if (normalizedSpec != null) {
    if (!isPlainObject(normalizedSpec)) {
      throw new Error("normalizedSpec must be a plain object.");
    }
    return normalizedSpec;
  }
  if (!normalizedSpecPath) {
    throw new Error("Provide either normalizedSpec or normalizedSpecPath.");
  }
  const resolved = path.resolve(String(normalizedSpecPath));
  if (!fs.existsSync(resolved)) throw new Error(`Normalized spec file not found: ${resolved}`);
  const stat = fs.statSync(resolved);
  if (!stat.isFile()) throw new Error(`Normalized spec path is not a file: ${resolved}`);
  try {
    const parsed = JSON.parse(fs.readFileSync(resolved, "utf-8"));
    if (!isPlainObject(parsed)) throw new Error("Normalized spec root must be an object.");
    return parsed;
  } catch (err) {
    throw new Error(`Invalid JSON in normalized spec file '${resolved}': ${err}`);
  }
}

function loadPlanningPrompts({
  promptsRoot,
  normalizedSpec,
  starterTemplate,
  targetPath,
  milestone,
  constraints,
  systemPromptPath,
  userPromptPath,
}) {
  const values = {
    starter_template: starterTemplate,
    target_path: targetPath,
    normalized_game_spec_json: JSON.stringify(normalizedSpec, null, 2),
    milestone: milestone || "",
    constraints: JSON.stringify(constraints || {}, null, 2),
  };

  const resolvedSystem = systemPromptPath || DEFAULT_SYSTEM_PROMPT_PATH;
  const resolvedUser = userPromptPath || DEFAULT_USER_PROMPT_PATH;

  return loadSystemUserPrompts({
    promptsRoot,
    systemTemplatePath: resolvedSystem,
    userTemplatePath: resolvedUser,
    values,
  });
}

function combinePromptsForSingleMessage({ systemPrompt, userPrompt }) {
  return (
    "SYSTEM INSTRUCTIONS:\n" +
    systemPrompt.trim() +
    "\n\nUSER REQUEST:\n" +
    userPrompt.trim()
  );
}

function isPlainObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

