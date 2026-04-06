import test from "node:test";
import assert from "node:assert/strict";

import { GenericMcpRunner } from "../GenericMcpRunner.js";
import { interpretGoalIntent } from "../GoalIntentInterpreter.js";

function completedResult(label) {
  return {
    ok: true,
    status: "completed",
    reason: null,
    presentation: `completed:${label}`,
  };
}

test("runner queue: one prompt with multiple tasks executes strictly sequentially", async () => {
  const runner = new GenericMcpRunner();
  const calls = [];
  runner._runSingleTask = async ({ userRequest, resumeNeedsInput }) => {
    calls.push({ userRequest, resumeNeedsInput });
    return completedResult(userRequest);
  };

  const result = await runner.run({
    userRequest: "create scene, then add node, then save scene",
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, "completed");
  assert.equal(result.taskQueue?.status, "completed");
  assert.equal(result.taskQueue?.totalTasks, 3);
  assert.equal(result.taskQueue?.completedTasks?.length, 3);
  assert.deepEqual(
    calls.map((c) => c.userRequest),
    ["create scene", "add node", "save scene"]
  );
});

test("runner queue: pauses when a queued task returns needs_input and preserves completed tasks", async () => {
  const runner = new GenericMcpRunner();
  let callCount = 0;
  runner._runSingleTask = async ({ userRequest }) => {
    callCount += 1;
    if (callCount === 3) {
      return {
        ok: false,
        status: "needs_input",
        kind: "missing_args",
        field: "sceneRef",
        question: "Which scene should I use?",
        partialPlan: {
          tool: "list-scene-nodes",
          args: { sceneRef: null },
        },
        presentation: "Missing arguments: sceneRef",
      };
    }
    return completedResult(userRequest);
  };

  const result = await runner.run({
    userRequest: "task one; task two; task three",
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, "paused");
  assert.equal(result.pauseReason, "needs_input");
  assert.equal(result.taskQueue?.status, "paused");
  assert.equal(result.taskQueue?.currentTaskIndex, 2);
  assert.equal(result.taskQueue?.completedTasks?.length, 2);
  assert.equal(result.taskQueue?.pausedTask?.index, 2);
  assert.equal(result.pausedTaskResult?.status, "needs_input");
  assert.equal(result.pausedTaskResult?.kind, "missing_args");
});

test("runner queue: resume continues paused needs_input task then remaining tasks in order", async () => {
  const runner = new GenericMcpRunner();
  const calls = [];
  runner._runSingleTask = async ({ userRequest, resumeNeedsInput }) => {
    calls.push({ userRequest, resumeNeedsInput });
    if (userRequest === "task two" && !resumeNeedsInput) {
      return {
        ok: false,
        status: "needs_input",
        kind: "missing_args",
        field: "sceneRef",
        question: "Which scene should I use?",
        partialPlan: {
          tool: "add-node",
          args: { sceneRef: null },
        },
        presentation: "Missing arguments: sceneRef",
      };
    }
    return completedResult(userRequest);
  };

  const paused = await runner.run({
    userRequest: "task one; task two; task three",
  });
  assert.equal(paused.status, "paused");
  assert.equal(paused.pauseReason, "needs_input");
  assert.equal(paused.taskQueue?.currentTaskIndex, 1);
  assert.equal(paused.taskQueue?.remainingTasks?.length, 1);

  const resumed = await runner.run({
    userRequest: "res://Gameplay.tscn",
    resumeNeedsInput: paused,
  });
  assert.equal(resumed.ok, true);
  assert.equal(resumed.status, "completed");
  assert.equal(resumed.taskQueue?.completedTasks?.length, 3);

  assert.equal(calls.length, 4);
  assert.equal(calls[2].userRequest, "res://Gameplay.tscn");
  assert.equal(calls[2].resumeNeedsInput?.status, "needs_input");
  assert.equal(calls[3].userRequest, "task three");
  assert.equal(calls[3].resumeNeedsInput, null);
});

test("runner queue: pauses on failure and supports skip on resume while preserving remaining tasks", async () => {
  const runner = new GenericMcpRunner();
  const calls = [];
  runner._runSingleTask = async ({ userRequest }) => {
    calls.push(userRequest);
    if (userRequest === "task beta") {
      return {
        ok: false,
        status: "failed",
        reason: "tool call failed",
        presentation: "Task failed",
      };
    }
    return completedResult(userRequest);
  };

  const paused = await runner.run({
    userRequest: "task alpha; task beta; task gamma",
  });
  assert.equal(paused.status, "paused");
  assert.equal(paused.pauseReason, "failed");
  assert.equal(paused.taskQueue?.currentTaskIndex, 1);
  assert.equal(paused.taskQueue?.remainingTasks?.length, 1);

  const resumed = await runner.run({
    userRequest: "skip",
    resumeNeedsInput: paused,
  });
  assert.equal(resumed.ok, true);
  assert.equal(resumed.status, "completed");
  assert.equal(resumed.taskQueue?.completedTasks?.length, 3);
  assert.equal(resumed.taskQueue?.completedTasks?.[1]?.status, "skipped");
  assert.deepEqual(calls, ["task alpha", "task beta", "task gamma"]);
});

test("runner queue: existing single-task behavior remains direct", async () => {
  const runner = new GenericMcpRunner();
  const calls = [];
  runner._runSingleTask = async ({ userRequest, resumeNeedsInput }) => {
    calls.push({ userRequest, resumeNeedsInput });
    return completedResult("single");
  };

  const result = await runner.run({
    userRequest: "create one scene only",
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, "completed");
  assert.equal(Object.prototype.hasOwnProperty.call(result, "taskQueue"), false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].userRequest, "create one scene only");
});

test("runner queue: carryover maps pronoun script refs to latest created script artifact", () => {
  const runner = new GenericMcpRunner();
  runner._modules.artifactRegistry = {
    getAll() {
      return [
        {
          kind: "script",
          godotPath: "res://scripts/Enemy.gd",
          relativePath: "scripts/Enemy.gd",
          filename: "Enemy.gd",
        },
      ];
    },
  };
  const rewritten = runner._applyQueueCarryoverArtifacts(
    "attach this script to `Alphabet` node in Enemies.tscn"
  );
  assert.match(rewritten, /script\s+res:\/\/scripts\/Enemy\.gd/i);
});

test("goal intent: attach target node ref is parsed from quoted/backticked node text", () => {
  const intent = interpretGoalIntent({
    userRequest: "attach script res://scripts/Enemy.gd to `Alphabet` node in Enemies.tscn",
  });
  assert.equal(intent.refs?.targetNodeRef, "Alphabet");
});

test("goal intent: creation requestedName is extracted from backticked called-name phrase", () => {
  const intent = interpretGoalIntent({
    userRequest: "Create new script called `Enemy`, in this script extends from label",
  });
  assert.equal(intent.creationIntent?.requestedName, "Enemy");
});

test("goal intent: does not misclassify filler pronoun as sceneRef", () => {
  const intent = interpretGoalIntent({
    userRequest: "Create new script called `Enemy`, in this script extends from label",
  });
  assert.equal(intent.refs?.sceneRef ?? null, null);
});
