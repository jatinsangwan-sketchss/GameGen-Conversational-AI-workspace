#!/usr/bin/env node

/**
 * Isolated LLM smoke test for factory-js.
 *
 * What this proves:
 * 1) LLM backend/model selection is wired.
 * 2) Raw text generation works end to end.
 * 3) Prompt templates load/render through PromptBuilder.
 * 4) Structured JSON parse + schema validation works for normalized spec.
 * 5) Structured JSON parse + schema validation works for generation recipe.
 * 6) Intentional malformed-output path fails clearly (no false success).
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

import { createLLMClient } from "./llm/client.js";
import { PromptBuilder } from "./llm/prompt_builder.js";
import { parseValidateWithOneRepair } from "./llm/structured_output.js";

const THIS_FILE = fileURLToPath(import.meta.url);
const FACTORY_ROOT = path.dirname(THIS_FILE);
const PROMPTS_ROOT = path.resolve(FACTORY_ROOT, "prompts");
const SCHEMAS_ROOT = path.resolve(FACTORY_ROOT, "schemas");

const DEFAULT_MODEL = process.env.FACTORY_SMOKE_MODEL || "gpt-oss:20b";
const DEFAULT_LLM_CONFIG = {
  backend: process.env.FACTORY_SMOKE_BACKEND || "llama",
  llama: {
    host: process.env.FACTORY_SMOKE_LLAMA_HOST || "127.0.0.1",
    port: Number(process.env.FACTORY_SMOKE_LLAMA_PORT || 11434),
    timeout_seconds: Number(process.env.FACTORY_SMOKE_TIMEOUT_SECONDS || 90),
  },
};

async function main() {
  const model = getArgValue("--model") || DEFAULT_MODEL;
  const llmConfig = buildLlmConfigFromArgs();

  printHeader("Factory JS LLM Smoke Test");
  console.log(`Backend: ${llmConfig.backend}`);
  console.log(`Model:   ${model}`);
  if (llmConfig.backend === "llama") {
    console.log(
      `Endpoint: http://${llmConfig.llama.host}:${llmConfig.llama.port}/v1/chat/completions`
    );
  }
  console.log("");

  const sections = [];
  const llmClient = await runSection(sections, "Initialize shared LLM client", async () => {
    return createLLMClient(llmConfig);
  });

  await runSection(sections, "Simple text-generation smoke test", async () => {
    const prompt = [
      "You are in a smoke test.",
      'Reply with EXACT text: LLM_SMOKE_OK and then one short sentence.',
      "No JSON.",
    ].join("\n");
    const resp = await llmClient.generateText({ prompt, model, temperature: 0.0, maxTokens: 120 });
    console.log("Raw text output:");
    printBlock(resp.text);
    console.log(`Response backend/model: ${resp.backend}/${resp.model}`);
    if (!String(resp.text).includes("LLM_SMOKE_OK")) {
      throw new Error("Expected token 'LLM_SMOKE_OK' was not found in raw text output.");
    }
    return { chars: String(resp.text).length };
  });

  const normalizedResult = await runSection(
    sections,
    "Normalized-game-spec structured JSON smoke test",
    async () => runNormalizedSpecStructuredTest({ llmClient, model })
  );

  await runSection(sections, "Generation-recipe structured JSON smoke test", async () =>
    runGenerationRecipeStructuredTest({
      llmClient,
      model,
      normalizedSpec: normalizedResult?.parsed_data || sampleNormalizedSpec(),
    })
  );

  await runSection(sections, "Intentional malformed-output path test", async () => {
    const failingStubClient = {
      async generateText() {
        return { text: "still not valid json", backend: "stub", model: "stub" };
      },
    };
    const malformed = await parseValidateWithOneRepair({
      rawOutput: "not-json-at-all",
      schemaPath: path.resolve(SCHEMAS_ROOT, "normalized_game_spec.schema.json"),
      llmClient: failingStubClient,
      model: "stub",
      promptValues: {
        prd_text: "stub",
        gdd_text: "stub",
        ui_spec_text: "stub",
      },
      promptsRoot: PROMPTS_ROOT,
      temperature: 0.0,
    });

    console.log("Malformed-path result summary:");
    console.log(
      JSON.stringify(
        {
          ok: malformed.ok,
          repaired: malformed.repaired,
          parse_error_code: malformed.parse_error?.code ?? null,
          validation_ok: malformed.validation?.is_valid ?? null,
          repair_error: malformed.repair_error ?? null,
        },
        null,
        2
      )
    );

    if (malformed.ok) {
      throw new Error("Malformed-output test unexpectedly passed.");
    }
    return { expected_failure_observed: true };
  });

  printSummary(sections);
  const hasFailure = sections.some((s) => s.status === "FAIL");
  process.exitCode = hasFailure ? 1 : 0;
}

async function runNormalizedSpecStructuredTest({ llmClient, model }) {
  const builder = new PromptBuilder({ promptsRoot: PROMPTS_ROOT });
  const promptValues = {
    project_name: "SmokeRunner",
    platform: "pc",
    orientation: "landscape",
    constraints: JSON.stringify({ prototype_only: true }, null, 2),
    prd_text: "Build a tiny dodge prototype with score and fail/retry loop.",
    gdd_text:
      "Player dodges falling hazards. Score increases over time. Fail on collision. One gameplay scene.",
    ui_spec_text: "HUD shows score. A fail popup offers restart.",
  };

  // Proves prompt template loading + rendering path for spec ingest prompts.
  const rendered = builder.loadSystemUserPrompts({
    systemTemplatePath: "specs/normalized_game_spec_system.md",
    userTemplatePath: "specs/normalized_game_spec_prompt.md",
    values: promptValues,
  });

  const combinedPrompt = combinePromptPair(rendered);
  const rawResp = await llmClient.generateText({
    prompt: combinedPrompt,
    model,
    temperature: 0.0,
    maxTokens: 1400,
  });

  console.log("Raw normalized-spec output:");
  printBlock(rawResp.text);

  const structured = await parseValidateWithOneRepair({
    rawOutput: rawResp.text,
    schemaPath: path.resolve(SCHEMAS_ROOT, "normalized_game_spec.schema.json"),
    llmClient,
    model,
    promptValues: {
      prd_text: promptValues.prd_text,
      gdd_text: promptValues.gdd_text,
      ui_spec_text: promptValues.ui_spec_text,
    },
    promptsRoot: PROMPTS_ROOT,
    temperature: 0.0,
  });

  printStructuredSummary("normalized_spec", structured);
  if (!structured.ok || !structured.data) {
    throw new Error("Normalized-game-spec structured validation failed.");
  }
  return { parsed_data: structured.data };
}

async function runGenerationRecipeStructuredTest({ llmClient, model, normalizedSpec }) {
  const builder = new PromptBuilder({ promptsRoot: PROMPTS_ROOT });
  const promptValues = {
    starter_template: "ai-starter-template",
    target_path: "./artifacts/smoke/target/demo_game",
    normalized_game_spec_json: JSON.stringify(normalizedSpec, null, 2),
  };

  // Proves prompt template loading + rendering path for planner prompts.
  const rendered = builder.loadSystemUserPrompts({
    systemTemplatePath: "planning/generation_recipe_system.md",
    userTemplatePath: "planning/generation_recipe_prompt.md",
    values: promptValues,
  });

  const combinedPrompt = combinePromptPair(rendered);
  const rawResp = await llmClient.generateText({
    prompt: combinedPrompt,
    model,
    temperature: 0.0,
    maxTokens: 1600,
  });

  console.log("Raw generation-recipe output:");
  printBlock(rawResp.text);

  const structured = await parseValidateWithOneRepair({
    rawOutput: rawResp.text,
    schemaPath: path.resolve(SCHEMAS_ROOT, "generation_recipe.schema.json"),
    llmClient,
    model,
    promptValues: {
      prd_text: JSON.stringify(
        {
          starter_template: promptValues.starter_template,
          target_path: promptValues.target_path,
          normalized_spec: normalizedSpec,
        },
        null,
        2
      ),
      gdd_text: "",
      ui_spec_text: "",
    },
    promptsRoot: PROMPTS_ROOT,
    temperature: 0.0,
  });

  printStructuredSummary("generation_recipe", structured);
  if (!structured.ok || !structured.data) {
    throw new Error("Generation-recipe structured validation failed.");
  }
  return { parsed_data: structured.data };
}

async function runSection(results, title, fn) {
  const start = Date.now();
  console.log(`--- ${title} ---`);
  try {
    const data = await fn();
    const elapsedMs = Date.now() - start;
    console.log(`PASS (${elapsedMs} ms)\n`);
    results.push({ title, status: "PASS", elapsedMs });
    return data;
  } catch (err) {
    const elapsedMs = Date.now() - start;
    console.error(`FAIL (${elapsedMs} ms): ${err?.message ?? String(err)}\n`);
    results.push({ title, status: "FAIL", elapsedMs, error: err?.message ?? String(err) });
    return null;
  }
}

function buildLlmConfigFromArgs() {
  const backend = getArgValue("--backend") || DEFAULT_LLM_CONFIG.backend;
  const host = getArgValue("--host") || DEFAULT_LLM_CONFIG.llama.host;
  const port = Number(getArgValue("--port") || DEFAULT_LLM_CONFIG.llama.port);
  const timeoutSeconds = Number(
    getArgValue("--timeout-seconds") || DEFAULT_LLM_CONFIG.llama.timeout_seconds
  );
  return {
    backend,
    llama: { host, port, timeout_seconds: timeoutSeconds },
  };
}

function combinePromptPair({ system_prompt, user_prompt }) {
  return `SYSTEM INSTRUCTIONS:\n${String(system_prompt).trim()}\n\nUSER REQUEST:\n${String(
    user_prompt
  ).trim()}`;
}

function printStructuredSummary(label, structured) {
  const data = structured?.data;
  const summary = {
    label,
    ok: structured?.ok ?? false,
    repaired: structured?.repaired ?? false,
    validation_ok: structured?.validation?.is_valid ?? false,
    parse_error_code: structured?.parse_error?.code ?? null,
    error_count: Array.isArray(structured?.validation?.errors)
      ? structured.validation.errors.length
      : 0,
    top_level_keys:
      data && typeof data === "object" && !Array.isArray(data) ? Object.keys(data).slice(0, 10) : [],
  };
  console.log("Parsed + validated summary:");
  console.log(JSON.stringify(summary, null, 2));
}

function sampleNormalizedSpec() {
  return {
    project_name: "SmokeRunner",
    platform: "pc",
    orientation: "landscape",
    genre: "arcade",
    summary: "A tiny dodge prototype.",
    core_loop: "Move, dodge, score, fail, retry.",
    player_fantasy: "Survive a hazard storm.",
    input_model: { type: "keyboard", rules: ["Arrow keys move player"] },
    fail_condition: "Player collides with hazard.",
    score_model: "Score increases over time.",
    difficulty_model: "Spawn rate increases over time.",
    scenes: [{ name: "Gameplay", purpose: "Main loop and hazards" }],
    ui: {
      screens: ["Gameplay"],
      hud_elements: ["Score text"],
      layout_notes: ["Minimal top-left score display"],
    },
    entities: [{ name: "Player", role: "Avatar", behavior_notes: ["Moves and avoids hazards"] }],
    systems: ["Score manager"],
    out_of_scope: ["Progression", "Monetization"],
    acceptance_criteria: ["Game runs and score increments", "Fail on collision"],
    open_questions: [],
  };
}

function printSummary(sections) {
  printHeader("Section Results");
  for (const section of sections) {
    const line = `${section.status.padEnd(4)} ${section.title} (${section.elapsedMs} ms)`;
    console.log(line);
    if (section.error) console.log(`      error: ${section.error}`);
  }
  const passCount = sections.filter((s) => s.status === "PASS").length;
  const failCount = sections.length - passCount;
  console.log("");
  console.log(`Overall: ${failCount === 0 ? "PASS" : "FAIL"} (${passCount} passed, ${failCount} failed)`);
}

function printHeader(text) {
  console.log("=".repeat(text.length));
  console.log(text);
  console.log("=".repeat(text.length));
}

function printBlock(text) {
  const raw = String(text ?? "");
  const maxChars = 1400;
  const trimmed = raw.length > maxChars ? `${raw.slice(0, maxChars)}\n... [truncated]` : raw;
  console.log(trimmed);
}

function getArgValue(name) {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return null;
  return process.argv[idx + 1] ?? null;
}

main().catch((err) => {
  console.error("Fatal smoke-test failure:", err?.stack || err?.message || String(err));
  process.exitCode = 1;
});

