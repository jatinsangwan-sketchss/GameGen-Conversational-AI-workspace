/**
 * Prompt template loader and strict renderer.
 *
 * Templates live on disk under factory/prompts/ and use {placeholder} tokens.
 * This module loads template files and replaces placeholders from runtime values.
 */

import fs from "node:fs";
import path from "node:path";

export class PromptTemplateError extends Error {
  /**
   * @param {string} message
   */
  constructor(message) {
    super(message);
    this.name = "PromptTemplateError";
  }
}

const DEFAULT_PROMPTS_ROOT = path.resolve("factory/prompts");
const PLACEHOLDER_RE = /\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g;

export class PromptBuilder {
  /**
   * @param {object} params
   * @param {string} [params.promptsRoot]
   */
  constructor({ promptsRoot = DEFAULT_PROMPTS_ROOT } = {}) {
    this.promptsRoot = path.resolve(String(promptsRoot));
  }

  /**
   * Load template file as text.
   * @param {string} templatePath
   * @returns {string}
   */
  loadTemplate(templatePath) {
    const resolved = this.resolveTemplatePath(templatePath);
    if (!fs.existsSync(resolved)) {
      throw new Error(`Prompt template file not found: ${resolved}`);
    }
    const stat = fs.statSync(resolved);
    if (!stat.isFile()) {
      throw new Error(`Prompt template path is not a file: ${resolved}`);
    }
    return fs.readFileSync(resolved, "utf-8");
  }

  /**
   * Strictly render a template: fail if required placeholders are missing.
   * @param {string} templateText
   * @param {object} values
   * @returns {string}
   */
  renderTemplate(templateText, values) {
    const requiredKeys = extractPlaceholders(templateText);
    const missing = Array.from(requiredKeys).filter((k) => !(k in values));
    if (missing.length > 0) {
      missing.sort();
      throw new PromptTemplateError(
        `Missing required template placeholders: ${missing.join(", ")}`
      );
    }

    let rendered = templateText;
    // Replace each required placeholder deterministically.
    for (const key of Array.from(requiredKeys).sort()) {
      const value = values[key];
      const asText = value == null ? "" : String(value);
      rendered = rendered.split(`{${key}}`).join(asText);
    }
    return rendered;
  }

  /**
   * One step: load + render.
   * @param {string} templatePath
   * @param {object} values
   */
  loadAndRender(templatePath, values) {
    const text = this.loadTemplate(templatePath);
    return this.renderTemplate(text, values);
  }

  /**
   * Load and render separate system and user templates.
   * @param {object} params
   * @param {string} params.systemTemplatePath
   * @param {string} params.userTemplatePath
   * @param {object} params.values
   * @returns {{system_prompt: string, user_prompt: string}}
   */
  loadSystemUserPrompts({ systemTemplatePath, userTemplatePath, values }) {
    return {
      system_prompt: this.loadAndRender(systemTemplatePath, values),
      user_prompt: this.loadAndRender(userTemplatePath, values),
    };
  }

  resolveTemplatePath(templatePath) {
    const maybe = path.resolve(String(templatePath));
    // Absolute path: keep it.
    if (path.isAbsolute(String(templatePath))) return maybe;
    return path.resolve(this.promptsRoot, String(templatePath));
  }
}

function extractPlaceholders(templateText) {
  const keys = new Set();
  for (const match of templateText.matchAll(PLACEHOLDER_RE)) {
    const key = match[1];
    if (key) keys.add(key);
  }
  return keys;
}

export function loadSystemUserPrompts({
  systemTemplatePath,
  userTemplatePath,
  values,
  promptsRoot = DEFAULT_PROMPTS_ROOT,
}) {
  const builder = new PromptBuilder({ promptsRoot });
  return builder.loadSystemUserPrompts({
    systemTemplatePath,
    userTemplatePath,
    values,
  });
}

