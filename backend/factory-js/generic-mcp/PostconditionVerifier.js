import { unmetExpectedEffects } from "./ArtifactOperationModel.js";

function safeString(value) {
  return value == null ? "" : String(value);
}

function isPlainObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

export function verifyWorkflowPostconditions({ operationState = null, workflowState = null } = {}) {
  const op = isPlainObject(operationState)
    ? operationState
    : isPlainObject(workflowState?.artifactOperation)
      ? workflowState.artifactOperation
      : null;
  if (!op) return { ok: true, unmet: [], summary: "no_operation_constraints" };
  const unmet = unmetExpectedEffects(op);
  if (unmet.length === 0) {
    return { ok: true, unmet: [], summary: "all_expected_effects_observed" };
  }
  return {
    ok: false,
    unmet,
    summary: `Unmet expected effects: ${unmet.join(", ")}`,
  };
}

export function compactStepVerification({ stepTool = null, executionResult = null } = {}) {
  const tool = safeString(stepTool?.name).trim();
  const ok = Boolean(executionResult?.ok);
  return {
    tool,
    ok,
    verified: ok,
  };
}

