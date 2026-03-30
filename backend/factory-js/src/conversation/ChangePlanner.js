/**
 * ChangePlanner
 * --------------
 * Converts conversational text into a validated JSON change plan.
 *
 * Key contract:
 * - This module PLANS only (no project mutations).
 * - Normal edit requests go through the shared LLM path.
 * - LLM output must satisfy a strict schema before execution can continue.
 */

import { validateDataAgainstSchema } from "../../schema_utils.js";
import { createLLMClient } from "../../llm/client.js";
import { parseJsonObject } from "../../llm/response_parser.js";
import {
  operationExists,
  validateOperationParams,
  getAllOperationDefinitions,
} from "../godot/GoPeakOperationRegistry.js";
import { GOPEAK_DISCOVERY_DEBUG } from "../godot/GoPeakDebugFlags.js";

const CHANGE_PLAN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "intent_summary",
    "source_of_truth_updates",
    "affected_project_files",
    "operations",
    "file_changes",
    "cli_actions",
    "validation_steps",
    "risks",
  ],
  properties: {
    intent_summary: { type: "string", minLength: 1 },
    source_of_truth_updates: {
      type: "object",
      additionalProperties: false,
      required: ["normalized_game_spec_patch", "generation_recipe_patch", "project_state_patch"],
      properties: {
        normalized_game_spec_patch: { type: ["object", "null"] },
        generation_recipe_patch: { type: ["object", "null"] },
        project_state_patch: { type: ["object", "null"] },
      },
    },
    affected_project_files: {
      type: "array",
      items: { type: "string", minLength: 1 },
    },
    file_changes: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["type", "path", "content", "notes", "target"],
        properties: {
          type: { type: "string", minLength: 1 },
          path: { type: "string", minLength: 1 },
          content: { type: ["string", "null"] },
          notes: { type: ["string", "null"] },
          target: { type: ["object", "null"] },
        },
      },
    },
    operations: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["action", "params"],
        properties: {
          action: { type: "string", minLength: 1 },
          params: { type: "object" },
        },
      },
    },
    mcp_actions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["action", "params"],
        properties: {
          action: { type: "string", minLength: 1 },
          params: { type: "object" },
        },
      },
    },
    cli_actions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["action", "cliArgs", "params", "timeoutSeconds"],
        properties: {
          action: { type: "string", minLength: 1 },
          cliArgs: { type: "array", items: { type: "string" } },
          params: { type: "object" },
          timeoutSeconds: { type: ["number", "null"] },
        },
      },
    },
    validation_steps: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "type", "description", "params"],
        properties: {
          id: { type: "string", minLength: 1 },
          type: { type: "string", minLength: 1 },
          description: { type: "string", minLength: 1 },
          params: { type: "object" },
        },
      },
    },
    risks: {
      type: "array",
      items: { type: "string" },
    },
    created_at: { type: "string" },
    required_mcp_actions: { type: "array" },
    required_cli_actions: { type: "array" },
  },
};

const TERMINAL_COMMANDS = new Set(["help", "status", "validate", "exit", "quit"]);
const DEFAULT_LLM_CONFIG = {
  backend: "llama",
  llama: { host: "127.0.0.1", port: 11434, timeout_seconds: 120 },
};
const PLANNER_PROMPT_TEMPLATE_ID = "conversation/change_planner_v2_inline";

const CHANGE_PLAN_PROMPT_TEMPLATE = `
You are a production planner for conversational edits in an existing Godot project.
Return ONLY one JSON object. No markdown. No explanation.

STRICT OUTPUT CONTRACT:
{change_plan_schema_json}

Planning rules:
- Be conservative and actionable.
- Use source_of_truth_updates for canonical artifact patches.
- Use file_changes only for true local file operations (e.g. script file create/modify).
- Use operations as the canonical execution contract. Each operation must be one of the registry operations and use canonical snake_case params only.
- Prefer MCP-backed or composed operations when they are supported in supported_operations_json.
- Use only operations that are enabled in supported_operations_json.
- Include at least one bounded_validation step.
- Keep affected_project_files aligned with file_changes.
- Do not output a no-op plan for actionable edit requests.
- If request is ambiguous, return a failure-intent plan with risks explaining what's missing, but still keep schema-valid structure.

Workspace snapshot:
{workspace_snapshot_json}

Supported operations:
{supported_operations_json}

User request:
{user_request_text}
`.trim();

function isPlainObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function safeString(v) {
  return v == null ? "" : String(v);
}

function nowIso() {
  return new Date().toISOString();
}

function buildPromptFromTemplate(template, values) {
  let out = String(template);
  for (const [k, v] of Object.entries(values)) {
    out = out.split(`{${k}}`).join(safeString(v));
  }
  return out;
}

function workspaceSnapshotForPrompt(workspace) {
  return {
    project_root: workspace?.project_root ?? workspace?.projectRoot ?? null,
    source_of_truth_dir: workspace?.source_of_truth_dir ?? null,
    normalized_game_spec: workspace?.normalizedGameSpec ?? null,
    generation_recipe: workspace?.generationRecipe ?? null,
    project_state: workspace?.projectState ?? null,
  };
}

function isTerminalCommandRequest(text) {
  const cmd = safeString(text).trim().toLowerCase();
  return TERMINAL_COMMANDS.has(cmd);
}

function looksClearlyActionableEditRequest(text) {
  const t = safeString(text).trim().toLowerCase();
  if (!t) return false;
  const actionable = /\b(add|update|change|modify|edit|remove|delete|rename|set|fix|create|attach|move)\b/i.test(t);
  const target = /\b(scene|script|node|project|name|ui|hud|boot|gameplay|settings|input|file)\b/i.test(t);
  return actionable || target;
}

function validatePlan(plan) {
  if (!isPlainObject(plan)) return { ok: false, error: "Change plan must be a JSON object." };
  const validation = validateDataAgainstSchema(plan, CHANGE_PLAN_SCHEMA);
  if (validation.is_valid) return { ok: true };
  return { ok: false, error: "Change plan schema validation failed.", details: validation.errors ?? [] };
}

function isNoOpPlan(plan) {
  const updates = plan?.source_of_truth_updates ?? {};
  const hasSot =
    updates?.normalized_game_spec_patch != null ||
    updates?.generation_recipe_patch != null ||
    updates?.project_state_patch != null;
  const hasFiles = Array.isArray(plan?.file_changes) && plan.file_changes.length > 0;
  const hasMcp = Array.isArray(plan?.mcp_actions) && plan.mcp_actions.length > 0;
  const hasCli = Array.isArray(plan?.cli_actions) && plan.cli_actions.length > 0;
  const hasAffected = Array.isArray(plan?.affected_project_files) && plan.affected_project_files.length > 0;
  return !(hasSot || hasFiles || hasMcp || hasCli || hasAffected);
}

function isSceneLikePath(pathValue) {
  const p = safeString(pathValue).trim().toLowerCase();
  if (!p) return false;
  return p.endsWith(".tscn") || p.includes("scene");
}

function isSceneMutationMcpAction(actionObj) {
  const action = safeString(actionObj?.action).trim().toLowerCase();
  return ["attach_script", "save_scene", "add_node", "create_scene"].includes(action);
}

function sceneMutationMcpActions(plan) {
  const actions = Array.isArray(plan?.operations)
    ? plan.operations
    : Array.isArray(plan?.mcp_actions)
      ? plan.mcp_actions
      : [];
  return actions.filter((a) => a && isPlainObject(a) && isSceneMutationMcpAction(a));
}

function collectAffectedScenePathsFromMcpActions(actions) {
  const out = [];
  for (const actionObj of actions) {
    const params = isPlainObject(actionObj?.params) ? actionObj.params : {};
    const scenePath = safeString(params.scenePath ?? params.scene_path).trim();
    const scriptPath = safeString(params.scriptPath ?? params.script_path).trim();
    if (scenePath) out.push(scenePath);
    if (scriptPath) out.push(scriptPath);
  }
  return out;
}

function shouldDeferSceneFileChangeToMcp(fc) {
  const type = safeString(fc?.type).trim().toLowerCase();
  const relPath = safeString(fc?.path).trim();
  const notes = safeString(fc?.notes).trim().toLowerCase();
  const sceneType = ["edit", "modify", "scene_attach_script", "scene_node_update"].includes(type);
  const scenePath = isSceneLikePath(relPath);
  const sceneHint = notes.includes("scene") || notes.includes("attach_script") || notes.includes("attach script");
  return sceneType && (scenePath || sceneHint);
}

function normalizeSceneMutationPlan(plan) {
  const mcpSceneActions = sceneMutationMcpActions(plan);
  if (mcpSceneActions.length === 0) return plan;

  const originalFileChanges = Array.isArray(plan.file_changes) ? plan.file_changes : [];
  const keptFileChanges = [];
  let deferredCount = 0;

  // Scene mutations are MCP-driven in this workflow. Keep planner output explicit
  // by removing redundant scene file_changes that could block execution pre-MCP.
  for (const fc of originalFileChanges) {
    if (shouldDeferSceneFileChangeToMcp(fc)) {
      deferredCount += 1;
      continue;
    }
    keptFileChanges.push(fc);
  }

  if (deferredCount > 0) {
    // eslint-disable-next-line no-console
    console.log("[ChangePlanner] deferred scene file_changes to MCP actions", {
      deferred_count: deferredCount,
      mcp_scene_actions: mcpSceneActions.length,
    });
  }

  const originalAffected = Array.isArray(plan.affected_project_files) ? plan.affected_project_files : [];
  const inferredAffected = collectAffectedScenePathsFromMcpActions(mcpSceneActions);
  plan.file_changes = keptFileChanges;
  plan.affected_project_files = [...new Set([...originalAffected, ...inferredAffected])];
  return plan;
}

function toResScenePath(scenePath) {
  const p = safeString(scenePath).trim();
  if (!p) return null;
  if (p.startsWith("res://")) return p;
  return `res://${p.replace(/^\.?\//, "")}`;
}

function inferRootNameFromScenePath(scenePath) {
  const p = safeString(scenePath).trim();
  if (!p) return "Root";
  const file = p.split("/").pop() ?? "Root";
  const base = file.replace(/\.tscn$/i, "").trim();
  return base || "Root";
}

function canConvertFileChangeToSceneCreateMcp(fc) {
  const type = safeString(fc?.type).trim().toLowerCase();
  const relPath = safeString(fc?.path).trim().toLowerCase();
  const notes = safeString(fc?.notes).trim().toLowerCase();
  const looksSceneFile = relPath.endsWith(".tscn") || relPath.includes("scene");
  const createType =
    type === "create_scene" || type === "scene_create" || type === "create" || type === "add";
  const noteHint = notes.includes("create scene") || notes.includes("new scene");
  return looksSceneFile && (createType || noteHint);
}

function preferMcpSceneCreationPlanning(plan, supportedOperations) {
  const supported = buildSupportedOperationsMap(supportedOperations);
  const canCreateScene = supported.get("create_scene") === true;
  if (!canCreateScene) return { converted: 0 };

  const canSaveScene = supported.get("save_scene") === true;
  const originalFileChanges = Array.isArray(plan?.file_changes) ? plan.file_changes : [];
  const existingMcpActions = Array.isArray(plan?.mcp_actions) ? plan.mcp_actions : [];
  const convertedPaths = new Set();
  const keptFileChanges = [];
  const mcpActions = [...existingMcpActions];
  let converted = 0;

  for (const fc of originalFileChanges) {
    if (!canConvertFileChangeToSceneCreateMcp(fc)) {
      keptFileChanges.push(fc);
      continue;
    }

    const relPath = safeString(fc?.path).trim();
    const scenePath = toResScenePath(relPath);
    if (!scenePath) {
      keptFileChanges.push(fc);
      continue;
    }
    if (convertedPaths.has(scenePath)) continue;
    const alreadyHasCreate = mcpActions.some((a) => {
      const action = normalizeActionName(a?.action);
      const p = isPlainObject(a?.params) ? a.params : {};
      const ap = toResScenePath(p.scene_path ?? p.scenePath);
      return action === "create_scene" && ap === scenePath;
    });
    if (alreadyHasCreate) {
      convertedPaths.add(scenePath);
      continue;
    }

    const target = isPlainObject(fc?.target) ? fc.target : {};
    const rootName = safeString(target.root_node_name ?? target.rootName ?? target.nodeName).trim() || inferRootNameFromScenePath(scenePath);
    const rootType = safeString(target.root_node_type ?? target.rootType ?? "Node2D").trim() || "Node2D";

    mcpActions.push({
      action: "create_scene",
      params: {
        scene_path: scenePath,
        root_node_name: rootName,
        root_node_type: rootType,
      },
    });
    if (canSaveScene) {
      mcpActions.push({
        action: "save_scene",
        params: { scene_path: scenePath },
      });
    }
    convertedPaths.add(scenePath);
    converted += 1;
  }

  if (converted > 0) {
    plan.file_changes = keptFileChanges;
    plan.mcp_actions = mcpActions;
    plan.required_mcp_actions = mcpActions;
    plan.affected_project_files = [
      ...(Array.isArray(plan.affected_project_files) ? plan.affected_project_files : []),
      ...Array.from(convertedPaths),
    ].filter(Boolean);
    plan.affected_project_files = [...new Set(plan.affected_project_files)];
    // Capability-aware scene planning: prefer MCP-backed creation when supported.
    // eslint-disable-next-line no-console
    console.log("[ChangePlanner] selected MCP-backed scene creation planning", {
      converted_scene_creates: converted,
      save_scene_added: canSaveScene,
      scene_paths: Array.from(convertedPaths),
    });
  }
  return { converted };
}

function attachExecutionDefaults(plan, { boundedValidationSeconds, strictValidation }) {
  plan.created_at = typeof plan.created_at === "string" && plan.created_at.trim() ? plan.created_at : nowIso();
  const canonicalOps = Array.isArray(plan.operations)
    ? plan.operations
    : Array.isArray(plan.mcp_actions)
      ? plan.mcp_actions
      : [];
  plan.operations = canonicalOps;
  plan.mcp_actions = canonicalOps;
  plan.required_mcp_actions = canonicalOps;
  plan.required_cli_actions = Array.isArray(plan.cli_actions) ? plan.cli_actions : [];
  plan.validation_steps = Array.isArray(plan.validation_steps)
    ? plan.validation_steps.map((s) => ({
        ...s,
        params: {
          ...(isPlainObject(s?.params) ? s.params : {}),
          boundedRunSeconds: boundedValidationSeconds,
          strict: strictValidation,
        },
      }))
    : [];
  return plan;
}

function buildSupportedOperationsMap(supportedOperations) {
  const ops = Array.isArray(supportedOperations) ? supportedOperations : [];
  const map = new Map();
  for (const op of ops) {
    if (!op || typeof op !== "object") continue;
    const name = safeString(op.operation).trim();
    if (!name) continue;
    map.set(name, Boolean(op.enabled));
  }
  return map;
}

function normalizeActionName(action) {
  const a = safeString(action).trim();
  if (!a) return "";
  const aliases = {
    createScene: "create_scene",
    addNode: "add_node",
    saveScene: "save_scene",
    attachScript: "attach_script",
  };
  return aliases[a] ?? a;
}

function toCapabilityOperationKey(action) {
  const normalized = normalizeActionName(action);
  if (normalized === "attach_script") return "attach_script_to_scene_root";
  return normalized;
}

function enforceSupportedOperations(plan, supportedOperations) {
  const supported = buildSupportedOperationsMap(supportedOperations);
  if (supported.size === 0) return { plan, kept: [], rejected: [] };

  const actions = Array.isArray(plan?.operations)
    ? plan.operations
    : Array.isArray(plan?.mcp_actions)
      ? plan.mcp_actions
      : [];
  const kept = [];
  const rejected = [];

  for (const actionObj of actions) {
    const action = normalizeActionName(actionObj?.action);
    const capabilityKey = toCapabilityOperationKey(action);
    const enabled = supported.get(capabilityKey) === true;
    if (!enabled) {
      rejected.push({
        requested_action: action || safeString(actionObj?.action),
        capability_key: capabilityKey,
      });
      continue;
    }
    kept.push({
      ...actionObj,
      action,
    });
  }

  plan.operations = kept;
  plan.mcp_actions = kept;
  if (Array.isArray(plan.required_mcp_actions)) {
    plan.required_mcp_actions = kept;
  }
  if (rejected.length > 0) {
    plan.risks = [
      ...(Array.isArray(plan.risks) ? plan.risks : []),
      `Rejected unsupported operations: ${rejected.map((r) => `${r.requested_action}=>${r.capability_key}`).join(", ")}`,
    ];
    // eslint-disable-next-line no-console
    console.log("[ChangePlanner] rejected unsupported operations", {
      rejected,
      kept: kept.map((k) => k.action),
    });
  }
  return { plan, kept, rejected };
}

function summarizePlan(plan) {
  return {
    intent_summary: plan?.intent_summary ?? null,
    affected_project_files: Array.isArray(plan?.affected_project_files)
      ? plan.affected_project_files.length
      : 0,
    file_changes: Array.isArray(plan?.file_changes) ? plan.file_changes.length : 0,
    operations: Array.isArray(plan?.operations) ? plan.operations.length : 0,
    mcp_actions: Array.isArray(plan?.mcp_actions) ? plan.mcp_actions.length : 0,
    cli_actions: Array.isArray(plan?.cli_actions) ? plan.cli_actions.length : 0,
    validation_steps: Array.isArray(plan?.validation_steps) ? plan.validation_steps.length : 0,
  };
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function getActionParam(params, keys) {
  const p = isPlainObject(params) ? params : {};
  for (const key of keys) {
    if (p[key] != null) return p[key];
  }
  return null;
}

function validatePlannedMcpActions(plan) {
  const actions = Array.isArray(plan?.operations)
    ? plan.operations
    : Array.isArray(plan?.mcp_actions)
      ? plan.mcp_actions
      : [];
  const invalid = [];
  const kept = [];
  for (const actionObj of actions) {
    const action = normalizeActionName(actionObj?.action);
    const params = isPlainObject(actionObj?.params) ? actionObj.params : {};
    const errors = [];
    if (action === "create_scene") {
      if (!isNonEmptyString(getActionParam(params, ["scene_path", "scenePath"]))) errors.push("scene_path is required");
      if (!isNonEmptyString(getActionParam(params, ["root_node_name", "rootName", "root_name"]))) errors.push("root_node_name is required");
      if (!isNonEmptyString(getActionParam(params, ["root_node_type", "rootType", "root_type"]))) errors.push("root_node_type is required");
    } else if (action === "add_node") {
      if (!isNonEmptyString(getActionParam(params, ["scene_path", "scenePath"]))) errors.push("scene_path is required");
      if (!isNonEmptyString(getActionParam(params, ["node_name", "nodeName"]))) errors.push("node_name is required");
      if (!isNonEmptyString(getActionParam(params, ["node_type", "nodeType"]))) errors.push("node_type is required");
    } else if (action === "save_scene") {
      if (!isNonEmptyString(getActionParam(params, ["scene_path", "scenePath"]))) errors.push("scene_path is required");
    } else if (action === "attach_script") {
      if (!isNonEmptyString(getActionParam(params, ["scene_path", "scenePath"]))) errors.push("scene_path is required");
      if (!isNonEmptyString(getActionParam(params, ["script_path", "scriptPath"]))) errors.push("script_path is required");
    }
    if (errors.length > 0) {
      invalid.push({ action, errors });
      continue;
    }
    kept.push({ ...actionObj, action });
  }
  plan.operations = kept;
  plan.mcp_actions = kept;
  if (Array.isArray(plan.required_mcp_actions)) {
    plan.required_mcp_actions = kept;
  }
  if (invalid.length > 0) {
    plan.risks = [
      ...(Array.isArray(plan.risks) ? plan.risks : []),
      `Rejected malformed MCP actions: ${invalid.map((x) => `${x.action}(${x.errors.join("; ")})`).join(", ")}`,
    ];
    // eslint-disable-next-line no-console
    console.log("[ChangePlanner] rejected malformed MCP actions", { invalid });
  }
  return invalid;
}

function normalizeCanonicalOperationParams(action, rawParams) {
  const params = isPlainObject(rawParams) ? { ...rawParams } : {};
  const op = normalizeActionName(action);
  if (op === "create_scene") {
    if (params.scene_path == null && params.path != null) params.scene_path = params.path;
    if (params.root_node_name == null && params.root_name != null) params.root_node_name = params.root_name;
    if (params.root_node_type == null && params.root_type != null) params.root_node_type = params.root_type;
    if (params.root_node_name == null && params.rootName != null) params.root_node_name = params.rootName;
    if (params.root_node_type == null && params.rootType != null) params.root_node_type = params.rootType;
  }
  if (op === "add_node") {
    if (params.scene_path == null && params.path != null) params.scene_path = params.path;
  }
  if (op === "save_scene") {
    if (params.scene_path == null && params.path != null) params.scene_path = params.path;
  }
  if (op === "attach_script_to_scene_root" || op === "attach_script") {
    if (params.scene_path == null && params.path != null) params.scene_path = params.path;
    if (params.script_path == null && params.scriptPath != null) params.script_path = params.scriptPath;
  }
  return stripLegacyAliasParamsForOperation(op, params);
}

function stripLegacyAliasParamsForOperation(operation, params) {
  const out = isPlainObject(params) ? { ...params } : {};
  // Canonical contract guard:
  // keep registry param names only and drop legacy aliases that cause drift.
  if (operation === "create_scene") {
    delete out.path;
    delete out.root_name;
    delete out.root_type;
    delete out.rootName;
    delete out.rootType;
    delete out.scenePath;
  }
  if (operation === "add_node") {
    delete out.path;
    delete out.scenePath;
  }
  if (operation === "save_scene") {
    delete out.path;
    delete out.scenePath;
  }
  if (operation === "attach_script_to_scene_root" || operation === "attach_script") {
    delete out.path;
    delete out.scenePath;
    delete out.scriptPath;
  }
  return out;
}

function coerceOperationsToCanonical(plan) {
  const raw = Array.isArray(plan?.operations)
    ? plan.operations
    : Array.isArray(plan?.mcp_actions)
      ? plan.mcp_actions
      : [];
  const out = raw
    .filter((o) => o && isPlainObject(o))
    .map((o) => {
      const action = normalizeActionName(o.action);
      return {
        action,
        params: normalizeCanonicalOperationParams(action, o.params),
      };
    });
  plan.operations = out;
  plan.mcp_actions = out;
  plan.required_mcp_actions = out;
  return out;
}

function validateOperationsAgainstRegistry(plan) {
  const ops = Array.isArray(plan?.operations) ? plan.operations : [];
  const invalid = [];
  const kept = [];
  for (const op of ops) {
    const action = normalizeActionName(op?.action);
    const params = isPlainObject(op?.params) ? op.params : {};
    if (!operationExists(action)) {
      invalid.push({ action, error: "operation_not_in_registry" });
      continue;
    }
    const validated = validateOperationParams(action, params);
    if (!validated.ok) {
      invalid.push({ action, error: validated.error, missing_required_params: validated.missing_required_params ?? [] });
      continue;
    }
    kept.push({ action, params });
  }
  plan.operations = kept;
  plan.mcp_actions = kept;
  plan.required_mcp_actions = kept;
  if (invalid.length > 0) {
    plan.risks = [
      ...(Array.isArray(plan.risks) ? plan.risks : []),
      `Rejected invalid canonical operations: ${invalid.map((x) => `${x.action}:${x.error}`).join(", ")}`,
    ];
    // eslint-disable-next-line no-console
    console.log("[ChangePlanner] rejected invalid canonical operations", { invalid });
  }
  return invalid;
}

async function resolveLLMClient({ llmClient, llmConfig }) {
  if (llmClient) return llmClient;
  return createLLMClient(llmConfig ?? DEFAULT_LLM_CONFIG);
}

export async function planChange({
  workspace,
  userRequestText,
  llmClient = null,
  llmConfig = null,
  modelName = "gpt-oss:20b",
  boundedValidationSeconds = 5,
  strictValidation = false,
  supportedOperations = null,
} = {}) {
  if (!workspace || !isPlainObject(workspace)) {
    return { ok: false, error: "workspace must be provided as a JSON object." };
  }
  if (!userRequestText || !safeString(userRequestText).trim()) {
    return { ok: false, error: "userRequestText must be a non-empty string." };
  }
  if (isTerminalCommandRequest(userRequestText)) {
    return {
      ok: false,
      error: "Terminal command should be handled by TerminalEditModeRunner before planChange.",
    };
  }

  const actionable = looksClearlyActionableEditRequest(userRequestText);
  let resolvedLLMClient = null;
  try {
    resolvedLLMClient = await resolveLLMClient({ llmClient, llmConfig });
  } catch (err) {
    return {
      ok: false,
      error: `Failed to initialize LLM client for change planning: ${safeString(err?.message ?? err)}`,
    };
  }

  const prompt = buildPromptFromTemplate(CHANGE_PLAN_PROMPT_TEMPLATE, {
    user_request_text: safeString(userRequestText),
    workspace_snapshot_json: JSON.stringify(workspaceSnapshotForPrompt(workspace), null, 2),
    change_plan_schema_json: JSON.stringify(CHANGE_PLAN_SCHEMA, null, 2),
    supported_operations_json: JSON.stringify(Array.isArray(supportedOperations) ? supportedOperations : [], null, 2),
  });

  // Runtime evidence for planning behavior.
  // eslint-disable-next-line no-console
  console.log("[ChangePlanner][LLM] backend/model", {
    backend: resolvedLLMClient?.backendName ?? llmConfig?.backend ?? "unknown",
    model: modelName,
  });
  // eslint-disable-next-line no-console
  if (GOPEAK_DISCOVERY_DEBUG) {
    console.log("[ChangePlanner][LLM] prompt_template", {
      id: PLANNER_PROMPT_TEMPLATE_ID,
      canonical_operation_registry: getAllOperationDefinitions().map((o) => o.operation),
    });
  }

  let rawText = "";
  try {
    const llmRes = await resolvedLLMClient.generateText({
      prompt,
      model: modelName,
      temperature: 0.0,
    });
    rawText = safeString(llmRes?.text);
  } catch (err) {
    return {
      ok: false,
      error: `LLM planning call failed: ${safeString(err?.message ?? err)}`,
    };
  }

  if (GOPEAK_DISCOVERY_DEBUG) {
    // eslint-disable-next-line no-console
    console.log("[ChangePlanner][LLM] raw_response", rawText);
  }

  let parsed = null;
  try {
    parsed = parseJsonObject(rawText);
  } catch (err) {
    return {
      ok: false,
      error: "LLM planner output is not valid JSON object.",
      details: { message: safeString(err?.message ?? err) },
      raw_llm_response: rawText,
    };
  }

  const validated = validatePlan(parsed);
  if (!validated.ok) {
    return {
      ok: false,
      error: validated.error,
      details: validated.details,
      raw_llm_response: rawText,
    };
  }

  const plan = attachExecutionDefaults(parsed, {
    boundedValidationSeconds,
    strictValidation,
  });
  coerceOperationsToCanonical(plan);
  preferMcpSceneCreationPlanning(plan, supportedOperations);
  const enforcement = enforceSupportedOperations(plan, supportedOperations);
  const registryInvalid = validateOperationsAgainstRegistry(plan);
  const malformedActions = validatePlannedMcpActions(plan);
  normalizeSceneMutationPlan(plan);

  if (actionable && Array.isArray(enforcement?.rejected) && enforcement.rejected.length > 0) {
    return {
      ok: false,
      error: "Planner requested unsupported MCP operations for current discovered GoPeak capability set.",
      details: {
        rejected_operations: enforcement.rejected,
        supported_operations: Array.isArray(supportedOperations)
          ? supportedOperations.filter((o) => o?.enabled).map((o) => o?.operation)
          : [],
      },
      raw_llm_response: rawText,
    };
  }
  if (actionable && Array.isArray(registryInvalid) && registryInvalid.length > 0) {
    return {
      ok: false,
      error: "Planner emitted operations that are not valid canonical registry actions.",
      details: { invalid_operations: registryInvalid },
      raw_llm_response: rawText,
    };
  }
  if (actionable && Array.isArray(malformedActions) && malformedActions.length > 0) {
    return {
      ok: false,
      error: "Planner emitted malformed MCP action arguments.",
      details: { malformed_mcp_actions: malformedActions },
      raw_llm_response: rawText,
    };
  }

  if (actionable && isNoOpPlan(plan)) {
    return {
      ok: false,
      error:
        "Planner produced an empty/no-op plan for an actionable request. Refusing fallback to prevent hardcoded behavior.",
      raw_llm_response: rawText,
      details: { summary: summarizePlan(plan) },
    };
  }

  if (GOPEAK_DISCOVERY_DEBUG) {
    // eslint-disable-next-line no-console
    console.log("[ChangePlanner][LLM] parsed_plan_summary", summarizePlan(plan));
  }

  return { ok: true, plan };
}

