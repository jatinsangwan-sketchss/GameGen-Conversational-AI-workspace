/**
 * Executor
 * -----------------------------------------------------------------------------
 * Executes resolved Generic MCP plans directly against MCP transport.
 *
 * Scope:
 * - validate tool existence against live inventory
 * - validate required arguments
 * - build tools/call payload
 * - execute in-order (1..6 tools)
 * - preserve raw MCP responses and raw failure bodies
 *
 * Out of scope:
 * - request planning
 * - argument/path resolution
 * - result formatting
 */
import fs from "node:fs/promises";
import path from "node:path";
import { ArtifactRegistry } from "./ArtifactRegistry.js";
import { coercePropertyLikeArgs } from "./PropertyValueCoercer.js";
import { describeClientAvailability, getSessionClient } from "./utils/session-client.js";

function safeString(value) {
  return value == null ? "" : String(value);
}

function isPlainObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function toArgs(value) {
  return isPlainObject(value) ? value : {};
}

function normalizeRequired(inputSchema) {
  return Array.isArray(inputSchema?.required)
    ? inputSchema.required.map((k) => safeString(k).trim()).filter(Boolean)
    : [];
}

function extractInputSchema(tool) {
  if (!isPlainObject(tool)) return {};
  if (isPlainObject(tool.inputSchema)) return tool.inputSchema;
  if (isPlainObject(tool.input_schema)) return tool.input_schema;
  return {};
}

function parseFailureText(rawResult) {
  if (rawResult == null) return "MCP tool reported failure.";
  if (typeof rawResult === "string") return rawResult;
  if (!isPlainObject(rawResult)) return safeString(rawResult);

  const explicit = safeString(rawResult.error ?? rawResult.message ?? "").trim();
  if (explicit) return explicit;

  const content = Array.isArray(rawResult.content) ? rawResult.content : [];
  const text = content
    .map((c) => safeString(c?.text).trim())
    .filter(Boolean)
    .join("\n")
    .trim();
  if (text) return text;

  try {
    return JSON.stringify(rawResult);
  } catch {
    return "MCP tool reported failure.";
  }
}

function normalizeRef(input) {
  const raw = safeString(input).trim();
  if (!raw) return null;
  return raw.replace(/^res:\/\//i, "").replace(/^\/+/, "").replace(/\\/g, "/");
}

function collectPathLikeStrings(value, out = []) {
  if (value == null) return out;
  if (typeof value === "string") {
    const n = normalizeRef(value);
    if (n && /[./\\]/.test(n)) out.push(n);
    return out;
  }
  if (Array.isArray(value)) {
    for (const v of value) collectPathLikeStrings(v, out);
    return out;
  }
  if (isPlainObject(value)) {
    for (const [k, v] of Object.entries(value)) {
      const nk = safeString(k).toLowerCase().replace(/[^a-z0-9_]/g, "");
      if (nk.includes("path") || nk.includes("file") || nk.includes("scene") || nk.includes("resource")) {
        collectPathLikeStrings(v, out);
      }
    }
  }
  return out;
}

function isRawResultOk(rawResult) {
  if (!isPlainObject(rawResult)) return true;
  if (rawResult.ok === false) return false;
  if (rawResult.isError === true) return false;
  if (rawResult.error != null) return false;
  return true;
}
function normalizeKey(value) {
  return safeString(value).toLowerCase().replace(/[^a-z0-9_]/g, "");
}
function isAttachMode(workflowState = null) {
  const mode = safeString(workflowState?.artifactOperation?.mode).trim().toLowerCase();
  return mode === "attach_existing" || mode === "create_then_attach" || mode === "modify_then_attach";
}
function pickFirstText(values = []) {
  for (const v of values) {
    const s = safeString(v).trim();
    if (s) return s;
  }
  return "";
}
function toGodotPath(value) {
  const rel = normalizeRef(value);
  return rel ? `res://${rel}` : null;
}
function looksAttachToolName(toolName) {
  const normalized = safeString(toolName).replace(/[_-]+/g, " ").toLowerCase();
  return /\b(attach|assign|link|bind)\b/.test(normalized) || /\bset\b.*\bscript\b/.test(normalized);
}
function hasScriptPropertyHint(args = {}) {
  const a = toArgs(args);
  const directName = safeString(a.propertyName || a.property || a.key).trim().toLowerCase();
  if (directName === "script") return true;
  for (const key of ["propertyMap", "properties", "props"]) {
    const raw = a[key];
    if (isPlainObject(raw) && Object.prototype.hasOwnProperty.call(raw, "script")) return true;
    if (typeof raw === "string") {
      try {
        const parsed = JSON.parse(raw);
        if (isPlainObject(parsed) && Object.prototype.hasOwnProperty.call(parsed, "script")) return true;
      } catch {
        // ignore non-json property payloads
      }
    }
  }
  return false;
}

function isLikelyReadOnlyToolName(toolName) {
  const t = safeString(toolName).trim().toLowerCase();
  if (!t) return false;
  const hasReadVerb = /\b(get|read|list|show|find|inspect|query|fetch|describe)\b/.test(t);
  const hasWriteVerb = /\b(set|add|create|new|update|modify|edit|patch|delete|remove|attach|assign|link|save|write)\b/.test(t);
  return hasReadVerb && !hasWriteVerb;
}

function isLikelyMutationToolName(toolName) {
  const t = safeString(toolName).trim().toLowerCase();
  if (!t) return false;
  return /\b(set|add|create|new|update|modify|edit|patch|delete|remove|attach|assign|link|save|write|duplicate|reparent)\b/.test(t);
}

function tokenizeIdentity(value) {
  return (safeString(value).toLowerCase().match(/[a-z0-9]+/g) ?? []).filter(Boolean);
}

function parseJsonLikeContentBlocks(rawResult) {
  const out = [];
  if (isPlainObject(rawResult)) out.push(rawResult);
  if (Array.isArray(rawResult?.content)) {
    for (const block of rawResult.content) {
      const text = safeString(block?.text).trim();
      if (!text) continue;
      try {
        out.push(JSON.parse(text));
      } catch {
        // ignore non-json text blocks
      }
    }
  }
  return out.filter((v) => isPlainObject(v));
}

function parsePropertyContainer(raw) {
  if (isPlainObject(raw)) return raw;
  if (typeof raw !== "string") return null;
  const text = safeString(raw).trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
const VERIFIABLE_ARTIFACT_EXTENSIONS = new Set([
  ".tscn",
  ".gd",
  ".tres",
  ".res",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".shader",
  ".gdshader",
]);

function hasVerifiableArtifactExtension(candidate) {
  const rel = normalizeRef(candidate);
  if (!rel) return false;
  const ext = path.extname(rel).toLowerCase();
  return VERIFIABLE_ARTIFACT_EXTENSIONS.has(ext);
}
function isGdScriptArtifactCandidate(candidate) {
  const rel = normalizeRef(candidate);
  if (!rel) return false;
  return path.extname(rel).toLowerCase() === ".gd";
}
function isAlreadyExistsErrorText(text) {
  const t = safeString(text).trim().toLowerCase();
  if (!t) return false;
  return (
    t.includes("already exists") ||
    t.includes("already exist") ||
    t.includes("exists already") ||
    t.includes("file already exists") ||
    t.includes("script file already exists") ||
    t.includes("resource already exists")
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class Executor {
  constructor({ sessionManager = null, toolInventory = null, fileIndex = null, debug = false } = {}) {
    this._sessionManager = sessionManager ?? null;
    this._toolInventory = toolInventory ?? null;
    this._fileIndex = fileIndex ?? null;
    this._artifactRegistry = new ArtifactRegistry();
    this._debug = Boolean(debug) || safeString(process.env.DEBUG_GENERIC_MCP_EXECUTOR).toLowerCase() === "true";
  }

  async execute(resolvedPlan, { sessionStatus = null, inventory = null, artifactRegistry = null, workflowState = null } = {}) {
    const plan = isPlainObject(resolvedPlan) ? resolvedPlan : null;
    if (!plan) return { ok: false, results: [], error: "Resolved plan must be an object." };
    if (safeString(plan.status).trim() !== "ready") {
      return { ok: false, results: [], error: `Executor requires resolved plan status=ready, got "${safeString(plan.status)}".` };
    }

    const tools = Array.isArray(plan.tools) ? plan.tools : [];
    if (tools.length < 1 || tools.length > 6) {
      return { ok: false, results: [], error: `Executor requires 1..6 tools, got ${tools.length}.` };
    }

    const inv = await this._resolveInventory(inventory);
    if (!inv.ok) return { ok: false, results: [], error: inv.error };

    const client = await this._resolveClient(sessionStatus); 
    if (!client.ok) return { ok: false, results: [], error: client.error };
    const registry = artifactRegistry ?? this._artifactRegistry;

    const results = [];
    for (const t of tools) {
      const toolName = safeString(t?.name).trim();
      const prepared = this._prepareArgsForExecution({
        toolName,
        args: toArgs(t?.args),
        artifactRegistry: registry,
      });
      const args = prepared.args;
      const res = await this.executeTool({
        toolName,
        args,
        client: client.client,
        inventory: inv.inventory,
        artifactRegistry: registry,
        workflowState,
      });
      results.push(res);
      if (!res.ok) {
        return { ok: false, results, error: res.error ?? "MCP tool execution failed." };
      }
    }
    return { ok: true, results, error: null, artifacts: registry.getAll() };
  }

  async executeTool({ toolName, args, client, inventory, artifactRegistry = null, workflowState = null } = {}) {
    const tool = inventory.getTool(toolName);
    if (!tool) {
      return {
        ok: false,
        tool: toolName,
        args: toArgs(args),
        rawResult: null,
        error: `Tool not found in live inventory: ${toolName}`,
      };
    }

    const required = normalizeRequired(extractInputSchema(tool));
    const missing = required.filter((k) => args?.[k] == null || safeString(args[k]).trim() === "");
    if (missing.length > 0) {
      return {
        ok: false,
        tool: toolName,
        args: toArgs(args),
        rawResult: null,
        error: `Missing required args for ${toolName}: ${missing.join(", ")}`,
      };
    }

    const payload = this.buildPayload({ toolName, args: toArgs(args) });
    const expectsCreation = this._expectsArtifactCreation({ toolName, workflowState });
    const genericReadbackPlan = this._planGenericReadback({
      toolName,
      mutationArgs: toArgs(args),
      inventory,
    });
    const strictMutationVerification =
      this._isMutationLikeCall({ toolName, args: toArgs(args) }) &&
      !this._isAttachLikeMutation({ toolName, args: toArgs(args) });
    if (!expectsCreation && strictMutationVerification && safeString(genericReadbackPlan?.reason).trim() === "readback_args_unavailable") {
      return {
        ok: false,
        tool: toolName,
        args: toArgs(args),
        rawResult: null,
        error: "Mutation verification unavailable: read-back tool exists but required read arguments could not be compiled.",
        verification: {
          readback: {
            enabled: false,
            reason: "readback_args_unavailable",
          },
        },
      };
    }
    let preMutationReadback = null;
    if (genericReadbackPlan?.enabled && !expectsCreation) {
      preMutationReadback = await this._runGenericReadback({
        client,
        readTool: genericReadbackPlan.readTool,
        readArgs: genericReadbackPlan.readArgs,
        phase: "pre",
      });
      if (!preMutationReadback.ok) {
        return {
          ok: false,
          tool: toolName,
          args: toArgs(args),
          rawResult: null,
          error: preMutationReadback.reason || "Pre-mutation read-back failed.",
          verification: {
            readback: {
              enabled: true,
              readTool: safeString(genericReadbackPlan.readTool?.name).trim() || null,
              preOk: false,
              postOk: null,
              readArgs: isPlainObject(genericReadbackPlan.readArgs) ? genericReadbackPlan.readArgs : null,
            },
          },
        };
      }
    }
    const verifyArgs = toArgs(args);
    const semanticState = isPlainObject(workflowState?.semanticState) ? workflowState.semanticState : {};
    const arrayLenOrNull = (v) => (Array.isArray(v) ? v.length : null);
    if (this._debug) {
      console.log("[VERIFY][pre-executor]", {
        tool: toolName,
        argKeys: Object.keys(verifyArgs),
        argsPreview: verifyArgs,
        hasGeneratedContent: Boolean(safeString(semanticState?.generatedContent?.content).trim()),
        hasGeneratedCode: Boolean(safeString(semanticState?.generatedCode).trim()),
        hasCompiledPayload: isPlainObject(semanticState?.compiledPayload) && Object.keys(semanticState.compiledPayload).length > 0,
        hasModifications: Array.isArray(verifyArgs.modifications),
        modificationsLength: arrayLenOrNull(verifyArgs.modifications),
        hasOperations: Array.isArray(verifyArgs.operations) || isPlainObject(verifyArgs.operations),
        operationsLength: Array.isArray(verifyArgs.operations)
          ? verifyArgs.operations.length
          : (isPlainObject(verifyArgs.operations) ? Object.keys(verifyArgs.operations).length : null),
        hasEdits: Array.isArray(verifyArgs.edits),
        editsLength: arrayLenOrNull(verifyArgs.edits),
        hasPatches: Array.isArray(verifyArgs.patches),
        patchesLength: arrayLenOrNull(verifyArgs.patches),
        hasChanges: Array.isArray(verifyArgs.changes),
        changesLength: arrayLenOrNull(verifyArgs.changes),
      });
    }
    if (this._debug) {
      // eslint-disable-next-line no-console
      console.log("[GenericMCP][Executor][DEBUG] payload", payload);
    }

    // eslint-disable-next-line no-console
    if (this._debug) {
      console.log("[GenericMCP][Executor] execute", {
        tool: toolName,
        argKeys: Object.keys(toArgs(args)),
        argsPreview: toArgs(args),
      });
    }
    // console.log("[Executor] payload ", payload);

    const rawResult = await this._callTool(client, { toolName, args: toArgs(args), payload });
    let ok = isRawResultOk(rawResult);
    let error = ok ? null : this.extractFailureText(rawResult);
    if (!ok) {
      const recoverableCreateCollision = await this._isRecoverableCreateCollision({
        toolName,
        args: toArgs(args),
        rawResult,
        errorText: error,
        workflowState,
      });
      if (recoverableCreateCollision) {
        ok = true;
        error = null;
      }
    }
    if (ok) {
      const creationVerification = await this._verifyArtifactFilesExist({
        toolName,
        args: toArgs(args),
        rawResult,
        workflowState,
      });
      if (!creationVerification.ok) {
        ok = false;
        error = creationVerification.reason || "Creation verification failed.";
      }
    }
    if (ok) {
      await this._normalizeCreatedGdscriptHeaders({
        toolName,
        args: toArgs(args),
        rawResult,
        workflowState,
      });
    }
    if (ok) {
      const attachVerification = await this._verifyAttachApplied({
        toolName,
        args: toArgs(args),
        rawResult,
        client,
        inventory,
        workflowState,
      });
      if (!attachVerification.ok) {
        ok = false;
        error = attachVerification.reason || "Attach verification failed.";
      }
    }
    let genericReadbackVerification = { ok: true };
    if (ok) {
      genericReadbackVerification = await this._verifyMutationViaReadback({
        toolName,
        args: toArgs(args),
        rawResult,
        client,
        inventory,
        workflowState,
        plannedReadback: genericReadbackPlan,
        preReadback: preMutationReadback,
      });
      if (!genericReadbackVerification.ok) {
        ok = false;
        error = genericReadbackVerification.reason || "Mutation verification failed.";
      }
    }

    if (this._debug) {
      // eslint-disable-next-line no-console
      console.log("[GenericMCP][Executor][DEBUG] raw response", rawResult);
    }
    if (!ok) {
      // eslint-disable-next-line no-console
      if (this._debug) {
        console.log("[GenericMCP][Executor] failed", {
          tool: toolName,
          error,
        });
      }
    } else {
      if (this._debug) {
        // eslint-disable-next-line no-console
        console.log("[GenericMCP][Executor] success", { tool: toolName });
      }
      artifactRegistry?.registerFromExecution?.({ toolName, args: toArgs(args), rawResult });
      await this._updateProjectIndexAfterMutation({ toolName, args: toArgs(args), rawResult });
    }

    return {
      ok,
      tool: toolName,
      args: toArgs(args),
      rawResult,
      error,
      verification: {
        readback: {
          enabled: Boolean(genericReadbackPlan?.enabled),
          readTool: safeString(genericReadbackPlan?.readTool?.name).trim() || null,
          preOk: Boolean(preMutationReadback?.ok),
          postOk: Boolean(genericReadbackVerification?.ok),
          readArgs: isPlainObject(genericReadbackPlan?.readArgs) ? genericReadbackPlan.readArgs : null,
        },
      },
    };
  }

  buildPayload({ toolName, args } = {}) {
    return {
      method: "tools/call",
      params: {
        name: safeString(toolName).trim(),
        arguments: toArgs(args),
      },
    };
  }

  extractFailureText(rawResult) {
    return parseFailureText(rawResult);
  }

  _prepareArgsForExecution({ toolName, args, artifactRegistry }) {
    const base = toArgs(args);
    const coerced = coercePropertyLikeArgs({
      toolName,
      args: base,
      artifactRegistry,
    });
    if (this._debug && coerced.changed) {
      // eslint-disable-next-line no-console
      console.log("[GenericMCP][Executor][DEBUG] property coercion", {
        tool: toolName,
        count: coerced.coercions.length,
      });
    }
    return { args: coerced.args };
  }

  async _resolveInventory(inventoryArg) {
    if (inventoryArg && typeof inventoryArg.getTool === "function") {
      return { ok: true, inventory: inventoryArg };
    }
    const inv = this._toolInventory;
    if (!inv || typeof inv.load !== "function" || typeof inv.getTool !== "function") {
      return { ok: false, error: "Executor requires a valid toolInventory." };
    }
    const loaded = await inv.load();
    if (!loaded?.ok) return { ok: false, error: safeString(loaded?.error || "Failed to load inventory.") };
    return { ok: true, inventory: inv };
  }

  async _resolveClient(sessionStatusArg) {
    const sm = this._sessionManager;
    if (!sm) return { ok: false, error: "Executor requires sessionManager." };
    if (typeof sm.ensureReady === "function") {
      await sm.ensureReady(sessionStatusArg?.desiredProjectRoot ?? null);
    } else if (typeof sm.initialize === "function") {
      await sm.initialize(sessionStatusArg?.desiredProjectRoot ?? null);
    }
    const client = getSessionClient(sm);
    if (!client) {
      return {
        ok: false,
        error: `No active MCP client available from SessionManager (${describeClientAvailability(sm)}).`,
      };
    }
    return { ok: true, client };
  }

  async _callTool(client, { toolName, args, payload }) {
    // console.log("[Executor] callTool", typeof client.callTool, typeof client.toolsCall, typeof client.request, client.callTool(toolName,args));
    if (typeof client.callTool === "function") {
      return client.callTool(toolName, args);
    }
    if (typeof client.toolsCall === "function") {
      return client.toolsCall({ name: toolName, arguments: args });
    }
    if (typeof client.request === "function") {
      const res = await client.request(payload);
      // console.log("[Executor] callTool ",res);
      return isPlainObject(res) && isPlainObject(res.result) ? res.result : res;
    }
    throw new Error("MCP client does not support callTool/toolsCall/request.");
  }

  async _verifyAttachApplied({ toolName, args, client, inventory, workflowState }) {
    if (!isAttachMode(workflowState)) return { ok: true };
    const stepToolName = safeString(toolName).trim();
    const scriptTarget = pickFirstText([args.scriptPath, args.scriptRef]);
    const nodeTarget = pickFirstText([args.nodePath, args.targetNodePath, args.targetNode, args.nodeRef, args.targetNodeRef]);
    const sceneTarget = pickFirstText([args.scenePath, args.sceneRef]);
    const stepLooksAttach =
      Boolean(scriptTarget) &&
      (looksAttachToolName(stepToolName) || hasScriptPropertyHint(args));
    if (!stepLooksAttach) {
      return { ok: true };
    }
    if (!scriptTarget || !nodeTarget || !sceneTarget) {
      return { ok: true };
    }
    const readTool = this._pickNodePropertiesReadTool(inventory);
    if (!readTool) {
      return { ok: false, reason: "Attach verification failed: no node-properties read tool available for confirmation." };
    }
    const readArgs = this._buildNodePropertiesReadArgs({ tool: readTool, sceneTarget, nodeTarget, args });
    let verifyRaw = null;
    try {
      verifyRaw = await this._callTool(client, {
        toolName: readTool.name,
        args: readArgs,
        payload: this.buildPayload({ toolName: readTool.name, args: readArgs }),
      });
    } catch (err) {
      return { ok: false, reason: `Attach verification failed: read-back call errored (${safeString(err?.message ?? err)}).` };
    }
    if (!isRawResultOk(verifyRaw)) {
      return { ok: false, reason: `Attach verification failed: read-back tool failed (${this.extractFailureText(verifyRaw)}).` };
    }
    const actualPath = this._extractAttachedScriptPathFromReadResult(verifyRaw);
    const expectedPath = toGodotPath(scriptTarget);
    if (!expectedPath) {
      return { ok: false, reason: "Attach verification failed: expected script path is invalid after resolution." };
    }
    if (!actualPath) {
      return { ok: false, reason: "Attach verification failed: read-back did not return node script property." };
    }
    const a = normalizeRef(actualPath);
    const e = normalizeRef(expectedPath);
    if (a && e && a === e) return { ok: true };
    return {
      ok: false,
      reason: `Attach verification failed: expected script ${expectedPath} but node reports ${actualPath}.`,
    };
  }

  _expectsArtifactCreation({ toolName, workflowState }) {
    const expected = workflowState?.artifactOperation?.expectedEffects;
    if (isPlainObject(expected) && typeof expected.artifactCreated === "boolean") {
      return expected.artifactCreated;
    }
    return /create|new|generate|scaffold|save|write/i.test(safeString(toolName));
  }

  _resolveProjectRootForVerification(args = {}) {
    const a = toArgs(args);
    const fromArgs = pickFirstText([a.projectPath, a.project_path, a.projectRoot, a.project_root]);
    if (fromArgs) return path.resolve(fromArgs);
    const fromIndex = this._fileIndex && typeof this._fileIndex.getProjectRoot === "function"
      ? safeString(this._fileIndex.getProjectRoot()).trim()
      : "";
    return fromIndex ? path.resolve(fromIndex) : null;
  }

  _toAbsoluteArtifactCandidate(candidate, projectRoot) {
    const raw = safeString(candidate).trim();
    if (!raw || !hasVerifiableArtifactExtension(raw)) return null;
    if (path.isAbsolute(raw)) return path.normalize(raw);
    const rel = normalizeRef(raw);
    if (!rel || !projectRoot) return null;
    return path.resolve(projectRoot, rel);
  }

  _collectVerifiableArtifactCandidates({ args = {}, rawResult = null, projectRoot = null } = {}) {
    const uniq = new Set();
    const push = (value) => {
      const abs = this._toAbsoluteArtifactCandidate(value, projectRoot);
      if (abs) uniq.add(abs);
    };
    for (const c of collectPathLikeStrings(args)) push(c);
    for (const c of collectPathLikeStrings(rawResult)) push(c);
    return [...uniq];
  }

  async _pathExists(absPath) {
    try {
      const st = await fs.stat(absPath);
      return st.isFile();
    } catch {
      return false;
    }
  }

  async _pathExistsViaIndexOrFs(absPath, projectRoot = null) {
    const fi = this._fileIndex;
    if (fi && typeof fi.addOrUpdateRelativePath === "function" && projectRoot) {
      const relPath = path.relative(projectRoot, absPath).split(path.sep).join("/");
      if (relPath && !relPath.startsWith("..") && !path.isAbsolute(relPath)) {
        const upsert = await fi.addOrUpdateRelativePath(relPath);
        if (upsert?.ok) return true;
      }
    }
    return this._pathExists(absPath);
  }

  async _verifyArtifactFilesExist({ toolName, args = {}, rawResult = null, workflowState = null } = {}) {
    if (!this._expectsArtifactCreation({ toolName, workflowState })) return { ok: true };
    const projectRoot = this._resolveProjectRootForVerification(args);
    if (!projectRoot) {
      return { ok: false, reason: "Creation verification failed: missing project root for artifact existence checks." };
    }
    const candidates = this._collectVerifiableArtifactCandidates({ args, rawResult, projectRoot });
    if (candidates.length < 1) {
      return { ok: false, reason: "Creation verification failed: no verifiable artifact path found in tool args/result." };
    }
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      for (const abs of candidates) {
        const existsNow = await this._pathExistsViaIndexOrFs(abs, projectRoot);
        if (existsNow) {
          return { ok: true };
        }
      }
      if (attempt < 5) await sleep(120);
    }

    const pretty = candidates.map((p) => path.relative(projectRoot, p) || p);
    return {
      ok: false,
      reason: `Creation verification failed: expected artifact path(s) do not exist on disk (${pretty.join(", ")}).`,
    };
  }

  async _isRecoverableCreateCollision({ toolName, args = {}, rawResult = null, errorText = "", workflowState = null } = {}) {
    if (!this._expectsArtifactCreation({ toolName, workflowState })) return false;
    if (!isAlreadyExistsErrorText(errorText)) return false;
    const projectRoot = this._resolveProjectRootForVerification(args);
    if (!projectRoot) return false;
    const candidates = this._collectVerifiableArtifactCandidates({ args, rawResult, projectRoot });
    if (candidates.length < 1) return false;
    for (const abs of candidates) {
      const existsNow = await this._pathExistsViaIndexOrFs(abs, projectRoot);
      if (existsNow) return true;
    }
    return false;
  }

  _dedupeLeadingExtendsLines(scriptContent = "") {
    const source = safeString(scriptContent);
    if (!source) return { changed: false, content: source };
    const eol = source.includes("\r\n") ? "\r\n" : "\n";
    const lines = source.split(/\r?\n/);
    const isMeaningful = (line) => {
      const trimmed = safeString(line).trim();
      if (!trimmed) return false;
      if (trimmed.startsWith("#")) return false;
      return true;
    };
    const meaningful = [];
    for (let i = 0; i < lines.length; i += 1) {
      if (!isMeaningful(lines[i])) continue;
      meaningful.push(i);
      if (meaningful.length >= 2) break;
    }
    if (meaningful.length < 2) return { changed: false, content: source };
    const [firstIdx, secondIdx] = meaningful;
    const first = safeString(lines[firstIdx]).trim();
    const second = safeString(lines[secondIdx]).trim();
    const firstExtends = /^extends\b/i.test(first);
    const secondExtends = /^extends\b/i.test(second);
    if (!firstExtends || !secondExtends) return { changed: false, content: source };
    const norm = (line) => safeString(line).trim().toLowerCase().replace(/\s+/g, " ");
    const firstNorm = norm(first);
    const secondNorm = norm(second);
    const shouldDropFirst = firstNorm === secondNorm || firstNorm === "extends node";
    if (!shouldDropFirst) return { changed: false, content: source };
    lines.splice(firstIdx, 1);
    const trailingEol = source.endsWith("\r\n") || source.endsWith("\n");
    const collapsed = lines.join(eol);
    return { changed: true, content: trailingEol ? `${collapsed}${eol}` : collapsed };
  }

  async _normalizeCreatedGdscriptHeaders({ toolName, args = {}, rawResult = null, workflowState = null } = {}) {
    if (!this._expectsArtifactCreation({ toolName, workflowState })) return;
    const projectRoot = this._resolveProjectRootForVerification(args);
    if (!projectRoot) return;
    const candidates = this._collectVerifiableArtifactCandidates({ args, rawResult, projectRoot })
      .filter((absPath) => isGdScriptArtifactCandidate(absPath));
    if (candidates.length < 1) return;
    for (const absPath of candidates) {
      const exists = await this._pathExistsViaIndexOrFs(absPath, projectRoot);
      if (!exists) continue;
      let text = "";
      try {
        text = await fs.readFile(absPath, "utf8");
      } catch {
        continue;
      }
      const normalized = this._dedupeLeadingExtendsLines(text);
      if (!normalized.changed) continue;
      try {
        await fs.writeFile(absPath, normalized.content, "utf8");
      } catch {
        // best-effort normalization only
      }
    }
  }

  _pickNodePropertiesReadTool(inventory) {
    const tools = inventory && typeof inventory.getInventory === "function"
      ? (Array.isArray(inventory.getInventory()?.tools) ? inventory.getInventory().tools : [])
      : [];
    const canonical = tools.find((t) => {
      const k = normalizeKey(t?.name);
      return k === "getnodeproperties" || k === "nodegetproperties";
    });
    if (canonical) return canonical;
    return tools.find((t) => {
      const k = normalizeKey(t?.name);
      return k.includes("node") && k.includes("propert") && (k.includes("get") || k.includes("read") || k.includes("fetch"));
    }) || null;
  }

  _isAttachLikeMutation({ toolName = "", args = {} } = {}) {
    return looksAttachToolName(toolName) || hasScriptPropertyHint(args);
  }

  _isMutationLikeCall({ toolName = "", args = {} } = {}) {
    const a = toArgs(args);
    if (this._isAttachLikeMutation({ toolName, args: a })) return true;
    if (isLikelyMutationToolName(toolName)) return true;
    const hasPropertyPayload =
      isPlainObject(a.properties) ||
      isPlainObject(a.propertyMap) ||
      isPlainObject(a.props) ||
      typeof a.properties === "string" ||
      typeof a.propertyMap === "string" ||
      typeof a.props === "string";
    return hasPropertyPayload;
  }

  _collectDomainTokensFromArgs(args = {}) {
    const a = toArgs(args);
    const out = new Set();
    const add = (k) => {
      const nk = normalizeKey(k);
      if (!nk) return;
      if (nk.includes("scene")) out.add("scene");
      if (nk.includes("node") || nk.includes("parent")) out.add("node");
      if (nk.includes("script")) out.add("script");
      if (nk.includes("resource")) out.add("resource");
      if (nk.includes("file")) out.add("file");
      if (nk.includes("property") || nk.includes("props")) out.add("property");
      if (nk.includes("setting")) out.add("setting");
      if (nk.includes("input")) out.add("input");
      if (nk.includes("project")) out.add("project");
      if (nk === "path" || nk.endsWith("path")) out.add("path");
    };
    for (const key of Object.keys(a)) add(key);
    return out;
  }

  _scoreReadToolCandidate({ mutationToolName = "", mutationArgs = {}, readTool = null } = {}) {
    if (!isPlainObject(readTool)) return -1;
    const name = safeString(readTool.name).trim();
    if (!name || !isLikelyReadOnlyToolName(name)) return -1;
    const mutationTokens = new Set([
      ...tokenizeIdentity(mutationToolName),
      ...this._collectDomainTokensFromArgs(mutationArgs),
    ]);
    const readTokens = new Set(tokenizeIdentity(name));
    const schema = extractInputSchema(readTool);
    const keys = [
      ...(Array.isArray(schema.required) ? schema.required : []),
      ...(isPlainObject(schema.properties) ? Object.keys(schema.properties) : []),
    ];
    for (const k of keys) readTokens.add(normalizeKey(k));
    let score = 0;
    for (const token of mutationTokens) {
      if (readTokens.has(token)) score += 2;
      if ([...readTokens].some((t) => safeString(t).includes(token))) score += 1;
    }
    if (readTokens.has("scene") && mutationTokens.has("scene")) score += 2;
    if (readTokens.has("node") && mutationTokens.has("node")) score += 2;
    if (readTokens.has("setting") && mutationTokens.has("setting")) score += 2;
    const hasPropertyPayload =
      isPlainObject(mutationArgs?.properties) ||
      isPlainObject(mutationArgs?.propertyMap) ||
      isPlainObject(mutationArgs?.props) ||
      typeof mutationArgs?.properties === "string" ||
      typeof mutationArgs?.propertyMap === "string" ||
      typeof mutationArgs?.props === "string";
    if (hasPropertyPayload) {
      const hasPropertyReadShape =
        readTokens.has("property") ||
        readTokens.has("properties") ||
        [...readTokens].some((t) => safeString(t).includes("propert"));
      if (hasPropertyReadShape) score += 5;
      else score -= 2;
    }
    if (name === mutationToolName) score = -1;
    return score;
  }

  _pickGenericReadbackTool({ mutationToolName = "", mutationArgs = {}, inventory = null } = {}) {
    const tools = inventory && typeof inventory.getInventory === "function"
      ? (Array.isArray(inventory.getInventory()?.tools) ? inventory.getInventory().tools : [])
      : [];
    let best = null;
    let bestScore = -1;
    for (const tool of tools) {
      const score = this._scoreReadToolCandidate({
        mutationToolName,
        mutationArgs,
        readTool: tool,
      });
      if (score > bestScore) {
        bestScore = score;
        best = tool;
      }
    }
    return bestScore > 1 ? best : null;
  }

  _planGenericReadback({ toolName = "", mutationArgs = {}, inventory = null } = {}) {
    if (!this._isMutationLikeCall({ toolName, args: mutationArgs })) {
      return { enabled: false, reason: "not_mutation_like" };
    }
    if (this._isAttachLikeMutation({ toolName, args: mutationArgs })) {
      return { enabled: false, reason: "attach_like_has_dedicated_verifier" };
    }
    const readTool = this._pickGenericReadbackTool({
      mutationToolName: toolName,
      mutationArgs,
      inventory,
    });
    if (!readTool) return { enabled: false, reason: "no_readback_tool" };
    const readArgs = this._buildGenericReadbackArgs({
      readTool,
      mutationArgs,
    });
    if (!isPlainObject(readArgs) || Object.keys(readArgs).length < 1) {
      return { enabled: false, reason: "readback_args_unavailable" };
    }
    return { enabled: true, readTool, readArgs };
  }

  async _runGenericReadback({ client, readTool, readArgs, phase = "post" } = {}) {
    let verifyRaw = null;
    try {
      verifyRaw = await this._callTool(client, {
        toolName: readTool.name,
        args: readArgs,
        payload: this.buildPayload({ toolName: readTool.name, args: readArgs }),
      });
    } catch (err) {
      return {
        ok: false,
        reason: `${phase === "pre" ? "Pre-mutation" : "Post-mutation"} read-back failed (${safeString(err?.message ?? err).trim() || "unknown error"}).`,
        raw: null,
      };
    }
    if (!isRawResultOk(verifyRaw)) {
      return {
        ok: false,
        reason: `${phase === "pre" ? "Pre-mutation" : "Post-mutation"} read-back tool failed (${this.extractFailureText(verifyRaw)}).`,
        raw: verifyRaw,
      };
    }
    return { ok: true, reason: null, raw: verifyRaw };
  }

  _pickValueForReadArg({ requiredKey = "", mutationArgs = {} } = {}) {
    const rk = normalizeKey(requiredKey);
    const a = toArgs(mutationArgs);
    const groups = [
      ["scenePath", "scene_path", "sceneRef", "scene", "path"],
      ["nodePath", "targetNodePath", "targetNode", "nodeRef", "targetNodeRef", "parentPath"],
      ["scriptPath", "scriptRef", "filePath", "fileRef", "resourcePath", "resourceRef", "artifactRef", "path"],
      ["propertyName", "property", "key", "name"],
      ["projectPath", "project_path", "projectRoot", "project_root"],
      ["settingPath", "settingRef", "setting", "key", "path"],
      ["inputMap", "inputAction", "inputName", "name", "key"],
    ];
    const byCategory = (candidates) => {
      for (const k of candidates) {
        const v = safeString(a[k]).trim();
        if (v) return v;
      }
      return null;
    };
    if (rk.includes("scene")) return byCategory(groups[0]);
    if (rk.includes("node") || rk.includes("parent")) return byCategory(groups[1]);
    if (rk.includes("script") || rk.includes("file") || rk.includes("resource") || rk.includes("artifact")) return byCategory(groups[2]);
    if (rk.includes("property")) return byCategory(groups[3]);
    if (rk.includes("project")) return byCategory(groups[4]);
    if (rk.includes("setting")) return byCategory(groups[5]);
    if (rk.includes("input")) return byCategory(groups[6]);
    if (rk === "path" || rk.endsWith("path")) return byCategory([...groups[0], ...groups[1], ...groups[2]]);
    return byCategory([...groups[0], ...groups[1], ...groups[2], ...groups[3], ...groups[5], ...groups[6]]);
  }

  _buildGenericReadbackArgs({ readTool = null, mutationArgs = {} } = {}) {
    const schema = extractInputSchema(readTool);
    const required = normalizeRequired(schema);
    if (required.length < 1) return null;
    const out = {};
    for (const key of required) {
      const value = this._pickValueForReadArg({ requiredKey: key, mutationArgs });
      if (!safeString(value).trim()) return null;
      out[key] = value;
    }
    const projectPath = this._pickValueForReadArg({ requiredKey: "projectPath", mutationArgs });
    if (safeString(projectPath).trim()) {
      out.projectPath = safeString(projectPath).trim();
      out.project_path = safeString(projectPath).trim();
    }
    return out;
  }

  _hasExpectedMutationEvidence({ mutationArgs = {}, verifyRaw = null } = {}) {
    const a = toArgs(mutationArgs);
    const payloads = parseJsonLikeContentBlocks(verifyRaw);
    const propertyPayload =
      parsePropertyContainer(a.properties) ||
      parsePropertyContainer(a.propertyMap) ||
      parsePropertyContainer(a.props) ||
      null;
    if (!propertyPayload) return true;
    const expectedKeys = Object.keys(propertyPayload)
      .map((k) => safeString(k).trim())
      .filter(Boolean);
    if (expectedKeys.length < 1) return true;
    const haystacks = [];
    for (const p of payloads) {
      haystacks.push(JSON.stringify(p));
      if (isPlainObject(p.properties)) haystacks.push(JSON.stringify(p.properties));
      if (isPlainObject(p.node_properties)) haystacks.push(JSON.stringify(p.node_properties));
    }
    const merged = haystacks.join("\n").toLowerCase();
    if (!merged) return false;
    const expectedRoots = [...new Set(expectedKeys
      .map((k) => safeString(k).trim().toLowerCase())
      .map((k) => k.split("/")[0])
      .filter(Boolean))];
    if (expectedRoots.length < 1) return true;
    return expectedRoots.some((k) => merged.includes(k));
  }

  async _verifyMutationViaReadback({
    toolName,
    args,
    rawResult,
    client,
    inventory,
    workflowState,
    plannedReadback = null,
    preReadback = null,
  }) {
    if (!this._isMutationLikeCall({ toolName, args })) return { ok: true };
    if (this._isAttachLikeMutation({ toolName, args })) return { ok: true };
    if (!isRawResultOk(rawResult)) return { ok: true };
    const plan = isPlainObject(plannedReadback)
      ? plannedReadback
      : this._planGenericReadback({ toolName, mutationArgs: args, inventory });
    if (!plan?.enabled) return { ok: true };
    const pre = isPlainObject(preReadback) ? preReadback : { ok: true, raw: null };
    if (!pre.ok) return { ok: false, reason: pre.reason || "Pre-mutation read-back failed." };
    const post = await this._runGenericReadback({
      client,
      readTool: plan.readTool,
      readArgs: plan.readArgs,
      phase: "post",
    });
    if (!post.ok) return { ok: false, reason: post.reason || "Post-mutation read-back failed." };
    const evidenceOk = this._hasExpectedMutationEvidence({
      mutationArgs: args,
      verifyRaw: post.raw,
    });
    if (!evidenceOk) {
      return {
        ok: false,
        reason: "Post-mutation read-back did not contain expected target/property evidence.",
      };
    }
    return {
      ok: true,
      readTool: safeString(plan?.readTool?.name).trim() || null,
      readArgs: isPlainObject(plan?.readArgs) ? plan.readArgs : null,
    };
  }

  _buildNodePropertiesReadArgs({ tool, sceneTarget, nodeTarget, args }) {
    const schema = isPlainObject(tool?.inputSchema) ? tool.inputSchema : {};
    const keys = [
      ...(Array.isArray(schema.required) ? schema.required : []),
      ...(isPlainObject(schema.properties) ? Object.keys(schema.properties) : []),
    ];
    const out = {
      scenePath: sceneTarget,
      scene_path: sceneTarget,
      nodePath: nodeTarget,
      node_path: nodeTarget,
      path: nodeTarget,
    };
    const pp = safeString(args?.projectPath).trim();
    if (pp) {
      out.projectPath = pp;
      out.project_path = pp;
      out.projectRoot = pp;
      out.project_root = pp;
    }
    const sceneKey = keys.find((k) => normalizeKey(k).includes("scene"));
    const nodeKey = keys.find((k) => normalizeKey(k).includes("node"));
    if (sceneKey) out[sceneKey] = sceneTarget;
    if (nodeKey) out[nodeKey] = nodeTarget;
    return out;
  }

  _extractAttachedScriptPathFromReadResult(rawResult) {
    const payloads = [];
    if (isPlainObject(rawResult)) payloads.push(rawResult);
    if (Array.isArray(rawResult?.content)) {
      for (const block of rawResult.content) {
        const text = safeString(block?.text).trim();
        if (!text) continue;
        try {
          const parsed = JSON.parse(text);
          if (isPlainObject(parsed)) payloads.push(parsed);
        } catch {
          // ignore non-json
        }
      }
    }
    for (const item of payloads) {
      const props =
        (isPlainObject(item?.properties) && item.properties) ||
        (isPlainObject(item?.node_properties) && item.node_properties) ||
        null;
      const directScript = props?.script ?? item?.script ?? null;
      if (!directScript) continue;
      if (typeof directScript === "string") return directScript;
      if (isPlainObject(directScript)) {
        const p = pickFirstText([directScript.path, directScript.resource_path, directScript.value]);
        if (p) return p;
      }
    }
    return null;
  }

  async _updateProjectIndexAfterMutation({ toolName, args, rawResult } = {}) {
    const fi = this._fileIndex;
    if (!fi || typeof fi.addOrUpdateRelativePath !== "function") return;
    const key = safeString(toolName).toLowerCase();
    const looksMutation =
      key.includes("create") ||
      key.includes("new") ||
      key.includes("add") ||
      key.includes("save") ||
      key.includes("write");
    if (!looksMutation) return;

    // Generic post-mutation index update: collect path-like outputs + input path args.
    const candidates = new Set();
    for (const p of collectPathLikeStrings(args)) candidates.add(p);
    for (const p of collectPathLikeStrings(rawResult)) candidates.add(p);

    for (const rel of candidates) {
      const res = await fi.addOrUpdateRelativePath(rel);
      if (this._debug && res?.ok) {
        // eslint-disable-next-line no-console
        console.log("[GenericMCP][Executor][DEBUG] index upsert", { path: rel });
      }
    }
  }
}
