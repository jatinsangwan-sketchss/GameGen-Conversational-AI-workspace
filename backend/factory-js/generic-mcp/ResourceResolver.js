/**
 * ResourceResolver
 * -----------------------------------------------------------------------------
 * Resolves file/resource refs against a ProjectFileIndex.
 *
 * Session context args (e.g. projectPath) are explicitly out of scope.
 */

function normalizeRef(input) {
  const s = String(input ?? "")
    .trim()
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/^res:\/\//i, "")
    .replace(/^\/+/, "")
    .replace(/\\/g, "/");
  // Trim trailing punctuation from natural-language captures, e.g. "Game.tscn."
  return s.replace(/[)\],;:!?]+$/g, "").replace(/\.$/, (m, offset, full) => {
    const before = full.slice(0, -1);
    return /\.[A-Za-z0-9]{2,8}$/.test(before) ? "" : ".";
  });
}

function isLikelyAbsolute(input) {
  const s = String(input ?? "").trim();
  return s.startsWith("/") || /^[A-Za-z]:\\/.test(s);
}

function uniqueByPath(entries) {
  const out = [];
  const seen = new Set();
  for (const e of entries) {
    const key = String(e?.relative_path ?? "");
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
}

function fileStem(filename) {
  const s = String(filename ?? "").trim();
  if (!s) return "";
  const idx = s.lastIndexOf(".");
  if (idx <= 0) return s;
  return s.slice(0, idx);
}

export class ResourceResolver {
  constructor({ fileIndex, debug = false } = {}) {
    this._fileIndex = fileIndex;
    this._debug = Boolean(debug) || String(process.env.DEBUG_GENERIC_MCP_RESOLVER || "").toLowerCase() === "true";
  }

  getFileIndex() {
    return this._fileIndex ?? null;
  }

  async resolve({ value }) {
    const rawInput = String(value ?? "");
    const input = normalizeRef(value);
    // console.log("input [ResourceResolver]", input);
    if (!input) return { status: "not_found", matches: [], reason: "empty_input" };
    if (isLikelyAbsolute(value)) return { status: "not_found", matches: [], reason: "absolute_path_not_resource_ref" };
    if (this._debug) {
      console.error("[generic-mcp][resolver] resolve start", {
        rawInput,
        normalizedInput: input,
      });
    }

    if (this._debug) console.error("[generic-mcp][resolver] input", input);

    // 1) exact relative path
    const exactRel = this._fileIndex.findByRelativePath(input);
    if (this._debug) {
      console.error("[generic-mcp][resolver] candidates exact_relative_path", exactRel.map((m) => m.relative_path));
    }
    if (exactRel.length === 1) {
      if (this._debug) console.error("[generic-mcp][resolver] file ref resolved", { input, strategy: "exact_relative_path", resolved: exactRel[0].relative_path });
      return { status: "resolved", value: exactRel[0].relative_path, matches: [] };
    }
    if (exactRel.length > 1) {
      if (this._debug) console.error("[generic-mcp][resolver] file ref ambiguous", { input, strategy: "exact_relative_path", matchCount: exactRel.length });
      return { status: "ambiguous", value: null, matches: uniqueByPath(exactRel).map((m) => m.relative_path), ambiguities: uniqueByPath(exactRel).map((m) => m.relative_path) };
    }
    if (this._debug) console.error("[generic-mcp][resolver] exactRel", exactRel);

    // 2) exact filename
    const filename = input.split("/").pop() ?? input;
    const byExactName = this._fileIndex.findByFilename(filename);
    if (this._debug) {
      console.error("[generic-mcp][resolver] candidates exact_filename", byExactName.map((m) => m.relative_path));
    }
    if (byExactName.length === 1) {
      if (this._debug) console.error("[generic-mcp][resolver] file ref resolved", { input, strategy: "exact_filename", resolved: byExactName[0].relative_path });
      return { status: "resolved", value: byExactName[0].relative_path, matches: [] };
    }
    if (byExactName.length > 1) {
      if (this._debug) console.error("[generic-mcp][resolver] file ref ambiguous", { input, strategy: "exact_filename", matchCount: byExactName.length });
      return { status: "ambiguous", value: null, matches: uniqueByPath(byExactName).map((m) => m.relative_path), ambiguities: uniqueByPath(byExactName).map((m) => m.relative_path) };
    }
    if (this._debug) console.error("[generic-mcp][resolver] byExactName", byExactName);

    // 3) case-insensitive filename
    const lowerName = filename.toLowerCase();
    const ci = this._fileIndex.getAll().filter((e) => e.lowercase_filename === lowerName);
    if (this._debug) {
      console.error("[generic-mcp][resolver] candidates ci_filename", ci.map((m) => m.relative_path));
    }
    if (ci.length === 1) {
      if (this._debug) console.error("[generic-mcp][resolver] file ref resolved", { input, strategy: "ci_filename", resolved: ci[0].relative_path });
      return { status: "resolved", value: ci[0].relative_path, matches: [] };
    }
    if (ci.length > 1) {
      if (this._debug) console.error("[generic-mcp][resolver] file ref ambiguous", { input, strategy: "ci_filename", matchCount: ci.length });
      return { status: "ambiguous", value: null, matches: uniqueByPath(ci).map((m) => m.relative_path), ambiguities: uniqueByPath(ci).map((m) => m.relative_path) };
    }
    if (this._debug) console.error("[generic-mcp][resolver] ci", ci);

    // 4) basename/stem match (extension-agnostic semantic refs like "NewScene")
    const stem = fileStem(filename).toLowerCase();
    // console.log("[ResourcesResolver] 4 stemMatch",stem);
    const byStem = stem ? this._fileIndex.findByStem(stem) : [];
    // console.log("[ResourcesResolver] 4 findBy",{byStem, length: byStem.length});
    if (this._debug) {
      console.error("[generic-mcp][resolver] candidates basename_stem", byStem.map((m) => m.relative_path));
    }
    if (byStem.length === 1) {
      if (this._debug) console.error("[generic-mcp][resolver] file ref resolved", { input, strategy: "basename_stem", resolved: byStem[0].relative_path });
      return { status: "resolved", value: byStem[0].relative_path, matches: [] };
    }
    if (byStem.length > 1) {
      if (this._debug) console.error("[generic-mcp][resolver] file ref ambiguous", { input, strategy: "basename_stem", matchCount: byStem.length });
      return { status: "ambiguous", value: null, matches: uniqueByPath(byStem).map((m) => m.relative_path), ambiguities: uniqueByPath(byStem).map((m) => m.relative_path) };
    }
    if (this._debug) console.error("[generic-mcp][resolver] byStem", byStem);

    // 5) unique suffix/path match
    const suffix = input.toLowerCase();
    const bySuffix = this._fileIndex.findBySuffix(suffix);
    if (this._debug) {
      console.error("[generic-mcp][resolver] candidates unique_suffix", bySuffix.map((m) => m.relative_path));
    }
    if (bySuffix.length === 1) {
      if (this._debug) console.error("[generic-mcp][resolver] file ref resolved", { input, strategy: "unique_suffix", resolved: bySuffix[0].relative_path });
      return { status: "resolved", value: bySuffix[0].relative_path, matches: [] };
    }
    if (bySuffix.length > 1) {
      if (this._debug) console.error("[generic-mcp][resolver] file ref ambiguous", { input, strategy: "unique_suffix", matchCount: bySuffix.length });
      return { status: "ambiguous", value: null, matches: uniqueByPath(bySuffix).map((m) => m.relative_path), ambiguities: uniqueByPath(bySuffix).map((m) => m.relative_path) };
    }
    if (this._debug) console.error("[generic-mcp][resolver] bySuffix", bySuffix);
    if (this._debug) console.error("[generic-mcp][resolver] file ref not found", { input });
    return { status: "not_found", matches: [], reason: "no_match" };
  }
}
