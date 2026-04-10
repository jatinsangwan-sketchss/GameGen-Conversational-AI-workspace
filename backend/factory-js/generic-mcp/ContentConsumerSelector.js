/**
 * ContentConsumerSelector
 * -----------------------------------------------------------------------------
 * Generic, schema-driven classification of how a tool can consume generated
 * content (full body vs structured edit arrays). Used by the runner to avoid
 * routing blobs into incompatible tools and to pick schema-valid discriminator
 * values for synthesized structured items (no hardcoded "modify" type).
 */

/** Keep in sync with RichArgPayloadSynthesizer (avoid circular import). */
export const RICH_CONTAINER_KEYS = new Set(["modifications", "operations", "edits", "patches", "changes"]);

function safeString(value) {
  return value == null ? "" : String(value);
}

function isPlainObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function getProperties(schema) {
  return isPlainObject(schema?.properties) ? schema.properties : {};
}

function getRequired(schema) {
  return Array.isArray(schema?.required)
    ? schema.required.map((x) => safeString(x).trim()).filter(Boolean)
    : [];
}

export function extractToolSchema(toolName, inventory) {
  const tools = Array.isArray(inventory?.tools) ? inventory.tools : [];
  const tool = tools.find((t) => safeString(t?.name).trim() === safeString(toolName).trim()) ?? null;
  return isPlainObject(tool?.inputSchema) ? tool.inputSchema : {};
}

/** String-ish schema fields that can carry full generated body/source at write time. */
const DIRECT_CONTENT_NAME_RE =
  /^(content|body|source|text|code|snippet|scriptbody|scriptBody|filecontent|fileContent|sourcecode|sourceCode|raw|data)$/i;

const DIRECT_CONTENT_NORMALIZED_KEYS = new Set([
  "content",
  "body",
  "source",
  "text",
  "code",
  "snippet",
  "scriptbody",
  "scriptcontent",
  "scriptcode",
  "scriptsource",
  "scripttext",
  "filecontent",
  "filebody",
  "filecode",
  "filesource",
  "filetext",
  "sourcecode",
  "sourcecontent",
  "raw",
  "data",
]);

function normalizeContentKey(key) {
  return safeString(key).toLowerCase().replace(/[^a-z0-9]/g, "");
}

function schemaAllowsStringContent(propSchema) {
  const schema = isPlainObject(propSchema) ? propSchema : {};
  const directType = schema.type;
  if (typeof directType === "string") {
    return directType.trim().toLowerCase() === "string";
  }
  if (Array.isArray(directType)) {
    return directType.some((entry) => safeString(entry).trim().toLowerCase() === "string");
  }
  const unionKeys = ["anyOf", "oneOf", "allOf"];
  for (const key of unionKeys) {
    const variants = Array.isArray(schema[key]) ? schema[key] : [];
    for (const variant of variants) {
      if (!isPlainObject(variant)) continue;
      if (schemaAllowsStringContent(variant)) return true;
    }
  }
  return false;
}

function propertyLooksLikeDirectContentString(key, propSchema) {
  const k = safeString(key).trim();
  if (!schemaAllowsStringContent(propSchema)) return false;

  if (DIRECT_CONTENT_NAME_RE.test(k)) return true;
  const normalized = normalizeContentKey(k);
  if (!normalized) return false;
  if (DIRECT_CONTENT_NORMALIZED_KEYS.has(normalized)) return true;

  const suffixMatch = normalized.match(/(content|body|source|text|code|snippet)$/);
  if (!suffixMatch) return false;
  const suffix = safeString(suffixMatch[1]).trim();
  const prefix = normalized.slice(0, normalized.length - suffix.length);
  if (!prefix) return true;
  if (/(intent|path|ref|kind|type|mode|format|language|lang)$/.test(prefix)) return false;
  return /(script|file|source|raw|data|payload|template|content|code|text|body)/.test(prefix);
}

/**
 * Tools whose top-level schema includes a string field suitable for full generated content.
 */
export function listDirectContentArgKeys(schema) {
  const props = getProperties(schema);
  const out = [];
  for (const [k, sch] of Object.entries(props)) {
    if (propertyLooksLikeDirectContentString(k, sch)) out.push(k);
  }
  return out;
}

function schemaRequiresRichContainer(schema) {
  const req = getRequired(schema);
  return req.some((k) => RICH_CONTAINER_KEYS.has(k));
}

function schemaMentionsRichContainer(schema) {
  const props = getProperties(schema);
  for (const k of Object.keys(props)) {
    if (RICH_CONTAINER_KEYS.has(k)) return true;
  }
  return false;
}

/**
 * @returns {"create_with_content" | "modify_with_structured_edits" | "mixed" | "none"}
 */
export function classifyToolContentConsumerCapability(toolName, inventory) {
  const schema = extractToolSchema(toolName, inventory);
  const directKeys = listDirectContentArgKeys(schema);
  const requiresStructured = schemaRequiresRichContainer(schema);
  const mentionsStructured = schemaMentionsRichContainer(schema);
  const hasDirect = directKeys.length > 0;

  if (requiresStructured && hasDirect) return "mixed";
  if (requiresStructured && !hasDirect) return "modify_with_structured_edits";
  if (hasDirect) return "create_with_content";
  if (mentionsStructured) return "modify_with_structured_edits";
  return "none";
}

/**
 * Inventory scan: tools that can accept full body/content without requiring structured edit arrays.
 */
export function findDirectContentConsumerToolNames(inventory) {
  const tools = Array.isArray(inventory?.tools) ? inventory.tools : [];
  const names = [];
  for (const t of tools) {
    const n = safeString(t?.name).trim();
    if (!n) continue;
    const mode = classifyToolContentConsumerCapability(n, inventory);
    if (mode === "create_with_content" || mode === "mixed") names.push(n);
  }
  return names;
}

function isOperationLikeFieldName(fieldName) {
  const lower = safeString(fieldName).trim().toLowerCase();
  return /^(type|operation|op|action|kind|modificationtype|modificationType|editkind|editKind)$/.test(lower);
}

/**
 * Prefer schema enum/const for operation-like fields instead of guessing "modify".
 */
export function pickSchemaBackedOperationValue(fieldName, itemSchema) {
  const props = getProperties(itemSchema);
  const key = safeString(fieldName).trim();
  const sch = isPlainObject(props[key]) ? props[key] : {};
  if (Array.isArray(sch.enum) && sch.enum.length > 0) return sch.enum[0];
  if (sch.const != null) return sch.const;
  if (sch.default != null) return sch.default;
  return null;
}

/**
 * When building a synthetic structured item, pick (field → value) for the discriminator.
 */
export function pickDiscriminatorBindingForItemSchema(itemSchema) {
  const props = getProperties(itemSchema);
  const priority = [
    "modificationType",
    "modification_type",
    "type",
    "operation",
    "op",
    "action",
    "kind",
    "editKind",
    "edit_kind",
  ];
  for (const key of priority) {
    if (!Object.prototype.hasOwnProperty.call(props, key)) continue;
    const v = pickSchemaBackedOperationValue(key, itemSchema);
    if (v != null && safeString(v).trim() !== "") return { field: key, value: v };
  }
  for (const [key, sch] of Object.entries(props)) {
    if (!isPlainObject(sch)) continue;
    if (Array.isArray(sch.enum) && sch.enum.length > 0 && isOperationLikeFieldName(key)) {
      return { field: key, value: sch.enum[0] };
    }
  }
  return { field: null, value: null };
}

/**
 * Runner gate: block obvious wrong routing of generated content (e.g. edit-only tool
 * before artifact exists when a direct body-capable tool exists in inventory).
 *
 * @returns {{ ok: true } | { ok: false, code: string, reason: string, alternatives?: string[] }}
 */
export function evaluateContentConsumerGate({
  toolName,
  inventory,
  workflowState,
  contentStep = false,
  /** True when the tool schema requires a rich container (modifications/operations/...) — from inventory. */
  requiresStructuredPayload = false,
} = {}) {
  const name = safeString(toolName).trim();
  if (!name) return { ok: true };

  const semanticState = isPlainObject(workflowState?.semanticState) ? workflowState.semanticState : {};
  const hasBlob = Boolean(
    safeString(semanticState?.generatedContent?.content).trim() || safeString(semanticState?.generatedCode).trim()
  );
  if (!hasBlob) return { ok: true };

  const applied = safeString(semanticState?.contentApplication?.status).trim().toLowerCase() === "applied";
  if (applied) return { ok: true };

  const op = isPlainObject(workflowState?.artifactOperation) ? workflowState.artifactOperation : {};
  const mode = safeString(op.mode).trim().toLowerCase();
  const created = Boolean(op.observedEffects?.artifactCreated);

  const cap = classifyToolContentConsumerCapability(name, inventory);

  const createFirstModes = new Set(["create_then_modify", "create_then_attach", "create_then_modify_then_attach"]);
  if (createFirstModes.has(mode) && !created && cap === "modify_with_structured_edits") {
    const alternatives = findDirectContentConsumerToolNames(inventory).filter((n) => n !== name);
    if (alternatives.length > 0) {
      return {
        ok: false,
        code: "prefer_create_with_content",
        reason:
          "Generated content should be written via a create/save tool that accepts body/source directly. An edit-only structured tool was selected before the artifact exists.",
        alternatives,
      };
    }
  }

  if (contentStep && cap === "none" && requiresStructuredPayload) {
    return {
      ok: false,
      code: "unsupported_content_consumer",
      reason:
        "This tool requires structured edit payload fields, but its schema does not expose a compatible body/content field or item shape for generated content.",
    };
  }

  return { ok: true };
}
