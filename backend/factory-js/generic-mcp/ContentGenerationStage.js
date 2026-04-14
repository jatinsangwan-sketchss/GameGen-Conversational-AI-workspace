import { buildGenerationContext, evaluateGenerationTargetReadiness } from "./GenerationContextBuilder.js";

function safeString(value) {
  return value == null ? "" : String(value);
}

function isPlainObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function normalizeIntentKey(intent) {
  return safeString(intent).trim().toLowerCase();
}

function isGodotScriptLikeContext({ toolName = "", generationContext = null } = {}) {
  const toolLower = safeString(toolName).trim().toLowerCase();
  const runtime = safeString(generationContext?.runtime).trim().toLowerCase();
  const artifactKind = safeString(generationContext?.artifactKind).trim().toLowerCase();
  return (
    runtime === "godot" &&
    (/script|gdscript|code|edit|modify|create|write|save/.test(toolLower) || artifactKind === "script")
  );
}

function normalizeGodot4Syntax(content) {
  let text = safeString(content);
  if (!text.trim()) return text;
  // Godot 3.x -> 4.x syntax normalization (generic language-level fixups).
  text = text.replace(/(^|\n)\s*export\s+var\b/g, "$1@export var");
  text = text.replace(/(^|\n)\s*onready\s+var\b/g, "$1@onready var");
  text = text.replace(/\byield\s*\(/g, "await ");
  return text;
}

function stripCodeFences(text) {
  const raw = safeString(text);
  const fenced = raw.match(/```(?:gdscript|gd)?\s*([\s\S]*?)```/i);
  if (fenced && safeString(fenced[1]).trim()) return fenced[1].trim();
  return raw.trim();
}

function validateGodot4Script(content) {
  const text = safeString(content);
  const issues = [];
  const push = (code, message) => issues.push({ code, message });
  if (!text.trim()) push("empty_script", "Generated script is empty.");
  if (/(^|\n)\s*export\s+var\b/.test(text)) push("godot3_export_var", "Uses Godot 3.x `export var` syntax.");
  if (/(^|\n)\s*onready\s+var\b/.test(text)) push("godot3_onready_var", "Uses Godot 3.x `onready var` syntax.");
  if (/\byield\s*\(/.test(text)) push("godot3_yield", "Uses Godot 3.x `yield()` syntax.");
  const extendsMatches = text.match(/(^|\n)\s*extends\s+[^\n]+/g) || [];
  if (extendsMatches.length > 1) push("duplicate_extends", "Contains multiple `extends` declarations.");
  return { ok: issues.length === 0, issues };
}

async function attemptGodot4Repair({
  invalidContent = "",
  issues = [],
  intent = "",
  generationContext = null,
  toolName = "",
  modelClient = null,
} = {}) {
  const normalized = normalizeGodot4Syntax(invalidContent);
  const normalizedCheck = validateGodot4Script(normalized);
  if (normalizedCheck.ok) {
    return {
      ok: true,
      content: normalized,
      repairedBy: "normalizer",
      issues: [],
    };
  }
  if (!modelClient || typeof modelClient.generate !== "function") {
    return {
      ok: false,
      content: normalized,
      repairedBy: null,
      issues: normalizedCheck.issues,
      reason: "model_repair_unavailable",
    };
  }

  const repairPrompt = [
    "Repair this GDScript to valid Godot 4.6 style.",
    "Return only code, no markdown fences.",
    "Keep behavior intent unchanged.",
    `tool: ${safeString(toolName).trim()}`,
    `intent: ${safeString(intent).trim()}`,
    `generationContext: ${JSON.stringify(isPlainObject(generationContext) ? generationContext : {})}`,
    `validationIssues: ${JSON.stringify(Array.isArray(issues) ? issues : [])}`,
    "invalidCode:",
    safeString(invalidContent),
  ].join("\n");

  try {
    if (DEBUG_VERIFY) {
      console.log("[generic-mcp][contentgen][model-input]", {
        phase: "repair",
        responseFormat: "text",
        tool: safeString(toolName).trim() || null,
        promptPreview: safeString(repairPrompt).slice(0, 4000),
      });
    }
    const repairedRaw = await modelClient.generate({ prompt: repairPrompt, responseFormat: "text" });
    const repairedText = stripCodeFences(safeString(repairedRaw?.text ?? repairedRaw));
    const finalText = normalizeGodot4Syntax(repairedText);
    const finalCheck = validateGodot4Script(finalText);
    if (finalCheck.ok) {
      return {
        ok: true,
        content: finalText,
        repairedBy: "model_repair",
        issues: [],
      };
    }
    return {
      ok: false,
      content: finalText,
      repairedBy: "model_repair",
      issues: finalCheck.issues,
      reason: "repair_failed_validation",
    };
  } catch {
    return {
      ok: false,
      content: normalized,
      repairedBy: null,
      issues: normalizedCheck.issues,
      reason: "repair_call_failed",
    };
  }
}

function buildPrompt({ contentIntent, toolName, semanticState, args, generationContext }) {
  const targetRefs = isPlainObject(semanticState?.targetRefs) ? semanticState.targetRefs : {};
  const creationIntent = isPlainObject(semanticState?.creationIntent) ? semanticState.creationIntent : {};
  return [
    "Generate concrete content for a generic MCP editing/writing workflow.",
    "Return JSON only with keys: kind, content, summary.",
    "kind should be one of: code_snippet, text_block, patch_notes.",
    "content must be actual implementation content, not intent labels.",
    ...(safeString(generationContext?.runtime).trim().toLowerCase() === "godot"
      ? [
          `runtimeDialect: Godot ${safeString(generationContext?.runtimeVersion).trim() || "4.x"} GDScript`,
          "When generating GDScript, use Godot 4.x syntax only.",
          "Do not use Godot 3.x constructs (e.g. export var / onready var / yield()).",
        ]
      : []),
    `intent: ${safeString(contentIntent).trim()}`,
    `tool: ${safeString(toolName).trim()}`,
    `targetRefs: ${JSON.stringify(targetRefs)}`,
    `creationIntent: ${JSON.stringify(creationIntent)}`,
    `generationContext: ${JSON.stringify(isPlainObject(generationContext) ? generationContext : {})}`,
    `args: ${JSON.stringify(isPlainObject(args) ? args : {})}`,
  ].join("\n");
}

function fallbackGenerateContent(intent, { toolName = "", generationContext = null } = {}) {
  const t = safeString(intent).trim();
  const lower = t.toLowerCase();
  const toolLower = safeString(toolName).trim().toLowerCase();
  const runtime = safeString(generationContext?.runtime).trim().toLowerCase();
  const artifactKind = safeString(generationContext?.artifactKind).trim().toLowerCase();
  const scriptLikeTool =
    /(^|[_\-\s])(script|code|gdscript|create|write|save)([_\-\s]|$)/.test(toolLower) ||
    artifactKind === "script" ||
    runtime === "godot";
  if (scriptLikeTool) {
    const generated = {
      kind: "code_snippet",
      content: [
        "extends Node",
        "",
        "func _ready():",
        `\t# TODO: ${t || "implement requested behavior"}`,
        "\tpass",
      ].join("\n"),
      summary: "Generated script scaffold from semantic intent fallback.",
    };
    if (isGodotScriptLikeContext({ toolName, generationContext })) {
      generated.content = normalizeGodot4Syntax(generated.content);
    }
    return generated;
  }
  if (lower.includes("print") && lower.includes("hello")) {
    return {
      kind: "code_snippet",
      content: 'print("Hello world")',
      summary: "Prints Hello world.",
    };
  }
  if (lower.includes("jump") && (lower.includes("tap") || lower.includes("touch") || lower.includes("screen"))) {
    return {
      kind: "code_snippet",
      content: [
        "func _unhandled_input(event):",
        "  if event is InputEventScreenTouch and event.pressed:",
        "    jump()",
      ].join("\n"),
      summary: "Adds jump-on-tap behavior.",
    };
  }
  return {
    kind: "text_block",
    content: `# Implementation\n${t}`,
    summary: "Generic generated content from semantic intent.",
  };
}

function parseGeneratedPayload(raw) {
  if (isPlainObject(raw)) {
    if (isPlainObject(raw.output)) return raw.output;
    return raw;
  }
  const text = safeString(raw).trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

const DEBUG_VERIFY = safeString(process.env.DEBUG_GENERIC_MCP_VERIFY).trim().toLowerCase() === "true";

function isScriptValidationEnabled(workflowState = null) {
  return Boolean(
    workflowState?.featureFlags?.scriptValidation?.enabled ||
    workflowState?.semanticState?.knownFacts?.scriptValidationEnabled
  );
}

export async function ensureGeneratedContentForStep({
  toolName,
  args = null,
  workflowState = null,
  modelClient = null,
  allowFallback = true,
  sessionContext = null,
} = {}) {
  const semanticState = isPlainObject(workflowState?.semanticState) ? workflowState.semanticState : {};
  const generationContext = buildGenerationContext({
    workflowState,
    args,
    toolName,
    sessionContext,
  });
  const contentIntent =
    safeString(args?.contentIntent).trim() ||
    safeString(args?.codeIntent).trim() ||
    safeString(semanticState?.contentIntent).trim() ||
    "";
  if (!contentIntent) {
    const out = {
      status: "not_applicable",
      generatedContent: null,
      reason: null,
      generationContext,
    };
    if (DEBUG_VERIFY) {
      console.log("[VERIFY][contentgen-final]", {
        status: out.status,
        kind: null,
        keys: [],
        generatedContent: null,
        preview: "",
      });
    }
    return out;
  }

  const targetReadiness = evaluateGenerationTargetReadiness(generationContext);
  if (safeString(targetReadiness?.status).trim() === "needs_input") {
    const out = {
      status: "not_ready",
      generatedContent: null,
      reason: safeString(targetReadiness?.reason).trim() || "Target context is required for grounded content generation.",
      missingSemanticField: safeString(targetReadiness?.missingSemanticField).trim() || null,
      generationContext,
    };
    if (DEBUG_VERIFY) {
      console.log("[VERIFY][contentgen-final]", {
        status: out.status,
        kind: null,
        keys: [],
        generatedContent: null,
        preview: "",
      });
    }
    return out;
  }

  const existing = isPlainObject(semanticState?.generatedContent) ? semanticState.generatedContent : null;
  if (existing && normalizeIntentKey(existing.intent) === normalizeIntentKey(contentIntent) && safeString(existing.content).trim()) {
    if (isScriptValidationEnabled(workflowState) && isGodotScriptLikeContext({ toolName, generationContext })) {
      const existingValidation = validateGodot4Script(existing.content);
      if (!existingValidation.ok) {
        const repaired = await attemptGodot4Repair({
          invalidContent: existing.content,
          issues: existingValidation.issues,
          intent: contentIntent,
          generationContext,
          toolName,
          modelClient,
        });
        if (!repaired.ok) {
          return {
            status: "not_ready",
            generatedContent: null,
            reason: `script_validation_failed: ${safeString(repaired.reason).trim() || "invalid_godot46_script"}`,
            generationContext,
            missingSemanticField: null,
          };
        }
        existing.content = safeString(repaired.content);
        existing.repairedForGodot46 = true;
        existing.repairMethod = safeString(repaired.repairedBy).trim() || "unknown";
      }
    }
    const out = {
      status: "ready",
      generatedContent: existing,
      reason: null,
      generationContext,
    };
    if (DEBUG_VERIFY) {
      console.log("[VERIFY][contentgen-final]", {
        status: out.status,
        kind: safeString(existing?.kind).trim() || null,
        keys: isPlainObject(existing) ? Object.keys(existing) : [],
        generatedContent: existing,
        preview: safeString(existing?.content).slice(0, 300),
      });
    }
    return out;
  }

  const prompt = buildPrompt({ contentIntent, toolName, semanticState, args, generationContext });
  let generated = null;
  if (modelClient && typeof modelClient.generate === "function") {
    try {
      if (DEBUG_VERIFY) {
        console.log("[generic-mcp][contentgen][model-input]", {
          phase: "generate",
          responseFormat: "json_object",
          tool: safeString(toolName).trim() || null,
          promptPreview: safeString(prompt).slice(0, 4000),
        });
      }
      const res = await modelClient.generate({ prompt, responseFormat: "json_object" });
      if (DEBUG_VERIFY) {
        console.log("[VERIFY][contentgen-raw-output]", res ?? null);
      }
      const parsed = parseGeneratedPayload(res?.text ?? res);
      if (isPlainObject(parsed) && safeString(parsed.content).trim()) {
        let generatedContent = safeString(parsed.content);
        if (isGodotScriptLikeContext({ toolName, generationContext })) {
          generatedContent = normalizeGodot4Syntax(generatedContent);
        }
        generated = {
          kind: safeString(parsed.kind).trim() || "text_block",
          content: generatedContent,
          summary: safeString(parsed.summary).trim() || null,
          intent: contentIntent,
          source: "model",
          contextReadiness: safeString(targetReadiness?.status).trim() || "ready_to_generate",
        };
      }
    } catch {
      generated = null;
    }
  }

  if (!generated) {
    if (!allowFallback) {
      const out = {
        status: "not_ready",
        generatedContent: null,
        reason: "content_generation_failed",
      };
      if (DEBUG_VERIFY) {
        console.log("[VERIFY][contentgen-final]", {
          status: out.status,
          kind: null,
          keys: isPlainObject(existing) ? Object.keys(existing) : [],
          generatedContent: null,
          preview: "",
        });
      }
      return out;
    }
    const fb = fallbackGenerateContent(contentIntent, { toolName, generationContext });
    generated = {
      kind: fb.kind,
      content: isGodotScriptLikeContext({ toolName, generationContext }) ? normalizeGodot4Syntax(fb.content) : fb.content,
      summary: fb.summary,
      intent: contentIntent,
      source: "fallback",
      contextReadiness: safeString(targetReadiness?.status).trim() || "generate_with_partial_context",
    };
  }

  if (isScriptValidationEnabled(workflowState) && isGodotScriptLikeContext({ toolName, generationContext })) {
    const initial = validateGodot4Script(generated?.content);
    if (!initial.ok) {
      const repaired = await attemptGodot4Repair({
        invalidContent: generated?.content,
        issues: initial.issues,
        intent: contentIntent,
        generationContext,
        toolName,
        modelClient,
      });
      if (repaired.ok) {
        generated = {
          ...generated,
          content: safeString(repaired.content),
          source: safeString(generated?.source).trim() || "model",
          repairedForGodot46: true,
          repairMethod: safeString(repaired.repairedBy).trim() || "unknown",
        };
      } else {
        return {
          status: "not_ready",
          generatedContent: null,
          reason: `script_validation_failed: ${safeString(repaired.reason).trim() || "invalid_godot46_script"}`,
          generationContext,
          missingSemanticField: null,
        };
      }
    }
  }

  const out = {
    status: "ready",
    generatedContent: generated,
    reason: null,
    generationContext,
  };
  if (DEBUG_VERIFY) {
    console.log("[VERIFY][contentgen-final]", {
      status: out.status,
      kind: safeString(generated?.kind).trim() || null,
      keys: isPlainObject(generated) ? Object.keys(generated) : [],
      generatedContent: generated,
      preview: safeString(generated?.content).slice(0, 300),
    });
  }
  return out;
}
