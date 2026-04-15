import fs from "node:fs";
import path from "node:path";

function safeString(value) {
  return value == null ? "" : String(value);
}

function isPlainObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function normalizeInput(value) {
  return safeString(value).trim();
}

function asStringArray(value) {
  return Array.isArray(value)
    ? value.map((v) => normalizeInput(v)).filter(Boolean)
    : [];
}
function normalizeRunMode(value) {
  const mode = normalizeInput(value).toLowerCase();
  return mode === "online" ? "online" : "local";
}

function canonicalPathForCompare(input) {
  const v = normalizeInput(input);
  if (!v) return null;
  let resolved;
  try {
    resolved = path.isAbsolute(v) ? path.normalize(v) : path.resolve(process.cwd(), v);
  } catch {
    return null;
  }
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

export class GenericMcpHttpAdapterError extends Error {
  constructor(message, { httpStatus = 400, code = "bad_request", details = null } = {}) {
    super(message);
    this.name = "GenericMcpHttpAdapterError";
    this.httpStatus = httpStatus;
    this.code = code;
    this.details = details;
  }
}

export class GenericMcpHttpAdapter {
  constructor({
    runner,
    localRunner = null,
    onlineRunner = null,
    sessionStore,
    mcpConfig = null,
    defaultProjectPath = null,
    sessionManager = null,
    debug = false,
  } = {}) {
    const fallbackRunner = localRunner ?? runner ?? null;
    if (!fallbackRunner || typeof fallbackRunner.run !== "function") {
      throw new Error("GenericMcpHttpAdapter requires a local runner with run(...).");
    }
    if (onlineRunner != null && typeof onlineRunner.run !== "function") {
      throw new Error("GenericMcpHttpAdapter onlineRunner must expose run(...).");
    }
    if (!sessionStore || typeof sessionStore.ensureSession !== "function") {
      throw new Error("GenericMcpHttpAdapter requires a sessionStore.");
    }
    this._localRunner = fallbackRunner;
    this._onlineRunner = onlineRunner ?? fallbackRunner;
    this._sessionStore = sessionStore;
    this._mcpConfig = mcpConfig;
    this._defaultProjectPath = normalizeInput(defaultProjectPath) || null;
    this._sessionManager = sessionManager ?? null;
    this._startedAt = Date.now();
    this._debug = Boolean(debug);
  }

  async handleRun(payload, { runMode = "local" } = {}) {
    const normalizedRunMode = normalizeRunMode(runMode);
    const body = this._validateObjectPayload(payload);
    const input = this._requireNonEmptyField(body, "input");
    const responseMode = this._resolveResponseMode(body);
    const rawSessionId = normalizeInput(body.sessionId) || null;
    const existingSession = rawSessionId ? this._sessionStore.getSession(rawSessionId) : null;
    const projectPath = this._resolveProjectPath(body.projectPath, {
      sessionProjectPath: existingSession?.projectPath ?? null,
    });

    const session = this._sessionStore.ensureSession(rawSessionId, { projectPath });
    const runner = this._resolveRunnerForMode(normalizedRunMode);
    const runResult = await runner.run({
      userRequest: input,
      projectRoot: projectPath,
      mcpConfig: this._mcpConfig,
      sessionContext: {
        projectRoot: projectPath,
        sidecarSessionId: session.sessionId,
      },
      resumeNeedsInput: null,
    });

    const resolvedProjectPath = this._resolveResultProjectPath(runResult, {
      fallbackProjectPath: projectPath,
    });
    this._sessionStore.setRunResult(session.sessionId, runResult, {
      projectPath: resolvedProjectPath,
      runMode: normalizedRunMode,
    });
    return this._ok(
      this._buildRunResponseBody({
        sessionId: session.sessionId,
        runResult,
        responseMode,
        runMode: normalizedRunMode,
      })
    );
  }

  handleHealth() {
    const mcp = this._buildReadinessSnapshot();
    const status = !mcp.available
      ? "healthy"
      : mcp.ready
        ? "healthy"
        : mcp.lastError
          ? "degraded"
          : "starting";
    return this._ok({
      ok: true,
      status,
      ready: mcp.ready,
      uptimeSeconds: Math.floor((Date.now() - this._startedAt) / 1000),
      sidecar: {
        transport: "http",
        workflowSource: "GenericMcpRunner",
      },
      mcp,
      sessions: this._sessionStore.getSummary(),
    });
  }

  async handleReady({ projectPath = null } = {}) {
    const expectedProjectPath = normalizeInput(projectPath) || null;
    let gateError = null;
    if (this._sessionManager && typeof this._sessionManager.ensureReady === "function") {
      try {
        await this._sessionManager.ensureReady(expectedProjectPath);
      } catch (err) {
        gateError = safeString(err?.message ?? err).trim() || "ensureReady failed";
      }
    }

    const mcp = this._buildReadinessSnapshot({ expectedProjectPath });
    const ready = mcp.available ? Boolean(mcp.ready) : false;
    return {
      httpStatus: ready ? 200 : 503,
      body: {
        ok: ready,
        status: ready ? "ready" : "not_ready",
        ready,
        mcp,
        ...(gateError ? { error: gateError } : {}),
      },
    };
  }

  toErrorResponse(error) {
    const httpStatus = Number(error?.httpStatus) || 500;
    const code = safeString(error?.code).trim() || "internal_error";
    const message = safeString(error?.message).trim() || "Unknown error";
    const details = error?.details ?? null;

    if (this._debug) {
      console.error("[generic-mcp][http-adapter] error", {
        httpStatus,
        code,
        message,
        details,
      });
    }

    return {
      httpStatus,
      body: {
        ok: false,
        status: "error",
        code,
        error: message,
        ...(details != null ? { details } : {}),
      },
    };
  }

  _ok(body) {
    return { httpStatus: 200, body };
  }

  _resolveResponseMode(payload) {
    const mode = normalizeInput(payload?.responseMode).toLowerCase();
    return mode === "full" ? "full" : "compact";
  }

  _buildRunResponseBody({ sessionId, runResult, responseMode = "compact", runMode = "local" } = {}) {
    const id = normalizeInput(sessionId) || null;
    const result = isPlainObject(runResult) ? runResult : {};
    const mode = normalizeRunMode(runMode);
    if (responseMode === "full") {
      return {
        sessionId: id,
        runMode: mode,
        ...result,
      };
    }
    const out = {
      sessionId: id,
      runMode: mode,
      ok: Boolean(result.ok),
      status: normalizeInput(result.status) || null,
      reason: result.reason ?? null,
      presentation: safeString(result.presentation),
      responseMode: "compact",
    };
    const passthroughKeys = [
      "kind",
      "field",
      "question",
      "missing",
      "options",
      "attemptedValue",
      "pauseReason",
      "pausedTaskStatus",
      "code",
      "error",
    ];
    for (const key of passthroughKeys) {
      if (!Object.prototype.hasOwnProperty.call(result, key)) continue;
      out[key] = result[key];
    }
    if (isPlainObject(result.partialPlan)) {
      out.partialPlan = {
        tool: normalizeInput(result.partialPlan.tool) || null,
        args: isPlainObject(result.partialPlan.args) ? result.partialPlan.args : {},
      };
    }
    if (isPlainObject(result.taskQueue)) {
      out.taskQueue = this._compactTaskQueue(result.taskQueue);
    }
    if (isPlainObject(result.pausedTaskResult)) {
      out.pausedTask = this._compactRunResultSummary(result.pausedTaskResult);
    }
    const connectedProjectPath = normalizeInput(result?.session?.connectedProjectPath) || null;
    const toolCount = Number.isFinite(Number(result?.inventory?.toolCount))
      ? Number(result.inventory.toolCount)
      : null;
    if (connectedProjectPath || toolCount != null) {
      out.context = {
        ...(connectedProjectPath ? { connectedProjectPath } : {}),
        ...(toolCount != null ? { toolCount } : {}),
      };
    }
    out.resumeAvailable = false;
    return out;
  }

  _resolveRunnerForMode(runMode) {
    const mode = normalizeRunMode(runMode);
    return mode === "online" ? this._onlineRunner : this._localRunner;
  }

  _compactTaskQueue(taskQueue = {}) {
    const queue = isPlainObject(taskQueue) ? taskQueue : {};
    const tasks = asStringArray(queue.tasks);
    const completedTasksRaw = Array.isArray(queue.completedTasks) ? queue.completedTasks : [];
    const completedTasks = completedTasksRaw.map((entry) => this._compactQueueTaskEntry(entry));
    const currentTaskIndex = Number.isFinite(Number(queue.currentTaskIndex))
      ? Math.max(0, Math.floor(Number(queue.currentTaskIndex)))
      : 0;
    const pausedTask = isPlainObject(queue.pausedTask)
      ? this._compactQueueTaskEntry(queue.pausedTask)
      : null;
    const totalTasks = Number.isFinite(Number(queue.totalTasks))
      ? Math.max(0, Math.floor(Number(queue.totalTasks)))
      : tasks.length;
    return {
      mode: normalizeInput(queue.mode) || null,
      status: normalizeInput(queue.status) || null,
      totalTasks,
      currentTaskIndex,
      pauseReason: normalizeInput(queue.pauseReason) || null,
      tasks,
      completedTasks,
      pausedTask,
      counts: {
        completed: completedTasks.length,
        pending: Math.max(totalTasks - currentTaskIndex, 0),
        remaining: Math.max(totalTasks - (currentTaskIndex + 1), 0),
      },
    };
  }

  _compactQueueTaskEntry(entry = {}) {
    const item = isPlainObject(entry) ? entry : {};
    const out = {
      index: Number.isFinite(Number(item.index)) ? Math.floor(Number(item.index)) : null,
      task: normalizeInput(item.task) || null,
      ok: typeof item.ok === "boolean" ? item.ok : null,
      status: normalizeInput(item.status) || null,
      reason: item.reason ?? null,
      presentation: safeString(item.presentation),
    };
    const nested = isPlainObject(item.result) ? this._compactRunResultSummary(item.result) : null;
    if (nested) out.result = nested;
    return out;
  }

  _compactRunResultSummary(result = {}) {
    const value = isPlainObject(result) ? result : null;
    if (!value) return null;
    return {
      ok: Boolean(value.ok),
      status: normalizeInput(value.status) || null,
      reason: value.reason ?? null,
      presentation: safeString(value.presentation),
      kind: normalizeInput(value.kind) || null,
      field: normalizeInput(value.field) || null,
      question: normalizeInput(value.question) || null,
      missing: asStringArray(value.missing),
      options: asStringArray(value.options),
    };
  }

  _validateObjectPayload(payload) {
    if (payload == null) return {};
    if (!isPlainObject(payload)) {
      throw new GenericMcpHttpAdapterError("Expected JSON object payload.", {
        httpStatus: 400,
        code: "invalid_payload_type",
      });
    }
    return payload;
  }

  _requireNonEmptyField(payload, fieldName) {
    const value = normalizeInput(payload?.[fieldName]);
    if (!value) {
      throw new GenericMcpHttpAdapterError(`Field "${fieldName}" is required.`, {
        httpStatus: 400,
        code: "missing_required_field",
        details: { field: fieldName },
      });
    }
    return value;
  }

  _resolveProjectPath(projectPathValue, { sessionProjectPath = null } = {}) {
    const requested = normalizeInput(projectPathValue) || null;
    const sessionPath = normalizeInput(sessionProjectPath) || null;
    const connectedPath = normalizeInput(this._readSessionManagerStatus()?.connectedProjectPath) || null;
    return requested || sessionPath || connectedPath || this._defaultProjectPath || null;
  }

  _resolveResultProjectPath(runResult, { fallbackProjectPath = null } = {}) {
    const fromResult = normalizeInput(runResult?.session?.connectedProjectPath) || null;
    const connectedPath = normalizeInput(this._readSessionManagerStatus()?.connectedProjectPath) || null;
    const fallback = normalizeInput(fallbackProjectPath) || null;
    return fromResult || connectedPath || fallback;
  }

  _readSessionManagerStatus() {
    if (!this._sessionManager || typeof this._sessionManager.getStatus !== "function") {
      return null;
    }
    try {
      const status = this._sessionManager.getStatus();
      return isPlainObject(status) ? status : null;
    } catch {
      return null;
    }
  }

  _buildReadinessSnapshot({ expectedProjectPath = null } = {}) {
    const status = this._readSessionManagerStatus();
    if (!status) {
      return {
        available: false,
        ready: null,
        mcpClientReady: null,
        bridgeReady: null,
        connectedProjectPath: null,
        desiredProjectRoot: null,
        expectedProjectPath: normalizeInput(expectedProjectPath) || null,
        projectMatches: null,
        failurePhase: null,
        failedPhase: null,
        lastError: null,
      };
    }

    const connectedProjectPath = normalizeInput(status.connectedProjectPath) || null;
    const desiredProjectRoot = normalizeInput(status.desiredProjectRoot) || null;
    const expected = normalizeInput(expectedProjectPath) || desiredProjectRoot || null;
    const canonicalConnected = canonicalPathForCompare(connectedProjectPath);
    const canonicalExpected = canonicalPathForCompare(expected);
    const projectMatches =
      expected == null
        ? true
        : canonicalConnected != null &&
          canonicalExpected != null &&
          canonicalConnected === canonicalExpected;
    const ready = Boolean(status.mcpClientReady) && Boolean(status.bridgeReady) && Boolean(projectMatches);

    return {
      available: true,
      ready,
      mcpClientReady: Boolean(status.mcpClientReady),
      bridgeReady: Boolean(status.bridgeReady),
      connectedProjectPath,
      desiredProjectRoot,
      expectedProjectPath: expected,
      projectMatches,
      failurePhase: status.failurePhase ?? null,
      failedPhase: status.failedPhase ?? null,
      lastError: normalizeInput(status.lastError) || null,
    };
  }
}
