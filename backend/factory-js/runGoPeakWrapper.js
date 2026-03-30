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
import { GodotExecutor } from "./core/godot/GodotExecutor.js";
import { RecipeEngine, SUPPORTED_RECIPES } from "./core/RecipeEngine.js";
import { getGoPeakSessionManager } from "./core/godot/GoPeakSessionManager.js";
import { GOPEAK_DISCOVERY_DEBUG } from "./core/godot/GoPeakDebugFlags.js";

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

function safeError(err) {
  if (err?.message) return String(err.message);
  return String(err ?? "Unknown error");
}

const PROTOTYPE_SCENE_PATH = "res://scenes/wrapper_test_scene.tscn";
const PROTOTYPE_ROOT_NODE_NAME = "WrapperTestRoot";
const PROTOTYPE_ROOT_NODE_TYPE = "Node2D";
const PROTOTYPE_NODE_NAME = "WrapperNode";
const PROTOTYPE_NODE_TYPE = "Node2D";
const PROTOTYPE_NODE_PATH = ".";
const PROTOTYPE_SCRIPT_PATH = "scripts/WrapperGenerated.gd";

function buildPrototypeOperationParams(operation) {
  // Canonical params for RecipeEngine + GodotExecutor.
  // This wrapper validates the prototype operation layer, not raw tools.
  switch (operation) {
    case "inspect_scene":
      return { scene_path: PROTOTYPE_SCENE_PATH };
    case "create_scene":
      return {
        scene_path: PROTOTYPE_SCENE_PATH,
        root_node_name: PROTOTYPE_ROOT_NODE_NAME,
        root_node_type: PROTOTYPE_ROOT_NODE_TYPE,
      };
    case "add_node":
      return {
        scene_path: PROTOTYPE_SCENE_PATH,
        node_name: PROTOTYPE_NODE_NAME,
        node_type: PROTOTYPE_NODE_TYPE,
        parent_path: PROTOTYPE_NODE_PATH,
      };
    case "set_node_properties":
      return {
        scene_path: PROTOTYPE_SCENE_PATH,
        node_path: PROTOTYPE_NODE_PATH,
        properties: { visible: true },
      };
    case "save_scene":
      return { scene_path: PROTOTYPE_SCENE_PATH };
    case "create_script_file":
      return {
        script_path: PROTOTYPE_SCRIPT_PATH,
        content: "extends Node\n\nfunc _ready():\n\tprint(\"wrapper generated\")\n",
      };
    default:
      return {};
  }
}

async function runTestAll({ executor, projectRoot, allowMutatingTools = false }) {
  // This wrapper validates the same constrained prototype operation interface
  // used by edit mode (RecipeEngine lifecycle), not the raw discovered tool list.
  const events = [];
  const recipeEngine = new RecipeEngine();

  const supportedOpsRes = await executor.getSupportedOperations();
  const discoveredOperations = Array.isArray(supportedOpsRes?.output?.operations)
    ? supportedOpsRes.output.operations
    : [];

  const enabledMap = new Map(
    discoveredOperations
      .filter((o) => o && typeof o.operation === "string")
      .map((o) => [String(o.operation), Boolean(o.enabled)])
  );

  if (GOPEAK_DISCOVERY_DEBUG) {
    // eslint-disable-next-line no-console
    console.log("[GoPeakWrapper][DEBUG] getSupportedOperations", {
      enabled_operations: discoveredOperations.filter((o) => o?.enabled).map((o) => o.operation),
      disabled_operations: discoveredOperations.filter((o) => !o?.enabled).map((o) => o.operation),
      suppressed: "raw tool inventory is handled inside GodotExecutor when DEBUG_GOPEAK_DISCOVERY=true",
    });
  } else {
    // eslint-disable-next-line no-console
    console.log("[GoPeakWrapper] supported prototype enabled by discovery:", {
      enabled_ops_count: Array.from(enabledMap.values()).filter(Boolean).length,
    });
  }

  const FORCE_ENABLED = new Set(["inspect_scene", "create_script_file"]);
  const counts = {
    total_tested: 0,
    supported: 0,
    skipped_prerequisite_missing: 0,
    semantic_verification_failed: 0,
    failed: 0,
    success: 0,
    unsupported_by_discovery: 0,
    allow_mutating_tools: Boolean(allowMutatingTools),
  };

  const orderedOps = Array.isArray(SUPPORTED_RECIPES)
    ? [...SUPPORTED_RECIPES.filter((o) => o !== "inspect_scene"), "inspect_scene"]
    : [];

  for (const op of orderedOps) {
    const supportedByDiscovery = FORCE_ENABLED.has(op) || enabledMap.get(op) === true;

    if (!supportedByDiscovery) {
      counts.unsupported_by_discovery += 1;
      events.push({ operation: op, status: "unsupported", reason: "not enabled by discovery" });
      // eslint-disable-next-line no-console
      console.log(`[UNSUPPORTED] ${op}`);
      continue;
    }

    counts.supported += 1;
    counts.total_tested += 1;

    const params = buildPrototypeOperationParams(op);
    const start = Date.now();
    let recipeRes = null;
    try {
      recipeRes = await recipeEngine.runRecipe({ operation: op, params, executor, projectRoot });
    } catch (err) {
      const reason = safeError(err);
      counts.failed += 1;
      events.push({ operation: op, status: "failed", reason, error: safeError(err), elapsed_ms: Date.now() - start });
      // eslint-disable-next-line no-console
      console.log(`[FAILED] ${op} | reason=${reason}`);
      continue;
    }

    const elapsed = Date.now() - start;
    if (recipeRes?.ok === true) {
      if (op === "inspect_scene") {
        const sceneExists = recipeRes?.output?.execution?.output?.scene_exists;
        if (sceneExists === false) {
          counts.semantic_verification_failed += 1;
          events.push({
            operation: op,
            status: "semantic verification failed",
            reason: "inspect_scene could not find expected scene on disk",
            elapsed_ms: elapsed,
            inputs: params,
          });
          // eslint-disable-next-line no-console
          console.log(`[SEMANTIC FAILED] ${op} | reason=scene_exists=false`);
          continue;
        }
      }

      counts.success += 1;
      events.push({ operation: op, status: "success", elapsed_ms: elapsed, inputs: params });
      // eslint-disable-next-line no-console
      console.log(`[SUCCESS] ${op} | elapsed_ms=${elapsed}`);
      continue;
    }

    if (recipeRes?.phase === "prerequisite_check") {
      counts.skipped_prerequisite_missing += 1;
      const reason = recipeRes?.output?.prerequisite?.error ?? recipeRes?.error ?? "prerequisite missing";
      events.push({ operation: op, status: "skipped_prerequisite_missing", reason, elapsed_ms: elapsed, inputs: params });
      // eslint-disable-next-line no-console
      console.log(`[SKIPPED] ${op} | prerequisite missing: ${reason}`);
      continue;
    }

    // Semantic verification is the prototype-specific validation layer:
    // - create_scene uses executor semantic_check.match
    // - other operations use RecipeEngine validation checks
    const semanticCheck = recipeRes?.output?.execution?.output?.semantic_check ?? null;
    const validation = recipeRes?.output?.validation ?? null;

    const semanticVerificationFailed =
      Boolean(semanticCheck && semanticCheck.match === false) ||
      Boolean(validation && validation.ok === false && (validation.type_match === false || validation.name_match === false || op !== "create_scene"));

    if (semanticVerificationFailed) {
      counts.semantic_verification_failed += 1;
      let reason = recipeRes?.error ?? "semantic verification failed";
      if (semanticCheck && semanticCheck.match === false) {
        const expected = semanticCheck?.expectation ?? {};
        const actual = semanticCheck?.actual ?? {};
        reason = `create_scene semantic mismatch: expected(type=${expected?.root_node_type ?? "?"}, name=${expected?.root_node_name ?? "?"}) actual(type=${actual?.root_node_type ?? "?"}, name=${actual?.root_node_name ?? "?"})`;
      } else if (validation && validation.ok === false) {
        // RecipeEngine validation checks drive this path for add_node/set_node_properties/save_scene.
        reason = recipeRes?.error ?? "prototype semantic verification failed";
      }
      events.push({
        operation: op,
        status: "semantic verification failed",
        reason,
        elapsed_ms: elapsed,
        inputs: params,
      });
      // eslint-disable-next-line no-console
      console.log(`[SEMANTIC FAILED] ${op} | reason=${reason}`);
      continue;
    }

    counts.failed += 1;
    const reason = recipeRes?.error ?? "operation failed";
    events.push({ operation: op, status: "failed", reason, elapsed_ms: elapsed, inputs: params, recipe_result: recipeRes });
    // eslint-disable-next-line no-console
    console.log(`[FAILED] ${op} | reason=${reason}`);
  }

  // eslint-disable-next-line no-console
  console.log("\n=== Prototype RecipeEngine Wrapper Summary ===");
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(counts, null, 2));

  return { ok: true, counts, events };
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

