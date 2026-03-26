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
  } = {}) {
    if (projectRoot == null) {
      throw new Error("GodotExecutor requires 'projectRoot'.");
    }

    this.projectRoot = path.resolve(String(projectRoot));
    this.mcpClient = mcpClient;
    this._mcp = null;
    this._mcpToolsCache = null;
    this._mcpDebug = false;

    this.godotCliPath = godotCliPath;
    this.defaultHeadless = defaultHeadless;
    this.defaultMainScenePath = defaultMainScenePath;

    /** @type {Array<ReturnType<typeof normalizeResult>>} */
    this._actionHistory = [];

    // Optional: allow a config-driven mcpClientFactory to be injected by the caller.
    if (!this.mcpClient && typeof mcpClientFactory === "function") {
      this.mcpClient = mcpClientFactory({ projectRoot: this.projectRoot }) ?? null;
    }

    // If the caller didn't inject an mcpClient, attempt an internal
    // stdio transport to the configured Godot MCP server.
    if (!this.mcpClient) {
      // Default MCP launch configuration is loaded from:
      //   backend/factory-js/mcp.config.json
      // (so we keep tool/server settings out of code).
      const fileConfig = mcpServerConfig ?? loadDefaultMcpConfigFile();
      const resolved = resolveGodotMcpServerConfig({
        mcpServerConfig: fileConfig ?? null,
        processEnv: process.env,
      });

      if (resolved?.enabled) {
        this._mcpDebug = Boolean(resolved.debug);
        this._mcp = new GodotMcpStdioClient({
          command: resolved.command,
          args: resolved.args,
          env: resolved.env,
          workingDirectory: resolved.workingDirectory ?? null,
          debug: this._mcpDebug,
          requestTimeoutMs: resolved.requestTimeoutMs ?? 120_000,
        });

        // Maintain the external contract expected by _runMcpAction:
        // { call: (toolName, params) => Promise<toolResult> }
        this.mcpClient = {
          call: (toolName, params) => this._mcp.callTool(toolName, params),
        };
      }
    }
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
    });
  }

  // -----------------------------
  // MCP-oriented actions
  // -----------------------------

  async analyzeProject() {
    const tool = await this._resolveGoPeakToolName({
      action: "analyze_project",
      candidates: ["get_project_health", "validate_project"],
      regexes: [/^get_project_health$/i, /^validate_project$/i, /project.*health/i],
    });
    return this._runMcpAction("analyze_project", tool, { projectPath: this.projectRoot });
  }

  async createScene({ scenePath, rootType, rootName }) {
    const tool = await this._resolveGoPeakToolName({
      action: "create_scene",
      candidates: ["create_scene"],
      regexes: [/create_scene/i],
    });
    const sceneResPath = normalizeResPath(scenePath);
    const inputs = {
      scene_path: sceneResPath,
      root_node_type: rootType,
      ...(typeof rootName === "string" && rootName.trim()
        ? { root_node_name: rootName }
        : {}),
      nodes: [],
    };

    // eslint-disable-next-line no-console
    console.log(
      `[GodotExecutor][MCP] create_scene: scene=${sceneResPath} root=${rootName} type=${rootType}`
    );

    return this._runMcpAction("create_scene", tool, inputs);
  }

  async addNode({ scenePath, nodeName, nodeType, parentPath = "." }) {
    const tool = await this._resolveGoPeakToolName({
      action: "add_node",
      candidates: ["add_node"],
      regexes: [/add_node/i],
    });

    const sceneResPath = normalizeResPath(scenePath);
    const sceneFsRel = String(sceneResPath ?? "")
      .replace(/^res:\/\//, "")
      .replace(/^\/+/, "");
    const sceneAbs = path.resolve(this.projectRoot, sceneFsRel);
    const rootNodeName = tryReadRootNodeName(sceneAbs);

    let parentPathForTool = parentPath ?? ".";
    if (parentPathForTool === "" || parentPathForTool === ".") parentPathForTool = ".";
    if (rootNodeName && parentPathForTool === rootNodeName) parentPathForTool = ".";

    // eslint-disable-next-line no-console
    console.log(
      `[GodotExecutor][MCP] add_node: scene=${sceneResPath} node=${nodeName} type=${nodeType} parent=${parentPathForTool}`
    );

    return this._runMcpAction("add_node", tool, {
      scene_path: sceneResPath,
      node_name: nodeName,
      node_type: nodeType,
      parent_path: parentPathForTool,
    });
  }

  async saveScene({ scenePath }) {
    const sceneResPath = normalizeResPath(scenePath);

    // tomyud1's godot-mcp scene tools typically auto-save inside
    // create_scene/add_node/attach_script, but we still expose saveScene()
    // to match the factory executor contract.
    const sceneFsRel = String(sceneResPath ?? "")
      .replace(/^res:\/\//, "")
      .replace(/^\/+/, "");
    const sceneAbs = path.resolve(this.projectRoot, sceneFsRel);
    const exists = fs.existsSync(sceneAbs) && fs.statSync(sceneAbs).isFile();
    if (!exists) {
      return this._storeAndReturn(
        normalizeResult({
          ok: false,
          action: "save_scene",
          backend: "executor",
          inputs: { scene_path: sceneResPath },
          output: {},
          error: `Scene does not exist: ${sceneAbs}`,
        })
      );
    }

    // If a dedicated save_scene tool exists in the MCP catalog, call it;
    // otherwise treat saveScene as a no-op verification step.
    try {
      if (this._mcp) {
        const toolNames = await this._mcp.getToolNames();
        if (Array.isArray(toolNames) && toolNames.includes("save_scene")) {
          // eslint-disable-next-line no-console
          console.log(`[GodotExecutor][MCP] save_scene: scene=${sceneResPath}`);
          const mcpRes = await this._runMcpAction("save_scene", "save_scene", {
            scene_path: sceneResPath,
          });
          if (mcpRes?.ok) return mcpRes;
        }
      }
    } catch {
      // Ignore tool-catalog errors and keep the filesystem verification result.
    }

    // eslint-disable-next-line no-console
    console.log(`[GodotExecutor] save_scene: MCP tool not found (no-op), scene exists.`);
    return this._storeAndReturn(
      normalizeResult({
        ok: true,
        action: "save_scene",
        backend: "executor",
        inputs: { scene_path: sceneResPath },
        output: { changed: false, skipped: true, reason: "Assumed auto-saved by scene tools." },
        error: null,
      })
    );
  }

  /**
   * Not required by current v1 generator/validator, but included for parity with
   * earlier executor drafts.
   */
  async attachScript({ scenePath, nodeName, scriptPath }) {
    const sceneResPath = normalizeResPath(scenePath);
    const scriptResPath = normalizeResPath(scriptPath);

    const inputs = {
      scene_path: sceneResPath,
      node_name: nodeName,
      script_path: scriptResPath,
    };

    if (!sceneResPath || !scriptResPath) {
      return this._storeAndReturn(
        normalizeResult({
          ok: false,
          action: "attach_script",
          backend: "executor",
          inputs,
          output: {},
          error: "attachScript missing/invalid scenePath/scriptPath.",
        })
      );
    }

    const sceneFsRel = String(sceneResPath ?? "")
      .replace(/^res:\/\//, "")
      .replace(/^\/+/, "");
    const sceneAbs = path.resolve(this.projectRoot, sceneFsRel);
    const rootNodeName = tryReadRootNodeName(sceneAbs);

    let nodePathForTool = ".";
    const nodeNameStr = nodeName == null ? "" : String(nodeName).trim();
    if (!nodeNameStr || nodeNameStr === "." || nodeNameStr === rootNodeName) {
      nodePathForTool = ".";
    } else {
      nodePathForTool = nodeNameStr;
    }

    // eslint-disable-next-line no-console
    console.log(
      `[GodotExecutor][MCP] attach_script: scene=${sceneResPath} node=${nodePathForTool} script=${scriptResPath}`
    );

    // Prefer MCP attach_script when the tool exists in the catalog.
    try {
      if (this._mcp) {
        const toolNames = await this._mcp.getToolNames();
        if (Array.isArray(toolNames) && toolNames.includes("attach_script")) {
          const mcpRes = await this._runMcpAction("attach_script", "attach_script", {
            scene_path: sceneResPath,
            node_path: nodePathForTool,
            script_path: scriptResPath,
          });
          if (mcpRes?.ok) return mcpRes;

          const errStr = String(mcpRes?.error ?? "");
          let payloadStr = "";
          try {
            payloadStr = JSON.stringify(mcpRes?.output ?? {});
          } catch {
            payloadStr = String(mcpRes?.output ?? "");
          }
          const searchLower = `${errStr}\n${payloadStr}`.toLowerCase();
          const notConnected =
            searchLower.includes("not connected") ||
            searchLower.includes("godot editor is not connected") ||
            searchLower.includes("godot editor is not") ||
            searchLower.includes("godot editor is not connected");

          // If MCP can't operate because the editor bridge isn't connected,
          // fall back to direct `.tscn` mutation so the factory still succeeds.
          if (notConnected) {
            // eslint-disable-next-line no-console
            console.warn(
              `[GodotExecutor] MCP attach_script failed due to missing Godot connection; falling back to file mutation.`
            );
          } else {
            return mcpRes;
          }
        }
      }
    } catch {
      // fall through to file mutation fallback
    }

    // Fallback: minimal `.tscn` mutation directly on disk so we don't report false success.
    try {
      const original = fs.readFileSync(sceneAbs, "utf-8");
      const already = original.includes(`script = "${scriptResPath}"`);
      if (already) {
        return this._storeAndReturn(
          normalizeResult({
            ok: true,
            action: "attach_script",
            backend: "file",
            inputs,
            output: { changed: false, script_res_path: scriptResPath },
            error: null,
          })
        );
      }

      const lines = original.split("\n");
      const targetIdx =
        nodeNameStr && nodeNameStr !== "."
          ? lines.findIndex((ln) => ln.includes(`[node name="${nodeNameStr}"`))
          : lines.findIndex((ln) => ln.startsWith("[node "));
      const idx = targetIdx >= 0 ? targetIdx : lines.findIndex((ln) => ln.startsWith("[node "));
      if (idx < 0) throw new Error(`Could not find a [node ...] header in scene: ${sceneFsRel}`);

      const window = lines.slice(idx, Math.min(idx + 10, lines.length)).join("\n");
      if (window.includes("script =")) {
        const scriptLineIdx = lines.findIndex(
          (_, i) => i > idx && i < idx + 20 && lines[i].includes("script =")
        );
        if (scriptLineIdx >= 0) {
          lines[scriptLineIdx] = `script = "${scriptResPath}"`;
        } else {
          throw new Error(
            `Scene already has a script line near node ${nodeNameStr || "(unknown)"}, but could not safely update it.`
          );
        }
      } else {
        lines.splice(idx + 1, 0, `script = "${scriptResPath}"`);
      }

      fs.writeFileSync(sceneAbs, lines.join("\n"), "utf-8");
      return this._storeAndReturn(
        normalizeResult({
          ok: true,
          action: "attach_script",
          backend: "file",
          inputs,
          output: { changed: true, script_res_path: scriptResPath, scene: sceneFsRel },
          error: null,
        })
      );
    } catch (err) {
      return this._storeAndReturn(
        normalizeResult({
          ok: false,
          action: "attach_script",
          backend: "file",
          inputs,
          output: {},
          error: `attachScript file mutation failed: ${formatMcpError(err)}`,
        })
      );
    }
  }

  /**
   * Resolve a GoPeak MCP tool name at runtime using the server's current
   * `tools/list` catalog.
   *
   * We intentionally avoid hardcoding any single server's tool names.
   */
  async _resolveGoPeakToolName({ candidates = [], regexes = [], action }) {
    const first = candidates[0] ?? null;
    if (!this._mcp) return first;

    try {
      const toolNames = await this._mcp.getToolNames();
      if (!Array.isArray(toolNames) || toolNames.length === 0) return first;

      // 1) Exact match (most reliable).
      for (const c of candidates) {
        if (toolNames.includes(c)) {
          // eslint-disable-next-line no-console
          console.log(`[GodotExecutor] resolved ${action} -> MCP tool: ${c}`);
          return c;
        }
      }

      // 2) Regex match fallback.
      for (const re of regexes) {
        const match = toolNames.find((n) => re.test(n));
        if (match) {
          // eslint-disable-next-line no-console
          console.log(`[GodotExecutor] resolved ${action} -> MCP tool: ${match}`);
          return match;
        }
      }

      // If tool catalog is present but none match, keep going with first
      // candidate so errors are explicit in executor logs.
      // eslint-disable-next-line no-console
      console.warn(
        `[GodotExecutor] could not find expected MCP tool for ${action} in catalog; using candidate: ${first}`
      );
      return first;
    } catch {
      return first;
    }
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
  // Debug helpers
  // -----------------------------

  async getDebugOutput({ lastN = 10 } = {}) {
    const n = Number(lastN);
    if (!Number.isFinite(n) || n < 1) {
      throw new Error("getDebugOutput({ lastN }) requires lastN >= 1.");
    }

    return this._storeAndReturn(
      normalizeResult({
        ok: true,
        action: "get_debug_output",
        backend: "executor",
        inputs: { last_n: n },
        output: { actions: this._actionHistory.slice(-n) },
        error: null,
      })
    );
  }

  // -----------------------------
  // Internals
  // -----------------------------

  async _runMcpAction(action, method, params) {
    const inputs = params ?? {};

    // MCP: best-effort call into a configured MCP client.
    if (!this.mcpClient) {
      return this._storeAndReturn(
        normalizeResult({
          ok: false,
          action,
          backend: "mcp",
          inputs,
          output: {},
          error: "MCP client is not configured for this executor.",
        })
      );
    }

    try {
      const start = Date.now();

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
      if (this._mcpDebug) {
        // eslint-disable-next-line no-console
        console.log(`[GodotExecutor][MCP] params`, {
          scene_path: params?.scene_path ?? null,
          tool_params_keys: isPlainObject(params) ? Object.keys(params) : [],
          timeout_seconds: params?.timeout_seconds ?? null,
        });
      }

      const response = await this.mcpClient.call(method, params);
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
        return this._storeAndReturn(
          normalizeResult({
            ok: false,
            action,
            backend: "mcp",
            inputs,
            output: {},
            error: "MCP client does not expose a callable method for this action.",
          })
        );
      }

      return this._storeAndReturn(
        normalizeResult({
          ok: mcpToolOk(response),
          action,
          backend: "mcp",
          inputs,
          output: safeJsonOutput(response),
          error: mcpToolOk(response) ? null : mcpToolError(response),
        })
      );
    } catch (err) {
      const timedOut = err?.code === "ETIMEDOUT" || err?.timeoutMs != null;
      const timeoutMs = err?.timeoutMs ?? null;
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
          err_message: formatMcpError(err),
        },
      });
      // #endregion
      return this._storeAndReturn(
        normalizeResult({
          ok: false,
          action,
          backend: "mcp",
          inputs,
          output: timedOut ? { timed_out: true, timeout_ms: timeoutMs } : {},
          error: timedOut
            ? `MCP call timed out after ${timeoutMs ?? "unknown"}ms: ${formatMcpError(err)}`
            : `MCP call failed: ${formatMcpError(err)}`,
        })
      );
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
  // External injection always wins (caller passed mcpClient or mcpClientFactory).
  if (mcpServerConfig === false) return null;

  const enabledEnv =
    processEnv.GODOT_MCP_ENABLED === "true" ||
    processEnv.GODOT_MCP_ENABLED === "1" ||
    processEnv.GODOT_MCP_ENABLED === "yes";

  const autoEnv =
    processEnv.GODOT_MCP_STARTUP != null ||
    processEnv.GODOT_MCP_NPX_ARGS != null ||
    processEnv.GODOT_MCP_LOCAL_ENTRY != null ||
    processEnv.GODOT_MCP_COMMAND != null;

  // Enabled by env, or by explicit mcpServerConfig.
  if (!mcpServerConfig && !(enabledEnv || autoEnv)) return null;

  const merged = mcpServerConfig && typeof mcpServerConfig === "object" ? mcpServerConfig : {};
  const startup = String(merged.startup ?? processEnv.GODOT_MCP_STARTUP ?? "config").toLowerCase();

  const debug =
    merged.debug != null
      ? parseBoolLike(merged.debug, false)
      : parseBoolLike(processEnv.DEBUG, false) ||
        parseBoolLike(processEnv.GODOT_MCP_DEBUG, false);

  const explicitCommand = merged.command ?? processEnv.GODOT_MCP_COMMAND ?? null;
  const explicitArgs = Array.isArray(merged.args)
    ? merged.args
    : processEnv.GODOT_MCP_ARGS
      ? String(processEnv.GODOT_MCP_ARGS)
          .split(" ")
          .map((s) => s.trim())
          .filter(Boolean)
      : null;

  let command = explicitCommand;
  let args = explicitArgs ?? [];

  // Some local configs mistakenly use `npx` with a direct `.js` entrypoint
  // (e.g. `npx /path/to/dist/index.js`). In that case, `npx` may try to
  // execute the file as a binary and fail. Normalize to `node` so the stdio
  // server can start reliably.
  if (
    String(command).trim().toLowerCase() === "npx" &&
    Array.isArray(args) &&
    args.length === 1 &&
    typeof args[0] === "string" &&
    args[0].trim().toLowerCase().endsWith(".js")
  ) {
    command = "node";
  }

  // Legacy local-entry convenience mode:
  // startup=local + localEntry => command=node args=[localEntry, ...localArgs]
  if ((!command || args.length === 0) && startup === "local") {
    const localEntry = merged.localEntry ?? processEnv.GODOT_MCP_LOCAL_ENTRY;
    if (localEntry && String(localEntry).trim()) {
      command = merged.nodeCommand ?? processEnv.GODOT_MCP_NODE_COMMAND ?? "node";
      const localArgs = Array.isArray(merged.localArgs) ? merged.localArgs : [];
      args = [String(localEntry), ...localArgs];
    }
  }

  // Optional explicit fallback only (never implicit):
  // startup=npx OR GODOT_MCP_ALLOW_NPX_FALLBACK=true.
  const allowNpxFallback =
    startup === "npx" ||
    processEnv.GODOT_MCP_ALLOW_NPX_FALLBACK === "true" ||
    processEnv.GODOT_MCP_ALLOW_NPX_FALLBACK === "1";

  if ((!command || args.length === 0) && allowNpxFallback) {
    command = "npx";
    // Default to GoPeak.
    const pkg = merged.npxPackage ?? processEnv.GODOT_MCP_NPX_ARGS ?? "gopeak";
    // Prefer -y so tests/runs don't hang on confirmation.
    args = Array.isArray(merged.npxArgs) && merged.npxArgs.length > 0 ? merged.npxArgs : ["-y", String(pkg)];
  }

  // Config-driven startup is required for normal usage.
  if (!command || !String(command).trim() || !Array.isArray(args) || args.length === 0) {
    return null;
  }

  const workingDirectoryRaw =
    merged.working_directory ??
    merged.workingDirectory ??
    processEnv.GODOT_MCP_WORKING_DIRECTORY ??
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
    processEnv.GODOT_MCP_REQUEST_TIMEOUT_MS ??
    null;

  const requestTimeoutSecondsRaw =
    merged.requestTimeoutSeconds ??
    merged.request_timeout_seconds ??
    processEnv.GODOT_MCP_REQUEST_TIMEOUT_SECONDS ??
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

    // 3) tools/list (best-effort; cached)
    try {
      const toolsList = await this._requestRaw("tools/list", {});
      this._toolsListed = true;
      this._cachedToolsList = toolsList ?? null;
      this._toolNames = extractToolNamesFromToolsList(toolsList);
      if (this.debug) {
        const tools = toolsList?.tools ?? toolsList?.data?.tools ?? [];
        const names = Array.isArray(tools) ? tools.map((t) => t?.name).filter(Boolean) : [];
        // eslint-disable-next-line no-console
        console.log(`[GodotExecutor][MCP] tools/list names: ${names.join(", ")}`);
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
    await this.ensureConnected();
    return Array.isArray(this._toolNames) ? this._toolNames : [];
  }
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

