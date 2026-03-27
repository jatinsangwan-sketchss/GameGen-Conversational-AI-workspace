# Implementation Brief

## Project
[Project name]

## Current milestone
[M0 / M1 / M2 / M3 / M4 / M5]

## Current goal
[One-sentence description of what this milestone/build should achieve]

Example:
Create the first playable vertical slice of the core loop with fail and retry flow.

---

## Included in scope
List only what is included in the current milestone.

- [feature/system 1]
- [feature/system 2]
- [feature/system 3]

Example:
- player input
- basic movement
- one enemy/obstacle interaction
- score tracking
- fail state
- retry flow
- gameplay HUD

---

## Out of scope
List what must not be built in this milestone.

- [not included 1]
- [not included 2]
- [not included 3]

Example:
- progression/meta systems
- rewards economy
- ads integration
- live ops systems
- advanced polish
- content scaling

---

## Relevant design summary
Condense PRD/GDD/UI into the minimum needed for implementation.

### Core loop
[Describe the player action loop]

### Win/fail conditions
[Describe fail and win if relevant]

### Controls
[Describe input expectations]

### Feedback goals
[Describe intended feel, clarity, and response]

### UI summary
[Describe required screens/HUD for this milestone]

---

## Scene plan
List scenes expected for this milestone.

- `scene_name` — purpose
- `scene_name` — purpose

Example:
- `boot_scene` — project entry and startup flow
- `main_menu` — menu shell
- `gameplay_scene` — main gameplay loop
- `fail_popup` — fail state UI
- `hud` — score and essential gameplay UI

---

## Script/system ownership
Clarify which logic belongs where.

### Scene-owned scripts
- [script] — [responsibility]

### Shared systems
- [system] — [responsibility]

Example:

### Scene-owned scripts
- `player_controller.gd` — player movement and local input handling
- `fail_popup.gd` — fail popup UI logic
- `hud_controller.gd` — display current score and run info

### Shared systems
- `game_manager.gd` — run start/end/restart flow
- `score_manager.gd` — current run score state

---

## Manual structure/setup owned by human
List anything you will create or wire manually.

- folders to create
- scenes to create
- node trees to set up
- signal connections to confirm
- exported fields to assign

Example:
- create gameplay scene node tree
- add HUD canvas layer
- assign player node reference in gameplay controller
- connect retry button signal

---

## Files Cursor may edit
List only the files that are valid for current coding tasks.

- `path/file.gd`
- `path/file.gd`

---

## Constraints
Project-level restrictions for this milestone.

- minimal changes only
- no architecture redesign
- no file moves/renames
- no plugin additions
- keep changes easy to review
- prefer simplest working solution

---

## Acceptance criteria
Define what “done” means.

- [observable result 1]
- [observable result 2]
- [observable result 3]

Example:
- gameplay scene starts without errors
- player can perform the core action
- fail condition triggers correctly
- retry restarts a clean run
- HUD updates score correctly

---

## Manual test checklist
List what must be tested in Godot after implementation.

- [test 1]
- [test 2]
- [test 3]

Example:
- launch project and enter gameplay
- test input response
- test fail trigger
- press retry and confirm clean reset
- verify no runtime errors in output

---

## Known open questions
Track unresolved decisions here.

- [question 1]
- [question 2]

Example:
- should score reset on retry or after menu return only?
- should fail popup pause gameplay or freeze via state manager?