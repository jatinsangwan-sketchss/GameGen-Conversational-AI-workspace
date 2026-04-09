import test from "node:test";
import assert from "node:assert/strict";
import { updateSemanticStateFromStep } from "./SemanticWorkflowState.js";

test("updateSemanticStateFromStep consumes only the targeted edit applied by successful node property step", () => {
  const semanticState = {
    targetRefs: {},
    creationIntent: {},
    knownFacts: {},
    completedEffects: {},
    targetedEdits: [
      { kind: "set_value", field: "BoundRight.position", newValue: { type: "Vector2", x: 990, y: 0 }, oldValue: null },
      { kind: "set_value", field: "BoundTop.position", newValue: { type: "Vector2", x: 0, y: 780 }, oldValue: null },
    ],
  };

  updateSemanticStateFromStep({
    semanticState,
    resolvedArgs: {
      nodeRef: "BoundRight",
      propertyMap: { position: { type: "Vector2", x: 990, y: 0 } },
      targetedEdits: [
        { kind: "set_value", field: "BoundRight.position", newValue: { type: "Vector2", x: 990, y: 0 }, oldValue: null },
        { kind: "set_value", field: "BoundTop.position", newValue: { type: "Vector2", x: 0, y: 780 }, oldValue: null },
      ],
    },
    stepToolName: "set-node-properties",
    executionResult: { ok: true, results: [{ ok: true }] },
    artifactOperation: { observedEffects: {} },
  });

  assert.equal(semanticState.targetedEdits.length, 1);
  assert.equal(semanticState.targetedEdits[0].field, "BoundTop.position");
});

test("updateSemanticStateFromStep keeps targeted edits when execution failed", () => {
  const semanticState = {
    targetRefs: {},
    creationIntent: {},
    knownFacts: {},
    completedEffects: {},
    targetedEdits: [
      { kind: "set_value", field: "BoundRight.position", newValue: { type: "Vector2", x: 990, y: 0 }, oldValue: null },
      { kind: "set_value", field: "BoundTop.position", newValue: { type: "Vector2", x: 0, y: 780 }, oldValue: null },
    ],
  };

  updateSemanticStateFromStep({
    semanticState,
    resolvedArgs: {
      nodeRef: "BoundRight",
      propertyMap: { position: { type: "Vector2", x: 990, y: 0 } },
      targetedEdits: [
        { kind: "set_value", field: "BoundRight.position", newValue: { type: "Vector2", x: 990, y: 0 }, oldValue: null },
        { kind: "set_value", field: "BoundTop.position", newValue: { type: "Vector2", x: 0, y: 780 }, oldValue: null },
      ],
    },
    stepToolName: "set-node-properties",
    executionResult: { ok: false, results: [{ ok: false }] },
    artifactOperation: { observedEffects: {} },
  });

  assert.equal(semanticState.targetedEdits.length, 2);
});
