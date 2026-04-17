/**
 * GenericMcpHttpServer
 * -----------------------------------------------------------------------------
 * Thin HTTP transport wrapper for the Generic MCP sidecar.
 *
 * Handles:
 * - route dispatch
 * - body parsing/size enforcement
 * - content-type checks
 * - error-to-http mapping
 */

import http from "node:http";

function safeString(value) {
  return value == null ? "" : String(value);
}

function isJsonContentType(contentType) {
  const v = safeString(contentType).toLowerCase();
  return v.includes("application/json") || v === "";
}

async function readRequestBody(req, { maxBodyBytes }) {
  let total = 0;
  const chunks = [];
  for await (const chunk of req) {
    const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += part.length;
    if (total > maxBodyBytes) {
      const err = new Error(`Request body too large (max ${maxBodyBytes} bytes).`);
      err.httpStatus = 413;
      err.code = "payload_too_large";
      throw err;
    }
    chunks.push(part);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parseJsonBody(rawText) {
  const text = safeString(rawText).trim();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch (err) {
    const e = new Error(`Invalid JSON body: ${safeString(err?.message)}`);
    e.httpStatus = 400;
    e.code = "invalid_json";
    throw e;
  }
}

export class GenericMcpHttpServer {
  constructor({
    adapter,
    host = "127.0.0.1",
    port = 4318,
    maxBodyBytes = 1024 * 1024,
    debug = false,
  } = {}) {
    if (!adapter) throw new Error("GenericMcpHttpServer requires adapter.");
    this._adapter = adapter;
    this._host = host;
    this._port = Number(port) || 4318;
    this._maxBodyBytes = Number(maxBodyBytes) || 1024 * 1024;
    this._debug = Boolean(debug);
    this._server = null;
  }

  async start() {
    if (this._server) return this.getAddress();
    this._server = http.createServer((req, res) => {
      this._handleRequest(req, res).catch((error) => {
        const fallback = this._adapter.toErrorResponse?.(error) ?? {
          httpStatus: Number(error?.httpStatus) || 500,
          body: {
            ok: false,
            status: "error",
            code: safeString(error?.code).trim() || "internal_error",
            error: safeString(error?.message).trim() || "Unknown error",
          },
        };
        this._sendJson(res, fallback.httpStatus, fallback.body);
      });
    });

    await new Promise((resolve, reject) => {
      this._server.once("error", reject);
      this._server.listen(this._port, this._host, resolve);
    });

    if (this._debug) {
      console.error("[generic-mcp][http] server started", this.getAddress());
    }
    return this.getAddress();
  }

  async stop() {
    if (!this._server) return;
    const srv = this._server;
    this._server = null;
    await new Promise((resolve, reject) => {
      srv.close((err) => (err ? reject(err) : resolve()));
    });
  }

  getAddress() {
    if (!this._server) return null;
    const addr = this._server.address();
    if (addr == null || typeof addr === "string") return null;
    return {
      host: addr.address,
      port: addr.port,
      family: addr.family,
    };
  }

  async _handleRequest(req, res) {
    const method = safeString(req.method).toUpperCase();
    const url = new URL(req.url || "/", "http://localhost");
    const pathname = url.pathname;

    if (method === "OPTIONS") {
      this._sendEmpty(res, 204);
      return;
    }

    if (method === "GET" && pathname === "/health") {
      const response = this._adapter.handleHealth();
      this._sendJson(res, response.httpStatus, response.body);
      return;
    }
    if (method === "GET" && pathname === "/ready") {
      const projectPath = safeString(url.searchParams.get("projectPath")).trim() || null;
      const response = await this._adapter.handleReady({ projectPath });
      this._sendJson(res, response.httpStatus, response.body);
      return;
    }

    if (method === "POST" && (pathname === "/run" || pathname === "/runlocal")) {
      const contentType = req.headers["content-type"] || "";
      if (!isJsonContentType(contentType)) {
        this._sendJson(res, 415, {
          ok: false,
          status: "error",
          code: "unsupported_content_type",
          error: "Content-Type must be application/json.",
        });
        return;
      }
      const rawBody = await readRequestBody(req, { maxBodyBytes: this._maxBodyBytes });
      const body = parseJsonBody(rawBody);

      const result = await this._adapter.handleRun(body, {
        runMode: pathname === "/run" ? "online" : "local",
      });
      this._sendJson(res, result.httpStatus, result.body);
      return;
    }

    this._sendJson(res, 404, {
      ok: false,
      status: "error",
      code: "route_not_found",
      error: `Route not found: ${method} ${pathname}`,
    });
  }

  _sendEmpty(res, statusCode) {
    res.writeHead(statusCode, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Content-Length": "0",
    });
    res.end();
  }

  _sendJson(res, statusCode, body) {
    const payload = JSON.stringify(body ?? {});
    res.writeHead(statusCode, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": Buffer.byteLength(payload, "utf8"),
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    res.end(payload);
  }
}
