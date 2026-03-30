/**
 * Project scaffolder for generated Godot workspaces.
 *
 * Deterministic filesystem stage:
 * - validate starter template baseline structure
 * - optionally overwrite target project directory
 * - copy template into target
 * - create per-run artifact directories
 * - return a structured scaffold summary (and optionally save JSON)
 *
 * No LLM/MCP logic lives here.
 */

import fs from "node:fs";
import path from "node:path";

const REQUIRED_TEMPLATE_FILES = [
  "project.godot",
  "AGENTS.md",
  path.join("docs", "conventions.md"),
  path.join("docs", "implementation-brief.md"),
];

const REQUIRED_TEMPLATE_DIRS = ["scenes", "scripts", "systems", "docs"];

const ARTIFACT_SUBDIRS = ["reports", "intermediate", "logs"];

export function scaffoldProject({
  starterTemplate,
  targetPath,
  projectName,
  overwrite = false,
  artifactsRoot = null,
  runId = null,
  saveSummary = false,
}) {
  const projectNameClean = normalizeProjectName(projectName);
  const starterTemplatePath = path.resolve(String(starterTemplate));
  const targetProjectPath = path.resolve(String(targetPath));

  const templateValidation = validateTemplate(starterTemplatePath);
  prepareTargetPath(targetProjectPath, overwrite);
  copyTemplate(starterTemplatePath, targetProjectPath);
  const copiedIntegrity = validateCopiedProject(targetProjectPath);

  const artifacts = createArtifactDirectories({
    projectName: projectNameClean,
    artifactsRoot,
    runId,
  });

  const summary = {
    ok: true,
    project_name: projectNameClean,
    starter_template: starterTemplatePath,
    target_path: targetProjectPath,
    overwrite_used: overwrite,
    run_id: runId,
    template_validation: templateValidation,
    copied_project_validation: copiedIntegrity,
    artifacts,
  };

  if (saveSummary) {
    const summaryPath = writeScaffoldSummary(
      summary,
      artifacts.project_artifacts_dir
    );
    summary.summary_path = summaryPath;
  }

  return summary;
}

function normalizeProjectName(projectName) {
  const cleaned = String(projectName ?? "").trim();
  if (!cleaned) throw new Error("projectName must be a non-empty string.");
  return cleaned;
}

function validateTemplate(templatePath) {
  if (!fs.existsSync(templatePath)) {
    throw new Error(`Starter template path not found: ${templatePath}`);
  }
  const stat = fs.statSync(templatePath);
  if (!stat.isDirectory()) {
    throw new Error(`Starter template path must be a directory: ${templatePath}`);
  }

  const missingFiles = findMissingPaths(
    templatePath,
    REQUIRED_TEMPLATE_FILES,
    false
  );
  const missingDirs = findMissingPaths(
    templatePath,
    REQUIRED_TEMPLATE_DIRS,
    true
  );

  if (missingFiles.length > 0 || missingDirs.length > 0) {
    const problems = [];
    if (missingFiles.length > 0) {
      problems.push(`missing files: ${missingFiles.join(", ")}`);
    }
    if (missingDirs.length > 0) {
      problems.push(`missing directories: ${missingDirs.join(", ")}`);
    }
    throw new Error(
      `Starter template is missing required baseline structure: ${problems.join("; ")}`
    );
  }

  return {
    is_valid: true,
    required_files_checked: REQUIRED_TEMPLATE_FILES.slice(),
    required_dirs_checked: REQUIRED_TEMPLATE_DIRS.slice(),
  };
}

function prepareTargetPath(targetPath, overwrite) {
  if (fs.existsSync(targetPath)) {
    if (!overwrite) {
      throw new Error(
        `Target project path already exists and overwrite is disabled: ${targetPath}`
      );
    }

    const stat = fs.statSync(targetPath);
    if (stat.isFile()) {
      throw new Error(
        `Target path points to a file, expected directory: ${targetPath}`
      );
    }
    fs.rmSync(targetPath, { recursive: true, force: true });
  }

  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
}

function copyTemplate(templatePath, targetPath) {
  try {
    fs.cpSync(templatePath, targetPath, { recursive: true });
  } catch (err) {
    throw new Error(
      `Failed to copy starter template '${templatePath}' to '${targetPath}': ${err}`
    );
  }
}

function validateCopiedProject(targetPath) {
  const missingFiles = findMissingPaths(
    targetPath,
    REQUIRED_TEMPLATE_FILES,
    false
  );
  const missingDirs = findMissingPaths(targetPath, REQUIRED_TEMPLATE_DIRS, true);

  if (missingFiles.length > 0 || missingDirs.length > 0) {
    const problems = [];
    if (missingFiles.length > 0) problems.push(`missing files: ${missingFiles.join(", ")}`);
    if (missingDirs.length > 0) problems.push(`missing directories: ${missingDirs.join(", ")}`);
    throw new Error(
      `Copied project failed integrity check after scaffolding: ${problems.join("; ")}`
    );
  }

  return {
    is_valid: true,
    required_files_checked: REQUIRED_TEMPLATE_FILES.slice(),
    required_dirs_checked: REQUIRED_TEMPLATE_DIRS.slice(),
  };
}

function createArtifactDirectories({ projectName, artifactsRoot, runId }) {
  const root = artifactsRoot ? path.resolve(String(artifactsRoot)) : path.resolve("artifacts");
  const projectArtifactsDir = path.join(root, projectName);
  const runArtifactsDir = path.join(projectArtifactsDir, runId ? String(runId) : "latest");

  fs.mkdirSync(projectArtifactsDir, { recursive: true });
  fs.mkdirSync(runArtifactsDir, { recursive: true });

  const subdirs = {};
  for (const name of ARTIFACT_SUBDIRS) {
    const p = path.join(runArtifactsDir, name);
    fs.mkdirSync(p, { recursive: true });
    subdirs[`${name}_dir`] = p;
  }

  return {
    artifacts_root: root,
    project_artifacts_dir: projectArtifactsDir,
    run_artifacts_dir: runArtifactsDir,
    ...subdirs,
  };
}

function writeScaffoldSummary(summary, projectArtifactsDir) {
  const outputPath = path.join(projectArtifactsDir, "scaffold_summary.json");
  fs.writeFileSync(outputPath, JSON.stringify(summary, null, 2), "utf-8");
  return outputPath;
}

function findMissingPaths(root, relPaths, expectDir) {
  const missing = [];
  for (const rel of relPaths) {
    const candidate = path.join(root, rel);
    const exists = expectDir ? fs.existsSync(candidate) && fs.statSync(candidate).isDirectory() : fs.existsSync(candidate) && fs.statSync(candidate).isFile();
    if (!exists) missing.push(rel);
  }
  return missing;
}

