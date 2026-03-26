# project_scaffolder.py Design

## Purpose

`project_scaffolder.py` is responsible for creating a new generated project workspace from the reusable Godot starter template.

This module does not design the game.
It prepares the target project directory so later factory stages can safely generate scenes, scripts, configs, and reports.

---

## Responsibilities

- copy the starter template project into a new target path
- rename project-level identifiers if needed
- create artifact/output folders for generation runs
- confirm required baseline files exist
- avoid overwriting existing work unless explicitly allowed
- produce a scaffold summary for later stages

---

## Non-responsibilities

This module should not:
- generate gameplay scenes
- generate scripts
- call LLMs for planning
- perform validation beyond basic scaffold integrity checks
- repair project logic

---

## Inputs

Required:
- starter template path
- target output path
- project name

Optional:
- overwrite flag
- run ID
- artifact root override
- template sanity check strictness
- project metadata overrides

---

## Outputs

Primary output:
- copied Godot project workspace

Secondary outputs:
- scaffold metadata object
- scaffold log entry
- artifact directory for this generation run

Optional persisted output:
- `artifacts/<project_name>/scaffold_summary.json`

---

## Main steps

### Step 1 - Validate starter template
Confirm the starter template exists and contains required baseline files.

Recommended required files:
- `project.godot`
- `AGENTS.md`
- `docs/conventions.md`
- `docs/implementation-brief.md`

Recommended required directories:
- `scenes/`
- `scripts/`
- `systems/`
- `docs/`

### Step 2 - Resolve target path
Determine where the new project will be created.

Rules:
- fail if target already exists unless overwrite is explicitly enabled
- create parent directories if needed
- keep generated projects isolated from the starter template

### Step 3 - Copy template
Copy starter template into the target path.

Rules:
- preserve relative paths
- do not symlink unless explicitly requested later
- ignore unnecessary transient files if desired

### Step 4 - Apply project metadata updates
Optionally update project-level identifiers.

Possible updates:
- project display name
- generated project name in metadata
- artifact folder naming

Do not rewrite more than necessary in v1.

### Step 5 - Create artifacts directory
Create a per-project artifact folder for:
- normalized spec
- generation recipe
- validation reports
- repair reports
- summaries

Suggested path:
- `artifacts/<project_name>/`

### Step 6 - Run scaffold integrity check
Confirm copied project contains expected baseline structure.

### Step 7 - Return scaffold summary
Return structured result for later stages.

---

## Suggested Python interface

```python
def scaffold_project(
    starter_template: str,
    target_path: str,
    project_name: str,
    overwrite: bool = False,
    artifacts_root: str | None = None,
    run_id: str | None = None,
) -> dict:
    ...