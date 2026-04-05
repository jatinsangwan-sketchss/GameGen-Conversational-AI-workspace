import { classifyToolArgs, semanticSlotForArg } from "./ArgRoleClassifier.js";

function safeString(value) {
  return value == null ? "" : String(value);
}

function isPlainObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function normalizeKey(key) {
  return safeString(key).toLowerCase().replace(/[^a-z0-9_]/g, "");
}

function isExecutionPathLikeKey(key) {
  const nk = normalizeKey(key);
  return nk.endsWith("path") || nk.includes("projectpath");
}

function isSemanticSlotName(name) {
  return /ref$/i.test(safeString(name).trim());
}

export function toSemanticField(field) {
  const f = safeString(field).trim();
  if (!f) return null;
  const lower = f.toLowerCase();
  if (["modifications", "operations", "edits", "patches", "changes"].includes(lower)) return "contentIntent";
  if (lower === "codeintent") return "contentIntent";
  const slot = safeString(semanticSlotForArg(f)).trim();
  if (slot && slot !== f) return slot;
  if (/path$/i.test(f)) return f.replace(/path$/i, "Ref");
  return f;
}

function getToolSchemaFromInventory(toolName, inventory) {
  const tools = Array.isArray(inventory?.tools) ? inventory.tools : [];
  const tool = tools.find((t) => safeString(t?.name).trim() === safeString(toolName).trim()) ?? null;
  return isPlainObject(tool?.inputSchema) ? tool.inputSchema : {};
}

export function extractSemanticArgs({ toolName, args, inventory = null } = {}) {
  const input = isPlainObject(args) ? args : {};
  const schema = getToolSchemaFromInventory(toolName, inventory);
  const roleInfo = classifyToolArgs({ toolName, inputSchema: schema, args: input });
  const out = {};

  for (const [key, value] of Object.entries(input)) {
    const role = safeString(roleInfo.rolesByArg?.[key]?.role).trim();
    if (role === "session_injected") continue;
    if (isExecutionPathLikeKey(key)) {
      const slot = toSemanticField(key);
      if (slot && isSemanticSlotName(slot)) {
        if (!Object.prototype.hasOwnProperty.call(out, slot)) out[slot] = value;
      }
      continue;
    }
    out[key] = value;
  }

  // If schema contains semantic-ref args and raw execution values were provided,
  // promote raw arg to semantic slot when semantic slot is absent.
  for (const [key, meta] of Object.entries(roleInfo.rolesByArg ?? {})) {
    const role = safeString(meta?.role).trim();
    if (role !== "semantic_ref") continue;
    const slot = toSemanticField(key);
    if (!slot || !isSemanticSlotName(slot)) continue;
    if (Object.prototype.hasOwnProperty.call(out, slot)) continue;
    if (!Object.prototype.hasOwnProperty.call(input, key)) continue;
    out[slot] = input[key];
  }

  return out;
}

export function buildRuntimeState({ planningResult = null, resolvedPlan = null, needsInput = null, inventory = null } = {}) {
  const planning = isPlainObject(planningResult) ? planningResult : {};
  const resolved = isPlainObject(resolvedPlan) ? resolvedPlan : {};
  const pending = isPlainObject(needsInput) ? needsInput : {};
  const planTool = planning?.tools?.[0] ?? resolved?.tools?.[0] ?? null;
  const tool = safeString(planTool?.name).trim() || null;
  const semanticArgs = extractSemanticArgs({
    toolName: tool,
    args: isPlainObject(planning?.tools?.[0]?.args) ? planning.tools[0].args : planTool?.args,
    inventory,
  });
  const resolvedArgs = isPlainObject(resolved?.tools?.[0]?.args) ? { ...resolved.tools[0].args } : {};

  return {
    semantic: {
      tool,
      args: semanticArgs,
      status: safeString(planning?.status).trim() || null,
    },
    resolved: {
      tool: safeString(resolved?.tools?.[0]?.name).trim() || tool,
      args: resolvedArgs,
      status: safeString(resolved?.status).trim() || null,
    },
    clarification: {
      status: safeString(pending?.status).trim() || null,
      kind: safeString(pending?.kind).trim() || null,
      field: safeString(pending?.field).trim() || null,
      options: Array.isArray(pending?.options) ? pending.options : [],
      attemptedValue: safeString(pending?.attemptedValue).trim() || null,
    },
  };
}
