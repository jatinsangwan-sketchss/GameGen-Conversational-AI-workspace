
# `factory/validator_design.md`

```md id="h0jnmt"
# validator.py Design

## Purpose

`validator.py` checks whether a generated project has reached the minimum acceptable state.

This module should answer:
- does the project structure exist
- do the required scenes/scripts exist
- can the project run
- are there obvious script or node errors
- do the required acceptance checks pass

It should produce output matching:
- `schemas/validation_report.schema.json`

---

## Responsibilities

- validate project file structure
- validate generated scene/script presence
- run bounded project validation
- inspect debug output
- produce a structured validation report
- separate hard failures from warnings

---

## Non-responsibilities

This module should not:
- generate code
- repair code
- plan architecture
- decide fun/quality
- perform deep gameplay simulation in v1

---

## Inputs

Required:
- project name
- project root
- generation recipe
- executor instance

Optional:
- validation profile
- bounded run duration
- strictness mode

---

## Outputs

Primary output:
- validation report JSON object

Optional persisted output:
- `artifacts/<project_name>/validation_report.json`

---

## Validation layers

### Layer 1 - File presence checks
Check required:
- scene files
- scripts
- systems
- config files if any

### Layer 2 - Scene structure checks
Check required nodes exist in expected scenes when possible.

### Layer 3 - Runtime checks
Run project in a bounded way and inspect:
- exit result
- stderr
- debug output
- script/runtime errors

### Layer 4 - Acceptance checks
Check recipe-defined required conditions at a high level.

For v1, many acceptance checks may still be structural rather than behavioral.

---

## Suggested Python interface

```python
def validate_project(
    project_name: str,
    project_root: str,
    generation_recipe: dict,
    executor: object,
    bounded_run_seconds: int = 5,
    strict: bool = False,
) -> dict:
    ...