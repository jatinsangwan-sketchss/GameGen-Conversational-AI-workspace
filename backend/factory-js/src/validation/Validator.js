/**
 * Validator for generated Godot projects (v1).
 *
 * Responsibilities:
 * - Structural presence checks based on generation recipe
 * - v1 acceptance checks derived from recipe.validation_checks
 * - Bounded runtime execution via injected executor (if available)
 * - Debug output inspection (optional)
 * - Produce schema-validated validation_report.json
 */

import fs from "node:fs";
import path from "node:path";

import { loadJsonSchema, validateDataAgainstSchema } from "../../schema_utils.js";

export const DEFAULT_REPORT_SCHEMA_PATH =
  "factory-js/schemas/validation_report.schema.json";
export const DEFAULT_REPORT_FILENAME = "validation_report.json";

export async function validateProject({
  projectName,
  projectRoot,
  generationRecipe,
  executor,
  boundedRunSeconds = 5,
  strict = false,
  schemaPath = DEFAULT_REPORT_SCHEMA_PATH,
  artifactsDir = null,
  projectState = null,
}) {
  ensureObject("generationRecipe", generationRecipe);
  const root = path.resolve(String(projectRoot));
  if (!fs.existsSync(root)) throw new Error(`Project root not found: ${root}`);
  if (!fs.statSync(root).isDirectory()) {
    throw new Error(`Project root must be a directory: ${root}`);
  }

  const checks = [];
  const errors = [];
  const warnings = [];

  runPresenceChecks({
    root,
    recipe: generationRecipe,
    checks,
    errors,
  });

  runAcceptanceChecks({
    recipe: generationRecipe,
    root,
    checks,
    errors,
    warnings,
    strict,
  });

  const runtimeResult = await runBoundedRuntimeCheck({
    executor,
    boundedRunSeconds,
    checks,
    errors,
    warnings,
    strict,
  });

  const debugExcerpt = inspectDebugOutput({ executor, warnings });

  runBootSceneStartupPrintProofChecks({
    root,
    projectState,
    runtimeResult,
    checks,
    errors,
    warnings,
  });

  const report = buildValidationReport({
    projectName,
    checks,
    errors,
    warnings,
    debugExcerpt,
  });

  validateReportSchema({ report, schemaPath });

  let outputPath = null;
  if (artifactsDir != null) {
    outputPath = saveValidationReport({ report, artifactsDir });
  }

  return {
    ok: report.status === "pass",
    validation_report: report,
    runtime_result: runtimeResult,
    output_path: outputPath,
  };
}

function runPresenceChecks({ root, recipe, checks, errors }) {
  checkRecipePaths({
    root,
    entries: safeList(recipe.scenes_to_create),
    pathKey: "path",
    checkId: "required_scenes_exist",
    description: "All required scene files from recipe exist.",
    errorType: "missing_scene",
    category: "file_presence",
    checks,
    errors,
  });

  checkRecipePaths({
    root,
    entries: safeList(recipe.scripts_to_create),
    pathKey: "path",
    checkId: "required_scripts_exist",
    description: "All required script files from recipe exist.",
    errorType: "missing_script",
    category: "file_presence",
    checks,
    errors,
  });

  checkRecipePaths({
    root,
    entries: safeList(recipe.systems_to_create),
    pathKey: "path",
    checkId: "required_systems_exist",
    description: "All required shared system files from recipe exist.",
    errorType: "missing_system",
    category: "file_presence",
    checks,
    errors,
  });

  // Config files are optional in some recipes, so only validate them when
  // `config_files_to_create` is actually provided.
  const configEntries = safeList(recipe.config_files_to_create);
  if (configEntries.length > 0) {
    checkRecipePaths({
      root,
      entries: configEntries,
      pathKey: "path",
      checkId: "required_config_files_exist",
      description: "All required config files from recipe exist.",
      errorType: "missing_config_file",
      category: "file_presence",
      checks,
      errors,
    });
  }
}

function runAcceptanceChecks({
  recipe,
  root,
  checks,
  errors,
  warnings,
  strict,
}) {
  for (const rawCheck of safeList(recipe.validation_checks)) {
    if (!isPlainObject(rawCheck)) continue;
    const id = String(rawCheck.id ?? "").trim() || "unnamed_check";
    const description = String(rawCheck.description ?? "").trim() || "No description";

    const [status, details] = evaluateAcceptanceCheck({
      checkId: id,
      description,
      root,
      recipe,
    });

    // Always push a check record.
    checks.push({ id, description, status, details });

    if (status === "fail") {
      errors.push({
        type: "acceptance_check_failed",
        message: `Validation check failed: ${id}`,
        suggested_category: "acceptance",
      });
    } else if (status === "skip") {
      if (strict) {
        errors.push({
          type: "acceptance_check_skipped",
          message: `Validation check skipped (no v1 evaluator): ${id}`,
          suggested_category: "acceptance",
        });
      } else {
        warnings.push({
          message: `Validation check skipped (no v1 evaluator): ${id}`,
          file: "",
        });
      }
    }
  }
}

function evaluateAcceptanceCheck({ checkId, description, root, recipe }) {
  const text = `${checkId} ${description}`.toLowerCase();
  if (text.includes("scene") && text.includes("exist")) {
    const missing = missingPaths(root, extractPaths(recipe.scenes_to_create, "path"));
    return [missing.length ? "fail" : "pass", missing.length ? `Missing scenes: ${missing.join(", ")}` : "All scene files exist."];
  }
  if (text.includes("script") && text.includes("exist")) {
    const missing = missingPaths(root, extractPaths(recipe.scripts_to_create, "path"));
    return [missing.length ? "fail" : "pass", missing.length ? `Missing scripts: ${missing.join(", ")}` : "All script files exist."];
  }
  if (text.includes("system") && text.includes("exist")) {
    const missing = missingPaths(root, extractPaths(recipe.systems_to_create, "path"));
    return [missing.length ? "fail" : "pass", missing.length ? `Missing systems: ${missing.join(", ")}` : "All system files exist."];
  }
  if (text.includes("runtime") || text.includes("startup") || text.includes("run")) {
    return ["skip", "Handled by runtime validation layer."];
  }
  return ["skip", "No dedicated v1 evaluator for this check id yet."];
}

async function runBoundedRuntimeCheck({
  executor,
  boundedRunSeconds,
  checks,
  errors,
  warnings,
  strict,
}) {
  const canRun = executor && typeof executor.runProject === "function";

  if (!canRun) {
    if (strict) {
      errors.push({
        type: "runtime_failure",
        message: "No executor configured for runtime validation.",
        suggested_category: "runtime",
      });
    } else {
      warnings.push({ message: "Runtime validation skipped (executor missing runProject).", file: "" });
    }

    checks.push({
      id: "bounded_runtime_startup",
      description: "Project starts and runs within bounded runtime window.",
      status: "skip",
      details: "Executor not configured; runtime skipped.",
    });
    return { ok: false, action: "run_project", backend: "executor", inputs: {}, output: {}, error: "skipped" };
  }

  const runtimeResult = await executor.runProject({
    headless: true,
    extraArgs: null,
    timeoutSeconds: Number(boundedRunSeconds),
  });

  const ok = Boolean(runtimeResult?.ok);
  const stderr = runtimeResult?.output && typeof runtimeResult.output === "object" ? String(runtimeResult.output.stderr || "") : "";

  checks.push({
    id: "bounded_runtime_startup",
    description: "Project starts and runs within bounded runtime window.",
    status: ok ? "pass" : "fail",
    details: ok ? "Runtime succeeded." : "Runtime reported failure.",
  });

  if (!ok) {
    errors.push({
      type: "runtime_failure",
      message: "Bounded runtime execution failed.",
      suggested_category: classifyRuntimeCategory(stderr),
    });
  } else if (looksWarningLike(stderr)) {
    warnings.push({ message: "Runtime stderr contains warnings.", file: "" });
  }

  return runtimeResult;
}

function inspectDebugOutput({ executor, warnings }) {
  if (!executor || typeof executor.getDebugOutput !== "function") return "";
  try {
    const debug = executor.getDebugOutput({ lastN: 25 });
    const output = debug?.output;
    if (!output || typeof output !== "object") return "";
    const actions = output.actions;
    if (!Array.isArray(actions)) return "";

    const snippet = JSON.stringify(actions.slice(-5), null, 2);
    addDebugWarningsFromActions({ actions, warnings });
    return snippet;
  } catch (err) {
    warnings.push({ message: `Debug output unavailable: ${String(err)}`, file: "" });
    return "";
  }
}

function runBootSceneStartupPrintProofChecks({ root, projectState, runtimeResult, checks, errors, warnings }) {
  // This is an edit-mode specific proof step for the single gold-standard
  // workflow we support today:
  // "Update the boot scene root script so that in _ready() it prints a message once".
  if (!projectState || !isPlainObject(projectState)) return;

  const bootSceneRelPath = projectState.boot_scene_rel_path ?? projectState.bootSceneRelPath ?? null;
  const scriptRelPath =
    projectState.boot_print_script_rel_path ?? projectState.bootPrintScriptRelPath ?? null;
  const expectedMessage = projectState.boot_print_message ?? projectState.bootPrintMessage ?? null;

  if (!bootSceneRelPath || !scriptRelPath) return;

  const sceneAbs = path.resolve(String(root), String(bootSceneRelPath));
  const scriptAbs = path.resolve(String(root), String(scriptRelPath));
  const scriptResPath = scriptRelPath.startsWith("res://")
    ? scriptRelPath
    : `res://${String(scriptRelPath).replace(/^[./]+/, "")}`;

  // 1) Script exists
  const scriptExists = fs.existsSync(scriptAbs) && fs.statSync(scriptAbs).isFile();
  checks.push({
    id: "edit_boot_print_script_exists",
    description: "Boot print script file exists on disk.",
    status: scriptExists ? "pass" : "fail",
    details: scriptExists ? scriptAbs : `Missing: ${scriptAbs}`,
  });
  if (!scriptExists) {
    errors.push({
      type: "edit_boot_missing_script",
      message: "Expected boot print script file is missing.",
      suggested_category: "edit",
      file: String(scriptRelPath),
    });
    // If the script isn't present, later checks are likely to cascade; still
    // attempt scene reference + runtime checks for better debug context.
  }

  // 2) Boot scene references the script
  let sceneReferencesScript = false;
  let sceneReferenceDetails = "";
  try {
    const sceneRaw = fs.readFileSync(sceneAbs, "utf-8");
    // Robust across Godot authoring styles:
    // - `script = "res://..."` style
    // - `script = ExtResource("...")` style (but still includes res path in ext resource)
    sceneReferencesScript = sceneRaw.includes(scriptResPath);
    if (!sceneReferencesScript) {
      // Fallback: look for the script filename at least.
      sceneReferencesScript = sceneRaw.includes(path.basename(String(scriptRelPath)));
    }
    sceneReferenceDetails = sceneReferencesScript
      ? `Scene contains script reference (expected ${scriptResPath}).`
      : `Scene missing reference to ${scriptResPath} (and filename fallback).`;
  } catch (err) {
    sceneReferencesScript = false;
    sceneReferenceDetails = `Failed to read boot scene file: ${String(err?.message ?? err)}`;
  }

  checks.push({
    id: "edit_boot_print_scene_references_script",
    description: "Boot scene references the boot print script.",
    status: sceneReferencesScript ? "pass" : "fail",
    details: sceneReferenceDetails,
  });
  if (!sceneReferencesScript) {
    errors.push({
      type: "edit_boot_script_not_referenced",
      message: "Boot scene does not reference the expected boot print script.",
      suggested_category: "edit",
      file: String(bootSceneRelPath),
    });
  }

  // 3) Runtime prints the expected message
  const stdout =
    runtimeResult?.output?.stdout ??
    runtimeResult?.output?.output?.stdout ??
    runtimeResult?.output?.data?.stdout ??
    null;
  const stderr =
    runtimeResult?.output?.stderr ??
    runtimeResult?.output?.output?.stderr ??
    runtimeResult?.output?.data?.stderr ??
    null;
  // Some MCP servers return different nesting for stdout/stderr.
  // To keep this proof step robust, also fall back to a JSON-stringified
  // view of the runtime output.
  let runtimeText = `${stdout ?? ""}\n${stderr ?? ""}`.trim();
  if ((!runtimeText || runtimeText.length === 0) && runtimeResult?.output) {
    try {
      const serialized = typeof runtimeResult.output === "string" ? runtimeResult.output : JSON.stringify(runtimeResult.output);
      runtimeText = `${runtimeText}\n${serialized}`.trim();
    } catch {
      // ignore
    }
  }

  const expected = typeof expectedMessage === "string" ? expectedMessage : null;
  let occurrences = 0;
  if (expected && expected.trim()) {
    const needle = expected;
    occurrences = runtimeText.length > 0 ? runtimeText.split(needle).length - 1 : 0;
  }

  const messageEmitted = occurrences > 0;
  checks.push({
    id: "edit_boot_print_message_emitted",
    description: "Bounded runtime output contains the expected boot print message.",
    status: messageEmitted ? "pass" : "fail",
    details: expected
      ? `Occurrences: ${occurrences} (expected message: ${expected}).`
      : "No expected message found in project_state; skipping strict message proof.",
  });

  if (!expected || !expected.trim()) {
    // If we don't have a message, do not error (other proof checks still apply).
    return;
  }

  if (!messageEmitted) {
    errors.push({
      type: "edit_boot_message_not_emitted",
      message: "Startup runtime did not emit the expected boot print message.",
      suggested_category: "edit",
    });
  } else if (occurrences > 1) {
    warnings.push({
      message: `Boot print message emitted ${occurrences} times (expected once).`,
      file: "",
    });
  }
}

function addDebugWarningsFromActions({ actions, warnings }) {
  const recent = actions.slice(-10);
  for (const action of recent) {
    if (!isPlainObject(action)) continue;
    if (action.ok) continue;
    const actionName = String(action.action ?? "unknown");
    const err = String(action.error ?? "unknown executor failure");
    warnings.push({ message: `Executor action failed during run: ${actionName} (${err})`, file: "" });
  }
}

function buildValidationReport({ projectName, checks, errors, warnings, debugExcerpt }) {
  const status = deriveStatus({ errors, checks });
  const report = {
    project_name: projectName,
    status,
    checks,
    errors,
    warnings,
    generated_at: new Date().toISOString(),
  };
  if (debugExcerpt) report.debug_output_excerpt = debugExcerpt;
  return report;
}

function deriveStatus({ errors, checks }) {
  if (errors.length > 0) {
    const passed = checks.some((c) => c.status === "pass");
    return passed ? "partial" : "fail";
  }
  return "pass";
}

function validateReportSchema({ report, schemaPath }) {
  const schema = loadJsonSchema(schemaPath);
  const validation = validateDataAgainstSchema(report, schema);
  if (validation.is_valid) return;
  const rendered = JSON.stringify(validation.errors ?? [], null, 2);
  throw new Error(`Generated validation report does not match schema: ${rendered}`);
}

function saveValidationReport({ report, artifactsDir, filename = DEFAULT_REPORT_FILENAME }) {
  const outDir = path.resolve(String(artifactsDir));
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, filename);
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2), "utf-8");
  return outPath;
}

function checkRecipePaths({
  root,
  entries,
  pathKey,
  checkId,
  description,
  errorType,
  category,
  checks,
  errors,
}) {
  const expectedPaths = extractPaths(entries, pathKey);
  const missing = missingPaths(root, expectedPaths);

  checks.push({
    id: checkId,
    description,
    status: missing.length ? "fail" : "pass",
    details: missing.length ? `Missing: ${missing.join(", ")}` : "All required files exist.",
  });

  for (const relPath of missing) {
    errors.push({
      type: errorType,
      message: `Required file missing: ${relPath}`,
      file: relPath,
      suggested_category: category,
    });
  }
}

function extractPaths(entries, pathKey) {
  const paths = [];
  for (const entry of safeList(entries)) {
    if (!isPlainObject(entry)) continue;
    const raw = entry[pathKey];
    if (typeof raw === "string" && raw.trim()) paths.push(raw.trim());
  }
  return paths;
}

function missingPaths(root, relPaths) {
  const missing = [];
  for (const relPath of relPaths) {
    if (!fs.existsSync(path.join(root, relPath))) missing.push(relPath);
  }
  return missing;
}

function classifyRuntimeCategory(stderr) {
  const text = String(stderr || "").toLowerCase();
  if (text.includes("script") && text.includes("error")) return "runtime_script_error";
  if (text.includes("node") && (text.includes("missing") || text.includes("not found"))) return "runtime_node_error";
  if (text.includes("parse") || text.includes("syntax")) return "runtime_parse_error";
  return "runtime_general_failure";
}

function looksWarningLike(stderr) {
  const text = String(stderr || "").toLowerCase();
  return text.includes("warning") && !text.includes("error");
}

function safeList(value) {
  return Array.isArray(value) ? value : [];
}

function ensureObject(name, value) {
  if (!isPlainObject(value)) throw new Error(`'${name}' must be an object.`);
}

function isPlainObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

