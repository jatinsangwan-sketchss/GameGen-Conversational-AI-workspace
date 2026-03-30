/**
 * ProjectMetadataUpdater
 * -----------------------
 * Updates metadata inside a Godot project's `project.godot` based on the
 * canonical project source-of-truth artifact:
 *   normalized_game_spec.project_name
 *
 * Why:
 * - Godot projects copied from templates often keep a default name.
 * - For conversational editing and repeatable generation, we reflect the
 *   canonical project name back into `project.godot`.
 *
 * This module is intentionally conservative:
 * - it preserves unrelated `project.godot` content
 * - it only updates `config/name` within the `[application]` section
 * - it fails clearly when `project.godot` or required fields are missing
 */

import fs from "node:fs";
import path from "node:path";

function isPlainObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function stringifyGodotValue(value) {
  // `project.godot` values for config/name are commonly quoted.
  // We stringify so embedded quotes are escaped safely.
  return JSON.stringify(String(value));
}

function getApplicationSectionBounds(lines) {
  // Returns { startIdx, endIdxExclusive } for the `[application]` section
  // or `null` if missing.
  let startIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed === "[application]") {
      startIdx = i;
      break;
    }
  }
  if (startIdx === -1) return null;

  let endIdxExclusive = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    // Another section begins.
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      endIdxExclusive = i;
      break;
    }
  }

  return { startIdx, endIdxExclusive };
}

function updateConfigNameInApplicationSection({ lines, newName }) {
  const bounds = getApplicationSectionBounds(lines);
  if (!bounds) {
    return {
      ok: false,
      updatedCount: 0,
      error: "Missing [application] section in project.godot.",
    };
  }

  let updatedCount = 0;
  let beforeName = null;
  let afterName = String(newName);

  // Only update `config/name` lines inside the application section.
  for (let i = bounds.startIdx + 1; i < bounds.endIdxExclusive; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed.startsWith("config/name=")) continue;

    // Preserve leading whitespace and everything before the value.
    // Accept both quoted and unquoted values.
    // Examples:
    //   config/name="My Game"
    //   config/name=My Game
    const match = line.match(/^(\s*config\/name\s*=\s*)(.*)$/);
    if (!match) continue;

    const prefix = match[1];
    const rawValue = match[2].trim();

    // Extract beforeName for reporting:
    // - if quoted, remove outer quotes
    // - else use raw string directly
    if (beforeName === null) {
      if (rawValue.startsWith('"') && rawValue.endsWith('"') && rawValue.length >= 2) {
        beforeName = rawValue.slice(1, -1);
      } else {
        beforeName = rawValue;
      }
    }

    lines[i] = `${prefix}${stringifyGodotValue(afterName)}`;
    updatedCount++;
  }

  if (updatedCount === 0) {
    return {
      ok: false,
      updatedCount,
      error: "Missing `config/name` inside the [application] section in project.godot.",
    };
  }

  return { ok: true, updatedCount, beforeName, afterName };
}

function readProjectGodotFile(projectGodotPath) {
  const resolved = path.resolve(String(projectGodotPath));
  if (!fs.existsSync(resolved)) {
    return {
      ok: false,
      error: `project.godot not found at: ${resolved}`,
      path: resolved,
    };
  }
  const stat = fs.statSync(resolved);
  if (!stat.isFile()) {
    return {
      ok: false,
      error: `project.godot path is not a file: ${resolved}`,
      path: resolved,
    };
  }

  const content = fs.readFileSync(resolved, "utf-8");
  return { ok: true, path: resolved, content };
}

function writeProjectGodotFile(projectGodotPath, content) {
  const resolved = path.resolve(String(projectGodotPath));
  fs.writeFileSync(resolved, content, "utf-8");
  return resolved;
}

export function updateProjectGodotProjectName({
  projectRoot,
  normalizedGameSpec,
  projectGodotPath = null,
} = {}) {
  if (!projectRoot) {
    return { ok: false, error: "projectRoot is required." };
  }
  const spec = normalizedGameSpec;
  if (!isPlainObject(spec)) {
    return { ok: false, error: "normalizedGameSpec must be a JSON object." };
  }

  const projectName = spec?.project_name;
  if (typeof projectName !== "string" || !projectName.trim()) {
    return { ok: false, error: "normalized_game_spec.project_name must be a non-empty string." };
  }

  const resolvedGodotPath = projectGodotPath ?? path.join(path.resolve(String(projectRoot)), "project.godot");
  const readRes = readProjectGodotFile(resolvedGodotPath);
  if (!readRes.ok) return { ok: false, project_godot_path: readRes.path, error: readRes.error };

  // Preserve content as much as possible: we only edit the matched line(s).
  const lines = readRes.content.split("\n");
  const updateRes = updateConfigNameInApplicationSection({
    lines,
    newName: projectName.trim(),
  });

  if (!updateRes.ok) {
    return {
      ok: false,
      project_godot_path: resolvedGodotPath,
      error: updateRes.error,
    };
  }

  const updatedContent = lines.join("\n");
  const savedPath = writeProjectGodotFile(resolvedGodotPath, updatedContent);

  return {
    ok: true,
    project_godot_path: savedPath,
    updated_fields: ["application.config/name"],
    updated_count: updateRes.updatedCount,
    before_name: updateRes.beforeName,
    after_name: updateRes.afterName,
  };
}

