/**
 * runEditMode.js
 * ----------------
 * Terminal entrypoint for edit-mode (conversation) on an existing generated
 * Godot project.
 *
 * This file is intentionally thin: it parses CLI args and delegates the
 * interactive loop to `src/conversation/TerminalEditModeRunner.js`.
 */

import { runTerminalEditMode } from "./src/conversation/TerminalEditModeRunner.js";

function parseArg(argv, flag) {
  const idx = argv.indexOf(flag);
  if (idx === -1) return null;
  return argv[idx + 1] ?? null;
}

function hasFlag(argv, flag) {
  return argv.includes(flag);
}

function main() {
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

  runTerminalEditMode({
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
    onEvent: (e) => {
      // TerminalEditModeRunner already prints events; keep this noop hook for future.
    },
  }).catch((err) => {
    console.error("runEditMode failed:", err);
    process.exit(1);
  });
}

main();

