/**
 * testAttachScriptMcp.js
 * ----------------------
 * Direct MCP smoke test for the `attach_script` operation used by
 * `GodotExecutor.attachScript()`.
 *
 * Goal: isolate MCP attach timeouts outside the full edit-mode pipeline.
 *
 * Usage:
 *   node testAttachScriptMcp.js --project-root /abs/path/to/project
 *
 * Notes:
 * - Uses the configured MCP server from `backend/factory-js/mcp.config.json`
 *   via `GodotExecutor` (config-driven startup).
 * - Forces a short MCP request timeout (~15s) via env var.
 */

import { GodotExecutor } from "./src/godot/GodotExecutor.js";

const DEBUG_INGEST_URL = "http://127.0.0.1:7625/ingest/7bb5a989-4dc4-4303-8ae6-c9e2b5e6442e";
const DEBUG_SESSION_ID = "c36693";
const RUN_ID = process.env.DEBUG_RUN_ID ?? "attach_script_smoke";

function parseArg(argv, flag) {
  const idx = argv.indexOf(flag);
  if (idx === -1) return null;
  return argv[idx + 1] ?? null;
}

function postDebugLog({ hypothesisId, location, message, data }) {
  fetch(DEBUG_INGEST_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Debug-Session-Id": DEBUG_SESSION_ID,
    },
    body: JSON.stringify({
      sessionId: DEBUG_SESSION_ID,
      runId: RUN_ID,
      hypothesisId,
      location,
      message,
      data,
      timestamp: Date.now(),
    }),
  }).catch(() => {});
}

async function main() {
  const argv = process.argv.slice(2);
  const projectRoot = parseArg(argv, "--project-root");

  if (!projectRoot) {
    console.error("Missing required: --project-root /abs/path/to/project");
    process.exit(1);
  }

  // Shorten MCP request timeout for this isolated debug test.
  // GodotExecutor reads `process.env.GODOT_MCP_REQUEST_TIMEOUT_SECONDS`.
  process.env.GODOT_MCP_REQUEST_TIMEOUT_SECONDS = "15";

  // #region agent log (H1 init timeout / server startup)
  postDebugLog({
    hypothesisId: "H1_mcp_init_timeout_or_server_startup_issue",
    location: "testAttachScriptMcp.js:main:start",
    message: "Parsed args + forcing short MCP request timeout.",
    data: { projectRoot, timeoutSeconds: 15 },
  });
  // #endregion

  const executor = GodotExecutor.fromConfig({
    config: { project_root: projectRoot },
    mcpClient: null,
  });

  const scenePath = "scenes/boot/boot_scene.tscn";
  const nodeName = "BootScene";
  const scriptPath = "res://scripts/BootPrintHelloWorld.gd";

  // Exact MCP tools/call payload (JSON-RPC id is internal and not included).
  const toolsCallPayload = {
    jsonrpc: "2.0",
    method: "tools/call",
    params: {
      name: "attach_script",
      arguments: {
        project_root: executor.projectRoot,
        scene_path: scenePath,
        node_name: nodeName,
        script_path: scriptPath,
      },
    },
  };

  console.log("MCP request payload (tools/call):");
  console.log(JSON.stringify(toolsCallPayload, null, 2));

  try {
    // #region agent log (H2 attach_script payload/params)
    postDebugLog({
      hypothesisId: "H2_attach_script_tool_call_payload_or_params_issue",
      location: "testAttachScriptMcp.js:before_attachScript",
      message: "Calling executor.attachScript() (MCP attach_script).",
      data: { scenePath, nodeName, scriptPath, sceneArg: "scenes/boot/boot_scene.tscn" },
    });
    // #endregion

    console.log("Calling executor.attachScript()...");
    const result = await executor.attachScript({ scenePath, nodeName, scriptPath });

    // #region agent log (H1 attachScript return)
    postDebugLog({
      hypothesisId: "H1_mcp_init_timeout_or_server_startup_issue",
      location: "testAttachScriptMcp.js:after_attachScript",
      message: "executor.attachScript() returned.",
      data: {
        ok: result?.ok,
        action: result?.action,
        backend: result?.backend,
        error: result?.error ?? null,
        output: result?.output ?? null,
      },
    });
    // #endregion

    console.log("MCP attach_script normalized result:");
    console.log(JSON.stringify(result, null, 2));
    process.exit(result?.ok ? 0 : 2);
  } catch (err) {
    // #region agent log (H1 attachScript exception)
    postDebugLog({
      hypothesisId: "H1_mcp_init_timeout_or_server_startup_issue",
      location: "testAttachScriptMcp.js:attachScript_catch",
      message: "executor.attachScript() threw.",
      data: { error: err?.message ?? String(err), code: err?.code ?? null },
    });
    // #endregion

    console.error("MCP attach_script threw an exception:");
    console.error(err?.stack ?? String(err));
    process.exit(3);
  }
}

main().catch((err) => {
  console.error("testAttachScriptMcp failed:", err?.stack ?? String(err));
  process.exit(1);
});

