# factory-js Prototype Cutlist (Core vs Experimental)

This repo is being reduced to a **small, reliable prototype**. The goal is not to complete every feature—it's to keep the edit-mode + GoPeak/MCP pipeline trustworthy and easy to reason about.

## Core (prototype hot path)
Core modules are the ones that power:
1. `runEditMode.js` (conversation-driven “plan → execute → validate” in an existing Godot project)
2. `runGoPeakWrapper.js` (GoPeak discovery + canonical operation execution)

Core is centered around:
- `GoPeakSessionManager`
- `GoPeakOperationRegistry`
- `GoPeakToolCatalog`
- `GoPeakArgumentBuilders`
- `GodotExecutor`
- `Validator`
- conversation edit-mode orchestration (`TerminalEditModeRunner`, planner/executor, orchestrator)

These are exposed under `backend/factory-js/core/` as thin import shims.

## Experimental (not on the hot path)
Experimental code supports broader/longer pipelines (generation, scaffolding, repairs, parity smoke, etc.). It may be incomplete and should not be depended on by default edit-mode execution.

These are exposed under `backend/factory-js/experimental/` as import shims (or left in-place when not referenced by core entrypoints).

## Archive / One-off scripts
One-off smoke tests, parity checks, and discovery utilities live under `backend/factory-js/archive/`. They should not be imported by `runEditMode.js`.

## Why shims instead of deleting?
During this stage we prefer isolating behavior via import boundaries (core/experimental/archive) rather than deleting code. This keeps risk low while we progressively cut the hot path.

## Current prototype support (v1)
At minimum, the prototype supports discovery-driven canonical operations backed by GoPeak/MCP, including scene operations like:
- `create_scene`
- `add_node`
- `set_node_properties`
- `save_scene`
- composed `attach_script_to_scene_root`

Debugging can be enabled with `DEBUG_GOPEAK_DISCOVERY=true` to surface deep discovery/raw payload details.

