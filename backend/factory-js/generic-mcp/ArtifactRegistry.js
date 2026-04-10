function safeString(value) {
  return value == null ? "" : String(value);
}

function isPlainObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function normalizeRef(input) {
  const s = safeString(input)
    .trim()
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/^res:\/\//i, "")
    .replace(/^\/+/, "")
    .replace(/\\/g, "/");
  return s || null;
}

function toGodotPath(relativePath) {
  const rel = normalizeRef(relativePath);
  return rel ? `res://${rel}` : null;
}

function fileName(relativePath) {
  const rel = normalizeRef(relativePath);
  if (!rel) return null;
  const parts = rel.split("/");
  return parts[parts.length - 1] || null;
}

function fileStem(nameOrPath) {
  const n = safeString(nameOrPath).trim();
  if (!n) return null;
  const base = n.split("/").pop() || n;
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

function inferKindFromPath(rel) {
  const r = normalizeRef(rel);
  if (!r) return null;
  const ext = r.includes(".") ? r.slice(r.lastIndexOf(".")).toLowerCase() : "";
  if (ext === ".gd") return "script";
  if (ext === ".tscn") return "scene";
  if (ext === ".tres" || ext === ".res") return "resource";
  if ([".png", ".jpg", ".jpeg", ".webp"].includes(ext)) return "texture";
  if ([".shader", ".gdshader"].includes(ext)) return "shader";
  return null;
}

function looksLikeCreateVerb(toolName) {
  const t = safeString(toolName).toLowerCase();
  return ["create", "new", "save", "write", "add", "attach", "generate", "export"].some((w) => t.includes(w));
}

function collectPathLikeStrings(value, out = []) {
  if (value == null) return out;
  if (typeof value === "string") {
    const n = normalizeRef(value);
    if (n && /[./\\]/.test(n)) out.push(n);
    return out;
  }
  if (Array.isArray(value)) {
    for (const v of value) collectPathLikeStrings(v, out);
    return out;
  }
  if (isPlainObject(value)) {
    for (const [k, v] of Object.entries(value)) {
      const nk = safeString(k).toLowerCase().replace(/[^a-z0-9_]/g, "");
      if (nk.includes("path") || nk.includes("file") || nk.includes("scene") || nk.includes("resource") || nk.includes("script")) {
        collectPathLikeStrings(v, out);
      }
    }
  }
  return out;
}

export class ArtifactRegistry {
  constructor() {
    this._byRelative = new Map();
    this._byLowerFilename = new Map();
    this._byLowerStem = new Map();
  }

  register({ relativePath, kind = null, requestedName = null, source = null } = {}) {
    const rel = normalizeRef(relativePath);
    if (!rel) return null;
    const filename = fileName(rel);
    const stem = fileStem(filename);
    if (!filename || !stem) return null;
    const artifact = {
      kind: safeString(kind).trim() || inferKindFromPath(rel) || null,
      requestedName: safeString(requestedName).trim() || filename,
      relativePath: rel,
      godotPath: toGodotPath(rel),
      filename,
      stem,
      source: safeString(source).trim() || null,
      updatedAt: new Date().toISOString(),
    };
    this._byRelative.set(rel.toLowerCase(), artifact);
    this._pushIndex(this._byLowerFilename, filename.toLowerCase(), artifact);
    this._pushIndex(this._byLowerStem, stem.toLowerCase(), artifact);
    return artifact;
  }

  registerFromExecution({ toolName, args, rawResult } = {}) {
    if (!looksLikeCreateVerb(toolName)) return [];
    const kindHint = safeString(args?.resourceKind).trim().toLowerCase() || null;
    const nameHint = safeString(args?.requestedName || args?.name || "").trim() || null;
    const seen = new Set();
    const out = [];
    const candidates = [
      ...collectPathLikeStrings(args),
      ...collectPathLikeStrings(rawResult),
    ];
    for (const c of candidates) {
      const rel = normalizeRef(c);
      if (!rel || seen.has(rel.toLowerCase())) continue;
      seen.add(rel.toLowerCase());
      const artifact = this.register({
        relativePath: rel,
        kind: kindHint || inferKindFromPath(rel),
        requestedName: nameHint,
        source: `tool:${safeString(toolName).trim()}`,
      });
      if (artifact) out.push(artifact);
    }
    return out;
  }

  resolveRef(value) {
    const raw = safeString(value).trim();
    const normalized = normalizeRef(raw);
    if (!raw || !normalized) return { status: "not_found", matches: [] };

    const exact = this._byRelative.get(normalized.toLowerCase());
    if (exact) return { status: "resolved", artifact: exact, matches: [] };

    const filename = fileName(normalized) || raw;
    const lowerFilename = safeString(filename).toLowerCase();
    const byFilename = [...(this._byLowerFilename.get(lowerFilename) ?? [])];
    if (byFilename.length === 1) return { status: "resolved", artifact: byFilename[0], matches: [] };
    if (byFilename.length > 1) return { status: "ambiguous", artifact: null, matches: byFilename };

    const stem = safeString(fileStem(filename)).toLowerCase();
    const byStem = [...(this._byLowerStem.get(stem) ?? [])];
    if (byStem.length === 1) return { status: "resolved", artifact: byStem[0], matches: [] };
    if (byStem.length > 1) return { status: "ambiguous", artifact: null, matches: byStem };

    const suffixMatches = this.getAll().filter((a) => a.relativePath.toLowerCase().endsWith(normalized.toLowerCase()));
    if (suffixMatches.length === 1) return { status: "resolved", artifact: suffixMatches[0], matches: [] };
    if (suffixMatches.length > 1) return { status: "ambiguous", artifact: null, matches: suffixMatches };
    return { status: "not_found", matches: [] };
  }

  getAll() {
    return [...this._byRelative.values()];
  }

  _pushIndex(map, key, artifact) {
    const list = (map.get(key) ?? []).filter((x) => x.relativePath.toLowerCase() !== artifact.relativePath.toLowerCase());
    list.push(artifact);
    map.set(key, list);
  }
}

