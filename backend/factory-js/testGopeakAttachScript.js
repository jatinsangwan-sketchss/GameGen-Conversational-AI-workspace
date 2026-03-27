/**
 * Isolated GoPeak capability smoke test.
 * Verifies script attachment through discovered node/property/save tools (not attach_script assumptions).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GodotExecutor } from "./src/godot/GodotExecutor.js";

const TARGET_SCENE = "scenes/boot/boot_scene.tscn";
const TARGET_NODE = "BootScene";
const TARGET_SCRIPT = "res://scripts/BootPrintHelloWorld.gd";
const SHORT_TIMEOUT_SECONDS = 15;

function readMcpConfigOrExit() {
  const thisFile = fileURLToPath(import.meta.url);
  const thisDir = path.dirname(thisFile);
  const configPath = path.resolve(thisDir, "mcp.config.json");
  const raw = fs.readFileSync(configPath, "utf-8");
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || !parsed.godot) {
    throw new Error(`Invalid mcp.config.json at ${configPath}`);
  }
  return parsed;
}

function parseProjectRoot(argv) {
  const idx = argv.indexOf("--project-root");
  const raw = idx >= 0 && argv[idx + 1] ? String(argv[idx + 1]) : "./artifacts/MyProject1/run_002/project";
  const cwd = process.cwd();
  const direct = path.resolve(cwd, raw);
  if (fs.existsSync(direct)) return direct;
  const backendDup = `${path.sep}backend${path.sep}backend${path.sep}`;
  if (direct.includes(backendDup)) {
    const collapsed = direct.replace(backendDup, `${path.sep}backend${path.sep}`);
    if (fs.existsSync(collapsed)) return collapsed;
  }
  if (path.basename(cwd) === "backend" && (raw.startsWith("./backend/") || raw.startsWith("backend/"))) {
    const stripped = raw.replace(/^\.?\/?backend\//, "");
    const candidate = path.resolve(cwd, stripped);
    if (fs.existsSync(candidate)) return candidate;
  }
  return direct;
}

function printJson(label, data) {
  console.log(`\n${label}`);
  console.log(JSON.stringify(data, null, 2));
}

async function main() {
  const projectRoot = parseProjectRoot(process.argv.slice(2));
  printJson("[GoPeak Smoke] resolved project root", { cwd: process.cwd(), project_root: projectRoot });
  const mcpConfig = readMcpConfigOrExit();
  const cfg = {
    project_root: projectRoot,
    godot: {
      ...mcpConfig.godot,
      request_timeout_seconds: SHORT_TIMEOUT_SECONDS,
    },
  };

  const executor = GodotExecutor.fromConfig({ config: cfg, mcpClient: null });
  const listed = await executor.listAvailableTools();
  printJson("[GoPeak Smoke] available MCP tools", listed?.output?.tools ?? []);
  const propertyTools = await executor.findToolsByKeyword("properties");
  printJson("[GoPeak Smoke] property-related tools", propertyTools?.output?.tools ?? []);

  const workflowCalls = [
    {
      tool_group: "set-node-properties",
      target: {
        scene_path: `res://${TARGET_SCENE}`,
        node_path: TARGET_NODE,
        script: TARGET_SCRIPT,
      },
    },
    {
      tool_group: "save-scene",
      target: {
        scene_path: `res://${TARGET_SCENE}`,
      },
    },
  ];
  printJson("[GoPeak Smoke] expected MCP call sequence", workflowCalls);
  const attachResult = await executor.attachScript({
    scene_path: TARGET_SCENE,
    node_path: TARGET_NODE,
    script_path: TARGET_SCRIPT,
  });
  printJson("[GoPeak Smoke] attach_script normalized result", attachResult);

  const debug = await executor.getDebugOutput({ lastN: 20 });
  const actions = Array.isArray(debug?.output?.actions) ? debug.output.actions : [];
  const attachMcpAction = actions.find((a) => a?.action === "attach_script" && a?.backend === "mcp");
  printJson(
    "[GoPeak Smoke] attach_script raw MCP response",
    attachMcpAction?.output?.mcp_trace?.raw_response ?? null
  );

  const saveResult = await executor.saveScene({ scene_path: TARGET_SCENE });
  printJson("[GoPeak Smoke] save_scene result", saveResult);

  // Strict capability proof: attachment must be MCP-backed and must mutate scene state.
  const strictAttachOk =
    attachResult?.ok === true &&
    attachResult?.backend === "mcp" &&
    attachResult?.output?.changed === true &&
    attachMcpAction?.output?.mcp_trace?.raw_response != null;
  const ok = Boolean(strictAttachOk) && Boolean(saveResult?.ok) && saveResult?.backend === "mcp";
  if (!strictAttachOk) {
    printJson("[GoPeak Smoke] strict attach failure details", {
      attach_ok: attachResult?.ok ?? null,
      backend: attachResult?.backend ?? null,
      changed: attachResult?.output?.changed ?? null,
      raw_mcp_response_present: attachMcpAction?.output?.mcp_trace?.raw_response != null,
      attach_error: attachResult?.error ?? null,
    });
  }
  console.log(`\n[GoPeak Smoke] ${ok ? "SUCCESS (real MCP mutation)" : "FAILED (not a real MCP mutation)"}`);
  process.exit(ok ? 0 : 2);
}

main().catch((err) => {
  console.error("[GoPeak Smoke] ERROR", err?.stack ?? String(err));
  process.exit(1);
});

