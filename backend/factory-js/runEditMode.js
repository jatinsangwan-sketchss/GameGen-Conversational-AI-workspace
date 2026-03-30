/**
 * runEditMode.js
 * ----------------
 * Terminal entrypoint for edit-mode (conversation) on an existing generated
 * Godot project.
 *
 * This file is intentionally thin: it parses CLI args and delegates the
 * interactive loop to `src/conversation/TerminalEditModeRunner.js`.
 */

import { runTerminalEditMode } from "./core/conversation/TerminalEditModeRunner.js";
import { getGoPeakSessionManager } from "./core/godot/GoPeakSessionManager.js";

function parseArg(argv, flag) {
  const idx = argv.indexOf(flag);
  if (idx === -1) return null;
  return argv[idx + 1] ?? null;
}

function hasFlag(argv, flag) {
  return argv.includes(flag);
}

async function main() {
  const argv = process.argv.slice(2);

  const projectRoot = parseArg(argv, "--project-root");
  if (!projectRoot) {
    console.error("Missing required: --project-root /abs/path/to/project");
    process.exit(1);
  }

  const sourceOfTruthDir = parseArg(argv, "--source-of-truth-dir");
  const artifactsRoot = parseArg(argv, "--artifacts-root");
  const projectId = parseArg(argv, "--project-id");
  const runId = parseArg(argv, "--run-id");

  const boundedValidationSeconds = Number(
    parseArg(argv, "--bounded-validation-seconds") ?? 5
  );
  const strictValidation = hasFlag(argv, "--strict-validation");

  const llmBackend = parseArg(argv, "--llm-backend");
  const llmConfig =
    llmBackend != null
      ? {
          backend: llmBackend,
          llama: {
            host: parseArg(argv, "--llm-host") ?? "127.0.0.1",
            port: Number(parseArg(argv, "--llm-port") ?? 11434),
            timeout_seconds: Number(parseArg(argv, "--llm-timeout-seconds") ?? 120),
          },
        }
      : null;

  const modelName = parseArg(argv, "--model-name") ?? "gpt-oss:20b";

  const executor = null; // TerminalEditModeRunner will construct a default v1 GodotExecutor.

  const sessionManager = getGoPeakSessionManager();
  let cleanupStarted = false;
  const cleanup = async (reason) => {
    if (cleanupStarted) return;
    cleanupStarted = true;
    try {
      const res = await sessionManager.shutdown({ reason });
      console.log("[runEditMode] cleanup", res);
    } catch (err) {
      console.error("[runEditMode] cleanup failed:", err?.stack ?? String(err));
    }
  };

  const bindShutdownSignalHandlers = () => {
    const handleSignal = (signal, code) => {
      console.log(`[runEditMode] received ${signal}, shutting down GoPeak session...`);
      cleanup(`signal:${signal}`).finally(() => process.exit(code));
    };
    process.on("SIGINT", () => handleSignal("SIGINT", 130));
    process.on("SIGTERM", () => handleSignal("SIGTERM", 143));
    process.on("unhandledRejection", (err) => {
      console.error("[runEditMode] unhandledRejection:", err);
      cleanup("unhandledRejection").finally(() => process.exit(1));
    });
    process.on("uncaughtException", (err) => {
      console.error("[runEditMode] uncaughtException:", err);
      cleanup("uncaughtException").finally(() => process.exit(1));
    });
    process.on("exit", (code) => {
      console.log(`[runEditMode] process exit code=${code} cleanup_started=${cleanupStarted}`);
    });
  };
  bindShutdownSignalHandlers();

  try {
    await runTerminalEditMode({
      projectRoot,
      sourceOfTruthDir,
      artifactsRoot,
      projectId,
      runId,
      boundedValidationSeconds,
      strictValidation,
      llmConfig,
      modelName,
      executor,
      sessionManager,
      onEvent: (_e) => {
        // TerminalEditModeRunner already prints events; keep this noop hook for future.
      },
    });
  } catch (err) {
    console.error("runEditMode failed:", err);
    process.exitCode = 1;
  } finally {
    await cleanup("finally");
  }
}

main();

