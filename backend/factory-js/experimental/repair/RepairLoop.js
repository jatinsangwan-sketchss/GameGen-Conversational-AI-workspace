/**
 * Conservative bounded repair loop for v1 projects.
 *
 * Only auto-repairs clearly safe structural issues (missing files),
 * then re-runs validation after each attempt.
 */

import fs from "node:fs";
import path from "node:path";

import { loadJsonSchema, validateDataAgainstSchema } from "../../schema_utils.js";
import { validateProject } from "../validation/Validator.js";

export const DEFAULT_REPAIR_REPORT_SCHEMA_PATH =
  "factory-js/schemas/repair_report.schema.json";
export const DEFAULT_REPAIR_REPORT_FILENAME = "repair_report.json";

const SAFE_ERROR_TYPES = new Set([
  "missing_scene",
  "missing_script",
  "missing_system",
  "missing_config_file",
]);

export async function runRepairLoop({
  projectName,
  projectRoot,
  generationRecipe,
  validationReport,
  executor,
  maxAttempts = 3,
  strict = false,
  boundedRunSeconds = 5,
  artifactsDir = null,
  schemaPath = DEFAULT_REPAIR_REPORT_SCHEMA_PATH,
}) {
  ensurePositiveInt("maxAttempts", maxAttempts);

  const root = path.resolve(String(projectRoot));
  if (!fs.existsSync(root)) throw new Error(`Project root not found: ${root}`);

  // Callers typically pass `validateProject(...).validation_report`, but we
  // defensively accept the outer wrapper too.
  const resolvedValidationReport = resolveValidationReport(validationReport);

  const inputStatus = String(resolvedValidationReport?.status ?? "fail");

  if (inputStatus === "pass") {
    const report = buildRepairReport({
      projectName,
      inputValidationStatus: inputStatus,
      repairsAttempted: [],
      resultStatus: "resolved",
      remainingIssues: remainingIssueStrings(resolvedValidationReport),
      nextRecommendedAction:
        "Validation already passed; no repairs needed.",
    });
    return maybeSaveRepairReport({ report, artifactsDir });
  }

  let prevErrorSignatures = errorSignatures(resolvedValidationReport);
  let currentReport = resolvedValidationReport;
  let resultStatus = "unchanged";

  /** @type {Array<{issue:string, action:string, files_changed?:string[], notes?:string}>} */
  const repairsAttempted = [];

  for (let attemptIdx = 1; attemptIdx <= maxAttempts; attemptIdx++) {
    const candidates = extractRepairCandidates(currentReport);
    const safeCandidates = filterSafeCandidates(candidates);
    const remainingIssues = remainingIssueStrings(currentReport);

    if (safeCandidates.length === 0) {
      resultStatus = "failed";
      const report = buildRepairReport({
        projectName,
        inputValidationStatus: inputStatus,
        repairsAttempted,
        resultStatus,
        remainingIssues,
        nextRecommendedAction:
          "Remaining issues are not safely auto-repairable; manual intervention needed.",
      });
      return maybeSaveRepairReport({ report, artifactsDir });
    }

    const plannedActions = planRepairActions(safeCandidates, {
      maxActionsPerAttempt: 10,
    });
    const attemptResult = applyRepairActions({
      projectRoot: root,
      generationRecipe,
      plannedActions,
      executor,
    });

    repairsAttempted.push(attemptResult.attempt_log);

    // Re-run validation after repairs.
    let rerun;
    try {
      rerun = await validateProject({
        projectName,
        projectRoot: root,
        generationRecipe,
        executor,
        boundedRunSeconds,
        strict,
        artifactsDir: null,
        schemaPath: undefined, // use default
      });
    } catch (err) {
      resultStatus = "failed";
      const report = buildRepairReport({
        projectName,
        inputValidationStatus: inputStatus,
        repairsAttempted,
        resultStatus,
        remainingIssues: remainingIssueStrings(currentReport),
        nextRecommendedAction: `Validation threw during repair attempt ${attemptIdx}: ${String(err)}`,
      });
      return maybeSaveRepairReport({ report, artifactsDir });
    }

    currentReport = rerun.validation_report;

    if (String(currentReport?.status) === "pass") {
      resultStatus = "resolved";
      const report = buildRepairReport({
        projectName,
        inputValidationStatus: inputStatus,
        repairsAttempted,
        resultStatus,
        remainingIssues: remainingIssueStrings(currentReport),
        nextRecommendedAction: "Project validation passed after repairs.",
      });
      return maybeSaveRepairReport({ report, artifactsDir });
    }

    const newErrorSignatures = errorSignatures(currentReport);
    if (!didProgress(prevErrorSignatures, newErrorSignatures)) {
      resultStatus = "unchanged";
      const report = buildRepairReport({
        projectName,
        inputValidationStatus: inputStatus,
        repairsAttempted,
        resultStatus,
        remainingIssues,
        nextRecommendedAction:
          "No error-signature improvement across attempts; stopping to avoid repair spirals.",
      });
      return maybeSaveRepairReport({ report, artifactsDir });
    }

    prevErrorSignatures = newErrorSignatures;
    resultStatus = "improved";
  }

  // Max attempts reached.
  const report = buildRepairReport({
    projectName,
    inputValidationStatus: inputStatus,
    repairsAttempted,
    resultStatus: resultStatus === "resolved" ? "resolved" : resultStatus,
    remainingIssues: remainingIssueStrings(currentReport),
    nextRecommendedAction:
      "Max repair attempts reached; further repairs are not attempted.",
  });
  return maybeSaveRepairReport({ report, artifactsDir });
}

function maybeSaveRepairReport({ report, artifactsDir }) {
  if (artifactsDir == null) return report;
  const outDir = path.resolve(String(artifactsDir));
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, DEFAULT_REPAIR_REPORT_FILENAME);
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2), "utf-8");
  return { ...report, output_path: outPath };
}

function buildRepairReport({
  projectName,
  inputValidationStatus,
  repairsAttempted,
  resultStatus,
  remainingIssues,
  nextRecommendedAction,
}) {
  const report = {
    project_name: projectName,
    input_validation_status: inputValidationStatus,
    repairs_attempted: repairsAttempted,
    result_status: resultStatus,
    remaining_issues: remainingIssues,
    next_recommended_action: nextRecommendedAction,
    generated_at: new Date().toISOString(),
  };

  validateRepairReportSchema(report);
  return report;
}

function validateRepairReportSchema(report) {
  const schema = loadJsonSchema(DEFAULT_REPAIR_REPORT_SCHEMA_PATH);
  const validation = validateDataAgainstSchema(report, schema);
  if (validation.is_valid) return;
  const rendered = JSON.stringify(validation.errors ?? [], null, 2);
  throw new Error(`Repair report schema validation failed: ${rendered}`);
}

function ensurePositiveInt(name, value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${name} must be a positive integer.`);
}

function extractRepairCandidates(currentReport) {
  const errors = currentReport?.errors;
  if (!Array.isArray(errors)) return [];

  /** @type {Array<{type:string,file:string,message:string}>} */
  const candidates = [];
  for (const err of errors) {
    if (!isPlainObject(err)) continue;
    const type = String(err.type ?? "").trim();
    const file = String(err.file ?? "").trim();
    const message = String(err.message ?? "").trim();
    if (!type) continue;
    // If we cannot locate the file, we cannot safely apply a minimal repair.
    if (!file) continue;
    candidates.push({ type, file, message });
  }
  return candidates;
}

function filterSafeCandidates(candidates) {
  return candidates.filter((c) => SAFE_ERROR_TYPES.has(c.type));
}

function planRepairActions(safeCandidates, { maxActionsPerAttempt }) {
  const priorityMap = {
    missing_scene: 0,
    missing_script: 1,
    missing_system: 2,
    missing_config_file: 3,
  };

  const sorted = safeCandidates.slice().sort((a, b) => {
    const pa = priorityMap[a.type] ?? 99;
    const pb = priorityMap[b.type] ?? 99;
    if (pa !== pb) return pa - pb;
    return String(a.file).localeCompare(String(b.file));
  });

  const planned = sorted.slice(0, maxActionsPerAttempt);
  return planned.map((c) => ({
    type: c.type,
    file: c.file ?? "",
    message: c.message ?? "",
  }));
}

function applyRepairActions({
  projectRoot,
  generationRecipe,
  plannedActions,
  executor,
}) {
  const filesChanged = [];
  const actionItems = [];
  const notes = [];
  const repairCategories = new Set();

  for (const action of plannedActions) {
    const type = String(action.type ?? "");
    const relPath = String(action.file ?? "").trim();
    if (!relPath) {
      notes.push(`Skipping ${type}: missing 'file' in validation error.`);
      continue;
    }

    repairCategories.add(classifyRepairCategory(type));

    const changed = repairSingleIssue({
      projectRoot,
      generationRecipe,
      issueType: type,
      relPath,
      executor,
    });

    if (changed) {
      filesChanged.push(path.join(projectRoot, relPath));
      actionItems.push(`${type}:${relPath}`);
    }
  }

  return {
    attempt_log: {
      issue: "batch_safe_repairs",
      action: "apply_minimal_safe_repairs",
      files_changed: filesChanged,
      notes: [
        notes.filter(Boolean).join("; "),
        repairCategories.size
          ? `repair_categories: ${Array.from(repairCategories).join(", ")}`
          : null,
      ]
        .filter(Boolean)
        .join(" | "),
    },
    files_changed: filesChanged,
    repair_items: actionItems,
  };
}

function repairSingleIssue({
  projectRoot,
  generationRecipe,
  issueType,
  relPath,
  executor,
}) {
  const absPath = path.join(projectRoot, relPath);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });

  if (issueType === "missing_scene") {
    const sceneEntry = lookupByPath(generationRecipe?.scenes_to_create, relPath);
    const rootType = sceneEntry?.root_type ? String(sceneEntry.root_type) : "Node2D";
    const rootName = sceneEntry?.root_name ? String(sceneEntry.root_name) : "Scene";

    fs.writeFileSync(absPath, sceneStubContent({ rootType, rootName }), "utf-8");
    tryExecutorMcpSceneCreate({ executor, relPath, rootType, rootName });
    return true;
  }

  if (issueType === "missing_script") {
    const scriptEntry = lookupByPath(
      generationRecipe?.scripts_to_create,
      relPath
    );
    const role = scriptEntry?.role ? String(scriptEntry.role) : "";
    fs.writeFileSync(absPath, scriptStubContent({ role }), "utf-8");
    return true;
  }

  if (issueType === "missing_system") {
    const systemEntry = lookupByPath(
      generationRecipe?.systems_to_create,
      relPath
    );
    const role = systemEntry?.role ? String(systemEntry.role) : "";
    fs.writeFileSync(absPath, scriptStubContent({ role }), "utf-8");
    return true;
  }

  if (issueType === "missing_config_file") {
    const configEntry = lookupByPath(
      generationRecipe?.config_files_to_create,
      relPath
    );
    const purpose = configEntry?.purpose ? String(configEntry.purpose) : "";
    const content = { purpose, generated_by: "factory.repair_loop" };
    fs.writeFileSync(absPath, JSON.stringify(content, null, 2), "utf-8");
    return true;
  }

  return false;
}

function tryExecutorMcpSceneCreate({ executor, relPath, rootType, rootName }) {
  if (!executor) return;
  const createFn = executor.createScene ?? null;
  const saveFn = executor.saveScene ?? null;
  if (typeof createFn !== "function" || typeof saveFn !== "function") return;
  try {
    createFn({ scenePath: relPath, rootType, rootName });
    saveFn({ scenePath: relPath });
  } catch {
    // Best-effort only; filesystem stubs are authoritative.
  }
}

function lookupByPath(entries, relPath) {
  const arr = Array.isArray(entries) ? entries : [];
  for (const entry of arr) {
    if (!isPlainObject(entry)) continue;
    if (String(entry.path ?? "").trim() === String(relPath).trim()) return entry;
  }
  return null;
}

function sceneStubContent({ rootType, rootName }) {
  return [
    "[gd_scene format=3]",
    "",
    `[node name="${rootName}" type="${rootType}"]`,
    "",
  ].join("\n");
}

function scriptStubContent({ role }) {
  const roleNote = role || "TODO: implement role-specific behavior";
  return [
    "extends Node",
    "",
    `# ${roleNote}`,
    "func _ready() -> void:",
    "    pass",
    "",
  ].join("\n");
}

function errorSignatures(validationReport) {
  const errors = validationReport?.errors;
  if (!Array.isArray(errors)) return new Set();
  /** @type {Set<string>} */
  const sigs = new Set();
  for (const err of errors) {
    if (!isPlainObject(err)) continue;
    const type = String(err.type ?? "").trim();
    const file = String(err.file ?? "").trim();
    const nodePath = String(err.node_path ?? "").trim();
    const msg = String(err.message ?? "").trim();
    const signature = [type, file, nodePath, msg].filter(Boolean).join("|");
    if (signature) sigs.add(signature);
  }
  return sigs;
}

function didProgress(prev, next) {
  if (!next || next.size === 0) return true;
  if (!prev || prev.size === 0) return true;
  return next.size < prev.size || !setsEqual(prev, next);
}

function setsEqual(a, b) {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

function remainingIssueStrings(validationReport) {
  const errors = validationReport?.errors;
  if (!Array.isArray(errors)) return [];
  /** @type {string[]} */
  const issues = [];
  for (const err of errors) {
    if (!isPlainObject(err)) continue;
    const type = String(err.type ?? "").trim();
    const file = String(err.file ?? "").trim();
    const message = String(err.message ?? "").trim();
    if (file) issues.push(`${type}:${file}`);
    else issues.push(type || message || "unknown_issue");
  }
  return issues;
}

function resolveValidationReport(validationReport) {
  if (validationReport == null) return null;
  // Most callers pass `{ ... }` where `status/errors/warnings` live.
  if (Array.isArray(validationReport.errors) || typeof validationReport.status === "string") {
    return validationReport;
  }
  // Defensive: accept the wrapper returned from `validateProject()`.
  if (validationReport.validation_report && typeof validationReport.validation_report === "object") {
    return validationReport.validation_report;
  }
  return validationReport;
}

function classifyRepairCategory(issueType) {
  const t = String(issueType ?? "").trim();
  if (!t) return "unknown";
  if (t === "missing_scene") return "missing_scene";
  if (t === "missing_script") return "missing_script";
  if (t === "missing_system") return "missing_system";
  if (t === "missing_config_file") return "missing_config_file";
  return "unsafe_unknown";
}

function isPlainObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

