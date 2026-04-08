# factory-js (Reduced Prototype)

Current runtime source of truth: `generic-mcp/`.
Root-level generation/spec modules are legacy leftovers and are not part of the active runtime workflow.

Node.js / JavaScript port of the AI Game Factory.

This repo is intentionally reduced to a small, trustworthy prototype. The goal is to keep the edit-mode + GoPeak/MCP pipeline deterministic and easy to reason about, not to provide a general-purpose “raw MCP playground”.

## Prototype goal

Run conversation-driven edits against an existing generated Godot project by:
1. Planning a *small, validated* operation set.
2. Executing every supported operation through `RecipeEngine` (single lifecycle: prerequisites → inspect → execute → validate → summarize).
3. Rejecting unsupported requests clearly (no improvisation).

## What’s in scope (core hot path)

Core modules live under `backend/factory-js/core/` and power:
- `runEditMode.js` (conversation edit mode)
- `runGoPeakWrapper.js` (`--test-all` prototype validation)

Key design constraints:
- Edit mode supports only the prototype operations listed in `PROTOTYPE_CAPABILITY_MATRIX.md`.
- `--test-all` validates the same operation layer (not every discovered raw tool).
- Detailed discovery/raw payload logs are gated behind `DEBUG_GOPEAK_DISCOVERY=true`.

Anything under `backend/factory-js/experimental/` is explicitly out of scope for the hot path and should not be relied on for edit-mode determinism.

## Docs

- Prototype scope + “core vs experimental” guidance: `PROTOTYPE_CUTLIST.md`
- Exact supported/unsupported capabilities: `PROTOTYPE_CAPABILITY_MATRIX.md`

## Local usage (generic-mcp sidecar)

Start the local HTTP sidecar:

```bash
node ./factory-js/generic-mcp/run-generic-mcp-server.js \
  --client-module "./factory-js/generic-mcp/adapters/stdio-mcp-client.js"
```
By default, sidecar starts MCP initialize + bridge readiness attempts immediately on boot (disable with `--no-auto-init`).

Health check:

```bash
curl -s http://127.0.0.1:4318/health
```
Readiness check (runs MCP/session readiness gate):

```bash
curl -s "http://127.0.0.1:4318/ready"
```

Run a new request:

```bash
curl -s http://127.0.0.1:4318/run \
  -H "Content-Type: application/json" \
  -d '{
    "input":"create a gdscript called Logs and attach it to root node of NewScene.tscn. This script should print Hello world in the console",
    "projectPath":"/absolute/project/path (optional)",
    "sessionId":"optional"
  }'
```

Resume a pending semantic clarification:

```bash
curl -s http://127.0.0.1:4318/resume \
  -H "Content-Type: application/json" \
  -d '{
    "sessionId":"required",
    "input":"res://NewScene.tscn"
  }'
```
