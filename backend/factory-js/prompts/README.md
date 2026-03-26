
# `factory/prompts/README.md`

```md id="ek6yzs"
# Factory Prompts

## Purpose

This folder stores prompt templates used by the AI Game Factory.

Prompts should be:
- reusable
- scoped
- versionable
- easy to improve over time

Prompts are part of the factory codebase, not ad-hoc chat artifacts.

---

## Prompt categories

Recommended prompt groups:

### 1. Spec prompts
Used for:
- PRD refinement
- GDD refinement
- UI spec refinement
- normalized spec extraction

### 2. Planning prompts
Used for:
- implementation brief generation
- scene planning
- node tree planning
- script ownership planning
- validation check generation

### 3. Code generation prompts
Used for:
- scene-owned script generation
- system script generation
- UI script generation
- config/data generation

### 4. Repair prompts
Used for:
- runtime error analysis
- node-path mismatch repair
- missing-reference repair
- minimal patch generation

### 5. Reporting prompts
Used for:
- generation summary
- validation summary
- repair summary
- next-step recommendations

---

## Folder suggestion

```text
factory/prompts/
├── README.md
├── spec/
├── planning/
├── codegen/
├── repair/
└── reporting/