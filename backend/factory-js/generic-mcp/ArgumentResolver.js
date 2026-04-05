/**
 * ArgumentResolver
 * -----------------------------------------------------------------------------
 * Resolves planner-produced tool arguments into an executable, validated plan.
 *
 * This class is the argument stage only:
 * - inject session/context args
 * - **synthesize new resource paths** for create/new (name + folder + inferred ext)
 * - resolve **existing** file/resource refs (project index)
 * - resolve node refs
 * - validate required args
 *
 * Existing refs vs new paths: path-like args (`scenePath`, `filePath`, …) are either
 * looked up or synthesized — see PathSynthesizer (generic, not per-tool switches).
 *
 * It does NOT execute tools or format results.
 */

import {
  isCreatablePathArgName,
  synthesizeMissingCreationPath,
} from "./PathSynthesizer.js";
import { defaultPathPolicyForArg } from "./PathPolicy.js";
import { classifyToolArgs, isNodeRefSlot, semanticArgCandidates } from "./ArgRoleClassifier.js";
import { mapGeneratedContentIntoInlineSink } from "./ContentSinkResolver.js";
import { ensureRichPayloadReadiness } from "./RichArgPayloadSynthesizer.js";

function safeString(value) {
  return value == null ? "" : String(value);
}

function isPlainObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function normalizeKey(key) {
  return safeString(key).toLowerCase().replace(/[^a-z0-9_]/g, "");
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
  return v === "called" || v === "named" || v === "node" || v === "script" || v === "scene";
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
  constructor({ sessionManager = null, fileResolver = null, nodeResolver = null, toolInventory = null, debug = false } = {}) {
    this._sessionManager = sessionManager;
    this._fileResolver = fileResolver;
    this._nodeResolver = nodeResolver;
    this._toolInventory = toolInventory;
    this._debug = Boolean(debug);
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

  /** Shared ProjectFileIndex used for file ref resolution (when fileResolver exposes it). */
  getFileIndex() {
    const fr = this._fileResolver;
    if (fr && typeof fr.getFileIndex === "function") return fr.getFileIndex();
    return null;
  }

  /** File ref resolver (e.g. ResourceResolver) — for orchestrator wiring. */
  getFileResolver() {
    return this._fileResolver ?? null;
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
    // console.log("[ArgumentResolver] tools", tools);
    // console.log("[ArgumentResolver] tools1", Array.isArray(input.tools));
    // console.log("[ArgumentResolver] tools2", input.tools);
    
    const liveSessionStatus = sessionStatus ?? (await this._getSessionStatus());
    const liveInventory = toolInventory ?? this._toolInventory;

    const resolvedTools = [];
    const missingArgs = [];
    const ambiguities = [];
    const notFoundRefs = [];

    for (const tool of tools) {
      const name = safeString(tool?.name).trim();
      const args = isPlainObject(tool?.args) ? { ...tool.args } : {};
      if (!name) {
        return {
          ...normalizeBaseState("unsupported"),
          reason: "Tool entry is missing name.",
        };
      }

      // console.log("[ArgumentResolver] Resolve Args", tool.name, args);
      // Resolution order is strict and explicit:
      // 1) session/context injection
      // 2) creation-path synthesis (new resources — before index resolution)
      // 3) existing file/resource refs
      // 4) node refs
      // 5) required-arg validation
      const materialized = this.materializeSemanticAliases({
        toolName: name,
        args,
        inventory: liveInventory,
      });
      const classified = this.classifyArgs({ toolName: name, args: materialized.args, inventory: liveInventory });
      const withSession = this.injectSessionArgs({ toolName: name, args: materialized.args, sessionStatus: liveSessionStatus, classification: classified });
      const synthesized = this.synthesizeCreationPaths({
        toolName: name,
        args: withSession.args,
        inventory: liveInventory,
      });
      const classifiedAfterSynth = this.classifyArgs({ toolName: name, args: synthesized.args, inventory: liveInventory });
      const fileResolved = await this.resolveFileRefs({
        toolName: name,
        args: synthesized.args,
        classification: classifiedAfterSynth,
        synthesizedKeys: synthesized.synthesizedKeys,
        sessionInjectedKeys: withSession.injectedKeys,
        workflowState,
      });
      // console.log("[argumentResolver] outside ", fileResolved);
      const nodeResolved = await this.resolveNodeRefs({
        toolName: name,
        args: fileResolved.args,
        classification: classifiedAfterSynth,
        workflowState,
      });
      const validation = this.validateResolvedArgs({
        toolName: name,
        args: nodeResolved.args,
        inventory: liveInventory,
      });

      const compiled = await this.compileExecutableArgs({
        toolName: name,
        args: nodeResolved.args,
        argMeta: fileResolved.argMeta,
        inventory: liveInventory,
        workflowState,
      });

      resolvedTools.push({
        name,
        args: compiled.args,
        argMeta: compiled.argMeta,
      });
      const postCompileValidation =
        compiled.status === "ready"
          ? this.validateResolvedArgs({
              toolName: name,
              args: compiled.args,
              inventory: liveInventory,
            })
          : validation;
      missingArgs.push(
        ...withSession.missingArgs,
        ...fileResolved.missingArgs,
        ...nodeResolved.missingArgs,
        ...(Array.isArray(postCompileValidation?.missingArgs) ? postCompileValidation.missingArgs : [])
      );
      notFoundRefs.push(...fileResolved.notFoundRefs);
      notFoundRefs.push(...(Array.isArray(nodeResolved?.notFoundRefs) ? nodeResolved.notFoundRefs : []));
      ambiguities.push(...fileResolved.ambiguities, ...nodeResolved.ambiguities);

      if (compiled.status === "uncompilable") {
        return {
          status: "uncompilable",
          tools: resolvedTools,
          missingArgs: [],
          ambiguities: [],
          reason: compiled.reason || "Executable payload is uncompilable.",
        };
      }
      if (compiled.status === "not_found") {
        return {
          status: "not_found",
          tools: resolvedTools,
          missingArgs: [],
          ambiguities: [],
          reason: compiled.reason || "Referenced artifact target was not found.",
        };
      }
      if (compiled.status === "ambiguous") {
        return {
          status: "ambiguous",
          tools: resolvedTools,
          missingArgs: [],
          ambiguities: Array.isArray(compiled.ambiguities) ? compiled.ambiguities : [],
          reason: compiled.reason || null,
        };
      }
      if (compiled.status === "missing_args") {
        return {
          status: "missing_args",
          tools: resolvedTools,
          missingArgs: Array.isArray(compiled.missingArgs) ? compiled.missingArgs : [],
          ambiguities: [],
          reason: compiled.reason || null,
        };
      }
    }

    const uniqueMissing = [...new Set(missingArgs.filter(Boolean))];
    const uniqueAmbiguities = [...new Set(ambiguities.filter(Boolean))];
    const uniqueNotFound = [...new Set(notFoundRefs.filter(Boolean))];

    if (uniqueAmbiguities.length > 0) {
      return {
        status: "ambiguous",
        tools: resolvedTools,
        missingArgs: [],
        ambiguities: uniqueAmbiguities,
        reason: null,
      };
    }

    if (uniqueNotFound.length > 0) {
      return {
        status: "not_found",
        tools: resolvedTools,
        missingArgs: [],
        ambiguities: [],
        reason: `Referenced path(s) not found: ${uniqueNotFound.join(", ")}`,
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
      if (role === "session_injected") {
        classified.session_context_args.push(key);
        continue;
      }
      if (role === "semantic_ref" || role === "creation_intent_derived") {
        if (this._isNodeTargetKey(nk) || isNodeRefSlot(roleMeta?.semanticSlot)) {
          classified.node_target_args.push(key);
        } else if (this._isFileResourceRefKey(nk)) {
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
      if (!["semantic_ref", "creation_intent_derived", "direct_user_value"].includes(role)) continue;
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

  /**
   * Fills missing required path args from structured creation intent (planner args).
   * Synthesized keys skip ResourceResolver (non-existent paths are not index lookups).
   */
  synthesizeCreationPaths({ toolName, args, inventory = null } = {}) {
    const out = { ...(isPlainObject(args) ? args : {}) };
    const synthesizedKeys = new Set();
    const required = this._getRequiredArgs(toolName, inventory ?? this._toolInventory);
    for (const key of required) {
      const val = out[key];
      if (val != null && safeString(val).trim() !== "") continue;
      if (!isCreatablePathArgName(key)) continue;
      const syn = synthesizeMissingCreationPath(key, out);
      if (syn.ok && syn.relativePath) {
        out[key] = syn.relativePath;
        synthesizedKeys.add(key);
        if (this._debug && syn.meta) {
          console.error(
            "[generic-mcp][args] path synthesis",
            JSON.stringify({
              tool: toolName,
              synthesizedArg: key,
              sources: syn.meta.sources,
              ext: syn.meta.ext,
              finalPath: syn.meta.finalPath ?? syn.relativePath,
            })
          );
        }
      }
    }
    return { args: out, synthesizedKeys };
  }

  async resolveFileRefs({ toolName, args, classification, synthesizedKeys = new Set(), sessionInjectedKeys = [], workflowState = null } = {}) {
    const out = { ...(isPlainObject(args) ? args : {}) };
    const missingArgs = [];
    const notFoundRefs = [];
    const ambiguities = [];
    const argMeta = {};
    const keys = Array.isArray(classification?.file_resource_ref_args) ? classification.file_resource_ref_args : [];
    const sessionInjectedSet = new Set(Array.isArray(sessionInjectedKeys) ? sessionInjectedKeys : []);
    
    // console.log("[ArgumentResolver] anoher one ",{ args:out});

    const opMode = safeString(workflowState?.artifactOperation?.mode).trim().toLowerCase();
    const requiresExistingTarget = opMode === "modify_existing" || opMode === "modify_then_attach" || opMode === "attach_existing";
    const isAttachMode = opMode === "attach_existing" || opMode === "create_then_attach" || opMode === "modify_then_attach";
    const typedAttachRefs = ["scriptRef", "fileRef", "resourceRef", "artifactRef"];
    const mergedKeys = [...keys];
    if (isAttachMode) {
      for (const refKey of typedAttachRefs) {
        if (!mergedKeys.includes(refKey)) mergedKeys.push(refKey);
      }
    }

    for (const key of mergedKeys) {
      if (this._isProjectPathKey(normalizeKey(key))) continue;
      const raw = out[key];
      if (raw == null || safeString(raw).trim() === "") continue;
      if (isLikelyMarkerToken(raw)) {
        missingArgs.push(key);
        continue;
      }
      // Policy layer: existing refs (must_exist) resolve via index; create/new path
      // targets (may_not_exist_yet) pass through without not_found checks.
      const policy = defaultPathPolicyForArg(key, out, {
        synthesized: synthesizedKeys.has(key),
        sessionInjected: sessionInjectedSet.has(key),
      });
      const normalizedKey = normalizeKey(key);
      const isPathLikeRef = this._isFileResourceRefKey(normalizedKey);
      if (requiresExistingTarget && isPathLikeRef) {
        policy.existencePolicy = "must_exist";
        if (!safeString(policy.provenance).trim()) {
          policy.provenance = "resolved_existing_ref";
        }
      }
      argMeta[key] = policy;
      if (policy.existencePolicy !== "must_exist") {
        if (this._debug) {
          console.error(
            "[generic-mcp][args] path policy",
            JSON.stringify({ tool: toolName, arg: key, policy, value: safeString(raw).trim() })
          );
        }
        continue;
      }
      const resolved = await this._resolveFileRef({
        toolName,
        argKey: key,
        value: raw,
      });
      // console.log("[ArgumentResolver] resolveFIle ", resolved);      
      if (resolved.status === "resolved") {
        out[key] = resolved.value;
        const nk = normalizeKey(key);
        if (isAttachMode) {
          if (nk.includes("scriptref") && !safeString(out.scriptPath).trim()) out.scriptPath = resolved.value;
          if (nk.includes("fileref") && !safeString(out.filePath).trim()) out.filePath = resolved.value;
          if (nk.includes("resourceref") && !safeString(out.resourcePath).trim()) out.resourcePath = resolved.value;
          if (nk.includes("artifactref")) {
            if (!safeString(out.scriptPath).trim()) out.scriptPath = resolved.value;
            if (!safeString(out.filePath).trim()) out.filePath = resolved.value;
            if (!safeString(out.resourcePath).trim()) out.resourcePath = resolved.value;
          }
        }
        if (this._debug) {
          console.error("[generic-mcp][args] existing ref resolved", JSON.stringify({ tool: toolName, arg: key, input: safeString(raw).trim(), resolved: resolved.value }));
        }
        argMeta[key] = { provenance: "resolved_existing_ref", existencePolicy: "must_exist" };
      } else if (resolved.status === "ambiguous") {
        ambiguities.push(...resolved.ambiguities);
      } else if (resolved.status === "not_found") {
        const retried = await this._retryAfterIndexUpsert({ toolName, argKey: key, rawValue: raw });
        if (retried.status === "resolved") {
          out[key] = retried.value;
          if (this._debug) {
            console.error("[generic-mcp][args] existing ref resolved after upsert", JSON.stringify({ tool: toolName, arg: key, input: safeString(raw).trim(), resolved: retried.value }));
          }
          argMeta[key] = { provenance: "resolved_existing_ref", existencePolicy: "must_exist" };
        } else {
          notFoundRefs.push(`${key} (not_found: ${safeString(raw).trim()})`);
        }
      } else if (resolved.status === "missing") {
        missingArgs.push(key);
      }
    }
    for (const key of synthesizedKeys) {
      argMeta[key] = {
        provenance: "synthesized_new_path",
        existencePolicy: "may_not_exist_yet",
      };
    }
    if (isAttachMode) this._alignAttachScriptResourceProperty(out);
    return { args: out, missingArgs, notFoundRefs, ambiguities, argMeta };
  }

  _alignAttachScriptResourceProperty(args = {}) {
    const out = isPlainObject(args) ? args : {};
    const scriptRef = safeString(out.scriptPath).trim() || safeString(out.scriptRef).trim();
    const canonical = toCanonicalGodotResourcePath(scriptRef);
    if (!canonical) return;
    const normalizeScriptValue = () => ({ type: "Resource", path: canonical });
    const containerKeys = ["propertyMap", "properties", "props"];
    for (const key of containerKeys) {
      const raw = out[key];
      if (raw == null) continue;
      if (isPlainObject(raw) && Object.prototype.hasOwnProperty.call(raw, "script")) {
        out[key] = { ...raw, script: normalizeScriptValue() };
        continue;
      }
      if (typeof raw === "string") {
        try {
          const parsed = JSON.parse(raw);
          if (isPlainObject(parsed) && Object.prototype.hasOwnProperty.call(parsed, "script")) {
            parsed.script = normalizeScriptValue();
            out[key] = JSON.stringify(parsed);
          }
        } catch {
          // ignore non-json
        }
      }
    }
  }

  async resolveNodeRefs({ toolName, args, classification, workflowState = null } = {}) {
    const out = { ...(isPlainObject(args) ? args : {}) };
    const missingArgs = [];
    const ambiguities = [];
    const notFoundRefs = [];
    const keys = Array.isArray(classification?.node_target_args) ? classification.node_target_args : [];
    const artifactValues = new Set();
    for (const k of ["scriptRef", "fileRef", "resourceRef", "artifactRef", "scriptPath", "filePath", "resourcePath", "path"]) {
      const v = safeString(out[k]).trim();
      if (v) artifactValues.add(v);
    }

    // Node target resolution depends on scene/file resolution already being done.
    // console.log("[generic-mcp][args] resolveNodeRefs out", out);
    const scenePath = this._extractResolvedScenePath(out, workflowState);
    // console.log("scenePath [ArgumentResolver]", scenePath);
    for (const key of keys) {
      const raw = out[key];
      if (raw == null || safeString(raw).trim() === "") continue;
      const rawText = safeString(raw).trim();
      if (isLikelyMarkerToken(rawText)) {
        missingArgs.push(key);
        continue;
      }
      if (this._looksLikeFileResourceValue(rawText) || artifactValues.has(rawText)) {
        notFoundRefs.push(`${key} (not_found: ${rawText})`);
        continue;
      }
      const resolved = await this._resolveNodeRef({
        toolName,
        argKey: key,
        value: raw,
        scenePath,
      });
      if (resolved.status === "resolved") {
        out[key] = resolved.value;
      } else if (resolved.status === "ambiguous") {
        ambiguities.push(...resolved.ambiguities);
      } else if (resolved.status === "not_found") {
        notFoundRefs.push(`${key} (not_found: ${safeString(raw).trim()})`);
      } else if (resolved.status === "missing") {
        missingArgs.push(key);
      }
    }
    return { args: out, missingArgs, ambiguities, notFoundRefs };
  }

  validateResolvedArgs({ toolName, args, inventory = null } = {}) {
    const required = this._getRequiredArgs(toolName, inventory);
    const out = isPlainObject(args) ? args : {};
    const missingArgs = [];
    for (const key of required) {
      const val = out[key];
      if (val == null || safeString(val).trim() === "") missingArgs.push(key);
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

  _getRequiredArgs(toolName, inventory = null) {
    const schema = this._getToolSchema(toolName, inventory);
    const required = Array.isArray(schema.required)
      ? schema.required.map((k) => safeString(k).trim()).filter(Boolean)
      : [];
    return required;
  }

  _getToolSchema(toolName, inventory = null) {
    const inv = inventory ?? this._toolInventory;
    const getTool = inv && typeof inv.getTool === "function" ? inv.getTool.bind(inv) : null;
    if (!getTool) return {};
    const tool = getTool(toolName);
    const schema = isPlainObject(tool?.inputSchema) ? tool.inputSchema : {};
    return schema;
  }

  _isSessionContextKey(normalized) {
    return this._isProjectPathKey(normalized);
  }

  _isProjectPathKey(normalized) {
    return (
      normalized.includes("projectpath") ||
      normalized.includes("project_root") ||
      normalized.includes("projectroot") ||
      normalized.includes("project_path")
    );
  }

  _isFileResourceRefKey(normalized) {
    if (this._isSessionContextKey(normalized)) return false;
    return (
      normalized.includes("scenepath") ||
      normalized.includes("filepath") ||
      normalized.includes("scriptpath") ||
      normalized.includes("resourcepath") ||
      normalized.includes("texturepath") ||
      (normalized.endsWith("path") && !this._isNodeTargetKey(normalized))
    );
  }

  _isNodeTargetKey(normalized) {
    return (
      normalized.includes("nodepath") ||
      normalized.includes("parentpath") ||
      normalized.includes("targetnode")
    );
  }

  _extractResolvedScenePath(args, workflowState = null) {
    const out = isPlainObject(args) ? args : {};
    const semState = isPlainObject(workflowState?.semanticState) ? workflowState.semanticState : {};
    const semIntent = isPlainObject(workflowState?.semanticIntent) ? workflowState.semanticIntent : {};
    const semRefs = isPlainObject(semState?.targetRefs) ? semState.targetRefs : {};
    const intentRefs = isPlainObject(semIntent?.refs) ? semIntent.refs : {};
    const preferredKeys = [
      "scenePath",
      "scene_path",
      "sceneRef",
      "scene",
      "sceneFile",
      "scene_file",
      "path",
    ];
    const orderedKeys = [
      ...preferredKeys,
      ...Object.keys(out).filter((k) => !preferredKeys.includes(k)),
    ];
    for (const key of orderedKeys) {
      const nk = normalizeKey(key);
      if (!nk.includes("scene")) continue;
      const candidate = safeString(out[key]).trim();
      if (!candidate || isLikelyMarkerToken(candidate)) continue;
      const normalized = normalizeProjectRelativePath(candidate);
      if (normalized) return normalized;
    }
    for (const candidate of [semRefs.sceneRef, intentRefs.sceneRef]) {
      const raw = safeString(candidate).trim();
      if (!raw || isLikelyMarkerToken(raw)) continue;
      const normalized = normalizeProjectRelativePath(raw);
      if (normalized) return normalized;
    }
    return null;
  }

  async _resolveFileRef({ toolName, argKey, value }) {
    if (this._fileResolver && typeof this._fileResolver.resolve === "function") {
      const res = await this._fileResolver.resolve({ toolName, argKey, value });
      // console.log("[ArgumentResolver] resolveFileRef", res);
      return this._normalizeResolverResult(res, value, argKey);
    }
    const normalized = normalizeProjectRelativePath(value);
    return normalized
      ? { status: "resolved", value: normalized, ambiguities: [] }
      : { status: "missing", value: null, ambiguities: [], missingArg: argKey };
  }

  async _resolveNodeRef({ toolName, argKey, value, scenePath }) {
    const raw = safeString(value).trim();
    if (!raw) return { status: "missing", value: null, ambiguities: [], missingArg: argKey };
    if (this._nodeResolver && typeof this._nodeResolver.resolve === "function") {
      const res = await this._nodeResolver.resolve({ toolName, argKey, value, scenePath });
      const normalized = this._normalizeResolverResult(res, value, argKey);
      return normalized;
    }
    return { status: "not_found", value: null, ambiguities: [] };
  }

  async _resolveNodeRefViaInventory({ value, scenePath, projectPath = null } = {}) {
    const target = safeString(value).trim();
    const scene = safeString(scenePath).trim();
    if (!target || !scene) return { status: "not_found", value: null, ambiguities: [] };
    if (/^(scene_root|root node|root|\.)$/i.test(target)) {
      return { status: "resolved", value: ".", ambiguities: [] };
    }
    const client =
      (this._sessionManager && typeof this._sessionManager.getClient === "function" && this._sessionManager.getClient()) ||
      this._sessionManager?.client ||
      this._sessionManager?._client ||
      null;
    if (!client) return { status: "not_found", value: null, ambiguities: [] };

    const inv = this._toolInventory && typeof this._toolInventory.getInventory === "function"
      ? this._toolInventory.getInventory()
      : null;
    const tools = Array.isArray(inv?.tools) ? inv.tools : [];
    const candidates = this._pickSceneNodeListingToolCandidates(tools);
    const sessionStatus = await this._getSessionStatus();
    const sessionProjectPath =
      safeString(projectPath).trim() ||
      safeString(sessionStatus?.connectedProjectPath).trim() ||
      null;
    for (const tool of candidates.slice(0, 3)) {
      const args = this._buildSceneListArgs(tool, scene, sessionProjectPath);
      if (!args) continue;
      let raw = null;
      try {
        if (typeof client.callTool === "function") raw = await client.callTool(tool.name, args);
        else if (typeof client.request === "function") {
          const res = await client.request({ method: "tools/call", params: { name: tool.name, arguments: args } });
          raw = res?.result ?? res;
        }
      } catch {
        raw = null;
      }
      const nodes = this._extractNodeCandidates(raw);
      if (!Array.isArray(nodes) || nodes.length < 1) continue;
      const matched = this._matchNodeTarget(nodes, target);
      if (matched.status !== "not_found") return matched;
    }
    return { status: "not_found", value: null, ambiguities: [] };
  }
  _pickSceneNodeListingToolCandidates(tools = []) {
    const input = Array.isArray(tools) ? tools : [];
    const canonical = input.filter((t) => {
      const key = safeString(t?.name).trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
      return key === "listscenenodes" || key === "listscenenode";
    });
    if (canonical.length > 0) return canonical;
    return input.filter((t) => this._looksLikeSceneNodeListingTool(t));
  }

  _looksLikeSceneNodeListingTool(tool) {
    const name = safeString(tool?.name).trim().toLowerCase();
    if (!name) return false;
    const key = name.replace(/[^a-z0-9]+/g, "");
    if (!(key.includes("scene") && key.includes("node"))) return false;
    const schema = isPlainObject(tool?.inputSchema) ? tool.inputSchema : {};
    const props = isPlainObject(schema.properties) ? Object.keys(schema.properties).map((k) => safeString(k).trim().toLowerCase()) : [];
    const req = Array.isArray(schema.required) ? schema.required.map((k) => safeString(k).trim().toLowerCase()) : [];
    const all = [...req, ...props];
    if (all.length < 1) return false;
    return all.some((k) => k.includes("scene")) && !all.some((k) => k.includes("node"));
  }

  _buildSceneListArgs(tool, scenePath, projectPath = null) {
    const schema = isPlainObject(tool?.inputSchema) ? tool.inputSchema : {};
    const props = isPlainObject(schema.properties) ? Object.keys(schema.properties) : [];
    const req = Array.isArray(schema.required) ? schema.required : [];
    const preferredScene = [...req, ...props].find((k) => normalizeKey(k).includes("scenepath")) || [...req, ...props].find((k) => normalizeKey(k).includes("scene"));
    const preferredProject = [...req, ...props].find((k) => this._isProjectPathKey(normalizeKey(k))) || null;
    const out = preferredScene
      ? { [preferredScene]: scenePath, scenePath, scene_path: scenePath, path: scenePath }
      : { scenePath, scene_path: scenePath, path: scenePath };
    const pp = safeString(projectPath).trim();
    if (pp) {
      out.projectPath = pp;
      out.project_path = pp;
      out.projectRoot = pp;
      out.project_root = pp;
      if (preferredProject) out[preferredProject] = pp;
    }
    return out;
  }

  _extractNodeCandidates(raw) {
    const candidates = [];
    if (Array.isArray(raw?.content)) {
      for (const block of raw.content) {
        const text = safeString(block?.text).trim();
        if (!text) continue;
        try {
          candidates.push(JSON.parse(text));
        } catch {
          // ignore non-json
        }
      }
    }
    if (isPlainObject(raw)) candidates.push(raw);
    const out = [];
    const seen = new Set();
    const pushNode = (obj) => {
      const name = safeString(obj?.name ?? obj?.node_name).trim();
      const path = safeString(obj?.path ?? obj?.node_path).trim();
      const type = safeString(obj?.type ?? obj?.node_type).trim() || null;
      if (!path || seen.has(path)) return;
      seen.add(path);
      out.push({ name: name || path.split("/").pop() || "", path, type });
    };
    const walk = (arr) => {
      for (const item of arr) {
        if (!isPlainObject(item)) continue;
        pushNode(item);
        if (Array.isArray(item.children)) walk(item.children);
      }
    };
    for (const c of candidates) {
      if (Array.isArray(c?.nodes)) walk(c.nodes);
      if (Array.isArray(c?.scene_nodes)) walk(c.scene_nodes);
      if (Array.isArray(c?.items)) walk(c.items);
      if (Array.isArray(c)) walk(c);
      if (isPlainObject(c?.tree)) {
        const t = c.tree;
        pushNode(t);
        if (Array.isArray(t.children)) walk(t.children);
      }
    }
    return out;
  }

  _matchNodeTarget(nodes, target) {
    const raw = safeString(target).trim();
    if (!raw) return { status: "not_found", value: null, ambiguities: [] };
    const byPath = nodes.find((n) => n.path === raw);
    if (byPath) return { status: "resolved", value: byPath.path, ambiguities: [] };
    const exactNames = nodes.filter((n) => safeString(n.name).trim() === raw);
    if (exactNames.length === 1) return { status: "resolved", value: exactNames[0].path, ambiguities: [] };
    if (exactNames.length > 1) return { status: "ambiguous", value: null, ambiguities: [...new Set(exactNames.map((n) => n.path))] };
    const lower = raw.toLowerCase();
    const ci = nodes.filter((n) => safeString(n.name).trim().toLowerCase() === lower);
    if (ci.length === 1) return { status: "resolved", value: ci[0].path, ambiguities: [] };
    if (ci.length > 1) return { status: "ambiguous", value: null, ambiguities: [...new Set(ci.map((n) => n.path))] };
    const suffix = nodes.filter((n) => safeString(n.path).toLowerCase().endsWith(lower) || safeString(n.path).split("/").some((seg) => seg.toLowerCase() === lower));
    if (suffix.length === 1) return { status: "resolved", value: suffix[0].path, ambiguities: [] };
    if (suffix.length > 1) return { status: "ambiguous", value: null, ambiguities: [...new Set(suffix.map((n) => n.path))] };
    return { status: "not_found", value: null, ambiguities: [] };
  }

  async _retryAfterIndexUpsert({ toolName, argKey, rawValue }) {
    const fi = this.getFileIndex();
    if (!fi || typeof fi.addOrUpdateRelativePath !== "function") return { status: "not_found", value: null };
    const rel = normalizeProjectRelativePath(rawValue);
    if (!rel) return { status: "not_found", value: null };
    const upsert = await fi.addOrUpdateRelativePath(rel);
    if (!upsert?.ok) return { status: "not_found", value: null };
    const second = await this._resolveFileRef({ toolName, argKey, value: rawValue });
    return second;
  }

  async compileExecutableArgs({ toolName, args, argMeta = null, inventory = null, workflowState = null } = {}) {
    const inArgs = isPlainObject(args) ? { ...args } : {};
    const inMeta = isPlainObject(argMeta) ? { ...argMeta } : {};
    const compileInventory = this._normalizeCompilationInventory(inventory);
    const generated = this._extractGeneratedContent({ args: inArgs, workflowState });
    const variants = this._buildCompileVariants({
      toolName,
      args: inArgs,
      inventory: compileInventory,
      generatedContent: generated,
    });
    let bestFailure = null;

    for (const variant of variants) {
      const attempt = this._compileOneAttempt({
        toolName,
        args: variant,
        argMeta: inMeta,
        inventory: compileInventory,
        workflowState,
      });
      if (attempt.status === "ready") return attempt;
      bestFailure = this._pickPreferredCompileFailure(bestFailure, attempt);
    }

    return bestFailure || {
      status: "uncompilable",
      args: inArgs,
      argMeta: inMeta,
      reason: "Could not compile executable arguments from live tool contract.",
    };
  }

  _compileOneAttempt({ toolName, args, argMeta = null, inventory = null, workflowState = null } = {}) {
    const inArgs = isPlainObject(args) ? { ...args } : {};
    const inMeta = isPlainObject(argMeta) ? { ...argMeta } : {};
    const sink = mapGeneratedContentIntoInlineSink({
      toolName,
      args: inArgs,
      inventory,
      workflowState,
    });
    const argsWithSink = isPlainObject(sink?.args) ? sink.args : inArgs;
    const normalizedModifyArgs = this._normalizeStructuredModifyPayloadForContract({
      toolName,
      args: argsWithSink,
      inventory,
    });
    console.log("[VERIFY][content-sink-selection]", {
      tool: safeString(toolName).trim() || null,
      selectedContentField: safeString(sink?.selectedContentField).trim() || null,
      availableContentFields: Array.isArray(sink?.availableContentFields) ? sink.availableContentFields : [],
      mapped: Boolean(sink?.mapped),
      argKeys: Object.keys(normalizedModifyArgs),
    });
    const readiness = ensureRichPayloadReadiness({
      toolName,
      args: normalizedModifyArgs,
      inventory,
      workflowState,
      semanticIntent: workflowState?.semanticIntent,
    });
    const contractValidatedArgs = isPlainObject(readiness?.args) ? readiness.args : argsWithSink;
    const modificationTypeValidation = this._validateRequestedModificationTypesAgainstContract({
      toolName,
      args: contractValidatedArgs,
      inventory,
    });
    if (!modificationTypeValidation.ok) {
      return {
        status: "uncompilable",
        args: contractValidatedArgs,
        argMeta: inMeta,
        reason: modificationTypeValidation.reason || "Requested modification type is not supported by the live MCP contract.",
      };
    }
    if (safeString(readiness?.status).trim() === "not_ready") {
      const field = safeString(readiness?.missingSemanticField).trim();
      const targetedEdits =
        (Array.isArray(argsWithSink?.targetedEdits) && argsWithSink.targetedEdits) ||
        (Array.isArray(workflowState?.semanticState?.targetedEdits) && workflowState.semanticState.targetedEdits) ||
        (Array.isArray(workflowState?.semanticIntent?.targetedEdits) && workflowState.semanticIntent.targetedEdits) ||
        null;
      const hasKnownTypedTarget = Boolean(
        safeString(argsWithSink?.scriptRef).trim() ||
        safeString(argsWithSink?.fileRef).trim() ||
        safeString(argsWithSink?.resourceRef).trim() ||
        safeString(argsWithSink?.artifactRef).trim()
      );
      const hasResolvedTarget = this._hasResolvedArtifactTarget({
        args: isPlainObject(readiness?.args) ? readiness.args : argsWithSink,
        argMeta: inMeta,
      });
      if (Array.isArray(targetedEdits) && targetedEdits.length > 0 && hasKnownTypedTarget && hasResolvedTarget) {
        return {
          status: "uncompilable",
          args: isPlainObject(readiness?.args) ? readiness.args : argsWithSink,
          argMeta: inMeta,
          reason: readiness?.reason || "Uncompilable structured edit payload for targeted modify-existing intent.",
        };
      }
      if (field) {
        return {
          status: "missing_args",
          args: isPlainObject(readiness?.args) ? readiness.args : argsWithSink,
          argMeta: inMeta,
          missingArgs: [field],
          reason: readiness?.reason || null,
        };
      }
      return {
        status: "uncompilable",
        args: isPlainObject(readiness?.args) ? readiness.args : argsWithSink,
        argMeta: inMeta,
        reason: readiness?.reason || "Structured payload is not executable.",
      };
    }

    const modifyGate = this._ensureModifyExistingTargetResolution({
      toolName,
      args: isPlainObject(readiness?.args) ? readiness.args : argsWithSink,
      argMeta: inMeta,
      workflowState,
    });
    console.log("[VERIFY][modify-target-resolution]", {
      tool: safeString(toolName).trim() || null,
      operationMode: safeString(workflowState?.artifactOperation?.mode).trim().toLowerCase() || null,
      typedRefs: modifyGate.typedRefs ?? {},
      typedPaths: modifyGate.typedPaths ?? {},
      resolvedArtifactPath: modifyGate.resolvedArtifactPath ?? null,
      resolutionStatus: modifyGate.resolutionStatus ?? "unknown",
      canProceed: Boolean(modifyGate.canProceed),
    });
    if (!modifyGate.ok) {
      if (modifyGate.status === "missing_args") {
        return {
          status: "missing_args",
          args: isPlainObject(readiness?.args) ? readiness.args : argsWithSink,
          argMeta: inMeta,
          missingArgs: [modifyGate.field || "artifactRef"],
          reason: modifyGate.reason || null,
        };
      }
      if (modifyGate.status === "ambiguous") {
        return {
          status: "ambiguous",
          args: isPlainObject(readiness?.args) ? readiness.args : argsWithSink,
          argMeta: inMeta,
          ambiguities: Array.isArray(modifyGate.ambiguities) ? modifyGate.ambiguities : [],
          reason: modifyGate.reason || null,
        };
      }
      return {
        status: "not_found",
        args: isPlainObject(readiness?.args) ? readiness.args : argsWithSink,
        argMeta: inMeta,
        reason: modifyGate.reason || null,
      };
    }
    const attachGate = this._ensureAttachExistingDualResolution({
      args: isPlainObject(readiness?.args) ? readiness.args : argsWithSink,
      argMeta: inMeta,
      workflowState,
    });
    if (!attachGate.ok) {
      if (attachGate.status === "missing_args") {
        return {
          status: "missing_args",
          args: isPlainObject(readiness?.args) ? readiness.args : argsWithSink,
          argMeta: inMeta,
          missingArgs: [attachGate.field || "artifactRef"],
          reason: attachGate.reason || null,
        };
      }
      if (attachGate.status === "ambiguous") {
        return {
          status: "ambiguous",
          args: isPlainObject(readiness?.args) ? readiness.args : argsWithSink,
          argMeta: inMeta,
          ambiguities: Array.isArray(attachGate.ambiguities) ? attachGate.ambiguities : [],
          reason: attachGate.reason || null,
        };
      }
      return {
        status: "not_found",
        args: isPlainObject(readiness?.args) ? readiness.args : argsWithSink,
        argMeta: inMeta,
        reason: attachGate.reason || null,
      };
    }
    return {
      status: "ready",
      args: isPlainObject(readiness?.args) ? readiness.args : argsWithSink,
      argMeta: inMeta,
      reason: null,
    };
  }

  _ensureAttachExistingDualResolution({ args = {}, argMeta = {}, workflowState = null } = {}) {
    const mode = safeString(workflowState?.artifactOperation?.mode).trim().toLowerCase();
    const isAttach = mode === "attach_existing" || mode === "create_then_attach" || mode === "modify_then_attach";
    if (!isAttach) return { ok: true };
    const a = isPlainObject(args) ? args : {};
    const m = isPlainObject(argMeta) ? argMeta : {};

    const artifactPath =
      safeString(a.scriptPath).trim() ||
      safeString(a.filePath).trim() ||
      safeString(a.resourcePath).trim() ||
      safeString(a.path).trim() ||
      "";
    const hasResolvedArtifact = this._looksConcreteArtifactPath(artifactPath);
    if (!hasResolvedArtifact) {
      const field = this._preferredArtifactSemanticField(a);
      const attempted = safeString(a[field]).trim() || safeString(a.artifactRef).trim() || null;
      if (!attempted) {
        return { ok: false, status: "missing_args", field, reason: "Missing attach-side artifact target." };
      }
      return {
        ok: false,
        status: "not_found",
        field,
        reason: `Referenced path(s) not found: ${field}${attempted ? ` (not_found: ${attempted})` : ""}`,
      };
    }

    const nodeCandidate =
      safeString(a.targetNode).trim() ||
      safeString(a.targetNodePath).trim() ||
      safeString(a.nodePath).trim() ||
      safeString(a.nodeRef).trim() ||
      safeString(a.targetNodeRef).trim();
    if (!nodeCandidate || isLikelyMarkerToken(nodeCandidate)) {
      return { ok: false, status: "missing_args", field: "targetNodeRef", reason: "Missing attach-side node target." };
    }
    const nodeMeta =
      (isPlainObject(m.targetNode) ? m.targetNode : null) ||
      (isPlainObject(m.targetNodePath) ? m.targetNodePath : null) ||
      (isPlainObject(m.nodePath) ? m.nodePath : null) ||
      null;
    const nodeMustExist = !nodeMeta || safeString(nodeMeta.existencePolicy).trim().toLowerCase() === "must_exist";
    if (nodeMustExist && this._looksLikeFileResourceValue(nodeCandidate)) {
      return { ok: false, status: "not_found", field: "nodeRef", reason: `Referenced path(s) not found: nodeRef (not_found: ${nodeCandidate})` };
    }
    return { ok: true };
  }

  _extractGeneratedContent({ args = {}, workflowState = null } = {}) {
    const direct = [
      safeString(args?.content).trim(),
      safeString(args?.body).trim(),
      safeString(args?.source).trim(),
      safeString(args?.text).trim(),
    ].find(Boolean);
    if (direct) return direct;
    return (
      safeString(workflowState?.semanticState?.generatedContent?.content).trim() ||
      safeString(workflowState?.semanticState?.generatedCode).trim() ||
      ""
    );
  }

  _buildCompileVariants({ toolName, args, inventory = null, generatedContent = "" } = {}) {
    const base = isPlainObject(args) ? { ...args } : {};
    const variants = [base];
    const content = safeString(generatedContent).trim();
    if (!content) return variants;
    const schema = this._getToolSchema(toolName, inventory);
    const props = isPlainObject(schema?.properties) ? schema.properties : {};
    const keys = Object.keys(props).filter((k) => this._looksLikeInlineContentField(k));
    const seen = new Set();
    seen.add(JSON.stringify(base));
    for (const key of keys.slice(0, 4)) {
      const next = { ...base };
      next[key] = next[key] ?? content;
      const sig = JSON.stringify(next);
      if (seen.has(sig)) continue;
      seen.add(sig);
      variants.push(next);
    }
    return variants;
  }

  _looksLikeInlineContentField(key) {
    const nk = normalizeKey(key);
    return nk.includes("content") || nk.includes("body") || nk.includes("source") || nk.includes("text") || nk.includes("code");
  }

  _pickPreferredCompileFailure(current, next) {
    if (!next) return current;
    if (!current) return next;
    const rank = (s) => {
      const status = safeString(s).trim();
      if (status === "not_found") return 6;
      if (status === "ambiguous") return 5;
      if (status === "uncompilable") return 4;
      if (status === "missing_args") return 3;
      if (status === "unsupported") return 2;
      return 1;
    };
    return rank(next.status) >= rank(current.status) ? next : current;
  }

  _hasResolvedArtifactTarget({ args = {}, argMeta = {} } = {}) {
    const a = isPlainObject(args) ? args : {};
    const m = isPlainObject(argMeta) ? argMeta : {};
    for (const key of ["scriptPath", "filePath", "resourcePath", "path"]) {
      const value = safeString(a[key]).trim();
      if (!value || !this._looksConcreteArtifactPath(value)) continue;
      const meta = isPlainObject(m[key]) ? m[key] : null;
      if (!meta) return true;
      const policy = safeString(meta.existencePolicy).trim().toLowerCase();
      if (!policy || policy === "must_exist") return true;
    }
    return false;
  }

  _ensureModifyExistingTargetResolution({ toolName, args, argMeta = null, workflowState = null } = {}) {
    const opMode = safeString(workflowState?.artifactOperation?.mode).trim().toLowerCase();
    const needsGate = opMode === "modify_existing" || opMode === "modify_then_attach";
    if (!needsGate) {
      return { ok: true, canProceed: true, resolutionStatus: "not_applicable", typedRefs: {}, typedPaths: {}, resolvedArtifactPath: null };
    }
    const a = isPlainObject(args) ? args : {};
    const m = isPlainObject(argMeta) ? argMeta : {};
    const typedRefs = {};
    for (const key of ["artifactRef", "scriptRef", "fileRef", "resourceRef"]) {
      const v = safeString(a[key]).trim();
      if (isLikelyMarkerToken(v)) continue;
      if (v) typedRefs[key] = v;
    }
    const typedPaths = {};
    for (const key of ["scriptPath", "filePath", "resourcePath", "path"]) {
      const v = safeString(a[key]).trim();
      if (v) typedPaths[key] = v;
    }
    const pathCandidates = Object.entries(typedPaths).filter(([k]) => /(script|file|resource|path)/i.test(k));
    const resolved = pathCandidates.find(([k, v]) => {
      if (!this._looksConcreteArtifactPath(v)) return false;
      const meta = isPlainObject(m[k]) ? m[k] : null;
      if (!meta) return true;
      const existence = safeString(meta.existencePolicy).trim().toLowerCase();
      return !existence || existence === "must_exist";
    }) || null;
    const resolvedArtifactPath = resolved?.[1] ?? null;
    if (resolvedArtifactPath) {
      return { ok: true, canProceed: true, resolutionStatus: "resolved", typedRefs, typedPaths, resolvedArtifactPath };
    }
    const hasTarget = Object.keys(typedRefs).length > 0 || pathCandidates.length > 0;
    const field = this._preferredArtifactSemanticField(a);
    const attempted = safeString(a[field]).trim() || safeString(a.artifactRef).trim() || null;
    if (!hasTarget) {
      return {
        ok: false,
        canProceed: false,
        status: "missing_args",
        field,
        typedRefs,
        typedPaths,
        resolvedArtifactPath: null,
        resolutionStatus: "missing_target",
        reason: "Missing existing artifact target.",
      };
    }
    return {
      ok: false,
      canProceed: false,
      status: "not_found",
      field,
      typedRefs,
      typedPaths,
      resolvedArtifactPath: null,
      resolutionStatus: "unresolved_target",
      reason: `Referenced path(s) not found: ${field}${attempted ? ` (not_found: ${attempted})` : ""}`,
    };
  }

  _preferredArtifactSemanticField(args = {}) {
    for (const key of ["scriptRef", "fileRef", "resourceRef", "artifactRef"]) {
      const v = safeString(args[key]).trim();
      if (!v || isLikelyMarkerToken(v)) continue;
      return key;
    }
    return "artifactRef";
  }

  _looksConcreteArtifactPath(value) {
    const raw = safeString(value).trim();
    if (!raw) return false;
    const normalized = raw.replace(/\\/g, "/");
    const withoutScheme = normalized.replace(/^res:\/\//i, "").replace(/^\/+/, "");
    if (!withoutScheme) return false;
    if (withoutScheme.includes("/")) return true;
    return /\.[a-z0-9_]+$/i.test(withoutScheme);
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

  _normalizeCompilationInventory(inventory = null) {
    if (isPlainObject(inventory) && Array.isArray(inventory.tools)) return inventory;
    if (inventory && typeof inventory.getInventory === "function") {
      const raw = inventory.getInventory();
      if (isPlainObject(raw)) {
        const getTool =
          typeof raw.getTool === "function"
            ? raw.getTool.bind(raw)
            : (typeof inventory.getTool === "function" ? inventory.getTool.bind(inventory) : undefined);
        return getTool ? { ...raw, getTool } : raw;
      }
    }
    return inventory;
  }

  _validateRequestedModificationTypesAgainstContract({ toolName, args = {}, inventory = null } = {}) {
    const supported = this._extractSupportedModificationTypesFromContract({ toolName, inventory });
    if (supported.length < 1) return { ok: true, reason: null };
    const modifications = Array.isArray(args?.modifications) ? args.modifications : [];
    if (modifications.length < 1) return { ok: true, reason: null };
    const supportedSet = new Set(supported.map((x) => safeString(x).trim().toLowerCase()).filter(Boolean));
    for (const item of modifications) {
      if (!isPlainObject(item)) continue;
      const requested =
        safeString(item.type).trim() ||
        safeString(item.kind).trim() ||
        "";
      if (!requested) continue;
      if (supportedSet.has(requested.toLowerCase())) continue;
      return {
        ok: false,
        reason: `Uncompilable structured edit payload for: modifications (unsupported type: ${requested}; supported: ${supported.join(", ")})`,
      };
    }
    return { ok: true, reason: null };
  }

  _extractSupportedModificationTypesFromContract({ toolName, inventory = null } = {}) {
    const schema = this._getToolSchema(toolName, inventory);
    const props = isPlainObject(schema?.properties) ? schema.properties : {};
    const mods = isPlainObject(props?.modifications) ? props.modifications : {};
    const item = isPlainObject(mods?.items) ? mods.items : {};
    const itemProps = isPlainObject(item?.properties) ? item.properties : {};
    const typeSchema = isPlainObject(itemProps?.type) ? itemProps.type : {};
    const out = new Set();
    if (Array.isArray(typeSchema?.enum)) {
      for (const v of typeSchema.enum) {
        const t = safeString(v).trim();
        if (t) out.add(t);
      }
    }
    const typeDesc = safeString(typeSchema?.description).trim();
    if (typeDesc) {
      const quoted = [...typeDesc.matchAll(/["'`]([A-Za-z0-9_:-]+)["'`]/g)];
      for (const m of quoted) {
        const t = safeString(m?.[1]).trim();
        if (t) out.add(t);
      }
      const underscored = [...typeDesc.matchAll(/\b[a-z]+_[a-z0-9_]+\b/gi)];
      for (const m of underscored) {
        const t = safeString(m?.[0]).trim();
        if (t) out.add(t);
      }
    }
    return [...out];
  }

  _normalizeStructuredModifyPayloadForContract({ toolName, args = {}, inventory = null } = {}) {
    const out = isPlainObject(args) ? { ...args } : {};
    const schema = this._getToolSchema(toolName, inventory);
    const modsSchema = isPlainObject(schema?.properties?.modifications) ? schema.properties.modifications : null;
    const itemSchema = isPlainObject(modsSchema?.items) ? modsSchema.items : null;
    if (!modsSchema || !itemSchema) return out;
    const requiresMods = Array.isArray(schema?.required) && schema.required.includes("modifications");
    if (!requiresMods) return out;
    if (Array.isArray(out.modifications)) return out;
    if (!isPlainObject(out.modifications)) return out;

    const entries = Object.entries(out.modifications);
    const normalizedItems = [];
    for (const [opKeyRaw, opValue] of entries) {
      if (!isPlainObject(opValue)) continue;
      const opKey = camelToSnake(opKeyRaw);
      const inferredType =
        opKey === "add_variable" || opKey === "add_signal" || opKey === "add_function"
          ? opKey
          : "";
      const item = { ...opValue };
      const currentTypeText = safeString(item.type).trim().toLowerCase();
      const looksLikeOperationType = currentTypeText === "add_variable" || currentTypeText === "add_signal" || currentTypeText === "add_function";
      if (inferredType && (!hasNonEmpty(item.type) || !looksLikeOperationType)) {
        if (hasNonEmpty(item.type) && !hasNonEmpty(item.varType) && inferredType === "add_variable") {
          item.varType = safeString(item.type).trim();
        }
        item.type = inferredType;
      }
      if (!hasNonEmpty(item.name)) {
        item.name =
          safeString(item.variableName).trim() ||
          safeString(item.signalName).trim() ||
          safeString(item.functionName).trim() ||
          "";
      }
      if (safeString(item.type).trim().toLowerCase() === "add_variable") {
        if (!hasNonEmpty(item.varType) && hasNonEmpty(opValue.varType)) item.varType = safeString(opValue.varType).trim();
        if (!hasNonEmpty(item.defaultValue) && item.value != null) item.defaultValue = safeString(item.value).trim();
      }
      normalizedItems.push(item);
    }
    if (normalizedItems.length > 0) {
      out.modifications = normalizedItems;
    }
    return out;
  }
}
