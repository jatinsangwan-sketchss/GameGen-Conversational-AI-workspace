import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { getSessionClient } from "./utils/session-client.js";

function safeString(value) {
  return value == null ? "" : String(value);
}

function isPlainObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function normalizeProjectRelativePath(value) {
  const raw = safeString(value).trim();
  if (!raw) return null;
  return raw
    .replace(/^res:\/\//i, "")
    .replace(/^\/+/, "")
    .replace(/\\/g, "/");
}

function hashText(text) {
  return crypto.createHash("sha256").update(safeString(text), "utf8").digest("hex");
}

function extOf(relPath) {
  return path.extname(safeString(relPath).trim()).toLowerCase();
}

function isRawToolResultOk(rawResult) {
  if (!isPlainObject(rawResult)) return true;
  if (rawResult.ok === false) return false;
  if (rawResult.isError === true) return false;
  if (rawResult.error != null) return false;
  return true;
}

function extractRawFailureText(rawResult) {
  const raw = isPlainObject(rawResult) ? rawResult : {};
  const direct = safeString(raw.error ?? raw.message).trim();
  if (direct) return direct;
  const blocks = Array.isArray(raw.content) ? raw.content : [];
  for (const block of blocks) {
    const text = safeString(block?.text).trim();
    if (!text) continue;
    try {
      const parsed = JSON.parse(text);
      const msg = safeString(parsed?.error ?? parsed?.message).trim();
      if (msg) return msg;
    } catch {
      // ignore
    }
    return text;
  }
  return "";
}

function parseGeneratedJson(raw) {
  if (isPlainObject(raw)) return raw;
  const text = safeString(raw?.text ?? raw).trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

function countOccurrences(haystack, needle) {
  if (!needle) return 0;
  let count = 0;
  let from = 0;
  while (true) {
    const idx = haystack.indexOf(needle, from);
    if (idx < 0) break;
    count += 1;
    from = idx + Math.max(needle.length, 1);
  }
  return count;
}

function validateGodot4Script(content) {
  const text = safeString(content);
  const issues = [];
  const push = (code, message) => issues.push({ code, message });
  if (!text.trim()) push("empty_script", "Generated script is empty.");
  if (/(^|\n)\s*export\s+var\b/.test(text)) push("godot3_export_var", "Uses Godot 3.x `export var` syntax.");
  if (/(^|\n)\s*onready\s+var\b/.test(text)) push("godot3_onready_var", "Uses Godot 3.x `onready var` syntax.");
  if (/\byield\s*\(/.test(text)) push("godot3_yield", "Uses Godot 3.x `yield()` syntax.");
  const extendsMatches = text.match(/(^|\n)\s*extends\s+[^\n]+/g) || [];
  if (extendsMatches.length > 1) push("duplicate_extends", "Contains multiple `extends` declarations.");
  return { ok: issues.length === 0, issues };
}

function validateTscnStructure(content) {
  const text = safeString(content);
  const issues = [];
  const push = (code, message) => issues.push({ code, message });
  if (!text.trim()) push("empty_scene", "Scene file is empty.");
  if (!text.startsWith("[gd_scene")) push("missing_gd_scene_header", "Scene must start with [gd_scene ...].");
  if (text.includes("\u0000")) push("null_byte", "Scene contains null byte.");
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line.startsWith("[")) continue;
    if (!line.endsWith("]")) {
      push("invalid_section_header", `Malformed section header at line ${i + 1}.`);
      break;
    }
  }
  if (!/(^|\n)\s*\[node\b/.test(text)) push("missing_node_section", "Scene is missing any [node ...] section.");
  return { ok: issues.length === 0, issues };
}

function normalizeOperations(rawOps = null) {
  const ops = Array.isArray(rawOps) ? rawOps : [];
  const normalized = [];
  for (const raw of ops) {
    if (!isPlainObject(raw)) continue;
    const type = safeString(raw.type).trim().toLowerCase();
    if (!type) continue;
    const op = { type };
    const copyIf = (key, aliases = []) => {
      const v = safeString(raw[key] ?? aliases.map((a) => raw[a]).find((x) => x != null));
      if (v) op[key] = v;
    };
    // Accept common alias keys from model outputs while preserving canonical ops.
    copyIf("find", ["target", "anchor", "match"]);
    if (type === "replace_once" || type === "replace_all") {
      copyIf("replace", ["content", "replacement", "value", "insert", "text"]);
    }
    if (type === "insert_before" || type === "insert_after") {
      copyIf("insert", ["content", "replacement", "value", "text", "replace"]);
    } else {
      copyIf("insert", ["text"]);
    }
    copyIf("start");
    copyIf("end");
    normalized.push(op);
  }
  return normalized;
}

function applyTargetedOperations(content, operations = []) {
  let out = safeString(content);
  for (let idx = 0; idx < operations.length; idx += 1) {
    const op = operations[idx];
    const type = safeString(op?.type).trim().toLowerCase();
    if (type === "replace_once") {
      const find = safeString(op.find);
      const replace = safeString(op.replace);
      const count = countOccurrences(out, find);
      if (!find || count !== 1) {
        return { ok: false, error: "replace_once requires exactly one unique match.", opIndex: idx, opType: type, matchCount: count, op };
      }
      out = out.replace(find, replace);
      continue;
    }
    if (type === "replace_all") {
      const find = safeString(op.find);
      const replace = safeString(op.replace);
      const count = countOccurrences(out, find);
      if (!find || count < 1) {
        return { ok: false, error: "replace_all requires at least one match.", opIndex: idx, opType: type, matchCount: count, op };
      }
      out = out.split(find).join(replace);
      continue;
    }
    if (type === "insert_before") {
      const find = safeString(op.find);
      const insert = safeString(op.insert);
      const count = countOccurrences(out, find);
      if (!find || count !== 1) {
        return { ok: false, error: "insert_before requires exactly one unique anchor.", opIndex: idx, opType: type, matchCount: count, op };
      }
      const anchorIdx = out.indexOf(find);
      out = `${out.slice(0, anchorIdx)}${insert}${out.slice(anchorIdx)}`;
      continue;
    }
    if (type === "insert_after") {
      const find = safeString(op.find);
      const insert = safeString(op.insert);
      const count = countOccurrences(out, find);
      if (!find || count !== 1) {
        return { ok: false, error: "insert_after requires exactly one unique anchor.", opIndex: idx, opType: type, matchCount: count, op };
      }
      const anchorIdx = out.indexOf(find);
      out = `${out.slice(0, anchorIdx + find.length)}${insert}${out.slice(anchorIdx + find.length)}`;
      continue;
    }
    if (type === "delete_block") {
      const start = safeString(op.start);
      const end = safeString(op.end);
      if (!start || !end) return { ok: false, error: "delete_block requires start and end markers.", opIndex: idx, opType: type, op };
      const startCount = countOccurrences(out, start);
      const endCount = countOccurrences(out, end);
      if (startCount !== 1 || endCount !== 1) {
        return {
          ok: false,
          error: "delete_block markers must be unique.",
          opIndex: idx,
          opType: type,
          markerCounts: { start: startCount, end: endCount },
          op,
        };
      }
      const startIdx = out.indexOf(start);
      const endIdx = out.indexOf(end, startIdx + start.length);
      if (startIdx < 0 || endIdx < 0 || endIdx < startIdx) {
        return { ok: false, error: "delete_block markers are out of order.", opIndex: idx, opType: type, op };
      }
      out = `${out.slice(0, startIdx)}${out.slice(endIdx + end.length)}`;
      continue;
    }
    return { ok: false, error: `Unsupported operation type: ${type || "<empty>"}`, opIndex: idx, opType: type, op };
  }
  return { ok: true, content: out };
}

function parseSectionType(headerLine = "") {
  const m = safeString(headerLine).trim().match(/^\[([a-z_]+)/i);
  return m ? safeString(m[1]).toLowerCase() : "";
}

function parseHeaderAttributes(headerLine = "") {
  const out = {};
  const line = safeString(headerLine);
  const re = /([A-Za-z_][A-Za-z0-9_]*)=(?:"([^"]*)"|([^\s\]]+))/g;
  let m = null;
  while ((m = re.exec(line)) != null) {
    const key = safeString(m[1]).trim();
    const value = m[2] != null ? m[2] : safeString(m[3]).trim();
    if (!key) continue;
    out[key] = value;
  }
  return out;
}

function parseTscnSections(content = "") {
  const text = safeString(content);
  const lines = text.split("\n");
  const starts = [];
  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = safeString(lines[i]).trim();
    if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) continue;
    starts.push(i);
  }
  const sections = [];
  for (let i = 0; i < starts.length; i += 1) {
    const start = starts[i];
    const end = i + 1 < starts.length ? starts[i + 1] : lines.length;
    const headerLine = lines[start];
    sections.push({
      type: parseSectionType(headerLine),
      attrs: parseHeaderAttributes(headerLine),
      headerLine,
      start,
      end,
    });
  }
  const gdScene = sections.find((s) => s.type === "gd_scene") || null;
  const subResources = new Map();
  const extResources = [];
  const nodes = [];
  for (const sec of sections) {
    if (sec.type === "ext_resource") {
      extResources.push(sec);
      continue;
    }
    if (sec.type === "sub_resource") {
      const id = safeString(sec.attrs.id).trim();
      if (id) subResources.set(id, sec);
      continue;
    }
    if (sec.type === "node") {
      const name = safeString(sec.attrs.name).trim();
      const parent = safeString(sec.attrs.parent).trim();
      const pathValue = parent && parent !== "."
        ? `${parent}/${name}`.replace(/^\/+/, "")
        : name;
      nodes.push({ ...sec, name, parent, pathValue });
    }
  }
  return { lines, sections, gdScene, subResources, extResources, nodes };
}

function findPropertyLineIndex(lines = [], section = null, propertyName = "") {
  if (!section) return -1;
  const key = safeString(propertyName).trim();
  if (!key) return -1;
  const re = new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}\\s*=`);
  for (let i = section.start + 1; i < section.end; i += 1) {
    const trimmed = safeString(lines[i]).trim();
    if (re.test(trimmed)) return i;
  }
  return -1;
}

function parseSubResourceRef(value = "") {
  const m = safeString(value).match(/SubResource\("([^"]+)"\)/);
  return m ? safeString(m[1]).trim() : "";
}

function replaceHeaderLoadSteps(headerLine = "", incrementBy = 0) {
  const base = safeString(headerLine);
  const inc = Number(incrementBy) || 0;
  if (inc < 1) return { changed: false, value: base };
  const match = base.match(/\bload_steps\s*=\s*(\d+)/i);
  if (!match) return { changed: false, value: base };
  const current = Number(match[1]);
  if (!Number.isFinite(current)) return { changed: false, value: base };
  const updated = Math.max(1, current + inc);
  const value = base.replace(/\bload_steps\s*=\s*\d+/i, `load_steps=${updated}`);
  return { changed: value !== base, value };
}

function pickSubResourceInsertAnchor(scene = null) {
  if (!scene) return "";
  const subList = [...(scene.subResources?.values?.() ?? [])]
    .filter((s) => Number.isFinite(s?.start) && s.start >= 0)
    .sort((a, b) => Number(a.start) - Number(b.start));
  if (subList.length > 0) return safeString(subList[subList.length - 1].headerLine);
  const extList = Array.isArray(scene.extResources) ? scene.extResources : [];
  if (extList.length > 0) {
    const sorted = [...extList]
      .filter((s) => Number.isFinite(s?.start) && s.start >= 0)
      .sort((a, b) => Number(a.start) - Number(b.start));
    if (sorted.length > 0) return safeString(sorted[sorted.length - 1].headerLine);
  }
  return safeString(scene.gdScene?.headerLine);
}

function pickExtResourceInsertAnchor(scene = null) {
  if (!scene) return "";
  const extList = Array.isArray(scene.extResources) ? scene.extResources : [];
  const sortedExt = extList
    .filter((s) => Number.isFinite(s?.start) && s.start >= 0)
    .sort((a, b) => Number(a.start) - Number(b.start));
  if (sortedExt.length > 0) return safeString(sortedExt[sortedExt.length - 1].headerLine);
  return safeString(scene.gdScene?.headerLine);
}

function inferGodotResourceTypeFromPath(pathValue = "") {
  const p = safeString(pathValue).trim().toLowerCase();
  if (!p) return "Resource";
  if (p.endsWith(".tscn")) return "PackedScene";
  if (/\.(png|jpg|jpeg|webp|bmp|svg)$/.test(p)) return "Texture2D";
  if (/\.(ogg|wav|mp3|flac)$/.test(p)) return "AudioStream";
  if (/\.(ttf|otf|woff|woff2)$/.test(p)) return "FontFile";
  if (/\.(gdshader|shader)$/.test(p)) return "Shader";
  if (/\.(tres|res)$/.test(p)) return "Resource";
  return "Resource";
}

function normalizeResourceTypeHint(typeHint = "", paths = []) {
  const hint = safeString(typeHint).trim();
  const lower = hint.toLowerCase();
  if (!hint) {
    const firstPath = Array.isArray(paths) && paths.length > 0 ? safeString(paths[0]).trim() : "";
    return inferGodotResourceTypeFromPath(firstPath);
  }
  if (lower === "scene" || lower === "packedscene") return "PackedScene";
  if (lower === "texture" || lower === "texture2d") return "Texture2D";
  if (lower === "audio" || lower === "audiostream") return "AudioStream";
  if (lower === "font" || lower === "fontfile") return "FontFile";
  if (lower === "shader") return "Shader";
  if (lower === "resource") return "Resource";
  return hint;
}

function parseNodeRequestSegments(userRequest = "") {
  const text = safeString(userRequest);
  if (!text.trim()) return [];
  const out = [];
  const seen = new Set();
  const clauses = text
    .split(/\s*(?:\.\s+|;\s+|\n+)\s*/)
    .map((c) => safeString(c).trim())
    .filter(Boolean);
  for (const clause of clauses) {
    if (!/\bset[-_ ]node[-_ ]properties\b/i.test(clause)) continue;
    const nodePatterns = [
      /\bon\s+Node\s+`([^`]+)`/i,
      /\bon\s+Node\s+([A-Za-z0-9_./-]+)/i,
      /\bto\s+`([^`]+)`/i,
      /\bto\s+([A-Za-z0-9_./-]+)/i,
      /\bNode\s+`([^`]+)`/i,
      /\bNode\s+([A-Za-z0-9_./-]+)/i,
    ];
    let nodeToken = "";
    for (const p of nodePatterns) {
      const m = clause.match(p);
      const candidate = safeString(m?.[1]).trim();
      if (candidate) {
        nodeToken = candidate;
        break;
      }
    }
    if (!nodeToken) continue;
    const key = `${nodeToken.toLowerCase()}::${clause.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ nodeToken, chunk: clause });
  }
  return out;
}

function parseNodePropertyIntentFromChunk(chunk = "") {
  const text = safeString(chunk);
  const intent = {
    color: null,
    polygon: null,
    shapeResourceType: null,
    shapeProperties: {},
    position: null,
    resourceArray: null,
    genericProperties: {},
  };
  const colorMatch = text.match(/\bcolor\s+(?:to|as)\s+(Color\([^)]+\))/i);
  if (colorMatch) intent.color = safeString(colorMatch[1]).trim();
  const points = [...text.matchAll(/\[\s*([-+]?\d*\.?\d+)\s*,\s*([-+]?\d*\.?\d+)\s*\]/g)];
  if (points.length >= 3 && /\bpolygon\s+(?:to|as)\b/i.test(text)) {
    const flat = [];
    for (const p of points) {
      flat.push(Number(p[1]), Number(p[2]));
    }
    intent.polygon = `PackedVector2Array(${flat.join(", ")})`;
  }
  const shapeTypeMatch = text.match(/\bshape\s+(?:to|as)\s+(?:a|an)?\s*([A-Za-z_][A-Za-z0-9_]*)\b/i);
  if (shapeTypeMatch) {
    intent.shapeResourceType = safeString(shapeTypeMatch[1]).trim();
  }
  const sizeMatch = text.match(/\b(?:size\s+(?:to|as)\s+|with\s+size\s+)(Vector2\(\s*[-+]?\d*\.?\d+\s*,\s*[-+]?\d*\.?\d+\s*\))/i);
  if (sizeMatch) {
    intent.shapeProperties.size = safeString(sizeMatch[1]).trim();
  }
  const radiusMatch = text.match(/\b(?:radius\s+(?:to|as)\s+|with\s+radius\s+)([-+]?\d*\.?\d+)\b/i);
  if (radiusMatch) {
    intent.shapeProperties.radius = String(Number(radiusMatch[1]));
  }
  const heightMatch = text.match(/\b(?:height\s+(?:to|as)\s+|with\s+height\s+)([-+]?\d*\.?\d+)\b/i);
  if (heightMatch) {
    intent.shapeProperties.height = String(Number(heightMatch[1]));
  }
  const widthMatch = text.match(/\b(?:width\s+(?:to|as)\s+|with\s+width\s+)([-+]?\d*\.?\d+)\b/i);
  if (widthMatch) {
    intent.shapeProperties.width = String(Number(widthMatch[1]));
  }
  if (!intent.shapeResourceType) {
    const inferredShapeFromProps =
      Object.prototype.hasOwnProperty.call(intent.shapeProperties, "radius")
        ? "CircleShape2D"
        : Object.prototype.hasOwnProperty.call(intent.shapeProperties, "size")
          ? "RectangleShape2D"
          : null;
    if (inferredShapeFromProps) intent.shapeResourceType = inferredShapeFromProps;
  }
  const posMatch = text.match(/\bposition\s+(?:to|as)\s+(Vector2\(\s*[-+]?\d*\.?\d+\s*,\s*[-+]?\d*\.?\d+\s*\))/i);
  if (posMatch) intent.position = safeString(posMatch[1]).trim();

  const normalizeGenericExpr = (propertyName = "", rawExpr = "") => {
    const prop = safeString(propertyName).trim().toLowerCase();
    const exprRaw = safeString(rawExpr).trim().replace(/[.;]+$/g, "").trim();
    if (!exprRaw) return "";
    if (prop === "polygon") {
      const vectorMatches = [...exprRaw.matchAll(/Vector2\(\s*([-+]?\d*\.?\d+)\s*,\s*([-+]?\d*\.?\d+)\s*\)/g)];
      if (vectorMatches.length >= 3) {
        const flat = [];
        for (const m of vectorMatches) flat.push(Number(m[1]), Number(m[2]));
        return `PackedVector2Array(${flat.join(", ")})`;
      }
    }
    return exprRaw;
  };
  const explicitSetMatch = text.match(/\bto\s+set\s+([\s\S]+)$/i);
  const explicitSetTail = safeString(explicitSetMatch?.[1]).trim();
  if (explicitSetTail) {
    const parts = explicitSetTail
      .split(/\s+\band\b\s+/i)
      .map((p) => safeString(p).trim())
      .filter(Boolean);
    for (const part of parts) {
      const m = part.match(/^([A-Za-z_][A-Za-z0-9_/]*)\s+(?:to|as)\s+([\s\S]+)$/i);
      const prop = safeString(m?.[1]).trim();
      const expr = normalizeGenericExpr(prop, safeString(m?.[2]).trim());
      if (!prop || !expr) continue;
      intent.genericProperties[prop] = expr;
    }
  }
  const arrayPropMatch = text.match(/\bproperty\s+([A-Za-z_][A-Za-z0-9_]*)\s+to\s+an?\s+array\b/i);
  const inlinePropMatch = text.match(/\bset[_ -]?node[_ -]?properties\b[^.]*?\b([A-Za-z_][A-Za-z0-9_]*)\s+to\s+an?\s+array\b/i);
  const typedArrayMatch = text.match(/\barray\s+containing\s+([A-Za-z0-9_]+)\s+paths?\b/i);
  const propName = safeString(arrayPropMatch?.[1] || inlinePropMatch?.[1]).trim();
  const resourcePaths = [...text.matchAll(/res:\/\/[A-Za-z0-9_./-]+\.[A-Za-z0-9_]+/gi)].map((m) => safeString(m[0]).trim());
  const uniqueResourcePaths = [...new Set(resourcePaths)];
  if (propName && uniqueResourcePaths.length > 0) {
    intent.resourceArray = {
      propertyName: propName,
      resourceTypeHint: safeString(typedArrayMatch?.[1]).trim() || null,
      resourcePaths: uniqueResourcePaths,
    };
  }
  return intent;
}

function validateNormalizedOperations(operations = []) {
  const out = Array.isArray(operations) ? operations : [];
  const issues = [];
  for (let i = 0; i < out.length; i += 1) {
    const op = out[i];
    const type = safeString(op?.type).trim().toLowerCase();
    if (!type) {
      issues.push({ index: i, reason: "missing_type" });
      continue;
    }
    if (type === "replace_once" || type === "replace_all") {
      if (!safeString(op.find)) issues.push({ index: i, reason: "missing_find" });
      if (!safeString(op.replace)) issues.push({ index: i, reason: "missing_replace" });
      continue;
    }
    if (type === "insert_before" || type === "insert_after") {
      if (!safeString(op.find)) issues.push({ index: i, reason: "missing_find" });
      if (!safeString(op.insert)) issues.push({ index: i, reason: "missing_insert" });
      continue;
    }
    if (type === "delete_block") {
      if (!safeString(op.start)) issues.push({ index: i, reason: "missing_start" });
      if (!safeString(op.end)) issues.push({ index: i, reason: "missing_end" });
      continue;
    }
    issues.push({ index: i, reason: `unsupported_type:${type}` });
  }
  return { ok: issues.length === 0, issues };
}

export class TextEditFallbackStage {
  constructor({
    sessionManager = null,
    toolInventory = null,
    modelClient = null,
    debug = false,
    snapshotLimit = 3,
  } = {}) {
    this._sessionManager = sessionManager ?? null;
    this._toolInventory = toolInventory ?? null;
    this._modelClient = modelClient ?? null;
    this._snapshotLimit = Number.isFinite(Number(snapshotLimit)) ? Math.max(1, Math.floor(Number(snapshotLimit))) : 3;
    this._debug =
      Boolean(debug) ||
      safeString(process.env.DEBUG_GENERIC_MCP_FALLBACK).trim().toLowerCase() === "true";
  }

  _debugLog(label, payload = null) {
    if (!this._debug) return;
    if (payload == null) {
      console.error(`[generic-mcp][fallback] ${label}`);
    } else {
      console.error(`[generic-mcp][fallback] ${label}`, payload);
    }
  }

  _isSupportedTarget(relPath = "") {
    const ext = extOf(relPath);
    return ext === ".gd" || ext === ".tscn";
  }

  _normalizeTarget(targetPath = "") {
    const rel = normalizeProjectRelativePath(targetPath);
    if (!rel) return null;
    if (!this._isSupportedTarget(rel)) return null;
    return rel;
  }

  _findTargetNodeSection(scene = null, requestedNode = "") {
    const token = safeString(requestedNode).trim();
    if (!scene || !token) return { ok: false, reason: "empty_node_token", section: null };
    const tokenLower = token.toLowerCase();
    const candidates = (Array.isArray(scene.nodes) ? scene.nodes : []).filter((n) => {
      const name = safeString(n.name).trim().toLowerCase();
      const full = safeString(n.pathValue).trim().toLowerCase();
      if (!name && !full) return false;
      if (tokenLower === name || tokenLower === full) return true;
      if (full && full.endsWith(`/${tokenLower}`)) return true;
      return false;
    });
    if (candidates.length === 1) return { ok: true, reason: null, section: candidates[0] };
    if (candidates.length > 1) return { ok: false, reason: `ambiguous_node:${token}`, section: null };
    return { ok: false, reason: `node_not_found:${token}`, section: null };
  }

  _newSubResourceId(scene = null, type = "Resource") {
    const existing = new Set(
      [...(scene?.subResources?.keys?.() ?? [])].map((v) => safeString(v).trim()).filter(Boolean)
    );
    const base = `${safeString(type).trim() || "Resource"}_gmcp`;
    for (let i = 1; i < 1000; i += 1) {
      const candidate = `${base}_${i}`;
      if (!existing.has(candidate)) return candidate;
    }
    return `${base}_${Date.now()}`;
  }

  _newExtResourceId(scene = null, type = "Resource") {
    const existing = new Set();
    const ext = Array.isArray(scene?.extResources) ? scene.extResources : [];
    for (const sec of ext) {
      const id = safeString(sec?.attrs?.id).trim();
      if (id) existing.add(id);
    }
    const base = `${safeString(type).trim() || "Resource"}_gmcp`;
    for (let i = 1; i < 1000; i += 1) {
      const candidate = `${base}_${i}`;
      if (!existing.has(candidate)) return candidate;
    }
    return `${base}_${Date.now()}`;
  }

  _buildStructuredTscnOperations({ userRequest = "", originalContent = "" } = {}) {
    const scene = parseTscnSections(originalContent);
    if (!scene?.gdScene?.headerLine) return { ok: false, reason: "tscn_no_gd_scene_header", operations: [] };
    const segments = parseNodeRequestSegments(userRequest);
    if (segments.length < 1) return { ok: false, reason: "tscn_no_node_segments", operations: [] };

    const operations = [];
    const addReplacePropertyOp = (section, propertyName, expr) => {
      if (!section || !propertyName) return;
      const lineIdx = findPropertyLineIndex(scene.lines, section, propertyName);
      const expectedLine = `${propertyName} = ${expr}`;
      if (lineIdx >= 0) {
        const currentLine = safeString(scene.lines[lineIdx]);
        if (safeString(currentLine).trim() === expectedLine.trim()) return;
        operations.push({
          type: "replace_once",
          find: currentLine,
          replace: expectedLine,
        });
        return;
      }
      operations.push({
        type: "insert_after",
        find: section.headerLine,
        insert: `\n${expectedLine}`,
      });
    };

    const pendingNewSubResources = [];
    const pendingNewExtResources = [];
    for (const seg of segments) {
      const intent = parseNodePropertyIntentFromChunk(seg.chunk);
      const genericProps = isPlainObject(intent.genericProperties) ? intent.genericProperties : {};
      if (
        !intent.color &&
        !intent.polygon &&
        !intent.shapeResourceType &&
        !intent.position &&
        !intent.resourceArray &&
        Object.keys(genericProps).length < 1
      ) continue;
      const nodeMatch = this._findTargetNodeSection(scene, seg.nodeToken);
      if (!nodeMatch.ok || !nodeMatch.section) {
        return { ok: false, reason: nodeMatch.reason || `tscn_node_unresolved:${seg.nodeToken}`, operations: [] };
      }
      const node = nodeMatch.section;
      if (intent.color) addReplacePropertyOp(node, "color", intent.color);
      if (intent.polygon) addReplacePropertyOp(node, "polygon", intent.polygon);
      if (intent.position) addReplacePropertyOp(node, "position", intent.position);
      for (const [propNameRaw, exprRaw] of Object.entries(genericProps)) {
        const propName = safeString(propNameRaw).trim();
        const expr = safeString(exprRaw).trim();
        if (!propName || !expr) continue;
        const lowerProp = propName.toLowerCase();
        if (lowerProp === "shape") {
          continue;
        }
        if (lowerProp === "color" && intent.color) continue;
        if (lowerProp === "polygon" && intent.polygon) continue;
        if (lowerProp === "position" && intent.position) continue;
        addReplacePropertyOp(node, propName, expr);
      }
      if (intent.shapeResourceType) {
        const desiredShapeType = safeString(intent.shapeResourceType).trim() || "Resource";
        let shapeSubId = "";
        const shapeLineIdx = findPropertyLineIndex(scene.lines, node, "shape");
        if (shapeLineIdx >= 0) {
          const existingShapeLine = safeString(scene.lines[shapeLineIdx]).trim();
          const refId = parseSubResourceRef(existingShapeLine);
          const sub = refId ? scene.subResources.get(refId) : null;
          const subType = safeString(sub?.attrs?.type).trim().toLowerCase();
          if (refId && sub && subType === desiredShapeType.toLowerCase()) {
            shapeSubId = refId;
          }
        }
        if (!shapeSubId) {
          shapeSubId = this._newSubResourceId(scene, desiredShapeType);
          const props = isPlainObject(intent.shapeProperties) ? intent.shapeProperties : {};
          const normalizedProps = Object.fromEntries(
            Object.entries(props)
              .map(([k, v]) => [safeString(k).trim(), safeString(v).trim()])
              .filter(([k, v]) => Boolean(k) && Boolean(v))
          );
          pendingNewSubResources.push({
            id: shapeSubId,
            type: desiredShapeType,
            properties: normalizedProps,
          });
          scene.subResources.set(shapeSubId, {
            type: "sub_resource",
            attrs: { type: desiredShapeType, id: shapeSubId },
            headerLine: `[sub_resource type="${desiredShapeType}" id="${shapeSubId}"]`,
            start: -1,
            end: -1,
          });
        }
        addReplacePropertyOp(node, "shape", `SubResource("${shapeSubId}")`);
        const subSection = scene.subResources.get(shapeSubId);
        if (subSection && Number.isFinite(subSection.start) && subSection.start >= 0) {
          const shapeProps = isPlainObject(intent.shapeProperties) ? intent.shapeProperties : {};
          for (const [propName, propValue] of Object.entries(shapeProps)) {
            const p = safeString(propName).trim();
            const v = safeString(propValue).trim();
            if (!p || !v) continue;
            addReplacePropertyOp(subSection, p, v);
          }
        }
      }
      if (isPlainObject(intent.resourceArray)) {
        const prop = safeString(intent.resourceArray.propertyName).trim();
        const paths = Array.isArray(intent.resourceArray.resourcePaths)
          ? intent.resourceArray.resourcePaths.map((p) => safeString(p).trim()).filter(Boolean)
          : [];
        const targetType = normalizeResourceTypeHint(intent.resourceArray.resourceTypeHint, paths) || "Resource";
        if (prop && paths.length > 0) {
          const refs = [];
          for (const p of paths) {
            const existingExt = (Array.isArray(scene.extResources) ? scene.extResources : []).find((sec) => {
              const type = safeString(sec?.attrs?.type).trim().toLowerCase();
              const pathValue = safeString(sec?.attrs?.path).trim();
              return type === safeString(targetType).trim().toLowerCase() && pathValue === p;
            });
            let extId = safeString(existingExt?.attrs?.id).trim();
            if (!extId) {
              extId = this._newExtResourceId(scene, targetType);
              pendingNewExtResources.push({ id: extId, path: p, type: targetType });
              scene.extResources = Array.isArray(scene.extResources) ? scene.extResources : [];
              scene.extResources.push({
                type: "ext_resource",
                attrs: { type: targetType, path: p, id: extId },
                headerLine: `[ext_resource type="${targetType}" path="${p}" id="${extId}"]`,
                start: -1,
                end: -1,
              });
            }
            refs.push(`ExtResource("${extId}")`);
          }
          addReplacePropertyOp(node, prop, `Array[${targetType}]([${refs.join(", ")}])`);
        }
      }
    }

    if (pendingNewExtResources.length > 0) {
      const extAnchor = pickExtResourceInsertAnchor(scene) || safeString(scene.gdScene?.headerLine);
      const extBlock = pendingNewExtResources
        .map((res) => `[ext_resource type="${safeString(res.type).trim() || "Resource"}" path="${res.path}" id="${res.id}"]`)
        .join("\n");
      operations.unshift({
        type: "insert_after",
        find: extAnchor,
        insert: `\n${extBlock}\n`,
      });
    }

    if (pendingNewSubResources.length > 0) {
      const prefixOps = [];
      const originalHeaderLine = safeString(scene.gdScene.headerLine);
      let headerAnchorForInsert = pickSubResourceInsertAnchor(scene) || originalHeaderLine;
      const headerUpdate = replaceHeaderLoadSteps(
        originalHeaderLine,
        pendingNewSubResources.length
      );
      if (headerUpdate.changed) {
        prefixOps.push({
          type: "replace_once",
          find: originalHeaderLine,
          replace: headerUpdate.value,
        });
        if (headerAnchorForInsert === originalHeaderLine) headerAnchorForInsert = headerUpdate.value;
      }
      const block = pendingNewSubResources
        .map((res) => {
          const type = safeString(res?.type).trim() || "Resource";
          const props = isPlainObject(res?.properties) ? res.properties : {};
          const propLines = Object.entries(props)
            .map(([k, v]) => `${safeString(k).trim()} = ${safeString(v).trim()}`)
            .filter((line) => !/^\s*=/.test(line));
          return [
            "",
            `[sub_resource type="${type}" id="${res.id}"]`,
            ...propLines,
          ].join("\n");
        })
        .join("\n");
      prefixOps.push({
        type: "insert_after",
        find: headerAnchorForInsert,
        insert: `${block}\n`,
      });
      operations.unshift(...prefixOps);
    }

    if (operations.length < 1) return { ok: false, reason: "tscn_no_structured_operations", operations: [] };
    const validation = validateNormalizedOperations(operations);
    if (!validation.ok) {
      return {
        ok: false,
        reason: `tscn_structured_operations_invalid: ${validation.issues.map((i) => `${i.index}:${i.reason}`).join(", ")}`,
        operations: [],
      };
    }
    return {
      ok: true,
      reason: null,
      operations,
      summary: "TSCN structured fallback operations generated from node/property intents.",
    };
  }

  async attempt({
    userRequest = "",
    projectRoot = null,
    targetPath = null,
    reason = null,
    workflowState = null,
  } = {}) {
    const rel = this._normalizeTarget(targetPath);
    const root = safeString(projectRoot).trim();
    if (!root) {
      return { ok: false, reason: "fallback_project_root_missing", fallback: { attempted: false } };
    }
    if (!rel) {
      return { ok: false, reason: "fallback_target_not_supported", fallback: { attempted: false } };
    }
    const absPath = path.resolve(root, rel);
    let original = "";
    try {
      original = await fs.readFile(absPath, "utf8");
    } catch {
      return { ok: false, reason: `fallback_target_not_found: ${rel}`, fallback: { attempted: false, targetPath: rel } };
    }
    const ext = extOf(rel);
    const snapshot = {
      targetPath: rel,
      content: original,
      hash: hashText(original),
      createdAt: new Date().toISOString(),
    };
    this._debugLog("snapshot:captured", { targetPath: rel, hash: snapshot.hash });

    let plan = null;
    if (ext === ".tscn") {
      const structured = this._buildStructuredTscnOperations({
        userRequest,
        originalContent: original,
      });
      if (structured.ok) {
        plan = structured;
        this._debugLog("plan:structured-generated", {
          targetPath: rel,
          operationCount: structured.operations.length,
          operations: structured.operations,
        });
      } else {
        this._debugLog("plan:structured-unavailable", {
          targetPath: rel,
          reason: structured.reason,
        });
      }
    }
    if (!plan) {
      plan = await this._generateOperations({
        userRequest,
        reason,
        targetPath: rel,
        extension: ext,
        originalContent: original,
      });
    }
    if (!plan.ok) {
      this._debugLog("plan:failed", { targetPath: rel, reason: plan.reason });
      return {
        ok: false,
        reason: plan.reason,
        fallback: { attempted: true, targetPath: rel, stage: "plan", error: plan.reason },
      };
    }
    this._debugLog("plan:generated", {
      targetPath: rel,
      operationCount: Array.isArray(plan.operations) ? plan.operations.length : 0,
      operations: plan.operations,
      summary: plan.summary || null,
    });
    const applyResult = applyTargetedOperations(original, plan.operations);
    let finalPlan = plan;
    let finalApply = applyResult;
    const retryableApplyFailure = !applyResult.ok && /unique anchor|unique match|at least one match/i.test(safeString(applyResult.error));
    if (retryableApplyFailure) {
      this._debugLog("apply:retry-plan", {
        targetPath: rel,
        firstApplyError: applyResult.error,
        opIndex: applyResult.opIndex,
        opType: applyResult.opType,
        matchCount: applyResult.matchCount ?? null,
      });
      const retryPlan = await this._generateOperations({
        userRequest,
        reason: `${safeString(reason).trim() || "n/a"}; previous apply failed: ${safeString(applyResult.error).trim()}`,
        targetPath: rel,
        extension: ext,
        originalContent: original,
        retryHint: "Previous operations failed due to non-unique or missing anchor. Use deterministic replace_once/replace_all anchored to full unique Godot property lines.",
      });
      if (retryPlan.ok) {
        this._debugLog("plan:generated-retry", {
          targetPath: rel,
          operationCount: Array.isArray(retryPlan.operations) ? retryPlan.operations.length : 0,
          operations: retryPlan.operations,
          summary: retryPlan.summary || null,
        });
        finalPlan = retryPlan;
        finalApply = applyTargetedOperations(original, retryPlan.operations);
      } else {
        this._debugLog("plan:retry-failed", { targetPath: rel, reason: retryPlan.reason });
      }
    }
    if (!finalApply.ok) {
      this._debugLog("apply:failed", {
        targetPath: rel,
        error: finalApply.error,
        opIndex: finalApply.opIndex ?? null,
        opType: finalApply.opType ?? null,
        matchCount: finalApply.matchCount ?? null,
        markerCounts: finalApply.markerCounts ?? null,
        op: finalApply.op ?? null,
      });
      const detailBits = [
        safeString(finalApply.error).trim(),
        Number.isFinite(finalApply.opIndex) ? `opIndex=${finalApply.opIndex}` : null,
        safeString(finalApply.opType).trim() ? `opType=${safeString(finalApply.opType).trim()}` : null,
        Number.isFinite(finalApply.matchCount) ? `matchCount=${finalApply.matchCount}` : null,
      ].filter(Boolean);
      return {
        ok: false,
        reason: `fallback_apply_failed: ${detailBits.join("; ") || "unknown apply error"}`,
        fallback: {
          attempted: true,
          targetPath: rel,
          stage: "apply",
          operations: finalPlan.operations,
          error: finalApply.error,
          opIndex: finalApply.opIndex ?? null,
          opType: finalApply.opType ?? null,
          matchCount: finalApply.matchCount ?? null,
        },
      };
    }
    if (finalApply.content === original) {
      this._debugLog("apply:no-effect", { targetPath: rel, operations: finalPlan.operations });
      return {
        ok: false,
        reason: "fallback_apply_no_effect",
        fallback: { attempted: true, targetPath: rel, stage: "apply", operations: finalPlan.operations },
      };
    }

    const candidate = finalApply.content;
    const preValidate = await this._validateContent({
      extension: ext,
      content: candidate,
      targetPath: rel,
      projectRoot: root,
      performSceneProbe: false,
    });
    if (!preValidate.ok) {
      this._debugLog("validate:failed-pre", {
        targetPath: rel,
        reason: preValidate.reason,
        issues: preValidate.issues,
      });
      return {
        ok: false,
        reason: `fallback_validation_failed: ${preValidate.reason}`,
        fallback: {
          attempted: true,
          targetPath: rel,
          stage: "validate",
          operations: finalPlan.operations,
          validation: preValidate,
        },
      };
    }

    let method = "local_fs";
    let mcpApplyError = null;
    try {
      const mcpApply = await this._applyViaMcpWrite({
        projectRoot: root,
        relativePath: rel,
        content: candidate,
      });
      if (mcpApply.ok) {
        method = "mcp";
      } else {
        mcpApplyError = mcpApply.reason;
        await this._writeAtomic(absPath, candidate);
      }
    } catch (err) {
      this._debugLog("apply:error", { error: safeString(err?.message ?? err) });
      try {
        await this._restoreOriginal(absPath, original);
      } catch {
        // ignore secondary restore failure in error path
      }
      return {
        ok: false,
        reason: `fallback_commit_failed: ${safeString(err?.message ?? err)}`,
        fallback: { attempted: true, targetPath: rel, stage: "commit", method, error: safeString(err?.message ?? err) },
      };
    }

    let committed = "";
    try {
      committed = await fs.readFile(absPath, "utf8");
    } catch (err) {
      await this._restoreOriginal(absPath, original);
      return {
        ok: false,
        reason: `fallback_postread_failed: ${safeString(err?.message ?? err)}`,
        fallback: { attempted: true, targetPath: rel, stage: "postread", method },
      };
    }

    const postValidate = await this._validateContent({
      extension: ext,
      content: committed,
      targetPath: rel,
      projectRoot: root,
      performSceneProbe: true,
    });
    if (!postValidate.ok) {
      this._debugLog("validate:failed-post", {
        targetPath: rel,
        reason: postValidate.reason,
        issues: postValidate.issues,
      });
      await this._restoreOriginal(absPath, original);
      return {
        ok: false,
        reason: `fallback_validation_failed: ${postValidate.reason}`,
        fallback: {
          attempted: true,
          targetPath: rel,
          stage: "validate",
          method,
          operations: finalPlan.operations,
          validation: postValidate,
          restored: true,
        },
      };
    }

    this._retainSnapshot({ workflowState, snapshot });
    const fallback = {
      attempted: true,
      applied: true,
      targetPath: rel,
      method,
      operations: finalPlan.operations,
      operationCount: finalPlan.operations.length,
      summary: safeString(finalPlan.summary).trim() || null,
      validation: postValidate,
      mcpApplyError: mcpApplyError || null,
      snapshotHash: snapshot.hash,
    };
    this._debugLog("apply:success", { targetPath: rel, method, operationCount: finalPlan.operations.length });
    return {
      ok: true,
      reason: null,
      fallback,
      executionResult: {
        ok: true,
        results: [
          {
            ok: true,
            tool: "text-edit-fallback",
            args: {
              targetPath: rel,
              operationCount: finalPlan.operations.length,
              method,
            },
            rawResult: {
              fallback,
            },
            error: null,
          },
        ],
        error: null,
      },
    };
  }

  _retainSnapshot({ workflowState = null, snapshot = null } = {}) {
    if (!isPlainObject(workflowState) || !isPlainObject(snapshot)) return;
    if (!isPlainObject(workflowState.semanticState)) workflowState.semanticState = {};
    const ss = workflowState.semanticState;
    if (!isPlainObject(ss.fallbackSnapshots)) ss.fallbackSnapshots = {};
    const key = safeString(snapshot.targetPath).trim();
    if (!key) return;
    const arr = Array.isArray(ss.fallbackSnapshots[key]) ? ss.fallbackSnapshots[key] : [];
    arr.unshift(snapshot);
    ss.fallbackSnapshots[key] = arr.slice(0, this._snapshotLimit);
  }

  async _generateOperations({ userRequest, reason, targetPath, extension, originalContent, retryHint = null }) {
    if (!this._modelClient || typeof this._modelClient.generate !== "function") {
      return { ok: false, reason: "fallback_model_unavailable", operations: [] };
    }
    const prompt = [
      "You are generating SAFE targeted text edit operations.",
      "Return JSON only with keys: operations, summary.",
      "Do NOT return full file content.",
      "Allowed operation types: replace_once, replace_all, insert_before, insert_after, delete_block.",
      "Every operation must be minimally scoped and deterministic.",
      `targetPath: ${safeString(targetPath).trim()}`,
      `targetExtension: ${safeString(extension).trim()}`,
      `failureReason: ${safeString(reason).trim() || "n/a"}`,
      safeString(retryHint).trim() ? `retryHint: ${safeString(retryHint).trim()}` : null,
      `userRequest: ${safeString(userRequest).trim()}`,
      "originalContent:",
      safeString(originalContent),
    ].filter(Boolean).join("\n");
    this._debugLog("plan:model-input", {
      targetPath: safeString(targetPath).trim() || null,
      extension: safeString(extension).trim() || null,
      reason: safeString(reason).trim() || null,
      retryHint: safeString(retryHint).trim() || null,
      promptPreview: safeString(prompt).slice(0, 4000),
    });
    try {
      const raw = await this._modelClient.generate({ prompt, responseFormat: "json_object" });
      this._debugLog("plan:model-raw", {
        targetPath: safeString(targetPath).trim() || null,
        rawPreview: safeString(raw?.text ?? raw).slice(0, 2000),
      });
      const parsed = parseGeneratedJson(raw?.text ?? raw);
      if (!isPlainObject(parsed)) return { ok: false, reason: "fallback_plan_invalid_json", operations: [] };
      if (parsed.content != null || parsed.fullContent != null || parsed.file != null) {
        return { ok: false, reason: "fallback_plan_full_rewrite_rejected", operations: [] };
      }
      const operations = normalizeOperations(parsed.operations);
      if (operations.length < 1) {
        return { ok: false, reason: "fallback_plan_missing_operations", operations: [] };
      }
      const opValidation = validateNormalizedOperations(operations);
      if (!opValidation.ok) {
        this._debugLog("plan:invalid-operations", {
          targetPath: safeString(targetPath).trim() || null,
          parsedOperations: Array.isArray(parsed.operations) ? parsed.operations : parsed.operations ?? null,
          normalizedOperations: operations,
          issues: opValidation.issues,
        });
        return {
          ok: false,
          reason: `fallback_plan_invalid_operations: ${opValidation.issues.map((i) => `${i.index}:${i.reason}`).join(", ")}`,
          operations: [],
        };
      }
      return {
        ok: true,
        reason: null,
        operations,
        summary: safeString(parsed.summary).trim() || null,
      };
    } catch (err) {
      return { ok: false, reason: `fallback_plan_generate_failed: ${safeString(err?.message ?? err)}`, operations: [] };
    }
  }

  async _validateContent({ extension, content, targetPath, projectRoot, performSceneProbe = false }) {
    if (extension === ".gd") {
      const check = validateGodot4Script(content);
      return {
        ok: check.ok,
        reason: check.ok ? null : "invalid_godot4_script",
        issues: check.issues,
      };
    }
    if (extension === ".tscn") {
      const structure = validateTscnStructure(content);
      if (!structure.ok) {
        return {
          ok: false,
          reason: "invalid_tscn_structure",
          issues: structure.issues,
        };
      }
      if (performSceneProbe) {
        const probe = await this._probeSceneParse({ targetPath, projectRoot });
        if (!probe.ok) {
          return {
            ok: false,
            reason: probe.reason || "scene_parse_probe_failed",
            issues: [{ code: "parse_probe_failed", message: probe.reason || "Scene parse probe failed." }],
          };
        }
      }
      return { ok: true, reason: null, issues: [] };
    }
    return { ok: false, reason: "unsupported_target_extension", issues: [] };
  }

  async _probeSceneParse({ targetPath = null, projectRoot = null } = {}) {
    const scenePath = normalizeProjectRelativePath(targetPath);
    if (!scenePath) return { ok: false, reason: "scene_probe_missing_target" };
    const inv = this._toolInventory && typeof this._toolInventory.getInventory === "function"
      ? this._toolInventory.getInventory()
      : null;
    const tools = Array.isArray(inv?.tools) ? inv.tools : [];
    const readTool = tools.find((t) => {
      const n = safeString(t?.name).trim().toLowerCase().replace(/[^a-z0-9]/g, "");
      return n === "listscenenodes" || n === "listscenenode";
    });
    if (!readTool) return { ok: false, reason: "scene_parse_probe_unavailable" };
    const client = getSessionClient(this._sessionManager);
    if (!client) return { ok: false, reason: "scene_parse_probe_no_client" };
    const args = {
      scenePath,
      scene_path: scenePath,
      path: scenePath,
      projectPath: safeString(projectRoot).trim() || undefined,
      project_path: safeString(projectRoot).trim() || undefined,
    };
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        let raw = null;
        if (typeof client.callTool === "function") raw = await client.callTool(readTool.name, args);
        else if (typeof client.request === "function") {
          const res = await client.request({
            method: "tools/call",
            params: { name: readTool.name, arguments: args },
          });
          raw = isPlainObject(res?.result) ? res.result : res;
        } else {
          return { ok: false, reason: "scene_parse_probe_client_unsupported" };
        }
        if (isRawToolResultOk(raw)) return { ok: true, reason: null };
        const detail = extractRawFailureText(raw);
        const reason = detail
          ? `scene_parse_probe_tool_failed: ${detail}`
          : "scene_parse_probe_tool_failed";
        const mayBeTransient = /failed to load/i.test(detail);
        if (attempt < 3 && mayBeTransient) {
          await new Promise((resolve) => setTimeout(resolve, 120));
          continue;
        }
        return { ok: false, reason };
      } catch (err) {
        const reason = `scene_parse_probe_error: ${safeString(err?.message ?? err)}`;
        if (attempt < 3) {
          await new Promise((resolve) => setTimeout(resolve, 120));
          continue;
        }
        return { ok: false, reason };
      }
    }
    return { ok: false, reason: "scene_parse_probe_failed" };
  }

  async _applyViaMcpWrite({ projectRoot = null, relativePath = null, content = "" } = {}) {
    const client = getSessionClient(this._sessionManager);
    if (!client) return { ok: false, reason: "mcp_write_no_client" };
    const inv = this._toolInventory && typeof this._toolInventory.getInventory === "function"
      ? this._toolInventory.getInventory()
      : null;
    const tools = Array.isArray(inv?.tools) ? inv.tools : [];
    const candidate = tools
      .map((t) => this._scoreWritableTool(t))
      .filter((x) => x && x.score > 0)
      .sort((a, b) => b.score - a.score)[0];
    if (!candidate) return { ok: false, reason: "mcp_write_tool_not_found" };
    const args = this._buildWriteArgs({
      tool: candidate.tool,
      pathValue: relativePath,
      contentValue: content,
      projectRoot,
    });
    if (!args) return { ok: false, reason: "mcp_write_tool_contract_unsupported" };
    this._debugLog("apply:mcp-attempt", { tool: candidate.tool.name, targetPath: relativePath });
    try {
      let raw = null;
      if (typeof client.callTool === "function") raw = await client.callTool(candidate.tool.name, args);
      else if (typeof client.request === "function") {
        const res = await client.request({
          method: "tools/call",
          params: { name: candidate.tool.name, arguments: args },
        });
        raw = isPlainObject(res?.result) ? res.result : res;
      } else {
        return { ok: false, reason: "mcp_write_client_unsupported" };
      }
      if (!isRawToolResultOk(raw)) return { ok: false, reason: "mcp_write_tool_failed" };
      return { ok: true, reason: null, toolName: candidate.tool.name };
    } catch (err) {
      return { ok: false, reason: `mcp_write_error: ${safeString(err?.message ?? err)}` };
    }
  }

  _scoreWritableTool(tool = null) {
    const name = safeString(tool?.name).trim();
    if (!name) return null;
    const schema = isPlainObject(tool?.inputSchema) ? tool.inputSchema : {};
    const keys = [
      ...(Array.isArray(schema?.required) ? schema.required : []),
      ...(isPlainObject(schema?.properties) ? Object.keys(schema.properties) : []),
    ].map((k) => safeString(k).trim()).filter(Boolean);
    const lowerName = name.toLowerCase();
    const hasWriteVerb = /(write|save|edit|modify|set)/.test(lowerName);
    const hasFileWord = /(file|script|scene|text|content)/.test(lowerName);
    const pathKey = keys.find((k) => /(scenepath|scriptpath|filepath|resourcepath|path)$/i.test(k));
    const contentKey = keys.find((k) => /(content|text|body|source|code|scriptcontent|filecontent)/i.test(k));
    let score = 0;
    if (hasWriteVerb) score += 3;
    if (hasFileWord) score += 2;
    if (pathKey) score += 2;
    if (contentKey) score += 2;
    return { tool, score, pathKey, contentKey };
  }

  _buildWriteArgs({ tool = null, pathValue = "", contentValue = "", projectRoot = null } = {}) {
    const schema = isPlainObject(tool?.inputSchema) ? tool.inputSchema : {};
    const keys = [
      ...(Array.isArray(schema?.required) ? schema.required : []),
      ...(isPlainObject(schema?.properties) ? Object.keys(schema.properties) : []),
    ].map((k) => safeString(k).trim()).filter(Boolean);
    const pathKey = keys.find((k) => /(scenepath|scriptpath|filepath|resourcepath|path)$/i.test(k));
    const contentKey = keys.find((k) => /(content|text|body|source|code|scriptcontent|filecontent)/i.test(k));
    if (!pathKey || !contentKey) return null;
    const args = {
      [pathKey]: safeString(pathValue).trim(),
      [contentKey]: safeString(contentValue),
    };
    if (keys.includes("projectPath")) args.projectPath = safeString(projectRoot).trim();
    if (keys.includes("project_path")) args.project_path = safeString(projectRoot).trim();
    if (keys.includes("projectRoot")) args.projectRoot = safeString(projectRoot).trim();
    if (keys.includes("project_root")) args.project_root = safeString(projectRoot).trim();
    return args;
  }

  async _writeAtomic(absPath, content) {
    const dir = path.dirname(absPath);
    const base = path.basename(absPath);
    const tempPath = path.join(
      dir,
      `.${base}.gmcp-tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    );
    await fs.writeFile(tempPath, safeString(content), "utf8");
    await fs.rename(tempPath, absPath);
  }

  async _restoreOriginal(absPath, originalContent) {
    this._debugLog("rollback:restore", { path: absPath });
    await this._writeAtomic(absPath, safeString(originalContent));
  }
}
