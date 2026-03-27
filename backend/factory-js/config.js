/**
 * Configuration loader for the AI Game Factory.
 *
 * Mirrors the Python factory/config.py behavior:
 * - defaults
 * - JSON file config
 * - environment variable overrides
 * - explicit override object (highest priority)
 *
 * Priority: defaults < JSON < env < overrides
 */

import fs from "node:fs";
import path from "node:path";

export const DEFAULT_CONFIG = {
  paths: {
    storage_root: "./storage",
    artifacts_root: "./storage/artifacts",
    generated_projects_root: "./storage/generated_projects",
  },
  model: {},
  execution: {
    default_platform: "android",
    bounded_validation_seconds: 5,
    use_headless_validation: true,
    enable_repair: true,
  },
  repair: {
    max_attempts: 3,
    strict_validation: false,
  },
  logging: {
    level: "INFO",
  },
};

const ENV_OVERRIDE_SPECS = {
  FACTORY_STARTER_TEMPLATE_PATH: [["paths", "starter_template"], String],
  FACTORY_GODOT_EXECUTABLE: [["paths", "godot_executable"], String],
  FACTORY_STORAGE_ROOT: [["paths", "storage_root"], String],
  FACTORY_ARTIFACT_ROOT: [["paths", "artifacts_root"], String],
  FACTORY_GENERATED_PROJECTS_ROOT: [["paths", "generated_projects_root"], String],
  FACTORY_DEFAULT_MODEL: [["model", "default_model"], String],
  FACTORY_DEFAULT_PLATFORM: [["execution", "default_platform"], String],
  FACTORY_BOUNDED_VALIDATION_SECONDS: [["execution", "bounded_validation_seconds"], Number],
  FACTORY_USE_HEADLESS_VALIDATION: [["execution", "use_headless_validation"], parseBool],
  FACTORY_ENABLE_REPAIR: [["execution", "enable_repair"], parseBool],
  FACTORY_MAX_REPAIR_ATTEMPTS: [["repair", "max_attempts"], Number],
  FACTORY_STRICT_VALIDATION: [["repair", "strict_validation"], parseBool],
  FACTORY_LOG_LEVEL: [["logging", "level"], String],
};

const REQUIRED_CONFIG_PATHS = [
  ["paths", "starter_template"],
  ["paths", "godot_executable"],
  ["model", "default_model"],
];

export function loadFactoryConfig(configPath, overrides = undefined) {
  const defaults = deepClone(DEFAULT_CONFIG);

  const fileConfig = loadJsonConfigFile(configPath);
  deepMerge(defaults, fileConfig);

  const envOverrides = collectEnvOverrides();
  deepMerge(defaults, envOverrides);

  if (overrides) {
    deepMerge(defaults, overrides);
  }

  validateRequiredConfig(defaults);
  return defaults;
}

function loadJsonConfigFile(configPath) {
  const configFile = path.resolve(String(configPath));
  assertExists(configFile);
  const raw = fs.readFileSync(configFile, "utf-8");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Invalid JSON in config file '${configFile}': ${err}`);
  }
  if (!isPlainObject(parsed)) {
    throw new Error(`Config file root must be a JSON object: ${configFile}`);
  }
  return parsed;
}

function collectEnvOverrides() {
  const overrides = {};

  for (const [envName, [pathParts, parser]] of Object.entries(ENV_OVERRIDE_SPECS)) {
    const rawValue = process.env[envName];
    if (rawValue == null) continue;

    let parsedValue;
    try {
      parsedValue = parser(rawValue);
    } catch (err) {
      const dotted = pathParts.join(".");
      throw new Error(
        `Invalid environment override '${envName}' for '${dotted}': ${JSON.stringify(rawValue)}`
      );
    }

    setNestedValue(overrides, pathParts, parsedValue);
  }

  return overrides;
}

function validateRequiredConfig(config) {
  const missingPaths = [];
  for (const pathParts of REQUIRED_CONFIG_PATHS) {
    const value = getNestedValue(config, pathParts);
    if (value == null) {
      missingPaths.push(pathParts.join("."));
      continue;
    }
    if (typeof value === "string" && value.trim().length === 0) {
      missingPaths.push(pathParts.join("."));
    }
  }

  if (missingPaths.length > 0) {
    const expectedEnv = Object.keys(ENV_OVERRIDE_SPECS).sort().join(", ");
    throw new Error(
      `Missing required configuration values: ${missingPaths.join(
        ", "
      )}. Provide them in the JSON config file, via environment variables, or explicit overrides. Supported env vars: ${expectedEnv}`
    );
  }
}

function deepMerge(target, update) {
  for (const [key, updateValue] of Object.entries(update || {})) {
    const baseValue = target[key];
    if (isPlainObject(baseValue) && isPlainObject(updateValue)) {
      deepMerge(baseValue, updateValue);
      continue;
    }
    target[key] = deepClone(updateValue);
  }
}

function setNestedValue(target, pathParts, value) {
  let current = target;
  for (const part of pathParts.slice(0, -1)) {
    if (!isPlainObject(current[part])) current[part] = {};
    current = current[part];
  }
  current[pathParts[pathParts.length - 1]] = value;
}

function getNestedValue(source, pathParts) {
  let current = source;
  for (const part of pathParts) {
    if (!isPlainObject(current)) return undefined;
    current = current[part];
  }
  return current;
}

function deepClone(value) {
  // Safe enough for this project's configuration objects.
  return JSON.parse(JSON.stringify(value));
}

function isPlainObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function assertExists(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) {
      throw new Error(`Config path is not a file: ${filePath}`);
    }
  } catch (err) {
    if (String(err).includes("ENOENT")) {
      throw new Error(`Config file not found: ${filePath}`);
    }
    throw err;
  }
}

function parseBool(rawValue) {
  const normalized = String(rawValue).trim().toLowerCase();
  const truthy = new Set(["1", "true", "t", "yes", "y", "on"]);
  const falsy = new Set(["0", "false", "f", "no", "n", "off"]);
  if (truthy.has(normalized)) return true;
  if (falsy.has(normalized)) return false;
  throw new Error(`Cannot parse boolean value: ${JSON.stringify(rawValue)}`);
}

