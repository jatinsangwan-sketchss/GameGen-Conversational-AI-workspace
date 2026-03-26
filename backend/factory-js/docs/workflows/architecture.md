# AI Game Factory Architecture

## Purpose

This document defines the architecture of the AI Game Factory.

The factory takes:
- PRD
- GDD
- UI spec

And produces:
- a generated Godot project instance
- generated scenes
- generated node trees
- generated scripts
- generated config/data files
- validation reports
- repair reports

The factory uses:
- LLMs for planning, code generation, and repair reasoning
- Godot MCP for editor/project/scene operations
- Godot CLI for project execution and validation
- a reusable starter Godot template project

---

## Primary goal

Create a semi-automated game generation pipeline where AI can:
1. read specs
2. normalize specs
3. plan game structure
4. scaffold a project
5. generate scenes and scripts
6. run and validate the project
7. repair failures
8. deliver a playable prototype candidate

---

## Factory modules

### 1. Spec Ingest
Reads PRD/GDD/UI and converts them into a normalized internal spec.

### 2. Planner
Turns the normalized spec into a generation recipe.

### 3. Project Scaffolder
Copies the starter Godot template into a new target project.

### 4. Executor
Uses Godot MCP and Godot CLI to create/edit scenes, scripts, and run validation.

### 5. Code Generator
Generates GDScript, UI logic, config files, and support files.

### 6. Validator
Runs project checks and evaluates whether the generated build matches minimum requirements.

### 7. Repair Loop
Uses validation failures to patch the project and rerun checks.

### 8. Reporter
Produces generation summaries, known issues, and next-step reports.

---

## End-to-end flow

### Stage 1: Intake
Inputs:
- PRD
- GDD
- UI spec
- target platform
- project name

Output:
- normalized game spec JSON

### Stage 2: Planning
Input:
- normalized game spec JSON

Output:
- generation recipe JSON

### Stage 3: Scaffolding
Input:
- starter template path
- output project path
- project metadata

Output:
- copied project workspace

### Stage 4: Generation
Input:
- generation recipe JSON
- copied workspace

Output:
- scenes created
- scripts created
- config files created
- node trees created

### Stage 5: Validation
Input:
- generated project

Output:
- validation report JSON

### Stage 6: Repair
Input:
- validation report JSON
- generation recipe JSON
- current project state

Output:
- repair report JSON
- patched project

### Stage 7: Delivery
Outputs:
- generated project
- generation summary
- validation summary
- known issues
- next manual review steps

---

## Execution split

### Use Godot MCP for
- project inspection
- scene creation
- adding nodes
- saving scenes
- project analysis
- running the game
- reading debug output

### Use Godot CLI for
- bounded runs
- headless validation
- import runs
- export/testing runs
- scripted project checks

---

## Human approval points

The factory is semi-automated, not unsupervised.

Human approval points:
- project idea selection
- final PRD/GDD/UI acceptance
- approval of generated architecture
- review of generated prototype
- playtest and fun judgment
- go/no-go for further iteration

---

## Factory design rules

- Use normalized intermediate artifacts instead of raw free-form text.
- Keep scene generation predictable and schema-driven.
- Keep task generation bounded and auditable.
- Prefer repair loops over one-shot generation.
- Log every generation step.
- Log every validation failure.
- Log every repair action.
- Keep template/starter project stable.
- Do not let game-specific hacks pollute the factory core.

---

## First supported scope

The first factory version should support:
- 2D mobile games
- one gameplay scene
- one menu scene
- one HUD
- one fail popup
- one or two core gameplay entities
- one simple fail condition
- one simple score/reward system
- no advanced meta systems
- no monetization
- no large asset pipelines

---

## First acceptance tests

Factory Test 1:
- Typing Survival

Factory Test 2:
- Lane Switch Survival

The factory is not considered valid until it can generate at least two different games from the same pipeline.