/**
 * ChangePlanner
 * --------------
 * Converts a conversational edit request into a structured, conservative
 * change plan. This plan is intentionally not executable here:
 * it must be consumed by a later orchestrator/executor that will:
 * - apply source-of-truth updates (patches)
 * - execute MCP/CLI actions
 * - run validation steps
 *
 * Why structured planning first?
 * - We never mutate the Godot project directly from raw chat text.
 * - We separate canonical artifact updates from project edits so the system
 *   can validate/parity-check changes before acting.
 */

import { validateDataAgainstSchema } from "../../schema_utils.js";
import { createLLMClient } from "../../llm/client.js";
import fs from "node:fs";
import path from "node:path";

const CHANGE_PLAN_SCHEMA = {
  type: "object",
  required: [
    "intent_summary",
    "source_of_truth_updates",
    "affected_project_files",
    "file_changes",
    "mcp_actions",
    "cli_actions",
    "validation_steps",
  ],
  properties: {
    intent_summary: { type: "string" },
    source_of_truth_updates: {
      type: "object",
      required: ["normalized_game_spec_patch", "generation_recipe_patch", "project_state_patch"],
      properties: {
        normalized_game_spec_patch: { type: ["object", "null"] },
        generation_recipe_patch: { type: ["object", "null"] },
        project_state_patch: { type: ["object", "null"] },
      },
    },
    affected_project_files: {
      type: "array",
      items: { type: "string" },
    },
    file_changes: {
      type: "array",
      items: {
        type: "object",
        required: ["type", "path"],
        properties: {
          type: { type: "string" },
          path: { type: "string" },
          content: { type: ["string", "null"] },
          notes: { type: ["string", "null"] },
          target: { type: ["object", "null"] },
        },
      },
    },
    mcp_actions: {
      type: "array",
      items: {
        type: "object",
        required: ["action", "params"],
        properties: {
          action: { type: "string" },
          params: { type: "object" },
        },
      },
    },
    cli_actions: {
      type: "array",
      items: {
        type: "object",
        required: ["action"],
        properties: {
          action: { type: "string" },
          cliArgs: { type: "array" },
          params: { type: "object" },
          timeoutSeconds: { type: ["number", "null"] },
        },
      },
    },
    validation_steps: {
      type: "array",
      items: {
        type: "object",
        required: ["id", "type"],
        properties: {
          id: { type: "string" },
          type: { type: "string" },
          description: { type: "string" },
          params: { type: "object" },
        },
      },
    },
    risks: { type: "array", items: { type: "string" } },
    created_at: { type: "string" },
    // Back-compat for ChangeExecutor (executor currently consumes required_* keys).
    required_mcp_actions: { type: "array" },
    required_cli_actions: { type: "array" },
  },
};

function isPlainObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function safeString(v) {
  return v == null ? "" : String(v);
}

function nowIso() {
  return new Date().toISOString();
}

function buildConservativeFallbackPlan({ userRequestText, workspace }) {
  const statePatch = {
    last_user_request: safeString(userRequestText),
    last_planned_intent: "unknown_or_needs_clarification",
  };

  // Conservative baseline:
  // - only update project_state (so future turns can reference what was asked)
  // - run bounded validation so we know if the project is still structurally sane
  return {
    intent_summary: "Update conversation state; no canonical/spec/project mutations planned yet.",
    source_of_truth_updates: {
      normalized_game_spec_patch: null,
      generation_recipe_patch: null,
      project_state_patch: statePatch,
    },
    affected_project_files: [],
    file_changes: [],
    mcp_actions: [],
    cli_actions: [],
    validation_steps: [
      {
        id: "post_change_bounded_validation",
        type: "bounded_validation",
        description: "Run v1 bounded runtime validation (headless quit) to confirm project startup.",
      },
    ],
    risks: [
      "Request could not be mapped deterministically without LLM planning; only state update will be applied.",
      "No source-of-truth changes were proposed for this plan.",
    ],
    created_at: nowIso(),
  };
}

function buildProjectNameChangePlan({ newProjectName, userRequestText, workspace }) {
  const statePatch = {
    last_user_request: safeString(userRequestText),
    last_planned_intent: "update_project_name",
  };

  // Canonical artifacts to update:
  // - normalized_game_spec.project_name
  // - generation_recipe.project_name (v1 schema requires it)
  const normalizedPatch = { project_name: newProjectName };
  const recipePatch = { project_name: newProjectName };

  // Project mutation separation:
  // - a later executor can call ProjectMetadataUpdater to edit project.godot.
  // - no MCP actions are required for this v1 name reflection.
  return {
    intent_summary: `Update project name to "${newProjectName}" in canonical artifacts and reflect into project.godot.`,
    source_of_truth_updates: {
      normalized_game_spec_patch: normalizedPatch,
      generation_recipe_patch: recipePatch,
      project_state_patch: statePatch,
    },
    affected_project_files: ["project.godot"],
    file_changes: [],
    mcp_actions: [],
    cli_actions: [],
    validation_steps: [
      {
        id: "post_change_bounded_validation",
        type: "bounded_validation",
        description: "Run v1 bounded runtime validation after metadata + canonical updates.",
      },
    ],
    risks: [
      "Name reflection into project.godot requires a file-level updater step in the execution layer.",
    ],
    created_at: nowIso(),
  };
}

function extractQuotedName(text) {
  const patterns = [
    /["“](.+?)["”]/,
    /(?:project\s*name|game\s*name|app\s*name)\s*(?:to|=|:)?\s*["“](.+?)["”]/i,
  ];
  for (const re of patterns) {
    const m = String(text ?? "").match(re);
    if (m && m[1]) return m[1].trim();
  }
  return null;
}

// Intent detection and payload extraction are separate:
// - Intent detection is only about whether this request is trying to add
//   a boot/startup print/log.
// - Payload extraction extracts the quoted payload literally (including
//   punctuation/commas) so the plan remains stable across wording variants.
const QUOTE_PAIRS = Object.freeze([
  { open: "“", close: "”" },
  { open: "‘", close: "’" },
  { open: "'", close: "'" },
  { open: '"', close: '"' },
]);

function extractFirstQuotedString(text, { startIndex = 0 } = {}) {
  const s = String(text ?? "");
  if (startIndex < 0) startIndex = 0;

  // Find earliest opening quote among supported quote delimiters.
  let best = null; // { open, close, idx }
  for (const pair of QUOTE_PAIRS) {
    const idx = s.indexOf(pair.open, startIndex);
    if (idx === -1) continue;
    if (best == null || idx < best.idx) best = { ...pair, idx };
  }

  if (!best) return null;

  const afterOpen = best.idx + best.open.length;
  const endIdx = s.indexOf(best.close, afterOpen);
  if (endIdx === -1) return null;

  // Preserve content literally; trimming is applied only to remove
  // accidental leading/trailing whitespace around the quotes.
  return s.slice(afterOpen, endIdx).trim();
}

function findFirstBootPrintKeywordIndex(text) {
  const s = String(text ?? "");
  const lower = s.toLowerCase();

  const candidates = [
    { re: /\bprints?\b/i, label: "print" },
    { re: /\blogs?\b/i, label: "log" },
    { re: /\bmessage(s)?\b/i, label: "message" },
  ];

  let bestIdx = null;
  for (const c of candidates) {
    const m = c.re.exec(lower);
    if (!m) continue;
    const idx = m.index;
    if (bestIdx == null || idx < bestIdx) bestIdx = idx;
  }
  return bestIdx;
}

function looksLikeBootSceneStartupPrintRequest(text) {
  const t = safeString(text).toLowerCase();

  // Conservative intent mapping: must mention boot/startup AND print/log.
  const bootish =
    t.includes("boot") ||
    t.includes("startup") ||
    t.includes("project starts") ||
    t.includes("on start") ||
    t.includes("when the project starts");

  const printish = /\bprint(s|ed)?\b/i.test(t) || /\blogs(s|ed)?\b/i.test(t);

  return Boolean(bootish && printish);
}

function extractBootPrintPayload(text) {
  // Payload extraction must preserve commas/punctuation inside the quoted
  // string. We look for the first quoted string after a `print/prints` or
  // `log/logs` keyword; if none exists, we fall back to the first quoted
  // string anywhere in the request.
  const keywordIdx = findFirstBootPrintKeywordIndex(text);
  if (keywordIdx != null) {
    const afterKeyword = keywordIdx + 1;
    const payload = extractFirstQuotedString(text, { startIndex: afterKeyword });
    if (payload != null) return payload;
  }

  return extractFirstQuotedString(text, { startIndex: 0 });
}

function inferBootSceneRelativePath({ projectRoot }) {
  const candidates = [
    "scenes/boot/boot_scene.tscn",
    "scenes/boot_scene.tscn",
    "scenes/boot/boot.tscn",
    "scenes/boot.tscn",
  ];

  if (!projectRoot) return candidates[0];

  for (const rel of candidates) {
    const abs = path.join(String(projectRoot), rel);
    try {
      if (fs.existsSync(abs) && fs.statSync(abs).isFile()) return rel;
    } catch {
      // Best-effort inference only.
    }
  }

  return candidates[0];
}

function readFirstNodeNameFromTscn({ tscnAbsPath }) {
  try {
    const raw = fs.readFileSync(tscnAbsPath, "utf-8");
    const lines = raw.split("\n");
    for (const line of lines) {
      // Match `[node name="X" type="Y" ...]` even when additional attributes exist.
      const m = line.match(/^\s*\[node\s+name="([^"]+)"\s+type="([^"]+)"[^\]]*\]/);
      if (m && m[1]) return m[1];
    }
  } catch {
    // ignore
  }
  return "Root";
}

function buildBootScenePrintPlan({ userRequestText, workspace, message, boundedValidationSeconds, strictValidation }) {
  const projectRoot = workspace?.project_root ?? workspace?.projectRoot ?? null;
  const bootSceneRelPath = inferBootSceneRelativePath({ projectRoot });
  const bootSceneAbsPath = projectRoot ? path.join(String(projectRoot), bootSceneRelPath) : null;

  const rootNodeName = bootSceneAbsPath
    ? readFirstNodeNameFromTscn({ tscnAbsPath: bootSceneAbsPath })
    : "Root";

  // v1 note:
  // - This planner describes concrete script/scene edits via `file_changes`.
  // - The execution layer is responsible for applying those file changes
  //   to the generated project before running validation.
  const scriptRelPath = "scripts/BootPrintHelloWorld.gd";
  const scriptResPath = `res://${scriptRelPath.replace(/^[./]+/, "")}`;

  const scriptContent = [
    "extends Node",
    "",
    "func _ready() -> void:",
    `    print(${JSON.stringify(message)})`,
    "",
  ].join("\n");

  return {
    intent_summary: "Add a startup print/log to the boot scene by attaching a tiny script to the boot root.",
    source_of_truth_updates: {
      normalized_game_spec_patch: null,
      generation_recipe_patch: null,
      project_state_patch: {
        last_user_request: safeString(userRequestText),
        last_planned_intent: "boot_scene_print_payload",
        boot_print_message: message,
        // Edit-proof targets used by the validator to confirm the mutation happened.
        boot_scene_rel_path: bootSceneRelPath,
        boot_print_script_rel_path: scriptRelPath,
        boot_print_script_res_path: scriptResPath,
        boot_print_root_node_name: rootNodeName,
      },
    },
    affected_project_files: [bootSceneRelPath, scriptRelPath],
    file_changes: [
      {
        type: "script_create",
        path: scriptRelPath,
        content: scriptContent,
        notes: "Create a script whose _ready() prints the requested message.",
      },
      {
        type: "scene_attach_script",
        path: bootSceneRelPath,
        content: null,
        notes: "Attach the script to the boot scene's root node (or best-effort inferred root).",
        target: { nodeName: rootNodeName, scriptPath: scriptRelPath },
      },
    ],
    // Gold-standard edit contract:
    // 1) create the script file on disk
    // 2) attach it to the boot scene root via MCP
    // 3) save the scene via MCP
    //
    // The ChangeExecutor is responsible for applying this plan in order and
    // the Validator is responsible for proving the edit took effect.
    mcp_actions: [
      {
        action: "attach_script",
        params: {
          scenePath: bootSceneRelPath,
          nodeName: rootNodeName,
          scriptPath: scriptRelPath,
        },
      },
      {
        action: "save_scene",
        params: { scenePath: bootSceneRelPath },
      },
    ],
    cli_actions: [],
    validation_steps: [
      {
        id: "post_change_bounded_validation",
        type: "bounded_validation",
        description: "Run bounded validation after the proposed boot-scene script change.",
      },
    ],
    risks: [
      "This plan relies on best-effort inference of the boot scene path and root node name from a .tscn file.",
      "If MCP scene attachment fails, the validator should detect that the boot scene does not reference the script or that the message is not emitted at runtime.",
    ],
    created_at: nowIso(),
  };
}

function validatePlan(plan) {
  if (!isPlainObject(plan)) return { ok: false, error: "Change plan must be a JSON object." };
  const validation = validateDataAgainstSchema(plan, CHANGE_PLAN_SCHEMA);
  if (validation.is_valid) return { ok: true };
  return {
    ok: false,
    error: "Change plan schema validation failed.",
    details: validation.errors ?? [],
  };
}

function buildLLMPrompt({ userRequestText, workspace }) {
  // Keep prompt compact: model must output JSON matching our plan schema.
  const specName = workspace?.normalizedGameSpec?.project_name ?? null;
  const recipeName = workspace?.generationRecipe?.project_name ?? null;
  const state = workspace?.projectState ?? null;

  return [
    "You are a conservative planner for conversational edits to a Godot project.",
    "Return ONLY valid JSON that matches the requested output shape.",
    "",
    "Rules:",
    "- Populate `intent_summary` with a short description of what you plan to do.",
    "- Use `source_of_truth_updates` for canonical JSON artifact changes (or set all to null for project-only edits).",
    "- Use `file_changes` for concrete script/scene file edits you can infer (script creation, script attachment, node edits, etc).",
    "- Populate `mcp_actions` and `cli_actions` arrays explicitly. If you can't infer safe MCP/CLI actions, keep them as empty arrays.",
    "- Keep `affected_project_files` in sync with your `file_changes` targets.",
    "- Include at least one `validation_steps` entry (use bounded_validation).",
    "",
    "Context:",
    `- Current normalized_game_spec.project_name: ${specName}`,
    `- Current generation_recipe.project_name: ${recipeName}`,
    `- Current project_state keys: ${state && isPlainObject(state) ? Object.keys(state).join(", ") : "none"}`,
    "",
    "User request:",
    safeString(userRequestText),
    "",
    "If the request is about changing the project name, output patches for:",
    "- normalized_game_spec_patch.project_name",
    "- generation_recipe_patch.project_name",
    "and set affected_project_files to include project.godot.",
    "",
    "Output JSON:",
  ].join("\n");
}

export async function planChange({
  workspace,
  userRequestText,
  llmClient = null,
  llmConfig = null,
  modelName = "gpt-oss:20b",
  boundedValidationSeconds = 5,
  strictValidation = false,
} = {}) {
  if (!workspace || !isPlainObject(workspace)) {
    return { ok: false, error: "workspace must be provided as a JSON object." };
  }
  if (!userRequestText || !safeString(userRequestText).trim()) {
    return { ok: false, error: "userRequestText must be a non-empty string." };
  }

  // Deterministic micro-intent: project name update.
  const quoted = extractQuotedName(userRequestText);
  const requestLower = safeString(userRequestText).toLowerCase();
  const looksLikeProjectNameRequest =
    requestLower.includes("project name") ||
    requestLower.includes("game name") ||
    requestLower.includes("app name") ||
    requestLower.includes("call it") ||
    requestLower.includes("rename");

  if (looksLikeProjectNameRequest && quoted) {
    const plan = buildProjectNameChangePlan({
      newProjectName: quoted,
      userRequestText,
      workspace,
    });
    const validated = validatePlan(plan);
    if (!validated.ok) return { ok: false, error: validated.error, details: validated.details };
    // Executor compatibility: it consumes required_* action arrays.
    plan.required_mcp_actions = plan.mcp_actions;
    plan.required_cli_actions = plan.cli_actions;

    // Attach runtime validation params for the executor layer.
    plan.validation_steps = plan.validation_steps.map((s) => ({
      ...s,
      params: {
        ...(s.params || {}),
        boundedRunSeconds: boundedValidationSeconds,
        strict: strictValidation,
      },
    }));
    return { ok: true, plan };
  }

  // Deterministic micro-intent: boot/startup print/log with optional quoted payload.
  // This is the class of requests that tends to vary only in punctuation/wording,
  // so we must extract the payload literally and avoid brittle regex matching.
  if (looksLikeBootSceneStartupPrintRequest(userRequestText)) {
    const extracted = extractBootPrintPayload(userRequestText);
    const message = extracted ?? "Hello World";

    const plan = buildBootScenePrintPlan({
      userRequestText,
      workspace,
      message,
      boundedValidationSeconds,
      strictValidation,
    });
    const validated = validatePlan(plan);
    if (!validated.ok) return { ok: false, error: validated.error, details: validated.details };

    plan.required_mcp_actions = plan.mcp_actions;
    plan.required_cli_actions = plan.cli_actions;
    plan.validation_steps = plan.validation_steps.map((s) => ({
      ...s,
      params: {
        ...(s.params || {}),
        boundedRunSeconds: boundedValidationSeconds,
        strict: strictValidation,
      },
    }));
    return { ok: true, plan };
  }

  // If we can’t map deterministically, try LLM if available.
  if (llmClient == null && llmConfig != null) {
    try {
      llmClient = await createLLMClient(llmConfig);
    } catch (err) {
      // Fall back to conservative plan below.
    }
  }

  if (llmClient && typeof llmClient.generateJson === "function") {
    const prompt = buildLLMPrompt({ userRequestText, workspace });
    let llmPlan;
    try {
      llmPlan = await llmClient.generateJson({
        prompt,
        model: modelName,
        temperature: 0.0,
      });
    } catch (err) {
      // Fall back to conservative plan.
      const fallback = buildConservativeFallbackPlan({ userRequestText, workspace });
      fallback.required_mcp_actions = fallback.mcp_actions;
      fallback.required_cli_actions = fallback.cli_actions;
      fallback.validation_steps = fallback.validation_steps.map((s) => ({
        ...s,
        params: {
          ...(s.params || {}),
          boundedRunSeconds: boundedValidationSeconds,
          strict: strictValidation,
        },
      }));
      return { ok: true, plan: fallback };
    }

    const validated = validatePlan(llmPlan);
    if (!validated.ok) {
      // Keep edit-mode resilient: when LLM outputs invalid plan JSON, fall back.
      const fallback = buildConservativeFallbackPlan({ userRequestText, workspace });
      fallback.required_mcp_actions = fallback.mcp_actions;
      fallback.required_cli_actions = fallback.cli_actions;
      fallback.validation_steps = fallback.validation_steps.map((s) => ({
        ...s,
        params: {
          ...(s.params || {}),
          boundedRunSeconds: boundedValidationSeconds,
          strict: strictValidation,
        },
      }));
      return { ok: true, plan: fallback };
    }

    // Add executor parameters for runtime validation steps (executor layer uses them).
    llmPlan.required_mcp_actions = llmPlan.mcp_actions;
    llmPlan.required_cli_actions = llmPlan.cli_actions;
    llmPlan.validation_steps = llmPlan.validation_steps.map((s) => ({
      ...s,
      params: {
        ...(s.params || {}),
        boundedRunSeconds: boundedValidationSeconds,
        strict: strictValidation,
      },
    }));

    return { ok: true, plan: llmPlan };
  }

  // No LLM: return a conservative fallback plan.
  const fallback = buildConservativeFallbackPlan({ userRequestText, workspace });
  fallback.required_mcp_actions = fallback.mcp_actions;
  fallback.required_cli_actions = fallback.cli_actions;
  fallback.validation_steps = fallback.validation_steps.map((s) => ({
    ...s,
    params: {
      ...(s.params || {}),
      boundedRunSeconds: boundedValidationSeconds,
      strict: strictValidation,
    },
  }));
  return { ok: true, plan: fallback };
}

