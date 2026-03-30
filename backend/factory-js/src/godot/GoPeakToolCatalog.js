/**
 * GoPeakToolCatalog
 * -----------------
 * Pure data/model helpers for translating raw discovered MCP tools into
 * factory-level capability manifests.
 *
 * Raw tools vs factory operations:
 * - Raw tools are what MCP `tools/list` returns (server truth).
 * - Factory operations are higher-level actions the factory can request
 *   directly or compose from multiple raw tools.
 *
 * This module intentionally has no transport, planning, or execution logic.
 */

const CATEGORY_RULES = Object.freeze([
  { category: "discovery", patterns: [/^tool[-_]?catalog$/i, /^manage[-_]?tool[-_]?groups$/i, /^list[-_]?projects$/i] },
  { category: "scene", patterns: [/scene/i] },
  { category: "node", patterns: [/node/i] },
  { category: "property", patterns: [/property/i] },
  { category: "resource", patterns: [/resource/i, /asset/i, /material/i, /shader/i, /tileset/i] },
  { category: "script", patterns: [/script/i, /lsp/i] },
  { category: "runtime", patterns: [/runtime/i, /^run[-_]?project$/i, /^stop[-_]?project$/i, /^inject/i] },
  { category: "debug", patterns: [/debug/i, /health/i, /diagnostic/i] },
  { category: "project", patterns: [/project/i, /autoload/i, /plugin/i, /version/i, /setting/i, /uid/i] },
]);

const DIRECT_OPERATION_DEFS = Object.freeze([
  { operation: "analyze_project", aliases: ["get-project-health", "validate-project", "get_project_health", "validate_project"] },
  { operation: "create_scene", aliases: ["create-scene", "create_scene", "createScene"] },
  { operation: "add_node", aliases: ["add-node", "add_node", "addNode"] },
  // Raw tool name observed in discovery: `set-node-properties`.
  // Map that to the factory operation `set_node_properties` so planners can
  // accept and execute node property mutations.
  { operation: "set_node_properties", aliases: ["set-node-properties", "set_node_properties", "setNodeProperties"] },
  { operation: "save_scene", aliases: ["save-scene", "save_scene", "saveScene"] },
]);

const COMPOSED_OPERATION_DEFS = Object.freeze([
  {
    operation: "attach_script_to_scene_root",
    requires: [
      ["set-node-properties", "set_node_properties", "setNodeProperties"],
      ["save-scene", "save_scene", "saveScene"],
    ],
    optional: [
      "get-node-properties",
      "get_node_properties",
      "list-scene-nodes",
      "list_scene_nodes",
    ],
  },
]);

function safeString(v) {
  return v == null ? "" : String(v);
}

function normalizeToolKey(name) {
  return safeString(name).trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

function classifyToolCategory(name) {
  const n = safeString(name);
  for (const rule of CATEGORY_RULES) {
    if (rule.patterns.some((re) => re.test(n))) return rule.category;
  }
  return "project";
}

function classifyPrerequisites(rawTool) {
  const name = safeString(rawTool?.name);
  const category = classifyToolCategory(name);
  const requires_editor =
    /scene|node|runtime|inject|save[-_]?scene|get[-_]?node|set[-_]?node/i.test(name) || category === "scene" || category === "node";
  const requires_project_path =
    /project|scene|node|resource|script|runtime|uid|setting|autoload|plugin/i.test(name);
  return {
    requires_editor,
    requires_project_path,
    category,
  };
}

function normalizeRawTools(discoveredTools) {
  const arr = Array.isArray(discoveredTools) ? discoveredTools : [];
  const seen = new Set();
  const out = [];

  for (const t of arr) {
    const name = safeString(t?.name).trim();
    if (!name) continue;
    const key = normalizeToolKey(name);
    if (!key || seen.has(key)) continue;
    seen.add(key);

    const inputSchema =
      isPlainObject(t?.input_schema) ? t.input_schema : isPlainObject(t?.inputSchema) ? t.inputSchema : null;
    const prereq = classifyPrerequisites({ name });
    out.push({
      name,
      key,
      title: safeString(t?.title) || null,
      description: safeString(t?.description) || null,
      tags: Array.isArray(t?.tags) ? t.tags.map((x) => safeString(x)) : [],
      input_schema: inputSchema,
      category: prereq.category,
      prerequisites: {
        requires_editor: prereq.requires_editor,
        requires_project_path: prereq.requires_project_path,
      },
    });
  }

  return out;
}

function findToolsByKeyword(rawTools, keyword) {
  const tools = normalizeRawTools(rawTools);
  const q = safeString(keyword).trim().toLowerCase();
  if (!q) return [];
  return tools.filter((t) =>
    [t.name, t.title, t.description, t.category, ...(Array.isArray(t.tags) ? t.tags : [])]
      .map((v) => safeString(v).toLowerCase())
      .join(" ")
      .includes(q)
  );
}

function deriveSupportedOperations(rawTools) {
  const tools = normalizeRawTools(rawTools);
  const byKey = new Set(tools.map((t) => t.key));
  const hasAny = (aliases) => aliases.some((a) => byKey.has(normalizeToolKey(a)));
  const matched = (aliases) => tools.filter((t) => aliases.some((a) => t.key === normalizeToolKey(a))).map((t) => t.name);

  const operations = [];
  for (const def of DIRECT_OPERATION_DEFS) {
    const enabled = hasAny(def.aliases);
    operations.push({
      operation: def.operation,
      enabled,
      mode: enabled ? "direct" : "unsupported",
      required_tools: [def.aliases[0]],
      matched_tools: matched(def.aliases),
      derived_from_discovery: true,
      kind: "direct",
    });
  }

  for (const def of COMPOSED_OPERATION_DEFS) {
    const enabled = def.requires.every((bucket) => hasAny(bucket));
    const matchedTools = [
      ...def.requires.flatMap((bucket) => matched(bucket)),
      ...matched(def.optional ?? []),
    ];
    operations.push({
      operation: def.operation,
      enabled,
      mode: enabled ? "composed" : "unsupported",
      required_tools: def.requires.map((bucket) => bucket[0]),
      matched_tools: [...new Set(matchedTools)],
      optional_tools: def.optional ?? [],
      derived_from_discovery: true,
      kind: "composed",
    });
  }

  const categories = tools.reduce((acc, t) => {
    if (!acc[t.category]) acc[t.category] = [];
    acc[t.category].push(t.name);
    return acc;
  }, {});

  return {
    raw_tools: tools,
    operations,
    categories,
    summary: {
      discovered_tool_count: tools.length,
      enabled_operations: operations.filter((o) => o.enabled).map((o) => o.operation),
      disabled_operations: operations.filter((o) => !o.enabled).map((o) => o.operation),
    },
  };
}

function normalizeOperationKey(operationName) {
  const op = safeString(operationName).trim();
  if (!op) return "";
  if (op === "attach_script") return "attach_script_to_scene_root";
  return op;
}

function buildOperationResolution(rawTools) {
  const manifest = deriveSupportedOperations(rawTools);
  const byOperation = new Map(
    (Array.isArray(manifest?.operations) ? manifest.operations : [])
      .filter((o) => o && safeString(o.operation).trim())
      .map((o) => [safeString(o.operation).trim(), o])
  );
  const resolve = (operationName) => {
    const requested = safeString(operationName).trim();
    const normalized = normalizeOperationKey(requested);
    if (!normalized) {
      return { ok: false, operation: requested, requested_operation: normalized, reason: "operation name is empty" };
    }
    const match = byOperation.get(normalized);
    if (!match) {
      return {
        ok: false,
        operation: requested,
        requested_operation: normalized,
        reason: `operation is not defined in catalog mapping: ${normalized}`,
      };
    }
    if (!match.enabled) {
      return {
        ok: false,
        operation: requested,
        requested_operation: normalized,
        reason: `operation is not enabled from discovery: ${normalized}`,
        operation_manifest: match,
      };
    }
    return {
      ok: true,
      operation: requested,
      requested_operation: normalized,
      mode: match.mode,
      operation_manifest: match,
      matched_tools: Array.isArray(match.matched_tools) ? match.matched_tools : [],
    };
  };

  return {
    raw_tools: manifest.raw_tools,
    operations: manifest.operations,
    categories: manifest.categories,
    summary: manifest.summary,
    by_operation: byOperation,
    resolve,
  };
}

function resolveFactoryOperation(rawTools, operationName) {
  return buildOperationResolution(rawTools).resolve(operationName);
}

function isPlainObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

export {
  normalizeToolKey,
  normalizeRawTools,
  deriveSupportedOperations,
  buildOperationResolution,
  resolveFactoryOperation,
  findToolsByKeyword,
  classifyPrerequisites,
};

