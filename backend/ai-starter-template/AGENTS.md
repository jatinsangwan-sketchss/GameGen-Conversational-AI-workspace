# AGENTS.md

This repository is a Godot game project for hyper/hybrid-casual development.

The coding assistant is used only for scoped coding tasks.
The human developer owns project structure, folder creation, file organization, scene setup, architecture decisions, and final review.

## Core operating rules

- Only make changes requested in the current task.
- Keep diffs minimal.
- Do not modify unrelated files.
- Do not move, rename, or delete files unless explicitly asked.
- Do not create folders unless explicitly asked.
- Do not invent new architecture unless explicitly asked.
- Prefer the simplest working solution.
- Preserve existing naming conventions and coding style.
- Explain assumptions clearly.
- Mention any manual Godot editor setup required.

## Responsibility split

### Human owns
- folder structure
- file organization
- scene creation and node structure
- architecture decisions
- naming conventions
- milestone planning
- gameplay judgment
- testing and validation
- final merges

### Agent owns
- implementing logic inside approved files
- bug fixing inside approved files
- refactoring approved files
- adding comments where useful
- improving readability without changing unrelated behavior

## Task input format

Every task should include:
- Goal
- Context
- Files allowed to change
- Files not to touch
- Requirements
- Constraints
- Acceptance criteria

Do not proceed beyond the scoped request.

## Godot-specific rules

- Use Godot 4.x compatible GDScript syntax only.
- Do not assume editor-created nodes exist unless specified by the task.
- If code depends on scene nodes, state clearly which nodes must exist.
- Prefer exported variables, clear node references, and readable scene-driven logic.
- Avoid hardcoding values that should be tunable.
- Prefer data-driven tuning where appropriate.
- Keep gameplay logic readable and easy to iterate on.
- Do not add plugins, addons, or external dependencies unless explicitly requested.

## File safety rules

- Only edit files explicitly listed in the task.
- If a change seems to require another file, stop and report it.
- If a requested change conflicts with the current implementation, explain the conflict instead of silently redesigning the system.

## Coding style

- Write clear and readable GDScript.
- Prefer small functions.
- Use descriptive names.
- Add comments only where they improve clarity.
- Avoid clever abstractions unless clearly justified.
- Keep systems easy to tune for casual-game iteration.

## Output format for every task

1. Summary of what changed
2. Files changed
3. Assumptions made
4. Manual Godot editor steps required
5. Risks or edge cases to test

## Refactor rules

For refactor tasks:
- preserve behavior unless explicitly asked otherwise
- avoid broad rewrites
- call out any risk areas
- keep external interfaces stable unless asked to change them

## Bug fix rules

For bug fix tasks:
- identify likely root cause first
- apply the smallest safe fix
- avoid opportunistic cleanup unless requested
- include manual repro/test steps in the response

## Feature rules

For feature tasks:
- implement only the requested scope
- do not add bonus features
- do not pre-build future systems unless requested
- keep new logic isolated and readable

## If context is missing

If required information is missing, do not invent hidden systems.
State what assumption is being made, or request the missing detail in the task response.