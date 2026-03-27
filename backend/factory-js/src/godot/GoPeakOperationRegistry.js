/**
 * GoPeakOperationRegistry
 * -----------------------
 * Canonical operation contract registry for factory-facing Godot/GoPeak operations.
 *
 * Why this exists:
 * - Planner, executor, wrapper, and validator must share one operation contract.
 * - Discovery tells us what raw tools exist; this registry tells us how factory
 *   operations are expected to behave, validate params, and define success.
 *
 * This module is intentionally pure data + helpers:
 * - no MCP transport
 * - no planning/execution orchestration
 */

function freezeDeep(value) {
  if (value == null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    for (const item of value) freezeDeep(item);
    return Object.freeze(value);
  }
  for (const key of Object.keys(value)) {
    freezeDeep(value[key]);
  }
  return Object.freeze(value);
}

function safeString(v) {
  return v == null ? "" : String(v);
}

function isPlainObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function toStringArray(value) {
  return Array.isArray(value) ? value.map((x) => safeString(x).trim()).filter(Boolean) : [];
}

const OPERATION_DEFINITIONS = freezeDeep([
  {
    operation: "analyze_project",
    category: "analysis",
    prerequisites: ["server_only", "project_required"],
    required_params: [],
    optional_params: ["project_path", "project_root"],
    placeholder_policy: "no_placeholders_required",
    fallback_policy: "fail_if_primary_unavailable",
    primary_execution_path: "mcp_tool",
    allowed_fallbacks: [],
    success_expectations: {
      backend: "mcp",
      requires_ok: true,
      requires_non_null_response: true,
    },
    unsupported_if_missing: true,
  },
  {
    operation: "create_scene",
    category: "scene_mutation",
    prerequisites: ["project_required", "editor_bridge_required"],
    required_params: ["scene_path", "root_node_name", "root_node_type"],
    optional_params: ["nodes"],
    placeholder_policy: "allow_safe_defaults_for_root_fields",
    fallback_policy: "fail_if_primary_unavailable",
    primary_execution_path: "mcp_tool",
    allowed_fallbacks: [],
    success_expectations: {
      backend: "mcp",
      requires_ok: true,
      requires_scene_written: true,
    },
    unsupported_if_missing: true,
  },
  {
    operation: "add_node",
    category: "scene_mutation",
    prerequisites: ["project_required", "editor_bridge_required"],
    required_params: ["scene_path", "node_name", "node_type"],
    optional_params: ["parent_path"],
    placeholder_policy: "allow_safe_defaults_for_parent_path",
    fallback_policy: "fail_if_primary_unavailable",
    primary_execution_path: "mcp_tool",
    allowed_fallbacks: [],
    success_expectations: {
      backend: "mcp",
      requires_ok: true,
      requires_scene_mutation: true,
    },
    unsupported_if_missing: true,
  },
  {
    operation: "set_node_properties",
    category: "scene_mutation",
    prerequisites: ["project_required", "editor_bridge_required"],
    required_params: ["scene_path", "node_path", "properties"],
    optional_params: ["property_changes"],
    placeholder_policy: "properties_must_be_explicit",
    fallback_policy: "fail_if_primary_unavailable",
    primary_execution_path: "mcp_tool",
    allowed_fallbacks: [],
    success_expectations: {
      backend: "mcp",
      requires_ok: true,
      requires_scene_mutation: true,
    },
    unsupported_if_missing: true,
  },
  {
    operation: "save_scene",
    category: "scene_mutation",
    prerequisites: ["project_required", "editor_bridge_required"],
    required_params: ["scene_path"],
    optional_params: [],
    placeholder_policy: "no_placeholders_allowed",
    fallback_policy: "fail_if_primary_unavailable",
    primary_execution_path: "mcp_tool",
    allowed_fallbacks: [],
    success_expectations: {
      backend: "mcp",
      requires_ok: true,
      requires_scene_saved: true,
    },
    unsupported_if_missing: true,
  },
  {
    operation: "attach_script_to_scene_root",
    category: "composed_scene_mutation",
    prerequisites: ["project_required", "editor_bridge_required"],
    required_params: ["scene_path", "script_path"],
    optional_params: ["node_path", "node_name"],
    placeholder_policy: "allow_root_node_default",
    fallback_policy: "fail_if_primary_unavailable",
    primary_execution_path: "composed_mcp_sequence",
    allowed_fallbacks: [],
    success_expectations: {
      backend: "mcp",
      requires_ok: true,
      requires_composed_steps: ["set_node_properties", "save_scene"],
      requires_scene_mutation: true,
    },
    unsupported_if_missing: true,
  },
  {
    operation: "create_script_file",
    category: "filesystem_mutation",
    prerequisites: ["project_required"],
    required_params: ["script_path", "content"],
    optional_params: [],
    placeholder_policy: "content_placeholder_allowed_if_explicit",
    fallback_policy: "allow_executor_file_write",
    primary_execution_path: "filesystem_write",
    allowed_fallbacks: [],
    success_expectations: {
      backend: "executor",
      requires_ok: true,
      requires_file_written: true,
    },
    unsupported_if_missing: false,
  },
  {
    operation: "modify_script_file",
    category: "filesystem_mutation",
    prerequisites: ["project_required"],
    required_params: ["script_path", "content"],
    optional_params: ["replace_mode"],
    placeholder_policy: "content_placeholder_disallowed",
    fallback_policy: "allow_executor_file_write",
    primary_execution_path: "filesystem_write",
    allowed_fallbacks: [],
    success_expectations: {
      backend: "executor",
      requires_ok: true,
      requires_file_written: true,
    },
    unsupported_if_missing: false,
  },
  {
    operation: "run_project",
    category: "runtime",
    prerequisites: ["project_required"],
    required_params: [],
    optional_params: ["headless", "extra_args", "timeout_seconds"],
    placeholder_policy: "no_placeholders_required",
    fallback_policy: "allow_cli_runner",
    primary_execution_path: "cli",
    allowed_fallbacks: [],
    success_expectations: {
      backend: "cli",
      requires_ok: true,
    },
    unsupported_if_missing: false,
  },
  {
    operation: "get_debug_output",
    category: "debug",
    prerequisites: ["server_only"],
    required_params: [],
    optional_params: ["last_n"],
    placeholder_policy: "no_placeholders_required",
    fallback_policy: "allow_executor_history",
    primary_execution_path: "executor",
    allowed_fallbacks: [],
    success_expectations: {
      backend: "executor",
      requires_ok: true,
    },
    unsupported_if_missing: false,
  },
  {
    operation: "rename_project",
    category: "project_metadata",
    prerequisites: ["project_required"],
    required_params: ["project_name"],
    optional_params: [],
    placeholder_policy: "project_name_placeholder_disallowed",
    fallback_policy: "allow_metadata_updater",
    primary_execution_path: "project_metadata_update",
    allowed_fallbacks: [],
    success_expectations: {
      backend: "executor",
      requires_ok: true,
      requires_project_settings_update: true,
    },
    unsupported_if_missing: false,
  },
]);

const OPERATION_MAP = freezeDeep(
  Object.fromEntries(OPERATION_DEFINITIONS.map((def) => [def.operation, def]))
);

function getOperationDefinition(operation) {
  const key = safeString(operation).trim();
  return OPERATION_MAP[key] ?? null;
}

function getAllOperationDefinitions() {
  return OPERATION_DEFINITIONS.slice();
}

function operationExists(operation) {
  return getOperationDefinition(operation) != null;
}

function validateOperationParams(operation, params) {
  const def = getOperationDefinition(operation);
  if (!def) {
    return {
      ok: false,
      operation: safeString(operation).trim(),
      error: "Unknown operation.",
      missing_required_params: [],
      unsupported_params: [],
    };
  }
  const input = isPlainObject(params) ? params : {};
  const required = toStringArray(def.required_params);
  const optional = toStringArray(def.optional_params);
  const allowed = new Set([...required, ...optional]);
  const missing = required.filter((key) => {
    const val = input[key];
    if (typeof val === "string") return val.trim().length === 0;
    return val == null;
  });
  const unsupported = Object.keys(input).filter((key) => !allowed.has(key));
  const ok = missing.length === 0;
  return {
    ok,
    operation: def.operation,
    error: ok ? null : `Missing required params: ${missing.join(", ")}`,
    missing_required_params: missing,
    unsupported_params: unsupported,
  };
}

function getSuccessExpectations(operation) {
  const def = getOperationDefinition(operation);
  return def?.success_expectations ?? null;
}

function getPrimaryExecutionPath(operation) {
  const def = getOperationDefinition(operation);
  return def?.primary_execution_path ?? null;
}

function getOperationPrerequisites(operation) {
  const def = getOperationDefinition(operation);
  return def ? toStringArray(def.prerequisites) : [];
}

function getOperationFallbackPolicy(operation) {
  const def = getOperationDefinition(operation);
  return def?.fallback_policy ?? null;
}

function getOperationPlaceholderPolicy(operation) {
  const def = getOperationDefinition(operation);
  return def?.placeholder_policy ?? null;
}

const GoPeakOperationRegistry = freezeDeep({
  operations: OPERATION_DEFINITIONS,
  operation_map: OPERATION_MAP,
});

export {
  GoPeakOperationRegistry,
  getOperationDefinition,
  getAllOperationDefinitions,
  operationExists,
  validateOperationParams,
  getSuccessExpectations,
  getPrimaryExecutionPath,
  getOperationPrerequisites,
  getOperationFallbackPolicy,
  getOperationPlaceholderPolicy,
};

