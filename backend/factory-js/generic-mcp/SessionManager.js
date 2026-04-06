/**
 * SessionManager
 * -----------------------------------------------------------------------------
 * Owns the Generic MCP session lifecycle for the new isolated workspace.
 *
 * Why "Godot says MCP connected" is not enough:
 * The editor can show MCP as connected while our stdio client is still spawning,
 * waiting on `initialize`, or waiting on the bridge probe / project path. Those
 * layers fail independently; diagnosing them requires explicit phases and
 * separate error slots — not a single generic timeout message.
 *
 * Why transport, initialize, bridge probe, and project matching are separate:
 * Each step uses different failure modes (process, JSON-RPC, editor bridge,
 * filesystem path equality). Collapsing them hides which layer to fix.
 *
 * Scope of this class:
 * - one persistent MCP client session per manager instance
 * - readiness checks for a desired project root
 * - truthful, stable session status reporting
 *
 * Out of scope here:
 * - tool discovery
 * - tool execution
 * - request planning/presentation
 *
 * This module is intentionally adapter-friendly: callers provide MCP config and
 * an optional `bridgeProbe` callback for tests or custom adapters. When the MCP
 * client implements `probeBridge()` (e.g. stdio adapter), SessionManager uses
 * that **generic capability** first — it is not factory tool planning, only
 * readiness consumption.
 *
 * Project roots are compared as **canonical absolute real paths** (`path.resolve`
 * + `fs.realpathSync`) so relative CLI args and symlinked directories match the
 * server-reported project path.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** High-level session phases after MCP transport (bridge / project). */
export const SESSION_PHASE = {
  BRIDGE_PROBE_STARTED: "bridge_probe_started",
  BRIDGE_PROBE_RESPONSE_RECEIVED: "bridge_probe_response_received",
  PROJECT_MATCH_CHECK: "project_match_check",
  READY: "ready",
};

function safeString(value) {
  return value == null ? "" : String(value);
}

function normalizeProjectRoot(projectRoot) {
  const v = safeString(projectRoot).trim();
  return v || null;
}

function sleep(ms) {
  const n = Number(ms);
  return new Promise((resolve) => setTimeout(resolve, Number.isFinite(n) && n > 0 ? n : 0));
}

function isPlainObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function canonicalProjectPath(input, cwd = process.cwd()) {
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

function resolveSessionProjectRoot(projectRoot) {
  const raw = projectRoot == null ? null : safeString(projectRoot);
  const trimmed = normalizeProjectRoot(projectRoot);
  const canonical = trimmed ? canonicalProjectPath(trimmed) : null;
  return { raw, trimmed, canonical };
}

function normalizePathForCompare(p) {
  return canonicalProjectPath(p);
}

function projectRootsMatch(connectedPath, desiredRoot) {
  if (desiredRoot == null) return true;
  if (connectedPath == null) return false;
  const c = canonicalProjectPath(connectedPath);
  const d = canonicalProjectPath(desiredRoot);
  return c != null && d != null && c === d;
}

/**
 * Structured project path comparison for diagnostics (normalization vs real mismatch).
 */
function buildProjectMatchDiagnostic(rawExpected, rawConnected, normalizedExpected, normalizedConnected) {
  if (rawExpected == null && normalizedExpected == null) {
    return {
      comparisonResult: "skipped_no_desired",
      rawExpectedPath: null,
      rawConnectedPath: rawConnected ?? null,
      normalizedExpectedPath: null,
      normalizedConnectedPath: normalizedConnected,
      pathResolveEqual: true,
    };
  }
  const pathResolveEqual =
    normalizedExpected != null &&
    normalizedConnected != null &&
    normalizedExpected === normalizedConnected;
  return {
    comparisonResult: pathResolveEqual ? "match" : "mismatch",
    rawExpectedPath: rawExpected ?? null,
    rawConnectedPath: rawConnected ?? null,
    normalizedExpectedPath: normalizedExpected,
    normalizedConnectedPath: normalizedConnected,
    pathResolveEqual,
  };
}

function defaultPhasesState() {
  return {
    transport: { ok: false, attempts: 0, lastError: null },
    bridge: { ok: false, attempts: 0, lastError: null },
  };
}

function makeSessionState() {
  return {
    connected: false,
    bridgeReady: false,
    connectedProjectPath: null,
    /** Raw string from bridge probe before normalization (diagnostics). */
    connectedProjectPathRaw: null,
    sessionId: null,
    mcpClientReady: false,
    desiredProjectRoot: null,
    /** Raw project root argument before trim/normalize. */
    desiredProjectRootRaw: null,
    mcpConfig: null,
    lastError: null,
    startedAt: null,
    updatedAt: new Date().toISOString(),
    /**
     * Coarse bucket: `mcp_transport` | `bridge_project` | null
     * Kept for compatibility with earlier status consumers.
     */
    failurePhase: null,
    /**
     * Fine-grained phase name when something failed (e.g. `initialize_response_received`,
     * `bridge_probe_response_received`, `project_match_check`).
     */
    failedPhase: null,
    phases: defaultPhasesState(),
    lastTransportError: null,
    lastInitializeError: null,
    lastBridgeProbeError: null,
    /** Last structured `raw` from adapter `probeBridge` / config probe when present. */
    lastBridgeProbeRaw: null,
    /** `adapter` | `config` | `none` — which probe path last ran. */
    bridgeProbeSource: null,
    lastProjectMatchDiagnostic: null,
  };
}

/**
 * Config contract (all optional except mcpConfig by convention):
 * {
 *   mcpConfig: { command, args, env, workingDirectory, ... } | any,
 *   createClient?: async ({ mcpConfig }) => client,
 *   bridgeProbe?: async ({ client, desiredProjectRoot, mcpConfig }) => ({ ... }),
 *   debug?: boolean,
 *   initializeMaxAttempts?: number,
 *   initializeRetryDelayMs?: number,
 *   bridgeMaxAttempts?: number,
 *   bridgeRetryDelayMs?: number,
 * }
 */
export class SessionManager {
  constructor(config = {}) {
    this._config = config ?? {};
    this._mcpConfig = this._config?.mcpConfig ?? null;
    this._client = null;
    this._state = makeSessionState();
    this._initializePromise = null;

    this._debug = Boolean(this._config.debug);

    const mcp = isPlainObject(this._mcpConfig) ? this._mcpConfig : {};
    const bMax = Number(this._config.bridgeMaxAttempts ?? mcp.bridgeMaxAttempts);
    const bDelay = Number(this._config.bridgeRetryDelayMs ?? mcp.bridgeRetryDelayMs);
    this._bridgeMaxAttempts = Number.isFinite(bMax) && bMax > 0 ? Math.floor(bMax) : 30;
    this._bridgeRetryDelayMs = Number.isFinite(bDelay) && bDelay >= 0 ? Math.floor(bDelay) : 2000;
  }

  _mergeMcpConfigForClient() {
    const base = isPlainObject(this._mcpConfig) ? { ...this._mcpConfig } : {};
    const iMax = Number(this._config.initializeMaxAttempts ?? base.initializeMaxAttempts);
    const iDelay = Number(this._config.initializeRetryDelayMs ?? base.initializeRetryDelayMs);
    return {
      ...base,
      initializeMaxAttempts: Number.isFinite(iMax) && iMax > 0 ? Math.floor(iMax) : 30,
      initializeRetryDelayMs: Number.isFinite(iDelay) && iDelay >= 0 ? Math.floor(iDelay) : 2000,
      debug: this._debug || Boolean(base.debug),
    };
  }

  _phaseLog(phase, normalDetail) {
    const debugOnly = new Set([
      SESSION_PHASE.BRIDGE_PROBE_STARTED,
      SESSION_PHASE.BRIDGE_PROBE_RESPONSE_RECEIVED,
      SESSION_PHASE.PROJECT_MATCH_CHECK,
    ]);
    if (debugOnly.has(phase) && !this._debug) return;
    console.error(`[generic-mcp] phase ${phase}: ${normalDetail}`);
  }

  _clearFailureFields() {
    this._state.failurePhase = null;
    this._state.failedPhase = null;
    this._state.lastTransportError = null;
    this._state.lastInitializeError = null;
    this._state.lastBridgeProbeError = null;
    this._state.lastBridgeProbeRaw = null;
    this._state.bridgeProbeSource = null;
    this._state.lastProjectMatchDiagnostic = null;
  }

  async initialize(projectRoot = null) {
    if (this._initializePromise) return this._initializePromise;
    this._initializePromise = this._initializeInternal(projectRoot);
    try {
      return await this._initializePromise;
    } finally {
      this._initializePromise = null;
    }
  }

  async ensureReady(projectRoot = null) {
    await this.initialize(projectRoot);
    const { canonical: desired } = resolveSessionProjectRoot(projectRoot);
    if (!this.getStatus().mcpClientReady) {
      const status = this.getStatus();
      return {
        ok: false,
        status,
        projectMatches: false,
      };
    }
    await this._refreshBridgeStatus(desired);
    if (!this._bridgeSuccessPredicate(desired).ok) {
      await this._waitForBridgeReadiness(desired, { label: "ensureReady" });
    }

    const status = this.getStatus();
    const projectMatches =
      desired == null ||
      status.connectedProjectPath == null ||
      projectRootsMatch(status.connectedProjectPath, desired);

    return {
      ok:
        Boolean(status.mcpClientReady) &&
        Boolean(status.bridgeReady) &&
        Boolean(projectMatches) &&
        Boolean(status.phases?.transport?.ok) &&
        Boolean(status.phases?.bridge?.ok),
      status,
      projectMatches,
    };
  }

  getStatus() {
    return { ...this._state };
  }

  async shutdown() {
    const client = this._client;
    this._client = null;

    if (client && typeof client.disconnect === "function") {
      try {
        await client.disconnect();
      } catch (err) {
        this._state.lastError = safeString(err?.message ?? err);
      }
    }

    this._state = {
      ...makeSessionState(),
      mcpConfig: this._mcpConfig ?? null,
    };
    return { ok: true, status: this.getStatus() };
  }

  _log(msg, detail = null) {
    if (detail != null && this._debug) {
      console.error(`[generic-mcp] ${msg}`, detail);
    } else {
      console.error(`[generic-mcp] ${msg}`);
    }
  }

  _transportMetaFromClient() {
    const c = this._client;
    if (c && typeof c.getTransportPhaseMeta === "function") {
      return c.getTransportPhaseMeta();
    }
    return { attempts: this._state.phases?.transport?.attempts ?? 0, lastError: null };
  }

  async _initializeInternal(projectRoot) {
    const { raw: desiredRaw, canonical: desired } = resolveSessionProjectRoot(projectRoot);
    if (!this._mcpConfig) {
      this._state = {
        ...this._state,
        desiredProjectRoot: desired,
        desiredProjectRootRaw: desiredRaw == null ? null : safeString(desiredRaw),
        mcpConfig: null,
        lastError: "Missing MCP configuration.",
        failurePhase: "mcp_transport",
        failedPhase: "process_spawn",
        phases: {
          ...defaultPhasesState(),
          transport: { ok: false, attempts: 0, lastError: "Missing MCP configuration." },
        },
        lastTransportError: "Missing MCP configuration.",
        updatedAt: new Date().toISOString(),
      };
      return { ok: false, status: this.getStatus(), error: this._state.lastError, failurePhase: "mcp_transport", failedPhase: "process_spawn" };
    }

    if (this._client) {
      this._state = {
        ...this._state,
        desiredProjectRoot: desired ?? this._state.desiredProjectRoot,
        desiredProjectRootRaw: desiredRaw == null ? this._state.desiredProjectRootRaw : safeString(desiredRaw),
        updatedAt: new Date().toISOString(),
      };
      try {
        await this._refreshBridgeStatus(desired);
        if (this._bridgeSuccessPredicate(desired).ok) {
          return { ok: true, reused: true, status: this.getStatus() };
        }
        await this._waitForBridgeReadiness(desired, { label: "initialize(reuse)" });
        return { ok: true, reused: true, status: this.getStatus() };
      } catch (err) {
        const msg = safeString(err?.message ?? err);
        this._state = {
          ...this._state,
          lastError: msg,
          failurePhase: "bridge_project",
          failedPhase: err?.phase || SESSION_PHASE.BRIDGE_PROBE_RESPONSE_RECEIVED,
          updatedAt: new Date().toISOString(),
        };
        this._log(`Session bridge/project phase failed (failedPhase=${this._state.failedPhase}).`, msg);
        return {
          ok: false,
          reused: true,
          status: this.getStatus(),
          error: msg,
          failurePhase: "bridge_project",
          failedPhase: this._state.failedPhase,
        };
      }
    }

    this._clearFailureFields();
    this._state = {
      ...this._state,
      failurePhase: null,
      failedPhase: null,
      desiredProjectRootRaw: desiredRaw == null ? null : safeString(desiredRaw),
      phases: defaultPhasesState(),
    };

    try {
      const merged = this._mergeMcpConfigForClient();
      this._client = await this._createClient({ mcpConfig: merged });

      const transportMeta = this._transportMetaFromClient();

      this._state = {
        ...this._state,
        connected: true,
        mcpClientReady: true,
        sessionId: randomUUID(),
        desiredProjectRoot: desired,
        desiredProjectRootRaw: desiredRaw == null ? null : safeString(desiredRaw),
        mcpConfig: this._mcpConfig,
        startedAt: new Date().toISOString(),
        lastError: null,
        failurePhase: null,
        failedPhase: null,
        lastTransportError: transportMeta.lastTransportError ?? null,
        lastInitializeError: transportMeta.lastInitializeError ?? null,
        phases: {
          ...this._state.phases,
          transport: {
            ok: true,
            attempts: transportMeta.attempts || 1,
            lastError: null,
          },
        },
        updatedAt: new Date().toISOString(),
      };

      await this._waitForBridgeReadiness(desired, { label: "initialize" });
      return { ok: true, reused: false, status: this.getStatus(), failurePhase: null, failedPhase: null };
    } catch (err) {
      const msg = safeString(err?.message ?? err);
      const transportFailed = msg.includes("MCP transport initialize failed") || !this._client;
      const granularPhase = err?.phase || (transportFailed ? "process_spawn" : SESSION_PHASE.BRIDGE_PROBE_RESPONSE_RECEIVED);

      if (transportFailed) {
        const tm = this._client ? this._transportMetaFromClient() : {};
        this._client = null;
        this._state = {
          ...this._state,
          connected: false,
          mcpClientReady: false,
          bridgeReady: false,
          connectedProjectPath: null,
          connectedProjectPathRaw: null,
          desiredProjectRoot: desired,
          desiredProjectRootRaw: desiredRaw == null ? null : safeString(desiredRaw),
          mcpConfig: this._mcpConfig,
          lastError: msg,
          failurePhase: "mcp_transport",
          failedPhase: granularPhase,
          lastTransportError: tm.lastTransportError ?? tm.lastError ?? msg,
          lastInitializeError: tm.lastInitializeError ?? null,
          phases: {
            ...this._state.phases,
            transport: {
              ok: false,
              attempts: tm.attempts ?? this._state.phases?.transport?.attempts ?? 0,
              lastError: msg,
            },
          },
          updatedAt: new Date().toISOString(),
        };
        this._phaseLog("failure", `mcp_transport (failedPhase=${this._state.failedPhase})`);
        this._log(`Session failed during MCP transport phase.`, msg);
        return { ok: false, status: this.getStatus(), error: msg, failurePhase: "mcp_transport", failedPhase: this._state.failedPhase };
      }

      this._state = {
        ...this._state,
        lastError: msg,
        failurePhase: "bridge_project",
        failedPhase: granularPhase,
        phases: {
          ...this._state.phases,
          bridge: {
            ok: false,
            attempts: this._state.phases?.bridge?.attempts ?? 0,
            lastError: msg,
          },
        },
        updatedAt: new Date().toISOString(),
      };
      this._phaseLog("failure", `bridge_project (failedPhase=${this._state.failedPhase})`);
      this._log(`Session failed during bridge/project phase.`, msg);
      return { ok: false, status: this.getStatus(), error: msg, failurePhase: "bridge_project", failedPhase: this._state.failedPhase };
    }
  }

  async _createClient({ mcpConfig }) {
    if (typeof this._config?.createClient === "function") {
      return this._config.createClient({ mcpConfig });
    }
    return {
      mcpConfig,
      disconnect: async () => {},
    };
  }

  _bridgeSuccessPredicate(desiredProjectRoot) {
    const st = this._state;
    if (!st.bridgeReady) return { ok: false, detail: "bridgeReady=false" };
    if (desiredProjectRoot != null) {
      if (st.connectedProjectPath == null || safeString(st.connectedProjectPath).trim() === "") {
        return { ok: false, detail: "connectedProjectPath not known yet" };
      }
      if (!projectRootsMatch(st.connectedProjectPath, desiredProjectRoot)) {
        return {
          ok: false,
          detail: `connectedProjectPath mismatch (got ${st.connectedProjectPath}, want ${desiredProjectRoot})`,
        };
      }
    }
    return { ok: true, detail: null };
  }

  _logProjectMatchDiagnostics(desiredProjectRoot) {
    const rawExp = this._state.desiredProjectRootRaw;
    const rawConn = this._state.connectedProjectPathRaw;
    const normExp = desiredProjectRoot != null ? normalizePathForCompare(desiredProjectRoot) : null;
    const normConn = normalizePathForCompare(this._state.connectedProjectPath);
    const diag = buildProjectMatchDiagnostic(rawExp, rawConn, normExp, normConn);
    this._state = {
      ...this._state,
      lastProjectMatchDiagnostic: diag,
      updatedAt: new Date().toISOString(),
    };

    if (this._debug) {
      console.error(
        `[generic-mcp] phase ${SESSION_PHASE.PROJECT_MATCH_CHECK}: comparisonResult=${diag.comparisonResult} pathResolveEqual=${diag.pathResolveEqual}`
      );
    }
    if (this._debug) {
      console.error("[generic-mcp][debug] project path diagnostic:", {
        rawExpectedPath: diag.rawExpectedPath,
        rawConnectedPath: diag.rawConnectedPath,
        normalizedExpectedPath: diag.normalizedExpectedPath,
        normalizedConnectedPath: diag.normalizedConnectedPath,
        comparisonResult: diag.comparisonResult,
      });
    }
  }

  async _waitForBridgeReadiness(desiredProjectRoot, { label = "bridge" } = {}) {
    let lastDetail = "bridge not ready";
    for (let attempt = 1; attempt <= this._bridgeMaxAttempts; attempt++) {
      await this._refreshBridgeStatus(desiredProjectRoot);
      const pred = this._bridgeSuccessPredicate(desiredProjectRoot);
      this._logProjectMatchDiagnostics(desiredProjectRoot);

      if (pred.ok) {
        this._state = {
          ...this._state,
          phases: {
            ...this._state.phases,
            bridge: { ok: true, attempts: attempt, lastError: null },
          },
          failurePhase: null,
          failedPhase: null,
          lastBridgeProbeError: null,
          updatedAt: new Date().toISOString(),
        };
        this._phaseLog(SESSION_PHASE.READY, `bridge ready (${label}, attempt ${attempt}/${this._bridgeMaxAttempts})`);
        return;
      }

      if (desiredProjectRoot != null && this._state.bridgeReady && this._state.connectedProjectPath != null) {
        const match = projectRootsMatch(this._state.connectedProjectPath, desiredProjectRoot);
        if (!match) {
          this._state = {
            ...this._state,
            failedPhase: SESSION_PHASE.PROJECT_MATCH_CHECK,
            failurePhase: "bridge_project",
            updatedAt: new Date().toISOString(),
          };
          this._phaseLog("failure", `${SESSION_PHASE.PROJECT_MATCH_CHECK} (paths do not match)`);
        }
      }

      lastDetail = pred.detail;
      console.error(
        `[generic-mcp] bridge readiness attempt ${attempt}/${this._bridgeMaxAttempts} (${label}): ${lastDetail}`
      );
      if (this._debug) {
        this._log(
          `Bridge/project readiness attempt ${attempt}/${this._bridgeMaxAttempts} (${label}): ${lastDetail}`,
          {
            connectedProjectPath: this._state.connectedProjectPath,
            connectedProjectPathRaw: this._state.connectedProjectPathRaw,
            desiredProjectRoot,
            desiredProjectRootRaw: this._state.desiredProjectRootRaw,
            lastProjectMatchDiagnostic: this._state.lastProjectMatchDiagnostic,
          }
        );
      }
      this._state = {
        ...this._state,
        phases: {
          ...this._state.phases,
          bridge: { ok: false, attempts: attempt, lastError: lastDetail },
        },
        updatedAt: new Date().toISOString(),
      };
      if (attempt >= this._bridgeMaxAttempts) break;
      await sleep(this._bridgeRetryDelayMs);
    }

    const errMsg = `Bridge/project readiness failed after ${this._bridgeMaxAttempts} attempts (${label}). Last: ${lastDetail}`;
    const err = new Error(errMsg);
    err.phase = this._state.failedPhase || SESSION_PHASE.BRIDGE_PROBE_RESPONSE_RECEIVED;
    throw err;
  }

  async _refreshBridgeStatus(desiredProjectRoot = null) {
    const defaultStatus = {
      bridgeReady: Boolean(this._state.bridgeReady),
      connectedProjectPath: this._state.connectedProjectPath ?? null,
      connectedProjectPathRaw: this._state.connectedProjectPathRaw ?? null,
      connected: Boolean(this._state.connected),
      mcpClientReady: Boolean(this._state.mcpClientReady),
    };

    this._phaseLog(SESSION_PHASE.BRIDGE_PROBE_STARTED, "resolving bridge readiness (adapter or config)");
    let probe = defaultStatus;
    let probeSource = "none";

    try {
      if (this._client && typeof this._client.probeBridge === "function") {
        probeSource = "adapter";
        const r = await this._client.probeBridge({ desiredProjectRoot });
        if (this._debug) {
          console.error("[generic-mcp][debug] adapter probeBridge result:", r);
        }
        const rawPath =
          r?.connectedProjectPathRaw != null
            ? safeString(r.connectedProjectPathRaw)
            : r?.connectedProjectPath != null
              ? safeString(r.connectedProjectPath)
              : null;
        probe = {
          ...defaultStatus,
          bridgeReady: Boolean(r?.bridgeReady),
          connectedProjectPath: r?.connectedProjectPath ?? null,
          connectedProjectPathRaw: rawPath,
          connected: r?.connected != null ? Boolean(r.connected) : Boolean(r?.bridgeReady),
          mcpClientReady: true,
        };
        this._state.lastBridgeProbeRaw = r?.raw != null ? r.raw : null;
        this._state.bridgeProbeSource = "adapter";
        this._state.lastBridgeProbeError = r?.ok === false && r?.error ? safeString(r.error) : null;
        if (r?.ok === false && r?.error && this._debug) {
          console.error("[generic-mcp][debug] adapter probeBridge reported not ok:", r.error);
        }
        this._phaseLog(
          SESSION_PHASE.BRIDGE_PROBE_RESPONSE_RECEIVED,
          `adapter probeBridge${r?.probeTool ? ` (${r.probeTool})` : ""}`
        );
      } else if (typeof this._config?.bridgeProbe === "function") {
        probeSource = "config";
        const result = await this._config.bridgeProbe({
          client: this._client,
          desiredProjectRoot,
          mcpConfig: this._mcpConfig,
        });
        const raw = result && typeof result === "object" ? result : {};
        if (this._debug) {
          console.error("[generic-mcp][debug] SessionManager bridgeProbe callback:", raw);
        }
        probe = {
          ...defaultStatus,
          ...raw,
        };
        this._state.lastBridgeProbeRaw = raw?.raw != null ? raw.raw : raw;
        this._state.bridgeProbeSource = "config";
        this._state.lastBridgeProbeError = null;
        this._phaseLog(SESSION_PHASE.BRIDGE_PROBE_RESPONSE_RECEIVED, "config bridgeProbe callback");
      } else {
        this._state.lastBridgeProbeError =
          "No bridge readiness probe: MCP client has no probeBridge() and SessionManager has no bridgeProbe callback.";
        this._state.lastBridgeProbeRaw = null;
        this._state.bridgeProbeSource = "none";
        probe = {
          ...defaultStatus,
          bridgeReady: false,
        };
        if (this._debug) {
          console.error("[generic-mcp][debug]", this._state.lastBridgeProbeError);
        }
        this._phaseLog(SESSION_PHASE.BRIDGE_PROBE_RESPONSE_RECEIVED, "failed (no probe capability)");
      }
    } catch (err) {
      const em = safeString(err?.message ?? err);
      this._state.lastError = em;
      this._state.lastBridgeProbeError = em;
      this._state.failedPhase = SESSION_PHASE.BRIDGE_PROBE_RESPONSE_RECEIVED;
      this._state.lastBridgeProbeRaw = null;
      this._state.bridgeProbeSource = probeSource || "unknown";
      probe = {
        ...defaultStatus,
        bridgeReady: false,
      };
      this._phaseLog("failure", `${SESSION_PHASE.BRIDGE_PROBE_RESPONSE_RECEIVED} (${em})`);
      if (this._debug) {
        console.error("[generic-mcp][debug] bridge probe threw:", err);
      }
    }

    const rawPath = probe.connectedProjectPathRaw ?? probe.connectedProjectPath;
    const normalizedPath =
      probe.connectedProjectPath != null ? canonicalProjectPath(probe.connectedProjectPath) : null;

    this._state = {
      ...this._state,
      desiredProjectRoot: desiredProjectRoot ?? this._state.desiredProjectRoot,
      bridgeReady: Boolean(probe.bridgeReady),
      connectedProjectPath: normalizedPath,
      connectedProjectPathRaw: rawPath == null ? null : safeString(rawPath),
      connected: Boolean(probe.connected),
      mcpClientReady: Boolean(probe.mcpClientReady),
      updatedAt: new Date().toISOString(),
    };
    return this.getStatus();
  }
}
