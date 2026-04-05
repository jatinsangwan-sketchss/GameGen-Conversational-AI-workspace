/**
 * PlannerCatalogBuilder
 * -----------------------------------------------------------------------------
 * Builds a compact planner-facing catalog from live MCP tool inventory.
 *
 * This keeps execution truth unchanged (full tool schemas remain in ToolInventory),
 * while minimizing planner token footprint by exposing only compact semantics.
 */
import { classifyToolArgs, semanticSlotForArg } from "./ArgRoleClassifier.js";

function safeString(value) {
  return value == null ? "" : String(value);
}

function isPlainObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function words(input) {
  return safeString(input)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

function toSentenceSummary(description, fallbackName) {
  const text = safeString(description).trim().replace(/\s+/g, " ");
  if (!text) return titleizeFromName(fallbackName);
  const sentence = text.split(/[.!?]\s+/)[0] || text;
  const clipped = sentence.split(/\s+/).slice(0, 14).join(" ");
  return clipped.replace(/\.$/, "");
}

function titleizeFromName(name) {
  const toks = words(name);
  if (toks.length === 0) return "Use tool";
  const verb = toks[0][0]?.toUpperCase() + toks[0].slice(1);
  const rest = toks.slice(1, 6).join(" ");
  return rest ? `${verb} ${rest}` : verb;
}

function inferVerbCategory(name) {
  const toks = words(name);
  const first = toks[0] ?? null;
  const verbs = new Set(["get", "list", "find", "search", "create", "new", "add", "set", "save", "update", "delete", "remove", "open", "close", "run", "execute"]);
  return {
    verb: first && verbs.has(first) ? first : null,
    category: toks[1] ?? null,
  };
}

function compactTags(toolName, description, required) {
  const base = [...words(toolName), ...words(description), ...required.map((r) => semanticSlotForArg(r).toLowerCase())];
  const noise = new Set(["tool", "mcp", "the", "a", "an", "for", "to", "of", "and", "with", "from", "in", "on", "by", "using"]);
  const out = [];
  const seen = new Set();
  for (const t of base) {
    if (!t || noise.has(t) || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= 8) break;
  }
  return out;
}

function readInputSchema(tool) {
  return (isPlainObject(tool?.inputSchema) && tool.inputSchema) || (isPlainObject(tool?.input_schema) && tool.input_schema) || {};
}

export function buildPlannerCatalog(tools = []) {
  const compact = [];
  for (const tool of Array.isArray(tools) ? tools : []) {
    const name = safeString(tool?.name).trim();
    if (!name) continue;
    const description = safeString(tool?.description).trim();
    const schema = readInputSchema(tool);
    const required = Array.isArray(schema.required) ? schema.required.map((k) => safeString(k).trim()).filter(Boolean) : [];
    const roles = classifyToolArgs({ toolName: name, inputSchema: schema }).rolesByArg;

    const slotToArg = {};
    const requiredSlots = [];
    for (const arg of required) {
      const roleMeta = roles[arg];
      const role = safeString(roleMeta?.role).trim();
      // Planner-level required slots should represent semantic/direct user input,
      // not execution-only session-injected or derived output-path requirements.
      if (role === "session_injected" || role === "creation_intent_derived" || role === "optional") continue;
      const slot = semanticSlotForArg(arg);
      if (!slot) continue;
      if (!Object.prototype.hasOwnProperty.call(slotToArg, slot)) {
        slotToArg[slot] = arg;
        requiredSlots.push(slot);
      } else {
        // Preserve raw name when normalization collides.
        slotToArg[arg] = arg;
        requiredSlots.push(arg);
      }
    }

    const vc = inferVerbCategory(name);
    compact.push({
      name,
      summary: toSentenceSummary(description, name),
      requiredSlots,
      slotToArg,
      tags: compactTags(name, description, required),
      verb: vc.verb,
      category: vc.category,
    });
  }
  return compact;
}
