/**
 * NodeResolver
 * -----------------------------------------------------------------------------
 * Resolves node refs from live scene inspection via MCP list-scene-nodes.
 *
 * File/resource resolution and node resolution are separate concerns:
 * - resource resolution picks scene file path
 * - node resolution maps refs to concrete node targets inside that scene
 */
import { describeClientAvailability, getSessionClient } from "./utils/session-client.js";

function safeString(v) {
  return v == null ? "" : String(v);
}

function normalize(v) {
  return safeString(v).trim();
}

function normalizeKey(v) {
  return safeString(v).toLowerCase().replace(/[^a-z0-9]/g, "");
}

function unique(arr) {
  return [...new Set(arr)];
}

function isPlainObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

export class NodeResolver {
  constructor({ sessionManager, inventory } = {}) {
    this._sessionManager = sessionManager ?? null;
    this._inventory = inventory ?? null;
  }

  async resolve({ toolName, argKey, value, scenePath }) {
    const scene = normalize(scenePath);
    const target = normalize(value);
    if (!scene || !target) return { status: "not_found", matches: [], reason: "missing_scene_or_target" };

    if (/^(scene_root|root node|root|\.)$/i.test(target)) {
      return { status: "resolved", value: ".", matches: [] };
    }

    const nodesRes = await this._listSceneNodes(scene);
    if (!nodesRes.ok) {
      return { status: "not_found", matches: [], reason: nodesRes.error ?? "list_scene_nodes_failed" };
    }

    const nodes = nodesRes.nodes;
    const byPath = nodes.find((n) => n.path === target);
    if (byPath) return { status: "resolved", value: byPath.path, matches: [] };

    const exactNames = nodes.filter((n) => n.name === target);
    if (exactNames.length === 1) return { status: "resolved", value: exactNames[0].path, matches: [] };
    if (exactNames.length > 1) return { status: "ambiguous", matches: unique(exactNames.map((n) => n.path)) };

    const lower = target.toLowerCase();
    const ciNames = nodes.filter((n) => n.name.toLowerCase() === lower);
    if (ciNames.length === 1) return { status: "resolved", value: ciNames[0].path, matches: [] };
    if (ciNames.length > 1) return { status: "ambiguous", matches: unique(ciNames.map((n) => n.path)) };

    const suffixMatches = nodes.filter((n) => n.path.toLowerCase().endsWith(lower) || n.path.split("/").some((seg) => seg.toLowerCase() === lower));
    if (suffixMatches.length === 1) return { status: "resolved", value: suffixMatches[0].path, matches: [] };
    if (suffixMatches.length > 1) return { status: "ambiguous", matches: unique(suffixMatches.map((n) => n.path)) };

    void toolName;
    void argKey;
    return { status: "not_found", matches: [], reason: "no_match" };
  }

  async _listSceneNodes(scenePath) {
    const client = getSessionClient(this._sessionManager);
    if (!client) {
      return {
        ok: false,
        error: `No active MCP client (${describeClientAvailability(this._sessionManager)}).`,
      };
    }

    const toolName = this._pickListSceneNodesToolName();
    if (!toolName) return { ok: false, error: "No list-scene-nodes tool in inventory." };

    const sessionStatus = this._sessionManager && typeof this._sessionManager.getStatus === "function"
      ? this._sessionManager.getStatus()
      : {};
    const activeProjectPath = normalize(
      sessionStatus?.connectedProjectPath ||
      sessionStatus?.desiredProjectRoot ||
      ""
    ) || null;
    const args = this._buildListArgs(scenePath, activeProjectPath);
    let raw = null;
    try {
      if (typeof client.callTool === "function") raw = await client.callTool(toolName, args);
      else if (typeof client.request === "function") {
        const res = await client.request({ method: "tools/call", params: { name: toolName, arguments: args } });
        raw = res?.result ?? res;
      } else {
        return { ok: false, error: "Client does not support callTool/request." };
      }
    } catch (err) {
      return { ok: false, error: safeString(err?.message ?? err) };
    }
    if (!this._isRawToolResultOk(raw)) {
      return { ok: false, error: this._extractToolError(raw) };
    }

    const nodes = this._extractNodes(raw);
    return { ok: true, nodes, raw };
  }

  _pickListSceneNodesToolName() {
    if (!this._inventory || typeof this._inventory.getInventory !== "function") return null;
    const inv = this._inventory.getInventory();
    const tools = Array.isArray(inv?.tools) ? inv.tools : [];
    const match = tools.find((t) => {
      const k = normalizeKey(t?.name);
      return k === normalizeKey("list-scene-nodes") || k === normalizeKey("list_scene_nodes");
    });
    return match?.name ?? null;
  }

  _buildListArgs(scenePath, projectPath = null) {
    const args = {
      scenePath,
      scene_path: scenePath,
      path: scenePath,
    };
    const pp = normalize(projectPath);
    if (pp) {
      args.projectPath = pp;
      args.project_path = pp;
      args.projectRoot = pp;
      args.project_root = pp;
    }
    return args;
  }

  _isRawToolResultOk(raw) {
    if (!isPlainObject(raw)) return true;
    if (raw.ok === false) return false;
    if (raw.isError === true) return false;
    if (raw.error != null) return false;
    return true;
  }

  _extractToolError(raw) {
    if (!isPlainObject(raw)) return safeString(raw) || "list_scene_nodes failed";
    const direct = normalize(raw.error ?? raw.message ?? "");
    if (direct) return direct;
    if (Array.isArray(raw.content)) {
      const text = raw.content.map((c) => normalize(c?.text)).filter(Boolean).join("\n");
      if (text) return text;
    }
    return "list_scene_nodes failed";
  }

  _extractNodes(raw) {
    const candidates = [];
    if (Array.isArray(raw?.content)) {
      for (const block of raw.content) {
        const text = safeString(block?.text).trim();
        if (!text) continue;
        try {
          candidates.push(JSON.parse(text));
        } catch {
          // Ignore non-JSON text blocks.
        }
      }
    }
    if (raw && typeof raw === "object") candidates.push(raw);

    const out = [];
    const seen = new Set();
    const pushNode = (obj) => {
      const name = normalize(obj?.name ?? obj?.node_name);
      const path = normalize(obj?.path ?? obj?.node_path);
      const type = normalize(obj?.type ?? obj?.node_type);
      if (!path || seen.has(path)) return;
      seen.add(path);
      out.push({ name: name || path.split("/").pop() || "", path, type: type || null });
    };
    const walkArray = (arr) => {
      for (const item of arr) {
        if (!item || typeof item !== "object") continue;
        pushNode(item);
      }
    };
    const walkTree = (node) => {
      if (!isPlainObject(node)) return;
      pushNode(node);
      if (Array.isArray(node.children)) {
        for (const child of node.children) {
          walkTree(child);
        }
      }
    };

    for (const c of candidates) {
      if (Array.isArray(c?.nodes)) walkArray(c.nodes);
      if (Array.isArray(c?.scene_nodes)) walkArray(c.scene_nodes);
      if (Array.isArray(c?.items)) walkArray(c.items);
      if (Array.isArray(c)) walkArray(c);
      if (isPlainObject(c?.tree)) walkTree(c.tree);
      if (isPlainObject(c) && Array.isArray(c.children)) walkTree(c);
    }

    return out;
  }
}
