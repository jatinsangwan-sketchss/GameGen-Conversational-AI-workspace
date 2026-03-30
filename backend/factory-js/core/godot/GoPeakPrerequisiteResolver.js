/**
 * GoPeakPrerequisiteResolver
 * --------------------------
 * Classifies discovered GoPeak tools by likely runtime prerequisites so
 * wrapper-driven tool testing can distinguish:
 * - real tool failures
 * - expected skips due to unmet environment preconditions
 *
 * This module is intentionally transport-agnostic (no MCP calls) and contains
 * no planning/execution orchestration logic.
 */

const PREREQUISITE_CLASSES = Object.freeze({
    server_only: "server_only",
    project_required: "project_required",
    editor_bridge_required: "editor_bridge_required",
    runtime_addon_required: "runtime_addon_required",
    lsp_required: "lsp_required",
    dap_required: "dap_required",
  });
  
  const PREREQUISITE_RULES = Object.freeze([
    {
      prerequisite: PREREQUISITE_CLASSES.lsp_required,
      patterns: [/lsp/i, /language[-_ ]server/i, /diagnostic/i, /gdscript/i],
      stop: false,
    },
    {
      prerequisite: PREREQUISITE_CLASSES.dap_required,
      patterns: [/dap/i, /debug[-_]?adapter/i, /breakpoint/i, /stack[-_]?trace/i],
      stop: false,
    },
    {
      prerequisite: PREREQUISITE_CLASSES.runtime_addon_required,
      patterns: [/runtime/i, /inject[-_]?/i, /^run[-_]?project$/i, /^stop[-_]?project$/i, /hot[-_ ]reload/i],
      stop: false,
    },
    {
      prerequisite: PREREQUISITE_CLASSES.editor_bridge_required,
      patterns: [/scene/i, /node/i, /save[-_]?scene/i, /editor/i, /plugin/i, /set[-_]?node/i, /get[-_]?node/i],
      stop: false,
    },
    {
      prerequisite: PREREQUISITE_CLASSES.project_required,
      patterns: [/project/i, /resource/i, /uid/i, /autoload/i, /setting/i, /script/i, /scene/i],
      stop: false,
    },
    {
      prerequisite: PREREQUISITE_CLASSES.server_only,
      patterns: [/.*/],
      stop: true,
    },
  ]);
  
  function safeString(v) {
    return v == null ? "" : String(v);
  }
  
  function normalizeToolMetadata(tool) {
    const name = safeString(tool?.name).trim();
    return {
      name,
      title: safeString(tool?.title).trim() || null,
      description: safeString(tool?.description).trim() || null,
      tags: Array.isArray(tool?.tags) ? tool.tags.map((t) => safeString(t).trim()).filter(Boolean) : [],
      input_schema:
        isPlainObject(tool?.input_schema) ? tool.input_schema : isPlainObject(tool?.inputSchema) ? tool.inputSchema : null,
    };
  }
  
  function classifyPrerequisiteForTool(tool) {
    const t = normalizeToolMetadata(tool);
    const haystack = [t.name, t.title, t.description, t.tags.join(" ")].map((v) => safeString(v).toLowerCase()).join(" ");
    const matched = [];
  
    for (const rule of PREREQUISITE_RULES) {
      if (rule.patterns.some((re) => re.test(haystack))) {
        matched.push(rule.prerequisite);
        if (rule.stop) break;
      }
    }
  
    const uniq = [...new Set(matched)];
    const primary = pickPrimaryPrerequisite(uniq);
    return {
      tool_name: t.name,
      primary_prerequisite: primary,
      prerequisites: uniq,
      classifier_version: "v1",
    };
  }
  
  function classifyPrerequisitesForTools(discoveredTools) {
    const tools = Array.isArray(discoveredTools) ? discoveredTools : [];
    return tools
      .map((tool) => classifyPrerequisiteForTool(tool))
      .filter((entry) => safeString(entry?.tool_name).trim());
  }
  
  function explainSkipReason({ prerequisiteClass, toolName, missingContext = {} } = {}) {
    const tool = safeString(toolName) || "tool";
    const ctx = isPlainObject(missingContext) ? missingContext : {};
  
    switch (prerequisiteClass) {
      case PREREQUISITE_CLASSES.server_only:
        return `${tool} can run with server-only context; no extra prerequisite detected.`;
      case PREREQUISITE_CLASSES.project_required:
        return `${tool} was skipped because a valid Godot project context is required (projectPath/project_root missing or invalid).`;
      case PREREQUISITE_CLASSES.editor_bridge_required:
        return `${tool} was skipped because editor bridge prerequisites were not met (Godot editor not connected or editor plugin inactive).`;
      case PREREQUISITE_CLASSES.runtime_addon_required:
        return `${tool} was skipped because runtime addon prerequisites were not met (project runtime/addon session not available).`;
      case PREREQUISITE_CLASSES.lsp_required:
        return `${tool} was skipped because LSP prerequisites were not met (script/LSP service unavailable).`;
      case PREREQUISITE_CLASSES.dap_required:
        return `${tool} was skipped because DAP prerequisites were not met (debug adapter session unavailable).`;
      default:
        if (ctx.reason) return `${tool} was skipped: ${safeString(ctx.reason)}`;
        return `${tool} was skipped because prerequisites were not met.`;
    }
  }
  
  function buildSkipReportEntry({ tool, prerequisiteClass, missingContext = {} } = {}) {
    const normalizedTool = normalizeToolMetadata(tool);
    const prerequisite = prerequisiteClass ?? classifyPrerequisiteForTool(normalizedTool).primary_prerequisite;
    return {
      tool_name: normalizedTool.name,
      prerequisite_class: prerequisite,
      skipped: true,
      eligible: false,
      reason: explainSkipReason({
        prerequisiteClass: prerequisite,
        toolName: normalizedTool.name,
        missingContext,
      }),
    };
  }
  
  function pickPrimaryPrerequisite(prerequisites) {
    const order = [
      PREREQUISITE_CLASSES.editor_bridge_required,
      PREREQUISITE_CLASSES.runtime_addon_required,
      PREREQUISITE_CLASSES.lsp_required,
      PREREQUISITE_CLASSES.dap_required,
      PREREQUISITE_CLASSES.project_required,
      PREREQUISITE_CLASSES.server_only,
    ];
    for (const cls of order) {
      if (prerequisites.includes(cls)) return cls;
    }
    return PREREQUISITE_CLASSES.server_only;
  }
  
  function evaluateToolEligibility({
    tool,
    context = {},
  } = {}) {
    const cls = classifyPrerequisiteForTool(tool);
    const normalizedCtx = isPlainObject(context) ? context : {};
    const hasProject = Boolean(normalizedCtx.projectRoot || normalizedCtx.project_root || normalizedCtx.projectPath);
    const bridgeReady = normalizedCtx.isBridgeReady === true;
    const runtimeReady = normalizedCtx.runtimeAddonReady === true || normalizedCtx.runtime_addon_ready === true;
    const lspReady = normalizedCtx.lspReady === true || normalizedCtx.lsp_ready === true;
    const dapReady = normalizedCtx.dapReady === true || normalizedCtx.dap_ready === true;
  
    const required = cls.primary_prerequisite;
    let eligible = false;
    if (required === PREREQUISITE_CLASSES.server_only) eligible = true;
    else if (required === PREREQUISITE_CLASSES.project_required) eligible = hasProject;
    else if (required === PREREQUISITE_CLASSES.editor_bridge_required) eligible = hasProject && bridgeReady;
    else if (required === PREREQUISITE_CLASSES.runtime_addon_required) eligible = hasProject && bridgeReady && runtimeReady;
    else if (required === PREREQUISITE_CLASSES.lsp_required) eligible = hasProject && bridgeReady && lspReady;
    else if (required === PREREQUISITE_CLASSES.dap_required) eligible = hasProject && bridgeReady && dapReady;
  
    return {
      tool_name: cls.tool_name,
      prerequisite_class: required,
      prerequisites: cls.prerequisites,
      eligible,
      skip_reason: eligible
        ? null
        : explainSkipReason({
            prerequisiteClass: required,
            toolName: cls.tool_name,
            missingContext: normalizedCtx,
          }),
    };
  }
  
  function isPlainObject(value) {
    return value != null && typeof value === "object" && !Array.isArray(value);
  }
  
  export {
    PREREQUISITE_CLASSES,
    classifyPrerequisiteForTool,
    classifyPrerequisitesForTools,
    evaluateToolEligibility,
    explainSkipReason,
    buildSkipReportEntry,
  };
  
  