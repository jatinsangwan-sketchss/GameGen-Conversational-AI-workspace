/**
 * McpConfigLoader
 * -----------------------------------------------------------------------------
 * Thin orchestration helper for loading MCP transport config for the isolated
 * Generic MCP pipeline.
 *
 * This loader does not contain tool semantics; it only resolves configuration
 * input sources in a deterministic order.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

function safeString(value) {
  return value == null ? "" : String(value);
}

function isPlainObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

const DEFAULT_CONFIG_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "mcp.config.json"
);

function normalizeMcpConfigObject(raw) {
  if (!isPlainObject(raw)) return null;
  // Prefer explicit generic_mcp block if present; otherwise support common
  // "godot" section shape for current local MCP config files.
  const src =
    (isPlainObject(raw.generic_mcp) && raw.generic_mcp) ||
    (isPlainObject(raw.godot) && raw.godot) ||
    raw;

  const command = safeString(src.command).trim();
  const args = Array.isArray(src.args) ? src.args.map((a) => String(a)) : [];
  if (!command) return null;
  return {
    command,
    args,
    env: isPlainObject(src.env) ? src.env : {},
    workingDirectory: safeString(src.working_directory ?? src.workingDirectory).trim() || undefined,
    timeoutMs: Number.isFinite(Number(src.timeout_ms ?? src.timeoutMs)) ? Number(src.timeout_ms ?? src.timeoutMs) : undefined,
    protocolVersion: safeString(src.protocol_version ?? src.protocolVersion).trim() || undefined,
    serverName: safeString(src.server_name ?? src.serverName).trim() || undefined,
    serverVersion: safeString(src.server_version ?? src.serverVersion).trim() || undefined,
    clientName: safeString(src.client_name ?? src.clientName).trim() || undefined,
    clientVersion: safeString(src.client_version ?? src.clientVersion).trim() || undefined,
  };
}

async function readJsonFile(absPath) {
  const text = await fs.readFile(absPath, "utf-8");
  return JSON.parse(text);
}

export class McpConfigLoader {
  constructor({ defaultConfigPath = DEFAULT_CONFIG_PATH } = {}) {
    this.defaultConfigPath = path.resolve(defaultConfigPath);
  }

  async load({ mcpConfigJson = null, mcpConfigPath = null } = {}) {
    const attempts = [];

    // 1) explicit --mcp-config-json override
    if (safeString(mcpConfigJson).trim()) {
      attempts.push({ source: "cli_json", detail: "--mcp-config-json" });
      try {
        const parsed = JSON.parse(String(mcpConfigJson));
        const normalized = normalizeMcpConfigObject(parsed);
        if (!normalized) throw new Error("JSON override missing required MCP fields (command).");
        return { ok: true, mcpConfig: normalized, source: "cli_json", attempts, defaultConfigPath: this.defaultConfigPath };
      } catch (err) {
        return {
          ok: false,
          error: `Failed to parse --mcp-config-json: ${safeString(err?.message ?? err)}`,
          attempts,
          defaultConfigPath: this.defaultConfigPath,
        };
      }
    }

    // 2) explicit --mcp-config-path override
    if (safeString(mcpConfigPath).trim()) {
      const abs = path.resolve(String(mcpConfigPath));
      attempts.push({ source: "cli_path", detail: abs });
      try {
        const parsed = await readJsonFile(abs);
        const normalized = normalizeMcpConfigObject(parsed);
        if (!normalized) throw new Error("Config file missing required MCP fields (command).");
        return { ok: true, mcpConfig: normalized, source: "cli_path", attempts, defaultConfigPath: this.defaultConfigPath };
      } catch (err) {
        return {
          ok: false,
          error: `Failed to load --mcp-config-path (${abs}): ${safeString(err?.message ?? err)}`,
          attempts,
          defaultConfigPath: this.defaultConfigPath,
        };
      }
    }

    // 3) default deterministic config path
    attempts.push({ source: "default_path", detail: this.defaultConfigPath });
    try {
      const parsed = await readJsonFile(this.defaultConfigPath);
      const normalized = normalizeMcpConfigObject(parsed);
      if (!normalized) throw new Error("Default config missing required MCP fields (command).");
      return { ok: true, mcpConfig: normalized, source: "default_path", attempts, defaultConfigPath: this.defaultConfigPath };
    } catch (err) {
      // 4) fail clearly
      return {
        ok: false,
        error: `Failed to load MCP config from default path: ${safeString(err?.message ?? err)}`,
        attempts,
        defaultConfigPath: this.defaultConfigPath,
      };
    }
  }
}

export { DEFAULT_CONFIG_PATH };

