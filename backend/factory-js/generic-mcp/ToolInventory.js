/**
 * ToolInventory
 * -----------------------------------------------------------------------------
 * Discovers MCP tools from an active session and normalizes them into one
 * stable in-memory inventory object.
 *
 * Scope:
 * - tools/list discovery (with pagination)
 * - normalized inventory cache
 * - exact-name lookup helpers
 *
 * Out of scope:
 * - request planning
 * - tool execution
 * - tool-specific behavior
 */
import { buildPlannerCatalog } from "./PlannerCatalogBuilder.js";
import { describeClientAvailability, getSessionClient } from "./utils/session-client.js";

function safeString(value) {
  return value == null ? "" : String(value);
}

function isPlainObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeTool(tool) {
  const raw = isPlainObject(tool) ? tool : {};
  const name = safeString(raw.name).trim();
  const description = safeString(raw.description).trim() || null;
  const inputSchema =
    (isPlainObject(raw.inputSchema) && raw.inputSchema) ||
    (isPlainObject(raw.input_schema) && raw.input_schema) ||
    {};
  return { name, description, inputSchema };
}

function extractPageItems(response) {
  if (!response) return [];
  const top = isPlainObject(response) ? response : {};
  const candidates = [
    top.tools,
    top.items,
    top.data?.tools,
    top.data?.items,
    top.result?.tools,
    top.result?.items,
  ];
  for (const c of candidates) {
    if (Array.isArray(c)) return c;
  }
  return [];
}

function extractNextCursor(response) {
  if (!response || typeof response !== "object") return null;
  const top = response;
  return (
    top.nextCursor ??
    top.next_cursor ??
    top.cursor?.next ??
    top.pagination?.nextCursor ??
    top.pagination?.next_cursor ??
    top.meta?.nextCursor ??
    null
  );
}

export class ToolInventory {
  constructor({ sessionManager, pageSize = 100 } = {}) {
    this._sessionManager = sessionManager ?? null;
    this._pageSize = Number.isFinite(Number(pageSize)) && Number(pageSize) > 0 ? Number(pageSize) : 100;
    this._inventory = {
      toolCount: 0,
      tools: [],
      fetchedAt: null,
      pageCount: 0,
    };
    this._error = null;
    this._plannerCatalog = [];
  }

  async load() {
    if (this._inventory.toolCount > 0 || this._inventory.fetchedAt != null) {
      return { ok: true, inventory: this.getInventory(), cached: true };
    }
    return this.refresh();
  }

  async refresh() {
    try {
      const client = await this._resolveClient();
      const pages = await this._fetchAllPages(client);
      const rawTools = pages.flatMap((p) => extractPageItems(p));
      const normalized = rawTools
        .map(normalizeTool)
        .filter((t) => t.name.length > 0);

      const deduped = [];
      const seen = new Set();
      for (const tool of normalized) {
        if (seen.has(tool.name)) continue;
        seen.add(tool.name);
        deduped.push(tool);
      }

      this._inventory = {
        toolCount: deduped.length,
        tools: deduped,
        fetchedAt: new Date().toISOString(),
        pageCount: pages.length,
      };
      this._plannerCatalog = buildPlannerCatalog(deduped);
      this._error = null;
      return { ok: true, inventory: this.getInventory(), cached: false };
    } catch (err) {
      this._error = safeString(err?.message ?? err) || "Tool discovery failed.";
      return {
        ok: false,
        error: this._error,
        inventory: this.getInventory(),
      };
    }
  }

  getInventory() {
    return {
      toolCount: this._inventory.toolCount,
      tools: [...this._inventory.tools],
      fetchedAt: this._inventory.fetchedAt,
      pageCount: this._inventory.pageCount,
      lastError: this._error,
    };
  }

  getPlannerCatalog() {
    return [...this._plannerCatalog];
  }

  getTool(name) {
    const needle = safeString(name).trim();
    if (!needle) return null;
    return this._inventory.tools.find((t) => t.name === needle) ?? null;
  }

  hasTool(name) {
    return this.getTool(name) != null;
  }

  async _resolveClient() {
    if (!this._sessionManager) {
      throw new Error("ToolInventory requires sessionManager.");
    }
    if (typeof this._sessionManager.ensureReady === "function") {
      await this._sessionManager.ensureReady(null);
    } else if (typeof this._sessionManager.initialize === "function") {
      await this._sessionManager.initialize(null);
    }

    // Keep this generic: accept any session manager that can expose a client.
    const client = getSessionClient(this._sessionManager);

    if (!client) {
      throw new Error(
        `No active MCP client available from SessionManager (${describeClientAvailability(this._sessionManager)}).`
      );
    }
    return client;
  }

  async _fetchAllPages(client) {
    const pages = [];
    let cursor = null;
    let guard = 0;
    const maxPages = 200;

    do {
      const page = await this._fetchPage(client, { cursor, pageSize: this._pageSize });
      pages.push(page);
      cursor = extractNextCursor(page);
      guard += 1;
      if (guard >= maxPages) {
        throw new Error(`tools/list pagination exceeded guard limit (${maxPages}).`);
      }
    } while (cursor);

    return pages;
  }

  async _fetchPage(client, { cursor = null, pageSize = 100 } = {}) {
    const pagination = { cursor, limit: pageSize };

    if (typeof client.listTools === "function") {
      const res = await client.listTools({ cursor, limit: pageSize, pageSize });
      return isPlainObject(res) ? res : { tools: toArray(res) };
    }

    if (typeof client.toolsList === "function") {
      const res = await client.toolsList({ cursor, limit: pageSize, pageSize });
      return isPlainObject(res) ? res : { tools: toArray(res) };
    }

    if (typeof client.request === "function") {
      const res = await client.request({
        method: "tools/list",
        params: { pagination },
      });
      if (isPlainObject(res?.result)) return res.result;
      if (isPlainObject(res)) return res;
      throw new Error("tools/list request returned unsupported response shape.");
    }

    throw new Error("Active MCP client does not support tools/list discovery methods.");
  }
}
