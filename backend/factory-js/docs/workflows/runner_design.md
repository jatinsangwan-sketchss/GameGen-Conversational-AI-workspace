
# `factory/runner_design.md`

```md id="xjlwm7"
# runner.py Design

## Purpose

`runner.py` is the orchestration entrypoint for the AI Game Factory.

This module coordinates all major factory stages:

1. spec ingest
2. planning
3. scaffolding
4. generation
5. validation
6. repair
7. reporting

It is the main "run the factory" script.

---

## Responsibilities

- load run configuration
- invoke modules in the correct order
- save intermediate artifacts
- stop on fatal upstream failures
- trigger validation and optional repair loop
- write final summaries
- return an overall run result

---

## Non-responsibilities

This module should not contain:
- low-level scene editing logic
- low-level schema definitions
- raw Godot CLI wrappers
- direct repair heuristics
- giant prompt strings

Those belong in dedicated modules.

---

## Inputs

Required:
- project name
- PRD path
- GDD path
- UI spec path
- starter template path
- target output path

Optional:
- platform
- orientation
- milestone
- overwrite flag
- max repair attempts
- model name
- artifacts root
- strict validation mode

---

## Outputs

Primary outputs:
- persisted normalized spec
- persisted generation recipe
- scaffold summary
- validation report
- repair report if applicable
- run summary

Optional:
- terminal summary / JSON result object

---

## Suggested high-level flow

### Step 1 - Load config
Read CLI args and/or config file.

### Step 2 - Build normalized spec
Call `spec_ingest.py`.

### Step 3 - Validate normalized spec
Fail fast if invalid.

### Step 4 - Build generation recipe
Call `planner.py`.

### Step 5 - Validate generation recipe
Fail fast if invalid.

### Step 6 - Scaffold project
Call `project_scaffolder.py`.

### Step 7 - Generate project contents
Call generator/executor logic.

### Step 8 - Validate project
Call `validator.py`.

### Step 9 - Repair if enabled
If validation fails and repair is enabled:
- call `repair_loop.py`
- rerun validator as needed

### Step 10 - Write reports
Call `reporter.py`.

### Step 11 - Return final result
Return structured run result.

---

## Suggested Python interface

```python
def run_factory(
    project_name: str,
    prd_path: str,
    gdd_path: str,
    ui_spec_path: str,
    starter_template: str,
    target_output_path: str,
    platform: str,
    orientation: str | None = None,
    overwrite: bool = False,
    max_repair_attempts: int = 3,
    strict_validation: bool = False,
    artifacts_root: str | None = None,
) -> dict:
    ...