#!/usr/bin/env node
/**
 * Interactive terminal runner for the isolated Generic MCP pipeline.
 * -----------------------------------------------------------------------------
 * This is a **connected MCP shell**, not a generic chat shell: the prompt appears
 * only after MCP transport, bridge/project readiness, and tool inventory load
 * succeed. It is **not** the old edit-mode runtime — only generic-mcp modules.
 *
 * One process wires SessionManager, ToolInventory, GenericMcpRunner, etc. **once**.
 * The MCP client session stays alive across turns; tool inventory stays cached
 * until `reload-tools` calls `refresh()`.
 *
 * Usage:
 *   node backend/factory-js/generic-mcp/run-interactive-generic-mcp.js \
 *     --project-root "<path>" --client-module "<path-to-stdio-mcp-client.js>"
 */

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import { SessionManager } from "./SessionManager.js";
import { ToolInventory } from "./ToolInventory.js";
import { ToolPlanner } from "./ToolPlanner.js";
import { ArgumentResolver } from "./ArgumentResolver.js";
import { Executor } from "./Executor.js";
import { ResultPresenter } from "./ResultPresenter.js";
import { GenericMcpRunner } from "./GenericMcpRunner.js";
import { LiveModelClient } from "./LiveModelClient.js";
import { ProjectFileIndex } from "./ProjectFileIndex.js";
import { ResourceResolver } from "./ResourceResolver.js";
import { NodeResolver } from "./NodeResolver.js";
import { McpConfigLoader, DEFAULT_CONFIG_PATH } from "./McpConfigLoader.js";
import { formatNeedsInputForCli } from "./NeedsInputFormatter.js";

function safeString(value) {
  return value == null ? "" : String(value);
}

/** Same canonical absolute realpath comparison idea as SessionManager (display-only). */
function canonicalPathForCompare(input) {
  if (input == null) return null;
  const s = safeString(input).trim();
  if (!s) return null;
  let resolved;
  try {
    resolved = path.isAbsolute(s) ? path.normalize(s) : path.resolve(process.cwd(), s);
  } catch {
    return null;
  }
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function computeProjectMatches(st) {
  const desired = st.desiredProjectRoot;
  const conn = st.connectedProjectPath;
  if (desired == null) return true;
  if (conn == null) return false;
  const c = canonicalPathForCompare(conn);
  const d = canonicalPathForCompare(desired);
  return c != null && d != null && c === d;
}

function getArg(argv, name) {
  const i = argv.indexOf(name);
  if (i < 0) return null;
  return argv[i + 1] ?? null;
}

function hasArg(argv, name) {
  return argv.includes(name);
}

function usage() {
  return [
    "Usage:",
    "  node backend/factory-js/generic-mcp/run-interactive-generic-mcp.js \\",
    '    --project-root "<path>" --client-module "<module exporting createClient>"',
    "",
    "Required:",
    "  --project-root <path>     Project root (resolved to absolute)",
    "  --client-module <path>    JS module that exports createClient({ mcpConfig })",
    "",
    "Optional:",
    `  (default MCP config: ${DEFAULT_CONFIG_PATH})`,
    "  --mcp-config-path <path>  MCP config file override",
    "  --mcp-config-json <json>  MCP config inline JSON",
    "  --model-backend, --model-name, --model-base-url, --model-api-key, --model-timeout-ms",
    "  --debug                   Start with structured JSON after each turn",
    "  --help",
    "",
    "Startup: connects MCP, waits for bridge/project readiness, loads tools — then prompt.",
    "",
    "Shell commands (not sent to MCP):",
    "  help          Show this help",
    "  status        Session + inventory summary",
    "  show-index    Show current ProjectFileIndex debug summary",
    "  reload-tools  Force tools/list refresh",
    "  debug on|off  Toggle structured run JSON after each turn",
    "  exit          Quit",
  ].join("\n");
}

function recoveryHelp() {
  return [
    "Not connected — normal pipeline input is disabled until startup succeeds.",
    "Commands: retry (re-run connection + tool load), status, exit",
  ].join("\n");
}

function isLikelyClarificationAnswer(input) {
  const s = safeString(input).trim();
  if (!s) return false;
  if (/^res:\/\//i.test(s)) return true;
  if (/^[`"']?.+\.(tscn|gd|tres|res|png|jpg|jpeg|webp|shader|gdshader)[`"']?$/i.test(s)) return true;
  if (!/\s/.test(s)) return true;
  return false;
}

function buildStatusPayload(sessionManager, toolInventory, { shellMode = "connected" } = {}) {
  const st = sessionManager.getStatus();
  const inv = toolInventory.getInventory();
  return {
    shellMode,
    mcpClientReady: st.mcpClientReady,
    bridgeReady: st.bridgeReady,
    connectedProjectPath: st.connectedProjectPath,
    desiredProjectRoot: st.desiredProjectRoot,
    projectMatches: computeProjectMatches(st),
    toolCount: inv.toolCount,
    inventoryFetchedAt: inv.fetchedAt,
    failedPhase: st.failedPhase ?? null,
    failurePhase: st.failurePhase ?? null,
    lastError: st.lastError ?? null,
  };
}

async function loadCreateClient(clientModulePath) {
  const abs = path.resolve(clientModulePath);
  const mod = await import(pathToFileURL(abs).href);
  const fn =
    (typeof mod.createClient === "function" && mod.createClient) ||
    (typeof mod.default === "function" && mod.default) ||
    (typeof mod.default?.createClient === "function" && mod.default.createClient) ||
    null;
  if (!fn) {
    throw new Error(`Client module must export createClient(...): ${abs}`);
  }
  return fn;
}

function applyInteractiveDebug({ runner, modelClient, debug }) {
  const d = Boolean(debug);
  runner._debug = d;
  if (modelClient && typeof modelClient === "object") {
    modelClient._debug = d;
  }
  const ex = runner._modules?.executor;
  const rp = runner._modules?.resultPresenter;
  if (ex) ex._debug = d;
  if (rp) rp._debug = d;
}

/**
 * Runs the real MCP workflow once: initialize → bridge/project readiness → tool inventory.
 * Does not enter prompt until this returns { ok: true }.
 */
async function runStartupGate({ sessionManager, toolInventory, projectRoot }) {
  console.error("[generic-mcp] [2/5] Connecting MCP (transport + initialize)…");
  const initRes = await sessionManager.initialize(projectRoot);
  if (!initRes?.ok) {
    const err = safeString(initRes?.error ?? initRes?.status?.lastError ?? "MCP initialize failed.");
    return {
      ok: false,
      phase: "mcp_initialize",
      error: err,
      initRes,
      readyRes: null,
      invRes: null,
    };
  }

  console.error("[generic-mcp] [3/5] Waiting for bridge / project readiness…");
  const readyRes = await sessionManager.ensureReady(projectRoot);
  const st = sessionManager.getStatus();
  if (!readyRes?.ok) {
    const err = safeString(readyRes?.status?.lastError ?? st?.lastError ?? "Bridge or project readiness failed.");
    return {
      ok: false,
      phase: "bridge_project",
      error: err,
      initRes,
      readyRes,
      invRes: null,
    };
  }

  if (!st.mcpClientReady || !st.bridgeReady || st.desiredProjectRoot == null) {
    return {
      ok: false,
      phase: "session_gate",
      error:
        "Session gate failed: expected mcpClientReady, bridgeReady, and desiredProjectRoot from startup args.",
      initRes,
      readyRes,
      invRes: null,
    };
  }

  console.error("[generic-mcp] [4/5] Loading tool inventory…");
  const invRes = await toolInventory.load();
  if (!invRes?.ok) {
    return {
      ok: false,
      phase: "tool_inventory",
      error: safeString(invRes?.error ?? "tools/list failed."),
      initRes,
      readyRes,
      invRes,
    };
  }

  const inv = toolInventory.getInventory();
  if (inv.fetchedAt == null) {
    return {
      ok: false,
      phase: "tool_inventory",
      error: "Tool inventory fetch did not complete (missing fetchedAt).",
      initRes,
      readyRes,
      invRes,
    };
  }

  console.error(
    `[generic-mcp] [5/5] Ready — ${inv.toolCount} tool(s). Connected MCP shell (session + inventory cached).`
  );
  return { ok: true, phase: null, error: null, initRes, readyRes, invRes };
}

function logStartupFailure(gate) {
  const { phase, error, initRes, readyRes, invRes } = gate;
  console.error(`[generic-mcp] Startup failed at phase "${phase}": ${error}`);
  const st = initRes?.status ?? readyRes?.status;
  if (st?.failedPhase != null || st?.failurePhase != null) {
    console.error(
      `[generic-mcp] Detail: failurePhase=${st.failurePhase ?? "?"} failedPhase=${st.failedPhase ?? "?"}`
    );
  }
  if (invRes && !invRes.ok) {
    console.error(`[generic-mcp] Inventory: ${safeString(invRes.error)}`);
  }
}

async function main() {
  const argv = process.argv.slice(2);
  if (hasArg(argv, "--help")) {
    console.log(usage());
    process.exit(0);
  }

  let projectRoot = getArg(argv, "--project-root");
  const clientModule = getArg(argv, "--client-module") || process.env.GENERIC_MCP_CLIENT_MODULE || null;
  const mcpConfigPath = getArg(argv, "--mcp-config-path");
  const mcpConfigJson = getArg(argv, "--mcp-config-json");
  let shellDebug = hasArg(argv, "--debug");

  if (!projectRoot || !clientModule) {
    console.error("Missing required args.\n");
    console.error(usage());
    process.exit(2);
  }
  projectRoot = path.resolve(projectRoot);

  console.error("[generic-mcp] [1/5] Loading MCP configuration…");
  const configLoader = new McpConfigLoader();
  const configRes = await configLoader.load({
    mcpConfigJson,
    mcpConfigPath,
  });
  if (!configRes.ok) {
    console.error("[generic-mcp] Startup failed at phase \"config\":", configRes.error);
    process.exit(2);
  }
  const mcpConfig = configRes.mcpConfig;

  const createClient = await loadCreateClient(clientModule);

  const modelClient = new LiveModelClient({
    backend: getArg(argv, "--model-backend") || process.env.GENERIC_MCP_MODEL_BACKEND || undefined,
    model: getArg(argv, "--model-name") || process.env.GENERIC_MCP_MODEL_NAME || undefined,
    baseUrl: getArg(argv, "--model-base-url") || process.env.GENERIC_MCP_MODEL_BASE_URL || undefined,
    apiKey: getArg(argv, "--model-api-key") || process.env.GENERIC_MCP_MODEL_API_KEY || undefined,
    timeoutMs: Number(getArg(argv, "--model-timeout-ms") || process.env.GENERIC_MCP_MODEL_TIMEOUT_MS || 120000),
    debug: shellDebug,
  });

  const sessionManager = new SessionManager({
    mcpConfig,
    createClient: async ({ mcpConfig: cfg }) => createClient({ mcpConfig: cfg }),
  });
  const toolInventory = new ToolInventory({ sessionManager });
  const fileIndex = new ProjectFileIndex({ debug: shellDebug });
  const resourceResolver = new ResourceResolver({ fileIndex, debug: shellDebug });
  const nodeResolver = new NodeResolver({ sessionManager, inventory: toolInventory });
  const toolPlanner = new ToolPlanner({ toolInventory, modelClient });
  const argumentResolver = new ArgumentResolver({
    sessionManager,
    fileResolver: resourceResolver,
    nodeResolver,
    toolInventory,
    debug: shellDebug,
  });
  const executor = new Executor({ sessionManager, toolInventory, fileIndex, debug: shellDebug });
  const resultPresenter = new ResultPresenter({ debug: shellDebug });

  const runner = new GenericMcpRunner({
    sessionManager,
    toolInventory,
    toolPlanner,
    fileIndex,
    resourceResolver,
    argumentResolver,
    executor,
    resultPresenter,
    modelClient,
    mcpConfig,
    debug: shellDebug,
  });

  applyInteractiveDebug({ runner, modelClient, debug: shellDebug });

  const rl = readline.createInterface({ input, output });

  const sessionContext = { projectRoot };
  let pendingNeedsInput = null;

  let shuttingDown = false;
  async function shutdownSession() {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      await sessionManager.shutdown();
    } catch {
      // best effort
    }
  }

  process.once("SIGINT", async () => {
    console.error("\n(interrupted)");
    await shutdownSession();
    rl.close();
    process.exit(0);
  });

  let gate = await runStartupGate({ sessionManager, toolInventory, projectRoot });
  if (!gate.ok) {
    logStartupFailure(gate);
    console.error("[generic-mcp] Entering recovery mode — only retry, status, exit. Not a chat shell.");
  }

  try {
    while (!gate?.ok) {
      const line = await rl.question("generic-mcp (disconnected)> ");
      const trimmed = line.trim();
      if (!trimmed) continue;
      const first = trimmed.split(/\s+/)[0].toLowerCase();

      if (first === "exit" || first === "quit") {
        return;
      }
      if (first === "status") {
        console.log(JSON.stringify(buildStatusPayload(sessionManager, toolInventory, { shellMode: "disconnected" }), null, 2));
        continue;
      }
      if (first === "retry") {
        gate = await runStartupGate({ sessionManager, toolInventory, projectRoot });
        if (!gate.ok) {
          logStartupFailure(gate);
        } else {
          console.error("[generic-mcp] Connected — you can use the normal prompt for pipeline requests.");
        }
        continue;
      }
      console.error("Unknown command (recovery). " + recoveryHelp());
    }

    console.error("Type `help` for shell commands. Ctrl+C or `exit` to quit.");

    while (true) {
      const line = await rl.question("generic-mcp> ");
      const trimmed = line.trim();
      if (!trimmed) continue;

      const first = trimmed.split(/\s+/)[0].toLowerCase();
      const rest = trimmed.slice(first.length).trim().toLowerCase();

      if (first === "exit" || first === "quit") {
        break;
      }
      if (first === "help" || first === "?") {
        console.log(usage());
        continue;
      }
      if (first === "status") {
        console.log(JSON.stringify(buildStatusPayload(sessionManager, toolInventory, { shellMode: "connected" }), null, 2));
        continue;
      }
      if (first === "show-index" || first === "index") {
        // Diagnostics-only: helps verify index contents vs resolver behavior.
        const summary =
          typeof fileIndex.getDebugSummary === "function"
            ? fileIndex.getDebugSummary({ tscnPreviewLimit: 80 })
            : { error: "Index summary unavailable." };
        console.log(JSON.stringify(summary, null, 2));
        continue;
      }
      if (first === "reload-tools") {
        const r = await toolInventory.refresh();
        console.log(
          r?.ok
            ? `Tools reloaded: ${toolInventory.getInventory().toolCount} tools.`
            : `Reload failed: ${r?.error ?? "unknown"}`
        );
        continue;
      }
      if (first === "debug") {
        if (rest === "on") {
          shellDebug = true;
          applyInteractiveDebug({ runner, modelClient, debug: true });
          console.log("Debug on (structured JSON after each turn).");
        } else if (rest === "off") {
          shellDebug = false;
          applyInteractiveDebug({ runner, modelClient, debug: false });
          console.log("Debug off.");
        } else {
          console.log("Usage: debug on | debug off");
        }
        continue;
      }

      const runResult = await runner.run({
        userRequest: trimmed,
        projectRoot,
        mcpConfig,
        sessionContext,
        resumeNeedsInput:
          pendingNeedsInput &&
          isLikelyClarificationAnswer(trimmed)
            ? pendingNeedsInput
            : null,
      });

      if (runResult.status === "needs_input") {
        pendingNeedsInput = runResult;
        console.log(formatNeedsInputForCli(runResult));
      } else {
        pendingNeedsInput = null;
        console.log(runResult.presentation || "(no presentation output)");
      }
      if (shellDebug) {
        console.log("\n[debug] structured run result:");
        console.log(JSON.stringify(runResult, null, 2));
      }
    }
  } finally {
    rl.close();
    await shutdownSession();
  }
}

main().catch((err) => {
  console.error("run-interactive-generic-mcp failed:", err?.message ?? err);
  process.exit(1);
});
