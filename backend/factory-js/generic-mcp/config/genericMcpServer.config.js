import path from "node:path";
import { fileURLToPath } from "node:url";

function safeString(value) {
  return value == null ? "" : String(value);
}

function getArg(argv, name) {
  const i = argv.indexOf(name);
  if (i < 0) return null;
  return argv[i + 1] ?? null;
}

function hasArg(argv, name) {
  return argv.includes(name);
}

function toInt(value, fallback, { min = null, max = null } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  if (min != null && i < min) return fallback;
  if (max != null && i > max) return fallback;
  return i;
}

function parseBool(value, fallback = false) {
  const v = safeString(value).trim().toLowerCase();
  if (!v) return fallback;
  if ([ "1", "true", "yes", "on" ].includes(v)) return true;
  if ([ "0", "false", "no", "off" ].includes(v)) return false;
  return fallback;
}

function resolveClientModulePath({ argv, env }) {
  const cliPath = safeString(getArg(argv, "--client-module")).trim();
  const envPath = safeString(env.GENERIC_MCP_CLIENT_MODULE).trim();
  if (cliPath) return path.resolve(cliPath);
  if (envPath) return path.resolve(envPath);

  const configDir = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(configDir, "..", "adapters", "stdio-mcp-client.js");
}

export function buildGenericMcpServerConfig({ argv = [], env = process.env } = {}) {
  const host =
    safeString(getArg(argv, "--host")).trim() ||
    safeString(env.GENERIC_MCP_HTTP_HOST).trim() ||
    "127.0.0.1";

  const port = toInt(
    getArg(argv, "--port") ?? env.GENERIC_MCP_HTTP_PORT,
    4318,
    { min: 1, max: 65535 }
  );

  const maxBodyBytes = toInt(
    getArg(argv, "--max-body-bytes") ?? env.GENERIC_MCP_HTTP_MAX_BODY_BYTES,
    1024 * 1024,
    { min: 1024, max: 10 * 1024 * 1024 }
  );

  const maxSessions = toInt(
    getArg(argv, "--max-sessions") ?? env.GENERIC_MCP_HTTP_MAX_SESSIONS,
    200,
    { min: 1, max: 5000 }
  );

  const defaultProjectPathRaw =
    safeString(getArg(argv, "--default-project-path")).trim() ||
    safeString(env.GENERIC_MCP_DEFAULT_PROJECT_PATH).trim() ||
    "";

  const debug =
    hasArg(argv, "--debug") ||
    parseBool(env.GENERIC_MCP_HTTP_DEBUG, false);
  const disableContentSynthesis =
    hasArg(argv, "--enable-content-synthesis")
      ? false
      : hasArg(argv, "--disable-content-synthesis")
        ? true
        : parseBool(env.GENERIC_MCP_DISABLE_CONTENT_SYNTHESIS, true);
  const autoInitializeOnStart =
    hasArg(argv, "--no-auto-init")
      ? false
      : hasArg(argv, "--auto-init")
        ? true
        : parseBool(env.GENERIC_MCP_AUTO_INIT_ON_START, true);

  const modelTimeoutMs = toInt(
    getArg(argv, "--model-timeout-ms") ?? env.GENERIC_MCP_MODEL_TIMEOUT_MS,
    120000,
    { min: 1000, max: 600000 }
  );
  const onlineModelTimeoutMs = toInt(
    getArg(argv, "--online-model-timeout-ms") ??
      env.GENERIC_MCP_ONLINE_MODEL_TIMEOUT_MS ??
      modelTimeoutMs,
    modelTimeoutMs,
    { min: 1000, max: 600000 }
  );

  return {
    host,
    port,
    maxBodyBytes,
    maxSessions,
    debug,
    disableContentSynthesis,
    autoInitializeOnStart,
    clientModulePath: resolveClientModulePath({ argv, env }),
    defaultProjectPath: defaultProjectPathRaw ? path.resolve(defaultProjectPathRaw) : null,
    mcpConfigPath: safeString(getArg(argv, "--mcp-config-path")).trim() || null,
    mcpConfigJson: safeString(getArg(argv, "--mcp-config-json")).trim() || null,
    model: {
      backend: safeString(getArg(argv, "--model-backend")).trim() || safeString(env.GENERIC_MCP_MODEL_BACKEND).trim() || undefined,
      model: safeString(getArg(argv, "--model-name")).trim() || safeString(env.GENERIC_MCP_MODEL_NAME).trim() || undefined,
      baseUrl: safeString(getArg(argv, "--model-base-url")).trim() || safeString(env.GENERIC_MCP_MODEL_BASE_URL).trim() || undefined,
      apiKey: safeString(getArg(argv, "--model-api-key")).trim() || safeString(env.GENERIC_MCP_MODEL_API_KEY).trim() || undefined,
      timeoutMs: modelTimeoutMs,
      debug,
    },
    onlineModel: {
      backend: "openai",
      model:
        safeString(getArg(argv, "--online-model-name")).trim() ||
        safeString(env.GENERIC_MCP_ONLINE_MODEL_NAME).trim() ||
        "gpt-4o",
      baseUrl:
        safeString(getArg(argv, "--online-model-base-url")).trim() ||
        safeString(env.GENERIC_MCP_ONLINE_MODEL_BASE_URL).trim() ||
        "https://api.openai.com",
      apiKey:
        safeString(getArg(argv, "--online-model-api-key")).trim() ||
        safeString(env.GENERIC_MCP_ONLINE_MODEL_API_KEY).trim() ||
        safeString(env.OPENAI_API_KEY).trim() ||
        undefined,
      timeoutMs: onlineModelTimeoutMs,
      debug,
    },
  };
}

export function genericMcpServerUsage() {
  return [
    "Usage:",
    "  node backend/factory-js/generic-mcp/run-generic-mcp-server.js [options]",
    "",
    "Options:",
    "  --host <host>                  Bind host (default: 127.0.0.1)",
    "  --port <port>                  Bind port (default: 4318)",
    "  --max-body-bytes <bytes>       Max JSON body size (default: 1048576)",
    "  --max-sessions <count>         Max in-memory sidecar sessions (default: 200)",
    "  --client-module <path>         MCP stdio client module exporting createClient(...)",
    "  --mcp-config-path <path>       MCP config file path override",
    "  --mcp-config-json <json>       Inline MCP config JSON override",
    "  --default-project-path <path>  Fallback project path if request omits projectPath",
    "  --model-backend <name>         Live model backend override",
    "  --model-name <name>            Live model name override",
    "  --model-base-url <url>         Live model base URL override",
    "  --model-api-key <key>          Live model API key override",
    "  --model-timeout-ms <ms>        Live model timeout override",
    "  --online-model-name <name>     /run online model name override (default: gpt-4o)",
    "  --online-model-base-url <url>  /run online model base URL override (default: https://api.openai.com)",
    "  --online-model-api-key <key>   /run online model API key override",
    "  --online-model-timeout-ms <ms> /run online model timeout override",
    "  --auto-init                    Auto-start MCP bridge readiness gate on sidecar boot (default: on)",
    "  --no-auto-init                 Disable startup auto-init gate",
    "  --debug                        Enable debug logging",
    "  --enable-content-synthesis     Enable legacy content synthesis plumbing (default: disabled)",
    "  --disable-content-synthesis    Disable content synthesis plumbing",
    "  --help                         Show help",
    "",
    "Routes:",
    "  GET  /health",
    "  GET  /ready   (optional query: ?projectPath=/abs/path)",
    "  POST /run      { input, projectPath?, sessionId? }",
    "  POST /runlocal { input, projectPath?, sessionId? }",
  ].join("\n");
}
