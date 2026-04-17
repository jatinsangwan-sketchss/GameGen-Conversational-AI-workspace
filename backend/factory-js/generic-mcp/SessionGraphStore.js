/**
 * SessionGraphStore
 * -----------------------------------------------------------------------------
 * Session JSON-backed path graph used by the thin MCP client.
 *
 * Inputs:
 * - `<projectRoot>/session.json` (preferred)
 * - `<projectRoot>/session.imported.json` (fallback)
 *
 * Outputs:
 * - canonical scene path resolution
 * - canonical node path resolution (including root aliases)
 *
 * This replaces legacy file-index and node-resolver heuristics.
 */

import fs from "node:fs/promises";
import path from "node:path";

function safeString(value) {
  return value == null ? "" : String(value);
}

function isPlainObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function normalizeRelPath(input) {
  const raw = safeString(input).trim();
  if (!raw) return "";
  return raw
    .replace(/^res:\/\//i, "")
    .replace(/^\/+/, "")
    .replace(/\\/g, "/");
}

function lower(value) {
  return safeString(value).trim().toLowerCase();
}

function stripExt(file) {
  return safeString(file).replace(/\.[a-z0-9_]+$/i, "");
}

function pushMapList(map, key, value) {
  const k = lower(key);
  if (!k) return;
  const current = map.get(k) || [];
  current.push(value);
  map.set(k, current);
}

export class SessionGraphStore {
  constructor({ debug = false } = {}) {
    this._debug = Boolean(debug) || safeString(process.env.DEBUG_GENERIC_MCP_VERIFY).trim().toLowerCase() === "true";
    this._projectRoot = null;
    this._sessionPath = null;
    this._loaded = false;
    this._scenes = [];
    this._byScenePath = new Map();
    this._bySceneName = new Map();
    this._bySceneStem = new Map();
  }

  getStatus() {
    return {
      loaded: this._loaded,
      projectRoot: this._projectRoot,
      sessionPath: this._sessionPath,
      sceneCount: this._scenes.length,
    };
  }

  async load(projectRoot = null) {
    const root = safeString(projectRoot).trim();
    if (!root) {
      this._reset();
      return { ok: false, reason: "project_root_missing" };
    }
    if (this._loaded && this._projectRoot === root) {
      return { ok: true, cached: true, ...this.getStatus() };
    }
    const candidates = [
      path.resolve(root, "session.json"),
      path.resolve(root, "session.imported.json"),
    ];
    let chosen = null;
    for (const candidate of candidates) {
      try {
        const st = await fs.stat(candidate);
        if (st.isFile()) {
          chosen = candidate;
          break;
        }
      } catch {
        // ignore missing candidate
      }
    }
    this._projectRoot = root;
    this._sessionPath = chosen;
    if (!chosen) {
      this._loaded = false;
      this._scenes = [];
      this._byScenePath.clear();
      this._bySceneName.clear();
      this._bySceneStem.clear();
      return { ok: false, reason: "session_json_not_found", ...this.getStatus() };
    }

    try {
      const raw = await fs.readFile(chosen, "utf8");
      const parsed = JSON.parse(raw);
      this._buildIndexes(parsed);
      this._loaded = true;
      if (this._debug) {
        console.log("[generic-mcp][session-graph] loaded", this.getStatus());
      }
      return { ok: true, ...this.getStatus() };
    } catch (err) {
      this._loaded = false;
      this._scenes = [];
      this._byScenePath.clear();
      this._bySceneName.clear();
      this._bySceneStem.clear();
      return { ok: false, reason: safeString(err?.message ?? err) || "session_json_load_failed", ...this.getStatus() };
    }
  }

  _reset() {
    this._projectRoot = null;
    this._sessionPath = null;
    this._loaded = false;
    this._scenes = [];
    this._byScenePath.clear();
    this._bySceneName.clear();
    this._bySceneStem.clear();
  }

  _buildIndexes(json) {
    const scenes = Array.isArray(json?.gameBuild?.blueprint?.scenes) ? json.gameBuild.blueprint.scenes : [];
    const normalizedScenes = [];
    this._byScenePath.clear();
    this._bySceneName.clear();
    this._bySceneStem.clear();
    for (const scene of scenes) {
      if (!isPlainObject(scene)) continue;
      const relPath = normalizeRelPath(scene.path);
      const name = safeString(scene.name).trim();
      const stem = stripExt(path.basename(relPath || name));
      const nodesRaw = Array.isArray(scene.nodes) ? scene.nodes : [];
      const nodes = nodesRaw
        .filter((n) => isPlainObject(n))
        .map((n) => ({
          name: safeString(n.name).trim(),
          type: safeString(n.type).trim() || null,
          nodePath: safeString(n.nodePath).trim(),
          parentPath: safeString(n.parentPath).trim() || null,
        }))
        .filter((n) => n.nodePath);
      const rootNode = nodes.find((n) => n.nodePath === ".") || null;
      const item = {
        path: relPath,
        name,
        stem,
        rootName: safeString(rootNode?.name).trim() || null,
        nodes,
      };
      normalizedScenes.push(item);
      if (relPath) this._byScenePath.set(lower(relPath), item);
      if (name) pushMapList(this._bySceneName, name, item);
      if (stem) pushMapList(this._bySceneStem, stem, item);
    }
    this._scenes = normalizedScenes;
  }

  resolveSceneRef(input = "") {
    const token = normalizeRelPath(input);
    if (!token || !this._loaded) return null;
    const exact = this._byScenePath.get(lower(token));
    if (exact?.path) return exact.path;

    const stem = stripExt(path.basename(token));
    const byName = this._bySceneName.get(lower(stem)) || [];
    if (byName.length === 1) return byName[0].path || null;
    const byStem = this._bySceneStem.get(lower(stem)) || [];
    if (byStem.length === 1) return byStem[0].path || null;

    const suffixMatches = this._scenes.filter((s) => lower(s.path).endsWith(`/${lower(token)}`) || lower(s.path) === lower(token));
    if (suffixMatches.length === 1) return suffixMatches[0].path || null;
    return null;
  }

  resolveNodeRef({ sceneRef = "", nodeRef = "" } = {}) {
    if (!this._loaded) return null;
    const resolvedScene = this.resolveSceneRef(sceneRef) || normalizeRelPath(sceneRef);
    const scene = this._byScenePath.get(lower(resolvedScene));
    if (!scene) return null;
    const token = safeString(nodeRef).trim().replace(/^["'`]+|["'`]+$/g, "");
    if (!token) return null;
    if (token === ".") return ".";
    const lowerToken = lower(token.replace(/^node\s+/i, ""));
    if (!lowerToken) return null;
    if (lowerToken === "root" || lowerToken === "root node" || lowerToken === "scene root" || lowerToken === "scene_root") return ".";
    if (scene.rootName && lower(scene.rootName) === lowerToken) return ".";

    const exactPath = scene.nodes.find((n) => lower(n.nodePath) === lowerToken);
    if (exactPath) return exactPath.nodePath;
    const exactName = scene.nodes.filter((n) => lower(n.name) === lowerToken);
    if (exactName.length === 1) return exactName[0].nodePath;
    if (exactName.length > 1) return null;

    const suffix = scene.nodes.filter((n) => lower(n.nodePath).endsWith(`/${lowerToken}`));
    if (suffix.length === 1) return suffix[0].nodePath;
    return null;
  }
}
