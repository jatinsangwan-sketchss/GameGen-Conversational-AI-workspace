
# `factory/planner_design.md`

```md id="w8b3n4"
# planner.py Design

## Purpose

`planner.py` converts the normalized game spec into a generation recipe.

It should produce a machine-usable plan for:
- scenes
- nodes
- scripts
- systems
- UI
- config files
- validation checks
- repair hints

The output must match:
- `schemas/generation_recipe.schema.json`

---

## Responsibilities

- interpret normalized game spec
- choose minimal scene structure
- choose script ownership
- choose shared systems only when justified
- generate validation checklist
- keep first version scope narrow
- avoid speculative architecture

---

## Inputs

Required:
- normalized game spec JSON
- starter template path
- target output path

Optional:
- milestone
- generation profile
- constraints

---

## Outputs

Primary output:
- generation recipe JSON object

Optional persisted output:
- `artifacts/<project_name>/generation_recipe.json`

---

## Main planning steps

### Step 1 - Read normalized spec
Load validated normalized game spec.

### Step 2 - Plan scenes
Determine which scenes should be created.

Typical first-version scene types:
- boot scene
- main menu
- gameplay scene
- HUD
- fail popup
- one or more gameplay entities

### Step 3 - Plan node trees
For each scene, define:
- root node type
- root name
- child nodes
- parent relationships
- attached script path if any

### Step 4 - Plan scripts
Define:
- scene-owned scripts
- shared systems
- optional config files

### Step 5 - Plan UI
Define:
- UI scenes
- HUD scene
- fail popup scene
- required UI nodes

### Step 6 - Plan validation checks
Define minimum runtime checks and file existence checks.

### Step 7 - Add repair hints
Add likely repair categories for this game type.

---

## Suggested Python interface

```python
def build_generation_recipe(
    normalized_spec: dict,
    starter_template: str,
    target_path: str,
    milestone: str | None = None,
    constraints: dict | None = None,
) -> dict:
    ...