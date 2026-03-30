import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { GOPEAK_DISCOVERY_DEBUG } from "./GoPeakDebugFlags.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_BRIDGE_WAIT_MS = 60_000;
const DEFAULT_BRIDGE_POLL_MS = 2_000;
const BRIDGE_HOST = "127.0.0.1";
const BRIDGE_PORT = 6505;

function safeString(v) {
  return v == null ? "" : String(v);
}

function isPlainObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function normalizeProjectPath(input, cwd = process.cwd()) {
  const raw = safeString(input).trim();
  if (!raw) return null;
  return path.resolve(cwd, raw);
}

function extractToolsListEntries(toolsList) {
  const tools =
    toolsList?.tools ??
    toolsList?.data?.tools ??
    toolsList?.result?.tools ??
    toolsList?.items ??
    [];
  return Array.isArray(tools) ? tools : [];
}

function dedupeToolsByName(entries) {
  const out = [];
  const seen = new Set();
  for (const entry of Array.isArray(entries) ? entries : []) {
    const name = safeString(entry?.name).trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(entry);
  }
  return out;
}

function extractNextCursor(toolsList) {
  const candidates = [
    toolsList?.nextCursor,
    toolsList?.next_cursor,
    toolsList?.cursor,
    toolsList?.pagination?.nextCursor,
    toolsList?.pagination?.next_cursor,
    toolsList?.meta?.nextCursor,
    toolsList?.meta?.next_cursor,
    toolsList?.result?.nextCursor,
    toolsList?.result?.next_cursor,
  ];
  for (const c of candidates) {
    const s = safeString(c).trim();
    if (s) return s;
  }
  return null;
}

function normalizeToolMetadataList(toolsList) {
  const entries = extractToolsListEntries(toolsList);
  const out = [];
  for (const entry of entries) {
    const name = safeString(entry?.name).trim();
    if (!name) continue;
    out.push({
      name,
      title: entry?.title != null ? String(entry.title) : null,
      description: entry?.description != null ? String(entry.description) : null,
      tags: Array.isArray(entry?.tags) ? entry.tags.map((t) => String(t)) : [],
      input_schema: isPlainObject(entry?.input_schema)
        ? entry.input_schema
        : isPlainObject(entry?.inputSchema)
          ? entry.inputSchema
          : null,
    });
  }
  return out;
}

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

function findKeyDeep(obj, key) {
  if (!isPlainObject(obj) && !Array.isArray(obj)) return undefined;
  if (isPlainObject(obj) && Object.prototype.hasOwnProperty.call(obj, key)) return obj[key];
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const found = findKeyDeep(item, key);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  for (const value of Object.values(obj)) {
    const found = findKeyDeep(value, key);
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

function normalizeBridgeStatusFromProbe({ probe, expectedProjectRoot }) {
  const output = isPlainObject(probe?.output) ? probe.output : {};
  const raw = output?.mcp_trace?.raw_response ?? output;
  const flattened = safeString(safeJsonStringify(raw ?? {})).toLowerCase();
  const explicitConnected = pickBooleanDeep(raw, [
    "connected",
    "is_connected",
    "isConnected",
    "editor_connected",
    "bridge_ready",
  ]);
  const disconnectedHint =
    flattened.includes("not connected") ||
    flattened.includes("editor is not connected") ||
    flattened.includes("bridge not ready");
  const connectedHint =
    flattened.includes("connected") ||
    flattened.includes("bridge ready") ||
    flattened.includes("\"ok\":true");
  const isBridgeReady = explicitConnected != null ? explicitConnected : disconnectedHint ? false : connectedHint;
  const connectedPathRaw = pickStringDeep(raw, [
    "project_path",
    "projectPath",
    "project_root",
    "projectRoot",
    "path",
  ]);
  const connectedProjectPath = connectedPathRaw ? normalizeProjectPath(connectedPathRaw) : null;
  const expected = expectedProjectRoot ? normalizeProjectPath(expectedProjectRoot) : null;
  const projectMatches = expected == null ? true : connectedProjectPath != null && connectedProjectPath === expected;
  return {
    ok: Boolean(probe?.ok) && Boolean(isBridgeReady) && Boolean(projectMatches),
    isBridgeReady: Boolean(isBridgeReady),
    connectedProjectPath,
    expectedProjectPath: expected,
    projectMatches: Boolean(projectMatches),
    probeTool: probe?.output?.mcp_trace?.tool_name ?? null,
    probeError: probe?.error ?? null,
  };
}

function safeJsonStringify(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return safeString(value);
  }
}

function resolveGoPeakConfigFromFile() {
  const thisFile = fileURLToPath(import.meta.url);
  const thisDir = path.dirname(thisFile);
  const configPath = path.resolve(thisDir, "../../mcp.config.json");
  if (!fs.existsSync(configPath)) {
    throw new Error(`GoPeak session config not found: ${configPath}`);
  }
  const parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const server = parsed?.godot;
  if (!isPlainObject(server)) {
    throw new Error("Invalid mcp.config.json: missing `godot` object.");
  }
  const command = safeString(server.command).trim();
  const args = Array.isArray(server.args) ? server.args : [];
  if (!command || args.length === 0) {
    throw new Error("Invalid mcp.config.json: `godot.command` and `godot.args[]` are required.");
  }
  return {
    command,
    args,
    workingDirectory:
      server.working_directory != null && safeString(server.working_directory).trim()
        ? String(server.working_directory)
        : null,
    env: {
      ...process.env,
      ...(isPlainObject(server.env) ? server.env : {}),
      DEBUG: "false",
      GOPEAK_TOOL_PROFILE: safeString(server?.env?.GOPEAK_TOOL_PROFILE).trim() || "full",
      GOPEAK_TOOLS_PAGE_SIZE: safeString(server?.env?.GOPEAK_TOOLS_PAGE_SIZE).trim() || "200",
    },
    requestTimeoutMs:
      Number(server.request_timeout_ms ?? server.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS,
    sourceConfigPath: configPath,
  };
}

class StdioMcpClient {
  constructor({ command, args, env, workingDirectory, requestTimeoutMs, hooks = {} }) {
    this.command = command;
    this.args = Array.isArray(args) ? args : [];
    this.env = env ?? process.env;
    this.workingDirectory = workingDirectory ?? null;
    this.requestTimeoutMs = Number(requestTimeoutMs) || DEFAULT_TIMEOUT_MS;
    this._proc = null;
    this._buffer = Buffer.alloc(0);
    this._pending = new Map();
    this._nextId = 1;
    this._connected = false;
    this._initPromise = null;
    this._hooks = isPlainObject(hooks) ? hooks : {};
  }

  async ensureConnected() {
    if (this._connected) return;
    if (this._initPromise) return this._initPromise;
    this._initPromise = this._connectAndInit();
    return this._initPromise;
  }

  async _connectAndInit() {
    if (typeof this._hooks.onProcessEvent === "function") {
      this._hooks.onProcessEvent({ type: "spawn_start", command: this.command, args: this.args, cwd: this.workingDirectory });
    }
    this._proc = spawn(this.command, this.args, {
      env: this.env,
      cwd: this.workingDirectory ?? undefined,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this._proc.stdout.on("data", (chunk) => this._handleData(chunk));
    this._proc.stderr.on("data", (chunk) => this._handleStderrChunk(chunk));
    this._proc.on("exit", (code) => {
      if (typeof this._hooks.onProcessEvent === "function") {
        this._hooks.onProcessEvent({ type: "exit", code });
      }
      for (const [, pending] of this._pending.entries()) {
        pending.reject(new Error(`GoPeak MCP process exited (${code ?? "unknown"})`));
      }
      this._pending.clear();
      this._connected = false;
      this._initPromise = null;
    });

    await this._requestRaw("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: { tools: { listChanged: true } },
      clientInfo: { name: "factory-js-gopeak-session-manager", version: "0.1.0" },
    });
    this._sendNotification("notifications/initialized", { initialized: true });
    this._connected = true;
    if (typeof this._hooks.onProcessEvent === "function") {
      this._hooks.onProcessEvent({ type: "initialized" });
    }
  }

  _handleData(chunk) {
    this._buffer = Buffer.concat([this._buffer, chunk]);
    while (true) {
      const newlineIdx = this._buffer.indexOf(10);
      if (newlineIdx === -1) break;
      const lineBuf = this._buffer.slice(0, newlineIdx);
      this._buffer = this._buffer.slice(newlineIdx + 1);
      const line = lineBuf.toString("utf8").trim();
      if (!line) continue;
      let msg = null;
      try {
        msg = JSON.parse(line);
      } catch {
        msg = null;
      }
      if (!msg) {
        if (typeof this._hooks.onStdoutLine === "function") {
          this._hooks.onStdoutLine({ line, isJsonRpc: false });
        }
        continue;
      }
      if (typeof this._hooks.onStdoutLine === "function") {
        this._hooks.onStdoutLine({ line, isJsonRpc: true });
      }
      if (msg.id != null && (msg.result != null || msg.error != null)) {
        const pending = this._pending.get(msg.id);
        if (!pending) continue;
        this._pending.delete(msg.id);
        if (msg.error) pending.reject(msg.error);
        else pending.resolve(msg.result);
      }
    }
  }

  _handleStderrChunk(chunk) {
    const text = safeString(chunk?.toString("utf8"));
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;
      if (typeof this._hooks.onStderrLine === "function") {
        this._hooks.onStderrLine({ line });
      }
    }
  }

  _sendNotification(method, params) {
    if (!this._proc?.stdin?.writable) {
      throw new Error("GoPeak MCP process stdin is not writable.");
    }
    const payload = { jsonrpc: "2.0", method, ...(params !== undefined ? { params } : {}) };
    this._proc.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  async _request(method, params) {
    await this.ensureConnected();
    return this._requestRaw(method, params);
  }

  _requestRaw(method, params) {
    if (!this._proc?.stdin?.writable) {
      throw new Error("GoPeak MCP process is not writable.");
    }
    const id = this._nextId++;
    const payload = { jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) };
    const promise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this._pending.delete(id);
        const err = new Error(`MCP request timeout: ${method} (${id})`);
        err.code = "ETIMEDOUT";
        reject(err);
      }, this.requestTimeoutMs);
      this._pending.set(id, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
        reject: (err) => {
          clearTimeout(timeout);
          reject(err);
        },
      });
    });
    this._proc.stdin.write(`${JSON.stringify(payload)}\n`);
    return promise;
  }

  async callTool(name, args) {
    return this._request("tools/call", {
      name: String(name),
      arguments: isPlainObject(args) ? args : {},
    });
  }

  async getToolsCatalog() {
    await this.ensureConnected();
    const pages = [];
    const seen = new Set();
    let cursor = null;
    while (true) {
      const page = await this._requestRaw("tools/list", cursor ? { cursor } : {});
      pages.push(page);
      const nextCursor = extractNextCursor(page);
      if (!nextCursor || seen.has(nextCursor)) break;
      seen.add(nextCursor);
      cursor = nextCursor;
    }
    const entries = dedupeToolsByName(pages.flatMap((p) => extractToolsListEntries(p)));
    return {
      tools: entries,
      page_fetch_count: pages.length,
      pagination: { paginated: pages.length > 1 },
    };
  }

  async shutdown({ forceAfterMs = 3_000 } = {}) {
    const proc = this._proc;
    if (!proc) {
      this._connected = false;
      this._initPromise = null;
      return { ok: true, terminated: false, reason: "no_process" };
    }

    const waitExit = new Promise((resolve) => {
      proc.once("exit", (code, signal) => resolve({ exited: true, code: code ?? null, signal: signal ?? null }));
    });

    let killedWith = null;
    try {
      if (!proc.killed) {
        killedWith = "SIGTERM";
        proc.kill("SIGTERM");
      }
    } catch {}

    const graceful = await Promise.race([
      waitExit,
      sleep(Math.max(200, Number(forceAfterMs) || 3000)).then(() => ({ exited: false })),
    ]);

    if (!graceful?.exited) {
      try {
        if (!proc.killed) {
          killedWith = "SIGKILL";
          proc.kill("SIGKILL");
        }
      } catch {}
      await Promise.race([waitExit, sleep(1_000)]);
    }

    for (const [, pending] of this._pending.entries()) {
      pending.reject(new Error("MCP client shutdown: pending request cancelled."));
    }
    this._pending.clear();
    this._connected = false;
    this._initPromise = null;
    this._proc = null;
    return { ok: true, terminated: true, signal: killedWith };
  }
}

class GoPeakSessionManager {
  constructor() {
    this._client = null;
    this._config = null;
    this._started = false;
    this._startCount = 0;
    this._toolsCache = null;
    this._bridgeStatusCache = null;
    this._bridgeStatusCacheAt = 0;
    this._shutdownPromise = null;
    this._bridgeProcessState = {
      process_started: false,
      mcp_initialized: false,
      bridge_listener_started: false,
      editor_connected: false,
      is_bridge_ready: false,
      ready_project_path: null,
      bind_error: null,
      port_open: false,
      port_in_use_before_start: false,
      probable_port_conflict: false,
      last_stdout_lines: [],
      last_stderr_lines: [],
    };
  }

  async ensureStarted() {
    if (this._started && this._client) {
      console.log("[GoPeakSessionManager] reusing backend-owned session");
      return { ok: true, reused: true, status: this.getStatus() };
    }
    this._config = resolveGoPeakConfigFromFile();
    // Bridge port ownership matters: GoPeak editor bridge is expected at fixed 127.0.0.1:6505.
    // If another process already owns it, this backend-owned session may initialize MCP but never
    // own a working bridge, causing opaque readiness timeouts later.
    const portInUseBeforeStart = await isTcpPortOpen(BRIDGE_HOST, BRIDGE_PORT, 300);
    this._bridgeProcessState.port_in_use_before_start = portInUseBeforeStart;
    if (portInUseBeforeStart) {
      console.log("[GoPeakSessionManager] WARNING: bridge port already in use before startup", {
        host: BRIDGE_HOST,
        port: BRIDGE_PORT,
        message: "Another process may already own GoPeak bridge port 6505.",
      });
    }
    this._client = new StdioMcpClient({
      command: this._config.command,
      args: this._config.args,
      env: this._config.env,
      workingDirectory: this._config.workingDirectory,
      requestTimeoutMs: this._config.requestTimeoutMs,
      hooks: {
        onProcessEvent: (evt) => this._onProcessEvent(evt),
        onStdoutLine: (evt) => this._onProcessStdoutLine(evt),
        onStderrLine: (evt) => this._onProcessStderrLine(evt),
      },
    });
    await this._client.ensureConnected();
    this._started = true;
    this._startCount += 1;
    console.log("[GoPeakSessionManager] started new backend-owned session", {
      command: this._config.command,
      args: this._config.args,
      working_directory: this._config.workingDirectory,
      source_config: this._config.sourceConfigPath,
      start_count: this._startCount,
    });
    return { ok: true, reused: false, status: this.getStatus() };
  }

  getStatus() {
    return {
      started: this._started,
      start_count: this._startCount,
      config_path: this._config?.sourceConfigPath ?? null,
      command: this._config?.command ?? null,
      args: this._config?.args ?? [],
      working_directory: this._config?.workingDirectory ?? null,
      has_tools_cache: Array.isArray(this._toolsCache?.tools),
      has_bridge_cache: this._bridgeStatusCache != null,
      has_active_client: Boolean(this._client),
      bridge_cache_age_ms: this._bridgeStatusCacheAt ? Date.now() - this._bridgeStatusCacheAt : null,
      bridge_process_state: this._bridgeProcessState,
    };
  }

  async listAvailableTools({ refresh = false } = {}) {
    await this.ensureStarted();
    if (!refresh && this._toolsCache) return this._toolsCache;
    const catalog = await this._client.getToolsCatalog();
    const tools = normalizeToolMetadataList(catalog);
    this._toolsCache = {
      ok: true,
      tools,
      page_fetch_count: catalog.page_fetch_count ?? null,
      paginated: Boolean(catalog?.pagination?.paginated),
    };
    return this._toolsCache;
  }

  async callTool(name, args = {}) {
    await this.ensureStarted();
    const res = await this._client.callTool(name, args);
    return {
      ok: !Boolean(res?.isError) && res?.error == null,
      tool: String(name),
      arguments: isPlainObject(args) ? args : {},
      raw: res ?? {},
      error: res?.error ?? null,
    };
  }

  async _probeBridgeStatus({ expectedProjectRoot = null, refresh = false } = {}) {
    await this.ensureStarted();
    if (!refresh && this._bridgeStatusCache && Date.now() - this._bridgeStatusCacheAt < 2_000) {
      return this._bridgeStatusCache;
    }

    const expectedAbs = expectedProjectRoot ? normalizeProjectPath(expectedProjectRoot) : null;
    const logReady = this._bridgeProcessState.is_bridge_ready === true;
    const logConnectedPath = this._bridgeProcessState.ready_project_path ?? null;
    const logProjectMatches = expectedAbs == null ? true : logConnectedPath != null && logConnectedPath === expectedAbs;

    const tools = await this.listAvailableTools({ refresh: false });
    const probeTool = pickBridgeProbeToolName(tools?.tools?.map((t) => t?.name) ?? []);
    if (!probeTool) {
      const out = {
        ok: logReady && logProjectMatches,
        isBridgeReady: logReady,
        connectedProjectPath: logConnectedPath,
        expectedProjectPath: expectedAbs,
        projectMatches: logProjectMatches,
        source: "log",
        error: logReady ? null : "No bridge probe tool available in discovered catalog.",
      };
      this._bridgeStatusCache = out;
      this._bridgeStatusCacheAt = Date.now();
      return out;
    }

    const probeArgs = {};
    if (expectedAbs) {
      probeArgs.project_path = expectedAbs;
      probeArgs.projectPath = expectedAbs;
      probeArgs.project_root = expectedAbs;
    }
    const probe = await this.callTool(probeTool, probeArgs);
    const normalized = normalizeBridgeStatusFromProbe({ probe, expectedProjectRoot });
    const probeErrorText = safeString(normalized?.probeError ?? normalized?.error).toLowerCase();
    const probePathRequired = probeErrorText.includes("project path is required");
    const useLogAsAuthority = logReady && (logConnectedPath != null || probePathRequired || normalized?.isBridgeReady === false);

    const merged = useLogAsAuthority
      ? {
          ok: logReady && logProjectMatches,
          isBridgeReady: logReady,
          connectedProjectPath: logConnectedPath,
          expectedProjectPath: expectedAbs,
          projectMatches: logProjectMatches,
          source: "log_authoritative",
          probe: normalized,
          error: logReady ? null : normalized?.error ?? null,
        }
      : {
          ...normalized,
          source: "probe",
          probe: normalized,
        };
    console.log("[GoPeakSessionManager] bridge readiness sources", {
      log_derived: {
        isBridgeReady: logReady,
        connectedProjectPath: logConnectedPath,
        projectMatches: logProjectMatches,
      },
      probe_derived: {
        isBridgeReady: normalized?.isBridgeReady ?? false,
        connectedProjectPath: normalized?.connectedProjectPath ?? null,
        projectMatches: normalized?.projectMatches ?? false,
        error: normalized?.error ?? null,
      },
      selected_source: merged.source,
    });
    this._bridgeStatusCache = merged;
    this._bridgeStatusCacheAt = Date.now();
    return merged;
  }

  async waitForBridgeReady(expectedProjectRoot = null, { timeoutMs = DEFAULT_BRIDGE_WAIT_MS, pollMs = DEFAULT_BRIDGE_POLL_MS } = {}) {
    await this.ensureStarted();
    const bridgeHealth = await this._waitForBridgeStartupHealth();
    if (!bridgeHealth.ok) {
      return {
        ok: false,
        isBridgeReady: false,
        connectedProjectPath: null,
        expectedProjectPath: expectedProjectRoot ? normalizeProjectPath(expectedProjectRoot) : null,
        projectMatches: false,
        attempts: 0,
        elapsed_ms: bridgeHealth.elapsed_ms ?? 0,
        error: bridgeHealth.error,
      };
    }
    const timeout = Math.max(1_000, Number(timeoutMs) || DEFAULT_BRIDGE_WAIT_MS);
    const poll = Math.max(200, Number(pollMs) || DEFAULT_BRIDGE_POLL_MS);
    const start = Date.now();
    let attempts = 0;
    let last = null;
    while (Date.now() - start < timeout) {
      attempts += 1;
      last = await this._probeBridgeStatus({ expectedProjectRoot, refresh: true });
      console.log("[GoPeakSessionManager] bridge wait probe", {
        attempts,
        isBridgeReady: last?.isBridgeReady ?? false,
        connectedProjectPath: last?.connectedProjectPath ?? null,
        expectedProjectRoot: expectedProjectRoot ? normalizeProjectPath(expectedProjectRoot) : null,
        projectMatches: last?.projectMatches ?? false,
      });
      if (last?.isBridgeReady && last?.projectMatches) {
        return {
          ok: true,
          isBridgeReady: true,
          connectedProjectPath: last.connectedProjectPath ?? null,
          expectedProjectPath: last.expectedProjectPath ?? null,
          projectMatches: true,
          attempts,
          elapsed_ms: Date.now() - start,
        };
      }
      await sleep(poll);
    }
    return {
      ok: false,
      isBridgeReady: last?.isBridgeReady ?? false,
      connectedProjectPath: last?.connectedProjectPath ?? null,
      expectedProjectPath: last?.expectedProjectPath ?? (expectedProjectRoot ? normalizeProjectPath(expectedProjectRoot) : null),
      projectMatches: last?.projectMatches ?? false,
      attempts,
      elapsed_ms: Date.now() - start,
      error: "Bridge did not become ready within timeout.",
    };
  }

  async getConnectedProjectPath() {
    if (this._bridgeProcessState.ready_project_path) {
      return this._bridgeProcessState.ready_project_path;
    }
    const status = await this._probeBridgeStatus({ refresh: true });
    return status?.connectedProjectPath ?? null;
  }

  async shutdown({ reason = "manual", forceAfterMs = 3_000 } = {}) {
    if (this._shutdownPromise) return this._shutdownPromise;
    this._shutdownPromise = (async () => {
      const hadClient = Boolean(this._client);
      let childResult = { ok: true, terminated: false, reason: "no_client" };
      try {
        if (this._client && typeof this._client.shutdown === "function") {
          childResult = await this._client.shutdown({ forceAfterMs });
        }
      } catch (err) {
        childResult = { ok: false, terminated: false, error: safeString(err?.message ?? err) };
      }

      this._client = null;
      this._started = false;
      this._toolsCache = null;
      this._bridgeStatusCache = null;
      this._bridgeStatusCacheAt = 0;
      this._bridgeProcessState = {
        process_started: false,
        mcp_initialized: false,
        bridge_listener_started: false,
        editor_connected: false,
        is_bridge_ready: false,
        ready_project_path: null,
        bind_error: null,
        port_open: false,
        port_in_use_before_start: false,
        probable_port_conflict: false,
        last_stdout_lines: [],
        last_stderr_lines: [],
      };

      const portStillOpen = await isTcpPortOpen(BRIDGE_HOST, BRIDGE_PORT, 300);
      const out = {
        ok: Boolean(childResult?.ok),
        reason,
        had_client: hadClient,
        child_result: childResult,
        port_still_open_after_shutdown: portStillOpen,
      };
      console.log("[GoPeakSessionManager] shutdown complete", out);
      return out;
    })().finally(() => {
      this._shutdownPromise = null;
    });
    return this._shutdownPromise;
  }

  _onProcessEvent(evt) {
    if (!isPlainObject(evt)) return;
    if (evt.type === "spawn_start") {
      this._bridgeProcessState.process_started = true;
      console.log("[GoPeakSessionManager] GoPeak child process starting", {
        command: evt.command ?? null,
        args: evt.args ?? [],
        cwd: evt.cwd ?? null,
      });
    } else if (evt.type === "initialized") {
      this._bridgeProcessState.mcp_initialized = true;
      console.log("[GoPeakSessionManager] MCP initialize completed");
    } else if (evt.type === "exit") {
      console.log("[GoPeakSessionManager] GoPeak child process exited", { code: evt.code ?? null });
    }
  }

  _onProcessStdoutLine({ line, isJsonRpc }) {
    const text = safeString(line);
    if (!text) return;
    this._pushProcessLogLine("stdout", text);
    if (isJsonRpc) return;
    this._trackBridgeSignalsFromLog(text, "stdout");
  }

  _onProcessStderrLine({ line }) {
    const text = safeString(line);
    if (!text) return;
    this._pushProcessLogLine("stderr", text);
    this._trackBridgeSignalsFromLog(text, "stderr");
  }

  _pushProcessLogLine(stream, line) {
    const key = stream === "stderr" ? "last_stderr_lines" : "last_stdout_lines";
    const list = Array.isArray(this._bridgeProcessState[key]) ? this._bridgeProcessState[key] : [];
    list.push(line);
    while (list.length > 25) list.shift();
    this._bridgeProcessState[key] = list;
    // Keep normal edit-mode output concise: only print child stdout/stderr lines
    // when DEBUG_GOPEAK_DISCOVERY=true.
    if (GOPEAK_DISCOVERY_DEBUG) {
      console.log(`[GoPeakSessionManager][${stream}] ${line}`);
    }
  }

  _trackBridgeSignalsFromLog(line, stream) {
    const lower = safeString(line).toLowerCase();
    if (
      lower.includes("bridge listening") ||
      lower.includes("bridge started on 127.0.0.1:6505") ||
      lower.includes("unified http+ws bridge listening")
    ) {
      this._bridgeProcessState.bridge_listener_started = true;
      console.log("[GoPeakSessionManager] bridge listener started", { host: BRIDGE_HOST, port: BRIDGE_PORT });
    }
    if (
      lower.includes("editor connected") ||
      lower.includes("godot editor connected") ||
      lower.includes("connected to ws://127.0.0.1:6505")
    ) {
      this._bridgeProcessState.editor_connected = true;
      this._bridgeProcessState.is_bridge_ready = true;
      console.log("[GoPeakSessionManager] editor connection detected in child logs");
    }
    const readyMatch = line.match(/godot\s+ready:\s*(.+)$/i);
    if (readyMatch && safeString(readyMatch[1]).trim()) {
      const parsed = normalizeProjectPath(safeString(readyMatch[1]).trim());
      this._bridgeProcessState.ready_project_path = parsed;
      this._bridgeProcessState.is_bridge_ready = true;
      console.log("[GoPeakSessionManager] log-derived bridge readiness", {
        isBridgeReady: true,
        connectedProjectPath: parsed,
      });
    }
    if (
      lower.includes("address already in use") ||
      lower.includes("eaddrinuse") ||
      lower.includes("port 6505")
    ) {
      this._bridgeProcessState.bind_error = `${stream}:${line}`;
      console.log("[GoPeakSessionManager] bridge bind/startup error detected", {
        error: this._bridgeProcessState.bind_error,
      });
    }
  }

  async _waitForBridgeStartupHealth({ timeoutMs = 10_000, pollMs = 250 } = {}) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (this._bridgeProcessState.bind_error) {
        return {
          ok: false,
          elapsed_ms: Date.now() - start,
          error: `Bridge startup failure detected: ${this._bridgeProcessState.bind_error}`,
        };
      }
      const open = await isTcpPortOpen(BRIDGE_HOST, BRIDGE_PORT, 250);
      this._bridgeProcessState.port_open = open;
      if (
        this._bridgeProcessState.port_in_use_before_start &&
        open &&
        !this._bridgeProcessState.bridge_listener_started
      ) {
        this._bridgeProcessState.probable_port_conflict = true;
        return {
          ok: false,
          elapsed_ms: Date.now() - start,
          error:
            "Bridge startup conflict: port 6505 was already occupied before startup, and this session did not report bridge listener ownership.",
        };
      }
      if (open) {
        if (!this._bridgeProcessState.bridge_listener_started) {
          console.log("[GoPeakSessionManager] bridge port is open before explicit startup log", {
            host: BRIDGE_HOST,
            port: BRIDGE_PORT,
          });
          this._bridgeProcessState.bridge_listener_started = true;
        }
        return { ok: true, elapsed_ms: Date.now() - start };
      }
      await sleep(pollMs);
    }
    const maybeInUseHint = this._bridgeProcessState.bind_error
      ? "possible bind failure / port already in use"
      : "listener never became reachable on 127.0.0.1:6505";
    return {
      ok: false,
      elapsed_ms: Date.now() - start,
      error: `Bridge startup health check failed: ${maybeInUseHint}`,
    };
  }
}

async function isTcpPortOpen(host, port, timeoutMs = 300) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      try {
        socket.destroy();
      } catch {}
      resolve(Boolean(value));
    };
    socket.setTimeout(Math.max(50, Number(timeoutMs) || 300));
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
    socket.connect(Number(port), host);
  });
}

const SHARED_SESSION_MANAGER = globalThis.__FACTORY_JS_GOPEAK_SESSION_MANAGER__ ?? new GoPeakSessionManager();
if (!globalThis.__FACTORY_JS_GOPEAK_SESSION_MANAGER__) {
  globalThis.__FACTORY_JS_GOPEAK_SESSION_MANAGER__ = SHARED_SESSION_MANAGER;
}

function getGoPeakSessionManager() {
  return SHARED_SESSION_MANAGER;
}

export { GoPeakSessionManager, getGoPeakSessionManager };

