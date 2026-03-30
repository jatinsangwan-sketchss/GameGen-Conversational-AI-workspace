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
  getOperationContextRequirements,
} from "./GoPeakOperationRegistry.js";
import { GOPEAK_DISCOVERY_DEBUG } from "./GoPeakDebugFlags.js";
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
    const resolutionDebug = GOPEAK_DISCOVERY_DEBUG;
    if (resolutionDebug) {
      // eslint-disable-next-line no-console
      console.log("[GodotExecutor] raw MCP tool normalization", {
        operation,
        discovered_tools: normalizedDiscoveredTools,
      });
    }
    for (const alias of Array.isArray(aliases) ? aliases : []) {
      const normalizedAlias = normalizeToolKey(alias);
      const m = byKey.get(normalizedAlias);
      if (resolutionDebug) {
        // eslint-disable-next-line no-console
        console.log("[GodotExecutor] MCP tool alias resolution", {
          operation,
          raw_tool_name: alias,
          normalized_tool_key: normalizedAlias,
          resolved_tool_match: m ?? null,
        });
      }
      if (m) return { ok: true, tool_name: m };
    }
    return {
      ok: false,
      error: `unresolved_operation:${operation} missing required raw MCP tool mapping`,
      tool_name: null,
      available_tools: names,
    };
  }

  async _getInspectionToolEntries() {
    if (this._inspectionToolEntries && this._inspectionToolEntries.list && this._inspectionToolEntries.getProps) {
      return this._inspectionToolEntries;
    }

    const listed = await this.listAvailableTools();
    if (!listed?.ok) return { ok: false, error: listed?.error ?? "tool discovery unavailable", list: null, getProps: null };

    const tools = Array.isArray(listed?.output?.tools) ? listed.output.tools : [];
    const byKey = new Map(tools.map((t) => [normalizeToolKey(String(t?.name ?? "")), t]));

    const findEntry = (aliases) => {
      for (const a of aliases) {
        const k = normalizeToolKey(a);
        const hit = byKey.get(k);
        if (hit) return hit;
      }
      return null;
    };

    const listEntry = findEntry(["list-scene-nodes", "list_scene_nodes", "listSceneNodes"]);
    const getPropsEntry = findEntry(["get-node-properties", "get_node_properties", "getNodeProperties"]);

    this._inspectionToolEntries = { ok: Boolean(listEntry && getPropsEntry), error: null, list: listEntry, getProps: getPropsEntry };
    return this._inspectionToolEntries;
  }

  _extractInputSchemaKeys(inputSchema) {
    if (!inputSchema || typeof inputSchema !== "object") return [];
    if (isPlainObject(inputSchema) && isPlainObject(inputSchema.properties)) {
      return Object.keys(inputSchema.properties);
    }
    if (Array.isArray(inputSchema?.required)) return inputSchema.required.map((x) => String(x));
    return [];
  }

  _buildInspectionArgs({ toolEntry, executionContext, scenePath, nodePath = null } = {}) {
    const sceneResPath = normalizeResPath(scenePath);
    const sceneFsRel = String(sceneResPath ?? "").replace(/^res:\/\//, "").replace(/^\/+/, "");
    const projectPath = executionContext?.projectPath ?? executionContext?.connectedProjectPath ?? this.projectRoot;

    const candidateValues = {
      scene_path: sceneResPath,
      scenePath: sceneFsRel,
      projectPath,
      project_path: projectPath,
      project_root: projectPath,
      projectRoot: projectPath,
      node_path: nodePath,
      nodePath,
    };

    const schemaKeys = this._extractInputSchemaKeys(toolEntry?.input_schema);
    const requiredKeys = Array.isArray(toolEntry?.input_schema?.required)
      ? toolEntry.input_schema.required.map((x) => String(x))
      : [];
    const keysToUse = schemaKeys.length > 0 ? schemaKeys : Object.keys(candidateValues);

    const out = {};
    for (const key of keysToUse) {
      if (candidateValues[key] != null) {
        out[key] = candidateValues[key];
        continue;
      }
      const k = String(key).toLowerCase();
      if (k.includes("scenepath")) out[key] = sceneFsRel;
      else if (k.includes("scene_path")) out[key] = sceneResPath;
      else if (k.includes("projectpath") || k.includes("project_path") || k.includes("projectroot") || k.includes("project_root")) out[key] = projectPath;
      else if (k.includes("nodepath") || k.includes("node_path")) out[key] = nodePath;
    }

    // If schema declares required keys but we couldn't satisfy them from
    // canonical inputs, let the MCP tool report the contract mismatch.
    // This keeps inspection arg building deterministic without hard-failing
    // due to schema key casing differences.
    if (requiredKeys.length > 0 && GOPEAK_DISCOVERY_DEBUG) {
      const missing = requiredKeys.filter((k) => out[k] == null);
      if (missing.length > 0) {
        // eslint-disable-next-line no-console
        console.log("[GodotExecutor][Inspection][DEBUG] missing required arg keys for inspection tool", {
          tool: toolEntry?.name,
          missing,
        });
      }
    }

    // Hard fallback for missing schema: use the most likely key casing.
    if (Object.keys(out).length === 0) {
      const toolName = safeString(toolEntry?.name).toLowerCase();
      if (toolName.includes("list") && toolName.includes("scene")) return { scenePath: sceneFsRel, projectPath };
      if (toolName.includes("get") && toolName.includes("node")) return { scenePath: sceneFsRel, nodePath, projectPath };
    }

    return out;
  }

  _normalizeSceneNodesFromInspectionPayload(payload) {
    const raw = payload ?? {};

    // GoPeak/MCP tools may return scene nodes in different shapes:
    // - direct object fields (nodes/items/data.nodes)
    // - raw_response wrappers
    // - content text blocks containing JSON.
    // Normalize all of them to one deterministic shape:
    // [{ node_path, node_name, node_type }, ...]
    const candidates = [];
    const pushCandidate = (value) => {
      if (value == null) return;
      candidates.push(value);
    };

    pushCandidate(raw);
    pushCandidate(raw?.nodes);
    pushCandidate(raw?.scene_nodes);
    pushCandidate(raw?.items);
    pushCandidate(raw?.data?.nodes);
    pushCandidate(raw?.data?.items);
    pushCandidate(raw?.output?.nodes);
    pushCandidate(raw?.output?.scene_nodes);
    pushCandidate(raw?.value?.nodes);
    pushCandidate(raw?.value?.scene_nodes);
    pushCandidate(raw?.mcp_trace?.raw_response);
    pushCandidate(raw?.mcp_trace?.raw_response?.nodes);
    pushCandidate(raw?.mcp_trace?.raw_response?.scene_nodes);
    pushCandidate(raw?.mcp_trace?.raw_response?.data?.nodes);
    pushCandidate(raw?.mcp_trace?.raw_response?.result?.nodes);
    pushCandidate(raw?.tree);
    pushCandidate(raw?.data?.tree);
    pushCandidate(raw?.result?.tree);
    pushCandidate(raw?.mcp_trace?.raw_response?.tree);

    // Also inspect MCP content blocks that often store JSON as text.
    const contentBlocks = [
      ...(Array.isArray(raw?.content) ? raw.content : []),
      ...(Array.isArray(raw?.mcp_trace?.raw_response?.content) ? raw.mcp_trace.raw_response.content : []),
    ];

    if (GOPEAK_DISCOVERY_DEBUG) {
      // eslint-disable-next-line no-console
      console.log("[GodotExecutor][Inspection][list_scene_nodes][DEBUG] raw_output", prettyForLog(raw));
      // eslint-disable-next-line no-console
      console.log("[GodotExecutor][Inspection][list_scene_nodes][DEBUG] raw_output.content", contentBlocks.length > 0 ? prettyForLog(contentBlocks) : "none");
    }

    for (const block of contentBlocks) {
      if (!isPlainObject(block)) continue;
      if (isPlainObject(block?.json)) pushCandidate(block.json);
      if (Array.isArray(block?.json)) pushCandidate(block.json);
      if (isPlainObject(block?.data)) pushCandidate(block.data);
      if (Array.isArray(block?.data)) pushCandidate(block.data);
      const text = safeString(block?.text).trim();
      if (!text) continue;
      if (GOPEAK_DISCOVERY_DEBUG) {
        // eslint-disable-next-line no-console
        console.log("[GodotExecutor][Inspection][list_scene_nodes][DEBUG] content.text_before_parse", text);
      }
      const parsed = parseJsonTextCandidatesDetailed(text);
      if (Array.isArray(parsed?.errors) && parsed.errors.length > 0) {
        if (GOPEAK_DISCOVERY_DEBUG) {
          // eslint-disable-next-line no-console
          console.log("[GodotExecutor][Inspection][list_scene_nodes][DEBUG] parse_failures", prettyForLog(parsed.errors));
        }
      }
      if (Array.isArray(parsed?.parsed) && parsed.parsed.length > 0) {
        if (GOPEAK_DISCOVERY_DEBUG) {
          // eslint-disable-next-line no-console
          console.log(
            "[GodotExecutor][Inspection][list_scene_nodes][DEBUG] parsed_json_candidates",
            prettyForLog(
              parsed.parsed.map((v) => ({
                value_type: Array.isArray(v) ? "array" : typeof v,
                top_level_keys: isPlainObject(v) ? Object.keys(v) : [],
                array_len: Array.isArray(v) ? v.length : null,
              }))
            )
          );
        }
      } else if (GOPEAK_DISCOVERY_DEBUG) {
        // eslint-disable-next-line no-console
        console.log("[GodotExecutor][Inspection][list_scene_nodes][DEBUG] parsed_json_candidates", "none");
      }
      for (const p of parsed?.parsed ?? []) pushCandidate(p);
    }

    const out = [];
    const seen = new Set();
    const flattenTree = (node, acc = []) => {
      if (!isPlainObject(node)) return acc;
      const name = safeString(node?.name).trim();
      const pathVal = safeString(node?.path).trim();
      const type = safeString(node?.type).trim();
      if (name || pathVal || type) {
        acc.push({
          node_name: name || null,
          node_path: pathVal || null,
          node_type: type || null,
          name: name || null,
          path: pathVal || null,
          type: type || null,
        });
      }
      const children = Array.isArray(node?.children) ? node.children : [];
      for (const child of children) flattenTree(child, acc);
      return acc;
    };
    const ingestArray = (arr) => {
      if (!Array.isArray(arr)) return;
      for (const n of arr) {
        const obj = isPlainObject(n) ? n : {};
        const nodePathRaw = obj?.path ?? obj?.node_path ?? obj?.nodePath ?? obj?.full_path ?? obj?.fullPath ?? null;
        const nodeNameRaw = obj?.name ?? obj?.node_name ?? obj?.nodeName ?? obj?.label ?? null;
        const nodeTypeRaw = obj?.type ?? obj?.node_type ?? obj?.nodeType ?? obj?.class ?? null;
        const nodePath = safeString(nodePathRaw).trim();
        const nodeName = safeString(nodeNameRaw).trim();
        const nodeType = safeString(nodeTypeRaw).trim();
        if (!nodePath && !nodeName) continue;
        const key = `${nodePath}::${nodeName}::${nodeType}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          node_path: nodePath || null,
          node_name: nodeName || null,
          node_type: nodeType || null,
          path: nodePath || null,
          name: nodeName || null,
          type: nodeType || null,
        });
      }
    };

    for (const c of candidates) {
      if (Array.isArray(c)) {
        ingestArray(c);
        continue;
      }
      if (isPlainObject(c)) {
        if (isPlainObject(c?.tree)) {
          ingestArray(flattenTree(c.tree, []));
        }
        // GoPeak list-scene-nodes common shape:
        // { tree: { name, path, type, children: [...] } }
        if (
          (Object.prototype.hasOwnProperty.call(c, "children") || Object.prototype.hasOwnProperty.call(c, "path")) &&
          !Array.isArray(c)
        ) {
          ingestArray(flattenTree(c, []));
        }
        ingestArray(c?.nodes);
        ingestArray(c?.scene_nodes);
        ingestArray(c?.items);
        ingestArray(c?.data?.nodes);
        ingestArray(c?.data?.items);
        ingestArray(c?.result?.nodes);
        if (isPlainObject(c?.data?.tree)) ingestArray(flattenTree(c.data.tree, []));
        if (isPlainObject(c?.result?.tree)) ingestArray(flattenTree(c.result.tree, []));
      }
    }

    if (GOPEAK_DISCOVERY_DEBUG) {
      // eslint-disable-next-line no-console
      console.log("[GodotExecutor][Inspection][list_scene_nodes][DEBUG] normalization_summary", {
        raw_shape_keys: isPlainObject(raw) ? Object.keys(raw) : [],
        candidate_count: candidates.length,
        normalized_node_count: out.length,
        normalized_nodes_preview: out.slice(0, 5),
      });
      if (out.length === 0) {
        const discoveredTopKeys = [];
        for (const c of candidates) {
          if (isPlainObject(c)) discoveredTopKeys.push(...Object.keys(c));
        }
        // eslint-disable-next-line no-console
        console.log("[GodotExecutor][Inspection][list_scene_nodes][DEBUG] no_nodes_discovered_top_level_keys", [...new Set(discoveredTopKeys)]);
      }
    }

    return out;
  }

  async _listSceneNodesForInspection({ scenePath, executionContext } = {}) {
    const tools = await this._getInspectionToolEntries();
    if (!tools?.list) {
      return { ok: false, error: "Missing list_scene_nodes tool in discovery." };
    }
    const args = this._buildInspectionArgs({ toolEntry: tools.list, executionContext, scenePath });
    const res = await this._runMcpAction("list_scene_nodes", tools.list.name, args);
    if (!res?.ok) return { ok: false, error: res?.error ?? "list_scene_nodes failed." };
    const nodes = this._normalizeSceneNodesFromInspectionPayload(res?.output);
    // eslint-disable-next-line no-console
    console.log("[GodotExecutor][Inspection][list_scene_nodes] normalized_result", {
      scene_path: scenePath,
      normalized_node_count: nodes.length,
      preview: GOPEAK_DISCOVERY_DEBUG ? nodes.slice(0, 3) : undefined,
    });
    return { ok: true, nodes, tool_result: res };
  }

  _extractPropertiesMapFromGetNodePropertiesPayload(payload) {
    const raw = payload ?? {};
    const toPropertiesMapFromEntries = (entries) => {
      if (!Array.isArray(entries) || entries.length === 0) return null;
      const out = {};
      for (const entry of entries) {
        if (!isPlainObject(entry)) continue;
        const key =
          safeString(entry?.name).trim() ||
          safeString(entry?.property).trim() ||
          safeString(entry?.key).trim();
        if (!key) continue;
        if (Object.prototype.hasOwnProperty.call(entry, "value")) out[key] = entry.value;
        else if (Object.prototype.hasOwnProperty.call(entry, "current_value")) out[key] = entry.current_value;
        else if (Object.prototype.hasOwnProperty.call(entry, "property_value")) out[key] = entry.property_value;
      }
      return Object.keys(out).length > 0 ? out : null;
    };

    const tryExtractPropertiesFromObject = (obj) => {
      if (!isPlainObject(obj)) return null;
      if (isPlainObject(obj?.properties)) return obj.properties;
      if (isPlainObject(obj?.node_properties)) return obj.node_properties;
      if (isPlainObject(obj?.props)) return obj.props;
      const propertiesList =
        toPropertiesMapFromEntries(obj?.properties) ??
        toPropertiesMapFromEntries(obj?.node_properties) ??
        toPropertiesMapFromEntries(obj?.props) ??
        toPropertiesMapFromEntries(obj?.items) ??
        toPropertiesMapFromEntries(obj?.property_list);
      if (propertiesList) return propertiesList;
      if (isPlainObject(obj?.value?.properties)) return obj.value.properties;
      if (isPlainObject(obj?.value)) return obj.value;
      return null;
    };

    const direct = tryExtractPropertiesFromObject(raw);
    if (direct) return direct;

    // Inspection tools often return JSON as text blocks. Parse those before failing.
    const contentBlocks = [
      ...(Array.isArray(raw?.content) ? raw.content : []),
      ...(Array.isArray(raw?.mcp_trace?.raw_response?.content) ? raw.mcp_trace.raw_response.content : []),
    ];
    for (const block of contentBlocks) {
      const text = safeString(block?.text ?? "").trim();
      if (!text) continue;
      try {
        const parsed = JSON.parse(text);
        const fromParsed = tryExtractPropertiesFromObject(parsed);
        if (fromParsed) return fromParsed;
      } catch {
        // Non-JSON text block; ignore.
      }
    }

    const trace = tryExtractPropertiesFromObject(raw?.mcp_trace?.raw_response);
    if (trace) return trace;

    if (isPlainObject(raw?.properties)) return raw.properties;
    if (isPlainObject(raw?.node_properties)) return raw.node_properties;
    if (isPlainObject(raw?.props)) return raw.props;
    if (isPlainObject(raw?.value?.properties)) return raw.value.properties;
    if (isPlainObject(raw?.value)) return raw.value;
    return null;
  }

  async _getNodePropertiesForInspection({ scenePath, nodePath, executionContext } = {}) {
    const tools = await this._getInspectionToolEntries();
    if (!tools?.getProps) {
      return { ok: false, error: "Missing get_node_properties tool in discovery." };
    }
    const args = this._buildInspectionArgs({ toolEntry: tools.getProps, executionContext, scenePath, nodePath });
    const res = await this._runMcpAction("get_node_properties", tools.getProps.name, args);
    if (!res?.ok) return { ok: false, error: res?.error ?? "get_node_properties failed." };

    // Intentional diagnostic logging step:
    // print the full raw MCP get_node_properties response contract before any
    // normalization so parser fixes can be driven by real payload shape.
    const rawOutput = res?.output ?? null;
    const contentBlocks = Array.isArray(rawOutput?.content) ? rawOutput.content : [];
    const parsedCandidates = [];
    const parsedCandidateTopLevelKeys = [];
    for (let i = 0; i < contentBlocks.length; i += 1) {
      const text = safeString(contentBlocks[i]?.text ?? "");
      if (!text.trim()) continue;
      try {
        const parsed = JSON.parse(text);
        parsedCandidates.push(parsed);
        parsedCandidateTopLevelKeys.push(
          isPlainObject(parsed) ? Object.keys(parsed) : Array.isArray(parsed) ? ["<array>"] : [typeof parsed]
        );
      } catch {
        // Keep diagnostic output-only behavior here; parsing may fail for non-JSON text.
      }
    }
    // eslint-disable-next-line no-console
    console.log("[GodotExecutor][Inspection][get_node_properties][DIAG] full_raw_output_object", rawOutput);
    // eslint-disable-next-line no-console
    console.log("[GodotExecutor][Inspection][get_node_properties][DIAG] output_content_array", contentBlocks);
    for (let i = 0; i < contentBlocks.length; i += 1) {
      // eslint-disable-next-line no-console
      console.log(`[GodotExecutor][Inspection][get_node_properties][DIAG] content[${i}].text_before_parse`, safeString(contentBlocks[i]?.text ?? ""));
    }
    // eslint-disable-next-line no-console
    console.log("[GodotExecutor][Inspection][get_node_properties][DIAG] parsed_json_candidates", parsedCandidates);
    // eslint-disable-next-line no-console
    console.log("[GodotExecutor][Inspection][get_node_properties][DIAG] parsed_json_candidate_top_level_keys", parsedCandidateTopLevelKeys);

    const properties = this._extractPropertiesMapFromGetNodePropertiesPayload(res?.output);
    if (GOPEAK_DISCOVERY_DEBUG) {
      // eslint-disable-next-line no-console
      console.log("[GodotExecutor][Inspection][get_node_properties][DEBUG] normalized_properties", {
        keys: isPlainObject(properties) ? Object.keys(properties) : [],
        normalized: properties,
      });
    } else {
      // eslint-disable-next-line no-console
      console.log("[GodotExecutor][Inspection][get_node_properties] normalized_result", {
        scene_path: scenePath,
        node_path: nodePath,
        properties_keys: isPlainObject(properties) ? Object.keys(properties) : [],
      });
    }
    return { ok: true, properties, tool_result: res };
  }

  _buildRootNodeContext({ scenePath, listedNodes } = {}) {
    const nodes = Array.isArray(listedNodes) ? listedNodes : [];
    const sceneBundle = resolveScenePathBundle({ projectRoot: this.projectRoot, scenePath: scenePath });
    const sceneRaw = sceneBundle.sceneAbs && fs.existsSync(sceneBundle.sceneAbs) ? fs.readFileSync(sceneBundle.sceneAbs, "utf-8") : "";
    const root = parseSceneRootNodeFromTscn(sceneRaw);
    const rootName = safeString(root?.name).trim();
    const rootNode =
      nodes.find((n) => safeString(n?.node_name).trim() === rootName) ??
      nodes.find((n) => safeString(n?.node_path).trim() === ".") ??
      nodes[0] ??
      null;
    return {
      scene_bundle: sceneBundle,
      root_node_name: rootName || null,
      root_node_path: safeString(rootNode?.node_path).trim() || ".",
    };
  }

  _isSceneRootIntent({ target, nodePath, nodeName } = {}) {
    const values = [target, nodePath, nodeName]
      .map((v) => safeString(v).trim().toLowerCase())
      .filter(Boolean);
    return values.some((v) => v === "scene_root" || v === "scene root" || v === "root node" || v === "root" || v === ".");
  }

  _resolveNodeTargetFromList({
    operation,
    requestedTarget,
    requestedNodePath,
    requestedNodeName,
    listedNodes,
    rootNodePath,
    scenePath,
  } = {}) {
    const op = safeString(operation).trim() || "node_target_resolution";
    const nodes = Array.isArray(listedNodes) ? listedNodes : [];
    const nodePathInput = safeString(requestedNodePath).trim();
    const nodeNameInput = safeString(requestedNodeName).trim();
    const targetInput = safeString(requestedTarget).trim();
    const sceneRootIntent = this._isSceneRootIntent({
      target: targetInput,
      nodePath: nodePathInput,
      nodeName: nodeNameInput,
    });

    const candidates = nodes
      .map((n) => ({
        node_path: safeString(n?.node_path).trim(),
        node_name: safeString(n?.node_name).trim(),
        node_type: safeString(n?.node_type).trim(),
      }))
      .filter((n) => n.node_path || n.node_name);

    if (GOPEAK_DISCOVERY_DEBUG) {
      // eslint-disable-next-line no-console
      console.log("[GodotExecutor][TargetResolution][DEBUG] candidates", {
        operation: op,
        scene_path: scenePath,
        requested_target: { target: targetInput || null, node_path: nodePathInput || null, node_name: nodeNameInput || null },
        candidates: candidates.map((n) => ({ node_path: n.node_path, node_name: n.node_name })),
      });
    }

    if (sceneRootIntent) {
      return {
        ok: true,
        resolved_node_path: rootNodePath,
        reason: "scene_root_intent",
      };
    }

    // 1) exact node path match
    if (nodePathInput) {
      const exactPath = candidates.find((n) => n.node_path === nodePathInput);
      if (exactPath) {
        return { ok: true, resolved_node_path: exactPath.node_path, reason: "exact_node_path_match" };
      }
    }

    // 2) exact node name match
    const exactNameNeedle = nodeNameInput || targetInput;
    if (exactNameNeedle) {
      const exactNameMatches = candidates.filter((n) => n.node_name === exactNameNeedle);
      if (exactNameMatches.length === 1) {
        return { ok: true, resolved_node_path: exactNameMatches[0].node_path, reason: "exact_node_name_match" };
      }
      if (exactNameMatches.length > 1) {
        return {
          ok: false,
          error: `${op}: target "${exactNameNeedle}" is ambiguous (multiple exact node names matched).`,
          reason: "ambiguous_exact_node_name",
          matches: exactNameMatches.map((n) => n.node_path),
        };
      }
    }

    // 3) case-insensitive node name match
    if (exactNameNeedle) {
      const lc = exactNameNeedle.toLowerCase();
      const ciMatches = candidates.filter((n) => n.node_name.toLowerCase() === lc);
      if (ciMatches.length === 1) {
        return { ok: true, resolved_node_path: ciMatches[0].node_path, reason: "case_insensitive_node_name_match" };
      }
      if (ciMatches.length > 1) {
        return {
          ok: false,
          error: `${op}: target "${exactNameNeedle}" is ambiguous (multiple case-insensitive node names matched).`,
          reason: "ambiguous_case_insensitive_node_name",
          matches: ciMatches.map((n) => n.node_path),
        };
      }
    }

    // 4) unique suffix/path-segment match
    const suffixNeedle = (nodePathInput || nodeNameInput || targetInput).replace(/^\/+|\/+$/g, "");
    if (suffixNeedle) {
      const suffixMatches = candidates.filter((n) => {
        const p = n.node_path.replace(/^\/+|\/+$/g, "");
        if (!p) return false;
        if (p === suffixNeedle) return true;
        if (p.endsWith(`/${suffixNeedle}`)) return true;
        const segs = p.split("/").filter(Boolean);
        return segs.includes(suffixNeedle);
      });
      if (suffixMatches.length === 1) {
        return { ok: true, resolved_node_path: suffixMatches[0].node_path, reason: "unique_suffix_or_segment_match" };
      }
      if (suffixMatches.length > 1) {
        return {
          ok: false,
          error: `${op}: target "${suffixNeedle}" is ambiguous (multiple suffix/segment matches).`,
          reason: "ambiguous_suffix_match",
          matches: suffixMatches.map((n) => n.node_path),
        };
      }
    }

    return {
      ok: false,
      error: `${op}: target not found in listed scene nodes.`,
      reason: "target_not_found",
      requested: { target: targetInput || null, node_path: nodePathInput || null, node_name: nodeNameInput || null },
    };
  }

  async resolveSceneNodeMutationTargets({ operation, params, executionContext: executionContextOverride = null } = {}) {
    const op = safeString(operation).trim();
    const p = isPlainObject(params) ? { ...params } : {};
    const contextRequirements = getOperationContextRequirements(op);
    const needsEditorBridge = contextRequirements.includes("editor_bridge_context_required");
    const needsConnectedProjectPath = contextRequirements.includes("connected_project_path_context_required");
    const executionContext = isPlainObject(executionContextOverride)
      ? executionContextOverride
      : {
          projectRoot: this.projectRoot,
          project_root: this.projectRoot,
          connectedProjectPath: null,
          connected_project_path: null,
          projectPath: null,
          isBridgeReady: null,
          debug: GOPEAK_DISCOVERY_DEBUG,
        };

    if ((needsEditorBridge || needsConnectedProjectPath) && !executionContextOverride) {
      const bridgeStatus = await this.getBridgeStatus({ expectedProjectRoot: this.projectRoot });
      const isReady = Boolean(bridgeStatus?.output?.isBridgeReady) === true;
      const projectMatches = Boolean(bridgeStatus?.output?.projectMatches) === true;
      executionContext.isBridgeReady = isReady;
      executionContext.connectedProjectPath = bridgeStatus?.output?.connectedProjectPath ?? null;
      executionContext.connected_project_path = executionContext.connectedProjectPath;
      executionContext.projectPath = executionContext.connectedProjectPath;
      if (needsEditorBridge && (!isReady || !projectMatches)) {
        throw new Error(
          `editor_bridge_context_required failed: isBridgeReady=${String(isReady)} projectMatches=${String(projectMatches)}.`
        );
      }
      if (needsConnectedProjectPath && !executionContext.projectPath) {
        throw new Error("connected_project_path_context_required failed: missing connectedProjectPath.");
      }
    }

    if (op === "set_node_properties") {
      const scenePath = p.scene_path ?? p.scenePath ?? null;
      if (!scenePath) throw new Error("set_node_properties target resolution missing scene_path.");

      const listRes = await this._listSceneNodesForInspection({ scenePath, executionContext });
      if (!listRes.ok) throw new Error(listRes.error ?? "list_scene_nodes failed.");
      const rootCtx = this._buildRootNodeContext({ scenePath, listedNodes: listRes.nodes });
      const resolvedTarget = this._resolveNodeTargetFromList({
        operation: op,
        requestedTarget: p.target_intent ?? p.target ?? null,
        requestedNodePath: p.node_path ?? null,
        requestedNodeName: p.node_name ?? null,
        listedNodes: listRes.nodes,
        rootNodePath: rootCtx.root_node_path,
        scenePath,
      });
      if (!resolvedTarget?.ok || !resolvedTarget?.resolved_node_path) {
        throw new Error(resolvedTarget?.error ?? "set_node_properties failed to resolve node target path.");
      }
      const resolvedNodePath = resolvedTarget.resolved_node_path;

      if (GOPEAK_DISCOVERY_DEBUG) {
        // eslint-disable-next-line no-console
        console.log("[GodotExecutor][TargetResolution][DEBUG] resolved target", {
          operation: op,
          scene_path: scenePath,
          requested_target: { target: p.target_intent ?? p.target ?? null, node_path: p.node_path ?? null, node_name: p.node_name ?? null },
          resolved_node_path: resolvedNodePath,
          resolution_reason: resolvedTarget.reason ?? null,
        });
      }

      // Cache resolved target for subsequent execution calls.
      this._resolvedSceneNodeTargetCache = this._resolvedSceneNodeTargetCache ?? new Map();
      this._resolvedSceneNodeTargetCache.set(`${op}:${scenePath}:${resolvedNodePath}`, { node_path: resolvedNodePath });

      return { ok: true, params: { ...p, node_path: resolvedNodePath } };
    }

    if (op === "get_node_properties") {
      // Read-only property inspection must never guess node targets.
      // We resolve the requested node_path via list_scene_nodes first.
      const scenePath = p.scene_path ?? p.scenePath ?? null;
      if (!scenePath) throw new Error("get_node_properties target resolution missing scene_path.");

      const listRes = await this._listSceneNodesForInspection({ scenePath, executionContext });
      if (!listRes.ok) throw new Error(listRes.error ?? "list_scene_nodes failed.");
      const rootCtx = this._buildRootNodeContext({ scenePath, listedNodes: listRes.nodes });
      const resolvedTarget = this._resolveNodeTargetFromList({
        operation: op,
        requestedTarget: p.target_intent ?? p.target ?? null,
        requestedNodePath: p.node_path ?? null,
        requestedNodeName: p.node_name ?? null,
        listedNodes: listRes.nodes,
        rootNodePath: rootCtx.root_node_path,
        scenePath,
      });
      if (!resolvedTarget?.ok || !resolvedTarget?.resolved_node_path) {
        throw new Error(resolvedTarget?.error ?? "get_node_properties failed to resolve node target path.");
      }
      const resolvedNodePath = resolvedTarget.resolved_node_path;

      if (GOPEAK_DISCOVERY_DEBUG) {
        // eslint-disable-next-line no-console
        console.log("[GodotExecutor][TargetResolution][DEBUG] resolved target", {
          operation: op,
          scene_path: scenePath,
          requested_target: { target: p.target_intent ?? p.target ?? null, node_path: p.node_path ?? null, node_name: p.node_name ?? null },
          resolved_node_path: resolvedNodePath,
          resolution_reason: resolvedTarget.reason ?? null,
        });
      }

      this._resolvedSceneNodeTargetCache = this._resolvedSceneNodeTargetCache ?? new Map();
      this._resolvedSceneNodeTargetCache.set(`${op}:${scenePath}:${resolvedNodePath}`, { node_path: resolvedNodePath });

      return { ok: true, params: { ...p, node_path: resolvedNodePath } };
    }

    if (op === "add_node") {
      const scenePath = p.scene_path ?? p.scenePath ?? null;
      if (!scenePath) throw new Error("add_node target resolution missing scene_path.");

      const listRes = await this._listSceneNodesForInspection({ scenePath, executionContext });
      if (!listRes.ok) throw new Error(listRes.error ?? "list_scene_nodes failed.");
      const rootCtx = this._buildRootNodeContext({ scenePath, listedNodes: listRes.nodes });
      const resolvedParent = this._resolveNodeTargetFromList({
        operation: "add_node",
        requestedTarget: p.target_intent ?? p.target ?? null,
        requestedNodePath: p.parent_path ?? ".",
        requestedNodeName: p.parent_name ?? null,
        listedNodes: listRes.nodes,
        rootNodePath: rootCtx.root_node_path,
        scenePath,
      });
      if (!resolvedParent?.ok || !resolvedParent?.resolved_node_path) {
        throw new Error(resolvedParent?.error ?? "add_node: parent target resolution failed.");
      }

      if (GOPEAK_DISCOVERY_DEBUG) {
        // eslint-disable-next-line no-console
        console.log("[GodotExecutor][TargetResolution][DEBUG] resolved parent target", {
          operation: op,
          scene_path: scenePath,
          requested_parent: p.parent_path ?? null,
          resolved_parent_path: resolvedParent.resolved_node_path,
          resolution_reason: resolvedParent.reason ?? null,
        });
      }
      // eslint-disable-next-line no-console
      console.log("[GodotExecutor][TargetResolution] add_node parent resolved", {
        requested_parent_target: p.target_intent ?? p.target ?? p.parent_name ?? p.parent_path ?? null,
        resolved_parent_path: resolvedParent.resolved_node_path,
      });

      return { ok: true, params: { ...p, parent_path: resolvedParent.resolved_node_path } };
    }

    // For other operations, no target resolution hook is implemented.
    return { ok: true, params: p };
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

    // -------------------------------------------------------------
    // ExecutionContext injection (session-derived, not planner params)
    // -------------------------------------------------------------
    const contextRequirements = getOperationContextRequirements(operation);
    const needsEditorBridge = contextRequirements.includes("editor_bridge_context_required");
    const needsConnectedProjectPath = contextRequirements.includes("connected_project_path_context_required");
    const executionContext = {
      // Provide both camel + snake variants so builders/tools can be explicit.
      projectRoot: this.projectRoot,
      project_root: this.projectRoot,
      connectedProjectPath: null,
      connected_project_path: null,
      projectPath: null, // raw MCP tool contract key for many GoPeak tools
      isBridgeReady: null,
      debug: GOPEAK_DISCOVERY_DEBUG,
    };

    if (needsEditorBridge || needsConnectedProjectPath) {
      const bridgeStatus = await this.getBridgeStatus({ expectedProjectRoot: this.projectRoot });
      const isReady = Boolean(bridgeStatus?.output?.isBridgeReady) === true;
      const projectMatches = Boolean(bridgeStatus?.output?.projectMatches) === true;

      executionContext.isBridgeReady = isReady;
      executionContext.connectedProjectPath = bridgeStatus?.output?.connectedProjectPath ?? null;
      executionContext.connected_project_path = executionContext.connectedProjectPath;
      executionContext.projectPath = executionContext.connectedProjectPath;

      // Ensure prerequisites happen before any builder translation.
      if (needsEditorBridge && (!isReady || !projectMatches)) {
        return this._canonicalResult({
          ok: false,
          operation,
          backend: "mcp",
          primaryPathAttempted: "context_injection_bridge_ready",
          primaryPathSucceeded: false,
          inputs: params,
          output: {
            context_requirements: contextRequirements,
            bridge_status: bridgeStatus?.output ?? null,
          },
          error: `Missing required injected context: editor_bridge_context_required (bridgeReady=${String(isReady)}, projectMatches=${String(projectMatches)}).`,
        });
      }

      if (needsConnectedProjectPath && !executionContext.projectPath) {
        return this._canonicalResult({
          ok: false,
          operation,
          backend: "mcp",
          primaryPathAttempted: "context_injection_connected_project_path",
          primaryPathSucceeded: false,
          inputs: params,
          output: {
            context_requirements: contextRequirements,
            bridge_status: bridgeStatus?.output ?? null,
          },
          error: "Missing required injected context: connected_project_path_context_required (projectPath for GoPeak tool arguments).",
        });
      }
    }

    // IMPORTANT: Do not use one object literal with a property per operation.
    // In JavaScript, *all* property values are evaluated when the object is created,
    // so create_scene would still run buildAddNodeArgs(params) and fail with
    // "Missing required parameter: node_name" because create_scene params lack node_name.
    let canonicalParams = params;
    if (operation === "add_node" || operation === "set_node_properties") {
      try {
        const resolved = await this.resolveSceneNodeMutationTargets({
          operation,
          params: canonicalParams,
          executionContext,
        });
        if (resolved?.ok !== true || !resolved.params) {
          return this._canonicalResult({
            ok: false,
            operation,
            backend: "mcp",
            primaryPathAttempted: "inspect_first_target_resolution",
            primaryPathSucceeded: false,
            inputs: canonicalParams,
            output: { resolved },
            error: resolved?.error ?? "inspect-first target resolution failed.",
          });
        }
        canonicalParams = resolved.params;
      } catch (err) {
        const msg = safeString(err?.message ?? err);
        return this._canonicalResult({
          ok: false,
          operation,
          backend: "mcp",
          primaryPathAttempted: "inspect_first_target_resolution",
          primaryPathSucceeded: false,
          inputs: canonicalParams,
          output: {},
          error: msg,
        });
      }
    }

    // Inspect-first mandatory for node mutations:
    // - list_scene_nodes resolves node targets deterministically
    // - get_node_properties validates property-level intent (when applicable)
    let preNodeProperties = null;
    let expectedPropertyKeys = null;
    let saveSceneResult = null;
    if (operation === "set_node_properties") {
      expectedPropertyKeys = isPlainObject(canonicalParams?.properties) ? Object.keys(canonicalParams.properties) : [];
      if (expectedPropertyKeys.length > 0) {
        const pre = await this._getNodePropertiesForInspection({
          scenePath: canonicalParams?.scene_path ?? canonicalParams?.scenePath,
          nodePath: canonicalParams?.node_path,
          executionContext,
        });
        if (pre?.ok === true && isPlainObject(pre.properties)) {
          preNodeProperties = pre.properties;
        }
      }
    }

    let translated = {};
    if (operation === "analyze_project") {
      translated = { project_root: this.projectRoot };
    } else if (operation === "create_scene") {
      translated = buildCreateSceneArgs(canonicalParams, executionContext);
    } else if (operation === "add_node") {
      translated = buildAddNodeArgs(canonicalParams, executionContext);
    } else if (operation === "set_node_properties") {
      translated = buildSetNodePropertiesArgs(canonicalParams, executionContext);
    } else if (operation === "save_scene") {
      translated = buildSaveSceneArgs(canonicalParams, executionContext);
    }
    const requestPayload = {
      name: resolved.tool_name,
      arguments: translated,
    };
    const logArgs = {
      operation,
      primary_path: "mcp_tool",
      canonical_params: {
        ...(operation === "create_scene"
          ? {
              scene_path: params?.scene_path ?? null,
              root_node_name: params?.root_node_name ?? null,
              root_node_type: params?.root_node_type ?? null,
            }
          : {}),
      },
      resolved_tool: resolved.tool_name,
      execution_context_injected: {
        project_root: executionContext.project_root,
        connected_project_path: executionContext.connectedProjectPath,
        projectPath: executionContext.projectPath,
        isBridgeReady: executionContext.isBridgeReady,
        context_requirements: contextRequirements,
      },
      builder_output_keys: isPlainObject(translated) ? Object.keys(translated) : [],
      ...(operation === "create_scene"
        ? {
            create_scene_has_projectPath: Object.prototype.hasOwnProperty.call(translated ?? {}, "projectPath"),
            create_scene_has_scenePath: Object.prototype.hasOwnProperty.call(translated ?? {}, "scenePath"),
            create_scene_has_rootNodeType: Object.prototype.hasOwnProperty.call(translated ?? {}, "rootNodeType"),
          }
        : {}),
    };

    if (GOPEAK_DISCOVERY_DEBUG) {
      // eslint-disable-next-line no-console
      console.log("[GodotExecutor] canonical operation execution (debug)", {
        ...logArgs,
        builder_output_before_mcp_call: translated,
        translated_raw_mcp_args: translated,
        final_request_payload: requestPayload,
      });
    } else {
      // eslint-disable-next-line no-console
      console.log("[GodotExecutor] canonical operation execution", logArgs);
    }
    if (operation === "add_node") {
      // eslint-disable-next-line no-console
      console.log("[GodotExecutor] add_node final raw MCP payload", {
        requested_parent_target:
          params?.target_intent ?? params?.target ?? params?.parent_name ?? params?.parent_path ?? null,
        resolved_parent_path: canonicalParams?.parent_path ?? null,
        raw_payload: translated,
      });
    }
    const res = await this._runMcpAction(operation, resolved.tool_name, translated);
    let finalOk = res?.ok === true;
    let semanticCheck = null;
    let semanticError = null;

    if (finalOk && operation === "set_node_properties") {
      // Verify-after-mutate contract requires persisted change evidence.
      // We explicitly save the scene after mutation and fail if save fails.
      const saveScenePath = canonicalParams?.scene_path ?? canonicalParams?.scenePath ?? null;
      if (!saveScenePath) {
        finalOk = false;
        semanticError = "set_node_properties semantic verification failed: missing scene_path for save_scene.";
      } else {
        saveSceneResult = await this._executeDirectMcpOperation({
          operation: "save_scene",
          params: { scene_path: saveScenePath },
        });
        if (!saveSceneResult?.ok) {
          finalOk = false;
          semanticError = `set_node_properties semantic verification failed: save_scene failed: ${saveSceneResult?.error ?? "unknown"}`;
        }
      }
    }

    if (finalOk && operation === "add_node") {
      // add_node is a mutation: for prototype reliability we require a persisted
      // edit evidence. We save before post-add verification (re-list).
      const saveScenePath = canonicalParams?.scene_path ?? canonicalParams?.scenePath ?? null;
      if (!saveScenePath) {
        finalOk = false;
        semanticError = "add_node semantic verification failed: missing scene_path for save_scene.";
      } else {
        saveSceneResult = await this._executeDirectMcpOperation({
          operation: "save_scene",
          params: { scene_path: saveScenePath },
        });
        if (!saveSceneResult?.ok) {
          finalOk = false;
          semanticError = `add_node semantic verification failed: save_scene failed: ${saveSceneResult?.error ?? "unknown"}`;
        }
      }
    }

    // Semantic verification: ensure the created scene root matches the requested
    // root node name/type (planner semantic intent), not just that MCP returned ok.
    if (finalOk && operation === "create_scene") {
      const expectedRootName = safeString(params?.root_node_name).trim();
      const expectedRootType = safeString(params?.root_node_type).trim();

      const { sceneResPath, sceneFsRel, sceneAbs } = resolveScenePathBundle({
        projectRoot: this.projectRoot,
        scenePath: params?.scene_path,
      });

      const sceneExists = Boolean(sceneAbs && fs.existsSync(sceneAbs));
      const sceneRaw = sceneExists ? fs.readFileSync(sceneAbs, "utf-8") : "";

      const rootNode = parseSceneRootNodeFromTscn(sceneRaw);
      const actualRootName = rootNode?.name ?? null;
      const actualRootType = rootNode?.type ?? null;

      // GoPeak's `create-scene` tool contract typically exposes root node TYPE
      // but may not expose a root node NAME field. We only enforce the name
      // expectation when the raw MCP argument payload includes a root-name key.
      const supportsRootName =
        Object.prototype.hasOwnProperty.call(translated ?? {}, "rootNodeName") ||
        Object.prototype.hasOwnProperty.call(translated ?? {}, "node_name") ||
        Object.prototype.hasOwnProperty.call(translated ?? {}, "nodeName");

      const matchesName = supportsRootName ? (expectedRootName ? actualRootName === expectedRootName : true) : true;
      const matchesType = expectedRootType ? actualRootType === expectedRootType : true;
      const matches = matchesName && matchesType;

      semanticCheck = {
        expectation: { root_node_name: expectedRootName, root_node_type: expectedRootType },
        actual: { root_node_name: actualRootName, root_node_type: actualRootType },
        supports_root_node_name: Boolean(supportsRootName),
        scene: { scene_res_path: sceneResPath, scene_fs_rel: sceneFsRel, exists: sceneExists },
        match: matches,
      };

      if (GOPEAK_DISCOVERY_DEBUG) {
        // eslint-disable-next-line no-console
        console.log("[GodotExecutor][Semantic] create_scene root verification", semanticCheck);
      }

      if (!matches) {
        finalOk = false;
        const rootMismatchDetails = {
          supports_root_node_name: Boolean(supportsRootName),
          expected: { root_node_name: expectedRootName, root_node_type: expectedRootType },
          actual: { root_node_name: actualRootName, root_node_type: actualRootType },
          mismatch_name: supportsRootName ? expectedRootName ? actualRootName !== expectedRootName : false : false,
          mismatch_type: expectedRootType ? actualRootType !== expectedRootType : false,
        };
        semanticError = `create_scene semantic verification failed: ${JSON.stringify(rootMismatchDetails)}.`;
      }
    }

    // Inspect-first semantic verification for set_node_properties:
    // - Re-read node properties via get_node_properties after mutation
    // - Fail the operation if requested property keys/values do not match
    if (finalOk && operation === "set_node_properties") {
      const expectedProps = isPlainObject(canonicalParams?.properties) ? canonicalParams.properties : {};
      const expectedKeys = Object.keys(expectedProps);
      const nodePath = canonicalParams?.node_path;
      const scenePath = canonicalParams?.scene_path ?? canonicalParams?.scenePath ?? null;

      if (!scenePath || !nodePath) {
        finalOk = false;
        semanticError = "set_node_properties semantic verification failed: missing resolved scene_path/node_path.";
      } else {
        const post = await this._getNodePropertiesForInspection({
          scenePath,
          nodePath,
          executionContext,
        });
        if (post?.ok === true && isPlainObject(post?.properties)) {
          const actualProps = post.properties;
          const actualLower = new Map(Object.keys(actualProps).map((k) => [String(k).toLowerCase(), k]));
          const perKey = expectedKeys.map((k) => {
            const actualKey = actualLower.get(String(k).toLowerCase()) ?? k;
            const actualVal = actualProps[actualKey];
            const expectedVal = expectedProps[k];
            const expectedPrimitive =
              typeof expectedVal === "string" || typeof expectedVal === "number" || typeof expectedVal === "boolean";
            let valueMatches = false;
            if (expectedPrimitive) {
              const actualPrimitive =
                typeof actualVal === "string" || typeof actualVal === "number" || typeof actualVal === "boolean";
              if (actualPrimitive) {
                valueMatches = String(actualVal) === String(expectedVal);
              } else if (isPlainObject(actualVal)) {
                // Common GoPeak responses sometimes wrap resource paths in an object.
                const candidates = [
                  actualVal.path,
                  actualVal.resource_path,
                  actualVal.resourcePath,
                  actualVal.value,
                  actualVal.script,
                ];
                valueMatches = candidates.some((c) => c != null && String(c) === String(expectedVal));
              }
            } else if (isPlainObject(expectedVal) || Array.isArray(expectedVal)) {
              try {
                valueMatches = JSON.stringify(actualVal) === JSON.stringify(expectedVal);
              } catch {
                valueMatches = false;
              }
            } else {
              // Last resort: string compare.
              valueMatches = String(actualVal) === String(expectedVal);
            }
            const keyMatches = Object.prototype.hasOwnProperty.call(actualProps, actualKey);
            const match = keyMatches && valueMatches;
            return { key: k, actual_key: actualKey, key_matches: keyMatches, value_matches: valueMatches, match };
          });
          const matches = perKey.every((x) => Boolean(x.match));
          semanticCheck = {
            target: { node_path: nodePath },
            expectation: { property_keys: expectedKeys },
            actual: { property_keys: Object.keys(actualProps) },
            pre_properties: preNodeProperties,
            post_properties: actualProps,
            per_key: perKey,
            match: matches,
          };
          if (GOPEAK_DISCOVERY_DEBUG) {
            // eslint-disable-next-line no-console
            console.log("[GodotExecutor][Semantic] set_node_properties post verification", semanticCheck);
          }
          if (!matches) {
            finalOk = false;
            semanticError = `set_node_properties semantic verification failed: property keys/values mismatch.`;
          }
        } else {
          finalOk = false;
          semanticError = "set_node_properties semantic verification failed: get_node_properties returned no properties map.";
        }
      }
    }

    // Inspect-first semantic verification for add_node:
    // - Re-read scene nodes via list_scene_nodes after mutation
    // - Fail if the expected node (name and optional type) does not exist
    if (finalOk && operation === "add_node") {
      const expectedName = safeString(canonicalParams?.node_name).trim();
      const expectedType = safeString(canonicalParams?.node_type).trim();
      const expectedParentPath = safeString(canonicalParams?.parent_path).trim() || ".";
      const scenePath = canonicalParams?.scene_path ?? canonicalParams?.scenePath ?? null;
      if (!scenePath || !expectedName) {
        finalOk = false;
        semanticError = "add_node semantic verification failed: missing scene_path/node_name.";
      } else {
        const listRes = await this._listSceneNodesForInspection({ scenePath, executionContext });
        if (listRes?.ok === true) {
          const matches = listRes.nodes.filter((n) => {
            const nameOk = n.node_name === expectedName;
            const typeOk = expectedType ? n.node_type === expectedType : true;
            const nodePath = safeString(n?.node_path).trim();
            const parentPath =
              nodePath === "."
                ? null
                : nodePath.includes("/")
                  ? nodePath.split("/").slice(0, -1).join("/") || "."
                  : ".";
            const parentOk = parentPath === expectedParentPath;
            return nameOk && typeOk && parentOk;
          });
          const match = matches.length > 0;
          semanticCheck = {
            expectation: {
              node_name: expectedName,
              node_type: expectedType || null,
              parent_path: expectedParentPath,
            },
            actual: { nodes_found: matches },
            match,
          };
          if (GOPEAK_DISCOVERY_DEBUG) {
            // eslint-disable-next-line no-console
            console.log("[GodotExecutor][Semantic] add_node post verification", semanticCheck);
          }
          if (!match) {
            finalOk = false;
            semanticError = "add_node semantic verification failed: expected node not found in list_scene_nodes output.";
          }
        } else {
          finalOk = false;
          semanticError = `add_node semantic verification failed: list_scene_nodes error: ${listRes?.error ?? "unknown"}`;
        }
      }
    }

    return this._canonicalResult({
      ok: finalOk,
      operation,
      backend: "mcp",
      primaryPathAttempted: "mcp_tool",
      primaryPathSucceeded: finalOk,
      expectedOutcomeVerified: finalOk,
      inputs: canonicalParams,
      output: {
        translated_payload: translated,
        mcp_result: res,
        save_scene_result: saveSceneResult,
        semantic_check: semanticCheck,
      },
      error: finalOk ? null : semanticError ?? res?.error ?? "MCP operation failed.",
    });
  }

  async _executeAttachScriptToSceneRoot(params) {
    // Inspect-first target resolution:
    // attach_script_to_scene_root may be asked to target an explicit node
    // by name. We must resolve node_path deterministically via
    // list_scene_nodes (not by assuming node_name==node_path).
    let resolvedForAttach = params;
    try {
      const resolved = await this.resolveSceneNodeMutationTargets({
        operation: "set_node_properties",
        params: {
          scene_path: params?.scene_path,
          node_path: params?.node_path ?? null,
          node_name: params?.node_name ?? null,
          target: params?.target ?? null,
          target_intent: params?.target_intent ?? null,
        },
      });
      if (resolved?.ok === true && resolved?.params?.node_path) {
        resolvedForAttach = { ...params, node_path: resolved.params.node_path };
      }
    } catch (err) {
      return this._canonicalResult({
        ok: false,
        operation: "attach_script_to_scene_root",
        backend: "mcp",
        primaryPathAttempted: "inspect_first_attach_script_target_resolution",
        primaryPathSucceeded: false,
        inputs: params,
        output: {},
        error: safeString(err?.message ?? err),
      });
    }

    const setPropPayload = buildAttachScriptSetPropertyParams(resolvedForAttach);
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
      if (operation === "list_scene_nodes") {
        const scenePath = normalizedParams?.scene_path ?? normalizedParams?.scenePath ?? null;
        const contextRequirements = getOperationContextRequirements(operation);
        const needsEditorBridge = contextRequirements.includes("editor_bridge_context_required");
        const needsConnectedProjectPath = contextRequirements.includes("connected_project_path_context_required");
        const executionContext = {
          projectRoot: this.projectRoot,
          project_root: this.projectRoot,
          connectedProjectPath: null,
          connected_project_path: null,
          projectPath: null,
          isBridgeReady: null,
          debug: GOPEAK_DISCOVERY_DEBUG,
        };

        if (needsEditorBridge || needsConnectedProjectPath) {
          const bridgeStatus = await this.getBridgeStatus({ expectedProjectRoot: this.projectRoot });
          const isReady = Boolean(bridgeStatus?.output?.isBridgeReady) === true;
          const projectMatches = Boolean(bridgeStatus?.output?.projectMatches) === true;
          executionContext.isBridgeReady = isReady;
          executionContext.connectedProjectPath = bridgeStatus?.output?.connectedProjectPath ?? null;
          executionContext.connected_project_path = executionContext.connectedProjectPath;
          executionContext.projectPath = executionContext.connectedProjectPath;

          if (needsEditorBridge && (!isReady || !projectMatches)) {
            return this._canonicalResult({
              ok: false,
              operation,
              backend: "mcp",
              primaryPathAttempted: "context_injection_bridge_ready",
              primaryPathSucceeded: false,
              inputs: normalizedParams,
              output: { context_requirements: contextRequirements, bridge_status: bridgeStatus?.output ?? null },
              error: `Missing required injected context: editor_bridge_context_required (bridgeReady=${String(isReady)}, projectMatches=${String(projectMatches)}).`,
            });
          }
          if (needsConnectedProjectPath && !executionContext.projectPath) {
            return this._canonicalResult({
              ok: false,
              operation,
              backend: "mcp",
              primaryPathAttempted: "context_injection_connected_project_path",
              primaryPathSucceeded: false,
              inputs: normalizedParams,
              output: { context_requirements: contextRequirements, bridge_status: bridgeStatus?.output ?? null },
              error: "Missing required injected context: connected_project_path_context_required.",
            });
          }
        }

        if (!scenePath) {
          return this._canonicalResult({
            ok: false,
            operation,
            backend: "mcp",
            primaryPathAttempted: "list_scene_nodes",
            primaryPathSucceeded: false,
            inputs: normalizedParams,
            output: {},
            error: "list_scene_nodes missing scene_path.",
          });
        }

        const res = await this._listSceneNodesForInspection({ scenePath, executionContext });
        if (!res?.ok) {
          return this._canonicalResult({
            ok: false,
            operation,
            backend: "mcp",
            primaryPathAttempted: "list_scene_nodes",
            primaryPathSucceeded: false,
            inputs: normalizedParams,
            output: { error: res?.error ?? "list_scene_nodes failed" },
            error: res?.error ?? "list_scene_nodes failed",
          });
        }

        return this._canonicalResult({
          ok: true,
          operation,
          backend: "mcp",
          primaryPathAttempted: "list_scene_nodes",
          primaryPathSucceeded: true,
          expectedOutcomeVerified: true,
          inputs: normalizedParams,
          output: { nodes: res.nodes ?? [], inspection: res.tool_result?.output ?? {} },
          error: null,
        });
      }

      if (operation === "get_node_properties") {
        const scenePath = normalizedParams?.scene_path ?? normalizedParams?.scenePath ?? null;
        const contextRequirements = getOperationContextRequirements(operation);
        const needsEditorBridge = contextRequirements.includes("editor_bridge_context_required");
        const needsConnectedProjectPath = contextRequirements.includes("connected_project_path_context_required");
        const executionContext = {
          projectRoot: this.projectRoot,
          project_root: this.projectRoot,
          connectedProjectPath: null,
          connected_project_path: null,
          projectPath: null,
          isBridgeReady: null,
          debug: GOPEAK_DISCOVERY_DEBUG,
        };

        if (needsEditorBridge || needsConnectedProjectPath) {
          const bridgeStatus = await this.getBridgeStatus({ expectedProjectRoot: this.projectRoot });
          const isReady = Boolean(bridgeStatus?.output?.isBridgeReady) === true;
          const projectMatches = Boolean(bridgeStatus?.output?.projectMatches) === true;
          executionContext.isBridgeReady = isReady;
          executionContext.connectedProjectPath = bridgeStatus?.output?.connectedProjectPath ?? null;
          executionContext.connected_project_path = executionContext.connectedProjectPath;
          executionContext.projectPath = executionContext.connectedProjectPath;

          if (needsEditorBridge && (!isReady || !projectMatches)) {
            return this._canonicalResult({
              ok: false,
              operation,
              backend: "mcp",
              primaryPathAttempted: "context_injection_bridge_ready",
              primaryPathSucceeded: false,
              inputs: normalizedParams,
              output: { context_requirements: contextRequirements, bridge_status: bridgeStatus?.output ?? null },
              error: `Missing required injected context: editor_bridge_context_required (bridgeReady=${String(isReady)}, projectMatches=${String(projectMatches)}).`,
            });
          }
          if (needsConnectedProjectPath && !executionContext.projectPath) {
            return this._canonicalResult({
              ok: false,
              operation,
              backend: "mcp",
              primaryPathAttempted: "context_injection_connected_project_path",
              primaryPathSucceeded: false,
              inputs: normalizedParams,
              output: { context_requirements: contextRequirements, bridge_status: bridgeStatus?.output ?? null },
              error: "Missing required injected context: connected_project_path_context_required.",
            });
          }
        }

        if (!scenePath) {
          return this._canonicalResult({
            ok: false,
            operation,
            backend: "mcp",
            primaryPathAttempted: "get_node_properties",
            primaryPathSucceeded: false,
            inputs: normalizedParams,
            output: {},
            error: "get_node_properties missing scene_path.",
          });
        }

        // Inspect-first contract:
        // always resolve target from list_scene_nodes, even when node_path is supplied,
        // so errors are deterministic (missing/ambiguous) and never guessed.
        const resolved = await this.resolveSceneNodeMutationTargets({
          operation: "get_node_properties",
          params: normalizedParams,
          executionContext,
        });
        if (!(resolved?.ok === true && isPlainObject(resolved?.params))) {
          return this._canonicalResult({
            ok: false,
            operation,
            backend: "mcp",
            primaryPathAttempted: "inspect_first_target_resolution",
            primaryPathSucceeded: false,
            inputs: normalizedParams,
            output: { resolved },
            error: resolved?.error ?? "Failed to resolve node target for get_node_properties.",
          });
        }
        const resolvedParams = resolved.params;

        const nodePath = resolvedParams?.node_path ?? null;
        const propsRes = await this._getNodePropertiesForInspection({ scenePath, nodePath, executionContext });
        if (!propsRes?.ok) {
          return this._canonicalResult({
            ok: false,
            operation,
            backend: "mcp",
            primaryPathAttempted: "get_node_properties",
            primaryPathSucceeded: false,
            inputs: resolvedParams,
            output: { error: propsRes?.error ?? "get_node_properties failed" },
            error: propsRes?.error ?? "get_node_properties failed",
          });
        }

        return this._canonicalResult({
          ok: true,
          operation,
          backend: "mcp",
          primaryPathAttempted: "get_node_properties",
          primaryPathSucceeded: true,
          expectedOutcomeVerified: true,
          inputs: resolvedParams,
          output: {
            properties: propsRes.properties ?? {},
            resolved_node_path: nodePath,
            // Keep read-only output human-usable while preserving traceability.
            target_resolution: {
              requested: {
                target: normalizedParams?.target ?? normalizedParams?.target_intent ?? null,
                node_path: normalizedParams?.node_path ?? null,
                node_name: normalizedParams?.node_name ?? null,
              },
              resolved_node_path: nodePath,
            },
            inspection: propsRes.tool_result?.output ?? {},
          },
          error: null,
        });
      }

      if (operation === "inspect_scene") {
        // Read-only composed inspection:
        // list_scene_nodes always runs first; get_node_properties runs only
        // if the caller provides a target (node_path/node_name/target intent).
        const listRes = await this.executeOperation({
          action: "list_scene_nodes",
          params: normalizedParams,
        });
        if (!listRes?.ok) return listRes;

        const candidateTarget =
          safeString(normalizedParams?.node_path).trim() ||
          safeString(normalizedParams?.node_name).trim() ||
          safeString(normalizedParams?.target).trim() ||
          safeString(normalizedParams?.target_intent).trim();

        if (!candidateTarget) {
          return this._canonicalResult({
            ok: true,
            operation,
            backend: "mcp",
            primaryPathAttempted: "inspect_scene:list_scene_nodes",
            primaryPathSucceeded: true,
            expectedOutcomeVerified: true,
            inputs: normalizedParams,
            output: { nodes: listRes?.output?.nodes ?? [], execution: listRes },
            error: null,
          });
        }

        const propsRes = await this.executeOperation({
          action: "get_node_properties",
          params: normalizedParams,
        });
        if (!propsRes?.ok) return propsRes;

        return this._canonicalResult({
          ok: true,
          operation,
          backend: "mcp",
          primaryPathAttempted: "inspect_scene:list_scene_nodes+get_node_properties",
          primaryPathSucceeded: true,
          expectedOutcomeVerified: true,
          inputs: normalizedParams,
          output: {
            nodes: listRes?.output?.nodes ?? [],
            properties: propsRes?.output?.properties ?? {},
            execution: { list: listRes, props: propsRes },
          },
          error: null,
        });
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
    if (GOPEAK_DISCOVERY_DEBUG) {
      // eslint-disable-next-line no-console
      console.log(`[GodotExecutor][MCP] resolve factory operation`, {
        requested_operation: operation,
        ok: resolved?.ok ?? false,
        mode: resolved?.mode ?? null,
        matched_tools: resolved?.matched_tools ?? [],
        reason: resolved?.reason ?? null,
      });
    }

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

    const discoveryDebug = GOPEAK_DISCOVERY_DEBUG;

    // eslint-disable-next-line no-console
    console.log(`[GodotExecutor][MCP] discovery get_supported_operations`, discoveryDebug ? {
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
    } : {
      discovered_tool_count: rawTools.length,
      enabled_operations: operations.filter((o) => o.enabled).map((o) => o.operation),
      disabled_operations_count: operations.filter((o) => !o.enabled).length,
      derivation: "suppressed (set DEBUG_GOPEAK_DISCOVERY=true to view full tool inventory)",
    });

    if (discoveryDebug) {
      const setNodePropsRawMatch = rawTools.find(
        (t) => normalizeToolKey(t?.name) === normalizeToolKey("set-node-properties")
      );
      const derivedSetNodeProps = operations.find((o) => o?.operation === "set_node_properties");
      // eslint-disable-next-line no-console
      console.log("[GodotExecutor][MCP] mapping check set_node_properties", {
        raw_tool_match: setNodePropsRawMatch?.name ?? null,
        derived_enabled: Boolean(derivedSetNodeProps?.enabled),
        derived_mode: derivedSetNodeProps?.mode ?? null,
      });
    }

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

      if (action === "create_scene" && GOPEAK_DISCOVERY_DEBUG) {
        // eslint-disable-next-line no-console
        console.log("[GodotExecutor][MCP] create_scene final tools/call.arguments", {
          argument_keys: isPlainObject(inputs) ? Object.keys(inputs) : [],
          arguments: prettyForLog(inputs),
        });
      }

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
      // Keep normal-mode logs concise; only print full request payload for
      // debugging (and keep it always for attach_script failures).
      const debugPayload = GOPEAK_DISCOVERY_DEBUG;
      if (debugPayload) {
        // eslint-disable-next-line no-console
        console.log(`[GodotExecutor][MCP] request payload`, prettyForLog(requestPayload));
      }

      const called = await this._sessionManager.callTool(String(method), inputs);
      const response = called?.raw ?? null;
      if (debugPayload) {
        // eslint-disable-next-line no-console
        console.log(`[GodotExecutor][MCP] raw response`, prettyForLog(response));
      }
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
        if (debugPayload) {
          // eslint-disable-next-line no-console
          console.log(`[GodotExecutor][MCP] normalized result`, prettyForLog(normalized));
        } else {
          // eslint-disable-next-line no-console
          console.log(`[GodotExecutor][MCP] result`, {
            action,
            method,
            ok: false,
            error: normalized.error ?? null,
          });
        }
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
      if (debugPayload) {
        // eslint-disable-next-line no-console
        console.log(`[GodotExecutor][MCP] normalized result`, prettyForLog(normalized));
      } else {
        // eslint-disable-next-line no-console
        console.log(`[GodotExecutor][MCP] result`, {
          action,
          method,
          ok: normalized.ok,
          error: normalized.error ?? null,
        });
      }
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

function parseJsonTextCandidatesDetailed(text) {
  const parsed = [];
  const errors = [];
  const raw = safeString(text).trim();
  if (!raw) return { parsed, errors };

  const tryPush = (s, source) => {
    const candidate = safeString(s).trim();
    if (!candidate) return;
    try {
      const value = JSON.parse(candidate);
      parsed.push(value);
    } catch (err) {
      errors.push({
        source,
        message: safeString(err?.message ?? err),
        preview: candidate.slice(0, 240),
      });
    }
  };

  // 1) raw string
  tryPush(raw, "raw_text");

  // 2) fenced JSON block
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) tryPush(fenced[1], "fenced_json_block");

  // 3) first object/array window in text
  const firstObjStart = raw.indexOf("{");
  const firstArrStart = raw.indexOf("[");
  const starts = [firstObjStart, firstArrStart].filter((x) => x >= 0).sort((a, b) => a - b);
  if (starts.length > 0) {
    const start = starts[0];
    const objEnd = raw.lastIndexOf("}");
    const arrEnd = raw.lastIndexOf("]");
    const end = Math.max(objEnd, arrEnd);
    if (end > start) {
      tryPush(raw.slice(start, end + 1), "object_or_array_window");
    }
  }

  return { parsed, errors };
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
    // Inspect-first rule:
    // Do NOT treat `node_name` as a node path.
    // Node path resolution must come from `list_scene_nodes`.
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

    if (GOPEAK_DISCOVERY_DEBUG) {
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
      if (GOPEAK_DISCOVERY_DEBUG) {
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
      if (GOPEAK_DISCOVERY_DEBUG) {
        const tools = extractToolEntries(toolsList);
        const names = Array.isArray(tools) ? tools.map((t) => t?.name).filter(Boolean) : [];
        // eslint-disable-next-line no-console
        console.log(`[GodotExecutor][MCP] tools/list names: ${names.join(", ")}`, {
          page_fetch_count: toolsList?.page_fetch_count ?? null,
        });
      }
    } catch (err) {
      if (GOPEAK_DISCOVERY_DEBUG) {
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

    if (GOPEAK_DISCOVERY_DEBUG) {
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

function parseSceneRootNodeFromTscn(sceneRaw) {
  const m = String(sceneRaw ?? "").match(/\[node\s+name="([^"]+)"\s+type="([^"]+)"/);
  if (!m) return null;
  return { name: m?.[1] ?? null, type: m?.[2] ?? null };
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

