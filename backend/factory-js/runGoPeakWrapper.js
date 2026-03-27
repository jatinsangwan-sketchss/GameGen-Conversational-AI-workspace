#!/usr/bin/env node
/**
 * runGoPeakWrapper.js
 * -------------------
 * Standalone discovery-first GoPeak wrapper focused on --test-all mode.
 *
 * Flow:
 * 1) Boot backend-owned GoPeak session manager (single long-lived owner).
 * 2) Create GodotExecutor adapter bound to same backend-owned session.
 * 3) Discover raw tools (pagination handled by session manager).
 * 3) Classify prerequisites + build safe dummy args.
 * 4) Execute callable tools one-by-one.
 * 5) Print clear per-tool and final summary output.
 *
 * This wrapper intentionally avoids FactoryRunner and edit-mode orchestration.
 */

import path from "node:path";
import { GodotExecutor } from "./src/godot/GodotExecutor.js";
import { normalizeRawTools, deriveSupportedOperations } from "./src/godot/GoPeakToolCatalog.js";
import {
  explainSkipReason,
} from "./src/godot/GoPeakPrerequisiteResolver.js";
import { getGoPeakSessionManager } from "./src/godot/GoPeakSessionManager.js";
import {
  getAllOperationDefinitions,
  getOperationPrerequisites,
  getOperationPlaceholderPolicy,
} from "./src/godot/GoPeakOperationRegistry.js";

function parseArgs(argv) {
  const args = Array.isArray(argv) ? argv : [];
  const has = (f) => args.includes(f);
  const get = (f) => {
    const i = args.indexOf(f);
    return i >= 0 ? args[i + 1] ?? null : null;
  };
  return {
    testAll: has("--test-all"),
    projectRoot: get("--project-root") ?? "./artifacts/MyProject1/run_002/project",
    allowMutatingTools: has("--allow-mutating-tools"),
  };
}

function usage() {
  console.log("Usage:");
  console.log("  node ./factory-js/runGoPeakWrapper.js --test-all [--project-root <path>] [--allow-mutating-tools]");
}

function summarizeArgs(args) {
  if (!args || typeof args !== "object") return "(none)";
  const keys = Object.keys(args);
  if (keys.length === 0) return "{}";
  const out = {};
  for (const k of keys) {
    const v = args[k];
    if (typeof v === "string" && v.length > 120) out[k] = `${v.slice(0, 117)}...`;
    else out[k] = v;
  }
  return JSON.stringify(out);
}

function safeError(err) {
  if (err?.message) return String(err.message);
  return String(err ?? "Unknown error");
}

function hasPrerequisites(prereqs, ctx) {
  const reqs = Array.isArray(prereqs) ? prereqs : [];
  for (const p of reqs) {
    if (p === "server_only") continue;
    if (p === "project_required" && !ctx.projectRoot) return false;
    if (p === "editor_bridge_required" && !ctx.bridgeReady) return false;
    if (p === "runtime_addon_required" && !ctx.runtimeAddonReady) return false;
    if (p === "lsp_required" && !ctx.lspReady) return false;
    if (p === "dap_required" && !ctx.dapReady) return false;
  }
  return true;
}

function buildCanonicalOperationParams({ operation, projectRoot, placeholderPolicy }) {
  const defaultScene = "res://scenes/boot/boot_scene.tscn";
  const defaultScript = "res://scripts/BootPrintHelloWorld.gd";
  const defaults = {
    analyze_project: {},
    create_scene: {
      scene_path: "res://scenes/wrapper_test_scene.tscn",
      root_node_name: "WrapperTestRoot",
      root_node_type: "Node2D",
    },
    add_node: {
      scene_path: defaultScene,
      node_name: "WrapperNode",
      node_type: "Node2D",
      parent_path: ".",
    },
    set_node_properties: {
      scene_path: defaultScene,
      node_path: ".",
      properties: { visible: true },
    },
    save_scene: {
      scene_path: defaultScene,
    },
    attach_script_to_scene_root: {
      scene_path: defaultScene,
      node_path: ".",
      script_path: defaultScript,
    },
    create_script_file: {
      script_path: "scripts/WrapperGenerated.gd",
      content:
        placeholderPolicy === "content_placeholder_allowed_if_explicit"
          ? "extends Node\n\nfunc _ready():\n\tprint(\"wrapper generated\")\n"
          : "extends Node\n",
    },
    modify_script_file: {
      script_path: "scripts/WrapperGenerated.gd",
      content: "extends Node\n\nfunc _ready():\n\tprint(\"wrapper modified\")\n",
      replace_mode: "replace_full",
    },
    run_project: {
      headless: true,
      timeout_seconds: 3,
    },
    get_debug_output: {
      last_n: 10,
    },
    rename_project: {
      project_name: "WrapperTestProject",
    },
  };
  const params = defaults[operation] ?? {};
  return {
    ...params,
    project_root: projectRoot ?? null,
  };
}

async function runTestAll({ executor, projectRoot, allowMutatingTools }) {
  const events = []; // in-memory only; no default persistence
  const sessionManager = getGoPeakSessionManager();
  const startInfo = await sessionManager.ensureStarted();
  console.log("[GoPeakWrapper] session owner initialized", {
    reused_existing_session: Boolean(startInfo?.reused),
    status: sessionManager.getStatus(),
  });

  const discovered = await sessionManager.listAvailableTools({ refresh: true });
  if (!discovered?.ok) {
    console.error("[GoPeakWrapper] discovery failed:", discovered?.error ?? "unknown");
    return { ok: false, events };
  }

  const rawTools = normalizeRawTools(discovered?.tools ?? []);
  const manifest = deriveSupportedOperations(rawTools);
  const supportedOps = new Set(
    (Array.isArray(manifest?.operations) ? manifest.operations : [])
      .filter((o) => o?.enabled)
      .map((o) => String(o.operation))
  );

  console.log(`[GoPeakWrapper] discovered tools: ${rawTools.length}`);
  console.log(`[GoPeakWrapper] tool_names=${JSON.stringify(rawTools.map((t) => t.name))}`);
  console.log(`[GoPeakWrapper] supported operations: ${JSON.stringify(manifest.summary, null, 2)}`);

  let bridge = null;
  try {
    bridge = await sessionManager.waitForBridgeReady(projectRoot, { timeoutMs: 1000, pollMs: 250 });
  } catch {
    bridge = null;
  }
  const connectedProjectPath = await sessionManager.getConnectedProjectPath().catch(() => null);
  const prerequisiteContext = {
    projectRoot,
    bridgeReady: Boolean(bridge?.isBridgeReady),
    runtimeAddonReady: false,
    lspReady: false,
    dapReady: false,
  };
  console.log("[GoPeakWrapper] prerequisite context", {
    bridge_ready: prerequisiteContext.bridgeReady,
    connected_project_path: connectedProjectPath,
  });

  // Wrapper now tests canonical operations (same contract as edit mode/executor),
  // while still printing raw discovery for transparency.
  const registryOps = getAllOperationDefinitions();
  const counts = {
    total: registryOps.length,
    supported: 0,
    unsupported: 0,
    prerequisite_missing: 0,
    executed: 0,
    fallback_used: 0,
    expected_outcome_verified: 0,
    skipped: 0,
    failed: 0,
  };
  const byCategory = {}; // operation category

  for (const def of registryOps) {
    const op = String(def.operation);
    const category = String(def.category ?? "unknown");
    byCategory[category] = byCategory[category] ?? { total: 0, executed: 0, failed: 0, skipped: 0 };
    byCategory[category].total += 1;

    if (!supportedOps.has(op)) {
      counts.unsupported += 1;
      byCategory[category].skipped += 1;
      events.push({ operation: op, category, status: "unsupported", reason: "not enabled by discovery" });
      console.log(`[UNSUPPORTED] ${op} | category=${category} | reason=not enabled by discovery`);
      continue;
    }
    counts.supported += 1;

    const prerequisites = getOperationPrerequisites(op);
    const eligible = hasPrerequisites(prerequisites, prerequisiteContext);
    if (!eligible) {
      const primaryMissing = prerequisites.find((p) => !hasPrerequisites([p], prerequisiteContext)) ?? "unknown";
      const reason = explainSkipReason({
        prerequisiteClass: primaryMissing,
        toolName: op,
        missingContext: prerequisiteContext,
      });
      counts.prerequisite_missing += 1;
      byCategory[category].skipped += 1;
      events.push({ operation: op, category, status: "prerequisite_missing", reason });
      console.log(`[PREREQUISITE_MISSING] ${op} | category=${category} | reason=${reason}`);
      continue;
    }

    const placeholderPolicy = getOperationPlaceholderPolicy(op);
    const params = buildCanonicalOperationParams({
      operation: op,
      projectRoot,
      placeholderPolicy,
    });
    if (!allowMutatingTools && ["create_script_file", "modify_script_file", "rename_project"].includes(op)) {
      counts.skipped += 1;
      byCategory[category].skipped += 1;
      events.push({ operation: op, category, status: "skipped", reason: "mutating op requires --allow-mutating-tools" });
      console.log(`[SKIPPED] ${op} | category=${category} | reason=mutating op requires --allow-mutating-tools`);
      continue;
    }

    try {
      const start = Date.now();
      const res = await executor.executeOperation({ action: op, params });
      const elapsed = Date.now() - start;
      counts.executed += 1;
      byCategory[category].executed += 1;
      const failed = res?.ok !== true;
      if (failed) {
        counts.failed += 1;
        byCategory[category].failed += 1;
        const reason = safeError(res?.error ?? "operation failed");
        events.push({
          operation: op,
          category,
          status: "failed",
          params,
          fallback_used: Boolean(res?.fallback_used),
          expected_outcome_verified: Boolean(res?.expected_outcome_verified),
          reason,
          elapsed_ms: elapsed,
        });
        console.log(`[FAILED] ${op} | category=${category} | args=${summarizeArgs(params)} | reason=${reason}`);
      } else {
        if (res?.fallback_used) counts.fallback_used += 1;
        if (res?.expected_outcome_verified) counts.expected_outcome_verified += 1;
        events.push({
          operation: op,
          category,
          status: "executed",
          params,
          fallback_used: Boolean(res?.fallback_used),
          expected_outcome_verified: Boolean(res?.expected_outcome_verified),
          reason: null,
          elapsed_ms: elapsed,
        });
        console.log(
          `[EXECUTED] ${op} | category=${category} | args=${summarizeArgs(params)} | fallback_used=${Boolean(res?.fallback_used)} | expected_outcome_verified=${Boolean(res?.expected_outcome_verified)} | elapsed_ms=${elapsed}`
        );
      }
    } catch (err) {
      counts.failed += 1;
      byCategory[category].failed += 1;
      const reason = safeError(err);
      events.push({
        operation: op,
        category,
        status: "failed",
        params,
        reason,
      });
      console.log(`[FAILED] ${op} | category=${category} | args=${summarizeArgs(params)} | reason=${reason}`);
    }
  }

  console.log("\n=== GoPeak Wrapper Summary ===");
  console.log(
    JSON.stringify(
      {
        counts,
        by_category: byCategory,
      },
      null,
      2
    )
  );

  return { ok: true, counts, byCategory, events };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.testAll) {
    usage();
    process.exit(1);
  }

  const projectRoot = path.resolve(process.cwd(), String(opts.projectRoot));
  console.log(`[GoPeakWrapper] mode=test-all`);
  console.log(`[GoPeakWrapper] project_root=${projectRoot}`);
  console.log(`[GoPeakWrapper] allow_mutating_tools=${opts.allowMutatingTools ? "true" : "false"}`);

  const sessionManager = getGoPeakSessionManager();
  await sessionManager.ensureStarted();
  const executor = GodotExecutor.fromConfig({
    config: { project_root: projectRoot },
    mcpClient: null, // executor adapts over session-manager-owned MCP session
  });
  console.log("[GoPeakWrapper] executor created over backend-owned session", executor.getMcpSessionInfo());

  const res = await runTestAll({
    executor,
    projectRoot,
    allowMutatingTools: opts.allowMutatingTools,
  });
  process.exit(res?.ok ? 0 : 2);
}

main().catch((err) => {
  console.error("[GoPeakWrapper] fatal error:", err?.stack ?? String(err));
  process.exit(1);
});

