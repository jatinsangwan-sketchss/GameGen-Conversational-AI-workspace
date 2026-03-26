
## spec_ingest.py Design

## Purpose

`spec_ingest.py` reads:
- PRD
- GDD
- UI spec

and converts them into a normalized internal spec object that matches:

- `schemas/normalized_game_spec.schema.json`

This module should reduce raw document ambiguity before planning begins.

---

## Responsibilities

- read source markdown/text files
- extract relevant sections
- combine information across PRD/GDD/UI
- resolve overlap and duplication
- create a normalized internal game spec
- validate the resulting spec against schema
- report missing required fields

---

## Inputs

Required:
- project name
- PRD file path
- GDD file path
- UI spec file path
- target platform

Optional:
- orientation override
- milestone override
- extra generation constraints

---

## Outputs

Primary output:
- normalized game spec JSON object

Optional persisted output:
- `artifacts/<project_name>/normalized_game_spec.json`

---

## Main internal steps

### Step 1 - Read source docs
Load raw content from:
- PRD
- GDD
- UI spec

### Step 2 - Parse sections
Extract sections such as:
- summary
- core loop
- controls
- fail condition
- score model
- scenes/screens
- UI HUD elements
- entities
- risks
- out of scope

### Step 3 - Merge and normalize
Build a single consistent spec object.

### Step 4 - Fill inferred defaults
Only fill safe defaults when information is clearly missing.

Examples:
- if platform is provided as input, use it
- if orientation is missing, use explicit config or require clarification
- if no systems are mentioned, use empty array

### Step 5 - Validate schema
Validate the generated object against the normalized spec schema.

### Step 6 - Return structured result
Return:
- normalized spec object
- validation errors if any
- extraction notes if useful

---

## Suggested Python interface

```python
def build_normalized_spec(
    project_name: str,
    prd_path: str,
    gdd_path: str,
    ui_spec_path: str,
    platform: str,
    orientation: str | None = None,
    constraints: dict | None = None,
) -> dict:
    ...