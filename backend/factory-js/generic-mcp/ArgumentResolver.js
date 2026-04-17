/**
 * ArgumentResolver
 * -----------------------------------------------------------------------------
 * Thin argument stage for Generic MCP.
 *
 * Responsibilities:
 * - materialize semantic aliases from planner output
 * - inject session-derived args (projectPath-like fields)
 * - validate required args against live tool schema
 *
 * Intentionally out of scope:
 * - file/node search heuristics
 * - compile-time mutation transforms
 * - tool execution and presentation
 */

import { classifyToolArgs, isNodeRefSlot, semanticArgCandidates } from "./ArgRoleClassifier.js";
import { getSessionClient } from "./utils/session-client.js";

function safeString(value) {
  return value == null ? "" : String(value);
}

function isPlainObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function normalizeKey(key) {
  // Canonicalize snake/camel/kebab key styles to one identity token.
  // Example: node_ref / nodeRef / node-ref => noderef
  return safeString(key).toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isPathLikeArg(argKey) {
  const nk = normalizeKey(argKey);
  if (!nk) return false;
  if (nk.includes("nodepath") || nk.includes("parentpath") || nk.includes("targetnode")) return false;
  return nk.endsWith("path") || nk.includes("filepath") || nk.includes("scenepath") || nk.includes("resourcepath") || nk.includes("scriptpath");
}

function isExplicitOutputPathArg(argKey) {
  const nk = normalizeKey(argKey);
  if (!nk) return false;
  return (
    nk.includes("outputpath") ||
    nk.includes("outputfile") ||
    nk.includes("outfile") ||
    nk.includes("destinationpath") ||
    nk.includes("destinationfile") ||
    nk.includes("destination") ||
    nk.includes("exportpath") ||
    nk.includes("buildpath") ||
    nk.includes("savepath") ||
    nk.includes("targetfile")
  );
}

function defaultPathPolicyForArg(argKey, _args, { synthesized = false, sessionInjected = false } = {}) {
  const nk = normalizeKey(argKey);
  if (sessionInjected) {
    return { provenance: "session_injected", existencePolicy: "must_exist" };
  }
  if (synthesized) {
    return { provenance: "synthesized_new_path", existencePolicy: "may_not_exist_yet" };
  }
  if (!isPathLikeArg(nk)) {
    return { provenance: "user_supplied_exact_path", existencePolicy: "must_exist" };
  }
  if (isExplicitOutputPathArg(argKey)) {
    return { provenance: "explicit_output_path", existencePolicy: "may_not_exist_yet" };
  }
  return { provenance: "user_supplied_exact_path", existencePolicy: "must_exist" };
}

function normalizeProjectRelativePath(value) {
  const raw = safeString(value).trim();
  if (!raw) return null;
  return raw
    .replace(/^res:\/\//i, "")
    .replace(/^\/+/, "")
    .replace(/\\/g, "/");
}

function hasNonEmpty(value) {
  return value != null && safeString(value).trim() !== "";
}
function toCanonicalGodotResourcePath(value) {
  const normalized = normalizeProjectRelativePath(value);
  return normalized ? `res://${normalized}` : null;
}

function isLikelyMarkerToken(value) {
  const v = safeString(value).trim().toLowerCase();
  return (
    v === "called" ||
    v === "named" ||
    v === "node" ||
    v === "script" ||
    v === "scene" ||
    v === "this" ||
    v === "that" ||
    v === "it" ||
    v === "here" ||
    v === "there"
  );
}

function looksLikeCodePayload(value) {
  const text = safeString(value);
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (trimmed.includes("```")) return true;
  if (/[{};]/.test(trimmed) && /[=()]/.test(trimmed)) return true;
  if (/\n/.test(trimmed) && /(^|\n)\s*(extends|class_name|func|var|const|if|for|while|return|pass)\b/i.test(trimmed)) {
    return true;
  }
  if (/\n/.test(trimmed) && /(^|\n)\s*(def|class|function|import|from)\b/i.test(trimmed)) {
    return true;
  }
  return false;
}

function normalizeBaseState(status) {
  return {
    status: status || "unsupported",
    tools: [],
    missingArgs: [],
    ambiguities: [],
    reason: null,
  };
}

function normalizeResolverStatus(status) {
  const s = safeString(status).trim().toLowerCase();
  if (s === "resolved") return "resolved";
  if (s === "ambiguous") return "ambiguous";
  if (s === "not_found" || s === "notfound" || s === "no_match") return "not_found";
  return "missing";
}
function camelToSnake(value) {
  return safeString(value).replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

export class ArgumentResolver {
  constructor({
    sessionManager = null,
    toolInventory = null,
    debug = false,
  } = {}) {
    this._sessionManager = sessionManager;
    this._toolInventory = toolInventory;
    this._debug =
      Boolean(debug) ||
      safeString(process.env.DEBUG_GENERIC_MCP_VERIFY).trim().toLowerCase() === "true";
  }

  _extractResolvedProjectPath(args) {
    const out = isPlainObject(args) ? args : {};
    for (const key of Object.keys(out)) {
      if (!this._isProjectPathKey(normalizeKey(key))) continue;
      const raw = safeString(out[key]).trim();
      if (!raw || isLikelyMarkerToken(raw)) continue;
      return raw;
    }
    return null;
  }

  async resolve(plan, { sessionStatus = null, toolInventory = null, workflowState = null } = {}) {
    const input = isPlainObject(plan) ? plan : null;
    if (!input) {
      return {
        ...normalizeBaseState("unsupported"),
        reason: "Plan must be an object.",
      };
    }

    // console.log("[ArgumentResolver] plan",plan.tools);

    const status = safeString(input.status).trim();
    if (!["ready", "missing_args", "ambiguous", "unsupported", "not_found", "not_ready"].includes(status)) {
      return {
        ...normalizeBaseState("unsupported"),
        reason: "Plan status is invalid.",
      };
    }
    if (status === "unsupported" || status === "ambiguous" || status === "not_found" || status === "not_ready") {
      return {
        status,
        tools: [],
        missingArgs: Array.isArray(input.missingArgs) ? input.missingArgs : [],
        ambiguities: Array.isArray(input.ambiguities) ? input.ambiguities : [],
        reason: safeString(input.reason).trim() || null,
      };
    }

    const tools = Array.isArray(input.tools) ? input.tools : [];
    if (tools.length < 1) {
      return {
        ...normalizeBaseState("unsupported"),
        reason: "No tools provided for argument resolution.",
      };
    }
    
    const liveSessionStatus = sessionStatus ?? (await this._getSessionStatus());
    const liveInventory = toolInventory ?? this._toolInventory;

    const resolvedTools = [];
    const missingArgs = [];
    const ambiguities = [];

    for (const tool of tools) {
      const name = safeString(tool?.name).trim();
      const args = isPlainObject(tool?.args) ? { ...tool.args } : {};
      if (!name) {
        return {
          ...normalizeBaseState("unsupported"),
          reason: "Tool entry is missing name.",
        };
      }

      const materialized = this.materializeSemanticAliases({
        toolName: name,
        args,
        inventory: liveInventory,
      });
      const classified = this.classifyArgs({ toolName: name, args: materialized.args, inventory: liveInventory });
      const withSession = this.injectSessionArgs({ toolName: name, args: materialized.args, sessionStatus: liveSessionStatus, classification: classified });
      const validation = this.validateResolvedArgs({
        toolName: name,
        args: withSession.args,
        inventory: liveInventory,
      });
      resolvedTools.push({
        name,
        args: withSession.args,
        argMeta: {},
      });
      missingArgs.push(
        ...withSession.missingArgs,
        ...(Array.isArray(validation?.missingArgs) ? validation.missingArgs : [])
      );
    }

    const uniqueMissing = [...new Set(missingArgs.filter(Boolean))];
    const uniqueAmbiguities = [...new Set(ambiguities.filter(Boolean))];

    if (uniqueAmbiguities.length > 0) {
      return {
        status: "ambiguous",
        tools: resolvedTools,
        missingArgs: [],
        ambiguities: uniqueAmbiguities,
        reason: null,
      };
    }

    if (uniqueMissing.length > 0) {
      return {
        status: "missing_args",
        tools: resolvedTools,
        missingArgs: uniqueMissing,
        ambiguities: [],
        reason: null,
      };
    }
    // console.log("[Arugmentresolver] return ", resolvedTools);
    return {
      status: "ready",
      tools: resolvedTools,
      missingArgs: [],
      ambiguities: [],
      reason: null,
    };
  }

  classifyArgs({ toolName, args, inventory = null } = {}) {
    const toolSchema = this._getToolSchema(toolName, inventory);
    const roleInfo = classifyToolArgs({ toolName, inputSchema: toolSchema, args });
    const inputArgs = isPlainObject(args) ? args : {};
    const classified = {
      session_context_args: [],
      file_resource_ref_args: [],
      node_target_args: [],
      plain_user_args: [],
      rolesByArg: roleInfo.rolesByArg,
    };
    for (const key of Object.keys(roleInfo.rolesByArg)) {
      const roleMeta = roleInfo.rolesByArg[key];
      const role = safeString(roleMeta?.role).trim();
      const nk = normalizeKey(key);
      const hasProvidedValue = hasNonEmpty(inputArgs[key]);
      const looksNodeTarget = this._isNodeTargetKey(nk) || isNodeRefSlot(roleMeta?.semanticSlot);
      const looksFileRef = this._isFileResourceRefKey(nk) || this._isFileResourceSemanticSlot(roleMeta?.semanticSlot);
      if (role === "session_injected") {
        classified.session_context_args.push(key);
        continue;
      }
      if (
        role === "semantic_ref" ||
        (role === "optional" && hasProvidedValue && (looksNodeTarget || looksFileRef))
      ) {
        if (looksNodeTarget) {
          classified.node_target_args.push(key);
        } else if (looksFileRef) {
          classified.file_resource_ref_args.push(key);
        }
        continue;
      }
      classified.plain_user_args.push(key);
    }
    return classified;
  }

  materializeSemanticAliases({ toolName, args, inventory = null } = {}) {
    const out = { ...(isPlainObject(args) ? args : {}) };
    const schema = this._getToolSchema(toolName, inventory);
    const roleInfo = classifyToolArgs({ toolName, inputSchema: schema, args: out });
    for (const key of roleInfo.required) {
      if (hasNonEmpty(out[key])) continue;
      const roleMeta = roleInfo.rolesByArg[key];
      const role = safeString(roleMeta?.role).trim();
      if (!["semantic_ref", "direct_user_value"].includes(role)) continue;
      const slot = safeString(roleMeta?.semanticSlot).trim() || key;
      const candidates = semanticArgCandidates(key, slot);
      const keyNorm = normalizeKey(key);
      const keyIsNodeTarget = this._isNodeTargetKey(keyNorm);
      const keyIsFileTarget = this._isFileResourceRefKey(keyNorm);
      for (const cand of candidates) {
        if (!hasNonEmpty(out[cand])) continue;
        const candNorm = normalizeKey(cand);
        const candVal = safeString(out[cand]).trim();
        if (keyIsNodeTarget) {
          if (this._isFileResourceRefKey(candNorm)) continue;
          if (this._looksLikeFileResourceValue(candVal)) continue;
        }
        if (keyIsFileTarget) {
          if (this._isNodeTargetKey(candNorm)) continue;
        }
        out[key] = out[cand];
        break;
      }
    }
    return { args: out };
  }

  injectSessionArgs({ toolName, args, sessionStatus, classification } = {}) {
    const out = { ...(isPlainObject(args) ? args : {}) };
    const missingArgs = [];
    const injectedKeys = [];
    const sessionPath = normalizeProjectRelativePath(sessionStatus?.connectedProjectPath) ? sessionStatus?.connectedProjectPath : null;
    const keys = Array.isArray(classification?.session_context_args) ? classification.session_context_args : [];

    // Session context keys are not user/file refs; they must come from session.
    for (const key of keys) {
      if (out[key] != null && safeString(out[key]).trim()) continue;
      if (this._isProjectPathKey(normalizeKey(key))) {
        if (sessionPath) {
          out[key] = sessionPath;
          injectedKeys.push(key);
        }
        else missingArgs.push(key);
      }
    }
    return { args: out, missingArgs, injectedKeys };
  }

  validateResolvedArgs({ toolName, args, inventory = null } = {}) {
    const schema = this._getToolSchema(toolName, inventory);
    const required = Array.isArray(schema?.required)
      ? schema.required.map((k) => safeString(k).trim()).filter(Boolean)
      : [];
    const out = isPlainObject(args) ? args : {};
    const roleInfo = classifyToolArgs({ toolName, inputSchema: schema, args: out });
    const hasValueForKey = (requiredKey) => {
      const direct = out[requiredKey];
      if (direct != null && safeString(direct).trim() !== "") return true;
      const roleMeta = isPlainObject(roleInfo?.rolesByArg?.[requiredKey]) ? roleInfo.rolesByArg[requiredKey] : null;
      const slot = safeString(roleMeta?.semanticSlot).trim() || requiredKey;
      const candidates = semanticArgCandidates(requiredKey, slot);
      for (const candidate of candidates) {
        if (Object.prototype.hasOwnProperty.call(out, candidate)) {
          const value = out[candidate];
          if (value != null && safeString(value).trim() !== "") return true;
        }
      }
      const wanted = normalizeKey(requiredKey);
      if (!wanted) return false;
      for (const [key, value] of Object.entries(out)) {
        if (normalizeKey(key) !== wanted) continue;
        if (value != null && safeString(value).trim() !== "") return true;
      }
      return false;
    };
    const missingArgs = [];
    for (const key of required) {
      if (!hasValueForKey(key)) missingArgs.push(key);
    }
    return { ok: missingArgs.length === 0, missingArgs };
  }

  async _getSessionStatus() {
    if (!this._sessionManager || typeof this._sessionManager.getStatus !== "function") {
      return {
        connected: false,
        bridgeReady: false,
        connectedProjectPath: null,
        sessionId: null,
        mcpClientReady: false,
      };
    }
    return this._sessionManager.getStatus();
  }

  _getToolSchema(toolName, inventory = null) {
    const inv = inventory ?? this._toolInventory;
    const getTool = inv && typeof inv.getTool === "function" ? inv.getTool.bind(inv) : null;
    if (!getTool) return {};
    const tool = getTool(toolName);
    const schema = isPlainObject(tool?.inputSchema) ? tool.inputSchema : {};
    return schema;
  }

  _isProjectPathKey(normalized) {
    return (
      normalized.includes("projectpath") ||
      normalized.includes("projectref") ||
      normalized.includes("project_root") ||
      normalized.includes("project_ref") ||
      normalized.includes("projectroot") ||
      normalized.includes("project_path")
    );
  }

  _isNodeTargetKey(normalized) {
    return (
      normalized.includes("nodepath") ||
      normalized.includes("noderef") ||
      normalized.includes("parentpath") ||
      normalized.includes("targetnode")
    );
  }

  _isFileResourceRefKey(normalized) {
    if (this._isProjectPathKey(normalized)) return false;
    return (
      normalized.includes("sceneref") ||
      normalized.includes("fileref") ||
      normalized.includes("scriptref") ||
      normalized.includes("resourceref") ||
      normalized.includes("textureref") ||
      normalized.includes("artifactref") ||
      normalized.includes("scenepath") ||
      normalized.includes("filepath") ||
      normalized.includes("scriptpath") ||
      normalized.includes("resourcepath") ||
      normalized.includes("texturepath") ||
      (normalized.endsWith("path") && !this._isNodeTargetKey(normalized))
    );
  }

  _isFileResourceSemanticSlot(slot) {
    const normalized = normalizeKey(slot);
    if (!normalized) return false;
    if (this._isProjectPathKey(normalized)) return false;
    if (this._isNodeTargetKey(normalized)) return false;
    return (
      normalized.includes("sceneref") ||
      normalized.includes("fileref") ||
      normalized.includes("scriptref") ||
      normalized.includes("resourceref") ||
      normalized.includes("textureref") ||
      normalized.includes("artifactref")
    );
  }

  _looksLikeFileResourceValue(value) {
    const raw = safeString(value).trim();
    if (!raw) return false;
    if (/^res:\/\//i.test(raw)) return true;
    const normalized = raw.replace(/\\/g, "/");
    const withoutScheme = normalized.replace(/^res:\/\//i, "").replace(/^\/+/, "");
    return /\.[a-z0-9_]+$/i.test(withoutScheme);
  }

  _normalizeResolverResult(result, value, argKey) {
    const raw = isPlainObject(result) ? result : {};
    // console.log("[ArgumentResolver] normalizeResolve ", raw);
    const status = normalizeResolverStatus(raw.status);
    if (status === "resolved") {
      return {
        status: "resolved",
        value: raw.value ?? raw.resolved ?? value,
        ambiguities: [],
      };
    }
    if (status === "ambiguous") {
      const ambiguities = Array.isArray(raw.ambiguities)
        ? raw.ambiguities.map((x) => safeString(x).trim()).filter(Boolean)
        : [`Ambiguous values for ${argKey}`];
        // console.log("[ArgumentResolver] normalizeResolve ",ambiguities);
      return { status: "ambiguous", value: null, ambiguities };
    }
    if (status === "not_found") {
      return {
        status: "not_found",
        value: null,
        ambiguities: [],
        missingArg: argKey,
      };
    }
    return {
      status: "missing",
      value: null,
      ambiguities: [],
      missingArg: argKey,
    };
  }
}
