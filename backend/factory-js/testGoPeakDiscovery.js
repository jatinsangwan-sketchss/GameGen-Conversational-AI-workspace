/**
 * Discovery-only GoPeak smoke test.
 * Verifies config-driven startup + full tool discovery/operation mapping
 * without mutating project state.
 */
import fs from "node:fs";
import path from "node:path";
import { GodotExecutor } from "./src/godot/GodotExecutor.js";
import { getGoPeakSessionManager } from "./src/godot/GoPeakSessionManager.js";

function parseProjectRoot(argv) {
  const idx = argv.indexOf("--project-root");
  if (idx >= 0 && argv[idx + 1]) return path.resolve(process.cwd(), String(argv[idx + 1]));
  return path.resolve(process.cwd(), "./artifacts/MyProject1/run_002/project");
}

function printJson(label, value) {
  console.log(`\n${label}`);
  console.log(JSON.stringify(value, null, 2));
}

function readGoPeakConfig() {
  const configPath = path.resolve(process.cwd(), "./factory-js/mcp.config.json");
  if (!fs.existsSync(configPath)) return { configPath, profile: null, pageSize: null };
  const parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const env = parsed?.godot?.env ?? {};
  return {
    configPath,
    profile: env?.GOPEAK_TOOL_PROFILE ?? null,
    pageSize: env?.GOPEAK_TOOLS_PAGE_SIZE ?? null,
  };
}

async function main() {
  const projectRoot = parseProjectRoot(process.argv.slice(2));
  console.log(`[GoPeak Discovery] project_root=${projectRoot}`);
  const cfg = readGoPeakConfig();
  console.log(`[GoPeak Discovery] config_path=${cfg.configPath}`);
  console.log(`[GoPeak Discovery] profile=${cfg.profile ?? "unknown"}`);
  console.log(`[GoPeak Discovery] page_size=${cfg.pageSize ?? "unknown"}`);

  // Discovery-only flow: start backend-owned session and inspect tool surface.
  const sessionManager = getGoPeakSessionManager();
  const started = await sessionManager.ensureStarted();
  console.log(`[GoPeak Discovery] reused_existing_session=${started?.reused ? "true" : "false"}`);
  printJson("[GoPeak Discovery] session_status", sessionManager.getStatus());

  const discoveredViaSession = await sessionManager.listAvailableTools({ refresh: true });
  if (!discoveredViaSession?.ok) {
    console.error("[GoPeak Discovery] session discovery failed:", discoveredViaSession?.error ?? "unknown error");
    process.exit(2);
  }
  console.log(`[GoPeak Discovery] pages_fetched=${discoveredViaSession?.page_fetch_count ?? "unknown"}`);

  const executor = GodotExecutor.fromConfig({
    config: { project_root: projectRoot },
    mcpClient: null,
  });

  const discovered = await executor.listAvailableTools();
  if (!discovered?.ok) {
    console.error("[GoPeak Discovery] listAvailableTools failed:", discovered?.error ?? "unknown error");
    process.exit(3);
  }

  const tools = Array.isArray(discovered?.output?.tools) ? discovered.output.tools : [];
  const names = tools.map((t) => t?.name).filter(Boolean);
  console.log(`[GoPeak Discovery] total_discovered_tools=${tools.length}`);
  printJson("[GoPeak Discovery] tool_names", names);

  const supported = await executor.getSupportedOperations();
  if (!supported?.ok) {
    console.error("[GoPeak Discovery] getSupportedOperations failed:", supported?.error ?? "unknown error");
    process.exit(4);
  }

  const operations = Array.isArray(supported?.output?.operations) ? supported.output.operations : [];
  printJson("[GoPeak Discovery] derived_supported_operations", operations);

  const moreThanFirstPage = tools.length > 33;
  console.log(`[GoPeak Discovery] pagination_effective=${moreThanFirstPage ? "true" : "false"}`);
  console.log("[GoPeak Discovery] done");
  process.exit(0);
}

main().catch((err) => {
  console.error("[GoPeak Discovery] fatal error:", err?.stack ?? String(err));
  process.exit(1);
});

