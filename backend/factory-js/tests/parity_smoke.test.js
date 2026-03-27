import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { ingestNormalizedSpec } from "../spec_ingest.js";
import { buildGenerationRecipe } from "../planner.js";
import { generateProjectFromRecipe } from "../generator.js";
import { validateProject } from "../validator.js";
import { runFactory } from "../runner.js";

const tmp = path.resolve("artifacts/_tmp_js_tests");

function writeText(p, content) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, "utf-8");
}

test("spec_ingest parses + validates normalized spec (mock llm)", async () => {
  const docsDir = path.join(tmp, "docs_ingest");
  writeText(path.join(docsDir, "prd.md"), "# PRD\n");
  writeText(path.join(docsDir, "gdd.md"), "# GDD\n");
  writeText(path.join(docsDir, "ui.md"), "# UI\n");

  const normalized = {
    project_name: "demo_game",
    platform: "android",
    orientation: "portrait",
    genre: "prototype",
    summary: "demo summary",
    core_loop: "core loop",
    player_fantasy: "fantasy",
    input_model: { type: "touch", rules: ["swipe to move"] },
    fail_condition: "fail",
    score_model: "score model",
    difficulty_model: "difficulty model",
    scenes: [{ name: "Gameplay", purpose: "play" }],
    ui: { screens: ["HUD"], hud_elements: ["score_label"], layout_notes: [] },
    entities: [{ name: "Player", role: "player" }],
    systems: [],
    out_of_scope: ["none"],
    acceptance_criteria: ["runs"],
    open_questions: [],
  };

  const mockLLM = {
    async generateText() {
      return { text: JSON.stringify(normalized) };
    },
  };

  const out = await ingestNormalizedSpec({
    projectName: "demo_game",
    prdPath: path.join(docsDir, "prd.md"),
    gddPath: path.join(docsDir, "gdd.md"),
    uiSpecPath: path.join(docsDir, "ui.md"),
    platform: "android",
    orientation: "portrait",
    llmClient: mockLLM,
    artifactsDir: path.join(tmp, "out_ingest"),
  });

  assert.equal(out.ok, true);
  assert.ok(out.output_path);
  assert.equal(out.normalized_spec.project_name, "demo_game");
});

test("planner parses + validates generation recipe (mock llm)", async () => {
  const recipeNormalized = {
    project_name: "demo_game",
    platform: "android",
    orientation: "portrait",
    genre: "prototype",
    core_loop: "core loop",
    player_fantasy: "fantasy",
    input_model: { type: "touch", rules: ["swipe to move"] },
    fail_condition: "fail",
    score_model: "score model",
    difficulty_model: "difficulty model",
    scenes: [{ name: "Gameplay", purpose: "play" }],
    ui: { screens: ["HUD"], hud_elements: ["score_label"], layout_notes: [] },
    entities: [{ name: "Player", role: "player" }],
    systems: [],
    out_of_scope: ["none"],
    acceptance_criteria: ["runs"],
    open_questions: [],
  };

  const mockLLM = {
    async generateText() {
      const recipe = {
        project_name: "demo_game",
        starter_template: "demo_template",
        target_path: "target",
        scenes_to_create: [
          {
            path: "scenes/gameplay.tscn",
            root_type: "Node2D",
            root_name: "Gameplay",
            nodes: [],
          },
        ],
        scripts_to_create: [
          {
            path: "scripts/gameplay/gameplay_controller.gd",
            role: "controller",
            scene_owned: true,
            dependencies: [],
          },
        ],
        systems_to_create: [],
        ui_to_create: [{ scene_path: "scenes/ui/hud.tscn", purpose: "hud" }],
        config_files_to_create: [],
        validation_checks: [{ id: "scene_files_exist", description: "scenes exist" }],
        repair_hints: [],
      };
      return { text: JSON.stringify(recipe) };
    },
  };

  const out = await buildGenerationRecipe({
    normalizedSpec: recipeNormalized,
    starterTemplate: "demo_template",
    targetPath: "target",
    llmClient: mockLLM,
    artifactsDir: path.join(tmp, "out_planner"),
  });

  assert.equal(out.ok, true);
  assert.ok(out.output_path);
  assert.equal(out.generation_recipe.project_name, "demo_game");
});

test("generator + validator create + validate files (no godot)", async () => {
  const outDir = path.join(tmp, "out_genval");
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  const projectRoot = path.join(outDir, "project");
  fs.mkdirSync(projectRoot, { recursive: true });

  const executorStub = {
    async runProject() {
      return {
        ok: true,
        action: "run_project",
        backend: "stub",
        inputs: {},
        output: { stderr: "" },
        error: null,
      };
    },
    getDebugOutput() {
      return { ok: true, output: { actions: [] } };
    },
  };

  const recipe = {
    project_name: "demo_game",
    starter_template: "demo_template",
    target_path: "target",
    scenes_to_create: [
      { path: "scenes/gameplay.tscn", root_type: "Node2D", root_name: "Gameplay", nodes: [] },
    ],
    scripts_to_create: [
      {
        path: "scripts/gameplay/gameplay_controller.gd",
        role: "controller",
        scene_owned: true,
        dependencies: [],
      },
    ],
    systems_to_create: [],
    ui_to_create: [],
    config_files_to_create: [],
    validation_checks: [{ id: "scene_files_exist", description: "scenes exist" }],
    repair_hints: [],
  };

  const gen = generateProjectFromRecipe({
    projectName: "demo_game",
    projectRoot,
    generationRecipe: recipe,
    executor: executorStub,
    dryRun: false,
    artifactsDir: outDir,
    saveResult: false,
  });

  assert.equal(gen.ok, true);
  assert.ok(fs.existsSync(path.join(projectRoot, "scenes", "gameplay.tscn")));
  assert.ok(
    fs.existsSync(path.join(projectRoot, "scripts", "gameplay", "gameplay_controller.gd"))
  );

  const val = await validateProject({
    projectName: "demo_game",
    projectRoot,
    generationRecipe: recipe,
    executor: executorStub,
    boundedRunSeconds: 1,
    strict: false,
    artifactsDir: outDir,
  });

  assert.equal(val.ok, true);
  assert.equal(val.validation_report.status, "pass");
  assert.ok(fs.existsSync(path.join(outDir, "validation_report.json")));
});

test("runner repair loop fills missing files (dryRun)", async () => {
  const base = path.join(tmp, "out_runner_repair");
  fs.rmSync(base, { recursive: true, force: true });
  fs.mkdirSync(base, { recursive: true });

  const docsDir = path.join(base, "docs");
  fs.mkdirSync(docsDir, { recursive: true });
  fs.writeFileSync(path.join(docsDir, "prd.md"), "# PRD\n");
  fs.writeFileSync(path.join(docsDir, "gdd.md"), "# GDD\n");
  fs.writeFileSync(path.join(docsDir, "ui.md"), "# UI\n");

  const starter = path.join(base, "starter");
  fs.mkdirSync(starter, { recursive: true });
  fs.mkdirSync(path.join(starter, "scenes"), { recursive: true });
  fs.mkdirSync(path.join(starter, "scripts"), { recursive: true });
  fs.mkdirSync(path.join(starter, "systems"), { recursive: true });
  fs.mkdirSync(path.join(starter, "docs"), { recursive: true });
  fs.writeFileSync(path.join(starter, "project.godot"), "# project.godot\n");
  fs.writeFileSync(path.join(starter, "AGENTS.md"), "# Agents\n");
  fs.writeFileSync(path.join(starter, "docs", "conventions.md"), "# conventions\n");
  fs.writeFileSync(
    path.join(starter, "docs", "implementation-brief.md"),
    "# brief\n"
  );

  const targetOutput = path.join(base, "target", "demo_game");

  const normalized = {
    project_name: "demo_game",
    platform: "android",
    orientation: "portrait",
    genre: "prototype",
    summary: "demo summary",
    core_loop: "core loop",
    player_fantasy: "fantasy",
    input_model: { type: "touch", rules: ["swipe to move"] },
    fail_condition: "fail",
    score_model: "score model",
    difficulty_model: "difficulty model",
    scenes: [{ name: "Gameplay", purpose: "play" }],
    ui: { screens: ["HUD"], hud_elements: ["score_label"], layout_notes: [] },
    entities: [{ name: "Player", role: "player" }],
    systems: [],
    out_of_scope: ["none"],
    acceptance_criteria: ["runs"],
    open_questions: [],
  };

  const mockLLM = {
    async generateText({ prompt, model }) {
      if (prompt.includes("generation_recipe") || prompt.toLowerCase().includes("generation recipe")) {
        const recipe = {
          project_name: "demo_game",
          starter_template: "starter",
          target_path: "target",
          scenes_to_create: [
            { path: "scenes/gameplay.tscn", root_type: "Node2D", root_name: "Gameplay", nodes: [] },
          ],
          scripts_to_create: [
            { path: "scripts/gameplay/gameplay_controller.gd", role: "controller", scene_owned: true, dependencies: [] },
          ],
          systems_to_create: [],
          ui_to_create: [],
          config_files_to_create: [],
          validation_checks: [{ id: "scene_files_exist", description: "scenes exist" }],
          repair_hints: [],
        };
        return { text: JSON.stringify(recipe), backend: "mock", model };
      }
      return { text: JSON.stringify(normalized), backend: "mock", model };
    },
  };

  const executorStub = {
    async runProject() {
      return {
        ok: true,
        action: "run_project",
        backend: "stub",
        inputs: {},
        output: { stderr: "" },
        error: null,
      };
    },
    getDebugOutput() {
      return { ok: true, output: { actions: [] } };
    },
  };

  const result = await runFactory({
    projectName: "demo_game",
    prdPath: path.join(docsDir, "prd.md"),
    gddPath: path.join(docsDir, "gdd.md"),
    uiSpecPath: path.join(docsDir, "ui.md"),
    starterTemplate: starter,
    targetOutputPath: targetOutput,
    platform: "android",
    orientation: "portrait",
    overwrite: true,
    artifactsRoot: path.join(base, "artifacts"),
    runId: "run_001",
    llmClient: mockLLM,
    executor: executorStub,
    enableRepair: true,
    boundedValidationSeconds: 1,
    strictValidation: false,
    dryRun: true, // generation does not write files; repair loop should fill them
  });

  assert.equal(result.ok, true);
  assert.equal(result.failures.length, 0);
  assert.equal(result.stages.repair?.result_status, "resolved");
  assert.ok(fs.existsSync(path.join(targetOutput, "scenes", "gameplay.tscn")));
  assert.ok(fs.existsSync(path.join(targetOutput, "scripts", "gameplay", "gameplay_controller.gd")));
});

