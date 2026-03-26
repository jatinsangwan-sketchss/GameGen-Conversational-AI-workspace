# repair_loop.py Design

## Purpose

`repair_loop.py` is responsible for improving a generated project after validation fails.

This module should:
- read the validation report
- classify the failures
- choose the smallest safe repair actions
- apply repairs
- rerun validation
- record what changed

It should produce output matching:
- `schemas/repair_report.schema.json`

The repair loop is what turns the factory from a one-shot generator into an iterative build system.

---

## Responsibilities

- consume validation failures
- classify failures into repair categories
- choose minimal repair actions
- patch files or scene structure
- rerun validation after each repair cycle
- stop after a bounded number of attempts
- produce a structured repair report

---

## Non-responsibilities

This module should not:
- redesign the whole project
- expand scope
- add bonus systems
- invent large new architecture
- replace planning logic
- judge game quality or fun

---

## Inputs

Required:
- project name
- project root
- generation recipe
- validation report
- executor instance

Optional:
- max repair attempts
- strictness mode
- repair policy
- model name override
- artifact output path

---

## Outputs

Primary output:
- repair report JSON object

Optional persisted outputs:
- `artifacts/<project_name>/repair_report.json`
- `artifacts/<project_name>/repair_attempt_01.json`
- patch/change summaries per attempt

---

## Main repair loop flow

### Step 1 - Read validation report
Load the current validation report.

### Step 2 - Extract repairable issues
Separate issues into:
- repairable automatically
- not repairable automatically
- ambiguous / needs human review

### Step 3 - Rank issues
Prefer fixing:
- syntax/runtime blockers
- missing files
- missing node references
- bad scene paths
- missing exported references

Defer:
- vague gameplay quality issues
- large architecture mismatches
- unclear design contradictions

### Step 4 - Generate repair actions
Create minimal repair actions.

Examples:
- create missing script file
- patch node path in script
- add missing node to scene
- attach missing script to scene root
- fix bad scene reference path

### Step 5 - Apply repair actions
Use:
- filesystem edits for code/config
- Godot MCP for scene/node operations
- possibly limited LLM code patching for script repairs

### Step 6 - Rerun validation
Run validator again.

### Step 7 - Decide whether to continue
Stop if:
- validation passes
- no progress is being made
- max attempts reached
- remaining issues are not safe for auto-repair

### Step 8 - Write repair report
Persist structured repair information.

---

## Suggested Python interface

```python
def run_repair_loop(
    project_name: str,
    project_root: str,
    generation_recipe: dict,
    validation_report: dict,
    executor: object,
    max_attempts: int = 3,
    strict: bool = False,
) -> dict:
    ...