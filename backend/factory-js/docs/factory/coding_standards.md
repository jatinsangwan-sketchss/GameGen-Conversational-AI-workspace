
---

# `factory/coding_standards.md`

```md id="jlwmkl"
# Factory Coding Standards

## Purpose

This document defines coding standards for the AI Game Factory and for generated game code.

These standards exist to ensure code is:
- readable
- maintainable
- modular
- easy to review
- easy for AI and humans to edit safely

---

## Core principles

- Prefer clarity over cleverness.
- Prefer small focused modules over large mixed-responsibility files.
- Use clear programming patterns.
- Keep responsibilities narrow.
- Write code that is easy to change later.
- Make code understandable without guessing hidden intent.

---

## Script size rule

Do not create one big script that handles too many responsibilities.

Instead:
- split by responsibility
- keep each script focused
- separate scene-owned logic from shared systems
- separate orchestration from low-level helpers

Bad:
- giant 600-line gameplay controller with spawning, scoring, UI, fail logic, save logic, and debug logic all mixed together

Good:
- gameplay controller
- enemy script
- HUD controller
- fail popup controller
- game manager only if needed

---

## Responsibility rule

Every module/script should answer:
- what it owns
- what it depends on
- what it does not own

If a script cannot be described in one short sentence, it may be too broad.

---

## Programming patterns rule

Use recognizable, boring, maintainable patterns.

Examples:
- controller for scene-owned logic
- manager/service only for true shared systems
- config/data-driven values where appropriate
- small helper functions
- explicit interfaces over magic coupling

Avoid:
- over-abstraction
- speculative design patterns
- unnecessary inheritance chains
- giant utility dumping grounds

---

## Commenting rule

Comments should explain:
- what this module/class/function is for
- how important flows work
- where this code connects to other systems
- assumptions that are not obvious
- manual setup requirements where relevant

Do not add comments that merely repeat the code.

Good comment:
- explains why a node path is required
- explains why a reset happens before retry
- explains why only closest matching enemy is selected

Bad comment:
- `# increment i`
- `# set variable`
- `# this is a function`

---

## Function design rule

Functions should:
- do one clear thing
- have descriptive names
- be short where practical
- avoid long chains of unrelated side effects

Prefer:
- small helper methods
- explicit inputs
- explicit return values where useful

Avoid:
- giant functions with many branches and responsibilities

---

## File organization rule

Keep code organized by role.

For factory code:
- one module per major responsibility

For generated game code:
- scene-owned scripts in `scripts/`
- shared systems in `systems/`

Do not dump unrelated logic into generic files like:
- `utils.py`
- `helpers.py`
- `manager.gd`

unless the purpose is specific and justified.

---

## Readability rule

Code should be easy to scan.

Use:
- descriptive variable names
- clear sectioning
- consistent formatting
- small logical blocks
- explicit assumptions

Avoid:
- cryptic names
- nested complexity when not needed
- long unbroken files

---

## Logging rule

Important flows should log meaningful information.

For factory code, log:
- stage start/end
- file creation
- validation failures
- repair actions
- major execution calls

Logs should help debug runs without reading all source code.

---

## Error handling rule

Handle errors explicitly.

Prefer:
- clear failure states
- categorized errors
- useful messages
- fail-fast when required config/artifacts are missing

Avoid:
- silent failures
- swallowed exceptions without context

---

## Generated code rule

Generated game code should:
- be minimal
- be readable
- follow the same structure rules
- avoid giant monolithic scripts
- include short useful comments where integration/setup is important

The factory should generate code that a human can comfortably edit later.

---

## Refactor rule

When refactoring:
- preserve behavior unless explicitly changing behavior
- improve clarity
- reduce responsibility sprawl
- avoid broad rewrites unless needed

---

## AI generation rule

When using LLMs for code:
- request small focused outputs
- define file ownership clearly
- define expected structure clearly
- require readable code
- require comments where integration assumptions matter

---

## Success criteria

Code follows this standard when:
- each script/module has a clear purpose
- responsibilities are not mixed excessively
- comments help understanding
- future edits are straightforward
- humans can onboard quickly
- AI can patch safely later