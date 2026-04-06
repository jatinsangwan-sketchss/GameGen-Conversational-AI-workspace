import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ArgumentResolver } from "../ArgumentResolver.js";
import { ProjectFileIndex } from "../ProjectFileIndex.js";
import { ResourceResolver } from "../ResourceResolver.js";
import { defaultPathPolicyForArg } from "../PathPolicy.js";

test("argument resolver: create_then_attach accepts generic path-like attach artifact targets", () => {
  const resolver = new ArgumentResolver();
  const result = resolver._ensureAttachExistingDualResolution({
    toolName: "generic-create-attach-tool",
    args: {
      artifactPath: "generated/Gameplay.tscn",
      targetNodeRef: "root node",
    },
    argMeta: {
      artifactPath: {
        provenance: "synthesized_new_path",
        existencePolicy: "may_not_exist_yet",
      },
    },
    inventory: null,
    workflowState: {
      artifactOperation: {
        mode: "create_then_attach",
      },
    },
  });
  assert.equal(result.ok, true);
});

test("argument resolver: injects session project path into required projectRef alias", async () => {
  const resolver = new ArgumentResolver({
    toolInventory: {
      getTool(name) {
        if (name !== "create-script") return null;
        return {
          name: "create-script",
          inputSchema: {
            required: ["projectRef", "scriptPath", "content"],
            properties: {
              projectRef: { type: "string" },
              scriptPath: { type: "string" },
              content: { type: "string" },
              requestedName: { type: "string" },
              resourceKind: { type: "string" },
            },
          },
        };
      },
    },
  });

  const result = await resolver.resolve(
    {
      status: "ready",
      tools: [
        {
          name: "create-script",
          args: {
            requestedName: "Enemy",
            resourceKind: "script",
            content: "extends Node\n",
          },
        },
      ],
    },
    {
      sessionStatus: {
        connectedProjectPath: "/tmp/gmcp-project-ref-alias",
      },
    }
  );

  assert.equal(result.status, "ready");
  assert.equal(result.tools[0].args.projectRef, "/tmp/gmcp-project-ref-alias");
  assert.equal(result.tools[0].args.scriptPath, "scripts/Enemy.gd");
});

test("argument resolver: maps planner body into schema-backed scriptContent for create-script", async () => {
  const resolver = new ArgumentResolver({
    toolInventory: {
      getTool(name) {
        if (name !== "create-script") return null;
        return {
          name: "create-script",
          inputSchema: {
            required: ["projectPath", "scriptPath"],
            properties: {
              projectPath: { type: "string" },
              scriptPath: { type: "string" },
              scriptContent: { type: "string" },
              requestedName: { type: "string" },
              resourceKind: { type: "string" },
              body: { type: "string" },
            },
          },
        };
      },
    },
  });

  const scriptBody = "extends Label\n\nfunc _ready():\n\ttext = \"A\"\n";
  const result = await resolver.resolve(
    {
      status: "ready",
      tools: [
        {
          name: "create-script",
          args: {
            requestedName: "Enemy",
            resourceKind: "script",
            body: scriptBody,
          },
        },
      ],
    },
    {
      sessionStatus: {
        connectedProjectPath: "/tmp/gmcp-content-field-map",
      },
    }
  );

  assert.equal(result.status, "ready");
  assert.equal(result.tools[0].args.scriptPath, "scripts/Enemy.gd");
  assert.equal(String(result.tools[0].args.scriptContent || "").trim(), scriptBody.trim());
});

test("argument resolver: maps code-like contentIntent into schema-backed scriptContent for create-script", async () => {
  const resolver = new ArgumentResolver({
    toolInventory: {
      getTool(name) {
        if (name !== "create-script") return null;
        return {
          name: "create-script",
          inputSchema: {
            required: ["projectPath", "scriptPath"],
            properties: {
              projectPath: { type: "string" },
              scriptPath: { type: "string" },
              scriptContent: { type: "string" },
              requestedName: { type: "string" },
              resourceKind: { type: "string" },
              contentIntent: { type: "string" },
            },
          },
        };
      },
    },
  });

  const intentCode = [
    "extends Label",
    "func _ready():",
    "    var alphabet = \"ABCDEFGHIJKLMNOPQRSTUVWXYZ\".split(\"\")[randi() % 26]",
    "    self.text = alphabet",
  ].join("\n");
  const result = await resolver.resolve(
    {
      status: "ready",
      tools: [
        {
          name: "create-script",
          args: {
            requestedName: "Enemy",
            resourceKind: "script",
            contentIntent: intentCode,
          },
        },
      ],
    },
    {
      sessionStatus: {
        connectedProjectPath: "/tmp/gmcp-content-intent-map",
      },
    }
  );

  assert.equal(result.status, "ready");
  assert.equal(result.tools[0].args.scriptPath, "scripts/Enemy.gd");
  assert.equal(String(result.tools[0].args.scriptContent || "").trim(), intentCode.trim());
});

test("path policy: resourceKind alone does not mark scenePath as may_not_exist_yet", () => {
  const policy = defaultPathPolicyForArg("scenePath", {
    scenePath: "Gameplay.tscn",
    resourceKind: "scene",
  });
  assert.equal(policy.existencePolicy, "must_exist");
});

test("argument resolver: canonicalizes scene basename via project index for list-scene-nodes style args", async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gmcp-scene-canon-"));
  try {
    const sceneAbsPath = path.join(projectRoot, "scenes", "Gameplay.tscn");
    await fs.mkdir(path.dirname(sceneAbsPath), { recursive: true });
    await fs.writeFile(sceneAbsPath, "[gd_scene format=3]\n");

    const fileIndex = new ProjectFileIndex();
    await fileIndex.build(projectRoot);
    const fileResolver = new ResourceResolver({ fileIndex });
    const resolver = new ArgumentResolver({
      fileResolver,
      toolInventory: {
        getTool(name) {
          if (name !== "list-scene-nodes") return null;
          return {
            name: "list-scene-nodes",
            inputSchema: {
              required: ["scenePath", "projectPath"],
              properties: {
                scenePath: { type: "string" },
                projectPath: { type: "string" },
                sceneRef: { type: "string" },
                resourceKind: { type: "string" },
              },
            },
          };
        },
      },
    });

    const result = await resolver.resolve(
      {
        status: "ready",
        tools: [
          {
            name: "list-scene-nodes",
            args: {
              sceneRef: "Gameplay.tscn",
              scenePath: "Gameplay.tscn",
              resourceKind: "scene",
            },
          },
        ],
      },
      {
        sessionStatus: {
          connectedProjectPath: projectRoot,
        },
      }
    );

    assert.equal(result.status, "ready");
    assert.equal(result.tools[0].args.scenePath, "scenes/Gameplay.tscn");
  } finally {
    await fs.rm(projectRoot, { recursive: true, force: true });
  }
});

test("argument resolver: ignores unresolved optional sceneRef placeholder for create-script", async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gmcp-script-no-scene-"));
  try {
    const fileIndex = new ProjectFileIndex();
    await fileIndex.build(projectRoot);
    const fileResolver = new ResourceResolver({ fileIndex });
    const resolver = new ArgumentResolver({
      fileResolver,
      toolInventory: {
        getTool(name) {
          if (name !== "create-script") return null;
          return {
            name: "create-script",
            inputSchema: {
              required: ["projectPath", "scriptPath", "content"],
              properties: {
                projectPath: { type: "string" },
                scriptPath: { type: "string" },
                content: { type: "string" },
                sceneRef: { type: "string" },
                requestedName: { type: "string" },
                resourceKind: { type: "string" },
              },
            },
          };
        },
      },
    });

    const result = await resolver.resolve(
      {
        status: "ready",
        tools: [
          {
            name: "create-script",
            args: {
              requestedName: "Enemy",
              resourceKind: "script",
              content: "extends Label\nfunc _ready():\n\tpass\n",
              sceneRef: "this",
            },
          },
        ],
      },
      {
        sessionStatus: {
          connectedProjectPath: projectRoot,
        },
      }
    );

    assert.equal(result.status, "ready");
    assert.equal(result.tools[0].args.scriptPath, "scripts/Enemy.gd");
    assert.equal(Object.prototype.hasOwnProperty.call(result.tools[0].args, "sceneRef"), false);
  } finally {
    await fs.rm(projectRoot, { recursive: true, force: true });
  }
});

test("argument resolver: create_then_attach still reports missing artifact target when no artifact path exists", () => {
  const resolver = new ArgumentResolver();
  const result = resolver._ensureAttachExistingDualResolution({
    args: {
      targetNodeRef: "root node",
    },
    argMeta: {},
    workflowState: {
      artifactOperation: {
        mode: "create_then_attach",
      },
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, "missing_args");
  assert.equal(result.field, "artifactRef");
});

test("argument resolver: infers missing targetNodeRef from requestedName when scene context exists", async () => {
  const calls = [];
  const resolver = new ArgumentResolver({
    nodeResolver: {
      async resolve(payload) {
        calls.push(payload);
        return { status: "resolved", value: "Player", ambiguities: [] };
      },
    },
  });
  const result = await resolver.resolveNodeRefs({
    toolName: "create-script",
    args: {
      requestedName: "Player",
      sceneRef: "Gameplay.tscn",
    },
    classification: {
      node_target_args: ["targetNodeRef"],
    },
    workflowState: {
      artifactOperation: {
        mode: "create_then_attach",
      },
    },
  });
  assert.equal(result.args.targetNodeRef, "Player");
  assert.equal(result.missingArgs.length, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].value, "Player");
  assert.equal(calls[0].scenePath, "Gameplay.tscn");
});

test("argument resolver: attach gate accepts inferred node target from requestedName", () => {
  const resolver = new ArgumentResolver();
  const result = resolver._ensureAttachExistingDualResolution({
    args: {
      artifactPath: "scripts/Player.gd",
      requestedName: "Player",
    },
    argMeta: {
      artifactPath: {
        provenance: "resolved_existing_ref",
        existencePolicy: "must_exist",
      },
    },
    workflowState: {
      artifactOperation: {
        mode: "create_then_attach",
      },
    },
  });
  assert.equal(result.ok, true);
});
