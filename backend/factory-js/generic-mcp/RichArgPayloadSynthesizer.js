import {
  RICH_CONTAINER_KEYS,
  pickDiscriminatorBindingForItemSchema,
  pickSchemaBackedOperationValue,
} from "./ContentConsumerSelector.js";

function safeString(value) {
  return value == null ? "" : String(value);
}

function isPlainObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

export { RICH_CONTAINER_KEYS };

function hasText(value) {
  return safeString(value).trim().length > 0;
}

function extractToolSchema(toolName, inventory) {
  const tools = Array.isArray(inventory?.tools) ? inventory.tools : [];
  const tool = tools.find((t) => safeString(t?.name).trim() === safeString(toolName).trim()) ?? null;
  return isPlainObject(tool?.inputSchema) ? tool.inputSchema : {};
}

function getRequired(schema) {
  return Array.isArray(schema?.required)
    ? schema.required.map((x) => safeString(x).trim()).filter(Boolean)
    : [];
}

function getProperties(schema) {
  return isPlainObject(schema?.properties) ? schema.properties : {};
}

function getPropertySchema(schema, key) {
  const props = isPlainObject(schema?.properties) ? schema.properties : {};
  return isPlainObject(props[key]) ? props[key] : {};
}

function basenameWithoutExt(value) {
  const raw = safeString(value).trim();
  if (!raw) return null;
  const clean = raw.replace(/\\/g, "/");
  const base = clean.split("/").filter(Boolean).pop() || "";
  if (!base) return null;
  return base.includes(".") ? base.slice(0, base.lastIndexOf(".")) : base;
}

function hasPresentValue(value) {
  if (value == null) return false;
  if (typeof value === "string") return value.trim() !== "";
  if (Array.isArray(value)) return value.length > 0;
  if (isPlainObject(value)) return Object.keys(value).length > 0;
  return true;
}

function hasTypeMatch(value, typeName) {
  const t = safeString(typeName).trim().toLowerCase();
  if (!t) return true;
  if (t === "array") return Array.isArray(value);
  if (t === "object") return isPlainObject(value);
  if (t === "string") return typeof value === "string";
  if (t === "number" || t === "integer") return typeof value === "number" && Number.isFinite(value);
  if (t === "boolean") return typeof value === "boolean";
  return true;
}
function inferPrimitiveValueTypeToken(text) {
  const lower = safeString(text).trim().toLowerCase();
  if (!lower) return null;
  if (/\bbool(?:ean)?\b/.test(lower)) return "bool";
  if (/\bint(?:eger)?\b/.test(lower)) return "int";
  if (/\bfloat|double|decimal|number\b/.test(lower)) return "float";
  if (/\bstring|str\b/.test(lower)) return "String";
  return null;
}
function inferDefaultValueForType(typeToken) {
  const lower = safeString(typeToken).trim().toLowerCase();
  if (!lower) return undefined;
  if (lower === "bool" || lower === "boolean") return false;
  if (lower === "int" || lower === "integer") return 0;
  if (lower === "float" || lower === "double" || lower === "decimal" || lower === "number") return 0.0;
  if (lower === "string" || lower === "str") return "";
  return undefined;
}
function isVariableTypeFieldName(fieldName) {
  const lower = safeString(fieldName).trim().toLowerCase();
  if (!lower) return false;
  return (
    lower === "vartype" ||
    lower === "var_type" ||
    lower === "variabletype" ||
    lower === "variable_type" ||
    lower === "valuetype" ||
    lower === "value_type" ||
    lower === "datatype" ||
    lower === "data_type" ||
    lower === "typehint" ||
    lower === "type_hint"
  );
}
function isDefaultValueFieldName(fieldName) {
  const lower = safeString(fieldName).trim().toLowerCase();
  if (!lower) return false;
  return (
    lower === "defaultvalue" ||
    lower === "default_value" ||
    lower === "initialvalue" ||
    lower === "initial_value" ||
    lower === "value"
  );
}
function extractNamedIdentifierListFromIntent(text) {
  const raw = safeString(text);
  if (!raw.trim()) return [];
  const direct = raw.match(/\b(?:named?|name\s+them)\s+(.+?)(?:[.;!?]|$)/i);
  const fallback = raw.match(/\bvariables?\s+([A-Za-z0-9_,\sand-]+)(?:[.;!?]|$)/i);
  const segment = safeString(direct?.[1] || fallback?.[1]).trim();
  if (!segment) return [];
  const tokens = segment.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [];
  const stopwords = new Set([
    "add",
    "variable",
    "variables",
    "var",
    "vars",
    "name",
    "named",
    "them",
    "and",
    "or",
    "with",
    "bool",
    "boolean",
    "int",
    "integer",
    "float",
    "double",
    "string",
  ]);
  const out = [];
  const seen = new Set();
  for (const token of tokens) {
    const normalized = safeString(token).trim();
    if (!normalized) continue;
    const lower = normalized.toLowerCase();
    if (stopwords.has(lower)) continue;
    if (seen.has(lower)) continue;
    seen.add(lower);
    out.push(normalized);
  }
  return out;
}

function inferFieldValue({
  fieldName,
  generatedCode,
  codeIntent,
  targetRef,
  semanticEdit = null,
  itemSchema = null,
  itemIndex = 0,
  inferredNames = [],
} = {}) {
  const name = safeString(fieldName).trim();
  const lower = name.toLowerCase();
  if (!name) return undefined;
  const inferredType =
    safeString(semanticEdit?.valueType).trim() ||
    safeString(semanticEdit?.varType).trim() ||
    safeString(semanticEdit?.typeHint).trim() ||
    safeString(inferPrimitiveValueTypeToken(codeIntent)).trim() ||
    safeString(inferPrimitiveValueTypeToken(generatedCode)).trim() ||
    "";
  if (isVariableTypeFieldName(name)) {
    return inferredType || undefined;
  }
  if (isDefaultValueFieldName(name)) {
    const inferredDefault = inferDefaultValueForType(inferredType);
    if (inferredDefault !== undefined) return inferredDefault;
  }
  if (semanticEdit && /(name|property|prop|key|field|selector)/.test(lower) && hasText(semanticEdit.field)) {
    return semanticEdit.field;
  }
  if (/(name|property|prop|key|field|selector)/.test(lower)) {
    const fromIntent = Array.isArray(inferredNames) ? safeString(inferredNames[itemIndex]).trim() : "";
    if (fromIntent) return fromIntent;
  }
  if (semanticEdit && /(newvalue|new_value|value|to|after|replacement)/.test(lower)) {
    return semanticEdit.newValue;
  }
  if (semanticEdit && /(oldvalue|old_value|from|before|previous|old)/.test(lower)) {
    return semanticEdit.oldValue;
  }
  if (/(^type$|operation|action|op$|modification)/.test(lower)) {
    const picked = itemSchema ? pickSchemaBackedOperationValue(fieldName, itemSchema) : null;
    if (picked != null && safeString(picked).trim() !== "") return picked;
    return undefined;
  }
  if (/(content|code|text|body|snippet)/.test(lower)) {
    return safeString(generatedCode).trim() || safeString(codeIntent).trim() || undefined;
  }
  if (/(intent|summary|description|reason|note)/.test(lower)) {
    return safeString(codeIntent).trim() || safeString(generatedCode).trim() || undefined;
  }
  if (/(target|path|ref|file|resource|script|scene|node)/.test(lower)) {
    return safeString(targetRef).trim() || undefined;
  }
  if (lower === "name") {
    return basenameWithoutExt(targetRef) || safeString(targetRef).trim() || undefined;
  }
  return undefined;
}

function validateAndNormalizeStructuredArrayItems({
  key,
  value,
  propSchema,
  generatedCode,
  codeIntent,
  targetRef,
} = {}) {
  if (!Array.isArray(value)) {
    return {
      ok: false,
      normalized: value,
      missingRequiredFields: [],
      invalidTypeFields: [],
      firstItemValidation: {
        key,
        index: 0,
        valid: false,
        missingFields: ["<item_object>"],
        invalidTypeFields: [],
      },
    };
  }
  const itemSchema = isPlainObject(propSchema?.items) ? propSchema.items : {};
  const itemRequired = Array.isArray(itemSchema?.required)
    ? itemSchema.required.map((x) => safeString(x).trim()).filter(Boolean)
    : [];
  const itemProperties = isPlainObject(itemSchema?.properties) ? itemSchema.properties : {};
  const inferredNamesFromIntent = extractNamedIdentifierListFromIntent(codeIntent);
  const normalized = [];
  const missingRequiredFields = new Set();
  const invalidTypeFields = new Set();
  let firstItemValidation = null;
  let ok = true;

  for (let i = 0; i < value.length; i += 1) {
    const rawItem = isPlainObject(value[i]) ? { ...value[i] } : {};
    const isObject = isPlainObject(value[i]);
    const missingFields = [];
    const badTypeFields = [];

    if (!isObject) {
      ok = false;
      missingFields.push("<item_object>");
      missingRequiredFields.add("<item_object>");
    }

    for (const req of itemRequired) {
      if (hasPresentValue(rawItem[req])) continue;
      const inferred = inferFieldValue({
        fieldName: req,
        generatedCode,
        codeIntent,
        targetRef,
        itemSchema,
        itemIndex: i,
        inferredNames: inferredNamesFromIntent,
      });
      if (hasPresentValue(inferred)) {
        rawItem[req] = inferred;
      } else {
        missingFields.push(req);
        missingRequiredFields.add(req);
        ok = false;
      }
    }

    for (const req of itemRequired) {
      if (!hasPresentValue(rawItem[req])) continue;
      const expected = safeString(itemProperties?.[req]?.type).trim();
      if (expected && !hasTypeMatch(rawItem[req], expected)) {
        badTypeFields.push(req);
        invalidTypeFields.add(req);
        ok = false;
      }
    }

    normalized.push(rawItem);
    if (!firstItemValidation) {
      firstItemValidation = {
        key,
        index: i,
        valid: missingFields.length < 1 && badTypeFields.length < 1,
        missingFields,
        invalidTypeFields: badTypeFields,
      };
    }
  }

  if (!firstItemValidation) {
    firstItemValidation = {
      key,
      index: 0,
      valid: false,
      missingFields: ["<empty_array>"],
      invalidTypeFields: [],
    };
    missingRequiredFields.add("<empty_array>");
    ok = false;
  }

  return {
    ok,
    normalized,
    missingRequiredFields: [...missingRequiredFields],
    invalidTypeFields: [...invalidTypeFields],
    firstItemValidation,
  };
}

function hasValue(args, key) {
  const v = args?.[key];
  if (Array.isArray(v)) return v.length > 0;
  return v != null && safeString(v).trim() !== "";
}

function isSimpleScalar(value) {
  return value == null || ["string", "number", "boolean"].includes(typeof value);
}

function pushEdit(out, edit) {
  if (!isPlainObject(edit)) return;
  const field = safeString(edit.field).trim();
  if (!field) return;
  out.push({
    kind: safeString(edit.kind).trim() || "set_value",
    field,
    newValue: edit.newValue,
    oldValue: edit.oldValue,
    valueType: safeString(edit.valueType).trim() || null,
  });
}

function extractVariableAddEditsFromIntent(text) {
  const source = safeString(text).trim();
  if (!source) return [];
  const lower = source.toLowerCase();
  if (!/\badd\b/.test(lower) || !/\bvariables?\b/.test(lower)) return [];
  const names = extractNamedIdentifierListFromIntent(source);
  if (names.length < 1) return [];
  const valueType = inferPrimitiveValueTypeToken(source);
  const defaultValue = inferDefaultValueForType(valueType);
  return names.map((name) => ({
    kind: "add_variable",
    field: name,
    valueType: valueType || null,
    ...(defaultValue !== undefined ? { newValue: defaultValue } : {}),
  }));
}

function deriveSemanticEdits({ args = null, semanticIntent = null, workflowState = null } = {}) {
  const out = [];
  const seen = new Set();
  const push = (edit) => {
    if (!isPlainObject(edit)) return;
    const key = [
      safeString(edit.kind).trim().toLowerCase(),
      safeString(edit.field).trim().toLowerCase(),
      safeString(edit.valueType).trim().toLowerCase(),
      String(edit.newValue),
    ].join("::");
    if (seen.has(key)) return;
    seen.add(key);
    pushEdit(out, edit);
  };
  const a = isPlainObject(args) ? args : {};
  const ss = isPlainObject(workflowState?.semanticState) ? workflowState.semanticState : {};
  const intents = [];
  if (Array.isArray(a.targetedEdits)) intents.push(...a.targetedEdits);
  if (Array.isArray(ss?.targetedEdits)) intents.push(...ss.targetedEdits);
  if (Array.isArray(semanticIntent?.targetedEdits)) intents.push(...semanticIntent.targetedEdits);
  for (const e of intents) push(e);

  const objectContainers = ["modifications", "operations", "edits", "patches", "changes"];
  for (const k of objectContainers) {
    const v = a[k];
    if (!isPlainObject(v)) continue;
    for (const [field, value] of Object.entries(v)) {
      if (!hasText(field)) continue;
      if (!isSimpleScalar(value)) continue;
      push({ kind: "set_value", field, newValue: value });
    }
  }
  const intentSources = [
    a.contentIntent,
    a.codeIntent,
    ss?.contentIntent,
    ss?.codeIntent,
    semanticIntent?.contentIntent,
    semanticIntent?.codeIntent,
  ];
  for (const source of intentSources) {
    const edits = extractVariableAddEditsFromIntent(source);
    for (const edit of edits) push(edit);
  }
  return out;
}

function hasRichContainerValue(value) {
  if (Array.isArray(value)) return value.length > 0;
  if (isPlainObject(value)) return Object.keys(value).length > 0;
  return false;
}

function normalizeEditKind(value) {
  const lower = safeString(value).trim().toLowerCase();
  if (!lower) return "set_value";
  if (/(rename)/.test(lower)) return "rename";
  if (/(remove|delete|unset)/.test(lower)) return "remove";
  if (/(add|insert|append|create)/.test(lower)) return "add";
  if (/(replace)/.test(lower)) return "replace";
  return "set_value";
}

function candidateOperationValuesForEditKind(kind) {
  const k = normalizeEditKind(kind);
  if (k === "rename") return ["rename", "set", "update", "modify"];
  if (k === "remove") return ["remove", "delete", "unset", "update", "modify"];
  if (k === "add") return ["add", "insert", "append", "create", "update"];
  if (k === "replace") return ["replace", "update", "modify", "set"];
  return ["set", "update", "modify", "replace", "change", "assign"];
}

function isOperationLikeFieldName(fieldName) {
  const lower = safeString(fieldName).trim().toLowerCase();
  return /^(type|operation|op|action|kind|modificationtype|modification_type|editkind|edit_kind)$/.test(lower);
}

function pickOperationFieldSchema(itemSchema) {
  const itemProps = isPlainObject(itemSchema?.properties) ? itemSchema.properties : {};
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
    if (isPlainObject(itemProps[key])) return { field: key, schema: itemProps[key] };
  }
  for (const [key, schema] of Object.entries(itemProps)) {
    if (!isPlainObject(schema)) continue;
    if (isOperationLikeFieldName(key)) return { field: key, schema };
  }
  return { field: null, schema: null };
}

function mapTargetedEditOperationValue({ semanticEdit = null, itemSchema = null, fieldName = null } = {}) {
  const field = safeString(fieldName).trim();
  if (!field) return { ok: false, value: null, reason: "no_operation_field" };
  const props = isPlainObject(itemSchema?.properties) ? itemSchema.properties : {};
  const fieldSchema = isPlainObject(props[field]) ? props[field] : {};
  const schemaBacked = pickSchemaBackedOperationValue(field, itemSchema);
  if (schemaBacked != null && safeString(schemaBacked).trim() !== "") {
    return { ok: true, value: schemaBacked, reason: "schema_default" };
  }
  const enumValues = Array.isArray(fieldSchema?.enum)
    ? fieldSchema.enum.map((x) => safeString(x).trim()).filter(Boolean)
    : [];
  const candidates = candidateOperationValuesForEditKind(semanticEdit?.kind);
  if (enumValues.length > 0) {
    const enumMap = new Map(enumValues.map((v) => [v.toLowerCase(), v]));
    for (const c of candidates) {
      const exact = enumMap.get(c.toLowerCase());
      if (exact) return { ok: true, value: exact, reason: "enum_exact" };
    }
    for (const e of enumValues) {
      const low = e.toLowerCase();
      if (candidates.some((c) => low.includes(c.toLowerCase()) || c.toLowerCase().includes(low))) {
        return { ok: true, value: e, reason: "enum_fuzzy" };
      }
    }
    return { ok: false, value: null, reason: "enum_mismatch" };
  }
  const typeName = safeString(fieldSchema?.type).trim().toLowerCase();
  if (!typeName || typeName === "string") {
    return { ok: true, value: candidates[0], reason: "string_fallback" };
  }
  return { ok: false, value: null, reason: "unsupported_discriminator_type" };
}

function isArtifactLikeKey(key) {
  const lower = safeString(key).trim().toLowerCase();
  if (!lower) return false;
  if (lower === "artifactref" || lower === "artifactpath") return true;
  if (/(scene|node|project|targetnode|parent)/.test(lower)) return false;
  if (/(script|file|resource|asset|document|module|template|artifact)/.test(lower)) {
    return lower.endsWith("ref") || lower.endsWith("path") || lower === "path";
  }
  return false;
}

function collectArtifactLikeEntries(source) {
  if (!isPlainObject(source)) return [];
  const out = [];
  for (const [key, value] of Object.entries(source)) {
    if (!isArtifactLikeKey(key)) continue;
    const text = safeString(value).trim();
    if (!text) continue;
    out.push({ key, value: text });
  }
  return out;
}

function canonicalizeArtifactTarget({ args = null, semanticIntent = null, workflowState = null } = {}) {
  const operationTarget = safeString(workflowState?.artifactOperation?.targetArtifactRef).trim();
  if (operationTarget) return operationTarget;
  const sources = [
    args,
    isPlainObject(workflowState?.semanticState?.targetRefs) ? workflowState.semanticState.targetRefs : null,
    isPlainObject(workflowState?.semanticIntent?.targetRefs) ? workflowState.semanticIntent.targetRefs : null,
    isPlainObject(workflowState?.semanticIntent?.refs) ? workflowState.semanticIntent.refs : null,
    isPlainObject(semanticIntent?.targetRefs) ? semanticIntent.targetRefs : null,
    isPlainObject(semanticIntent?.refs) ? semanticIntent.refs : null,
  ];
  const preferred = [];
  const fallback = [];
  for (const src of sources) {
    for (const entry of collectArtifactLikeEntries(src)) {
      const lower = safeString(entry.key).toLowerCase();
      if (lower === "artifactref") preferred.push(entry.value);
      else fallback.push(entry.value);
    }
  }
  return preferred[0] || fallback[0] || null;
}

function isValidRichPayloadValue(value, propSchema) {
  const kind = safeString(propSchema?.type).trim().toLowerCase();
  if (kind === "array") return Array.isArray(value) && value.length > 0;
  if (kind === "object") return isPlainObject(value) && Object.keys(value).length > 0;
  return hasRichContainerValue(value);
}

function guessTargetRef(args, semanticIntent) {
  const candidates = [
    args?.targetRef,
    args?.targetNodeRef,
    args?.nodeRef,
    args?.scriptRef,
    args?.fileRef,
    args?.resourceRef,
    args?.sceneRef,
    semanticIntent?.refs?.targetNodeRef,
    semanticIntent?.refs?.scriptRef,
    semanticIntent?.refs?.artifactRef,
    semanticIntent?.targetRefs?.artifactRef,
    semanticIntent?.targetRefs?.scriptRef,
    semanticIntent?.targetRefs?.fileRef,
    semanticIntent?.targetRefs?.resourceRef,
    semanticIntent?.refs?.sceneRef,
  ];
  for (const c of candidates) {
    const s = safeString(c).trim();
    if (s) return s;
  }
  return null;
}

function buildGenericOperation({ toolName = null, richKey, codeIntent, generatedCode, targetRef, semanticIntent, semanticEdit = null, itemSchema }) {
  const binding = pickDiscriminatorBindingForItemSchema(isPlainObject(itemSchema) ? itemSchema : {});
  const op = {
    intent:
      safeString(codeIntent).trim() ||
      (hasText(semanticEdit?.field) ? `set ${semanticEdit.field}` : "") ||
      safeString(semanticIntent?.behaviorIntent).trim() ||
      "apply requested change",
    target: targetRef,
    content: safeString(generatedCode).trim() || null,
    notes: richKey,
    ...(hasText(semanticEdit?.field) ? { field: semanticEdit.field } : {}),
    ...(semanticEdit?.newValue != null ? { value: semanticEdit.newValue } : {}),
    ...(semanticEdit?.oldValue != null ? { oldValue: semanticEdit.oldValue } : {}),
  };
  if (binding.field && binding.value != null && safeString(binding.value).trim() !== "") {
    op[binding.field] = binding.value;
  } else {
    const discriminator = pickOperationFieldSchema(itemSchema);
    if (discriminator.field) {
      const mapped = mapTargetedEditOperationValue({
        semanticEdit,
        itemSchema,
        fieldName: discriminator.field,
      });
      console.log("[VERIFY][targeted-edit-mapping]", {
        tool: safeString(toolName).trim() || null,
        semanticEditKind: safeString(semanticEdit?.kind).trim() || "set_value",
        mappedField: discriminator.field,
        mappedType: mapped.value,
        mappingSucceeded: Boolean(mapped.ok && hasText(mapped.value)),
        mappingReason: mapped.reason,
      });
      if (mapped.ok && hasText(mapped.value)) {
        op[discriminator.field] = mapped.value;
      }
    }
  }
  return op;
}

function coerceToShape(op, propSchema) {
  const kind = safeString(propSchema?.type).trim().toLowerCase();
  if (kind === "array") return [op];
  if (kind === "object") return { operations: [op] };
  return [op];
}

export function synthesizeRichArgsForTool({
  toolName,
  args = null,
  inventory = null,
  workflowState = null,
  semanticIntent = null,
} = {}) {
  const out = isPlainObject(args) ? { ...args } : {};
  const schema = extractToolSchema(toolName, inventory);
  const required = getRequired(schema);
  const missingRichKeys = required.filter((k) => {
    if (!RICH_CONTAINER_KEYS.has(k)) return false;
    return !isValidRichPayloadValue(out[k], getPropertySchema(schema, k));
  });
  if (missingRichKeys.length === 0) {
    return { args: out, synthesized: false, missingSemanticField: null };
  }

  const codeIntent =
    safeString(out.contentIntent).trim() ||
    safeString(out.codeIntent).trim() ||
    safeString(semanticIntent?.contentIntent).trim() ||
    safeString(semanticIntent?.codeIntent).trim() ||
    safeString(workflowState?.semanticState?.contentIntent).trim() ||
    safeString(workflowState?.semanticIntent?.codeIntent).trim() ||
    "";
  const generatedCode =
    safeString(workflowState?.semanticState?.generatedContent?.content).trim() ||
    safeString(out.generatedCode).trim() ||
    safeString(workflowState?.generatedArtifacts?.[0]?.content).trim() ||
    "";
  const operationState = isPlainObject(workflowState?.artifactOperation) ? workflowState.artifactOperation : {};
  const opMode = safeString(operationState?.mode).trim().toLowerCase();
  const semanticEdits = deriveSemanticEdits({
    args: out,
    semanticIntent: semanticIntent ?? workflowState?.semanticIntent,
    workflowState,
  });
  const canonicalArtifactTarget = canonicalizeArtifactTarget({
    args: out,
    semanticIntent: semanticIntent ?? workflowState?.semanticIntent,
    workflowState,
  });
  if (canonicalArtifactTarget && !hasText(out.artifactRef)) {
    out.artifactRef = canonicalArtifactTarget;
  }
  const targetRef = canonicalArtifactTarget || guessTargetRef(out, semanticIntent ?? workflowState?.semanticIntent);
  const requiresExistingTarget = ["modify_existing", "attach_existing", "modify_then_attach"].includes(opMode);
  if (requiresExistingTarget && !canonicalArtifactTarget) {
    return { args: out, synthesized: false, missingSemanticField: "artifactRef" };
  }
  if (!codeIntent && !generatedCode && semanticEdits.length < 1) {
    return { args: out, synthesized: false, missingSemanticField: "contentIntent" };
  }

  for (const richKey of missingRichKeys) {
    const propSchema = getPropertySchema(schema, richKey);
    const itemSchema = isPlainObject(propSchema?.items) ? propSchema.items : {};
    if (semanticEdits.length > 0) {
      const ops = semanticEdits.map((edit) =>
        buildGenericOperation({
          toolName,
          richKey,
          codeIntent,
          generatedCode,
          targetRef,
          semanticIntent: semanticIntent ?? workflowState?.semanticIntent,
          semanticEdit: edit,
          itemSchema,
        })
      );
      const kind = safeString(propSchema?.type).trim().toLowerCase();
      out[richKey] = kind === "object" ? { operations: ops } : ops;
      continue;
    }
    const op = buildGenericOperation({
      toolName,
      richKey,
      codeIntent,
      generatedCode,
      targetRef,
      semanticIntent: semanticIntent ?? workflowState?.semanticIntent,
      itemSchema,
    });
    out[richKey] = coerceToShape(op, propSchema);
  }

  return { args: out, synthesized: true, missingSemanticField: null };
}

export function getRequiredRichPayloadKeys({ toolName, inventory } = {}) {
  const schema = extractToolSchema(toolName, inventory);
  const required = getRequired(schema);
  const props = getProperties(schema);
  return required.filter((k) => {
    if (!RICH_CONTAINER_KEYS.has(k)) return false;
    const kind = safeString(props?.[k]?.type).trim().toLowerCase();
    return kind === "array" || kind === "object" || kind === "";
  });
}

export function ensureRichPayloadReadiness({
  toolName,
  args = null,
  inventory = null,
  workflowState = null,
  semanticIntent = null,
} = {}) {
  const schema = extractToolSchema(toolName, inventory);
  const requiredRichKeys = getRequiredRichPayloadKeys({ toolName, inventory });
  const baseArgs = isPlainObject(args) ? { ...args } : {};
  const semanticRefs = isPlainObject(workflowState?.semanticState?.targetRefs)
    ? workflowState.semanticState.targetRefs
    : (isPlainObject(semanticIntent?.refs) ? semanticIntent.refs : {});
  const semanticCreationIntent = isPlainObject(workflowState?.semanticState?.creationIntent)
    ? workflowState.semanticState.creationIntent
    : {};
  const semanticContentIntent = safeString(
    workflowState?.semanticState?.contentIntent ||
    semanticIntent?.contentIntent ||
    semanticIntent?.codeIntent ||
    args?.contentIntent ||
    args?.codeIntent
  ).trim() || null;
  console.log("[VERIFY][payload-synthesis-input]", {
    tool: safeString(toolName).trim() || null,
    requiresStructuredPayload: requiredRichKeys.length > 0,
    requiredStructuredKeys: requiredRichKeys,
    targetRefs: semanticRefs,
    creationIntent: semanticCreationIntent,
    contentIntent: semanticContentIntent,
    codeIntent: safeString(semanticIntent?.codeIntent || args?.codeIntent).trim() || null,
    argKeys: Object.keys(baseArgs),
    argsPreview: baseArgs,
  });
  if (requiredRichKeys.length < 1) {
    const out = {
      status: "not_applicable",
      args: baseArgs,
      requiredRichKeys: [],
      missingRichKeys: [],
      missingSemanticField: null,
      reason: null,
    };
    console.log("[VERIFY][payload-synthesis-output]", {
      tool: safeString(toolName).trim() || null,
      synthesisRan: false,
      synthesisStatus: out.status,
      requiredStructuredKeys: out.requiredRichKeys,
      missingStructuredKeys: out.missingRichKeys,
      argKeys: Object.keys(out.args || {}),
      hasModifications: Array.isArray(out.args?.modifications),
      modificationsLength: Array.isArray(out.args?.modifications) ? out.args.modifications.length : null,
      hasOperations: Array.isArray(out.args?.operations) || isPlainObject(out.args?.operations),
      operationsLength: Array.isArray(out.args?.operations) ? out.args.operations.length : (isPlainObject(out.args?.operations) ? Object.keys(out.args.operations).length : null),
      hasEdits: Array.isArray(out.args?.edits),
      editsLength: Array.isArray(out.args?.edits) ? out.args.edits.length : null,
      hasPatches: Array.isArray(out.args?.patches),
      patchesLength: Array.isArray(out.args?.patches) ? out.args.patches.length : null,
      hasChanges: Array.isArray(out.args?.changes),
      changesLength: Array.isArray(out.args?.changes) ? out.args.changes.length : null,
      missingSemanticField: out.missingSemanticField,
    });
    return out;
  }

  const initiallyMissing = requiredRichKeys.filter((k) => !isValidRichPayloadValue(baseArgs[k], getPropertySchema(schema, k)));
  let synthesisRan = false;
  let missingSemanticField = null;
  let workingArgs = { ...baseArgs };
  if (initiallyMissing.length > 0) {
    const synthesized = synthesizeRichArgsForTool({
      toolName,
      args: baseArgs,
      inventory,
      workflowState,
      semanticIntent,
    });
    workingArgs = isPlainObject(synthesized.args) ? { ...synthesized.args } : {};
    synthesisRan = Boolean(synthesized.synthesized);
    missingSemanticField = synthesized.missingSemanticField || null;
  }

  const finalMissing = requiredRichKeys.filter((k) => !isValidRichPayloadValue(workingArgs[k], getPropertySchema(schema, k)));
  const normalizedArgs = { ...workingArgs };
  const itemLevelInvalid = [];
  for (const key of requiredRichKeys) {
    const propSchema = getPropertySchema(schema, key);
    if (!Array.isArray(normalizedArgs[key])) continue;
    const itemCheck = validateAndNormalizeStructuredArrayItems({
      key,
      value: normalizedArgs[key],
      propSchema,
      generatedCode:
        safeString(workflowState?.semanticState?.generatedCode).trim() ||
        safeString(workflowState?.semanticState?.generatedContent?.content).trim() ||
        "",
      codeIntent:
        safeString(baseArgs?.contentIntent).trim() ||
        safeString(baseArgs?.codeIntent).trim() ||
        safeString(semanticIntent?.contentIntent).trim() ||
        safeString(semanticIntent?.codeIntent).trim() ||
        "",
      targetRef: canonicalizeArtifactTarget({
        args: normalizedArgs,
        semanticIntent: semanticIntent ?? workflowState?.semanticIntent,
        workflowState,
      }) || guessTargetRef(normalizedArgs, semanticIntent ?? workflowState?.semanticIntent),
    });
    normalizedArgs[key] = itemCheck.normalized;
    const firstItem = Array.isArray(itemCheck.normalized) && itemCheck.normalized.length > 0 ? itemCheck.normalized[0] : null;
    console.log("[VERIFY][compiled-first-item]", {
      tool: safeString(toolName).trim() || null,
      structuredKey: key,
      firstItem,
      validation: itemCheck.firstItemValidation,
      missingRequiredItemFields: itemCheck.missingRequiredFields,
      invalidTypeItemFields: itemCheck.invalidTypeFields,
    });
    if (!itemCheck.ok) {
      itemLevelInvalid.push({
        key,
        missingRequiredFields: itemCheck.missingRequiredFields,
        invalidTypeFields: itemCheck.invalidTypeFields,
      });
    }
  }

  if (finalMissing.length < 1) {
    if (itemLevelInvalid.length > 0) {
      const missingFieldCandidates = itemLevelInvalid.flatMap((x) => Array.isArray(x.missingRequiredFields) ? x.missingRequiredFields : []);
      const canonicalTarget = canonicalizeArtifactTarget({
        args: normalizedArgs,
        semanticIntent: semanticIntent ?? workflowState?.semanticIntent,
        workflowState,
      });
      const semanticField = missingFieldCandidates.some((f) => /(content|code|text|body|snippet|intent)/i.test(safeString(f)))
        ? "contentIntent"
        : (canonicalTarget ? null : "artifactRef");
      const out = {
        status: "not_ready",
        args: normalizedArgs,
        requiredRichKeys,
        missingRichKeys: itemLevelInvalid.map((x) => x.key),
        missingSemanticField: missingSemanticField || semanticField,
        reason: `Uncompilable structured edit payload for: ${itemLevelInvalid.map((x) => x.key).join(", ")}`,
      };
      console.log("[VERIFY][payload-synthesis-output]", {
        tool: safeString(toolName).trim() || null,
        synthesisRan,
        synthesisStatus: out.status,
        requiredStructuredKeys: out.requiredRichKeys,
        missingStructuredKeys: out.missingRichKeys,
        argKeys: Object.keys(out.args || {}),
        hasModifications: Array.isArray(out.args?.modifications),
        modificationsLength: Array.isArray(out.args?.modifications) ? out.args.modifications.length : null,
        hasOperations: Array.isArray(out.args?.operations) || isPlainObject(out.args?.operations),
        operationsLength: Array.isArray(out.args?.operations) ? out.args.operations.length : (isPlainObject(out.args?.operations) ? Object.keys(out.args.operations).length : null),
        hasEdits: Array.isArray(out.args?.edits),
        editsLength: Array.isArray(out.args?.edits) ? out.args.edits.length : null,
        hasPatches: Array.isArray(out.args?.patches),
        patchesLength: Array.isArray(out.args?.patches) ? out.args.patches.length : null,
        hasChanges: Array.isArray(out.args?.changes),
        changesLength: Array.isArray(out.args?.changes) ? out.args.changes.length : null,
        missingSemanticField: out.missingSemanticField,
        reason: out.reason,
      });
      return out;
    }
    const out = {
      status: "ready",
      args: normalizedArgs,
      requiredRichKeys,
      missingRichKeys: [],
      missingSemanticField: null,
      reason: null,
    };
    console.log("[VERIFY][payload-synthesis-output]", {
      tool: safeString(toolName).trim() || null,
      synthesisRan,
      synthesisStatus: out.status,
      requiredStructuredKeys: out.requiredRichKeys,
      missingStructuredKeys: out.missingRichKeys,
      argKeys: Object.keys(out.args || {}),
      hasModifications: Array.isArray(out.args?.modifications),
      modificationsLength: Array.isArray(out.args?.modifications) ? out.args.modifications.length : null,
      hasOperations: Array.isArray(out.args?.operations) || isPlainObject(out.args?.operations),
      operationsLength: Array.isArray(out.args?.operations) ? out.args.operations.length : (isPlainObject(out.args?.operations) ? Object.keys(out.args.operations).length : null),
      hasEdits: Array.isArray(out.args?.edits),
      editsLength: Array.isArray(out.args?.edits) ? out.args.edits.length : null,
      hasPatches: Array.isArray(out.args?.patches),
      patchesLength: Array.isArray(out.args?.patches) ? out.args.patches.length : null,
      hasChanges: Array.isArray(out.args?.changes),
      changesLength: Array.isArray(out.args?.changes) ? out.args.changes.length : null,
      missingSemanticField: out.missingSemanticField,
    });
    return out;
  }

  const out = {
    status: "not_ready",
    args: normalizedArgs,
    requiredRichKeys,
    missingRichKeys: finalMissing,
    missingSemanticField: missingSemanticField || "contentIntent",
    reason: `Structured payload required but not ready: ${finalMissing.join(", ")}`,
  };
  console.log("[VERIFY][payload-synthesis-output]", {
    tool: safeString(toolName).trim() || null,
    synthesisRan: true,
    synthesisStatus: out.status,
    requiredStructuredKeys: out.requiredRichKeys,
    missingStructuredKeys: out.missingRichKeys,
    argKeys: Object.keys(out.args || {}),
    hasModifications: Array.isArray(out.args?.modifications),
    modificationsLength: Array.isArray(out.args?.modifications) ? out.args.modifications.length : null,
    hasOperations: Array.isArray(out.args?.operations) || isPlainObject(out.args?.operations),
    operationsLength: Array.isArray(out.args?.operations) ? out.args.operations.length : (isPlainObject(out.args?.operations) ? Object.keys(out.args.operations).length : null),
    hasEdits: Array.isArray(out.args?.edits),
    editsLength: Array.isArray(out.args?.edits) ? out.args.edits.length : null,
    hasPatches: Array.isArray(out.args?.patches),
    patchesLength: Array.isArray(out.args?.patches) ? out.args.patches.length : null,
    hasChanges: Array.isArray(out.args?.changes),
    changesLength: Array.isArray(out.args?.changes) ? out.args.changes.length : null,
    missingSemanticField: out.missingSemanticField,
    reason: out.reason,
  });
  return out;
}
