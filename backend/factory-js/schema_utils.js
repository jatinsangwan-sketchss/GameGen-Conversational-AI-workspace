/**
 * JSON schema loading + validation helpers for the factory.
 *
 * Mirrors the Python factory/schema_utils.py responsibilities:
 * - loadJsonSchema(schemaPath) => schema object (must be a JSON object root)
 * - validateDataAgainstSchema(data, schema) => { is_valid, errors[] }
 *
 * Error normalization is designed to match the factory's expected structure:
 * {
 *   path: string[],
 *   schema_path: string[],
 *   message: string,
 *   validator: string,
 *   validator_value: any
 * }
 */

import fs from "node:fs";
import path from "node:path";
import Ajv from "ajv";

const ajv = new Ajv({ allErrors: true, strict: false });

export function loadJsonSchema(schemaPath) {
  const resolved = path.resolve(String(schemaPath));
  const schemaRoot = fs.readFileSync(resolved, "utf-8");

  let parsed;
  try {
    parsed = JSON.parse(schemaRoot);
  } catch (err) {
    throw new Error(`Invalid JSON in schema file '${resolved}': ${err}`);
  }

  if (!isPlainObject(parsed)) {
    throw new Error(`Schema file root must be a JSON object: ${resolved}`);
  }
  return parsed;
}

export function validateDataAgainstSchema(data, schema) {
  ensureObject("data", data);
  ensureObject("schema", schema);

  // Avoid Ajv attempting to resolve the $schema meta-schema URL.
  // The Python `jsonschema` loader is tolerant here; for v1 we mirror that.
  const schemaForAjv = isPlainObject(schema) ? { ...schema } : schema;
  if (schemaForAjv && typeof schemaForAjv === "object" && "$schema" in schemaForAjv) {
    delete schemaForAjv.$schema;
  }

  const validate = ajv.compile(schemaForAjv);
  const ok = validate(data);
  if (ok) {
    return { is_valid: true, errors: [] };
  }

  const errors = (validate.errors || [])
    .slice()
    .sort((a, b) => {
      const aPath = normalizePath(a.instancePath || "");
      const bPath = normalizePath(b.instancePath || "");
      return aPath.join("/").localeCompare(bPath.join("/"));
    })
    .map((err) => {
      const errorObj = err || {};
      return {
        path: normalizePath(errorObj.instancePath || ""),
        schema_path: normalizePath(errorObj.schemaPath || ""),
        message: String(errorObj.message || ""),
        validator: String(errorObj.keyword || ""),
        validator_value: errorObj.params ?? null,
      };
    });

  return { is_valid: false, errors };
}

function normalizePath(p) {
  // Ajv formats instancePath/schemaPath as JSON Pointer-ish like:
  //   "/paths/0/name" or "#/properties/x"
  return String(p)
    .split("/")
    .filter((seg) => seg.length > 0 && seg !== "#");
}

function ensureObject(name, value) {
  if (!isPlainObject(value)) {
    throw new TypeError(`'${name}' must be a dict-like object`);
  }
}

function isPlainObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

