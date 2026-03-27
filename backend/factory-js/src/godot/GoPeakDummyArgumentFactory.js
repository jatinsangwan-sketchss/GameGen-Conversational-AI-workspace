/**
 * GoPeakDummyArgumentFactory
 * --------------------------
 * Generates conservative dummy arguments for wrapper "test-all" runs.
 *
 * Design goals:
 * - Prefer safe read-only or low-impact calls.
 * - Skip destructive/risky tools instead of guessing unsafe payloads.
 * - Build args from discovered tool schema + explicit test context.
 *
 * This module is transport-agnostic and contains no MCP execution logic.
 */

const DEFAULTS = Object.freeze({
  scenePath: "res://scenes/boot/boot_scene.tscn",
  nodePath: ".",
  nodeName: "BootScene",
  scriptPath: "res://scripts/BootPrintHelloWorld.gd",
  resourcePath: "res://icon.svg",
  text: "test",
  label: "test_label",
  name: "test_name",
  id: "test_id",
  reason: "wrapper test-all smoke check",
  timeoutSeconds: 5,
});

const DANGEROUS_TOOL_PATTERNS = Object.freeze([
  /delete/i,
  /remove/i,
  /reparent/i,
  /duplicate/i,
  /export[-_]?project/i,
  /stop[-_]?project/i,
  /inject[-_]?/i,
  /set[-_]?project[-_]?setting/i,
  /disable[-_]?plugin/i,
  /modify[-_]?resource/i,
  /modify[-_]?script/i,
  /filesystem/i,
  /shell/i,
  /exec/i,
]);

const CAUTIOUS_TOOL_PATTERNS = Object.freeze([
  /create[-_]?/i,
  /add[-_]?/i,
  /set[-_]?/i,
  /save[-_]?scene/i,
]);

const SAFE_SERVER_ONLY_PATTERNS = Object.freeze([
  /health/i,
  /version/i,
  /status/i,
  /list[-_]?tools/i,
  /tool[-_]?catalog/i,
]);

function safeString(v) {
  return v == null ? "" : String(v);
}

function isPlainObject(v) {
  return v != null && typeof v === "object" && !Array.isArray(v);
}

function normalizeTool(toolDef) {
  return {
    name: safeString(toolDef?.name).trim(),
    input_schema:
      isPlainObject(toolDef?.input_schema)
        ? toolDef.input_schema
        : isPlainObject(toolDef?.inputSchema)
          ? toolDef.inputSchema
          : null,
  };
}

function normalizeContext(testContext) {
  const ctx = isPlainObject(testContext) ? testContext : {};
  return {
    projectPath: safeString(ctx.projectPath || ctx.project_root || ctx.projectRoot).trim() || null,
    scenePath: safeString(ctx.scenePath || ctx.scene_path).trim() || DEFAULTS.scenePath,
    nodePath: safeString(ctx.nodePath || ctx.node_path).trim() || DEFAULTS.nodePath,
    nodeName: safeString(ctx.nodeName || ctx.node_name).trim() || DEFAULTS.nodeName,
    scriptPath: safeString(ctx.scriptPath || ctx.script_path).trim() || DEFAULTS.scriptPath,
    resourcePath: safeString(ctx.resourcePath || ctx.resource_path).trim() || DEFAULTS.resourcePath,
    allowMutatingTools: Boolean(ctx.allowMutatingTools === true),
  };
}

function shouldSkipToolInTestAll(toolName, context) {
  const name = safeString(toolName);
  if (!name) return "tool name is empty";
  if (DANGEROUS_TOOL_PATTERNS.some((re) => re.test(name))) {
    return "skipped in test-all mode: destructive or disruptive operation";
  }
  if (!context.allowMutatingTools && CAUTIOUS_TOOL_PATTERNS.some((re) => re.test(name))) {
    return "skipped in test-all mode: mutating tool requires allowMutatingTools=true";
  }
  return null;
}

function requiresProjectPathByName(toolName) {
  const name = safeString(toolName).toLowerCase();
  return /project|scene|node|resource|script|runtime|uid|setting|autoload|plugin/.test(name);
}

function pickValueForParam(paramName, schema, context) {
  const key = safeString(paramName).toLowerCase();
  const type = safeString(schema?.type).toLowerCase();

  if (/projectpath|project_path|projectroot|project_root/.test(key)) return context.projectPath;
  if (/scenepath|scene_path/.test(key)) return context.scenePath;
  if (/nodepath|node_path/.test(key)) return context.nodePath;
  if (/nodename|node_name/.test(key)) return context.nodeName;
  if (/nodetype|node_type/.test(key)) return "Node2D";
  if (/scriptpath|script_path/.test(key)) return context.scriptPath;
  if (/resourcepath|resource_path|assetpath|asset_path/.test(key)) return context.resourcePath;
  if (/rootnodetype|root_node_type|roottype|root_type/.test(key)) return "Node2D";
  if (/rootnodename|root_node_name|rootname|root_name/.test(key)) return context.nodeName;
  if (/propertychanges|property_changes/.test(key)) return { script: context.scriptPath };
  if (/properties/.test(key)) return { visible: true };
  if (/nodeproperties|node_properties/.test(key)) return { visible: true };
  if (/reason/.test(key)) return DEFAULTS.reason;
  if (/name/.test(key)) return DEFAULTS.name;
  if (/label/.test(key)) return DEFAULTS.label;
  if (/text|message|query/.test(key)) return DEFAULTS.text;
  if (/id$|_id$/.test(key)) return DEFAULTS.id;
  if (/timeout/.test(key)) return DEFAULTS.timeoutSeconds;

  if (type === "boolean") return false;
  if (type === "integer" || type === "number") return 1;
  if (type === "array") return [];
  if (type === "object") return {};
  return DEFAULTS.text;
}

function buildArgsFromSchema(inputSchema, context) {
  const schema = isPlainObject(inputSchema) ? inputSchema : {};
  const properties = isPlainObject(schema.properties) ? schema.properties : {};
  const required = Array.isArray(schema.required) ? schema.required : [];
  const args = {};

  for (const req of required) {
    const propSchema = isPlainObject(properties[req]) ? properties[req] : {};
    const value = pickValueForParam(req, propSchema, context);
    if (value == null || value === "") {
      return { ok: false, error: `missing safe value for required parameter: ${req}` };
    }
    args[req] = value;
  }

  return { ok: true, args };
}

function buildArgsFromKnownNamePatterns(toolName, context) {
  const name = safeString(toolName).toLowerCase();
  if (!name) return null;
  if (/get[-_]?project[-_]?health|validate[-_]?project/.test(name)) {
    return context.projectPath ? { project_root: context.projectPath } : {};
  }
  if (/create[-_]?scene/.test(name)) {
    if (!context.projectPath) return null;
    return {
      scene_path: context.scenePath,
      root_node_name: context.nodeName,
      root_node_type: "Node2D",
      nodes: [],
    };
  }
  if (/add[-_]?node/.test(name)) {
    if (!context.projectPath) return null;
    return {
      scene_path: context.scenePath,
      node_name: "TestNode",
      node_type: "Node2D",
      parent_path: context.nodePath,
    };
  }
  if (/set[-_]?node[-_]?properties/.test(name)) {
    if (!context.projectPath) return null;
    return {
      scene_path: context.scenePath,
      node_path: context.nodePath,
      properties: { visible: true },
    };
  }
  if (/save[-_]?scene/.test(name)) {
    if (!context.projectPath) return null;
    return { scene_path: context.scenePath };
  }
  if (SAFE_SERVER_ONLY_PATTERNS.some((re) => re.test(name))) {
    return {};
  }
  return null;
}

/**
 * Main API for wrapper test-all mode.
 * Returns whether tool can be called safely with generated minimal args.
 */
function buildDummyArgumentsForTool(discoveredToolDef, testContext = {}) {
  const tool = normalizeTool(discoveredToolDef);
  const context = normalizeContext(testContext);

  if (!tool.name) {
    return {
      callable: false,
      args: null,
      skipReason: "tool definition missing name",
    };
  }
  const skipReason = shouldSkipToolInTestAll(tool.name, context);
  if (skipReason) {
    return {
      callable: false,
      args: null,
      skipReason,
    };
  }

  if (!context.projectPath && requiresProjectPathByName(tool.name)) {
    return {
      callable: false,
      args: null,
      skipReason: "projectPath/project_root is required for this project-scoped tool",
    };
  }

  const built = buildArgsFromSchema(tool.input_schema, context);
  if (built.ok && Object.keys(built.args ?? {}).length > 0) {
    return {
      callable: true,
      args: built.args,
      skipReason: null,
    };
  }

  if (!built.ok) {
    const known = buildArgsFromKnownNamePatterns(tool.name, context);
    if (known != null) {
      return {
        callable: true,
        args: known,
        skipReason: null,
      };
    }
    return {
      callable: false,
      args: null,
      skipReason: built.error,
    };
  }

  const known = buildArgsFromKnownNamePatterns(tool.name, context);
  if (known != null) {
    return {
      callable: true,
      args: known,
      skipReason: null,
    };
  }

  // If schema is empty/unknown and tool is not in known-safe set, skip explicitly.
  return {
    callable: false,
    args: null,
    skipReason: "tool has no clear required schema or safe known pattern; skipped to avoid blind guessing",
  };
}

export { buildDummyArgumentsForTool };

