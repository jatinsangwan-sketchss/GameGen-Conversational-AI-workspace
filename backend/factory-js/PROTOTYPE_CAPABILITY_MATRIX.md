# factory-js Prototype Capability Matrix

This matrix documents the reduced prototype that the current edit mode and `runGoPeakWrapper.js --test-all` validate.

If a capability is **not listed here**, it is intentionally out of scope for the prototype edit interface.

## Global prerequisites (edit mode & prototype operations)

1. Backend-owned GoPeak session must be running (managed by `GoPeakSessionManager`).
2. For operations that require `editor_bridge_required`: the Godot editor must be connected to the active GoPeak bridge, and the connected project path must match the requested project root.
3. Scene/script file paths are resolved relative to the target Godot project using `res://...` conventions.
4. Implementation location: working prototype code lives under `backend/factory-js/core/`. Anything under `backend/factory-js/experimental/` is out of scope for edit-mode contributors.

Debugging:
- Set `DEBUG_GOPEAK_DISCOVERY=true` to see deep discovery / raw payload details.
- Default logs are intended to stay concise.

## Supported operations (prototype)

Legend:
- **Supported now?** reflects whether edit mode and `RecipeEngine` currently allow/execute it.
- **Prerequisite class** mirrors the contract used by `RecipeEngine` / `GoPeakOperationRegistry`.
- **Validation status** is the semantic check that decides whether an execution is considered trustworthy.
- **Fallback policy** is the runtime behavior when the primary execution path is unavailable.

| Operation | Supported now? | Prerequisite class | Validation status | Fallback policy | Notes / limitations |
|---|---:|---|---|---|---|
| `inspect_scene` | Yes | (local) | Existence + parses scene root node from `.tscn` (no GoPeak required) | N/A | Prototype inspection only; no mutations. |
| `create_scene` | Yes | `project_required`, `editor_bridge_required` | Semantic: verifies created `.tscn` root node `type` matches `root_node_type`. Root `name` is enforced only when the underlying MCP payload indicates a name field was passed. | `fail_if_primary_unavailable` | Requires an editor bridge connection; does not attempt generic/unsafe scene-file edits. |
| `add_node` | Yes | `project_required`, `editor_bridge_required` | Semantic: checks the expected node `name` + `type` appears in the updated `.tscn`. | `fail_if_primary_unavailable` | Requires editor bridge and connected project context. |
| `set_node_properties` | Yes | `project_required`, `editor_bridge_required` | Semantic: checks requested property keys appear in the `.tscn` with `key = ...` (best-effort, conservative). | `fail_if_primary_unavailable` | Requires editor bridge and connected project context. |
| `save_scene` | Yes | `project_required`, `editor_bridge_required` | Checks the scene file exists after save (ensures the save step happened). | `fail_if_primary_unavailable` | Requires editor bridge. |
| `create_script_file` | Yes | `project_required` | Checks script file exists and that its content includes the provided content substring (or is non-empty where applicable). | `allow_executor_file_write` | This is executed via deterministic filesystem write by the executor; it is not an editor-bridge tool. |

## Stable vs unstable (prototype engineering guidance)

### Stable (prototype hot path)
- Edit mode planning/execution uses the constrained operation interface and goes through `RecipeEngine`.
- Unsupported requests are rejected (no improvisation via raw MCP tool guesses).
- Semantic verification exists for scene mutations and script file creation.

### Unstable / intentionally limited
- The underlying GoPeak tool contracts and node semantics can evolve; semantic checks may need adjustment if tool output changes.
- The prototype does not aim to cover every Godot editor operation—only the operation set above.

### Not yet supported (intentionally)
- Any operation not listed in the “Supported operations (prototype)” table.
- General-purpose editor manipulation beyond the canonical scene/script operations above.
- CLI/run_project orchestration, project renames, or runtime calls (unless explicitly added to the supported table).

## Intentionally out of scope (for edit mode)

Edit mode is not a general-purpose command runner. Anything outside the matrix above should be treated as:
- unsupported (clear rejection), or
- experimental code under `backend/factory-js/experimental/` (not part of the hot path).

