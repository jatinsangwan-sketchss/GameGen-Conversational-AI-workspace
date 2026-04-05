function safeString(value) {
  return value == null ? "" : String(value);
}

function isPlainObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function normalizeInput(value) {
  return safeString(value).trim();
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
    sessionStore,
    mcpConfig = null,
    defaultProjectPath = null,
    debug = false,
  } = {}) {
    if (!runner || typeof runner.run !== "function") {
      throw new Error("GenericMcpHttpAdapter requires a runner with run(...).");
    }
    if (!sessionStore || typeof sessionStore.ensureSession !== "function") {
      throw new Error("GenericMcpHttpAdapter requires a sessionStore.");
    }
    this._runner = runner;
    this._sessionStore = sessionStore;
    this._mcpConfig = mcpConfig;
    this._defaultProjectPath = normalizeInput(defaultProjectPath) || null;
    this._startedAt = Date.now();
    this._debug = Boolean(debug);
  }

  async handleRun(payload) {
    const body = this._validateObjectPayload(payload);
    const input = this._requireNonEmptyField(body, "input");
    const projectPath = this._resolveProjectPath(body.projectPath);
    const rawSessionId = normalizeInput(body.sessionId) || null;

    const session = this._sessionStore.ensureSession(rawSessionId, { projectPath });
    const runResult = await this._runner.run({
      userRequest: input,
      projectRoot: projectPath,
      mcpConfig: this._mcpConfig,
      sessionContext: {
        projectRoot: projectPath,
        sidecarSessionId: session.sessionId,
      },
      resumeNeedsInput: null,
    });

    this._sessionStore.setRunResult(session.sessionId, runResult, { projectPath });
    return this._ok({
      sessionId: session.sessionId,
      ...runResult,
    });
  }

  async handleResume(payload) {
    const body = this._validateObjectPayload(payload);
    const sessionId = this._requireNonEmptyField(body, "sessionId");
    const input = this._requireNonEmptyField(body, "input");
    const session = this._sessionStore.getSession(sessionId);
    if (!session) {
      throw new GenericMcpHttpAdapterError("Unknown sessionId for /resume.", {
        httpStatus: 404,
        code: "session_not_found",
      });
    }

    const pendingNeedsInput = this._sessionStore.getPendingNeedsInput(sessionId);
    if (!pendingNeedsInput) {
      throw new GenericMcpHttpAdapterError("No pending needs_input state for this session.", {
        httpStatus: 409,
        code: "resume_without_pending_state",
      });
    }

    const projectPath = this._resolveProjectPath(body.projectPath || session.projectPath);
    const runResult = await this._runner.run({
      userRequest: input,
      projectRoot: projectPath,
      mcpConfig: this._mcpConfig,
      sessionContext: {
        projectRoot: projectPath,
        sidecarSessionId: sessionId,
      },
      resumeNeedsInput: pendingNeedsInput,
    });

    this._sessionStore.setRunResult(sessionId, runResult, { projectPath });
    return this._ok({
      sessionId,
      ...runResult,
    });
  }

  handleHealth() {
    return this._ok({
      ok: true,
      status: "healthy",
      uptimeSeconds: Math.floor((Date.now() - this._startedAt) / 1000),
      sidecar: {
        transport: "http",
        workflowSource: "GenericMcpRunner",
      },
      sessions: this._sessionStore.getSummary(),
    });
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

  _resolveProjectPath(projectPathValue) {
    const resolved = normalizeInput(projectPathValue) || this._defaultProjectPath;
    if (!resolved) {
      throw new GenericMcpHttpAdapterError(
        'Field "projectPath" is required (or configure default project path).',
        {
          httpStatus: 400,
          code: "missing_project_path",
        }
      );
    }
    return resolved;
  }
}

