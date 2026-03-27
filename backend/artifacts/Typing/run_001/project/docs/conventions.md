# Conventions

## Purpose

This document defines project conventions for Godot-based hyper/hybrid-casual game development.

The goals are:
- keep project structure predictable
- make AI-assisted coding safer
- reduce architecture drift
- keep gameplay systems easy to iterate on

---

## Core principles

- Prefer simplicity over abstraction.
- Keep feature logic easy to read and easy to tune.
- Avoid broad architecture changes during feature work.
- Prefer minimal diffs and isolated changes.
- Keep scene ownership and system ownership clear.
- Anything tuned often should move toward data-driven configuration.
- Human controls structure and architecture.
- AI assists with scoped code tasks only.

---

## Folder ownership

### `docs/`
Planning and workflow documents.
Examples:
- PRD
- GDD
- UI specs
- implementation brief
- playtest notes
- milestone plans

### `scenes/`
Godot scene files only.
Organize by feature/domain.

### `scripts/`
Feature-owned scripts.
Use for scene-specific or feature-specific logic.

### `systems/`
Reusable cross-project or cross-feature systems.
Examples:
- game manager
- save manager
- progression manager
- state manager

### `data/`
Config and tunable content.
Examples:
- balance values
- upgrade definitions
- level parameters
- mission data

### `assets/`
Visual assets.

### `audio/`
Music and sound.

### `debug/`
Debug helpers, test overlays, tuning utilities.

---

## Scripts vs systems

### Put code in `scripts/` when:
- it belongs to one scene
- it belongs to one feature
- it directly controls local node behavior

Examples:
- player controller
- enemy movement
- HUD logic
- fail popup logic

### Put code in `systems/` when:
- it is reused by multiple scenes
- it manages shared state
- it acts like infrastructure or a service

Examples:
- game manager
- save system
- progression system
- analytics wrapper

---

## Scene ownership rules

Each major scene should have a clearly defined owner/controller script.

Every scene should answer:
- what it owns
- what it depends on
- what it must not manage

### Example: gameplay scene
Owns:
- current run state
- player instance
- local enemy/spawn behavior
- score for current run
- fail trigger

Does not own:
- long-term progression persistence
- monetization backend
- global save architecture
- unrelated menu logic

---

## Naming conventions

### Scene files
Use lowercase snake_case.

Examples:
- `main_menu.tscn`
- `gameplay_scene.tscn`
- `fail_popup.tscn`

### Script files
Use lowercase snake_case.

Examples:
- `player_controller.gd`
- `gameplay_controller.gd`
- `score_display.gd`

### System files
Use descriptive manager/service-style names only when appropriate.

Examples:
- `game_manager.gd`
- `save_manager.gd`
- `progression_manager.gd`

### Data files
Use lowercase snake_case and descriptive names.

Examples:
- `upgrade_definitions.json`
- `economy_config.json`
- `level_params_01.json`

---

## Coding rules

- Write readable GDScript.
- Prefer short functions.
- Use descriptive variable and function names.
- Avoid clever or overly generic abstractions.
- Keep public interfaces small.
- Add comments only when they improve clarity.
- Do not hardcode values that are likely to be tuned repeatedly.
- Keep gameplay logic easy to test manually.

---

## Feature implementation rules

For feature work:
- change only approved files
- avoid unrelated cleanup
- avoid speculative architecture
- implement only requested scope
- do not add bonus features unless requested

---

## Bug fix rules

For bug fixes:
- identify likely root cause first
- apply the smallest safe fix
- preserve existing behavior outside the bug scope
- include manual test steps after changes

---

## Refactor rules

For refactors:
- preserve behavior unless explicitly asked otherwise
- keep external interfaces stable where possible
- avoid broad rewrites
- explain any risk areas

---

## Data-driven design rules

Prefer config/data for:
- balance values
- upgrade values
- reward values
- spawn tuning
- mission definitions
- level parameters

Avoid moving to data too early if the mechanic is still unclear, but once the feature stabilizes, tuneable values should be externalized.

---

## Manual Godot setup rule

If code depends on editor-side setup, always document:
- required nodes
- required signal connections
- exported variable assignments
- autoload requirements if any

This is mandatory for AI-assisted coding tasks.

---

## Task handoff rules for Cursor

Every coding task should specify:
- goal
- context
- files allowed to change
- files not to touch
- requirements
- constraints
- acceptance criteria

If any of these are missing, the task is not ready.

---

## Milestone rule

All tasks should belong to a milestone.

Recommended milestone structure:
- M0: project setup and starter structure
- M1: playable core loop
- M2: HUD, fail, retry
- M3: progression/meta
- M4: content expansion
- M5: polish and testing

---

## Placeholder file rule

Empty folders are allowed.
Template files are allowed.
Junk placeholders are not allowed.

Good:
- clearly named folders
- docs templates
- simple bootstrap scenes
- empty feature folders

Bad:
- random temp files
- unclear unused placeholders
- duplicate experimental files without cleanup