
# `factory/reporter_design.md`

```md id="0oxzby"
# reporter.py Design

## Purpose

`reporter.py` creates readable run summaries for humans after generation, validation, and repair.

This module is not responsible for core generation logic.
It is responsible for visibility and auditability.

---

## Responsibilities

- summarize what was generated
- summarize validation results
- summarize repair attempts
- highlight remaining issues
- make next review steps clear

---

## Inputs

Possible inputs:
- normalized spec JSON
- generation recipe JSON
- validation report JSON
- repair report JSON
- created file list
- generation logs

---

## Outputs

Suggested outputs:
- `artifacts/<project_name>/generation_summary.md`
- `artifacts/<project_name>/validation_summary.md`
- `artifacts/<project_name>/repair_summary.md`
- one combined `run_summary.md`

---

## Suggested report sections

### Generation summary
- project name
- starter template used
- target path
- scenes created
- scripts created
- systems created
- config files created

### Validation summary
- overall status
- passed checks
- failed checks
- warnings
- debug output excerpt

### Repair summary
- number of attempts
- issues targeted
- changes applied
- remaining issues

### Next manual review steps
- what to open in Godot first
- what to test first
- known risky areas

---

## Suggested Python interface

```python
def write_generation_summary(
    output_path: str,
    normalized_spec: dict,
    generation_recipe: dict,
    created_files: list[str],
) -> None:
    ...

def write_validation_summary(
    output_path: str,
    validation_report: dict,
) -> None:
    ...

def write_repair_summary(
    output_path: str,
    repair_report: dict,
) -> None:
    ...

def write_run_summary(
    output_path: str,
    normalized_spec: dict,
    generation_recipe: dict,
    validation_report: dict | None = None,
    repair_report: dict | None = None,
) -> None:
    ...