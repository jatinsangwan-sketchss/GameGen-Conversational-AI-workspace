import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createServer } from "node:net";

import { GenericMcpSessionStore } from "../api/GenericMcpSessionStore.js";
import { GenericMcpHttpAdapter } from "../api/GenericMcpHttpAdapter.js";
import { GenericMcpHttpServer } from "../api/GenericMcpHttpServer.js";

function isPlainObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

async function reserveAvailablePort(host = "127.0.0.1") {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.unref();
    probe.once("error", reject);
    probe.listen(0, host, () => {
      const address = probe.address();
      const port = address && typeof address === "object" ? address.port : null;
      probe.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        if (!Number.isInteger(port) || port <= 0) {
          reject(new Error("Failed to reserve available test port."));
          return;
        }
        resolve(port);
      });
    });
  });
}

class FakeRunner {
  constructor({ scriptedResults = [] } = {}) {
    this.calls = [];
    this._scriptedResults = Array.isArray(scriptedResults) ? [...scriptedResults] : [];
  }

  async run(args) {
    this.calls.push(args);
    const next = this._scriptedResults.shift();
    if (typeof next === "function") return next(args);
    if (isPlainObject(next)) return next;
    return {
      ok: true,
      status: "completed",
      reason: null,
      presentation: "done",
    };
  }
}

async function startTestServer({ runner, defaultProjectPath = null, sessionManager = null } = {}) {
  const fakeRunner = runner ?? new FakeRunner();
  const sessionStore = new GenericMcpSessionStore({ maxSessions: 16 });
  const reservedPort = await reserveAvailablePort("127.0.0.1");
  const adapter = new GenericMcpHttpAdapter({
    runner: fakeRunner,
    sessionStore,
    defaultProjectPath,
    sessionManager,
  });
  const server = new GenericMcpHttpServer({
    adapter,
    host: "127.0.0.1",
    port: reservedPort,
    maxBodyBytes: 1024 * 1024,
  });
  const address = await server.start();
  return {
    runner: fakeRunner,
    sessionStore,
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
  };
}

async function postJson(url, payload) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const json = await res.json();
  return { res, json };
}
test("generic-mcp sidecar: health/run/resume semantics and CLI help non-regression", async () => {
  {
    const sessionManager = {
      getStatus() {
        return {
          mcpClientReady: false,
          bridgeReady: false,
          connectedProjectPath: null,
          desiredProjectRoot: null,
          failurePhase: null,
          failedPhase: null,
          lastError: null,
        };
      },
    };
    const runtime = await startTestServer({ sessionManager });
    try {
      const res = await fetch(`${runtime.baseUrl}/health`);
      const json = await res.json();
      assert.equal(res.status, 200);
      assert.equal(json.ok, true);
      assert.equal(json.status, "starting");
      assert.equal(json.ready, false);
      assert.equal(json.sidecar.workflowSource, "GenericMcpRunner");
      assert.equal(json.mcp.available, true);
      assert.ok(json.sessions.totalSessions >= 0);
    } finally {
      await runtime.server.stop();
    }
  }

  {
    const status = {
      mcpClientReady: false,
      bridgeReady: false,
      connectedProjectPath: null,
      desiredProjectRoot: null,
      failurePhase: null,
      failedPhase: null,
      lastError: null,
    };
    let ensureReadyCalls = 0;
    const sessionManager = {
      async ensureReady(projectRoot) {
        ensureReadyCalls += 1;
        status.mcpClientReady = true;
        status.bridgeReady = true;
        status.connectedProjectPath = projectRoot || "/tmp/project-live";
        status.desiredProjectRoot = projectRoot || null;
        status.lastError = null;
        return { ok: true, status: { ...status }, projectMatches: true };
      },
      getStatus() {
        return { ...status };
      },
    };
    const runtime = await startTestServer({ sessionManager });
    try {
      const res = await fetch(`${runtime.baseUrl}/ready?projectPath=${encodeURIComponent("/tmp/project-live")}`);
      const json = await res.json();
      assert.equal(res.status, 200);
      assert.equal(json.ok, true);
      assert.equal(json.status, "ready");
      assert.equal(json.mcp.connectedProjectPath, "/tmp/project-live");
      assert.equal(json.mcp.projectMatches, true);
      assert.equal(ensureReadyCalls, 1);
    } finally {
      await runtime.server.stop();
    }
  }

  {
    const runner = new FakeRunner({
      scriptedResults: [
        {
          ok: true,
          status: "completed",
          reason: null,
          presentation: "completed by runner",
        },
      ],
    });
    const sessionManager = {
      getStatus() {
        return {
          mcpClientReady: true,
          bridgeReady: true,
          connectedProjectPath: "/tmp/project-live-inferred",
          desiredProjectRoot: null,
          failurePhase: null,
          failedPhase: null,
          lastError: null,
        };
      },
    };
    const runtime = await startTestServer({ runner, sessionManager });
    try {
      const { res, json } = await postJson(`${runtime.baseUrl}/run`, {
        input: "attach script",
      });
      assert.equal(res.status, 200);
      assert.equal(json.ok, true);
      assert.equal(json.status, "completed");
      assert.equal(json.presentation, "completed by runner");
      assert.ok(typeof json.sessionId === "string" && json.sessionId.length > 0);
      assert.equal(runner.calls.length, 1);
      assert.equal(runner.calls[0].userRequest, "attach script");
      assert.equal(runner.calls[0].projectRoot, "/tmp/project-live-inferred");
      assert.equal(runner.calls[0].resumeNeedsInput, null);
    } finally {
      await runtime.server.stop();
    }
  }
  {
    const verbosePaused = {
      ok: false,
      status: "paused",
      reason: "queue_paused_failed",
      presentation: "Task 2 failed and queue execution is paused.",
      pauseReason: "failed",
      runtime: {
        semantic: { status: "missing_args", args: { noisy: true } },
        resolved: { status: "missing_args", args: { noisy: true } },
      },
      workflow: {
        stepCount: 7,
        history: [{ tool: "create-script" }],
      },
      planning: { status: "missing_args", tools: [] },
      resolved: { status: "missing_args", tools: [] },
      execution: null,
      session: { connectedProjectPath: "/tmp/project-compact-check" },
      inventory: { toolCount: 42 },
      pausedTaskResult: {
        ok: false,
        status: "failed",
        reason: "tool call failed",
        presentation: "failed",
        runtime: { noisy: true },
      },
      taskQueue: {
        mode: "sequential",
        status: "paused",
        totalTasks: 3,
        currentTaskIndex: 1,
        tasks: ["task one", "task two", "task three"],
        completedTasks: [
          { index: 0, task: "task one", status: "completed", ok: true },
        ],
        remainingTasks: ["task three"],
        pausedTask: {
          index: 1,
          task: "task two",
          result: {
            ok: false,
            status: "failed",
            reason: "tool call failed",
            presentation: "failed",
            runtime: { noisy: true },
            workflow: { noisy: true },
          },
        },
      },
    };
    const runner = new FakeRunner({
      scriptedResults: [verbosePaused, verbosePaused],
    });
    const runtime = await startTestServer({ runner });
    try {
      const compactResponse = await postJson(`${runtime.baseUrl}/run`, {
        input: "task one; task two; task three",
        sessionId: "compact-mode-session",
      });
      assert.equal(compactResponse.res.status, 200);
      assert.equal(compactResponse.json.status, "paused");
      assert.equal(compactResponse.json.responseMode, "compact");
      assert.equal(Object.prototype.hasOwnProperty.call(compactResponse.json, "runtime"), false);
      assert.equal(Object.prototype.hasOwnProperty.call(compactResponse.json, "workflow"), false);
      assert.equal(Object.prototype.hasOwnProperty.call(compactResponse.json, "planning"), false);
      assert.equal(Object.prototype.hasOwnProperty.call(compactResponse.json, "resolved"), false);
      assert.equal(Object.prototype.hasOwnProperty.call(compactResponse.json, "execution"), false);
      assert.equal(compactResponse.json.context.connectedProjectPath, "/tmp/project-compact-check");
      assert.equal(compactResponse.json.context.toolCount, 42);
      assert.equal(compactResponse.json.taskQueue.counts.completed, 1);
      assert.equal(compactResponse.json.taskQueue.counts.remaining, 1);
      assert.equal(
        Object.prototype.hasOwnProperty.call(
          compactResponse.json.taskQueue?.pausedTask?.result ?? {},
          "runtime"
        ),
        false
      );

      const fullResponse = await postJson(`${runtime.baseUrl}/run`, {
        input: "task one; task two; task three",
        sessionId: "compact-mode-session",
        responseMode: "full",
      });
      assert.equal(fullResponse.res.status, 200);
      assert.equal(fullResponse.json.status, "paused");
      assert.equal(isPlainObject(fullResponse.json.runtime), true);
      assert.equal(isPlainObject(fullResponse.json.workflow), true);
      assert.equal(isPlainObject(fullResponse.json.planning), true);
      assert.equal(isPlainObject(fullResponse.json.resolved), true);
    } finally {
      await runtime.server.stop();
    }
  }

  {
    const needsInputResult = {
      ok: false,
      status: "needs_input",
      kind: "missing_args",
      field: "sceneRef",
      question: "Which scene should I use?",
      partialPlan: {
        tool: "attach_script_to_node",
        args: {
          sceneRef: null,
          nodeRef: "root",
        },
      },
      presentation: "Which scene should I use?",
    };
    const completedResult = {
      ok: true,
      status: "completed",
      reason: null,
      presentation: "attached",
    };
    const runner = new FakeRunner({
      scriptedResults: [needsInputResult, completedResult],
    });
    const sessionManager = {
      getStatus() {
        return {
          mcpClientReady: true,
          bridgeReady: true,
          connectedProjectPath: "/tmp/project-beta-live",
          desiredProjectRoot: null,
          failurePhase: null,
          failedPhase: null,
          lastError: null,
        };
      },
    };
    const runtime = await startTestServer({ runner, sessionManager });
    try {
      const runResponse = await postJson(`${runtime.baseUrl}/run`, {
        input: "attach Logs.gd to root of NewScene",
        sessionId: "semantic-session-1",
      });
      assert.equal(runResponse.res.status, 200);
      assert.equal(runResponse.json.status, "needs_input");
      assert.equal(runResponse.json.field, "sceneRef");
      assert.equal(runResponse.json.partialPlan.args.sceneRef, null);
      assert.equal(Object.prototype.hasOwnProperty.call(runResponse.json.partialPlan.args, "scenePath"), false);

      const resumeResponse = await postJson(`${runtime.baseUrl}/resume`, {
        sessionId: "semantic-session-1",
        input: "res://NewScene.tscn",
      });
      assert.equal(resumeResponse.res.status, 200);
      assert.equal(resumeResponse.json.status, "completed");
      assert.equal(resumeResponse.json.presentation, "attached");

      assert.equal(runner.calls.length, 2);
      assert.equal(runner.calls[1].userRequest, "res://NewScene.tscn");
      assert.equal(runner.calls[1].projectRoot, "/tmp/project-beta-live");
      assert.deepEqual(runner.calls[1].resumeNeedsInput, needsInputResult);
    } finally {
      await runtime.server.stop();
    }
  }

  {
    const pausedQueueResult = {
      ok: false,
      status: "paused",
      reason: "queue_paused_failed",
      presentation: "Task 2 failed and queue execution is paused.",
      pauseReason: "failed",
      taskQueue: {
        mode: "sequential",
        status: "paused",
        totalTasks: 3,
        currentTaskIndex: 1,
        tasks: ["task one", "task two", "task three"],
        completedTasks: [
          { index: 0, task: "task one", status: "completed", ok: true },
        ],
        remainingTasks: ["task three"],
        pausedTask: {
          index: 1,
          task: "task two",
          result: {
            ok: false,
            status: "failed",
            reason: "tool call failed",
            presentation: "failed",
          },
        },
      },
    };
    const completedResult = {
      ok: true,
      status: "completed",
      reason: null,
      presentation: "queue resumed",
      taskQueue: {
        mode: "sequential",
        status: "completed",
        totalTasks: 3,
        currentTaskIndex: 3,
        tasks: ["task one", "task two", "task three"],
        completedTasks: [
          { index: 0, task: "task one", status: "completed", ok: true },
          { index: 1, task: "task two", status: "completed", ok: true },
          { index: 2, task: "task three", status: "completed", ok: true },
        ],
        remainingTasks: [],
      },
    };
    const runner = new FakeRunner({
      scriptedResults: [pausedQueueResult, completedResult],
    });
    const sessionManager = {
      getStatus() {
        return {
          mcpClientReady: true,
          bridgeReady: true,
          connectedProjectPath: "/tmp/project-queue-live",
          desiredProjectRoot: null,
          failurePhase: null,
          failedPhase: null,
          lastError: null,
        };
      },
    };
    const runtime = await startTestServer({ runner, sessionManager });
    try {
      const runResponse = await postJson(`${runtime.baseUrl}/run`, {
        input: "task one; task two; task three",
        sessionId: "queue-session-1",
      });
      assert.equal(runResponse.res.status, 200);
      assert.equal(runResponse.json.status, "paused");
      assert.equal(runResponse.json.pauseReason, "failed");

      const resumeResponse = await postJson(`${runtime.baseUrl}/resume`, {
        sessionId: "queue-session-1",
        input: "retry",
      });
      assert.equal(resumeResponse.res.status, 200);
      assert.equal(resumeResponse.json.status, "completed");
      assert.equal(resumeResponse.json.presentation, "queue resumed");

      assert.equal(runner.calls.length, 2);
      assert.equal(runner.calls[1].userRequest, "retry");
      assert.deepEqual(runner.calls[1].resumeNeedsInput, pausedQueueResult);
    } finally {
      await runtime.server.stop();
    }
  }

  {
    const runner = new FakeRunner({
      scriptedResults: [
        {
          ok: true,
          status: "completed",
          reason: null,
          presentation: "done",
        },
      ],
    });
    const runtime = await startTestServer({ runner });
    try {
      const runResponse = await postJson(`${runtime.baseUrl}/run`, {
        input: "do something",
        projectPath: "/tmp/project-gamma",
        sessionId: "resume-conflict-session",
      });
      assert.equal(runResponse.res.status, 200);
      assert.equal(runResponse.json.status, "completed");

      const resumeResponse = await postJson(`${runtime.baseUrl}/resume`, {
        sessionId: "resume-conflict-session",
        input: "extra input",
      });
      assert.equal(resumeResponse.res.status, 409);
      assert.equal(resumeResponse.json.ok, false);
      assert.equal(resumeResponse.json.status, "error");
      assert.equal(resumeResponse.json.code, "resume_without_pending_state");
    } finally {
      await runtime.server.stop();
    }
  }

  {
    const testDir = path.dirname(fileURLToPath(import.meta.url));
    const interactivePath = path.resolve(testDir, "..", "run-interactive-generic-mcp.js");
    const sidecarPath = path.resolve(testDir, "..", "run-generic-mcp-server.js");

    const interactiveHelp = spawnSync("node", [interactivePath, "--help"], {
      encoding: "utf8",
    });
    assert.equal(interactiveHelp.status, 0);
    assert.match(interactiveHelp.stdout, /Usage:/);

    const sidecarHelp = spawnSync("node", [sidecarPath, "--help"], {
      encoding: "utf8",
    });
    assert.equal(sidecarHelp.status, 0);
    assert.match(sidecarHelp.stdout, /Usage:/);
  }
});

