# generator.py Design

## Purpose

`generator.py` is responsible for turning the generation recipe into an actual Godot project state.

This is the main build stage of the factory.

It should:
- create scenes
- create node trees
- create scripts
- create UI scenes
- create config/data files
- attach scripts to nodes where appropriate
- prepare the project for validation

This module executes the build recipe after the starter template has already been scaffolded.

---

## Responsibilities

- read generation recipe
- create required scene files
- create required node structures
- create required scripts
- create required shared systems
- create required UI files/scenes
- create config files if needed
- attach scripts where specified
- record what was created

---

## Non-responsibilities

This module should not:
- decide game architecture
- redesign the recipe
- do long repair reasoning
- prioritize backlog items
- judge game quality

---

## Inputs

Required:
- project name
- project root
- generation recipe
- executor instance

Optional:
- model name
- code generation mode
- artifact output path
- dry run mode

---

## Outputs

Primary outputs:
- generated files in project workspace
- generation result object

Optional persisted outputs:
- `artifacts/<project_name>/generation_result.json`
- created file list
- generation step log

---

## Main generation stages

### Step 1 - Read generation recipe
Load validated recipe.

### Step 2 - Create scenes
For each scene in `scenes_to_create`:
- create scene via Godot MCP or scene file generation strategy
- set root node type/name

### Step 3 - Create node trees
For each node entry:
- add node to target parent
- attach script if specified
- save scene

### Step 4 - Create scripts
For each script in:
- `scripts_to_create`
- `systems_to_create`

Generate code and write files.

### Step 5 - Create UI scenes
Create HUD/fail/menu scenes as specified.

### Step 6 - Create config/data files
If recipe includes data/config files, generate them.

### Step 7 - Finalize generated state
Save all scenes and return summary of created artifacts.

---

## Generation split

### Scene/node generation
Preferred method:
- Godot MCP

Use for:
- create scene
- add node
- attach scripts if supported
- save scenes

### Script/config generation
Preferred method:
- direct filesystem writes

Use for:
- `.gd` files
- `.json` config files
- auxiliary metadata files

---

## Suggested Python interface

```python
def generate_project_from_recipe(
    project_name: str,
    project_root: str,
    generation_recipe: dict,
    executor: object,
    model_name: str | None = None,
    dry_run: bool = False,
) -> dict:
    ...