/**
 * ProjectFileIndex
 * -----------------------------------------------------------------------------
 * Filesystem-backed index for project-relative resources.
 */
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";

const DEFAULT_EXTENSIONS = new Set([
  ".tscn",
  ".gd",
  ".tres",
  ".res",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".shader",
  ".gdshader",
]);

const IGNORED_DIRS = new Set([
  ".git",
  ".godot",
  ".import",
  "node_modules",
  "dist",
  "build",
  ".cache",
  "cache",
  "tmp",
  "temp",
]);

function normalizeRef(value) {
  const raw = String(value ?? "").trim();
  return raw.replace(/^res:\/\//i, "").replace(/^\/+/, "").replace(/\\/g, "/");
}

function toRelPosix(projectRoot, absPath) {
  return path.relative(projectRoot, absPath).split(path.sep).join("/");
}

function fileStem(filename) {
  const name = String(filename ?? "").trim();
  if (!name) return "";
  const idx = name.lastIndexOf(".");
  if (idx <= 0) return name;
  return name.slice(0, idx);
}

export class ProjectFileIndex {
  constructor({ extensions = null, debug = false } = {}) {
    this._extensions = extensions instanceof Set ? extensions : DEFAULT_EXTENSIONS;
    this._debug = Boolean(debug) || String(process.env.DEBUG_GENERIC_MCP_INDEX || "").toLowerCase() === "true";
    this._projectRoot = null;
    this._entries = [];
    this._byFilename = new Map();
    this._byRel = new Map();
    this._byLowerStem = new Map();
    this._instanceId = Math.random().toString(36).substring(2, 15);
  }

  async build(projectRoot) {
    console.log("[ProjectFileIndex] build intanceID", {instanceId:this._instanceId});
    this._projectRoot = path.resolve(String(projectRoot ?? "").trim() || ".");
    this._entries = [];
    this._byFilename.clear();
    this._byRel.clear();
    this._byLowerStem.clear();
    await this._walk(this._projectRoot);
    this._logDebugSummary("build");
    if (this._debug) {
      console.error(`[generic-mcp][index] build summary`, this.getDebugSummary({ tscnPreviewLimit: 50 }));
      console.error("[ProjectFileIndex][build]", {
        instanceId: this._instanceId,
        projectRoot: this._projectRoot,
        entriesLen: this._entries.length,
        byRelSize: this._byRel.size,
        byFilenameSize: this._byFilename.size,
      });
    }
    return this.getAll();
  }

  async refresh() {
    if (!this._projectRoot) return [];
    return this.build(this._projectRoot);
  }

  getAll() {
    return [...this._entries];
  }

  getProjectRoot() {
    return this._projectRoot;
  }

  getDebugSummary({ tscnPreviewLimit = 40 } = {}) {
    const all = this._entries;
    const tscn = all.filter((e) => e.extension === ".tscn").map((e) => e.relative_path);
    const gd = all.filter((e) => e.extension === ".gd").map((e) => e.relative_path);
    return {
      projectRoot: this._projectRoot,
      totalIndexedFiles: all.length,
      tscnCount: tscn.length,
      gdCount: gd.length,
      tscnPreview: tscn.slice(0, Math.max(0, Number(tscnPreviewLimit) || 0)),
    };
  }

  findByFilename(name) {
    // console.log( "[ProjectFileIndex] findByFilename input", name );
    const n = String(name ?? "").trim();
    if (this._debug) console.error("[ProjectFileIndex][findByFilename]", { instanceId: this._instanceId });
    if (!n) return [];
    const cached = [...(this._byFilename.get(n) ?? [])];
    if (cached.length > 0 || !this._projectRoot) return cached;

    // Stale-index repair: creations from previous turn may exist on disk before
    // current in-memory index has been updated.
    const discovered = this._scanByFilenameSync(n);
    for (const rel of discovered) {
      this._insertEntry(rel, path.extname(rel).toLowerCase());
    }
    // console.log( "[ProjectFileIndex] findByFilename output", [...(this._byFilename.get(n) ?? [])] );
    return [...(this._byFilename.get(n) ?? [])];
  }

  findByRelativePath(relPath) {
    // console.log( "[ProjectFileIndex] findByRelativePath input", relPath );
    if (this._debug) console.error("[ProjectFileIndex][findByRelativePath]", { instanceId: this._instanceId });
    const n = normalizeRef(relPath);
    if (!n) return [];
    // console.log( "[ProjectFileIndex] findByRelativePath output", [...(this._byRel.get(n) ?? [])] );
    return [...(this._byRel.get(n) ?? [])];
  }

  findBySuffix(suffix) {
    // console.log( "[ProjectFileIndex] findBySuffix input", suffix );
    if (this._debug) console.error("[ProjectFileIndex][findBySuffix]", { instanceId: this._instanceId });
    const n = normalizeRef(suffix).toLowerCase();
    if (!n) return [];
    // console.log( "[ProjectFileIndex] findBySuffix output", this._entries.filter((e) => e.lowercase_relative_path.endsWith(n)) );
    return this._entries.filter((e) => e.lowercase_relative_path.endsWith(n));
  }

  findByStem(stem) {
    // console.log("[ProjectFileIndex] findByStem and intanceID", {stem, instanceId: this._instanceId});

    if (this._debug) console.error("[ProjectFileIndex][findByStem]", { instanceId: this._instanceId });
    const s = String(stem ?? "").trim().toLowerCase();
    if (!s) return [];
    return [...(this._byLowerStem.get(s) ?? [])];
  }

  /**
   * Keep index fresh after successful create/save mutations so next-turn resolution
   * can find newly created files immediately without full rebuild/restart.
   */
  async addOrUpdateRelativePath(relPath) {
    if (!this._projectRoot) return { ok: false, reason: "index_not_built" };
    const n = normalizeRef(relPath);
    if (!n) return { ok: false, reason: "empty_path" };
    const abs = path.resolve(this._projectRoot, n);
    let stat;
    try {
      stat = await fs.stat(abs);
    } catch {
      return { ok: false, reason: "not_on_disk" };
    }
    if (!stat.isFile()) return { ok: false, reason: "not_file" };
    const ext = path.extname(n).toLowerCase();
    if (!this._extensions.has(ext)) return { ok: false, reason: "unsupported_extension" };
    const entry = {
      relative_path: n,
      filename: path.basename(n),
      stem: fileStem(path.basename(n)),
      extension: ext,
      lowercase_filename: path.basename(n).toLowerCase(),
      lowercase_stem: fileStem(path.basename(n)).toLowerCase(),
      lowercase_relative_path: n.toLowerCase(),
    };
    this._insertEntry(entry.relative_path, entry.extension);
    if (this._debug) {
      console.error("[generic-mcp][index] upsert", {
        projectRoot: this._projectRoot,
        path: entry.relative_path,
      });
    }
    return { ok: true, entry };
  }

  _insertEntry(relativePath, ext) {
    const rel = normalizeRef(relativePath);
    if (this._debug) console.error("[ProjectFileIndex][_insertEntry]", { instanceId: this._instanceId });
    if (!rel) return;
    const extension = String(ext || path.extname(rel).toLowerCase() || "").toLowerCase();
    if (!this._extensions.has(extension)) return;
    const entry = {
      relative_path: rel,
      filename: path.basename(rel),
      stem: fileStem(path.basename(rel)),
      extension,
      lowercase_filename: path.basename(rel).toLowerCase(),
      lowercase_stem: fileStem(path.basename(rel)).toLowerCase(),
      lowercase_relative_path: rel.toLowerCase(),
    };
    this._entries = this._entries.filter((e) => e.relative_path !== rel);
    this._entries.push(entry);
    const existingFilenameList = (this._byFilename.get(entry.filename) ?? []).filter((e) => e.relative_path !== rel);
    existingFilenameList.push(entry);
    this._byFilename.set(entry.filename, existingFilenameList);
    this._byRel.set(entry.relative_path, [entry]);
    const existingStemList = (this._byLowerStem.get(entry.lowercase_stem) ?? []).filter((e) => e.relative_path !== rel);
    existingStemList.push(entry);
    this._byLowerStem.set(entry.lowercase_stem, existingStemList);
  }

  _scanByFilenameSync(filename) {
    const out = [];
    if (!this._projectRoot) return out;
    const stack = [this._projectRoot];
    const target = String(filename).toLowerCase();
    while (stack.length > 0) {
      const dir = stack.pop();
      let children = [];
      try {
        children = fsSync.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const child of children) {
        const abs = path.join(dir, child.name);
        if (child.isDirectory()) {
          const lower = child.name.toLowerCase();
          if (IGNORED_DIRS.has(lower) || lower.startsWith(".")) continue;
          stack.push(abs);
          continue;
        }
        if (!child.isFile()) continue;
        if (child.name.toLowerCase() !== target) continue;
        const ext = path.extname(child.name).toLowerCase();
        if (!this._extensions.has(ext)) continue;
        out.push(toRelPosix(this._projectRoot, abs));
      }
    }
    return out;
  }

  async _walk(dir) {
    const children = await fs.readdir(dir, { withFileTypes: true });
    for (const child of children) {
      const abs = path.join(dir, child.name);
      if (child.isDirectory()) {
        const lower = child.name.toLowerCase();
        if (IGNORED_DIRS.has(lower) || lower.startsWith(".")) continue;
        await this._walk(abs);
        continue;
      }
      if (!child.isFile()) continue;
      const ext = path.extname(child.name).toLowerCase();
      if (!this._extensions.has(ext)) continue;

      const relativePath = toRelPosix(this._projectRoot, abs);
      const entry = {
        relative_path: relativePath,
        filename: child.name,
        stem: fileStem(child.name),
        extension: ext,
        lowercase_filename: child.name.toLowerCase(),
        lowercase_stem: fileStem(child.name).toLowerCase(),
        lowercase_relative_path: relativePath.toLowerCase(),
      };
      this._entries.push(entry);

      const filenameList = this._byFilename.get(entry.filename) ?? [];
      filenameList.push(entry);
      this._byFilename.set(entry.filename, filenameList);

      this._byRel.set(entry.relative_path, [entry]);
      const stemList = this._byLowerStem.get(entry.lowercase_stem) ?? [];
      stemList.push(entry);
      this._byLowerStem.set(entry.lowercase_stem, stemList);
    }
  }

  _logDebugSummary(stage) {
    if (!this._debug) return;
    const summary = this.getDebugSummary({ tscnPreviewLimit: 50 });
    console.error(`[generic-mcp][index] ${stage} summary`, summary);
  }
}
