/**
 * Godot execution layer for MCP and CLI operations (v1 skeleton).
 *
 * This module isolates Godot-specific operations from planning, generation,
 * validation, and repair logic.
 *
 * Result normalization:
 * Every public executor method returns the same plain-object shape:
 * {
 *   ok, action, backend, inputs, output, error
 * }
 *
 * - MCP methods: analyzeProject/createScene/addNode/saveScene (call mcpClient)
 * - CLI methods: runProject/runCli/runHeadlessValidation (exec Godot binary)
 *
 * Extension points:
 * - Wire up a real MCP client where this executor is constructed (via `mcpClient`).
 * - Extend CLI args (e.g. setting `--main-scene`) in `runHeadlessValidation`.
 */

import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  normalizeToolKey,
  deriveSupportedOperations,
  resolveFactoryOperation,
} from "./GoPeakToolCatalog.js";
import { getGoPeakSessionManager } from "./GoPeakSessionManager.js";
import {
  operationExists,
  validateOperationParams,
  getPrimaryExecutionPath,
  getSuccessExpectations,
} from "./GoPeakOperationRegistry.js";
import {
  buildCreateSceneArgs,
  buildAddNodeArgs,
  buildSetNodePropertiesArgs,
  buildSaveSceneArgs,
  buildAttachScriptSetPropertyParams,
  buildAttachScriptSaveSceneParams,
  buildCreateScriptFileArgs,
  buildModifyScriptFileArgs,
  buildRunProjectArgs,
  buildRunProjectCliArgs,
  buildGetDebugOutputArgs,
} from "./GoPeakArgumentBuilders.js";

function normalizeResult({ ok, action, backend, inputs, output, error = null }) {
  return {
    ok: Boolean(ok),
    action,
    backend,
    inputs: inputs ?? {},
    output: output ?? {},
    error: error == null ? null : String(error),
  };
}

function safeJsonOutput(value) {
  // Keep outputs JSON-serializable where possible (important for artifact reports).
  if (value == null) return {};
  if (typeof value === "object") return value;
  return { raw: value };
}

function normalizeResPath(maybeRelOrResPath) {
  const p = String(maybeRelOrResPath ?? "").trim();
  if (!p) return null;
  if (p.startsWith("res://")) return p;
  return `res://${p.replace(/^[./]+/, "")}`;
}

const DEBUG_INGEST_URL = "http://127.0.0.1:7625/ingest/7bb5a989-4dc4-4303-8ae6-c9e2b5e6442e";
const DEBUG_SESSION_ID = "c36693";
const DEBUG_RUN_ID = process.env.DEBUG_RUN_ID ?? "attach_script_smoke";

function postAgentDebugLog({ hypothesisId, location, message, data }) {
  fetch(DEBUG_INGEST_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Debug-Session-Id": DEBUG_SESSION_ID,
    },
    body: JSON.stringify({
      sessionId: DEBUG_SESSION_ID,
      runId: DEBUG_RUN_ID,
      hypothesisId,
      location,
      message,
      data,
      timestamp: Date.now(),
    }),
  }).catch(() => {});
}

export class GodotExecutor {
  constructor({
    projectRoot,
    mcpClient = null,
    mcpClientFactory = null,
    mcpServerConfig = null,
    godotCliPath = "godot",
    defaultHeadless = true,
    defaultMainScenePath = null,
    useSharedMcpSession = true,
    sessionManager = null,
  } = {}) {
    if (projectRoot == null) {
      throw new Error("GodotExecutor requires 'projectRoot'.");
    }

    this.projectRoot = normalizeProjectRootPath(String(projectRoot), process.cwd());
    // eslint-disable-next-line no-console
    console.log(`[GodotExecutor] resolved project root`, {
      input: String(projectRoot),
      resolved: this.projectRoot,
    });
    this.mcpClient = null;
    this._mcp = null;
    this._sessionManager = sessionManager ?? getGoPeakSessionManager();
    this._mcpToolsCache = null;
    this._mcpDebug = false;

    this.godotCliPath = godotCliPath;
    this.defaultHeadless = defaultHeadless;
    this.defaultMainScenePath = defaultMainScenePath;
    this.useSharedMcpSession = Boolean(useSharedMcpSession);
    this._mcpSessionInfo = {
      owner: "GoPeakSessionManager",
      shared_enabled: this.useSharedMcpSession,
      reused: null,
      key: "backend-owned-session",
      started: false,
    };

    /** @type {Array<ReturnType<typeof normalizeResult>>} */
    this._actionHistory = [];

    // Ownership model:
    // - GoPeakSessionManager owns process startup + MCP transport lifetime.
    // - GodotExecutor adapts higher-level factory operations over that session.
    // Direct MCP launcher config args are intentionally ignored here.
    void mcpClient;
    void mcpClientFactory;
    void mcpServerConfig;
  }

  /**
   * Construct from a factory config object.
   *
   * Note: we intentionally do not create network connections here. For MCP,
   * callers should pass `mcpClient` (or a synchronous `mcpClientFactory`).
   */
  static fromConfig({ config, mcpClient = null } = {}) {
    const cfg = config ?? {};
    const projectRoot = cfg?.project_root ?? cfg?.projectRoot;
    if (typeof projectRoot !== "string" || !projectRoot.trim()) {
      throw new Error("GodotExecutor config requires non-empty project_root/projectRoot.");
    }

    const godotCliPath =
      (typeof cfg?.paths?.godot_executable === "string" && cfg.paths.godot_executable) ||
      (typeof cfg?.paths?.godot_cli === "string" && cfg.paths.godot_cli) ||
      (typeof cfg?.cli?.godot_path === "string" && cfg.cli.godot_path) ||
      "godot";

    const defaultHeadless =
      typeof cfg?.execution?.use_headless_validation === "boolean"
        ? cfg.execution.use_headless_validation
        : typeof cfg?.cli?.default_headless === "boolean"
          ? cfg.cli.default_headless
          : true;

    const defaultMainScenePath =
      typeof cfg?.execution?.main_scene_path === "string" ? cfg.execution.main_scene_path : null;
    const useSharedMcpSession =
      typeof cfg?.mcp?.use_shared_session === "boolean"
        ? cfg.mcp.use_shared_session
        : typeof cfg?.mcpUseSharedSession === "boolean"
          ? cfg.mcpUseSharedSession
          : true;

    const mcpServerConfig =
      cfg?.mcp?.server ??
      cfg?.mcp_server ??
      cfg?.mcpServer ??
      cfg?.mcp?.godot ??
      cfg?.mcp?.gopeak ??
      cfg?.godot?.mcp ??
      // Support config shape:
      // { "godot": { "command": "...", "args": [...], "env": {...}, "working_directory": "..." } }
      cfg?.godot ??
      cfg?.godot_mcp ??
      cfg?.gopeak ??
      cfg?.gopeak_mcp ??
      null;

    return new GodotExecutor({
      projectRoot,
      mcpClient,
      mcpServerConfig,
      godotCliPath,
      defaultHeadless,
      defaultMainScenePath,
      useSharedMcpSession,
    });
  }

  getMcpSessionInfo() {
    return {
      ...this._mcpSessionInfo,
      has_mcp_client: Boolean(this._sessionManager),
    };
  }

  _canonicalResult({
    ok,
    operation,
    primaryPathAttempted,
    primaryPathSucceeded,
    fallbackUsed = false,
    expectedOutcomeVerified = null,
    inputs = {},
    output = {},
    error = null,
    backend = null,
  }) {
    return this._storeAndReturn({
      ok: Boolean(ok),
      status: ok ? "success" : "failed",
      action: operation,
      operation,
      backend,
      primary_path_attempted: primaryPathAttempted ?? null,
      primary_path_succeeded: Boolean(primaryPathSucceeded),
      fallback_used: Boolean(fallbackUsed),
      expected_outcome_verified:
        expectedOutcomeVerified == null ? Boolean(ok) : Boolean(expectedOutcomeVerified),
      inputs,
      output,
      error: error == null ? null : String(error),
    });
  }

  async _resolveMcpToolFromCatalog({ operation, aliases }) {
    const listed = await this.listAvailableTools();
    if (!listed?.ok) {
      return {
        ok: false,
        error: listed?.error ?? "tool discovery unavailable",
        tool_name: null,
      };
    }
    const tools = Array.isArray(listed?.output?.tools) ? listed.output.tools : [];
    const names = tools.map((t) => safeString(t?.name)).filter(Boolean);
    // Normalize tool names into a stable key so discovery can match
    // server naming variants like hyphen_case, snake_case, and camelCase.
    const normalizedDiscoveredTools = names.map((name) => ({
      raw_tool_name: name,
      normalized_tool_key: normalizeToolKey(name),
    }));
    const byKey = new Map(names.map((n) => [normalizeToolKey(n), n]));
    // eslint-disable-next-line no-console
    console.log("[GodotExecutor] raw MCP tool normalization", {
      operation,
      discovered_tools: normalizedDiscoveredTools,
    });
    for (const alias of Array.isArray(aliases) ? aliases : []) {
      const normalizedAlias = normalizeToolKey(alias);
      const m = byKey.get(normalizedAlias);
      // eslint-disable-next-line no-console
      console.log("[GodotExecutor] MCP tool alias resolution", {
        operation,
        raw_tool_name: alias,
        normalized_tool_key: normalizedAlias,
        resolved_tool_match: m ?? null,
      });
      if (m) return { ok: true, tool_name: m };
    }
    return {
      ok: false,
      error: `unresolved_operation:${operation} missing required raw MCP tool mapping`,
      tool_name: null,
      available_tools: names,
    };
  }

  async _executeDirectMcpOperation({ operation, params }) {
    const mcpAliases = {
      analyze_project: ["get-project-health", "get_project_health", "validate-project", "validate_project"],
      create_scene: ["create-scene", "create_scene"],
      add_node: ["add-node", "add_node"],
      set_node_properties: ["set-node-properties", "set_node_properties"],
      save_scene: ["save-scene", "save_scene"],
    };
    const aliases = mcpAliases[operation] ?? [];
    const resolved = await this._resolveMcpToolFromCatalog({ operation, aliases });
    if (!resolved.ok || !resolved.tool_name) {
      return this._canonicalResult({
        ok: false,
        operation,
        backend: "mcp",
        primaryPathAttempted: "mcp_tool",
        primaryPathSucceeded: false,
        inputs: params,
        output: {
          available_tools: resolved?.available_tools ?? [],
          requested_aliases: aliases,
        },
        error: resolved?.error ?? `No MCP tool mapping for operation: ${operation}`,
      });
    }

    const translatedByOperation = {
      analyze_project: { project_root: this.projectRoot },
      create_scene: buildCreateSceneArgs(params),
      add_node: buildAddNodeArgs(params),
      set_node_properties: buildSetNodePropertiesArgs(params),
      save_scene: buildSaveSceneArgs(params),
    };
    const translated = translatedByOperation[operation] ?? {};
    const requestPayload = {
      name: resolved.tool_name,
      arguments: translated,
    };
    // eslint-disable-next-line no-console
    console.log("[GodotExecutor] canonical operation execution", {
      operation,
      primary_path: "mcp_tool",
      canonical_params: params,
      resolved_tool: resolved.tool_name,
      translated_raw_mcp_args: translated,
      final_request_payload: requestPayload,
    });
    const res = await this._runMcpAction(operation, resolved.tool_name, translated);
    return this._canonicalResult({
      ok: res?.ok === true,
      operation,
      backend: "mcp",
      primaryPathAttempted: "mcp_tool",
      primaryPathSucceeded: res?.ok === true,
      expectedOutcomeVerified: res?.ok === true,
      inputs: params,
      output: {
        translated_payload: translated,
        mcp_result: res,
      },
      error: res?.ok ? null : res?.error ?? "MCP operation failed.",
    });
  }

  async _executeAttachScriptToSceneRoot(params) {
    const setPropPayload = buildAttachScriptSetPropertyParams(params);
    const savePayload = buildAttachScriptSaveSceneParams(params);
    const setRes = await this._executeDirectMcpOperation({
      operation: "set_node_properties",
      params: setPropPayload,
    });
    if (!setRes?.ok) {
      return this._canonicalResult({
        ok: false,
        operation: "attach_script_to_scene_root",
        backend: "mcp",
        primaryPathAttempted: "composed_mcp_sequence",
        primaryPathSucceeded: false,
        inputs: params,
        output: { set_node_properties: setRes },
        error: `attach_script_to_scene_root failed at set_node_properties: ${setRes?.error ?? "unknown"}`,
      });
    }
    const saveRes = await this._executeDirectMcpOperation({
      operation: "save_scene",
      params: savePayload,
    });
    if (!saveRes?.ok) {
      return this._canonicalResult({
        ok: false,
        operation: "attach_script_to_scene_root",
        backend: "mcp",
        primaryPathAttempted: "composed_mcp_sequence",
        primaryPathSucceeded: false,
        inputs: params,
        output: { set_node_properties: setRes, save_scene: saveRes },
        error: `attach_script_to_scene_root failed at save_scene: ${saveRes?.error ?? "unknown"}`,
      });
    }
    return this._canonicalResult({
      ok: true,
      operation: "attach_script_to_scene_root",
      backend: "mcp",
      primaryPathAttempted: "composed_mcp_sequence",
      primaryPathSucceeded: true,
      expectedOutcomeVerified: true,
      inputs: params,
      output: { set_node_properties: setRes, save_scene: saveRes },
      error: null,
    });
  }

  async executeOperation(rawOperation = {}) {
    // Boundary trace: capture raw incoming operation object before destructuring.
    // eslint-disable-next-line no-console
    console.log("[GodotExecutor] raw received canonical operation object", prettyForLog(rawOperation));
    const opObj = isPlainObject(rawOperation) ? rawOperation : {};
    const action = opObj.action;
    const params = isPlainObject(opObj.params) ? opObj.params : {};
    const operation = safeString(action).trim();
    const normalizedParams = normalizeCanonicalOperationParams(operation, params);
    // eslint-disable-next-line no-console
    console.log("[GodotExecutor] requested canonical operation", {
      action: operation,
      params: prettyForLog(normalizedParams),
    });
    if (!operationExists(operation)) {
      return this._canonicalResult({
        ok: false,
        operation,
        primaryPathAttempted: null,
        primaryPathSucceeded: false,
        inputs: params,
        output: {},
        error: `unresolved_operation:${operation} not defined in GoPeakOperationRegistry`,
      });
    }

    const paramValidation = validateOperationParams(operation, normalizedParams);
    if (!paramValidation.ok) {
      return this._canonicalResult({
        ok: false,
        operation,
        primaryPathAttempted: null,
        primaryPathSucceeded: false,
        inputs: normalizedParams,
        output: { param_validation: paramValidation },
        error: paramValidation.error ?? "Invalid operation parameters.",
      });
    }

    const primaryPath = getPrimaryExecutionPath(operation);
    const expectations = getSuccessExpectations(operation);
    // eslint-disable-next-line no-console
    console.log("[GodotExecutor] resolved execution path", {
      operation,
      primary_path: primaryPath,
      success_expectations: expectations,
    });

    try {
      if (operation === "attach_script_to_scene_root") {
        return await this._executeAttachScriptToSceneRoot(normalizedParams);
      }
      if (["analyze_project", "create_scene", "add_node", "set_node_properties", "save_scene"].includes(operation)) {
        return await this._executeDirectMcpOperation({ operation, params: normalizedParams });
      }
      if (operation === "create_script_file") {
        const translated = buildCreateScriptFileArgs(normalizedParams, { projectRoot: this.projectRoot });
        fs.mkdirSync(path.dirname(translated.script_fs_path), { recursive: true });
        fs.writeFileSync(translated.script_fs_path, String(translated.content ?? ""), "utf-8");
        return this._canonicalResult({
          ok: true,
          operation,
          backend: "executor",
          primaryPathAttempted: "filesystem_write",
          primaryPathSucceeded: true,
          expectedOutcomeVerified: true,
          inputs: normalizedParams,
          output: translated,
          error: null,
        });
      }
      if (operation === "modify_script_file") {
        const translated = buildModifyScriptFileArgs(normalizedParams, { projectRoot: this.projectRoot });
        fs.mkdirSync(path.dirname(translated.script_fs_path), { recursive: true });
        fs.writeFileSync(translated.script_fs_path, String(translated.content ?? ""), "utf-8");
        return this._canonicalResult({
          ok: true,
          operation,
          backend: "executor",
          primaryPathAttempted: "filesystem_write",
          primaryPathSucceeded: true,
          expectedOutcomeVerified: true,
          inputs: normalizedParams,
          output: translated,
          error: null,
        });
      }
      if (operation === "run_project") {
        const normalized = buildRunProjectArgs(normalizedParams);
        const cliArgs = buildRunProjectCliArgs(normalized, { projectRoot: this.projectRoot });
        const res = await this.runCli({
          action: "run_project",
          cliArgs,
          timeoutSeconds: normalized.timeout_seconds ?? null,
        });
        return this._canonicalResult({
          ok: res?.ok === true,
          operation,
          backend: "cli",
          primaryPathAttempted: "cli",
          primaryPathSucceeded: res?.ok === true,
          expectedOutcomeVerified: res?.ok === true,
          inputs: normalizedParams,
          output: { cli_args: cliArgs, cli_result: res },
          error: res?.ok ? null : res?.error ?? "run_project failed",
        });
      }
      if (operation === "get_debug_output") {
        const translated = buildGetDebugOutputArgs(normalizedParams);
        const n = Number(translated.last_n);
        return this._canonicalResult({
          ok: true,
          operation,
          backend: "executor",
          primaryPathAttempted: "executor",
          primaryPathSucceeded: true,
          expectedOutcomeVerified: true,
          inputs: normalizedParams,
          output: { actions: this._actionHistory.slice(-n) },
          error: null,
        });
      }
      if (operation === "rename_project") {
        const projectName = safeString(normalizedParams?.project_name).trim();
        const projectFile = path.resolve(this.projectRoot, "project.godot");
        if (!projectName) {
          return this._canonicalResult({
            ok: false,
            operation,
            backend: "executor",
            primaryPathAttempted: "project_metadata_update",
            primaryPathSucceeded: false,
            inputs: normalizedParams,
            output: {},
            error: "Missing required parameter: project_name",
          });
        }
        if (!fs.existsSync(projectFile)) {
          return this._canonicalResult({
            ok: false,
            operation,
            backend: "executor",
            primaryPathAttempted: "project_metadata_update",
            primaryPathSucceeded: false,
            inputs: normalizedParams,
            output: { project_file: projectFile },
            error: "project.godot not found",
          });
        }
        const oldText = fs.readFileSync(projectFile, "utf-8");
        const updated = oldText.match(/^config\/name=/m)
          ? oldText.replace(/^config\/name=.*$/m, `config/name="${projectName}"`)
          : `${oldText}\n[application]\nconfig/name="${projectName}"\n`;
        fs.writeFileSync(projectFile, updated, "utf-8");
        return this._canonicalResult({
          ok: true,
          operation,
          backend: "executor",
          primaryPathAttempted: "project_metadata_update",
          primaryPathSucceeded: true,
          expectedOutcomeVerified: true,
          inputs: normalizedParams,
          output: { project_file: projectFile, project_name: projectName },
          error: null,
        });
      }
      return this._canonicalResult({
        ok: false,
        operation,
        primaryPathAttempted: primaryPath,
        primaryPathSucceeded: false,
        inputs: normalizedParams,
        output: {},
        error: `Unsupported canonical operation implementation: ${operation}`,
      });
    } catch (err) {
      return this._canonicalResult({
        ok: false,
        operation,
        primaryPathAttempted: primaryPath,
        primaryPathSucceeded: false,
        inputs: params,
        output: {},
        error: safeString(err?.message ?? err),
      });
    }
  }

  // -----------------------------
  // MCP-oriented actions
  // -----------------------------

  async analyzeProject() {
    return this.executeOperation({
      action: "analyze_project",
      params: { project_root: this.projectRoot },
    });
  }

  async createScene({ scenePath, rootType, rootName }) {
    return this.executeOperation({
      action: "create_scene",
      params: {
        scene_path: scenePath,
        root_node_name: rootName,
        root_node_type: rootType,
      },
    });
  }

  async addNode({ scenePath, nodeName, nodeType, parentPath = "." }) {
    return this.executeOperation({
      action: "add_node",
      params: {
        scene_path: scenePath,
        node_name: nodeName,
        node_type: nodeType,
        parent_path: parentPath,
      },
    });
  }

  async saveScene(rawParams = {}) {
    const normalizedParams = normalizeSaveSceneParams(rawParams);
    return this.executeOperation({
      action: "save_scene",
      params: { scene_path: normalizedParams.scenePath },
    });
  }

  /**
   * Not required by current v1 generator/validator, but included for parity with
   * earlier executor drafts.
   */
  async attachScript(rawParams = {}) {
    const normalizedParams = normalizeAttachScriptParams(rawParams);
    return this.executeOperation({
      action: "attach_script_to_scene_root",
      params: {
        scene_path: normalizedParams.scenePath,
        script_path: normalizedParams.scriptPath,
        node_path: normalizedParams.nodePath ?? ".",
        node_name: normalizedParams.nodeName ?? null,
      },
    });
  }

  /**
   * Resolve factory operation -> executable MCP tool(s) from live catalog.
   * This is discovery-first and never guesses fallback tool names.
   */
  async _resolveFactoryOperationExecution(operation) {
    const supported = await this.getSupportedOperations();
    if (!supported?.ok) {
      return {
        ok: false,
        result: this._storeAndReturn(
          normalizeResult({
            ok: false,
            action: operation,
            backend: "mcp",
            inputs: {},
            output: {},
            error: `operation resolution failed: ${supported?.error ?? "tool discovery unavailable"}`,
          })
        ),
      };
    }

    const rawTools = Array.isArray(supported?.output?.raw_tools) ? supported.output.raw_tools : [];
    const resolved = resolveFactoryOperation(rawTools, operation);
    // eslint-disable-next-line no-console
    console.log(`[GodotExecutor][MCP] resolve factory operation`, {
      requested_operation: operation,
      ok: resolved?.ok ?? false,
      mode: resolved?.mode ?? null,
      matched_tools: resolved?.matched_tools ?? [],
      reason: resolved?.reason ?? null,
    });

    if (!resolved?.ok) {
      return {
        ok: false,
        result: this._storeAndReturn(
          normalizeResult({
            ok: false,
            action: operation,
            backend: "mcp",
            inputs: {},
            output: {
              requested_operation: operation,
              resolution: resolved ?? null,
              raw_discovered_tools: rawTools.map((t) => t?.name).filter(Boolean),
            },
            error: `unresolved_operation:${operation} ${resolved?.reason ?? "no mapping from discovered catalog"}`,
          })
        ),
      };
    }

    const matchedTools = Array.isArray(resolved.matched_tools) ? resolved.matched_tools : [];
    const pick = (patterns) =>
      matchedTools.find((n) => patterns.some((re) => re.test(String(n)))) ?? null;
    const directTool = matchedTools[0] ?? null;
    const composedTools = {
      set_node_properties: pick([/set[-_]?node[-_]?properties/i]),
      save_scene: pick([/save[-_]?scene/i]),
      get_node_properties: pick([/get[-_]?node[-_]?properties/i]),
      list_scene_nodes: pick([/list[-_]?scene[-_]?nodes/i]),
    };
    if (resolved.requested_operation === "attach_script_to_scene_root") {
      if (!composedTools.set_node_properties || !composedTools.save_scene) {
        return {
          ok: false,
          result: this._storeAndReturn(
            normalizeResult({
              ok: false,
              action: operation,
              backend: "mcp",
              inputs: {},
              output: { resolution: resolved, composed_tools: composedTools },
              error:
                "unresolved_operation:attach_script missing composed tool mapping (set-node-properties/save-scene).",
            })
          ),
        };
      }
    }

    return {
      ok: true,
      mode: resolved.mode,
      direct_tool: directTool,
      composed_tools: composedTools,
      resolution: resolved,
    };
  }

  // -----------------------------
  // CLI-oriented actions
  // -----------------------------

  async runProject({ headless = null, extraArgs = null, timeoutSeconds = null } = {}) {
    // Bounded runtime validation should have deterministic "exit" semantics.
    // GoPeak's `run_project` tool is designed to run until an explicit stop,
    // which doesn't map cleanly to our bounded `--quit` contract.
    const useHeadless =
      headless === null || headless === undefined ? this.defaultHeadless : Boolean(headless);

    const args = [];
    if (useHeadless) args.push("--headless");

    // Godot should exit after starting the main scene.
    args.push("--quit");
    args.push("--path", this.projectRoot);

    if (Array.isArray(extraArgs) && extraArgs.length > 0) args.push(...extraArgs);

    return this.runCli({
      action: "run_project",
      cliArgs: args,
      timeoutSeconds,
    });
  }

  async runHeadlessValidation({
    timeoutSeconds = null,
    mainScenePath = null,
    extraArgs = null,
  } = {}) {
    // Separate action name so validators can distinguish bounded runtime vs other runs.
    const args = ["--headless", "--quit", "--path", this.projectRoot];

    const mainScene = mainScenePath ?? this.defaultMainScenePath;
    if (typeof mainScene === "string" && mainScene.trim()) {
      // Godot 4 supports `--main-scene`. If unsupported, this will surface in stderr.
      args.push("--main-scene", mainScene.trim());
    }

    if (Array.isArray(extraArgs) && extraArgs.length > 0) args.push(...extraArgs);

    return this.runCli({
      action: "headless_validation",
      cliArgs: args,
      timeoutSeconds,
    });
  }

  async runCli({ action, cliArgs, timeoutSeconds = null } = {}) {
    const commandArgs = Array.isArray(cliArgs) ? cliArgs : [];
    const inputs = {
      project_root: this.projectRoot,
      command: [this.godotCliPath, ...commandArgs],
      timeout_seconds: timeoutSeconds,
    };

    const timeoutMs = timeoutSeconds != null ? Math.max(0, Number(timeoutSeconds) * 1000) : undefined;

    try {
      const execRes = await new Promise((resolve) => {
        execFile(
          this.godotCliPath,
          commandArgs,
          { cwd: this.projectRoot, timeout: timeoutMs },
          (err, stdout, stderr) => {
            if (err) {
              const exitCode = typeof err.code === "number" ? err.code : null;
              const timedOut =
                err?.code === "ETIMEDOUT" ||
                err?.killed === true ||
                err?.signal === "SIGTERM" ||
                String(err?.message ?? "").toLowerCase().includes("timed out");
              resolve({
                stdout: stdout ?? "",
                stderr: stderr ?? "",
                exitCode,
                err,
                timedOut,
                timeoutSeconds: timeoutSeconds != null ? Number(timeoutSeconds) : null,
              });
              return;
            }
            resolve({
              stdout: stdout ?? "",
              stderr: stderr ?? "",
              exitCode: 0,
              err: null,
              timedOut: false,
              timeoutSeconds: timeoutSeconds != null ? Number(timeoutSeconds) : null,
            });
          }
        );
      });

      const { stdout, stderr, exitCode, err, timedOut = false, timeoutSeconds: timeoutSecondsFromRes } = execRes ?? {};
      const ok = exitCode === 0;
      const error = ok
        ? null
        : timedOut
          ? `Godot CLI timed out after ${timeoutSecondsFromRes ?? timeoutSeconds ?? "unknown"}s.`
          : err?.message ?? "Godot CLI exited with non-zero status.";

      return this._storeAndReturn(
        normalizeResult({
          ok,
          action,
          backend: "cli",
          inputs,
          output: {
            stdout: stdout ?? "",
            stderr: stderr ?? "",
            exit_code: exitCode ?? null,
            timed_out: Boolean(timedOut),
            timeout_seconds: timeoutSecondsFromRes ?? (timeoutSeconds != null ? Number(timeoutSeconds) : null),
          },
          error,
        })
      );
    } catch (err) {
      // Hard failures (execFile could not start).
      return this._storeAndReturn(
        normalizeResult({
          ok: false,
          action,
          backend: "cli",
          inputs,
          output: {},
          error: err,
        })
      );
    }
  }

  // -----------------------------
  // Debug / discovery helpers
  // -----------------------------

  async getDebugOutput({ lastN = 10 } = {}) {
    return this.executeOperation({
      action: "get_debug_output",
      params: { last_n: Number(lastN) },
    });
  }

  async listAvailableTools() {
    if (!this._sessionManager) {
      return this._storeAndReturn(
        normalizeResult({
          ok: false,
          action: "list_available_tools",
          backend: "mcp",
          inputs: {},
          output: { tools: [] },
          error: "GoPeakSessionManager is not configured for tool discovery.",
        })
      );
    }

    await this._ensureMcpSessionStarted();
    const listed = await this._sessionManager.listAvailableTools({ refresh: false });
    if (listed?.ok === false) {
      return this._storeAndReturn(
        normalizeResult({
          ok: false,
          action: "list_available_tools",
          backend: "mcp",
          inputs: {},
          output: { tools: [] },
          error: listed?.error ?? "Tool discovery failed.",
        })
      );
    }
    const tools = Array.isArray(listed?.tools) ? listed.tools : [];
    // Discovery is required before execution because GoPeak tool groups vary by server/profile.
    // eslint-disable-next-line no-console
    console.log(`[GodotExecutor][MCP] discovery list_available_tools`, {
      session_owner: "GoPeakSessionManager",
      page_fetch_count: listed?.page_fetch_count ?? null,
      total_tools: tools.length,
    });

    return this._storeAndReturn(
      normalizeResult({
        ok: true,
        action: "list_available_tools",
        backend: "mcp",
        inputs: {},
        output: { tools },
        error: null,
      })
    );
  }

  async findToolsByKeyword(keyword) {
    const kw = String(keyword ?? "").trim().toLowerCase();
    if (!kw) {
      return this._storeAndReturn(
        normalizeResult({
          ok: false,
          action: "find_tools_by_keyword",
          backend: "mcp",
          inputs: { keyword },
          output: { tools: [] },
          error: "findToolsByKeyword requires a non-empty keyword.",
        })
      );
    }

    const listed = await this.listAvailableTools();
    if (!listed.ok) {
      return this._storeAndReturn(
        normalizeResult({
          ok: false,
          action: "find_tools_by_keyword",
          backend: "mcp",
          inputs: { keyword: kw },
          output: { tools: [] },
          error: listed.error ?? "Tool discovery failed.",
        })
      );
    }

    const tools = Array.isArray(listed?.output?.tools) ? listed.output.tools : [];
    const filtered = tools.filter((tool) => {
      const haystack = [
        tool?.name,
        tool?.title,
        tool?.description,
        Array.isArray(tool?.tags) ? tool.tags.join(" ") : "",
      ]
        .map((v) => String(v ?? "").toLowerCase())
        .join(" ");
      return haystack.includes(kw);
    });
    // eslint-disable-next-line no-console
    console.log(`[GodotExecutor][MCP] discovery find_tools_by_keyword`, {
      keyword: kw,
      matches: filtered.length,
    });

    return this._storeAndReturn(
      normalizeResult({
        ok: true,
        action: "find_tools_by_keyword",
        backend: "mcp",
        inputs: { keyword: kw },
        output: { tools: filtered },
        error: null,
      })
    );
  }

  async getSupportedOperations() {
    const listed = await this.listAvailableTools();
    if (!listed?.ok) {
      return this._storeAndReturn(
        normalizeResult({
          ok: false,
          action: "get_supported_operations",
          backend: "mcp",
          inputs: {},
          output: { operations: [] },
          error: listed?.error ?? "Tool discovery failed.",
        })
      );
    }

    const tools = Array.isArray(listed?.output?.tools) ? listed.output.tools : [];
    const derived = deriveSupportedOperations(tools);
    const operations = Array.isArray(derived?.operations) ? derived.operations : [];
    const rawTools = Array.isArray(derived?.raw_tools) ? derived.raw_tools : [];

    // eslint-disable-next-line no-console
    console.log(`[GodotExecutor][MCP] discovery get_supported_operations`, {
      discovered_tool_count: rawTools.length,
      discovered_tool_names: rawTools.map((t) => t.name),
      enabled_operations: operations.filter((o) => o.enabled).map((o) => o.operation),
      disabled_operations: operations.filter((o) => !o.enabled).map((o) => o.operation),
      derivation: operations.map((o) => ({
        operation: o.operation,
        enabled: o.enabled,
        mode: o.mode,
        matched_tools: o.matched_tools,
      })),
    });

    return this._storeAndReturn(
      normalizeResult({
        ok: true,
        action: "get_supported_operations",
        backend: "mcp",
        inputs: {},
        output: { operations, raw_tools: rawTools, tools },
        error: null,
      })
    );
  }

  /**
   * Probe bridge readiness against currently connected GoPeak MCP session.
   * This is discovery-first: we only call tools that exist in the live catalog.
   */
  async getBridgeStatus({ expectedProjectRoot = null } = {}) {
    if (!this._sessionManager) {
      return this._storeAndReturn(
        normalizeResult({
          ok: false,
          action: "get_bridge_status",
          backend: "mcp",
          inputs: { expected_project_root: expectedProjectRoot },
          output: { isBridgeReady: false, connectedProjectPath: null, projectMatches: false },
          error: "GoPeakSessionManager is not configured.",
        })
      );
    }

    try {
      await this._ensureMcpSessionStarted();
      const expectedRootAbs = expectedProjectRoot
        ? normalizeProjectRootPath(String(expectedProjectRoot), process.cwd())
        : null;
      const waitRes = await this._sessionManager.waitForBridgeReady(expectedRootAbs, {
        timeoutMs: 1_000,
        pollMs: 250,
      });
      const connectedProjectPath = await this._sessionManager.getConnectedProjectPath();
      const normalized = normalizeResult({
        ok: Boolean(waitRes?.ok),
        action: "get_bridge_status",
        backend: "mcp",
        inputs: { expected_project_root: expectedRootAbs },
        output: {
          isBridgeReady: Boolean(waitRes?.isBridgeReady),
          connectedProjectPath: connectedProjectPath ?? waitRes?.connectedProjectPath ?? null,
          expectedProjectPath: expectedRootAbs ?? null,
          projectMatches: Boolean(waitRes?.projectMatches),
          attempts: waitRes?.attempts ?? null,
          elapsed_ms: waitRes?.elapsed_ms ?? null,
        },
        error: waitRes?.ok ? null : waitRes?.error ?? "Bridge status probe failed.",
      });
      // eslint-disable-next-line no-console
      console.log("[GodotExecutor][MCP] bridge status", {
        isBridgeReady: normalized.output?.isBridgeReady ?? false,
        connectedProjectPath: normalized.output?.connectedProjectPath ?? null,
        expectedProjectRoot: expectedRootAbs ?? null,
        projectMatches: normalized.output?.projectMatches ?? false,
        session_owner: "GoPeakSessionManager",
      });
      return this._storeAndReturn(normalized);
    } catch (err) {
      return this._storeAndReturn(
        normalizeResult({
          ok: false,
          action: "get_bridge_status",
          backend: "mcp",
          inputs: { expected_project_root: expectedProjectRoot },
          output: { isBridgeReady: false, connectedProjectPath: null, projectMatches: false },
          error: `Bridge status probe failed: ${formatMcpError(err)}`,
        })
      );
    }
  }

  /**
   * Wait for bridge readiness once at session startup. Caller should reuse this
   * executor across requests to avoid restarting MCP server/handshake repeatedly.
   */
  async waitForBridgeReady({ expectedProjectRoot = null, timeoutMs = 60_000, pollMs = 2_000 } = {}) {
    const timeout = Math.max(1_000, Number(timeoutMs) || 60_000);
    const poll = Math.max(200, Number(pollMs) || 2_000);
    const start = Date.now();
    let attempt = 0;
    let last = null;

    while (Date.now() - start < timeout) {
      attempt += 1;
      const status = await this.getBridgeStatus({ expectedProjectRoot });
      last = status;
      const isReady = status?.output?.isBridgeReady === true;
      const projectMatches = status?.output?.projectMatches === true;
      // eslint-disable-next-line no-console
      console.log("[GodotExecutor][MCP] wait bridge", {
        attempt,
        isBridgeReady: isReady,
        projectMatches,
        connectedProjectPath: status?.output?.connectedProjectPath ?? null,
      });
      if (isReady && projectMatches) {
        return this._storeAndReturn(
          normalizeResult({
            ok: true,
            action: "wait_for_bridge_ready",
            backend: "mcp",
            inputs: {
              expected_project_root: expectedProjectRoot,
              timeout_ms: timeout,
              poll_ms: poll,
            },
            output: {
              isBridgeReady: true,
              projectMatches: true,
              connectedProjectPath: status?.output?.connectedProjectPath ?? null,
              attempts: attempt,
              elapsed_ms: Date.now() - start,
            },
            error: null,
          })
        );
      }
      await sleep(poll);
    }

    return this._storeAndReturn(
      normalizeResult({
        ok: false,
        action: "wait_for_bridge_ready",
        backend: "mcp",
        inputs: {
          expected_project_root: expectedProjectRoot,
          timeout_ms: timeout,
          poll_ms: poll,
        },
        output: {
          isBridgeReady: last?.output?.isBridgeReady === true,
          projectMatches: last?.output?.projectMatches === true,
          connectedProjectPath: last?.output?.connectedProjectPath ?? null,
          attempts: attempt,
          elapsed_ms: Date.now() - start,
          last_status: last?.output ?? {},
        },
        error: "Bridge did not become ready for the requested project within timeout.",
      })
    );
  }

  // -----------------------------
  // Internals
  // -----------------------------

  async _ensureMcpSessionStarted() {
    if (!this._sessionManager || typeof this._sessionManager.ensureStarted !== "function") return null;
    const started = await this._sessionManager.ensureStarted();
    this._mcpSessionInfo = {
      ...this._mcpSessionInfo,
      owner: "GoPeakSessionManager",
      shared_enabled: true,
      reused: started?.reused ?? this._mcpSessionInfo.reused,
      started: true,
      key: "backend-owned-session",
    };
    // eslint-disable-next-line no-console
    console.log("[GodotExecutor][MCP] session-manager ownership", {
      reused_existing_session: started?.reused ?? null,
      owner: "GoPeakSessionManager",
      key: "backend-owned-session",
    });
    return started;
  }

  async _runMcpAction(action, method, params) {
    const inputs = params ?? {};

    // MCP ownership lives in GoPeakSessionManager.
    if (!this._sessionManager) {
      return this._storeAndReturn(
        normalizeResult({
          ok: false,
          action,
          backend: "mcp",
          inputs,
          output: {},
          error: "GoPeakSessionManager is not configured for this executor.",
        })
      );
    }

    try {
      await this._ensureMcpSessionStarted();
      const start = Date.now();
      const requestPayload = {
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          name: String(method),
          arguments: inputs,
        },
      };

      // #region agent log (MCP action start)
      postAgentDebugLog({
        hypothesisId: "H5_save_scene_tool_payload_or_server_contract_mismatch",
        location: "GodotExecutor.js:_runMcpAction:start",
        message: "Starting MCP action call.",
        data: {
          action,
          method,
          project_root: params?.project_root ?? null,
          scene_path: params?.scene_path ?? null,
          param_keys: isPlainObject(params) ? Object.keys(params) : [],
        },
      });
      // #endregion

      // eslint-disable-next-line no-console
      console.log(`[GodotExecutor][MCP] call ${String(method)} (${String(action)})`);
      // Always print the request payload so attach_script failures are diagnosable.
      // eslint-disable-next-line no-console
      console.log(`[GodotExecutor][MCP] request payload`, prettyForLog(requestPayload));

      const called = await this._sessionManager.callTool(String(method), inputs);
      const response = called?.raw ?? null;
      // eslint-disable-next-line no-console
      console.log(`[GodotExecutor][MCP] raw response`, prettyForLog(response));
      // #region agent log (MCP action response)
      postAgentDebugLog({
        hypothesisId: "H5_save_scene_tool_payload_or_server_contract_mismatch",
        location: "GodotExecutor.js:_runMcpAction:response",
        message: "MCP action returned response.",
        data: {
          action,
          method,
          elapsed_ms: Date.now() - start,
          response_ok: mcpToolOk(response),
          response_keys: isPlainObject(response) ? Object.keys(response) : [],
          response_error: isPlainObject(response) ? (response.error ?? null) : null,
          response_is_error: isPlainObject(response) ? (response.isError ?? null) : null,
        },
      });
      // #endregion

      if (response === null) {
        const normalized = normalizeResult({
          ok: false,
          action,
          backend: "mcp",
          inputs,
          output: {},
          error: "MCP client does not expose a callable method for this action.",
        });
        // eslint-disable-next-line no-console
        console.log(`[GodotExecutor][MCP] normalized result`, prettyForLog(normalized));
        return this._storeAndReturn(
          normalizeResult({
            ...normalized,
          })
        );
      }

      const normalized = normalizeResult({
        ok: mcpToolOk(response),
        action,
        backend: "mcp",
        inputs,
        output: safeJsonOutput(response),
        error: mcpToolOk(response) ? null : mcpToolError(response),
      });
      // Keep structured request/response trace in result for upstream debugging.
      normalized.output = {
        ...(isPlainObject(normalized.output) ? normalized.output : { value: normalized.output }),
        mcp_trace: {
          tool_name: String(method),
          request_payload: requestPayload,
          raw_response: response,
          elapsed_ms: Date.now() - start,
        },
      };
      // eslint-disable-next-line no-console
      console.log(`[GodotExecutor][MCP] normalized result`, prettyForLog(normalized));
      return this._storeAndReturn(normalized);
    } catch (err) {
      const timedOut = err?.code === "ETIMEDOUT" || err?.timeoutMs != null;
      const timeoutMs = err?.timeoutMs ?? null;
      const errMessage = formatMcpError(err);
      const errStack = typeof err?.stack === "string" ? err.stack : null;
      // eslint-disable-next-line no-console
      console.log(`[GodotExecutor][MCP] exception`, prettyForLog({
        action,
        method,
        message: errMessage,
        code: err?.code ?? null,
        stack: errStack,
      }));
      // #region agent log (MCP action exception)
      postAgentDebugLog({
        hypothesisId: "H5_save_scene_tool_payload_or_server_contract_mismatch",
        location: "GodotExecutor.js:_runMcpAction:catch",
        message: "MCP action threw exception.",
        data: {
          action,
          method,
          timed_out: timedOut,
          timeout_ms: timeoutMs,
          err_code: err?.code ?? null,
          err_message: errMessage,
        },
      });
      // #endregion
      const normalized = normalizeResult({
        ok: false,
        action,
        backend: "mcp",
        inputs,
        output: timedOut ? { timed_out: true, timeout_ms: timeoutMs } : {},
        error: timedOut
          ? `MCP call timed out after ${timeoutMs ?? "unknown"}ms: ${errMessage}`
          : `MCP call failed: ${errMessage}`,
      });
      normalized.output = {
        ...(isPlainObject(normalized.output) ? normalized.output : { value: normalized.output }),
        mcp_trace: {
          tool_name: String(method),
          request_payload: {
            jsonrpc: "2.0",
            method: "tools/call",
            params: { name: String(method), arguments: inputs },
          },
          raw_response: null,
          exception: {
            message: errMessage,
            code: err?.code ?? null,
            stack: errStack,
          },
        },
      };
      // eslint-disable-next-line no-console
      console.log(`[GodotExecutor][MCP] normalized result`, prettyForLog(normalized));
      return this._storeAndReturn(normalized);
    }
  }

  _storeAndReturn(result) {
    this._actionHistory.push(result);
    return result;
  }
}

function isPlainObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function mcpToolOk(toolResult) {
  if (!toolResult || typeof toolResult !== "object") return true;
  if (toolResult.ok === false) return false;
  if (toolResult.isError === true) return false;
  if (toolResult.error != null) return false;
  return true;
}

function mcpToolError(toolResult) {
  if (!toolResult || typeof toolResult !== "object") return "MCP tool reported failure.";
  return safeString(toolResult.error ?? toolResult.message ?? "MCP tool reported failure.");
}

function formatMcpError(err) {
  if (err == null) return "Unknown error";
  if (typeof err === "string") return err;
  if (typeof err === "object") {
    if (err.message) return String(err.message);
    if (err.error) return safeString(err.error);
    try {
      return JSON.stringify(err);
    } catch {
      return safeString(err);
    }
  }
  return safeString(err);
}

function prettyForLog(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function normalizeAttachScriptParams(rawParams) {
  const params = isPlainObject(rawParams) ? rawParams : {};
  return {
    scenePath: params.scenePath ?? params.scene_path ?? null,
    nodeName: params.nodeName ?? params.node_name ?? null,
    nodePath: params.nodePath ?? params.node_path ?? null,
    scriptPath: params.scriptPath ?? params.script_path ?? null,
  };
}

function normalizeCreateSceneParams(rawParams) {
  const params = isPlainObject(rawParams) ? rawParams : {};
  return {
    scenePath: params.scenePath ?? params.scene_path ?? null,
    rootType: params.rootType ?? params.root_type ?? params.root_node_type ?? null,
    rootName: params.rootName ?? params.root_name ?? params.root_node_name ?? null,
  };
}

function normalizeAddNodeParams(rawParams) {
  const params = isPlainObject(rawParams) ? rawParams : {};
  return {
    scenePath: params.scenePath ?? params.scene_path ?? null,
    nodeName: params.nodeName ?? params.node_name ?? null,
    nodeType: params.nodeType ?? params.node_type ?? null,
    parentPath: params.parentPath ?? params.parent_path ?? ".",
  };
}

function normalizeCanonicalOperationParams(operation, rawParams) {
  const params = isPlainObject(rawParams) ? { ...rawParams } : {};
  if (operation === "create_scene") {
    if (params.root_node_name == null && params.root_name != null) params.root_node_name = params.root_name;
    if (params.root_node_type == null && params.root_type != null) params.root_node_type = params.root_type;
  }
  if (operation === "attach_script_to_scene_root") {
    if (params.node_path == null && params.node_name != null) params.node_path = params.node_name;
  }
  return params;
}

function normalizeSaveSceneParams(rawParams) {
  const params = isPlainObject(rawParams) ? rawParams : {};
  return {
    scenePath: params.scenePath ?? params.scene_path ?? null,
  };
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function validateCreateSceneInputs(params) {
  const errors = [];
  if (!isNonEmptyString(params?.scenePath)) errors.push("scene_path/scenePath is required.");
  if (!isNonEmptyString(params?.rootName)) errors.push("root_node_name/rootName is required.");
  if (!isNonEmptyString(params?.rootType)) errors.push("root_node_type/rootType is required.");
  return {
    ok: errors.length === 0,
    error: errors.length > 0 ? `Invalid create_scene arguments: ${errors.join(" ")}` : null,
    errors,
  };
}

function validateAddNodeInputs(params) {
  const errors = [];
  if (!isNonEmptyString(params?.scenePath)) errors.push("scene_path/scenePath is required.");
  if (!isNonEmptyString(params?.nodeName)) errors.push("node_name/nodeName is required.");
  if (!isNonEmptyString(params?.nodeType)) errors.push("node_type/nodeType is required.");
  return {
    ok: errors.length === 0,
    error: errors.length > 0 ? `Invalid add_node arguments: ${errors.join(" ")}` : null,
    errors,
  };
}

function validateSaveSceneInputs(params) {
  const errors = [];
  if (!isNonEmptyString(params?.scenePath)) errors.push("scene_path/scenePath is required.");
  return {
    ok: errors.length === 0,
    error: errors.length > 0 ? `Invalid save_scene arguments: ${errors.join(" ")}` : null,
    errors,
  };
}

function validateAttachScriptInputs(params) {
  const errors = [];
  if (!isNonEmptyString(params?.scenePath)) errors.push("scene_path/scenePath is required.");
  if (!isNonEmptyString(params?.scriptPath)) errors.push("script_path/scriptPath is required.");
  return {
    ok: errors.length === 0,
    error: errors.length > 0 ? `Invalid attach_script arguments: ${errors.join(" ")}` : null,
    errors,
  };
}

function safeString(v) {
  return v == null ? "" : String(v);
}

function parseBoolLike(value, defaultValue = false) {
  if (value == null) return defaultValue;
  if (typeof value === "boolean") return value;
  const s = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(s)) return true;
  if (["0", "false", "no", "off"].includes(s)) return false;
  return defaultValue;
}

function resolveGodotMcpServerConfig({ mcpServerConfig, processEnv }) {
  if (!mcpServerConfig || mcpServerConfig === false) return null;
  const merged = isPlainObject(mcpServerConfig) ? mcpServerConfig : {};

  // GoPeak startup is config-driven only: no hardcoded package fallback.
  const command = typeof merged.command === "string" ? merged.command.trim() : "";
  const args = Array.isArray(merged.args) ? merged.args : [];
  if (!command || args.length === 0) return null;

  const debug =
    merged.debug != null
      ? parseBoolLike(merged.debug, false)
      : parseBoolLike(merged?.env?.DEBUG, false);

  const workingDirectoryRaw =
    merged.working_directory ??
    merged.workingDirectory ??
    null;
  const workingDirectory =
    workingDirectoryRaw == null || String(workingDirectoryRaw).trim() === ""
      ? null
      : String(workingDirectoryRaw);

  const env = {
    ...processEnv,
    ...(merged.env && typeof merged.env === "object" ? merged.env : {}),
    // Keep DEBUG off by default for stdio safety unless explicitly enabled.
    DEBUG: debug ? "true" : "false",
  };

  const requestTimeoutMsRaw =
    merged.requestTimeoutMs ??
    merged.request_timeout_ms ??
    null;
  const requestTimeoutSecondsRaw =
    merged.requestTimeoutSeconds ??
    merged.request_timeout_seconds ??
    null;

  let requestTimeoutMs = 120_000;
  if (requestTimeoutMsRaw != null && String(requestTimeoutMsRaw).trim() !== "") {
    requestTimeoutMs = Number(requestTimeoutMsRaw);
  } else if (
    requestTimeoutSecondsRaw != null &&
    String(requestTimeoutSecondsRaw).trim() !== ""
  ) {
    requestTimeoutMs = Number(requestTimeoutSecondsRaw) * 1000;
  }

  return {
    enabled: true,
    command,
    args,
    env,
    debug,
    workingDirectory,
    requestTimeoutMs: Number.isFinite(requestTimeoutMs) ? requestTimeoutMs : 120_000,
  };
}

function loadDefaultMcpConfigFile() {
  try {
    const thisFile = fileURLToPath(import.meta.url);
    const thisDir = path.dirname(thisFile);
    // GodotExecutor.js is at:
    //   backend/factory-js/src/godot/GodotExecutor.js
    // so mcp.config.json lives at:
    //   backend/factory-js/mcp.config.json
    const configPath = path.resolve(thisDir, "../../mcp.config.json");

    if (!fs.existsSync(configPath)) return null;
    const raw = fs.readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    return parsed.godot ?? parsed.mcp?.server ?? parsed.mcpServer ?? null;
  } catch {
    // If config cannot be read, keep MCP disabled rather than guessing.
    return null;
  }
}

/**
 * Minimal MCP client over stdio transport.
 *
 * Responsibilities:
 * - spawn an MCP server process
 * - speak JSON-RPC using MCP's stdio framing
 * - implement `callTool(toolName, params)` and nothing else
 *
 * Extension point:
 * - We can later support resources, subscriptions, and richer progress events
 *   by extending the internal client. For v1 generation/edit mode, tools are enough.
 */
class GodotMcpStdioClient {
  constructor({ command, args, env, workingDirectory = null, debug = false, requestTimeoutMs = 120_000 } = {}) {
    if (!command) throw new Error("GodotMcpStdioClient requires a command.");
    this.command = command;
    this.args = Array.isArray(args) ? args : [];
    this.env = env ?? process.env;
    this.workingDirectory = workingDirectory;
    this.debug = debug;
    this.requestTimeoutMs = requestTimeoutMs;

    this._proc = null;
    this._connected = false;
    this._initPromise = null;
    this._nextId = 1;
    this._pending = new Map();
    // MCP stdio framing (JSON-RPC over newline-delimited stdio).
    // - continuous byte stream
    // - each JSON-RPC message is newline-delimited
    this._buffer = Buffer.alloc(0);
    this._toolsListed = false;
    /** @type {string[]} */
    this._toolNames = [];
  }

  async ensureConnected() {
    if (this._connected) return;
    if (this._initPromise) return this._initPromise;

    this._initPromise = this._connectAndInit();
    return this._initPromise;
  }

  async _connectAndInit() {
    if (this._connected) return;

    if (this.debug) {
      // eslint-disable-next-line no-console
      console.log(`[GodotExecutor][MCP] starting server: ${this.command} ${this.args.join(" ")}`, {
        cwd: this.workingDirectory ?? null,
      });
    }

    // #region agent log (server spawn command)
    postAgentDebugLog({
      hypothesisId: "H3_server_spawn_or_init_handshake_issue",
      location: "GodotExecutor.js:G—MCP:_connectAndInit:spawn",
      message: "Spawning MCP server process (stdio).",
      data: { command: this.command, args: this.args, cwd: this.workingDirectory ?? null },
    });
    // #endregion

    this._proc = spawn(this.command, this.args, {
      env: this.env,
      cwd: this.workingDirectory ?? undefined,
      stdio: ["pipe", "pipe", "pipe"],
    });

    this._proc.stdout.on("data", (chunk) => this._handleData(chunk));
    this._proc.stderr.on("data", (chunk) => {
      if (this.debug) {
        // eslint-disable-next-line no-console
        console.log(`[GodotExecutor][MCP][stderr] ${chunk.toString("utf-8").trim()}`);
      }
    });

    this._proc.on("exit", (code) => {
      for (const [, pending] of this._pending.entries()) {
        pending.reject(new Error(`MCP server exited with code ${code ?? "unknown"}`));
      }
      this._pending.clear();
      this._connected = false;
    });

    // 1) initialize
    // #region agent log (initialize request)
    postAgentDebugLog({
      hypothesisId: "H1_initialize_timeout_or_server_not_ready",
      location: "GodotExecutor.js:G—MCP:_connectAndInit:before_initialize",
      message: "Sending MCP initialize request.",
      data: { protocolVersion: "2024-11-05" },
    });
    // #endregion

    const initRes = await this._requestRaw("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {
        // Keep minimal; the server should still reply with its capabilities.
        tools: { listChanged: true },
      },
      clientInfo: { name: "factory-js", version: "0.1.0" },
    });

    // 2) initialized notification
    this._sendNotification("notifications/initialized", {
      initialized: true,
      // Some MCP servers ignore extra params; this is safe best-effort.
      serverCapabilities: initRes?.capabilities ?? null,
    });

    // 3) tools/list discovery (best-effort; cached, paginated)
    try {
      const toolsList = await this._fetchAllToolsCatalogRaw({ skipEnsureConnected: true });
      this._toolsListed = true;
      this._cachedToolsList = toolsList ?? null;
      this._toolNames = extractToolNamesFromToolsList(toolsList);
      if (this.debug) {
        const tools = extractToolEntries(toolsList);
        const names = Array.isArray(tools) ? tools.map((t) => t?.name).filter(Boolean) : [];
        // eslint-disable-next-line no-console
        console.log(`[GodotExecutor][MCP] tools/list names: ${names.join(", ")}`, {
          page_fetch_count: toolsList?.page_fetch_count ?? null,
        });
      }
    } catch (err) {
      if (this.debug) {
        // eslint-disable-next-line no-console
        console.log(`[GodotExecutor][MCP] tools/list failed (continuing): ${String(err?.message ?? err)}`);
      }
    }

    this._connected = true;
  }

  _handleData(chunk) {
    this._buffer = Buffer.concat([this._buffer, chunk]);

    while (true) {
      // newline-delimited JSON-RPC (see MCP SDK stdio.js: reads until '\n')
      const newlineIdx = this._buffer.indexOf(10); // '\n'
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

      if (!msg) continue;
      this._dispatchMessage(msg);
    }
  }

  _dispatchMessage(msg) {
    // JSON-RPC response
    if (msg.id != null && (msg.result != null || msg.error != null)) {
      const pending = this._pending.get(msg.id);
      if (pending) {
        this._pending.delete(msg.id);
        if (msg.error) pending.reject(msg.error);
        else pending.resolve(msg.result);
      }
      return;
    }

    // JSON-RPC notifications: ignore for now.
  }

  _sendNotification(method, params) {
    if (!this._proc || !this._proc.stdin.writable) {
      throw new Error("MCP process is not writable.");
    }

    const payload = {
      jsonrpc: "2.0",
      method,
      ...(params !== undefined ? { params } : {}),
    };

    const json = JSON.stringify(payload);
    // MCP SDK stdio framing: newline-delimited JSON-RPC.
    this._proc.stdin.write(json + "\n");
  }

  async _request(method, params) {
    await this.ensureConnected();
    return this._requestRaw(method, params);
  }

  _requestRaw(method, params) {
    const id = this._nextId++;
    const payload = { jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) };
    const json = JSON.stringify(payload);

    const promise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this._pending.delete(id);
        // #region agent log (MCP request timeout)
        postAgentDebugLog({
          hypothesisId: "H4_mcp_request_or_framing_timeout",
          location: "GodotExecutor.js:G—MCP:_requestRaw:timeout",
          message: "MCP JSON-RPC request timed out.",
          data: { method, id, requestTimeoutMs: this.requestTimeoutMs },
        });
        // #endregion
        const err = new Error(`MCP request timeout: ${method} (${id})`);
        // Tag the error so the executor can attribute timeouts to steps.
        err.code = "ETIMEDOUT";
        err.timeoutMs = this.requestTimeoutMs;
        err.mcpMethod = method;
        err.mcpRequestId = id;
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

    // MCP SDK stdio framing: newline-delimited JSON-RPC.
    this._proc.stdin.write(json + "\n");
    return promise;
  }

  async callTool(name, args) {
    await this.ensureConnected();

    // Tool call uses MCP's generic shape:
    // tools/call { name: <toolName>, arguments: { ... } }
    const toolResult = await this._request("tools/call", {
      name: String(name),
      arguments: args ?? {},
    });

    // The JSON-RPC result may already be the toolResult content; pass through.
    return toolResult ?? {};
  }

  async getToolNames() {
    await this.getToolsCatalog();
    return Array.isArray(this._toolNames) ? this._toolNames : [];
  }

  async getToolsCatalog() {
    await this.ensureConnected();
    if (this._cachedToolsList) return this._cachedToolsList;
    const toolsList = await this._fetchAllToolsCatalogRaw();
    this._cachedToolsList = toolsList ?? null;
    this._toolNames = extractToolNamesFromToolsList(toolsList);
    return this._cachedToolsList;
  }

  async _fetchAllToolsCatalogRaw({ skipEnsureConnected = false } = {}) {
    if (!skipEnsureConnected) {
      await this.ensureConnected();
    }
    const pages = [];
    const seenCursors = new Set();
    let cursor = null;
    let pageCount = 0;

    // GoPeak can paginate tools/list; fetch until no next cursor.
    while (true) {
      const params = cursor ? { cursor } : {};
      const page = await this._requestRaw("tools/list", params);
      pageCount += 1;
      pages.push(page);

      const nextCursor = extractNextToolsCursor(page);
      if (!nextCursor || seenCursors.has(nextCursor)) break;
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }

    const allEntries = [];
    for (const page of pages) {
      allEntries.push(...extractToolEntries(page));
    }
    const dedupedEntries = dedupeToolsByName(allEntries);
    const merged = {
      tools: dedupedEntries,
      page_fetch_count: pageCount,
      pagination: {
        paginated: pageCount > 1,
      },
    };

    if (this.debug) {
      // eslint-disable-next-line no-console
      console.log(`[GodotExecutor][MCP] tools/list pagination`, {
        page_fetch_count: pageCount,
        total_tools: dedupedEntries.length,
      });
    }
    return merged;
  }
}

// Shared MCP session registry (process-local):
// bridge-based workflows can break when multiple GoPeak server processes exist
// and the editor is connected to a different one. Reuse avoids that split-brain.
const SHARED_MCP_CLIENTS = globalThis.__FACTORY_JS_SHARED_GOPEAK_CLIENTS__ ?? new Map();
if (!globalThis.__FACTORY_JS_SHARED_GOPEAK_CLIENTS__) {
  globalThis.__FACTORY_JS_SHARED_GOPEAK_CLIENTS__ = SHARED_MCP_CLIENTS;
}

function getOrCreateSharedMcpClient({ command, args, env, workingDirectory, debug, requestTimeoutMs }) {
  const key = buildSharedMcpSessionKey({ command, args, env, workingDirectory, requestTimeoutMs });
  const existing = SHARED_MCP_CLIENTS.get(key);
  if (existing?.client) {
    return { client: existing.client, reused: true, key };
  }
  const client = new GodotMcpStdioClient({
    command,
    args,
    env,
    workingDirectory,
    debug,
    requestTimeoutMs,
  });
  SHARED_MCP_CLIENTS.set(key, { client, createdAt: Date.now() });
  return { client, reused: false, key };
}

function buildSharedMcpSessionKey({ command, args, env, workingDirectory, requestTimeoutMs }) {
  const profile = safeString(env?.GOPEAK_TOOL_PROFILE).trim();
  const page = safeString(env?.GOPEAK_TOOLS_PAGE_SIZE).trim();
  return JSON.stringify({
    command: safeString(command),
    args: Array.isArray(args) ? args : [],
    cwd: safeString(workingDirectory),
    requestTimeoutMs: Number(requestTimeoutMs) || 120000,
    profile,
    page,
  });
}

function extractToolNamesFromToolsList(toolsList) {
  const tools =
    toolsList?.tools ??
    toolsList?.data?.tools ??
    toolsList?.result?.tools ??
    toolsList?.items ??
    [];
  if (!Array.isArray(tools)) return [];
  const names = tools.map((t) => t?.name).filter(Boolean).map(String);
  // Deduplicate while preserving order.
  const seen = new Set();
  const out = [];
  for (const n of names) {
    if (seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

function resolveScenePathBundle({ projectRoot, scenePath }) {
  const sceneResPath = normalizeResPath(scenePath);
  const sceneFsRel = String(sceneResPath ?? "")
    .replace(/^res:\/\//, "")
    .replace(/^\/+/, "");
  const sceneAbs = path.resolve(projectRoot, sceneFsRel);
  return { sceneResPath, sceneFsRel, sceneAbs };
}

function normalizeProjectRootPath(projectRootInput, cwd) {
  const raw = String(projectRootInput ?? "").trim();
  const base = cwd || process.cwd();
  const direct = path.resolve(base, raw);
  if (fs.existsSync(direct)) return direct;

  // Common caller mistake: running from backend/ and passing ./backend/... .
  const backendDup = `${path.sep}backend${path.sep}backend${path.sep}`;
  if (direct.includes(backendDup)) {
    const collapsed = direct.replace(backendDup, `${path.sep}backend${path.sep}`);
    if (fs.existsSync(collapsed)) return collapsed;
  }
  if (path.basename(base) === "backend" && (raw.startsWith("./backend/") || raw.startsWith("backend/"))) {
    const stripped = raw.replace(/^\.?\/?backend\//, "");
    const candidate = path.resolve(base, stripped);
    if (fs.existsSync(candidate)) return candidate;
  }
  return direct;
}

function extractToolEntries(toolsList) {
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
    const name = safeString(entry?.name);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(entry);
  }
  return out;
}

function extractNextToolsCursor(toolsList) {
  const candidates = [
    toolsList?.nextCursor,
    toolsList?.next_cursor,
    toolsList?.cursor,
    toolsList?.next,
    toolsList?.pagination?.nextCursor,
    toolsList?.pagination?.next_cursor,
    toolsList?.pagination?.next,
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
  const entries = extractToolEntries(toolsList);
  const out = [];
  for (const entry of entries) {
    const name = entry?.name != null ? String(entry.name) : "";
    if (!name) continue;
    out.push({
      name,
      title: entry?.title != null ? String(entry.title) : null,
      description: entry?.description != null ? String(entry.description) : null,
      tags: Array.isArray(entry?.tags) ? entry.tags.map((t) => String(t)) : [],
      input_schema: isPlainObject(entry?.inputSchema)
        ? entry.inputSchema
        : isPlainObject(entry?.input_schema)
          ? entry.input_schema
          : null,
    });
  }
  return out;
}

function pickBridgeProbeToolName(toolNames) {
  const names = Array.isArray(toolNames) ? toolNames.map((n) => String(n)) : [];
  if (names.length === 0) return null;
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

function normalizeBridgeProbeResult({ probeResult, expectedProjectRoot, probeTool }) {
  const output = isPlainObject(probeResult?.output) ? probeResult.output : {};
  const raw = output?.mcp_trace?.raw_response ?? output;
  const flattenedText = safeString(tryJsonStringify(raw)).toLowerCase();
  const disconnectedHint =
    flattenedText.includes("not connected") ||
    flattenedText.includes("editor is not connected") ||
    flattenedText.includes("bridge not ready");
  const connectedHint =
    flattenedText.includes("connected") ||
    flattenedText.includes("bridge ready") ||
    flattenedText.includes("\"ok\":true");
  const explicitConnected = pickBooleanDeep(raw, [
    "connected",
    "is_connected",
    "isConnected",
    "editor_connected",
    "editorConnected",
    "bridge_ready",
    "bridgeReady",
  ]);
  const connectedProjectPath = pickStringDeep(raw, [
    "project_path",
    "projectPath",
    "project_root",
    "projectRoot",
    "path",
  ]);

  const connectedProjectAbs = connectedProjectPath
    ? normalizeProjectRootPath(String(connectedProjectPath), process.cwd())
    : null;
  const expectedProjectAbs = expectedProjectRoot
    ? normalizeProjectRootPath(String(expectedProjectRoot), process.cwd())
    : null;
  const projectMatches =
    expectedProjectAbs == null ? true : connectedProjectAbs != null && connectedProjectAbs === expectedProjectAbs;
  const isBridgeReady = explicitConnected != null
    ? explicitConnected === true
    : disconnectedHint
      ? false
      : connectedHint;

  return normalizeResult({
    ok: Boolean(probeResult?.ok) && isBridgeReady && projectMatches,
    action: "get_bridge_status",
    backend: "mcp",
    inputs: {
      expected_project_root: expectedProjectAbs,
      probe_tool: probeTool,
    },
    output: {
      isBridgeReady: Boolean(isBridgeReady),
      connectedProjectPath: connectedProjectAbs,
      expectedProjectPath: expectedProjectAbs,
      projectMatches: Boolean(projectMatches),
      probe_tool: probeTool,
      bridge_probe_ok: Boolean(probeResult?.ok),
      bridge_probe_error: probeResult?.error ?? null,
    },
    error:
      !isBridgeReady
        ? "Godot editor bridge is not ready."
        : !projectMatches
          ? `Connected project does not match requested root. connected=${connectedProjectAbs ?? "unknown"} expected=${expectedProjectAbs ?? "unknown"}`
          : probeResult?.error ?? null,
  });
}

function pickBooleanDeep(obj, keys) {
  for (const key of keys) {
    const v = findKeyDeep(obj, key);
    if (typeof v === "boolean") return v;
    if (typeof v === "string") {
      const s = v.trim().toLowerCase();
      if (["true", "1", "yes"].includes(s)) return true;
      if (["false", "0", "no"].includes(s)) return false;
    }
  }
  return null;
}

function pickStringDeep(obj, keys) {
  for (const key of keys) {
    const v = findKeyDeep(obj, key);
    if (v == null) continue;
    const s = String(v).trim();
    if (s) return s;
  }
  return null;
}

function findKeyDeep(obj, key) {
  if (obj == null || typeof obj !== "object") return undefined;
  if (Object.prototype.hasOwnProperty.call(obj, key)) return obj[key];
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const found = findKeyDeep(item, key);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  for (const v of Object.values(obj)) {
    const found = findKeyDeep(v, key);
    if (found !== undefined) return found;
  }
  return undefined;
}

function tryJsonStringify(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value ?? "");
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

async function runMcpPayloadVariants({ run, variants, label }) {
  const attempted = [];
  let lastResult = null;
  for (let i = 0; i < variants.length; i += 1) {
    const params = variants[i] ?? {};
    // eslint-disable-next-line no-console
    console.log(`[GodotExecutor][MCP] ${label} payload variant #${i + 1}`, prettyForLog(params));
    const res = await run(params);
    lastResult = res;
    attempted.push({
      variant_index: i + 1,
      ok: Boolean(res?.ok),
      error: res?.error ?? null,
      backend: res?.backend ?? null,
    });
    if (res?.ok) return res;
  }
  if (lastResult && isPlainObject(lastResult)) {
    lastResult.output = {
      ...(isPlainObject(lastResult.output) ? lastResult.output : {}),
      attempted_variants: attempted,
    };
    return lastResult;
  }
  return normalizeResult({
    ok: false,
    action: label,
    backend: "mcp",
    inputs: {},
    output: { attempted_variants: attempted },
    error: `${label} failed for all payload variants.`,
  });
}

function tryReadRootNodeName(sceneAbsPath) {
  try {
    if (!sceneAbsPath || typeof sceneAbsPath !== "string") return null;
    if (!fs.existsSync(sceneAbsPath)) return null;
    if (!fs.statSync(sceneAbsPath).isFile()) return null;

    const raw = fs.readFileSync(sceneAbsPath, "utf-8");
    // Scene root is the first node header in a .tscn.
    const m = raw.match(/\[node\s+name="([^"]+)"\s+type="/);
    if (!m || !m[1]) return null;
    return String(m[1]);
  } catch {
    return null;
  }
}

