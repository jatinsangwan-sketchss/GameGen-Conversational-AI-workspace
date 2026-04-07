# Generic MCP Workspace

This directory is the new isolated Generic MCP workspace.

The old edit-mode and factory runtime paths are intentionally untouched.

No source-of-truth or curated factory logic belongs here yet.

Session and stdio transport: MCP `initialize` is retried separately from bridge/project readiness polling (configurable attempts and delays via `SessionManager` options and `mcp.config.json` fields such as `initializeMaxAttempts` / `bridgeMaxAttempts`).

With `debug: true` on `SessionManager` or `mcpConfig`, logs include phased transport/bridge diagnostics (spawn, initialize RPC, probe response, path comparison). Session `getStatus()` exposes `failedPhase`, `lastTransportError`, `lastInitializeError`, `lastBridgeProbeError`, and `lastProjectMatchDiagnostic` for structured failure analysis.

The stdio MCP adapter implements `probeBridge({ desiredProjectRoot })` using **log-derived** Godot bridge signals (stderr/stdout) as the primary readiness source; optional `mcpConfig.bridgeHealthDiagnostics: true` runs a health-style tool for secondary diagnostics only. `SessionManager` prefers `probeBridge` over an injected `bridgeProbe` callback when present. Project roots are compared as canonical absolute real paths.

Live model (Ollama): default model name is `gpt-oss:20b` (colon). Override with `--model-name` or `GENERIC_MCP_MODEL_NAME`. With `--debug`, the CLI prints `[generic-mcp][model] backend=… model=… baseUrl=…` before each generate call.

Argument resolution: existing resource paths are resolved via the project file index; **new** paths for create/new operations are synthesized generically from planner intent (`requestedName`, `targetFolder`, `resourceKind`, …) when a required `scenePath` / `filePath` / `resourcePath`-style arg is missing — see `PathSynthesizer.js` and `ArgumentResolver`.

**Interactive runner** (persistent session + cached tool inventory): startup loads config, connects MCP, waits for bridge/project readiness, then loads the tool inventory — only then does the `generic-mcp>` prompt appear. On failure, a minimal recovery shell offers `retry`, `status`, `exit` only. Built-ins when connected: `help`, `status`, `reload-tools`, `debug on|off`, `exit`.


node ./factory-js/generic-mcp/run-interactive-generic-mcp.js \
  --project-root "./artifacts/Typing/run_001/project" \
  --client-module "./factory-js/generic-mcp/adapters/stdio-mcp-client.js"

## Local HTTP sidecar (Phase 6)

Run the isolated sidecar server (no edits to base backend/frontend required):

```bash
node ./factory-js/generic-mcp/run-generic-mcp-server.js \
  --client-module "./factory-js/generic-mcp/adapters/stdio-mcp-client.js"
```
Startup auto-init is enabled by default: sidecar immediately begins MCP initialize + bridge readiness attempts on boot. Use `--no-auto-init` to disable.

Routes:
- `GET /health`
- `GET /ready` (optional query: `?projectPath=/absolute/project/path`)
- `POST /run` (online OpenAI path, default model `gpt-4o`)
- `POST /runlocal`
- `POST /resume`

Example payloads:
`POST /run`
```json
{
  "input": "create a gdscript called Logs and attach it to root node of NewScene.tscn. This script should print Hello world in the console",
  "projectPath": "/absolute/project/path (optional)",
  "sessionId": "optional",
  "responseMode": "compact (default) | full (optional)"
}
```

`POST /runlocal`
```json
{
  "input": "create a gdscript called Logs and attach it to root node of NewScene.tscn. This script should print Hello world in the console",
  "projectPath": "/absolute/project/path (optional)",
  "sessionId": "optional",
  "responseMode": "compact (default) | full (optional)"
}
```

`POST /run` uses sidecar `onlineModel` config (`backend: openai`) and reads API key from environment variables such as `GENERIC_MCP_ONLINE_MODEL_API_KEY` or `OPENAI_API_KEY`. Sidecar startup loads dotenv (`.env` from cwd plus `backend/.env`) so key-only `.env` setups work when launching from workspace root.  
`POST /runlocal` continues to use the existing local model config (`model` block / local backend).

`POST /resume`
```json
{
  "sessionId": "required",
  "input": "res://NewScene.tscn",
  "responseMode": "compact (default) | full (optional)"
}
```

The sidecar stores `needs_input` continuation state in memory per `sessionId` and forwards it back into `GenericMcpRunner` on `/resume`.
If `projectPath` is omitted, sidecar resolves it from the active MCP-connected project path (or from configured `--default-project-path` when available).

`responseMode: "compact"` returns a concise payload focused on status, reason, question/pause metadata, and compact queue/task summaries (without large repeated `planning/resolved/execution/runtime/workflow` trees). Use `responseMode: "full"` when you need the complete runner payload for deep debugging.
