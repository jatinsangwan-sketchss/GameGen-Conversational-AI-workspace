# factory-js

`factory-js` is a thin Generic MCP client runtime focused on reliability-first Godot automation.

Primary implementation lives in `generic-mcp/`.

## Current Architecture (Thin MCP)

This runtime intentionally does only a small set of things:

1. Keep one MCP session alive and verify bridge/project readiness.
2. Discover live tools from MCP at runtime (no hardcoded tool list).
3. Ask the planner LLM for the next step.
4. Apply thin argument handling:
   - semantic alias materialization
   - session `projectPath` injection
   - required-arg validation against live tool schema
5. Execute MCP tools.
6. Optionally use safe text-edit fallback for `.gd` / `.tscn` when enabled.

Source-of-truth path and node resolution is now `session.json` / `session.imported.json` via `SessionGraphStore`.

## Directory Guide

- `generic-mcp/run-generic-mcp-server.js`
  Sidecar bootstrap and module wiring.
- `generic-mcp/config/genericMcpServer.config.js`
  CLI/env config parser.
- `generic-mcp/api/GenericMcpHttpServer.js`
  HTTP transport and route handling.
- `generic-mcp/api/GenericMcpHttpAdapter.js`
  Request validation, session binding, result shaping.
- `generic-mcp/api/GenericMcpSessionStore.js`
  In-memory API session store.
- `generic-mcp/GenericMcpRunner.js`
  Main orchestration loop (queue, planning, resolve, execute, fallback).
- `generic-mcp/ToolPlanner.js`
  LLM planner that picks next tool + args.
- `generic-mcp/ArgumentResolver.js`
  Thin arg resolver (aliases, project path injection, required-arg checks).
- `generic-mcp/Executor.js`
  Tool invocation and result capture.
- `generic-mcp/SessionGraphStore.js`
  Session JSON index for scene/node path normalization.
- `generic-mcp/TextEditFallbackStage.js`
  Transactional text-edit fallback with validation/rollback.
- `generic-mcp/SessionManager.js`
  MCP client lifecycle and readiness checks.
- `generic-mcp/ToolInventory.js`
  Live tool discovery cache.
- `generic-mcp/ResultPresenter.js`
  Human-facing result presentation.
- `generic-mcp/WorkflowCore.js`
  Shared workflow-state helpers.
- `generic-mcp/LiveModelClient.js`
  LLM transport adapter.
- `generic-mcp/adapters/stdio-mcp-client.js`
  JSON-RPC stdio MCP client adapter.

## End-to-End Flow

1. HTTP request hits `/run` or `/runlocal`.
2. Adapter validates payload and resolves session/project context.
3. Runner ensures MCP session readiness.
4. Runner loads live inventory.
5. Planner returns `next_step | done | missing_args | ambiguous | unsupported`.
6. Resolver transforms planner args into executable args.
7. Executor calls MCP tool.
8. Runner either continues queue, completes, or invokes fallback (when enabled).

## API Endpoints

Base URL (default): `http://127.0.0.1:4318`

### `GET /health`

Returns liveness and runtime status summary.

### `GET /ready?projectPath=/abs/path`

Runs readiness gate for current MCP session and expected project.

### `POST /run`

Uses online model profile.

Request JSON:

```json
{
  "input": "string (required)",
  "projectPath": "optional absolute path",
  "sessionId": "optional",
  "responseMode": "compact|full (optional)"
}
```

### `POST /runlocal`

Uses local model profile. Request shape is identical to `/run`.

## Running API Mode

Minimal:

```bash
node ./generic-mcp/run-generic-mcp-server.js
```

Explicit adapter + host/port:

```bash
node ./generic-mcp/run-generic-mcp-server.js \
  --client-module "./generic-mcp/adapters/stdio-mcp-client.js" \
  --host 127.0.0.1 \
  --port 4318
```

With default Godot project + debug:

```bash
node ./generic-mcp/run-generic-mcp-server.js \
  --default-project-path "/absolute/path/to/godot-project" \
  --debug
```

Disable startup auto-init:

```bash
node ./generic-mcp/run-generic-mcp-server.js --no-auto-init
```

Quick curl checks:

```bash
curl -s http://127.0.0.1:4318/health
curl -s "http://127.0.0.1:4318/ready?projectPath=/absolute/path"
curl -s http://127.0.0.1:4318/runlocal -H "Content-Type: application/json" -d '{"input":"..."}'
```

## Session JSON Location

Expected under Godot project root:

- preferred: `session.json`
- fallback: `session.imported.json`

`SessionGraphStore` loads this file and resolves scene/node references for canonical tool args.

## Flags and Debug

Common debug flags:

- `DEBUG_GENERIC_MCP_VERIFY=true`
- `DEBUG_GENERIC_MCP_EXECUTOR=true`
- `DEBUG_GENERIC_MCP_FALLBACK=true`
- `DEBUG_GENERIC_MCP_PRESENTER=true`

Text-edit fallback gate:

- `GENERIC_MCP_TEXT_EDIT_FALLBACK=true`

Model/server config flags remain available under `generic-mcp/config/genericMcpServer.config.js` and `generic-mcp/LiveModelClient.js`.

## Reliability Notes

1. Live tool schemas are always used; no static contract assumptions.
2. Thin resolver avoids brittle heuristic mutation logic.
3. Session graph gives stable path canonicalization from session JSON.
4. Fallback path is transactional and rollback-safe.
5. Runner has queue safety bounds to avoid infinite loops.
