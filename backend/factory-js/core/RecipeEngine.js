/**
 * RecipeEngine (prototype)
 * ------------------------
 * A deterministic, minimal execution layer for the prototype.
 *
 * Why this exists:
 * - Keep the editor/wrapper flows from "improvising" raw MCP details.
 * - Ensure every supported operation runs through the same lifecycle:
 *   1) prerequisite check
 *   2) inspect (pre-state)
 *   3) execute (single canonical action)
 *   4) validate (requested semantic outcomes)
 *   5) summarize result
 *
 * The prototype intentionally supports only a small, explicit set of
 * operations. No broad fallback logic is used: unsupported operations
 * fail fast with clear messages.
 */

import fs from "node:fs";
import path from "node:path";

import {
  getOperationPrerequisites,
  getOperationContextRequirements,
  operationExists,
  validateOperationParams,
} from "./godot/GoPeakOperationRegistry.js";

const SUPPORTED_RECIPES = Object.freeze([
  "inspect_scene",
  "list_scene_nodes",
  "get_node_properties",
  "create_scene",
  "add_node",
  "set_node_properties",
  "save_scene",
  "create_script_file",
]);

function safeString(v) {
  return v == null ? "" : String(v);
}

function isPlainObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function normalizeResPath(maybeResOrRel) {
  const p = safeString(maybeResOrRel).trim();
  if (!p) return null;
  if (p.startsWith("res://")) return p;
  return `res://${p.replace(/^\.?\//, "")}`;
}

function resolveResPathToFsAbs(projectRoot, resOrRelPath) {
  const resPath = normalizeResPath(resOrRelPath);
  if (!resPath) return null;
  const rel = String(resPath).replace(/^res:\/\//, "").replace(/^\/+/, "");
  return path.resolve(projectRoot, rel);
}

function parseSceneRootNodeFromTscn(sceneRaw) {
  // Expected pattern in Godot .tscn:
  // [node name="RootName" type="NodeType"...]
  const m = String(sceneRaw ?? "").match(/\[node\s+name="([^"]+)"\s+type="([^"]+)"/);
  if (!m) return null;
  return { name: m?.[1] ?? null, type: m?.[2] ?? null };
}

function nodeLineMatches(sceneRaw, nodeName, nodeType) {
  const name = safeString(nodeName).trim();
  const type = safeString(nodeType).trim();
  if (!name && !type) return false;
  const nPart = name ? `name="${name}"` : null;
  const tPart = type ? `type="${type}"` : null;
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const escapedType = type.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (name && type) {
    return String(sceneRaw ?? "").includes(`[node ${nPart} ${tPart}`) || Boolean(
      String(sceneRaw ?? "").match(new RegExp(`\\[node\\s+${nPart}\\s+${tPart}`))
    );
  }
  if (name) {
    const r = new RegExp(`\\[node\\s+name="${escapedName}"`);
    return Boolean(String(sceneRaw ?? "").match(r));
  }
  const r = new RegExp(`\\[node\\s+type="${escapedType}"`);
  return Boolean(String(sceneRaw ?? "").match(r));
}

function validateCreateSceneSemantics({ projectRoot, params, executionResult }) {
  const sceneAbs = resolveResPathToFsAbs(projectRoot, params?.scene_path);
  const sceneExists = Boolean(sceneAbs && fs.existsSync(sceneAbs));
  const sceneRaw = sceneExists ? fs.readFileSync(sceneAbs, "utf-8") : "";

  const expectedName = safeString(params?.root_node_name).trim();
  const expectedType = safeString(params?.root_node_type).trim();

  const rootNode = parseSceneRootNodeFromTscn(sceneRaw);
  const actualName = rootNode?.name ?? null;
  const actualType = rootNode?.type ?? null;

  // GoPeak may not allow setting root node name via its create-scene contract.
  // We only enforce name expectations when the raw MCP args include a key that
  // indicates name was actually passed.
  const translatedRaw = executionResult?.output?.translated_payload ?? {};
  const supportsRootName =
    isPlainObject(translatedRaw) &&
    (Object.prototype.hasOwnProperty.call(translatedRaw, "rootNodeName") ||
      Object.prototype.hasOwnProperty.call(translatedRaw, "node_name") ||
      Object.prototype.hasOwnProperty.call(translatedRaw, "nodeName"));

  const typeOk = expectedType ? actualType === expectedType : true;
  const nameOk = supportsRootName ? (expectedName ? actualName === expectedName : true) : true;

  return {
    ok: sceneExists && typeOk && nameOk,
    scene_exists: sceneExists,
    expected: { root_node_name: expectedName || null, root_node_type: expectedType || null },
    actual: { root_node_name: actualName, root_node_type: actualType },
    supports_root_node_name: supportsRootName,
    type_match: typeOk,
    name_match: nameOk,
  };
}

function validateAddNodeSemantics({ projectRoot, params }) {
  const sceneAbs = resolveResPathToFsAbs(projectRoot, params?.scene_path);
  const sceneExists = Boolean(sceneAbs && fs.existsSync(sceneAbs));
  const sceneRaw = sceneExists ? fs.readFileSync(sceneAbs, "utf-8") : "";

  const expectedName = safeString(params?.node_name).trim();
  const expectedType = safeString(params?.node_type).trim();
  const ok = sceneExists && nodeLineMatches(sceneRaw, expectedName, expectedType);

  return {
    ok,
    scene_exists: sceneExists,
    expected: { node_name: expectedName || null, node_type: expectedType || null },
    actual: null,
  };
}

function validateSetNodePropertiesSemantics({ projectRoot, params }) {
  const sceneAbs = resolveResPathToFsAbs(projectRoot, params?.scene_path);
  const sceneExists = Boolean(sceneAbs && fs.existsSync(sceneAbs));
  const sceneRaw = sceneExists ? fs.readFileSync(sceneAbs, "utf-8") : "";

  const props = isPlainObject(params?.properties) ? params.properties : {};
  const keys = Object.keys(props);
  if (!sceneExists) {
    return { ok: false, scene_exists: false, missing_properties_keys: keys };
  }
  // Conservative: check each property key appears with `key =` somewhere.
  const perKey = keys.map((k) => {
    const hasKey = String(sceneRaw).includes(`${k} =`);
    const value = props?.[k];
    const hasValue =
      value == null
        ? false
        : typeof value === "object"
          ? true // structure printed; ensure the key exists
          : String(sceneRaw).includes(String(value));
    return { key: k, has_key: hasKey, has_value: hasValue };
  });

  const ok = perKey.every((x) => x.has_key);
  return {
    ok,
    scene_exists: true,
    properties_checked: perKey,
  };
}

function validateSaveSceneSemantics({ projectRoot, params }) {
  const sceneAbs = resolveResPathToFsAbs(projectRoot, params?.scene_path);
  const sceneExists = Boolean(sceneAbs && fs.existsSync(sceneAbs));
  return {
    ok: sceneExists,
    scene_exists: sceneExists,
  };
}

function validateCreateScriptFileSemantics({ projectRoot, params }) {
  const scriptAbs = resolveResPathToFsAbs(projectRoot, params?.script_path);
  const scriptExists = Boolean(scriptAbs && fs.existsSync(scriptAbs));
  const content = params?.content;
  const fileContent = scriptExists ? fs.readFileSync(scriptAbs, "utf-8") : "";
  const contentOk =
    typeof content === "string" && content.trim().length > 0 ? fileContent.includes(content.trim()) : true;

  return {
    ok: scriptExists && contentOk,
    script_exists: scriptExists,
    content_match: contentOk,
  };
}

class RecipeEngine {
  constructor() {}

  /**
   * Main entry: run a single recipe for one operation.
   *
   * @param {object} args
   * @param {string} args.operation - one of SUPPORTED_RECIPES
   * @param {object} args.params - canonical operation params
   * @param {import('./GodotExecutor.js').GodotExecutor} args.executor - factory executor
   * @param {string} args.projectRoot - filesystem project root (absolute path)
   */
  async runRecipe({ operation, params = {}, executor = null, projectRoot = null } = {}) {
    const op = safeString(operation).trim();
    if (!SUPPORTED_RECIPES.includes(op)) {
      return this._normalizedRecipeResult({
        ok: false,
        operation: op,
        phase: "precheck",
        error: `Unsupported prototype operation: ${op}`,
        inputs: params,
      });
    }
    if (!projectRoot || !isNonEmptyString(projectRoot)) {
      return this._normalizedRecipeResult({
        ok: false,
        operation: op,
        phase: "precheck",
        error: "Missing required projectRoot for prototype recipe execution.",
        inputs: params,
      });
    }

    if (!executor || typeof executor.executeOperation !== "function") {
      return this._normalizedRecipeResult({
        ok: false,
        operation: op,
        phase: "precheck",
        error: "GodotExecutor is required for prototype recipe execution.",
        inputs: params,
      });
    }

    // 1) prerequisite check
    const prerequisite = await this._checkPrerequisites({ operation: op, params, executor, projectRoot });
    if (!prerequisite.ok) {
      return this._normalizedRecipeResult({
        ok: false,
        operation: op,
        phase: "prerequisite_check",
        error: prerequisite.error,
        inputs: params,
        output: { prerequisite },
      });
    }

    // 2) inspect
    const inspect = this._inspectPreState({ operation: op, params, projectRoot });

    // 3) execute
    let executionResult = null;
    if (op === "inspect_scene") {
      if (inspect?.ok !== true) {
        executionResult = {
          ok: false,
          status: "failed",
          action: "inspect_scene",
          operation: "inspect_scene",
          backend: "prototype_local",
          primary_path_attempted: "inspect_pre_state",
          primary_path_succeeded: false,
          expected_outcome_verified: false,
          inputs: params,
          output: inspect,
          error: "inspect_scene pre-state failed.",
        };
      } else {
        // Always run list_scene_nodes first; only fetch get_node_properties when
        // the request targets a specific node.
        const listRes = await executor.executeOperation({
          action: "list_scene_nodes",
          params,
        });

        const hasNodeTarget =
          Boolean(safeString(params?.node_path).trim()) ||
          Boolean(safeString(params?.node_name).trim()) ||
          Boolean(safeString(params?.target).trim()) ||
          Boolean(safeString(params?.target_intent).trim());

        let propsRes = null;
        if (hasNodeTarget) {
          propsRes = await executor.executeOperation({
            action: "get_node_properties",
            params,
          });
        }

        const ok = Boolean(listRes?.ok === true) && (propsRes ? Boolean(propsRes?.ok === true) : true);
        executionResult = {
          ok,
          status: ok ? "success" : "failed",
          action: "inspect_scene",
          operation: "inspect_scene",
          backend: "prototype_mcp_inspection",
          primary_path_attempted: hasNodeTarget ? "list_scene_nodes+get_node_properties" : "list_scene_nodes",
          primary_path_succeeded: ok,
          expected_outcome_verified: ok,
          inputs: params,
          output: {
            scene_exists: inspect?.scene_exists ?? true,
            root_node: inspect?.root_node ?? null,
            nodes: listRes?.output?.nodes ?? [],
            properties: propsRes?.output?.properties ?? null,
            execution: { list: listRes, props: propsRes },
          },
          error: ok ? null : listRes?.error ?? propsRes?.error ?? "inspect_scene failed",
        };
      }
    } else {
      // Validate canonical params deterministically (registry contract).
      const paramValidation =
        operationExists(op) ? validateOperationParams(op, params) : { ok: false, error: "Unknown operation." };
      if (!paramValidation.ok) {
        return this._normalizedRecipeResult({
          ok: false,
          operation: op,
          phase: "validate_params",
          error: paramValidation.error ?? "Invalid operation parameters.",
          inputs: params,
          output: { param_validation: paramValidation },
        });
      }

      // Target-resolution step (inspect-first contract):
      // For node mutations we resolve node targets deterministically via the
      // executor before executing. This avoids brittle guessing in the planner.
      if (
        executor &&
        typeof executor.resolveSceneNodeMutationTargets === "function" &&
        ["add_node", "set_node_properties", "get_node_properties"].includes(op)
      ) {
        try {
          const resolved = await executor.resolveSceneNodeMutationTargets({ operation: op, params, projectRoot });
          if (resolved?.ok === true && isPlainObject(resolved?.params)) {
            params = resolved.params;
          }
        } catch (err) {
          return this._normalizedRecipeResult({
            ok: false,
            operation: op,
            phase: "target_resolution",
            error: safeString(err?.message ?? err),
            inputs: params,
          });
        }
      }

      executionResult = await executor.executeOperation({ action: op, params });
    }

    // 4) validate
    const validation = this._validateOutcome({ operation: op, params, projectRoot, executionResult });
    const ok = Boolean(executionResult?.ok === true) && Boolean(validation?.ok === true);

    // 5) summarize
    // Keep read-only inspect_scene summary fields at the recipe top-level output,
    // so downstream terminal rendering uses the same normalized node list source
    // as list_scene_nodes (no stale/alternate node fields).
    const summaryOutput = {
      prerequisite,
      inspect,
      execution: executionResult,
      validation,
    };
    if (op === "inspect_scene") {
      summaryOutput.nodes = Array.isArray(executionResult?.output?.nodes)
        ? executionResult.output.nodes
        : [];
      summaryOutput.properties = isPlainObject(executionResult?.output?.properties)
        ? executionResult.output.properties
        : null;
      summaryOutput.scene_exists = executionResult?.output?.scene_exists === true;
      summaryOutput.root_node = isPlainObject(executionResult?.output?.root_node)
        ? executionResult.output.root_node
        : null;
    }

    return this._normalizedRecipeResult({
      ok,
      operation: op,
      phase: "complete",
      error: ok ? null : validation?.error ?? "Recipe validation failed.",
      inputs: params,
      output: summaryOutput,
    });
  }

  async _checkPrerequisites({ operation, params, executor, projectRoot }) {
    const prereqs = getOperationPrerequisites(operation) ?? [];

    // project_required: ensure the target projectRoot exists.
    if (prereqs.includes("project_required")) {
      if (!fs.existsSync(projectRoot) || !fs.statSync(projectRoot).isDirectory()) {
        return { ok: false, error: `project_required failed: projectRoot missing/invalid: ${projectRoot}` };
      }
    }

    // editor_bridge_required: require bridge readiness via executor (deterministic).
    if (prereqs.includes("editor_bridge_required")) {
      if (!executor || typeof executor.getBridgeStatus !== "function") {
        return { ok: false, error: "editor_bridge_required failed: executor.getBridgeStatus missing." };
      }
      const status = await executor.getBridgeStatus({ expectedProjectRoot: projectRoot });
      const output = status?.output ?? {};
      const isBridgeReady = output.isBridgeReady === true;
      const projectMatches = output.projectMatches === true;
      if (!status?.ok || !isBridgeReady || !projectMatches) {
        return {
          ok: false,
          error: `editor_bridge_required failed: isBridgeReady=${String(isBridgeReady)} projectMatches=${String(projectMatches)}.`,
          status,
        };
      }
    }

    // connected_project_path injection: rely on executor for injection requirements.
    // Here we just ensure executor can derive context without MCP call failure.
    const contextReqs = getOperationContextRequirements(operation);
    if (contextReqs.length > 0) {
      if (!executor || typeof executor.getBridgeStatus !== "function") {
        return { ok: false, error: `context injection failed: executor.getBridgeStatus missing.` };
      }
      const status = await executor.getBridgeStatus({ expectedProjectRoot: projectRoot });
      const cp = status?.output?.connectedProjectPath ?? null;
      const needsConnected = contextReqs.includes("connected_project_path_context_required");
      if (needsConnected && !cp) {
        return {
          ok: false,
          error: "connected_project_path_context_required failed: no connectedProjectPath from bridge status.",
          status,
        };
      }
    }

    return { ok: true };
  }

  _inspectPreState({ operation, params, projectRoot }) {
    if (["inspect_scene", "list_scene_nodes", "get_node_properties"].includes(operation)) {
      const sceneAbs = resolveResPathToFsAbs(projectRoot, params?.scene_path);
      const exists = Boolean(sceneAbs && fs.existsSync(sceneAbs));
      if (!exists) {
        return { ok: false, scene_exists: false, scene_abs: sceneAbs ?? null };
      }

      // Light pre-state only: execution uses MCP for source-of-truth.
      // We keep this to produce deterministic "scene_exists" evidence.
      const raw = fs.readFileSync(sceneAbs, "utf-8");
      const root = parseSceneRootNodeFromTscn(raw);
      return {
        ok: true,
        scene_exists: true,
        scene_abs: sceneAbs,
        root_node: root,
      };
    }

    if (operation === "create_scene") {
      const sceneAbs = resolveResPathToFsAbs(projectRoot, params?.scene_path);
      const sceneExists = Boolean(sceneAbs && fs.existsSync(sceneAbs));
      return { ok: true, scene_exists_pre: sceneExists, scene_abs: sceneAbs ?? null };
    }

    if (["add_node", "set_node_properties", "save_scene"].includes(operation)) {
      const sceneAbs = resolveResPathToFsAbs(projectRoot, params?.scene_path);
      const sceneExists = Boolean(sceneAbs && fs.existsSync(sceneAbs));
      return { ok: true, scene_exists_pre: sceneExists, scene_abs: sceneAbs ?? null };
    }

    if (operation === "create_script_file") {
      const scriptAbs = resolveResPathToFsAbs(projectRoot, params?.script_path);
      const scriptExists = Boolean(scriptAbs && fs.existsSync(scriptAbs));
      return { ok: true, script_exists_pre: scriptExists, script_abs: scriptAbs ?? null };
    }

    return { ok: true };
  }

  _validateOutcome({ operation, params, projectRoot, executionResult }) {
    // Default: if the executor already failed, we treat validation as failed.
    if (!executionResult || executionResult?.ok !== true) {
      return { ok: false, error: "Execution did not succeed." };
    }

    if (operation === "create_scene") {
      const check = validateCreateSceneSemantics({
        projectRoot,
        params,
        executionResult,
      });
      return check;
    }

    if (operation === "add_node") {
      return validateAddNodeSemantics({ projectRoot, params });
    }

    if (operation === "set_node_properties") {
      const semanticCheck = executionResult?.output?.semantic_check;
      if (semanticCheck && typeof semanticCheck.match === "boolean") {
        return {
          ok: semanticCheck.match,
          error: semanticCheck.match
            ? null
            : `set_node_properties semantic verification failed (executor): ${safeString(semanticCheck?.error ?? "properties mismatch")}.`,
          semantic_check: semanticCheck,
        };
      }
      return validateSetNodePropertiesSemantics({ projectRoot, params });
    }

    if (operation === "save_scene") {
      return validateSaveSceneSemantics({ projectRoot, params });
    }

    if (operation === "create_script_file") {
      return validateCreateScriptFileSemantics({ projectRoot, params });
    }

    if (operation === "list_scene_nodes") {
      const nodes = executionResult?.output?.nodes;
      const ok = Array.isArray(nodes) && nodes.length > 0;
      return {
        ok,
        validation_type: "read_only_scene_validation",
        error: ok ? null : "list_scene_nodes semantic verification failed: expected non-empty nodes array.",
      };
    }

    if (operation === "get_node_properties") {
      const props = executionResult?.output?.properties;
      // Read-only inspection can legitimately return an empty properties object
      // for some nodes/tools. Treat object presence as success.
      const ok = isPlainObject(props);
      return {
        ok,
        validation_type: "read_only_scene_validation",
        empty_properties: ok ? Object.keys(props).length === 0 : false,
        summary: ok && Object.keys(props).length === 0 ? "Empty property set returned." : null,
        error: ok ? null : "get_node_properties semantic verification failed: expected properties object.",
      };
    }

    if (operation === "inspect_scene") {
      const nodes = executionResult?.output?.nodes;
      const okNodes = Array.isArray(nodes) && nodes.length > 0;
      // If caller targeted a node, properties should be present (may be empty object).
      const wantedProps = Boolean(safeString(params?.node_path).trim()) || Boolean(safeString(params?.node_name).trim()) || Boolean(safeString(params?.target).trim()) || Boolean(safeString(params?.target_intent).trim());
      const props = executionResult?.output?.properties;
      const okProps = wantedProps ? isPlainObject(props) : true;
      const hasStructuredScene =
        executionResult?.output?.scene_exists === true ||
        isPlainObject(executionResult?.output?.root_node) ||
        isPlainObject(executionResult?.output?.execution);
      const ok = okNodes && okProps && hasStructuredScene;
      return {
        ok,
        validation_type: "read_only_scene_validation",
        error: ok ? null : "inspect_scene semantic verification failed: expected structured scene nodes/properties output.",
      };
    }

    return { ok: false, error: `No validator implemented for operation: ${operation}` };
  }

  _normalizedRecipeResult({ ok, operation, phase, error, inputs, output = {} }) {
    return {
      ok: Boolean(ok),
      status: ok ? "success" : "failed",
      operation,
      phase,
      inputs: inputs ?? {},
      output,
      error: error == null ? null : safeString(error),
    };
  }
}

export { RecipeEngine, SUPPORTED_RECIPES };

