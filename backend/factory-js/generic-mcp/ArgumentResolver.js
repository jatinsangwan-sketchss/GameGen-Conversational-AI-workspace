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
  sanitizeFileStem,
  synthesizeMissingCreationPath,
} from "./PathSynthesizer.js";
import { defaultPathPolicyForArg } from "./PathPolicy.js";
import { classifyToolArgs, isNodeRefSlot, semanticArgCandidates } from "./ArgRoleClassifier.js";
import { mapGeneratedContentIntoInlineSink } from "./ContentSinkResolver.js";
import { ensureRichPayloadReadiness } from "./RichArgPayloadSynthesizer.js";
import { getSessionClient } from "./utils/session-client.js";

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
  constructor({ sessionManager = null, fileResolver = null, nodeResolver = null, toolInventory = null, debug = false } = {}) {
    this._sessionManager = sessionManager;
    this._fileResolver = fileResolver;
    this._nodeResolver = nodeResolver;
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
        workflowState,
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
      // console.log("[AR] outside ", fileResolved);
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

      // console.log("[AR] args:",{args: nodeResolved.args,});      

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
        role === "creation_intent_derived" ||
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
      if (!["semantic_ref", "creation_intent_derived", "direct_user_value"].includes(role)) continue;
      if (role === "creation_intent_derived") continue;
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
  synthesizeCreationPaths({ toolName, args, inventory = null, workflowState = null } = {}) {
    const out = { ...(isPlainObject(args) ? args : {}) };
    const synthesizedKeys = new Set();
    const schema = this._getToolSchema(toolName, inventory ?? this._toolInventory);
    const required = this._getRequiredArgs(toolName, inventory ?? this._toolInventory);
    const props = isPlainObject(schema?.properties) ? Object.keys(schema.properties) : [];
    const candidates = [...new Set([...required, ...props.filter((k) => isCreatablePathArgName(k))])];
    for (const key of candidates) {
      const val = out[key];
      if (val != null && safeString(val).trim() !== "") continue;
      if (!isCreatablePathArgName(key)) continue;
      if (this._isNodeTargetKey(normalizeKey(key))) continue;
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
    this._applyCanonicalCreateScriptPathAliases({
      toolName,
      args: out,
      workflowState,
      schema,
      required,
      synthesizedKeys,
    });
    return { args: out, synthesizedKeys };
  }

  _applyCanonicalCreateScriptPathAliases({
    toolName = "",
    args = {},
    workflowState = null,
    schema = null,
    required = [],
    synthesizedKeys = null,
  } = {}) {
    const out = isPlainObject(args) ? args : {};
    const keySet = synthesizedKeys instanceof Set ? synthesizedKeys : new Set();
    const createLike = this._isCreateLikeArtifactStep({ toolName, args: out, workflowState });
    if (!createLike) return;
    const canonical = this._deriveCanonicalScriptCreationPath({ toolName, args: out, workflowState });
    if (!canonical) return;
    const schemaProps = isPlainObject(schema?.properties) ? Object.keys(schema.properties) : [];
    const requiredKeys = Array.isArray(required) ? required : [];
    const candidateKeys = [...new Set([...Object.keys(out), ...schemaProps, ...requiredKeys])];
    for (const key of candidateKeys) {
      const nk = normalizeKey(key);
      if (!nk || this._isProjectPathKey(nk) || this._isNodeTargetKey(nk)) continue;
      const isScriptArtifactKey =
        nk === "path" ||
        nk.includes("scriptpath") ||
        nk.includes("filepath") ||
        nk.includes("artifactpath") ||
        nk.includes("scriptref") ||
        nk.includes("fileref") ||
        nk.includes("artifactref");
      if (!isScriptArtifactKey) continue;
      const previous = safeString(out[key]).trim();
      const previousNormalized = normalizeProjectRelativePath(previous);
      if (previousNormalized === canonical) continue;
      out[key] = canonical;
      keySet.add(key);
    }
  }

  _deriveCanonicalScriptCreationPath({ toolName = "", args = {}, workflowState = null } = {}) {
    const out = isPlainObject(args) ? args : {};
    const nested = isPlainObject(out.creationIntent) ? out.creationIntent : {};
    const semanticCreation = isPlainObject(workflowState?.semanticState?.creationIntent)
      ? workflowState.semanticState.creationIntent
      : (isPlainObject(workflowState?.semanticIntent?.creationIntent) ? workflowState.semanticIntent.creationIntent : {});
    // Preserve explicit concrete path targets when provided; synthesis should
    // only fill missing create-script aliases, not override intentful paths.
    for (const key of ["scriptPath", "scriptRef", "filePath", "fileRef", "artifactRef", "path"]) {
      const raw = safeString(out?.[key]).trim();
      if (!raw || isLikelyMarkerToken(raw)) continue;
      if (!this._looksConcreteArtifactPath(raw)) continue;
      const normalized = normalizeProjectRelativePath(raw);
      if (normalized) return normalized;
    }
    const requestedName =
      safeString(out.requestedName).trim() ||
      safeString(out.requested_name).trim() ||
      safeString(out.name).trim() ||
      safeString(out.scriptName).trim() ||
      safeString(out.fileName).trim() ||
      safeString(nested.requestedName).trim() ||
      safeString(nested.requested_name).trim() ||
      safeString(nested.name).trim() ||
      safeString(semanticCreation.requestedName).trim() ||
      safeString(semanticCreation.requested_name).trim() ||
      safeString(semanticCreation.name).trim() ||
      "";
    if (!requestedName) return null;
    const explicitRootFolder = [".", "./", "/"].includes(safeString(out.targetFolder || nested.targetFolder).trim());
    const folderRaw =
      safeString(out.targetFolder).trim() ||
      safeString(out.target_folder).trim() ||
      safeString(out.folder).trim() ||
      safeString(out.directory).trim() ||
      safeString(nested.targetFolder).trim() ||
      safeString(nested.folder).trim() ||
      safeString(semanticCreation.targetFolder).trim() ||
      safeString(semanticCreation.folder).trim() ||
      "";
    const normalizedFolder = normalizeProjectRelativePath(folderRaw);
    const folder = explicitRootFolder
      ? ""
      : ((safeString(normalizedFolder).replace(/^\.\/+/, "").replace(/\/+$/, "") || "scripts"));
    const resourceKind =
      safeString(out.resourceKind || out.resource_kind || nested.resourceKind || semanticCreation.resourceKind).trim().toLowerCase() ||
      "";
    const toolLower = safeString(toolName).toLowerCase();
    const scriptLike =
      resourceKind === "script" ||
      /\.gd$/i.test(requestedName) ||
      /(^|[_\-\s])script([_\-\s]|$)/.test(toolLower);
    if (!scriptLike) return null;
    const stem = sanitizeFileStem(requestedName);
    if (!stem) return null;
    return folder ? `${folder}/${stem}.gd` : `${stem}.gd`;
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
    const createLikeStep = this._isCreateLikeArtifactStep({ toolName, args: out, classification, workflowState });
    const requiresExistingTarget = !createLikeStep && (opMode === "modify_existing" || opMode === "modify_then_attach" || opMode === "attach_existing");
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
      const roleMeta = isPlainObject(classification?.rolesByArg?.[key]) ? classification.rolesByArg[key] : null;
      const isRequiredArg = Boolean(roleMeta?.required);
      const enforceResolution = isRequiredArg || requiresExistingTarget;
      if (isLikelyMarkerToken(raw)) {
        if (enforceResolution) missingArgs.push(key);
        else delete out[key];
        continue;
      }
      const role = safeString(roleMeta?.role).trim().toLowerCase();
      const normalizedKey = normalizeKey(key);
      const semanticSlot = safeString(roleMeta?.semanticSlot).trim().toLowerCase();
      const isArtifactTargetRef =
        this._isArtifactPathKey(normalizedKey) ||
        semanticSlot.includes("scriptref") ||
        semanticSlot.includes("fileref") ||
        semanticSlot.includes("resourceref") ||
        semanticSlot.includes("artifactref");
      // Policy layer: existing refs (must_exist) resolve via index; create/new path
      // targets (may_not_exist_yet) pass through without not_found checks.
      const policy = defaultPathPolicyForArg(key, out, {
        synthesized: synthesizedKeys.has(key),
        sessionInjected: sessionInjectedSet.has(key),
      });
      const isPathLikeRef = this._isFileResourceRefKey(normalizedKey);
      if (isPathLikeRef && role === "creation_intent_derived") {
        policy.existencePolicy = "may_not_exist_yet";
        if (!safeString(policy.provenance).trim()) {
          policy.provenance = "creation_intent_derived";
        }
      } else if (isPathLikeRef && role === "semantic_ref") {
        if (createLikeStep && isArtifactTargetRef) {
          policy.existencePolicy = "may_not_exist_yet";
          if (!safeString(policy.provenance).trim()) {
            policy.provenance = "creation_intent_derived";
          }
        } else {
          policy.existencePolicy = "must_exist";
          if (!safeString(policy.provenance).trim()) {
            policy.provenance = "resolved_existing_ref";
          }
        }
      }
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
        if (enforceResolution) ambiguities.push(...resolved.ambiguities);
        else delete out[key];
      } else if (resolved.status === "not_found") {
        const retried = await this._retryAfterIndexUpsert({ toolName, argKey: key, rawValue: raw });
        if (retried.status === "resolved") {
          out[key] = retried.value;
          if (this._debug) {
            console.error("[generic-mcp][args] existing ref resolved after upsert", JSON.stringify({ tool: toolName, arg: key, input: safeString(raw).trim(), resolved: retried.value }));
          }
          argMeta[key] = { provenance: "resolved_existing_ref", existencePolicy: "must_exist" };
        } else {
          if (enforceResolution) notFoundRefs.push(`${key} (not_found: ${safeString(raw).trim()})`);
          else delete out[key];
        }
      } else if (resolved.status === "missing") {
        if (enforceResolution) missingArgs.push(key);
        else delete out[key];
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

  _canInferNodeTargetForKey(argKey = "") {
    const nk = normalizeKey(argKey);
    return nk.includes("targetnode") || nk.includes("nodepath") || nk.includes("noderef");
  }

  _inferNodeTargetCandidate({ argKey = "", args = {}, workflowState = null } = {}) {
    if (!this._canInferNodeTargetForKey(argKey)) return null;
    const out = isPlainObject(args) ? args : {};
    const semState = isPlainObject(workflowState?.semanticState) ? workflowState.semanticState : {};
    const semIntent = isPlainObject(workflowState?.semanticIntent) ? workflowState.semanticIntent : {};
    const semStateRefs = isPlainObject(semState?.targetRefs) ? semState.targetRefs : {};
    const semIntentRefs = isPlainObject(semIntent?.refs) ? semIntent.refs : {};
    const semStateCreation = isPlainObject(semState?.creationIntent) ? semState.creationIntent : {};
    const semIntentCreation = isPlainObject(semIntent?.creationIntent) ? semIntent.creationIntent : {};
    const candidates = [
      out.targetNodeRef,
      out.targetNode,
      out.targetNodePath,
      out.nodeRef,
      out.nodePath,
      semStateRefs.targetNodeRef,
      semStateRefs.nodeRef,
      semIntentRefs.targetNodeRef,
      semIntentRefs.nodeRef,
      semState.targetConcept,
      semIntent.targetConcept,
      out.nodeName,
      out.targetNodeName,
      out.requestedName,
      semStateCreation.requestedName,
      semIntentCreation.requestedName,
    ];
    for (const candidate of candidates) {
      const value = safeString(candidate).trim();
      if (!value || isLikelyMarkerToken(value)) continue;
      return value;
    }
    return null;
  }

  async resolveNodeRefs({ toolName, args, classification, workflowState = null } = {}) {
    const out = { ...(isPlainObject(args) ? args : {}) };
    const missingArgs = [];
    const ambiguities = [];
    const notFoundByKey = new Map();
    const keys = Array.isArray(classification?.node_target_args) ? classification.node_target_args : [];
    const artifactValues = new Set();
    const resolvedNodeByKey = new Map();
    for (const k of ["scriptRef", "fileRef", "resourceRef", "artifactRef", "scriptPath", "filePath", "resourcePath", "path"]) {
      const v = safeString(out[k]).trim();
      if (v) artifactValues.add(v);
    }

    // Node target resolution depends on scene/file resolution already being done.
    // console.log("[generic-mcp][args] resolveNodeRefs out", out);
    const scenePath = this._extractResolvedScenePath(out, workflowState);
    // console.log("scenePath [ArgumentResolver]", scenePath);
    for (const key of keys) {
      let rawText = safeString(out[key]).trim();
      if (!rawText || isLikelyMarkerToken(rawText)) {
        const inferred = this._inferNodeTargetCandidate({
          argKey: key,
          args: out,
          workflowState,
        });
        if (!inferred) {
          if (rawText) missingArgs.push(key);
          continue;
        }
        rawText = inferred;
      }
      if (isLikelyMarkerToken(rawText)) {
        missingArgs.push(key);
        continue;
      }
      if (this._looksLikeFileResourceValue(rawText) || artifactValues.has(rawText)) {
        const inferred = this._inferNodeTargetCandidate({
          argKey: key,
          args: out,
          workflowState,
        });
        const inferredText = safeString(inferred).trim();
        const canRecoverFromSemanticNodeRef = Boolean(
          inferredText &&
          inferredText !== rawText &&
          !isLikelyMarkerToken(inferredText) &&
          !this._looksLikeFileResourceValue(inferredText) &&
          !artifactValues.has(inferredText)
        );
        if (!canRecoverFromSemanticNodeRef) {
          notFoundByKey.set(key, `${key} (not_found: ${rawText})`);
          continue;
        }
        rawText = inferredText;
      }
      const resolved = await this._resolveNodeRef({
        toolName,
        argKey: key,
        value: rawText,
        scenePath,
      });
      if (resolved.status === "resolved") {
        out[key] = resolved.value;
        resolvedNodeByKey.set(key, safeString(resolved.value).trim());
      } else if (resolved.status === "ambiguous") {
        ambiguities.push(...resolved.ambiguities);
      } else if (resolved.status === "not_found") {
        notFoundByKey.set(key, `${key} (not_found: ${rawText})`);
      } else if (resolved.status === "missing") {
        missingArgs.push(key);
      }
    }
    // Node-target aliases are interchangeable semantic slots. If one alias is
    // resolved, reuse it for unresolved siblings to avoid false not_found on the
    // same target domain.
    const canonicalResolvedNode =
      resolvedNodeByKey.get("targetNode") ||
      resolvedNodeByKey.get("targetNodePath") ||
      resolvedNodeByKey.get("nodePath") ||
      resolvedNodeByKey.get("targetNodeRef") ||
      resolvedNodeByKey.get("nodeRef") ||
      null;
    if (canonicalResolvedNode) {
      for (const key of keys) {
        const current = safeString(out[key]).trim();
        const shouldBackfill =
          !current ||
          isLikelyMarkerToken(current) ||
          this._looksLikeFileResourceValue(current) ||
          artifactValues.has(current) ||
          notFoundByKey.has(key);
        if (!shouldBackfill) continue;
        out[key] = canonicalResolvedNode;
        notFoundByKey.delete(key);
      }
    }
    return {
      args: out,
      missingArgs,
      ambiguities,
      notFoundRefs: [...notFoundByKey.values()],
    };
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
      normalized.includes("projectref") ||
      normalized.includes("project_root") ||
      normalized.includes("project_ref") ||
      normalized.includes("projectroot") ||
      normalized.includes("project_path")
    );
  }

  _isFileResourceRefKey(normalized) {
    if (this._isSessionContextKey(normalized)) return false;
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

  _isNodeTargetKey(normalized) {
    return (
      normalized.includes("nodepath") ||
      normalized.includes("noderef") ||
      normalized.includes("parentpath") ||
      normalized.includes("targetnode")
    );
  }

  _isFileResourceSemanticSlot(slot = "") {
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

  _isArtifactPathKey(normalized) {
    return (
      normalized.includes("scriptref") ||
      normalized.includes("fileref") ||
      normalized.includes("resourceref") ||
      normalized.includes("artifactref") ||
      normalized.includes("scriptpath") ||
      normalized.includes("filepath") ||
      normalized.includes("resourcepath") ||
      normalized.includes("artifactpath") ||
      normalized === "path"
    );
  }

  _hasCreationIntentSignals(args = {}, workflowState = null) {
    const a = isPlainObject(args) ? args : {};
    const nested = isPlainObject(a.creationIntent) ? a.creationIntent : {};
    const semanticStateCreation = isPlainObject(workflowState?.semanticState?.creationIntent)
      ? workflowState.semanticState.creationIntent
      : {};
    const semanticIntentCreation = isPlainObject(workflowState?.semanticIntent?.creationIntent)
      ? workflowState.semanticIntent.creationIntent
      : {};
    const goalText = safeString(workflowState?.semanticIntent?.goalText).trim();
    const hasRequestedName = Boolean(
      safeString(a.requestedName).trim() ||
      safeString(nested.requestedName).trim() ||
      safeString(semanticStateCreation.requestedName).trim() ||
      safeString(semanticIntentCreation.requestedName).trim()
    );
    const hasTargetFolder = Boolean(
      safeString(a.targetFolder).trim() ||
      safeString(nested.targetFolder).trim() ||
      safeString(semanticStateCreation.targetFolder).trim() ||
      safeString(semanticIntentCreation.targetFolder).trim()
    );
    const hasCreateFlag =
      a.create === true ||
      a.isCreate === true ||
      a.isNew === true ||
      nested.create === true ||
      nested.isCreate === true ||
      nested.isNew === true ||
      semanticStateCreation.create === true ||
      semanticStateCreation.isCreate === true ||
      semanticStateCreation.isNew === true ||
      semanticIntentCreation.create === true ||
      semanticIntentCreation.isCreate === true ||
      semanticIntentCreation.isNew === true;
    return hasRequestedName || hasTargetFolder || hasCreateFlag || /\b(create|new|generate|scaffold)\b/i.test(goalText);
  }

  _isCreateLikeArtifactStep({ toolName = "", args = {}, classification = null, workflowState = null } = {}) {
    const opMode = safeString(workflowState?.artifactOperation?.mode).trim().toLowerCase();
    if (opMode.startsWith("create_")) return true;
    const rolesByArg = isPlainObject(classification?.rolesByArg) ? classification.rolesByArg : {};
    for (const meta of Object.values(rolesByArg)) {
      if (safeString(meta?.role).trim().toLowerCase() === "creation_intent_derived") return true;
    }
    const normalizedToolName = safeString(toolName).replace(/[_-]+/g, " ").toLowerCase();
    if (/\b(create|new|generate|scaffold|init)\b/.test(normalizedToolName)) return true;
    return this._hasCreationIntentSignals(args, workflowState);
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
    const client = getSessionClient(this._sessionManager);
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
    const attempt = (query) => {
      const q = safeString(query).trim();
      if (!q) return { status: "not_found", value: null, ambiguities: [] };
      const byPath = nodes.find((n) => n.path === q);
      if (byPath) return { status: "resolved", value: byPath.path, ambiguities: [] };
      const exactNames = nodes.filter((n) => safeString(n.name).trim() === q);
      if (exactNames.length === 1) return { status: "resolved", value: exactNames[0].path, ambiguities: [] };
      if (exactNames.length > 1) return { status: "ambiguous", value: null, ambiguities: [...new Set(exactNames.map((n) => n.path))] };
      const lower = q.toLowerCase();
      const ci = nodes.filter((n) => safeString(n.name).trim().toLowerCase() === lower);
      if (ci.length === 1) return { status: "resolved", value: ci[0].path, ambiguities: [] };
      if (ci.length > 1) return { status: "ambiguous", value: null, ambiguities: [...new Set(ci.map((n) => n.path))] };
      const suffix = nodes.filter((n) => safeString(n.path).toLowerCase().endsWith(lower) || safeString(n.path).split("/").some((seg) => seg.toLowerCase() === lower));
      if (suffix.length === 1) return { status: "resolved", value: suffix[0].path, ambiguities: [] };
      if (suffix.length > 1) return { status: "ambiguous", value: null, ambiguities: [...new Set(suffix.map((n) => n.path))] };
      return { status: "not_found", value: null, ambiguities: [] };
    };
    const direct = attempt(raw);
    if (direct.status !== "not_found") return direct;
    if (raw.includes("/")) {
      const segments = raw.split("/").map((s) => safeString(s).trim()).filter(Boolean);
      for (let i = 1; i < segments.length; i += 1) {
        const fallback = attempt(segments.slice(i).join("/"));
        if (fallback.status !== "not_found") return fallback;
      }
    }
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

    // console.log("[AR] args:",{args});

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
    if (this._debug) {
      console.log("[VERIFY][content-sink-selection]", {
        tool: safeString(toolName).trim() || null,
        selectedContentField: safeString(sink?.selectedContentField).trim() || null,
        availableContentFields: Array.isArray(sink?.availableContentFields) ? sink.availableContentFields : [],
        mapped: Boolean(sink?.mapped),
        args: normalizedModifyArgs,
      });
    }
    const readiness = ensureRichPayloadReadiness({
      toolName,
      args: normalizedModifyArgs,
      inventory,
      workflowState,
      semanticIntent: workflowState?.semanticIntent,
    });
    const contractValidatedArgs = this._normalizeStructuredModifyPayloadForContract({
      toolName,
      args: isPlainObject(readiness?.args) ? readiness.args : argsWithSink,
      inventory,
    });
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
      args: contractValidatedArgs,
      argMeta: inMeta,
      inventory,
      workflowState,
    });
    if (this._debug) {
      console.log("[VERIFY][modify-target-resolution]", {
        tool: safeString(toolName).trim() || null,
        operationMode: safeString(workflowState?.artifactOperation?.mode).trim().toLowerCase() || null,
        typedRefs: modifyGate.typedRefs ?? {},
        typedPaths: modifyGate.typedPaths ?? {},
        resolvedArtifactPath: modifyGate.resolvedArtifactPath ?? null,
        resolutionStatus: modifyGate.resolutionStatus ?? "unknown",
        canProceed: Boolean(modifyGate.canProceed),
      });
    }
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
      toolName,
      args: contractValidatedArgs,
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
    const collapsedInlineArgs = this._collapseInlineContentAliases({
      toolName,
      args: contractValidatedArgs,
      inventory,
    });
    const normalizedPropertyArgs = this._normalizePropertyPayloadAliases({
      toolName,
      args: collapsedInlineArgs,
      inventory,
    });
    return {
      status: "ready",
      args: normalizedPropertyArgs,
      argMeta: inMeta,
      reason: null,
    };
  }

  _ensureAttachExistingDualResolution({ toolName = "", args = {}, argMeta = {}, inventory = null, workflowState = null } = {}) {
    const mode = safeString(workflowState?.artifactOperation?.mode).trim().toLowerCase();
    const isAttach = mode === "attach_existing" || mode === "create_then_attach" || mode === "modify_then_attach";
    if (!isAttach) return { ok: true };
    const a = isPlainObject(args) ? args : {};
    const m = isPlainObject(argMeta) ? argMeta : {};

    const artifactPathCandidates = this._collectAttachArtifactPathCandidates({
      toolName,
      args: a,
      argMeta: m,
      inventory,
    });
    const hasResolvedArtifact = artifactPathCandidates.length > 0;
    if (!hasResolvedArtifact) {
      const field = this._preferredArtifactSemanticField(a);
      const attempted = this._extractAttachArtifactAttemptedValue(a);
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
      safeString(a.targetNodeRef).trim() ||
      safeString(this._inferNodeTargetCandidate({ argKey: "targetNodeRef", args: a, workflowState })).trim();
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

  _collectAttachArtifactPathCandidates({ toolName = "", args = {}, argMeta = {}, inventory = null } = {}) {
    const out = [];
    const a = isPlainObject(args) ? args : {};
    const m = isPlainObject(argMeta) ? argMeta : {};
    const schema = this._getToolSchema(toolName, inventory);
    const roleInfo = classifyToolArgs({ toolName, inputSchema: schema, args: a });

    for (const [key, rawValue] of Object.entries(a)) {
      const value = safeString(rawValue).trim();
      if (!value || !this._looksConcreteArtifactPath(value)) continue;
      const nk = normalizeKey(key);
      if (this._isProjectPathKey(nk)) continue;

      const roleMeta = isPlainObject(roleInfo?.rolesByArg?.[key]) ? roleInfo.rolesByArg[key] : null;
      const role = safeString(roleMeta?.role).trim().toLowerCase();
      const semanticSlot = safeString(roleMeta?.semanticSlot).trim().toLowerCase();
      const slotLooksNodeRef =
        semanticSlot.includes("noderef") ||
        semanticSlot.includes("targetnode") ||
        semanticSlot.includes("parentnode");
      if (this._isNodeTargetKey(nk) || slotLooksNodeRef) continue;

      const looksPathLike = this._isFileResourceRefKey(nk);
      const looksSemanticArtifactRef = semanticSlot.endsWith("ref") && semanticSlot !== "projectpath" && !slotLooksNodeRef;
      const hasResolverPathPolicy = isPlainObject(m?.[key]);
      const roleSuggestsResourcePath = role === "semantic_ref" || role === "creation_intent_derived";
      if (!looksPathLike && !looksSemanticArtifactRef && !hasResolverPathPolicy && !roleSuggestsResourcePath) {
        continue;
      }

      out.push({
        key,
        value,
        role: role || null,
        semanticSlot: semanticSlot || null,
        existencePolicy: safeString(m?.[key]?.existencePolicy).trim().toLowerCase() || null,
      });
    }
    return out;
  }

  _extractAttachArtifactAttemptedValue(args = {}) {
    const a = isPlainObject(args) ? args : {};
    for (const [key, rawValue] of Object.entries(a)) {
      const value = safeString(rawValue).trim();
      if (!value || isLikelyMarkerToken(value)) continue;
      const nk = normalizeKey(key);
      if (this._isProjectPathKey(nk) || this._isNodeTargetKey(nk)) continue;
      if (nk.endsWith("ref") || this._isFileResourceRefKey(nk)) return value;
    }
    return null;
  }

  _extractGeneratedContent({ args = {}, workflowState = null } = {}) {
    const generatedCandidates = [
      safeString(workflowState?.semanticState?.generatedContent?.content).trim(),
      safeString(workflowState?.semanticState?.generatedCode).trim(),
      safeString(args?.generatedCode).trim(),
      safeString(args?.generatedContent?.content).trim(),
    ].filter(Boolean);
    const directCodeCandidates = [
      safeString(args?.content).trim(),
      safeString(args?.body).trim(),
      safeString(args?.source).trim(),
      safeString(args?.text).trim(),
      safeString(args?.code).trim(),
      safeString(args?.snippet).trim(),
      safeString(args?.script).trim(),
      safeString(args?.template).trim(),
    ].filter((value) => looksLikeCodePayload(value));
    const preferred = this._pickBestInlineContentValue([...generatedCandidates, ...directCodeCandidates]);
    if (hasNonEmpty(preferred)) return safeString(preferred).trim();
    const intentCandidate = [
      args?.codeIntent,
      args?.contentIntent,
      workflowState?.semanticState?.codeIntent,
      workflowState?.semanticState?.contentIntent,
      workflowState?.semanticIntent?.codeIntent,
      workflowState?.semanticIntent?.contentIntent,
    ].find((value) => looksLikeCodePayload(value));
    if (intentCandidate) return safeString(intentCandidate).trim();
    return (
      safeString(workflowState?.semanticState?.generatedContent?.content).trim() ||
      safeString(workflowState?.semanticState?.generatedCode).trim() ||
      ""
    );
  }

  _buildCompileVariants({ toolName, args, inventory = null, generatedContent = "" } = {}) {
    const base = isPlainObject(args) ? { ...args } : {};
    const variants = [];
    const content = safeString(generatedContent).trim();
    const seen = new Set();
    const pushVariant = (candidate) => {
      const sig = JSON.stringify(candidate);
      if (seen.has(sig)) return;
      seen.add(sig);
      variants.push(candidate);
    };

    if (content) {
      const schema = this._getToolSchema(toolName, inventory);
      const props = isPlainObject(schema?.properties) ? schema.properties : {};
      const keys = Object.keys(props).filter((k) => this._looksLikeInlineContentField(k));
      for (const key of keys.slice(0, 4)) {
        const next = { ...base };
        const existing = safeString(next[key]).trim();
        const shouldOverride =
          !hasNonEmpty(existing) ||
          (looksLikeCodePayload(content) && !looksLikeCodePayload(existing));
        if (shouldOverride) next[key] = content;
        pushVariant(next);
      }
    }

    if (variants.length < 1) {
      pushVariant(base);
      return variants;
    }

    pushVariant(base);
    return variants;
  }

  _looksLikeInlineContentField(key) {
    const nk = normalizeKey(key);
    if (nk.includes("path") || nk.endsWith("ref") || nk.includes("project")) return false;
    return (
      nk === "script" ||
      nk.includes("content") ||
      nk.includes("body") ||
      nk.includes("source") ||
      nk.includes("text") ||
      nk.includes("code") ||
      nk.includes("snippet") ||
      nk.includes("template")
    );
  }

  _inlineContentPriority(key = "") {
    const lower = safeString(key).trim().toLowerCase();
    const priority = [
      "content",
      "scriptcontent",
      "body",
      "source",
      "text",
      "code",
      "snippet",
      "sourcecode",
      "filecontent",
      "raw",
      "data",
    ];
    const idx = priority.indexOf(lower);
    return idx >= 0 ? idx : priority.length + 1;
  }

  _pickPreferredInlineContentKey(keys = [], required = []) {
    const reqSet = new Set((Array.isArray(required) ? required : []).map((k) => safeString(k).trim()).filter(Boolean));
    const ordered = [...(Array.isArray(keys) ? keys : [])]
      .map((k) => safeString(k).trim())
      .filter(Boolean)
      .sort((a, b) => this._inlineContentPriority(a) - this._inlineContentPriority(b));
    const requiredPick = ordered.find((k) => reqSet.has(k));
    return requiredPick || ordered[0] || null;
  }

  _scoreInlineContentValue(value) {
    const text = safeString(value).trim();
    if (!text) return -1;
    const codeBoost = looksLikeCodePayload(text) ? 100000 : 0;
    return codeBoost + text.length;
  }

  _pickBestInlineContentValue(values = []) {
    let best = null;
    let bestScore = -1;
    for (const value of values) {
      if (!hasNonEmpty(value)) continue;
      const score = this._scoreInlineContentValue(value);
      if (score > bestScore) {
        bestScore = score;
        best = safeString(value);
      }
    }
    return best;
  }

  _collapseInlineContentAliases({ toolName, args = {}, inventory = null } = {}) {
    const out = isPlainObject(args) ? { ...args } : {};
    const schema = this._getToolSchema(toolName, inventory);
    const props = isPlainObject(schema?.properties) ? schema.properties : {};
    const inlineKeys = Object.keys(props).filter((k) => this._looksLikeInlineContentField(k));
    if (inlineKeys.length < 2) return out;
    const required = Array.isArray(schema?.required)
      ? schema.required.map((k) => safeString(k).trim()).filter(Boolean)
      : [];
    const selected = this._pickPreferredInlineContentKey(inlineKeys, required);
    if (!selected) return out;
    const candidates = inlineKeys.map((k) => out[k]).filter((v) => hasNonEmpty(v));
    const canonical = this._pickBestInlineContentValue(candidates);
    if (!hasNonEmpty(canonical)) return out;
    out[selected] = canonical;
    const requiredSet = new Set(required);
    for (const key of inlineKeys) {
      if (key === selected) continue;
      if (requiredSet.has(key)) continue;
      if (!hasNonEmpty(out[key])) continue;
      delete out[key];
    }
    return out;
  }

  _normalizePropertyPayloadAliases({ toolName, args = {}, inventory = null } = {}) {
    const out = isPlainObject(args) ? { ...args } : {};
    const schema = this._getToolSchema(toolName, inventory);
    const props = isPlainObject(schema?.properties) ? schema.properties : {};
    const keys = ["properties", "propertyMap", "props"].filter((k) =>
      Object.prototype.hasOwnProperty.call(out, k) || Object.prototype.hasOwnProperty.call(props, k)
    );
    if (keys.length < 1) return out;

    const required = Array.isArray(schema?.required)
      ? schema.required.map((k) => safeString(k).trim()).filter(Boolean)
      : [];
    const requiredSet = new Set(required);
    const schemaOrder = ["properties", "propertyMap", "props"];
    const preferred =
      keys.find((k) => requiredSet.has(k)) ||
      schemaOrder.find((k) => Object.prototype.hasOwnProperty.call(props, k)) ||
      keys[0];
    if (!preferred) return out;

    let payloadObj = null;
    let payloadText = null;
    for (const key of keys) {
      const raw = out[key];
      if (isPlainObject(raw)) {
        payloadObj = this._normalizeTypedPropertyObjectsToPathEntries(raw);
        break;
      }
      if (typeof raw === "string") {
        const text = safeString(raw).trim();
        if (!text) continue;
        payloadText = payloadText ?? text;
        try {
          const parsed = JSON.parse(text);
          if (isPlainObject(parsed)) {
            payloadObj = this._normalizeTypedPropertyObjectsToPathEntries(parsed);
            break;
          }
        } catch {
          // keep as raw text fallback
        }
      }
    }
    if (!payloadObj && !payloadText) return out;

    const preferredSchema = isPlainObject(props?.[preferred]) ? props[preferred] : {};
    const preferredType = safeString(preferredSchema?.type).trim().toLowerCase();
    if (preferredType === "string") {
      out[preferred] = payloadText ?? JSON.stringify(payloadObj ?? {});
    } else {
      out[preferred] = payloadObj ?? payloadText;
    }

    for (const key of keys) {
      if (key === preferred) continue;
      if (requiredSet.has(key)) continue;
      if (!Object.prototype.hasOwnProperty.call(out, key)) continue;
      delete out[key];
    }
    return out;
  }

  _normalizeTypedPropertyObjectsToPathEntries(properties = {}) {
    const input = isPlainObject(properties) ? properties : {};
    const out = { ...input };
    for (const [key, value] of Object.entries(input)) {
      if (!isPlainObject(value)) continue;
      const type = safeString(value.type).trim();
      if (!type) continue;
      const hasPath = hasNonEmpty(value.path) || hasNonEmpty(value.resourcePath) || hasNonEmpty(value.resource_path);
      const isResourceLike = type.toLowerCase() === "resource" || hasPath;
      if (isResourceLike) continue;
      const entries = Object.entries(value).filter(([k]) => k !== "type");
      if (entries.length < 1) continue;
      out[key] = type;
      for (const [subKey, subValue] of entries) {
        const part = safeString(subKey).trim();
        if (!part) continue;
        out[`${key}/${part}`] = subValue;
      }
    }
    return out;
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
    const createLikeStep = this._isCreateLikeArtifactStep({ toolName, args, workflowState });
    const needsGate = !createLikeStep && (opMode === "modify_existing" || opMode === "modify_then_attach");
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

  _extractSupportedModificationTypesFromItemSchema(itemSchema = null) {
    const itemProps = isPlainObject(itemSchema?.properties) ? itemSchema.properties : {};
    const typeSchema = isPlainObject(itemProps?.type)
      ? itemProps.type
      : (isPlainObject(itemProps?.modificationType) ? itemProps.modificationType : {});
    const out = new Set();
    if (Array.isArray(typeSchema?.enum)) {
      for (const v of typeSchema.enum) {
        const t = safeString(v).trim();
        if (t) out.add(t);
      }
    }
    const typeDesc = safeString(typeSchema?.description).trim();
    if (typeDesc) {
      const quoted = [...typeDesc.matchAll(/[\"'`]([A-Za-z0-9_:-]+)[\"'`]/g)];
      for (const m of quoted) {
        const t = safeString(m?.[1]).trim();
        if (t) out.add(t);
      }
      const underscored = [...typeDesc.matchAll(/\\b[a-z]+_[a-z0-9_]+\\b/gi)];
      for (const m of underscored) {
        const t = safeString(m?.[0]).trim();
        if (t) out.add(t);
      }
    }
    return [...out];
  }

  _normalizeStructuredModifyPayloadForContract({ toolName, args = {}, inventory = null } = {}) {
    if (this._debug) {
      console.log("[ArgumentResolver] args", args);
    }
    const out = isPlainObject(args) ? { ...args } : {};
    const schema = this._getToolSchema(toolName, inventory);
    const modsSchema = isPlainObject(schema?.properties?.modifications) ? schema.properties.modifications : null;
    const itemSchema = isPlainObject(modsSchema?.items) ? modsSchema.items : null;
    if (!modsSchema || !itemSchema) return out;
    const requiresMods = Array.isArray(schema?.required) && schema.required.includes("modifications");
    if (!requiresMods) return out;
    const supportedTypes = [
      ...new Set([
        ...this._extractSupportedModificationTypesFromContract({ toolName, inventory }),
        ...this._extractSupportedModificationTypesFromItemSchema(itemSchema),
      ]),
    ]
      .map((x) => safeString(x).trim())
      .filter(Boolean);
    if (Array.isArray(out.modifications)) {
      out.modifications = out.modifications.map((item) =>
        this._normalizeModificationItemAgainstContract({ item, itemSchema, supportedTypes })
      );
      return out;
    }
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
      normalizedItems.push(this._normalizeModificationItemAgainstContract({ item, itemSchema, supportedTypes }));
    }
    if (normalizedItems.length > 0) {
      out.modifications = normalizedItems;
    }
    return out;
  }

  _firstContentLikeModificationField(itemSchema = null) {
    const itemProps = isPlainObject(itemSchema?.properties) ? itemSchema.properties : {};
    const keys = Object.keys(itemProps);
    const preferred = [
      "content",
      "body",
      "source",
      "text",
      "code",
      "snippet",
      "functionBody",
      "functionCode",
      "scriptContent",
      "scriptBody",
      "scriptSource",
    ];
    for (const key of preferred) {
      if (Object.prototype.hasOwnProperty.call(itemProps, key)) return key;
    }
    return keys.find((key) => {
      const lower = safeString(key).trim().toLowerCase();
      return /(content|body|source|text|code|snippet)/.test(lower);
    }) || null;
  }

  _chooseSupportedModificationType({ item = {}, supportedTypes = [] } = {}) {
    const supported = (Array.isArray(supportedTypes) ? supportedTypes : [])
      .map((x) => safeString(x).trim())
      .filter(Boolean);
    if (supported.length < 1) return null;
    const supportedLower = new Set(supported.map((x) => x.toLowerCase()));
    const current = safeString(item?.type).trim() || safeString(item?.kind).trim();
    if (current && supportedLower.has(current.toLowerCase())) return current;

    const field = safeString(item?.field).trim().toLowerCase();
    const name = safeString(item?.name || item?.functionName || item?.variableName || item?.signalName).trim().toLowerCase();
    const valueText = safeString(item?.value || item?.newValue || item?.content || item?.body || item?.source || item?.code).trim();

    if (supportedLower.has("add_signal")) {
      if (field.includes("signal") || name.includes("signal")) return "add_signal";
    }
    if (supportedLower.has("add_variable")) {
      if (
        hasNonEmpty(item?.varType) ||
        hasNonEmpty(item?.valueType) ||
        hasNonEmpty(item?.defaultValue) ||
        field.includes("var") ||
        field.includes("variable")
      ) {
        return "add_variable";
      }
    }
    if (supportedLower.has("add_function")) {
      if (
        hasNonEmpty(item?.content) ||
        hasNonEmpty(item?.body) ||
        hasNonEmpty(item?.source) ||
        hasNonEmpty(item?.code) ||
        field.includes("code") ||
        field.includes("function") ||
        field.includes("intent") ||
        valueText.length > 0
      ) {
        return "add_function";
      }
    }
    return supported[0];
  }

  _normalizeModificationItemAgainstContract({ item = {}, itemSchema = null, supportedTypes = [] } = {}) {
    const out = isPlainObject(item) ? { ...item } : {};
    const chosenType = this._chooseSupportedModificationType({ item: out, supportedTypes });
    if (chosenType && !safeString(out.type).trim()) out.type = chosenType;
    if (chosenType && safeString(out.type).trim().toLowerCase() !== safeString(chosenType).trim().toLowerCase()) {
      out.type = chosenType;
    }
    const loweredType = safeString(out.type).trim().toLowerCase();
    if (loweredType === "add_function") {
      if (!hasNonEmpty(out.name)) {
        out.name =
          safeString(out.functionName).trim() ||
          basenameWithoutExt(out.target) ||
          safeString(out.field).trim() ||
          "generated_function";
      }
      const contentField = this._firstContentLikeModificationField(itemSchema);
      if (contentField && !hasNonEmpty(out[contentField])) {
        const payload =
          safeString(out.content).trim() ||
          safeString(out.body).trim() ||
          safeString(out.source).trim() ||
          safeString(out.code).trim() ||
          safeString(out.value).trim() ||
          safeString(out.newValue).trim();
        if (payload) out[contentField] = payload;
      }
    } else if (loweredType === "add_variable") {
      if (!hasNonEmpty(out.name)) {
        out.name = safeString(out.variableName).trim() || safeString(out.field).trim() || "new_variable";
      }
      if (!hasNonEmpty(out.varType) && hasNonEmpty(out.valueType)) {
        out.varType = safeString(out.valueType).trim();
      }
    } else if (loweredType === "add_signal") {
      if (!hasNonEmpty(out.name)) {
        out.name = safeString(out.signalName).trim() || safeString(out.field).trim() || "new_signal";
      }
    }
    return out;
  }
}
