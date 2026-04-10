# GenericMCP Workflow and API Guide

This document explains how GenericMCP sidecar API mode works, all HTTP endpoints, and commands to run it.

## 1) GenericMCP Workflow (API Mode)

Request lifecycle:

1. `run-generic-mcp-server.js` boots the HTTP sidecar.
2. Sidecar loads MCP config via `McpConfigLoader`:
   - `--mcp-config-json` (highest priority)
   - `--mcp-config-path`
   - default `backend/factory-js/mcp.config.json`
3. Sidecar creates shared runtime modules:
   - `SessionManager`
   - `ToolInventory`
   - `GenericMcpRunner` (local + online planner variants)
   - in-memory `GenericMcpSessionStore`
4. Client sends `POST /run` or `POST /runlocal`.
5. Adapter resolves/creates a `sessionId`, picks run mode:
   - `/run` => `online`
   - `/runlocal` => `local`
6. Runner executes pipeline:
   - session readiness (`initialize` + bridge readiness)
   - live tool inventory
   - tool planning
   - argument resolution
   - tool execution
   - result presentation
7. If result is `needs_input` or queue pause, continuation state is stored in `GenericMcpSessionStore`.
8. Client sends `POST /resume` with `sessionId` + new input to continue.

## 2) Endpoints

Base defaults: `http://127.0.0.1:4318`

## `GET /health`

Purpose:
- Sidecar liveness and summarized readiness/session state.

Response:
- `200 OK`
- includes:
  - `ok`
  - `status` (`healthy` | `degraded` | `starting`)
  - `ready`
  - `uptimeSeconds`
  - `mcp` readiness snapshot
  - `sessions` summary

## `GET /ready?projectPath=/abs/path` (projectPath optional)

Purpose:
- strict readiness check for MCP + bridge + project match.

Behavior:
- calls `sessionManager.ensureReady(expectedProjectPath)` when available.

Response:
- `200 OK` when ready
- `503 Service Unavailable` when not ready
- body includes:
  - `ok`
  - `status` (`ready` | `not_ready`)
  - `ready`
  - `mcp` snapshot
  - optional `error`

## `POST /run`

Purpose:
- execute request using **online** model runner.

Required JSON fields:
- `input` (string)

Optional fields:
- `projectPath`
- `sessionId` (reuse existing session)
- `responseMode` (`compact` default, or `full`)

Response:
- `200 OK` for handled run result payload
- includes `sessionId`, `runMode: "online"`, run status fields

## `POST /runlocal`

Purpose:
- execute request using **local** model runner.

Request/response shape:
- same as `/run`
- `runMode: "local"`

## `POST /resume`

Purpose:
- continue a previously paused/needs-input session.

Required JSON fields:
- `sessionId`
- `input`

Optional fields:
- `projectPath`
- `responseMode` (`compact` default, or `full`)

Error cases:
- `404` `session_not_found` if session does not exist
- `409` `resume_without_pending_state` if no pending needs-input state

## Also handled at HTTP layer

- `OPTIONS *` => `204` (CORS preflight)
- Unsupported content-type on POST => `415`
- Invalid JSON => `400`
- Unknown route => `404`

## 3) Commands to Run API Mode

Run from workspace root (`backend` parent), or adjust path accordingly.

## Minimal

```bash
node ./backend/factory-js/generic-mcp/run-generic-mcp-server.js
```

## Recommended (explicit adapter + port)

```bash
node ./backend/factory-js/generic-mcp/run-generic-mcp-server.js \
  --client-module "./backend/factory-js/generic-mcp/adapters/stdio-mcp-client.js" \
  --host 127.0.0.1 \
  --port 4318
```

## With project default + debug

```bash
node ./backend/factory-js/generic-mcp/run-generic-mcp-server.js \
  --default-project-path "/absolute/path/to/godot-project" \
  --debug
```

## With explicit MCP config source

```bash
# File path override
node ./backend/factory-js/generic-mcp/run-generic-mcp-server.js \
  --mcp-config-path "./backend/factory-js/mcp.config.json"

# Inline JSON override
node ./backend/factory-js/generic-mcp/run-generic-mcp-server.js \
  --mcp-config-json '{"command":"node","args":["server.js"]}'
```

## Startup warmup gate controls

```bash
# default is auto-init ON
node ./backend/factory-js/generic-mcp/run-generic-mcp-server.js --auto-init

# disable startup readiness warmup
node ./backend/factory-js/generic-mcp/run-generic-mcp-server.js --no-auto-init
```

## 4) Quick API Calls (curl)

## Health

```bash
curl -s http://127.0.0.1:4318/health | jq
```

## Ready

```bash
curl -s "http://127.0.0.1:4318/ready?projectPath=/absolute/project/path" | jq
```

## Run local

```bash
curl -s http://127.0.0.1:4318/runlocal \
  -H "Content-Type: application/json" \
  -d '{
    "input": "Create a script called Logs and attach it to root node of NewScene.tscn",
    "projectPath": "/absolute/project/path",
    "responseMode": "compact"
  }' | jq
```

## Run online

```bash
curl -s http://127.0.0.1:4318/run \
  -H "Content-Type: application/json" \
  -d '{
    "input": "Create a script called Logs and attach it to root node of NewScene.tscn",
    "projectPath": "/absolute/project/path",
    "responseMode": "compact"
  }' | jq
```

## Resume

```bash
curl -s http://127.0.0.1:4318/resume \
  -H "Content-Type: application/json" \
  -d '{
    "sessionId": "session-id-from-run-response",
    "input": "Use res://NewScene.tscn",
    "responseMode": "compact"
  }' | jq
```

## 5) Useful Flags and Env Vars

CLI flags:
- `--host`
- `--port`
- `--max-body-bytes`
- `--max-sessions`
- `--client-module`
- `--mcp-config-path`
- `--mcp-config-json`
- `--default-project-path`
- `--model-backend`
- `--model-name`
- `--model-base-url`
- `--model-api-key`
- `--model-timeout-ms`
- `--online-model-name`
- `--online-model-base-url`
- `--online-model-api-key`
- `--online-model-timeout-ms`
- `--auto-init`
- `--no-auto-init`
- `--debug`

Environment vars (equivalent support exists in config parser):
- `GENERIC_MCP_HTTP_HOST`
- `GENERIC_MCP_HTTP_PORT`
- `GENERIC_MCP_HTTP_MAX_BODY_BYTES`
- `GENERIC_MCP_HTTP_MAX_SESSIONS`
- `GENERIC_MCP_HTTP_DEBUG`
- `GENERIC_MCP_AUTO_INIT_ON_START`
- `GENERIC_MCP_CLIENT_MODULE`
- `GENERIC_MCP_DEFAULT_PROJECT_PATH`
- `GENERIC_MCP_MODEL_BACKEND`
- `GENERIC_MCP_MODEL_NAME`
- `GENERIC_MCP_MODEL_BASE_URL`
- `GENERIC_MCP_MODEL_API_KEY`
- `GENERIC_MCP_MODEL_TIMEOUT_MS`
- `GENERIC_MCP_ONLINE_MODEL_NAME`
- `GENERIC_MCP_ONLINE_MODEL_BASE_URL`
- `GENERIC_MCP_ONLINE_MODEL_API_KEY`
- `GENERIC_MCP_ONLINE_MODEL_TIMEOUT_MS`
- `OPENAI_API_KEY` (fallback for online model key)
