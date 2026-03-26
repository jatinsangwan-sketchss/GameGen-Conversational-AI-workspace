/**
 * TerminalEditModeRunner
 * ------------------------
 * Interactive terminal loop for edit-mode conversation on an existing
 * generated Godot project.
 *
 * Flow:
 * - Open existing project workspace (ProjectLoader) once.
 * - Create an in-memory ConversationSession.
 * - REPL-style loop:
 *   - `help` prints commands
 *   - `status` prints session + latest validation summary
 *   - `validate` runs bounded v1 validation without applying changes
 *   - any other input is treated as a change request:
 *       - call ProjectConversationOrchestrator (planner+executor+validation)
 *       - print result
 *       - reload source-of-truth snapshots into the session
 *   - `exit` stops the loop
 *
 * This runner does NOT implement planning/execution logic itself; it only
 * orchestrates and prints events. It also does not persist runtime logs to
 * disk by default (only in-memory).
 */

import readline from "node:readline";
import path from "node:path";

import { GodotExecutor } from "../godot/GodotExecutor.js";
import { loadProjectWorkspace } from "./ProjectLoader.js";
import { SourceOfTruthManager } from "./SourceOfTruthManager.js";
import { ConversationSession } from "./ConversationSession.js";
import { runProjectConversationEdit } from "./ProjectConversationOrchestrator.js";
import { validateProject } from "../validation/validator.js";

function isoNow() {
  return new Date().toISOString();
}

function printEvent(event) {
  if (!event || typeof event !== "object") return;
  const { type, stage, message, timestamp, data } = event;
  const prefix = `${timestamp ?? isoNow()} [${type ?? "event"}]${stage ? ` ${stage}` : ""}`;
  if (data !== undefined) {
    // Keep console output readable: avoid dumping extremely large objects.
    const safe =
      data && typeof data === "object"
        ? JSON.stringify(data, null, 0).slice(0, 400)
        : String(data).slice(0, 400);
    console.log(`${prefix}: ${message ?? ""} ${safe ? `(${safe})` : ""}`);
  } else {
    console.log(`${prefix}: ${message ?? ""}`);
  }
}

function resolveExecutor({ projectRoot, godotCliPath = "godot" }) {
  // MCP client is optional; this terminal runner focuses on v1 executor+CLI.
  return new GodotExecutor({
    projectRoot,
    mcpClient: null,
    godotCliPath,
    defaultHeadless: true,
  });
}

function normalizeArgs(argv) {
  const get = (flag) => {
    const idx = argv.indexOf(flag);
    if (idx === -1) return null;
    return argv[idx + 1] ?? null;
  };
  const has = (flag) => argv.includes(flag);
  return {
    projectRoot: get("--project-root"),
    sourceOfTruthDir: get("--source-of-truth-dir"),
    artifactsRoot: get("--artifacts-root"),
    projectId: get("--project-id"),
    runId: get("--run-id"),

    godotCliPath: get("--godot-cli") || "godot",

    boundedValidationSeconds: Number(get("--bounded-validation-seconds") ?? 5),
    strictValidation: has("--strict-validation"),

    llmBackend: get("--llm-backend") || null,
    llmHost: get("--llm-host") || "127.0.0.1",
    llmPort: Number(get("--llm-port") || 11434),
    llmTimeoutSeconds: Number(get("--llm-timeout-seconds") || 120),
    modelName: get("--model-name") || "gpt-oss-20b",
  };
}

async function loadInitialSession(args) {
  const workspaceRes = await loadProjectWorkspace({
    projectId: args.projectId,
    projectRoot: args.projectRoot,
    sourceOfTruthDir: args.sourceOfTruthDir,
    artifactsRoot: args.artifactsRoot,
    runId: args.runId,
    validateNormalizedAndRecipe: true,
    requireProjectState: true,
  });

  if (!workspaceRes?.ok) {
    throw new Error(`Failed to open project: ${workspaceRes?.error ?? "unknown error"}`);
  }

  const session = new ConversationSession({ workspace: workspaceRes, maxTurns: 20 });
  const sotManager = new SourceOfTruthManager({ sourceOfTruthDir: workspaceRes.source_of_truth_dir });
  return { workspaceRes, session, sotManager };
}

function printHelp() {
  console.log("");
  console.log("Edit mode commands:");
  console.log("  help                Show this help");
  console.log("  status              Show session/project + latest validation summary");
  console.log("  validate            Run bounded validation (no changes)");
  console.log("  exit                Quit edit mode");
  console.log("");
  console.log("Anything else is treated as a conversation change request.");
  console.log("");
}

async function runValidate({ session, executor, boundedValidationSeconds, strictValidation }) {
  const workspace = session.getWorkspace();
  const projectRoot = workspace.project_root;
  const generationRecipe = session.sourceOfTruth.generation_recipe ?? workspace.generationRecipe ?? workspace.generation_recipe ?? null;
  const normalizedGameSpec = session.sourceOfTruth.normalized_game_spec ?? workspace.normalizedGameSpec ?? workspace.normalized_game_spec ?? null;

  if (!generationRecipe || !normalizedGameSpec) {
    return { ok: false, error: "Cannot validate: missing generationRecipe or normalizedGameSpec in session." };
  }

  const projectName = normalizedGameSpec.project_name ?? workspace.project_name ?? "unknown_project";

  // Use artifactsDir=null so validation does not persist runtime validation output.
  return validateProject({
    projectName,
    projectRoot,
    generationRecipe,
    executor,
    boundedRunSeconds: boundedValidationSeconds,
    strict: strictValidation,
    artifactsDir: null,
  });
}

export async function runTerminalEditMode({
  projectRoot = null,
  sourceOfTruthDir = null,
  artifactsRoot = null,
  projectId = null,
  runId = null,
  godotCliPath = "godot",

  boundedValidationSeconds = 5,
  strictValidation = false,

  llmConfig = null,
  modelName = "gpt-oss-20b",

  executor = null,
  validator = null,
  onEvent = null,
} = {}) {
  // Open project once, start REPL loop.
  const { workspaceRes, session, sotManager } = await loadInitialSession({
    projectRoot,
    sourceOfTruthDir,
    artifactsRoot,
    projectId,
    runId,
  });

  const resolvedExecutor =
    executor ??
    resolveExecutor({ projectRoot: workspaceRes.project_root, godotCliPath });

  console.log(`Opened project: ${workspaceRes.normalizedGameSpec?.project_name ?? workspaceRes.normalized_game_spec?.project_name ?? "unknown"} `);
  console.log("Type `help` for commands.");

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const question = (q) => new Promise((resolve) => rl.question(q, resolve));

  // We keep the live session state only in memory.
  while (true) {
    const text = await question("> ");
    const request = String(text ?? "").trim();
    if (!request) continue;

    const cmd = request.toLowerCase();
    if (cmd === "exit" || cmd === "quit") {
      rl.close();
      return { ok: true, session, workspace: session.getWorkspace() };
    }
    if (cmd === "help") {
      printHelp();
      continue;
    }
    if (cmd === "status") {
      const ws = session.getWorkspace();
      const name = session.sourceOfTruth.normalized_game_spec?.project_name ?? ws.normalizedGameSpec?.project_name ?? null;
      const latest = session.getLatestValidation();
      const status = latest?.validation_report?.status ?? null;
      console.log(`Project: ${name ?? ws.project_name ?? "unknown"}`);
      console.log(`Turns: ${session.turns?.length ?? 0}`);
      console.log(`Latest validation: ${status ?? "unknown"}`);
      continue;
    }
    if (cmd === "validate") {
      console.log("Running bounded validation...");
      const validationRes = await runValidate({
        session,
        executor: resolvedExecutor,
        boundedValidationSeconds,
        strictValidation,
      });
      if (!validationRes?.ok) {
        session.setLatestValidation(validationRes);
        console.log("Validation FAILED.");
      } else {
        session.setLatestValidation(validationRes);
        console.log("Validation PASSED.");
      }
      continue;
    }

    // Normal edit request: planner -> executor -> validation.
    // We rely on ProjectConversationOrchestrator to handle sequencing.
    console.log("Planning + executing edit...");

    const events = [];
    const orchestrationRes = await runProjectConversationEdit({
      projectRoot: session.getProjectRoot(),
      sourceOfTruthDir: session.getSourceOfTruthRefs().source_of_truth_dir,
      userRequestText: request,
      llmConfig,
      modelName,
      executor: resolvedExecutor,
      validator,
      boundedValidationSeconds,
      strictValidation,
      validateNormalizedAndRecipe: true,
      requireProjectState: true,
      onEvent: (evt) => {
        events.push(evt);
        printEvent(evt);
        if (typeof onEvent === "function") onEvent(evt);
      },
    });

    if (!orchestrationRes?.ok) {
      session.addTurn({
        userRequestText: request,
        plan: orchestrationRes.plan ?? null,
        execution: orchestrationRes.execution ?? null,
        validation: orchestrationRes.execution?.validation_result ?? null,
        metadata: { error: orchestrationRes.error ?? "unknown_error" },
      });
      console.log("Edit FAILED.");
      continue;
    }

    // Reload canonical artifacts into session snapshots.
    const newSpec = sotManager.loadNormalizedSpec({ required: true });
    const newRecipe = sotManager.loadGenerationRecipe({ required: true });
    const newState = sotManager.loadProjectState({ required: true });

    const specRes = await newSpec;
    const recipeRes = await newRecipe;
    const stateRes = await newState;

    // Update session state only if reload succeeded.
    if (specRes.ok || recipeRes.ok || stateRes.ok) {
      session.updateSourceOfTruth({
        normalizedGameSpec: specRes.ok ? specRes.data : undefined,
        generationRecipe: recipeRes.ok ? recipeRes.data : undefined,
        projectState: stateRes.ok ? stateRes.data : undefined,
      });
    }

    const execValidation = orchestrationRes.execution?.validation_result ?? null;
    session.setLatestValidation(execValidation);

    session.addTurn({
      userRequestText: request,
      plan: orchestrationRes.plan,
      execution: orchestrationRes.execution,
      validation: execValidation,
      metadata: { events_count: events.length },
    });

    const finalStatus = execValidation?.validation_report?.status ?? null;
    console.log(`Edit OK. Validation: ${finalStatus ?? "unknown"}`);
  }
}

function main() {
  const args = normalizeArgs(process.argv);

  // Optional: only create llmConfig if user supplied llm-backend.
  const llmConfig =
    args.llmBackend != null
      ? {
          backend: args.llmBackend,
          llama: {
            host: args.llmHost,
            port: args.llmPort,
            timeout_seconds: args.llmTimeoutSeconds,
          },
        }
      : null;

  runTerminalEditMode({
    projectRoot: args.projectRoot,
    sourceOfTruthDir: args.sourceOfTruthDir,
    artifactsRoot: args.artifactsRoot,
    projectId: args.projectId,
    runId: args.runId,

    godotCliPath: args.godotCliPath,

    boundedValidationSeconds: args.boundedValidationSeconds,
    strictValidation: args.strictValidation,

    llmConfig,
    modelName: args.modelName,
  }).catch((err) => {
    console.error("TerminalEditModeRunner failed:", err);
    process.exit(1);
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

