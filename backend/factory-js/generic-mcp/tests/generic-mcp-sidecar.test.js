import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { GenericMcpSessionStore } from "../api/GenericMcpSessionStore.js";
import { GenericMcpHttpAdapter } from "../api/GenericMcpHttpAdapter.js";
import { GenericMcpHttpServer } from "../api/GenericMcpHttpServer.js";

function isPlainObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
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

async function startTestServer({ runner, defaultProjectPath = null } = {}) {
  const fakeRunner = runner ?? new FakeRunner();
  const sessionStore = new GenericMcpSessionStore({ maxSessions: 16 });
  const adapter = new GenericMcpHttpAdapter({
    runner: fakeRunner,
    sessionStore,
    defaultProjectPath,
  });
  const server = new GenericMcpHttpServer({
    adapter,
    host: "127.0.0.1",
    port: 0,
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
    const runtime = await startTestServer();
    try {
      const res = await fetch(`${runtime.baseUrl}/health`);
      const json = await res.json();
      assert.equal(res.status, 200);
      assert.equal(json.ok, true);
      assert.equal(json.status, "healthy");
      assert.equal(json.sidecar.workflowSource, "GenericMcpRunner");
      assert.ok(json.sessions.totalSessions >= 0);
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
    const runtime = await startTestServer({ runner });
    try {
      const { res, json } = await postJson(`${runtime.baseUrl}/run`, {
        input: "attach script",
        projectPath: "/tmp/project-alpha",
      });
      assert.equal(res.status, 200);
      assert.equal(json.ok, true);
      assert.equal(json.status, "completed");
      assert.equal(json.presentation, "completed by runner");
      assert.ok(typeof json.sessionId === "string" && json.sessionId.length > 0);
      assert.equal(runner.calls.length, 1);
      assert.equal(runner.calls[0].userRequest, "attach script");
      assert.equal(runner.calls[0].projectRoot, "/tmp/project-alpha");
      assert.equal(runner.calls[0].resumeNeedsInput, null);
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
    const runtime = await startTestServer({ runner });
    try {
      const runResponse = await postJson(`${runtime.baseUrl}/run`, {
        input: "attach Logs.gd to root of NewScene",
        projectPath: "/tmp/project-beta",
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
      assert.equal(runner.calls[1].projectRoot, "/tmp/project-beta");
      assert.deepEqual(runner.calls[1].resumeNeedsInput, needsInputResult);
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

