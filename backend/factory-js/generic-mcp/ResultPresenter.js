/**
 * ResultPresenter
 * -----------------------------------------------------------------------------
 * Presentation-only adapter for Generic MCP execution results.
 *
 * Responsibilities:
 * - summarize successful read-only and mutation tool results
 * - preserve raw failure visibility for debugging
 * - lightly unwrap common MCP response wrappers (e.g. content[].text JSON)
 *
 * Out of scope:
 * - planning
 * - execution
 * - semantic/curated guarantees not present in executor output
 */

function safeString(value) {
  return value == null ? "" : String(value);
}

function isPlainObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function truncate(text, maxLen = 220) {
  const s = safeString(text);
  return s.length > maxLen ? `${s.slice(0, maxLen)}...` : s;
}

function formatInline(value, maxLen = 220) {
  if (value == null) return "null";
  if (typeof value === "string") return truncate(value, maxLen);
  try {
    return truncate(JSON.parse(value), maxLen);
  } catch {
    return truncate(String(value), maxLen);
  }
}

function normalizeKey(value) {
  return safeString(value).toLowerCase().replace(/[^a-z0-9]/g, "");
}

export class ResultPresenter {
  constructor({ debug = false } = {}) {
    this._debug = Boolean(debug) || safeString(process.env.DEBUG_GENERIC_MCP_PRESENTER).toLowerCase() === "true";
  }

  present(executionResult) {
    const exec = isPlainObject(executionResult) ? executionResult : {};
    const results = Array.isArray(exec.results) ? exec.results : [];
    const lines = [];

    if (results.length === 0) {
      lines.push("No tool results.");
      return lines.join("\n");
    }

    for (const result of results) {
      const block = this.presentToolResult(result);
      lines.push(...block, "");
    }

    if (lines[lines.length - 1] === "") lines.pop();
    return lines.join("\n");
  }

  presentToolResult(toolResult) {
    const r = isPlainObject(toolResult) ? toolResult : {};
    const tool = safeString(r.tool).trim() || "unknown_tool";
    const ok = r.ok !== false;
    const lines = [];

    lines.push(`Tool: ${tool}`);
    if (!ok) {
      lines.push(...this.summarizeFailure(r));
      return lines;
    }

    lines.push(...this.summarizeSuccess(r));
    return lines;
  }

  unwrapTextJson(rawResult) {
    const raw = isPlainObject(rawResult) ? rawResult : null;
    if (!raw) return { unwrapped: rawResult, parsedCandidates: [] };

    const content = Array.isArray(raw.content) ? raw.content : [];
    const parsedCandidates = [];
    for (const item of content) {
      const text = safeString(item?.text).trim();
      if (!text) continue;
      try {
        parsedCandidates.push(JSON.parse(text));
      } catch {
        // Keep unwrapping light and non-fatal.
      }
    }
    return {
      unwrapped: parsedCandidates[0] ?? raw,
      parsedCandidates,
    };
  }

  summarizeSuccess(toolResult) {
    const tool = safeString(toolResult?.tool).trim();
    const args = isPlainObject(toolResult?.args) ? toolResult.args : {};
    const raw = toolResult?.rawResult;
    const { unwrapped } = this.unwrapTextJson(raw);
    const data = isPlainObject(unwrapped) ? unwrapped : {};
    const key = normalizeKey(tool);
    const lines = [];

    // Presentation should be helpful but honest. If a sparse payload is all we
    // have (including {}), we show it directly instead of inventing semantics.
    if (key.includes("getprojectsetting")) {
      const settingPath = data.setting ?? data.setting_path ?? data.path ?? args.setting ?? args.setting_key ?? "unknown";
      const exists = data.exists ?? data.found ?? null;
      const value = Object.prototype.hasOwnProperty.call(data, "value") ? data.value : (data.setting_value ?? data.result ?? data);
      lines.push("Status: success");
      lines.push(`Setting: ${formatInline(settingPath)}`);
      if (exists != null) lines.push(`Exists: ${Boolean(exists)}`);
      lines.push(`Value: ${formatInline(value)}`);
      return lines;
    }

    if (key.includes("getnodeproperties")) {
      const nodePath = args.nodePath ?? args.node_path ?? data.nodePath ?? data.node_path ?? "unknown";
      const props =
        (isPlainObject(data.properties) && data.properties) ||
        (isPlainObject(data.node_properties) && data.node_properties) ||
        (isPlainObject(data.value) && data.value) ||
        {};
      lines.push("Status: success");
      lines.push(`Node: ${formatInline(nodePath)}`);
      lines.push(`Properties: ${formatInline(props, 600)}`);
      return lines;
    }

    if (key.includes("listscenenodes")) {
      const nodes =
        (Array.isArray(data.nodes) && data.nodes) ||
        (Array.isArray(data.scene_nodes) && data.scene_nodes) ||
        [];
      lines.push("Status: success");
      if (nodes.length > 0) {
        lines.push(`Node count: ${nodes.length}`);
        for (const n of nodes.slice(0, 8)) {
          const name = n?.name ?? n?.node_name ?? "?";
          const path = n?.path ?? n?.node_path ?? "?";
          const type = n?.type ?? n?.node_type ?? "?";
          lines.push(`- ${name} | path=${path} | type=${type}`);
        }
      } else {
        lines.push(`Scene data: ${formatInline(data, 600)}`);
      }
      return lines;
    }

    if (key.includes("getuid")) {
      const uid = data.uid ?? data.value ?? data.result ?? data;
      lines.push("Status: success");
      lines.push(`UID: ${formatInline(uid)}`);
      return lines;
    }

    if (key.includes("searchproject")) {
      const matches = data.matches ?? data.results ?? data.items ?? data.files ?? [];
      lines.push("Status: success");
      if (Array.isArray(matches)) {
        lines.push(`Matches: ${matches.length}`);
        for (const m of matches.slice(0, 8)) lines.push(`- ${formatInline(m, 180)}`);
      } else {
        lines.push(`Result: ${formatInline(data, 600)}`);
      }
      return lines;
    }

    const looksMutation = key.includes("set") || key.includes("add") || key.includes("save") || key.includes("create") || key.includes("delete");
    if (looksMutation) {
      lines.push("Status: success");
      if (safeString(toolResult?.outcome).trim() === "already_satisfied") {
        lines.push("Note: Target state already existed; no new mutation was required.");
      }
      lines.push(`Args: ${formatInline(args, 400)}`);
      if (this._debug) lines.push(`Raw: ${formatInline(raw, 700)}`);
      return lines;
    }

    lines.push("Status: success");
    lines.push(`Result: ${formatInline(data, 700)}`);
    return lines;
  }

  summarizeFailure(toolResult) {
    const tool = safeString(toolResult?.tool).trim() || "unknown_tool";
    const raw = toolResult?.rawResult;
    const reason = safeString(toolResult?.error).trim() || "MCP tool reported failure.";
    const body = this.extractFailureBody(raw);

    const lines = [];
    lines.push("Status: failed");
    lines.push(`Reason: ${reason}`);
    if (body) lines.push(`Raw failure body: ${formatInline(body, 900)}`);
    else lines.push("Raw failure body: (none)");
    lines.push(`Tool: ${tool}`);
    return lines;
  }

  extractFailureBody(rawResult) {
    if (rawResult == null) return null;
    if (!isPlainObject(rawResult)) return rawResult;
    if (rawResult.error != null) return rawResult.error;

    const content = Array.isArray(rawResult.content) ? rawResult.content : [];
    const texts = content.map((c) => safeString(c?.text).trim()).filter(Boolean);
    if (texts.length > 0) return texts.join("\n");
    return rawResult;
  }
}
