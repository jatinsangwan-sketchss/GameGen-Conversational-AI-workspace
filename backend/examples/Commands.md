# AI Game Factory — Operator Commands

Copy/paste friendly commands for local development and testing.

Run all commands from the repo root (`AI3/`) unless noted.

---

## 0) Repo Root Assumption

Most commands assume:

- current directory is the repo root: `AI3/`
- Python virtualenv is `./.venv`
- the factory Python package is `./factory`

If you’re not at repo root yet:

```bash
cd "/Users/ishanharshaddiwekar/AI3"
```

---

## 1) Environment Setup (Python)

### Create a venv (one-time)

```bash
python3 -m venv .venv
```

### Activate the venv

```bash
source .venv/bin/activate
```

### Upgrade pip

```bash
python -m pip install --upgrade pip
```

### Install Python deps

This repo currently relies on `jsonschema` for schema validation.

```bash
python -m pip install jsonschema
```

---

## 2) Local Model (Ollama / llama) Checks (for `gpt-oss:20b`)

### Verify Ollama is installed + reachable

```bash
ollama --version
ollama list
```

### Pull the model (if needed)

The current local test script uses `gpt-oss:20b`.

```bash
ollama pull gpt-oss:20b
```

### Start Ollama server (if it’s not already running)

In a separate terminal:

```bash
ollama serve
```

Expected default API endpoint:

- `http://127.0.0.1:11434`

---

## 3) Test: LLM Client (API vs llama backend selection)

This uses the existing script `factory/scripts/test_llm_client.py`.

```bash
python factory/scripts/test_llm_client.py
```

Notes:

- Requires Ollama running locally on `127.0.0.1:11434`
- The script requests model name `gpt-oss:20b`

---

## 4) Test: Prompt Builder (file-based templates + `{placeholders}`)

This renders the existing normalized-game-spec prompt templates with mock values.

```bash
python3 - <<'PY'
from factory.llm.prompt_builder import PromptBuilder

builder = PromptBuilder()
values = {
    "project_name": "demo_game",
    "platform": "android",
    "orientation": "portrait",
    "prd_text": "PRD mock text",
    "gdd_text": "GDD mock text",
    "ui_spec_text": "UI mock text",
}

prompts = builder.load_system_user_prompts(
    system_template_path="specs/normalized_game_spec_system.md",
    user_template_path="specs/normalized_game_spec_prompt.md",
    values=values,
)

print("SYSTEM prompt loaded:", len(prompts["system_prompt"]))
print("USER prompt loaded:", len(prompts["user_prompt"]))
print("--- USER prompt preview ---")
print(prompts["user_prompt"][:300])
PY
```

---

## 5) Test: Spec Ingest (mock LLM end-to-end, no Godot required)

This tests `factory/spec_ingest.py` using a **mock** LLM client that returns schema-valid JSON.

```bash
python3 - <<'PY'
import json
from pathlib import Path

from factory.spec_ingest import ingest_normalized_spec

class MockLLMClient:
    def generate_text(self, *, prompt: str, model: str, temperature: float = 0.0, max_tokens=None):
        # Return a normalized spec that satisfies factory/schemas/normalized_game_spec.schema.json
        data = {
            "project_name": "demo_game",
            "platform": "android",
            "orientation": "portrait",
            "genre": "prototype",
            "summary": "demo summary",
            "core_loop": "core loop",
            "player_fantasy": "player fantasy",
            "input_model": {"type": "touch", "rules": ["swipe to move"]},
            "fail_condition": "fail condition",
            "score_model": "score model",
            "difficulty_model": "difficulty model",
            "scenes": [{"name": "Gameplay", "purpose": "play"}],
            "ui": {"screens": ["HUD"], "hud_elements": ["score_label"], "layout_notes": ["simple"]},
            "entities": [{"name": "Player", "role": "player"}],
            "systems": [],
            "out_of_scope": ["none"],
            "acceptance_criteria": ["runs"],
            "open_questions": [],
        }
        return type("LLMResponse", (), {"text": json.dumps(data)})

tmp = Path("artifacts/_tmp_spec_ingest")
tmp.mkdir(parents=True, exist_ok=True)
prd = tmp / "prd.md"
gdd = tmp / "gdd.md"
ui = tmp / "ui.md"
prd.write_text("# PRD\n", encoding="utf-8")
gdd.write_text("# GDD\n", encoding="utf-8")
ui.write_text("# UI\n", encoding="utf-8")

result = ingest_normalized_spec(
    project_name="demo_game",
    prd_path=prd,
    gdd_path=gdd,
    ui_spec_path=ui,
    platform="android",
    orientation="portrait",
    llm_client=MockLLMClient(),
    artifacts_dir=tmp / "out",
)

print("ok:", result["ok"])
print("output_path:", result["output_path"])
if not result["ok"]:
    print(result["validation"])
PY
```

---

## 6) Test: Planner (mock LLM end-to-end, no Godot required)

This tests `factory/planner.py` using a **mock** LLM client returning a schema-valid generation recipe.

```bash
python3 - <<'PY'
import json
from pathlib import Path

from factory.planner import build_generation_recipe

class MockLLMClient:
    def generate_text(self, *, prompt: str, model: str, temperature: float = 0.0, max_tokens=None):
        data = {
            "project_name": "demo_game",
            "starter_template": "demo_template",
            "target_path": "demo_target",
            "scenes_to_create": [
                {"path": "scenes/gameplay.tscn", "root_type": "Node2D", "root_name": "Gameplay", "nodes": []}
            ],
            "scripts_to_create": [{"path": "scripts/gameplay/gameplay_controller.gd", "role": "controller", "scene_owned": True, "dependencies": []}],
            "systems_to_create": [],
            "ui_to_create": [{"scene_path": "scenes/ui/hud.tscn", "purpose": "hud"}],
            "config_files_to_create": [],
            "validation_checks": [{"id": "scene_files_exist", "description": "scenes exist"}],
            "repair_hints": [],
        }
        return type("LLMResponse", (), {"text": json.dumps(data)})

normalized_spec = {
    "project_name": "demo_game",
    "platform": "android",
    "orientation": "portrait",
    "genre": "prototype",
    "core_loop": "core loop",
    "input_model": {"type": "touch", "rules": ["swipe"]},
    "fail_condition": "fail",
    "score_model": "score",
    "difficulty_model": "easy",
    "scenes": [{"name": "Gameplay", "purpose": "play"}],
    "ui": {"screens": ["HUD"], "hud_elements": ["score_label"], "layout_notes": []},
    "entities": [{"name": "Player", "role": "player"}],
    "systems": [],
    "out_of_scope": ["none"],
    "acceptance_criteria": ["runs"],
    "open_questions": [],
}

out_dir = Path("artifacts/_tmp_planner")
out_dir.mkdir(parents=True, exist_ok=True)

result = build_generation_recipe(
    normalized_spec=normalized_spec,
    starter_template="demo_template",
    target_path="demo_target",
    llm_client=MockLLMClient(),
    artifacts_dir=out_dir,
)

print("ok:", result["ok"])
print("output_path:", result["output_path"])
if not result["ok"]:
    print(result["validation"])
PY
```

---

## 7) Test: Scaffolder (template copy + artifact dirs)

Since the repo doesn’t include a real Godot starter template, this command creates a **minimal fake** starter template that satisfies the scaffolder’s baseline checks.

```bash
python3 - <<'PY'
from pathlib import Path
from factory.project_scaffolder import scaffold_project

repo_root = Path(".").resolve()
fake_template = repo_root / "artifacts/_tmp_fake_godot_starter"
target = repo_root / "artifacts/_tmp_scaffold_target" / "demo_game"
artifacts_root = repo_root / "artifacts"

# Create minimal baseline template structure.
fake_template.mkdir(parents=True, exist_ok=True)
(fake_template / "scenes").mkdir(exist_ok=True)
(fake_template / "scripts").mkdir(exist_ok=True)
(fake_template / "systems").mkdir(exist_ok=True)
(fake_template / "docs").mkdir(exist_ok=True)

(fake_template / "project.godot").write_text("# project.godot\n", encoding="utf-8")
(fake_template / "AGENTS.md").write_text("# Agents\n", encoding="utf-8")
(fake_template / "docs" / "conventions.md").write_text("# conventions\n", encoding="utf-8")
(fake_template / "docs" / "implementation-brief.md").write_text("# brief\n", encoding="utf-8")

result = scaffold_project(
    starter_template=fake_template,
    target_path=target,
    project_name="demo_game",
    overwrite=True,
    artifacts_root=artifacts_root,
    run_id="run_001",
    save_summary=True,
)

print("ok:", result["ok"])
print("target_path:", result["target_path"])
print("artifacts.run_artifacts_dir:", result["artifacts"]["run_artifacts_dir"])
print("summary_path:", result.get("summary_path"))
PY
```

---

## 8) Test: Generator (recipe -> stub file creation, no Godot/MCP required)

This runs `factory/generator.py` with `executor=None` (so it uses filesystem stubs).

```bash
python3 - <<'PY'
import json
from pathlib import Path

from factory.generator import generate_project_from_recipe

project_root = Path("artifacts/_tmp_generated_project/demo_game")
project_root.mkdir(parents=True, exist_ok=True)

recipe = {
    "project_name": "demo_game",
    "starter_template": "demo_template",
    "target_path": str(project_root),
    "scenes_to_create": [
        {"path": "scenes/gameplay.tscn", "root_type": "Node2D", "root_name": "Gameplay", "nodes": []}
    ],
    "scripts_to_create": [{"path": "scripts/entities/player.gd", "role": "player", "scene_owned": True, "dependencies": []}],
    "systems_to_create": [{"path": "systems/score_system.gd", "role": "score"}],
    "ui_to_create": [{"scene_path": "scenes/ui/hud.tscn", "purpose": "hud"}],
    "config_files_to_create": [{"path": "config/milestone.json", "purpose": "milestone"}],
    "validation_checks": [{"id": "scene_files_exist", "description": "scenes exist"}],
    "repair_hints": [],
}

result = generate_project_from_recipe(
    project_name="demo_game",
    project_root=project_root,
    generation_recipe=recipe,
    executor=None,
    dry_run=False,
    artifacts_dir=Path("artifacts/_tmp_generated_project/demo_game_artifacts"),
    save_result=True,
)

print("ok:", result["ok"])
print("created_paths:", len(result["created_paths"]))
print("errors:", result["errors"])
print("result_path:", result.get("result_path"))
PY
```

---

## 9) Test: Validator (bounded runtime via stub executor)

Because Godot CLI likely isn’t available, this uses a stub executor that returns `ok=True` for runtime checks.

```bash
python3 - <<'PY'
from pathlib import Path
from factory.validator import validate_project

class StubExecutor:
    def run_project(self, *, headless=None, extra_args=None, timeout_seconds=None):
        # normalized shape expected by validator
        return {"ok": True, "action": "run_project", "backend": "cli", "inputs": {}, "output": {"stderr": ""}, "error": None}

    def get_debug_output(self, *, last_n=10):
        return {"ok": True, "output": {"actions": []}}

project_root = Path("artifacts/_tmp_generated_project/demo_game")

recipe = {
    "project_name": "demo_game",
    "starter_template": "demo_template",
    "target_path": str(project_root),
    "scenes_to_create": [{"path": "scenes/gameplay.tscn", "root_type": "Node2D", "root_name": "Gameplay", "nodes": []}],
    "scripts_to_create": [{"path": "scripts/entities/player.gd", "role": "player", "scene_owned": True, "dependencies": []}],
    "systems_to_create": [{"path": "systems/score_system.gd", "role": "score"}],
    "ui_to_create": [{"scene_path": "scenes/ui/hud.tscn", "purpose": "hud"}],
    "config_files_to_create": [{"path": "config/milestone.json", "purpose": "milestone"}],
    "validation_checks": [{"id": "scene_files_exist", "description": "scenes exist"}],
}

report = validate_project(
    project_name="demo_game",
    project_root=project_root,
    generation_recipe=recipe,
    executor=StubExecutor(),
    bounded_run_seconds=1,
    strict=False,
    artifacts_dir=Path("artifacts/_tmp_generated_project/demo_game_artifacts"),
)

print("ok:", report["ok"])
print("status:", report["validation_report"]["status"])
print("output_path:", report["output_path"])
PY
```

---

## 10) Test: Repair Loop (bounded auto-repair of missing files)

This feeds the repair loop a validation report that contains a *missing_scene* error and verifies it creates the missing scene stub.

```bash
python3 - <<'PY'
from pathlib import Path

from factory.repair_loop import run_repair_loop

class StubExecutor:
    def run_project(self, *, headless=None, extra_args=None, timeout_seconds=None):
        return {"ok": True, "action": "run_project", "backend": "cli", "inputs": {}, "output": {"stderr": ""}, "error": None}

    def get_debug_output(self, *, last_n=10):
        return {"ok": True, "output": {"actions": []}}

project_root = Path("artifacts/_tmp_repair_target/demo_game")
project_root.mkdir(parents=True, exist_ok=True)

recipe = {
    "project_name": "demo_game",
    "starter_template": "demo_template",
    "target_path": str(project_root),
    "scenes_to_create": [{"path": "scenes/gameplay.tscn", "root_type": "Node2D", "root_name": "Gameplay", "nodes": []}],
    "scripts_to_create": [],
    "systems_to_create": [],
    "ui_to_create": [],
    "config_files_to_create": [],
    "validation_checks": [{"id": "required_scenes_exist", "description": "scene files exist"}],
}

validation_report = {
    "project_name": "demo_game",
    "status": "fail",
    "checks": [],
    "errors": [
        {"type": "missing_scene", "message": "Required file missing: scenes/gameplay.tscn", "file": "scenes/gameplay.tscn", "suggested_category": "file_presence"}
    ],
    "warnings": [],
}

out_dir = Path("artifacts/_tmp_repair_target/artifacts")
out_dir.mkdir(parents=True, exist_ok=True)

repair = run_repair_loop(
    project_name="demo_game",
    project_root=project_root,
    generation_recipe=recipe,
    validation_report=validation_report,
    executor=StubExecutor(),
    max_attempts=2,
    bounded_run_seconds=1,
    strict=False,
    artifacts_dir=out_dir,
)

print("result_status:", repair["result_status"])
print("remaining_issues:", repair["remaining_issues"])
print("repair_report_path:", repair.get("output_path"))
PY
```

---

## 11) Test: Full Runner (end-to-end, fully mocked for LLM + runtime)

This command runs the full pipeline synchronously, but with:

- a mock LLM client (no real model calls)
- a stub executor (no Godot CLI required)
- a minimal fake starter template (so scaffolding can run)

This is the best way to validate the orchestration wiring.

```bash
python3 - <<'PY'
import json
from pathlib import Path

from factory.runner import run_factory

class MockLLMClient:
    def generate_text(self, *, prompt: str, model: str, temperature: float = 0.0, max_tokens=None):
        # Heuristic: spec ingest template asks to convert PRD/GDD/UI to normalized JSON
        if "Convert the following PRD, GDD, and UI spec" in prompt or "PRD, GDD, and UI documents" in prompt:
            normalized = {
                "project_name": "demo_game",
                "platform": "android",
                "orientation": "portrait",
                "genre": "prototype",
                "summary": "demo summary",
                "core_loop": "core loop",
                "player_fantasy": "fantasy",
                "input_model": {"type": "touch", "rules": ["swipe"]},
                "fail_condition": "fail",
                "score_model": "score",
                "difficulty_model": "easy",
                "scenes": [{"name": "Gameplay", "purpose": "play"}],
                "ui": {"screens": ["HUD"], "hud_elements": ["score_label"], "layout_notes": []},
                "entities": [{"name": "Player", "role": "player"}],
                "systems": [],
                "out_of_scope": ["none"],
                "acceptance_criteria": ["runs"],
                "open_questions": [],
            }
            return type("LLMResponse", (), {"text": json.dumps(normalized)})

        # Planner template converts normalized spec into generation recipe JSON
        recipe = {
            "project_name": "demo_game",
            "starter_template": "FAKE_TEMPLATE",
            "target_path": "TARGET",
            "scenes_to_create": [{"path": "scenes/gameplay.tscn", "root_type": "Node2D", "root_name": "Gameplay", "nodes": []}],
            "scripts_to_create": [{"path": "scripts/gameplay/gameplay_controller.gd", "role": "controller", "scene_owned": True, "dependencies": []}],
            "systems_to_create": [],
            "ui_to_create": [],
            "config_files_to_create": [],
            "validation_checks": [{"id": "scene_files_exist", "description": "scenes exist"}],
            "repair_hints": [],
        }
        return type("LLMResponse", (), {"text": json.dumps(recipe)})


class StubExecutor:
    # Used by generator (MCP-style methods) when executor is passed in.
    def __init__(self, project_root: Path):
        self._project_root = Path(project_root)

    def create_scene(self, *, scene_path: str, root_type: str, root_name: str):
        # Minimal stub: validator currently checks for file existence.
        # This is intentionally filesystem-only so runner can run without Godot.
        abs_path = self._project_root / scene_path
        abs_path.parent.mkdir(parents=True, exist_ok=True)
        abs_path.write_text(f"[gd_scene format=3]\n[node name=\"{root_name}\" type=\"{root_type}\"]\n", encoding="utf-8")

    def add_node(self, *, scene_path: str, node_name: str, node_type: str, parent_path: str = "."):
        pass

    def attach_script(self, *, scene_path: str, node_name: str, script_path: str):
        pass

    def save_scene(self, *, scene_path: str):
        pass

    # Used by validator runtime checks.
    def run_project(self, *, headless=None, extra_args=None, timeout_seconds=None):
        return {"ok": True, "action": "run_project", "backend": "cli", "inputs": {}, "output": {"stderr": ""}, "error": None}

    def get_debug_output(self, *, last_n=10):
        return {"ok": True, "output": {"actions": []}}


repo_root = Path(".").resolve()
fake_template = repo_root / "artifacts/_tmp_runner_fake_starter"
fake_template.mkdir(parents=True, exist_ok=True)
(fake_template / "scenes").mkdir(exist_ok=True)
(fake_template / "scripts").mkdir(exist_ok=True)
(fake_template / "systems").mkdir(exist_ok=True)
(fake_template / "docs").mkdir(exist_ok=True)
(fake_template / "project.godot").write_text("# project.godot\n", encoding="utf-8")
(fake_template / "AGENTS.md").write_text("# Agents\n", encoding="utf-8")
(fake_template / "docs" / "conventions.md").write_text("# conventions\n", encoding="utf-8")
(fake_template / "docs" / "implementation-brief.md").write_text("# brief\n", encoding="utf-8")

target_output_path = repo_root / "artifacts/_tmp_runner_target/demo_game"

# Create temporary PRD/GDD/UI inputs expected by spec ingest.
docs_dir = repo_root / "artifacts/_tmp_runner_docs"
docs_dir.mkdir(parents=True, exist_ok=True)
(docs_dir / "prd.md").write_text("# PRD\n", encoding="utf-8")
(docs_dir / "gdd.md").write_text("# GDD\n", encoding="utf-8")
(docs_dir / "ui.md").write_text("# UI\n", encoding="utf-8")

result = run_factory(
    project_name="demo_game",
    prd_path=repo_root / "artifacts/_tmp_runner_docs/prd.md",
    gdd_path=repo_root / "artifacts/_tmp_runner_docs/gdd.md",
    ui_spec_path=repo_root / "artifacts/_tmp_runner_docs/ui.md",
    starter_template=fake_template,
    target_output_path=target_output_path,
    platform="android",
    orientation="portrait",
    overwrite=True,
    artifacts_root=repo_root / "artifacts/_tmp_runner_artifacts",
    run_id="run_001",
    llm_client=MockLLMClient(),
    executor=StubExecutor(project_root=target_output_path),
    enable_repair=False,
    bounded_validation_seconds=1,
    strict_validation=False,
)

print("runner ok:", result["ok"])
print("run_summary:", result["failures"][:1] if result["failures"] else "none")
print("stages keys:", list(result["stages"].keys()))
PY
```

Notes:

- This runner snippet writes temporary PRD/GDD/UI markdown files under `artifacts/_tmp_runner_docs/`.
- If you want to use your own real design docs, replace `prd_path/gdd_path/ui_spec_path` in the snippet.

---
## 11) Full Runner (JavaScript) with Godot

Run the JS pipeline end-to-end using the real LLM + headless Godot validation.

```bash
node factory-js/FactoryRunner.js \
  --project-name "demo_game" \
  --prd-path "./path/to/prd.md" \
  --gdd-path "./path/to/gdd.md" \
  --ui-spec-path "./path/to/ui.md" \
  --starter-template "./path/to/godot_starter_template_dir" \
  --target-output-path "./artifacts/js_demo_game" \
  --platform android \
  --orientation "portrait" \
  --overwrite \
  --artifacts-root "./artifacts" \
  --run-id "run_001" \
  --llm-backend llama \
  --llm-host "127.0.0.1" \
  --llm-port 11434 \
  --model-name "gpt-oss-20b" \
  --bounded-validation-seconds 30 \
  --enable-repair \
  --max-repair-attempts 3
```

Expected artifacts (under `artifacts/<project-name>/<run-id>/reports/`):
- `run_summary.json`
- `validation_report.json`
- `repair_report.json` (only if `--enable-repair` and validation fails)

Starter template requirements (for scaffolding):
- Must include files: `project.godot`, `AGENTS.md`, `docs/conventions.md`, `docs/implementation-brief.md`
- Must include dirs: `scenes/`, `scripts/`, `systems/`, `docs/`

---

## 12) Backend / Frontend Commands (Future / Planned)

Planned sections to add as those subsystems are introduced:

### Godot / MCP Integration

GODOT_MCP_ENABLED=true \
GODOT_MCP_STARTUP=local \
GODOT_MCP_NODE_COMMAND=node \
GODOT_MCP_LOCAL_ENTRY="/Users/ishanharshaddiwekar/GodotProjects/godot-mcp/build/index.js" \
GODOT_MCP_WORKING_DIRECTORY="/Users/ishanharshaddiwekar/GodotProjects/godot-mcp" \
GODOT_MCP_DEBUG=true \
node "/Users/ishanharshaddiwekar/Project/GameGen-Conversational-AI-workspace/backend/factory-js/runEditMode.js" \
  --project-root "/Users/ishanharshaddiwekar/Project/GameGen-Conversational-AI-workspace/backend/artifacts/MyProject1/run_002/project" \
  --source-of-truth-dir "/Users/ishanharshaddiwekar/Project/GameGen-Conversational-AI-workspace/backend/artifacts/MyProject1/run_002/intermediate" \
  --bounded-validation-seconds 10

### Frontend / Web Portal

- Planned: run any web portal server build/dev commands

### CI

- Planned: add `pre-commit`, `pytest`, and pipeline commands once tests exist

