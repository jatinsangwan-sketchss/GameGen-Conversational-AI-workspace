/**
 * stdio-mcp-client
 * -----------------------------------------------------------------------------
 * Pure MCP **transport** for the isolated Generic MCP workspace: JSON-RPC over
 * process stdio. This file is a **fresh** implementation. The legacy
 * `GoPeakSessionManager` / `GodotExecutor` `GodotMcpStdioClient` code was used
 * **only as reference** to understand the handshake; nothing from the old
 * factory pipeline is imported or copied verbatim.
 *
 * Framing (critical):
 * Real Godot/MCP stdio servers in this repo follow the MCP SDK pattern:
 * **newline-delimited JSON** (one JSON-RPC message per line, UTF-8, `\n`).
 * They do **not** use HTTP-style `Content-Length: ...\r\n\r\n` bodies on stdio.
 * Using the wrong framing causes the client to never parse responses, so
 * `initialize` appears to time out even when the editor shows MCP connected.
 *
 * Handshake sequence (MCP):
 * 1. Client sends `initialize` with `protocolVersion`, `capabilities`, `clientInfo`.
 *    The server replies with its capabilities and `serverInfo` in the **result**
 *    (do not put `serverInfo` in the client `initialize` request — that is invalid).
 * 2. Client sends notification `notifications/initialized` (typically
 *    `params: { initialized: true }`).
 * 3. After that, normal `tools/list`, `tools/call`, etc.
 *
 * Bridge readiness (`probeBridge`) is an **adapter capability**: SessionManager
 * calls it generically. For Godot MCP stdio, the authoritative signal is **log-
 * derived** (stderr/stdout lines such as “editor connected” and `Godot ready:
 * <path>`), matching what the server actually emits. The `get-project-health`
 * tool may disagree or lag; using it as primary caused false negatives when the
 * editor was already connected. Optional health-tool calls are diagnostics only
 * (see `mcpConfig.bridgeHealthDiagnostics`).
 *
 * Exposed surface (generic, no tool semantics):
 * - request({ method, params })
 * - listTools / toolsList / callTool / toolsCall
 * - probeBridge({ desiredProjectRoot }) — optional adapter readiness probe
 * - disconnect()
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** Granular transport phases for diagnostics (session layer may map these). */
export const STDIO_PHASE = {
  PROCESS_SPAWN: "process_spawn",
  TRANSPORT_READY: "transport_ready",
  INITIALIZE_REQUEST_SENT: "initialize_request_sent",
  INITIALIZE_RESPONSE_RECEIVED: "initialize_response_received",
  INITIALIZED_NOTIFICATION_SENT: "initialized_notification_sent",
};

function safeString(value) {
  return value == null ? "" : String(value);
}

/**
 * Resolve to an absolute path, then `realpathSync` so symlinks and relative
 * CLI args match the server’s canonical project root.
 */
function normalizeToRealPath(input, cwd = process.cwd()) {
  if (input == null) return null;
  const s = safeString(input).trim();
  if (!s) return null;
  let resolved;
  try {
    resolved = path.isAbsolute(s) ? path.normalize(s) : path.resolve(cwd, s);
  } catch {
    return null;
  }
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function isPlainObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function sleep(ms) {
  const n = Number(ms);
  return new Promise((resolve) => setTimeout(resolve, Number.isFinite(n) && n > 0 ? n : 0));
}

function summarizeInitializeParams(params) {
  if (!isPlainObject(params)) return {};
  return {
    protocolVersion: params.protocolVersion,
    clientInfo: params.clientInfo,
    capabilitiesKeys: params.capabilities && isPlainObject(params.capabilities) ? Object.keys(params.capabilities) : [],
  };
}

function summarizeInitializeResponse(result) {
  if (result == null) return { type: "null" };
  if (!isPlainObject(result)) return { type: typeof result };
  return {
    protocolVersion: result.protocolVersion,
    serverInfo: result.serverInfo,
    capabilitiesKeys: result.capabilities && isPlainObject(result.capabilities) ? Object.keys(result.capabilities) : [],
  };
}

function attachPhase(err, phase) {
  const e = err instanceof Error ? err : new Error(safeString(err));
  e.phase = phase;
  return e;
}

function truncateJson(s, max = 600) {
  const t = safeString(s);
  return t.length <= max ? t : `${t.slice(0, max)}…`;
}

function jsonRpcErrorToError(err) {
  if (err instanceof Error) return err;
  if (isPlainObject(err) && err.message != null) {
    const e = new Error(safeString(err.message));
    e.code = err.code;
    e.data = err.data;
    return e;
  }
  return new Error(safeString(JSON.stringify(err)));
}

/* -------------------------------------------------------------------------- */
/* Bridge probe helpers (pattern informed by legacy GoPeak behavior; fresh code) */
/* -------------------------------------------------------------------------- */

function findKeyDeep(obj, key, depth = 0) {
  if (depth > 24) return undefined;
  if (!isPlainObject(obj) && !Array.isArray(obj)) return undefined;
  if (isPlainObject(obj) && Object.prototype.hasOwnProperty.call(obj, key)) return obj[key];
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const found = findKeyDeep(item, key, depth + 1);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  for (const value of Object.values(obj)) {
    const found = findKeyDeep(value, key, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

function pickStringDeep(obj, keys) {
  for (const key of keys) {
    const val = findKeyDeep(obj, key);
    if (val == null) continue;
    const s = String(val).trim();
    if (s) return s;
  }
  return null;
}

function pickBooleanDeep(obj, keys) {
  for (const key of keys) {
    const val = findKeyDeep(obj, key);
    if (typeof val === "boolean") return val;
    if (typeof val === "string") {
      const s = val.trim().toLowerCase();
      if (["1", "true", "yes", "on"].includes(s)) return true;
      if (["0", "false", "no", "off"].includes(s)) return false;
    }
  }
  return null;
}

/**
 * Prefer health / project validation tool names (same preference order as historical GoPeak).
 */
function pickBridgeProbeToolName(toolNames) {
  const names = Array.isArray(toolNames) ? toolNames.map((n) => String(n)) : [];
  const preferred = [
    /^get[-_]?project[-_]?health$/i,
    /^validate[-_]?project$/i,
    /project.*health/i,
    /health/i,
  ];
  for (const re of preferred) {
    const m = names.find((n) => re.test(n));
    if (m) return m;
  }
  return null;
}

function extractToolsArray(toolsList) {
  if (!toolsList) return [];
  const top = isPlainObject(toolsList) ? toolsList : {};
  const candidates = [
    top.tools,
    top.items,
    top.data?.tools,
    top.result?.tools,
  ];
  for (const c of candidates) {
    if (Array.isArray(c)) return c;
  }
  return [];
}

function extractNextCursorPage(toolsList) {
  if (!toolsList || typeof toolsList !== "object") return null;
  const candidates = [
    toolsList.nextCursor,
    toolsList.next_cursor,
    toolsList.cursor,
    toolsList.pagination?.nextCursor,
    toolsList.pagination?.next_cursor,
  ];
  for (const c of candidates) {
    const s = safeString(c).trim();
    if (s) return s;
  }
  return null;
}

/**
 * Normalize tools/call result into a plain object for field extraction.
 */
function toolCallResultToStructuredObject(result) {
  if (result == null) return {};
  if (isPlainObject(result) && !Array.isArray(result.content)) {
    return result;
  }
  const content = result?.content;
  if (Array.isArray(content)) {
    const texts = content.filter((c) => c?.type === "text" && c.text).map((c) => safeString(c.text));
    for (const t of texts) {
      try {
        const j = JSON.parse(t);
        if (isPlainObject(j)) return j;
      } catch {
        // not JSON; fall through
      }
    }
    if (texts.length) return { _text: texts.join("\n") };
  }
  return isPlainObject(result) ? result : { _value: result };
}

function interpretBridgeToolPayload(raw, expectedAbs) {
  const flattened = safeString(JSON.stringify(raw ?? {})).toLowerCase();
  let explicitConnected = pickBooleanDeep(raw, [
    "connected",
    "is_connected",
    "isConnected",
    "editor_connected",
    "editorConnected",
    "bridge_ready",
    "bridgeReady",
  ]);
  if (explicitConnected == null && isPlainObject(raw)) {
    if (raw.ok === true) explicitConnected = true;
    else if (raw.success === true) explicitConnected = true;
  }
  const disconnectedHint =
    flattened.includes("not connected") ||
    flattened.includes("editor is not connected") ||
    flattened.includes("bridge not ready");
  const connectedHint =
    flattened.includes("connected") ||
    flattened.includes("bridge ready") ||
    flattened.includes('"ok":true');
  const isBridgeReady =
    explicitConnected != null ? explicitConnected : disconnectedHint ? false : connectedHint;

  const connectedPathRaw = pickStringDeep(raw, [
    "project_path",
    "projectPath",
    "project_root",
    "projectRoot",
    "path",
  ]);
  const cwd = typeof process !== "undefined" ? process.cwd() : ".";
  const connectedAbs = connectedPathRaw ? normalizeToRealPath(connectedPathRaw, cwd) : null;

  const projectMatches =
    expectedAbs == null ? true : connectedAbs != null && connectedAbs === expectedAbs;

  let error = null;
  if (!isBridgeReady) error = "Bridge/tool payload indicates editor or bridge not ready.";
  if (expectedAbs != null && !projectMatches) {
    error = error
      ? `${error} Project path mismatch.`
      : "Connected project path does not match desired root.";
  }

  return {
    bridgeReady: Boolean(isBridgeReady),
    connectedProjectPath: connectedAbs,
    connectedProjectPathRaw: connectedPathRaw,
    projectMatches: Boolean(projectMatches),
    error,
  };
}

class StdioMcpClient {
  constructor({ mcpConfig }) {
    const cfg = isPlainObject(mcpConfig) ? mcpConfig : {};
    this._mcpConfig = cfg;
    const command = safeString(cfg.command).trim();
    const args = Array.isArray(cfg.args) ? cfg.args.map((a) => String(a)) : [];
    if (!command) throw new Error("mcpConfig.command is required.");

    this._command = command;
    this._args = args;
    this._env = isPlainObject(cfg.env) ? { ...process.env, ...cfg.env } : process.env;
    this._cwd = safeString(cfg.workingDirectory || cfg.cwd || "").trim() || process.cwd();
    this._protocolVersion = safeString(cfg.protocolVersion).trim() || "2024-11-05";
    this._timeoutMs = Number.isFinite(Number(cfg.timeoutMs)) ? Number(cfg.timeoutMs) : 30000;
    this._clientName = safeString(cfg.clientName).trim() || "generic-mcp-cli";
    this._clientVersion = safeString(cfg.clientVersion).trim() || "0.1.0";

    const initMax = Number(cfg.initializeMaxAttempts);
    const initDelay = Number(cfg.initializeRetryDelayMs);
    this._initializeMaxAttempts = Number.isFinite(initMax) && initMax > 0 ? Math.floor(initMax) : 30;
    this._initializeRetryDelayMs = Number.isFinite(initDelay) && initDelay >= 0 ? Math.floor(initDelay) : 2000;
    this._debug = Boolean(cfg.debug);

    this._child = null;
    this._spawned = false;
    this._handshakeComplete = false;
    this._nextId = 1;
    this._pending = new Map();
    /** @type {Buffer} */
    this._buffer = Buffer.alloc(0);
    this._stderrTail = [];
    this._stderrHead = [];
    this._stdoutHeadSample = "";
    this._transportInitAttempts = 0;
    this._transportInitLastError = null;
    this._lastFailedPhase = null;
    this._lastInitializeError = null;
    this._lastTransportError = null;
    this._lastInitializeRequestId = null;
    this._lastInitializeResponseSummary = null;
    this._initializedNotificationConfirmed = false;
    /** Debug: last frame summaries */
    this._lastOutgoingNdjson = null;
    this._lastIncomingNdjson = null;

    /**
     * Godot MCP often prints bridge/editor state to stderr (and occasionally
     * non-JSON lines on stdout). This is the authoritative readiness signal for
     * live sessions — not `get-project-health`, which can report stale/incorrect
     * state for this server combination.
     */
    this._resetLogBridgeState();
  }

  _resetLogBridgeState() {
    this._logBridge = {
      editorConnected: false,
      bridgeListenerStarted: false,
      connectedProjectPathRaw: null,
      lastReadyLogLine: null,
      lastEditorLogLine: null,
      godotReadyParsed: false,
    };
  }

  /**
   * Parse Godot/bridge log lines (pattern aligned with historical GoPeak session tracking).
   */
  _trackBridgeSignalsFromLog(line, stream) {
    const text = safeString(line).trim();
    if (!text) return;
    const lower = text.toLowerCase();
    if (
      lower.includes("bridge listening") ||
      lower.includes("bridge started on 127.0.0.1:6505") ||
      lower.includes("unified http+ws bridge listening")
    ) {
      this._logBridge.bridgeListenerStarted = true;
    }
    if (
      lower.includes("editor connected") ||
      lower.includes("godot editor connected") ||
      lower.includes("connected to ws://127.0.0.1:6505")
    ) {
      this._logBridge.editorConnected = true;
      this._logBridge.lastEditorLogLine = text;
      if (this._debug) console.error("[generic-mcp] adapter: editor connected (log signal)");
    }
    const readyMatch = text.match(/godot\s+ready:\s*(.+)$/i);
    if (readyMatch && safeString(readyMatch[1]).trim()) {
      const rawPath = safeString(readyMatch[1]).trim();
      this._logBridge.connectedProjectPathRaw = rawPath;
      this._logBridge.lastReadyLogLine = text;
      this._logBridge.godotReadyParsed = true;
      if (this._debug) console.error(`[generic-mcp] adapter: Godot ready — ${rawPath}`);
    }
    if (this._debug) {
      this._debugLog(`log signal (${stream})`, { line: truncateJson(text, 300) });
    }
  }

  _phaseLog(phase, normalDetail) {
    if (!this._debug) return;
    console.error(`[generic-mcp] phase ${phase}: ${normalDetail}`);
  }

  _debugLog(label, payload) {
    if (!this._debug) return;
    console.error(`[generic-mcp][debug] ${label}:`, payload);
  }

  /**
   * Write one JSON-RPC message using MCP stdio convention: UTF-8 JSON + `\n`.
   * (Not Content-Length framing.)
   */
  _writeNdjson(obj) {
    const line = `${JSON.stringify(obj)}\n`;
    this._lastOutgoingNdjson = truncateJson(line.trim());
    if (this._debug) {
      this._debugLog("outgoing NDJSON frame", { bytes: Buffer.byteLength(line, "utf8"), summary: this._lastOutgoingNdjson });
    }
    this._child.stdin.write(line, "utf8");
  }

  async connect() {
    if (this._handshakeComplete) return;

    let lastError = null;
    for (let attempt = 1; attempt <= this._initializeMaxAttempts; attempt++) {
      try {
        this._lastFailedPhase = null;
        this._lastInitializeError = null;
        this._lastTransportError = null;
        await this._ensureChildSpawned();
        await this._initializeHandshakeOnce();
        this._handshakeComplete = true;
        this._transportInitAttempts = attempt;
        this._transportInitLastError = null;
        this._logInitProgress(attempt, this._initializeMaxAttempts, null, true);
        return;
      } catch (err) {
        lastError = err;
        this._transportInitAttempts = attempt;
        this._transportInitLastError = safeString(err?.message ?? err);
        this._lastTransportError = this._transportInitLastError;
        if (err?.phase) this._lastFailedPhase = err.phase;
        if (err?.initializeError) this._lastInitializeError = err.initializeError;
        this._logInitProgress(attempt, this._initializeMaxAttempts, err, false);
        await this._resetTransportHard();
        if (attempt >= this._initializeMaxAttempts) break;
        await sleep(this._initializeRetryDelayMs);
      }
    }

    const phase = this._lastFailedPhase || STDIO_PHASE.PROCESS_SPAWN;
    const msg = `MCP transport initialize failed after ${this._initializeMaxAttempts} attempts (failedPhase=${phase}). Last error: ${this._transportInitLastError || safeString(lastError?.message ?? lastError)}`;
    const wrapped = attachPhase(new Error(msg), phase);
    if (lastError) wrapped.cause = lastError;
    throw wrapped;
  }

  _logInitProgress(attempt, max, err, success) {
    if (success) {
      console.error(`[generic-mcp] MCP transport initialize succeeded (attempt ${attempt}/${max}).`);
      return;
    }
    const brief = safeString(err?.message ?? err);
    const fp = err?.phase ? ` [failedPhase=${err.phase}]` : "";
    if (this._debug) {
      const tail = this._stderrTail.length ? ` stderr: ${this._stderrTail.slice(-8).join(" | ")}` : "";
      console.error(`[generic-mcp] MCP transport initialize attempt ${attempt}/${max} failed${fp}: ${brief}${tail}`);
    } else {
      console.error(`[generic-mcp] MCP transport initialize attempt ${attempt}/${max} failed${fp}: ${brief}`);
    }
  }

  async _ensureChildSpawned() {
    if (this._child && !this._child.killed) return;

    this._phaseLog(STDIO_PHASE.PROCESS_SPAWN, `command=${this._command} args=${JSON.stringify(this._args)} cwd=${this._cwd}`);
    this._debugLog("MCP process spawn", { command: this._command, args: this._args, cwd: this._cwd });

    this._spawned = false;
    this._stderrHead = [];
    this._stdoutHeadSample = "";
    this._buffer = Buffer.alloc(0);
    this._resetLogBridgeState();
    this._child = spawn(this._command, this._args, {
      cwd: this._cwd,
      env: this._env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    this._child.stdout.on("data", (chunk) => this._onStdout(chunk));
    this._child.stderr.on("data", (chunk) => this._onStderr(chunk));
    this._child.on("exit", (code) => {
      this._spawned = false;
      for (const [, pending] of this._pending.entries()) {
        pending.reject(
          attachPhase(
            new Error(`MCP process exited (${code ?? "unknown"}). ${this._stderrTail.join("\n")}`),
            STDIO_PHASE.TRANSPORT_READY
          )
        );
      }
      this._pending.clear();
    });
    this._spawned = true;
    this._phaseLog(STDIO_PHASE.TRANSPORT_READY, "stdio pipes open (NDJSON framing)");
  }

  async _resetTransportHard() {
    this._handshakeComplete = false;
    this._spawned = false;
    if (this._child) {
      try {
        if (this._child.stdin && !this._child.stdin.destroyed) this._child.stdin.end();
      } catch {
        // best effort
      }
      try {
        this._child.kill();
      } catch {
        // best effort
      }
    }
    this._child = null;
    for (const [, pending] of this._pending.entries()) {
      pending.reject(attachPhase(new Error("MCP transport disconnected."), STDIO_PHASE.TRANSPORT_READY));
    }
    this._pending.clear();
    this._buffer = Buffer.alloc(0);
    this._resetLogBridgeState();
  }

  _onStdout(chunk) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(safeString(chunk), "utf8");
    if (this._debug && this._stdoutHeadSample.length < 2048) {
      this._stdoutHeadSample += buf.toString("utf8");
      if (this._stdoutHeadSample.length > 2048) this._stdoutHeadSample = this._stdoutHeadSample.slice(0, 2048);
    }

    this._buffer = Buffer.concat([this._buffer, buf]);
    while (true) {
      const nl = this._buffer.indexOf(10);
      if (nl === -1) break;
      const lineBuf = this._buffer.subarray(0, nl);
      this._buffer = this._buffer.subarray(nl + 1);
      const line = lineBuf.toString("utf8").trim();
      if (!line) continue;

      this._lastIncomingNdjson = truncateJson(line);
      if (this._debug) {
        this._debugLog("incoming NDJSON frame", { summary: this._lastIncomingNdjson });
      }

      let msg = null;
      try {
        msg = JSON.parse(line);
      } catch (parseErr) {
        this._trackBridgeSignalsFromLog(line, "stdout");
        this._debugLog("JSON parse failed (non-RPC line?)", { line: truncateJson(line, 200), error: safeString(parseErr?.message) });
        continue;
      }
      if (!isPlainObject(msg)) continue;
      this._dispatchMessage(msg);
    }
  }

  _dispatchMessage(msg) {
    if (msg.id != null && (msg.result !== undefined || msg.error !== undefined)) {
      const pending = this._pending.get(msg.id);
      if (!pending) {
        if (this._debug) {
          this._debugLog("unmatched JSON-RPC response id (no pending request)", { id: msg.id });
        }
        return;
      }
      this._pending.delete(msg.id);
      if (msg.error !== undefined && msg.error !== null) {
        pending.reject(jsonRpcErrorToError(msg.error));
      } else {
        pending.resolve(msg.result);
      }
      return;
    }
    // Notifications / requests from server — ignored by this minimal client.
  }

  _onStderr(chunk) {
    const text = safeString(chunk?.toString?.("utf8") ?? chunk);
    if (!text) return;
    const lines = text.split(/\r?\n/).filter(Boolean);
    this._stderrTail.push(...lines);
    if (this._stderrTail.length > 40) {
      this._stderrTail = this._stderrTail.slice(this._stderrTail.length - 40);
    }
    for (const line of lines) {
      this._trackBridgeSignalsFromLog(line, "stderr");
      if (this._stderrHead.length < 8) this._stderrHead.push(line);
    }
  }

  _enqueueRequest(payload) {
    const id = payload.id;
    const method = safeString(payload.method).trim();
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(
          attachPhase(
            new Error(`MCP request timeout (${this._timeoutMs}ms) for method ${method} jsonrpc id=${id}`),
            method === "initialize" ? STDIO_PHASE.INITIALIZE_RESPONSE_RECEIVED : "jsonrpc_timeout"
          )
        );
      }, this._timeoutMs);
      this._pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
        method,
      });
    });
    this._writeNdjson(payload);
    return promise;
  }

  async request({ method, params = {} }) {
    if (!this._handshakeComplete && !this._spawned) await this.connect();
    const id = this._nextId++;
    const payload = {
      jsonrpc: "2.0",
      id,
      method: safeString(method).trim(),
      params: isPlainObject(params) ? params : {},
    };
    return this._enqueueRequest(payload);
  }

  /**
   * tools/list — params compatible with common MCP servers (flat cursor, optional limit).
   * Reference transport used `{ cursor }` for pagination, not only nested `pagination`.
   */
  async listTools({ cursor = null, limit = null, pageSize = null } = {}) {
    const effectiveLimit = limit ?? pageSize ?? null;
    const params = {};
    if (cursor != null) params.cursor = cursor;
    if (effectiveLimit != null) params.limit = Number(effectiveLimit);
    return this.request({
      method: "tools/list",
      params,
    });
  }

  async toolsList(opts) {
    return this.listTools(opts);
  }

  async callTool(name, args = {}) {
    return this.request({
      method: "tools/call",
      params: {
        name: safeString(name).trim(),
        arguments: isPlainObject(args) ? args : {},
      },
    });
  }

  async toolsCall({ name, arguments: args = {} } = {}) {
    return this.callTool(name, args);
  }

  /**
   * Bridge readiness: **log-derived first** (stderr/stdout), then canonical path
   * comparison. Optional `get-project-health`-style tool is diagnostics-only
   * (`mcpConfig.bridgeHealthDiagnostics`), not authoritative.
   */
  async probeBridge({ desiredProjectRoot = null } = {}) {
    const cwd = this._cwd;
    const rawDesired = desiredProjectRoot != null ? safeString(desiredProjectRoot).trim() : null;
    const desiredReal = rawDesired ? normalizeToRealPath(rawDesired, cwd) : null;

    const lb = this._logBridge;
    const bridgeReady = Boolean(lb.editorConnected || lb.godotReadyParsed);

    const rawConnected = lb.connectedProjectPathRaw;
    const connectedReal = rawConnected ? normalizeToRealPath(rawConnected, cwd) : null;

    const projectMatches =
      desiredReal == null ? true : connectedReal != null && connectedReal === desiredReal;

    if (this._debug) {
      this._debugLog("bridge path normalization", {
        rawRequestedProjectRoot: rawDesired,
        normalizedRequestedProjectRoot: desiredReal,
        rawConnectedProjectPath: rawConnected,
        normalizedConnectedProjectPath: connectedReal,
        pathEquality: desiredReal == null || connectedReal === desiredReal,
      });
    }

    let healthDiagnostics = null;
    if (this._mcpConfig.bridgeHealthDiagnostics === true) {
      try {
        const toolNames = await this._collectAllToolNames();
        const probeTool = pickBridgeProbeToolName(toolNames);
        if (probeTool) {
          const args = {};
          if (desiredReal) {
            args.project_path = desiredReal;
            args.projectPath = desiredReal;
            args.project_root = desiredReal;
          }
          const callResult = await this.callTool(probeTool, args);
          const parsed = toolCallResultToStructuredObject(callResult);
          healthDiagnostics = {
            probeTool,
            toolResult: callResult,
            interpreted: interpretBridgeToolPayload(parsed, desiredReal),
          };
        } else {
          healthDiagnostics = { skipped: true, reason: "no health-like tool in catalog" };
        }
      } catch (e) {
        healthDiagnostics = { error: safeString(e?.message ?? e) };
      }
    }

    const ok = bridgeReady && projectMatches;
    let error = null;
    if (!bridgeReady) error = "Bridge not ready: no editor-connected / Godot-ready log lines observed yet.";
    else if (desiredReal != null && !projectMatches) {
      error = "Project path mismatch (canonical real paths differ).";
    }

    if (this._debug) {
      console.error(
        `[generic-mcp] adapter: bridge probe — log bridgeReady=${bridgeReady} projectMatch=${projectMatches ? "ok" : "failed"}`
      );
    }

    return {
      ok,
      bridgeReady,
      connectedProjectPath: connectedReal,
      connectedProjectPathRaw: rawConnected,
      projectMatches,
      connected: bridgeReady,
      error: ok ? null : error,
      primarySource: "log",
      raw: {
        logBridge: { ...lb },
        healthDiagnostics,
      },
      probeTool: healthDiagnostics?.probeTool ?? null,
    };
  }

  async _collectAllToolNames() {
    const seenNames = new Set();
    const names = [];
    let cursor = null;
    const seenCursors = new Set();
    for (let page = 0; page < 64; page++) {
      const res = await this.listTools({ cursor, limit: 200, pageSize: 200 });
      const tools = extractToolsArray(res);
      for (const t of tools) {
        const n = safeString(t?.name).trim();
        if (n && !seenNames.has(n)) {
          seenNames.add(n);
          names.push(n);
        }
      }
      const next = extractNextCursorPage(res);
      if (!next || seenCursors.has(next)) break;
      seenCursors.add(next);
      cursor = next;
    }
    return names;
  }

  getTransportPhaseMeta() {
    return {
      attempts: this._transportInitAttempts,
      lastError: this._transportInitLastError,
      failedPhase: this._lastFailedPhase,
      lastTransportError: this._lastTransportError,
      lastInitializeError: this._lastInitializeError,
      lastInitializeRequestId: this._lastInitializeRequestId,
      lastInitializeResponseSummary: this._lastInitializeResponseSummary,
      initializedNotificationSent: this._initializedNotificationConfirmed,
      stderrHeadLines: [...this._stderrHead],
      stdoutHeadSample: this._stdoutHeadSample.slice(0, 2048),
      spawnCommand: this._command,
      spawnArgs: [...this._args],
      spawnCwd: this._cwd,
      framing: "ndjson",
      lastOutgoingNdjson: this._lastOutgoingNdjson,
      lastIncomingNdjson: this._lastIncomingNdjson,
      logDerivedBridge: this._logBridge ? { ...this._logBridge } : null,
    };
  }

  async disconnect() {
    await this._resetTransportHard();
    this._stderrTail = [];
    this._stderrHead = [];
    this._stdoutHeadSample = "";
    this._resetLogBridgeState();
  }

  async _initializeHandshakeOnce() {
    const params = {
      protocolVersion: this._protocolVersion,
      capabilities: {
        tools: { listChanged: true },
      },
      clientInfo: {
        name: this._clientName,
        version: this._clientVersion,
      },
    };

    this._debugLog("initialize payload summary", summarizeInitializeParams(params));

    const id = this._nextId++;
    this._lastInitializeRequestId = id;
    const payload = {
      jsonrpc: "2.0",
      id,
      method: "initialize",
      params,
    };

    this._phaseLog(STDIO_PHASE.INITIALIZE_REQUEST_SENT, `jsonrpc id=${id}`);
    this._debugLog("initialize request", { id, method: "initialize" });

    let result;
    try {
      result = await this._enqueueRequest(payload);
    } catch (err) {
      const ie = safeString(err?.message ?? err);
      this._lastInitializeError = ie;
      throw attachPhase(err, err?.phase || STDIO_PHASE.INITIALIZE_RESPONSE_RECEIVED);
    }

    this._lastInitializeResponseSummary = summarizeInitializeResponse(result);
    this._phaseLog(STDIO_PHASE.INITIALIZE_RESPONSE_RECEIVED, `jsonrpc id=${id} ok`);
    this._debugLog("initialize response summary", { id, summary: this._lastInitializeResponseSummary, rawResultKeys: isPlainObject(result) ? Object.keys(result) : [] });

    try {
      const notif = {
        jsonrpc: "2.0",
        method: "notifications/initialized",
        params: { initialized: true },
      };
      this._writeNdjson(notif);
      this._initializedNotificationConfirmed = true;
      this._phaseLog(STDIO_PHASE.INITIALIZED_NOTIFICATION_SENT, "notifications/initialized written (NDJSON)");
      this._debugLog("initialized notification", { sent: true, afterRequestId: id });
      if (this._debug) {
        this._debugLog("MCP process first stderr lines", this._stderrHead.slice(0, 8));
        this._debugLog("MCP process stdout head sample", this._stdoutHeadSample.slice(0, 512));
      }
    } catch (err) {
      const ie = safeString(err?.message ?? err);
      this._lastInitializeError = ie;
      throw attachPhase(new Error(`Failed to send notifications/initialized: ${ie}`), STDIO_PHASE.INITIALIZED_NOTIFICATION_SENT);
    }
  }
}

export async function createClient({ mcpConfig }) {
  const client = new StdioMcpClient({ mcpConfig });
  await client.connect();
  return client;
}
