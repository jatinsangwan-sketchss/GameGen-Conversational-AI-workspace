import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Executor } from "../Executor.js";
import { buildArtifactOperationState } from "../ArtifactOperationModel.js";

test("artifact operation model: create-scene goal with root node reference remains create_new", () => {
  const state = buildArtifactOperationState({
    semanticIntent: {
      goalText: "Create new scene called Gameplay with Node2D as root node",
      goalType: "create",
      refs: {
        targetNodeRef: "root node",
        scriptRef: null,
        fileRef: null,
        resourceRef: null,
        artifactRef: null,
      },
      creationIntent: {
        requestedName: "Gameplay",
        resourceKind: "scene",
      },
    },
  });
  assert.equal(state.mode, "create_new");
  assert.equal(state.expectedEffects.artifactCreated, true);
  assert.equal(state.expectedEffects.artifactAttached, false);
});

test("artifact operation model: target node + existing artifact implies attach intent", () => {
  const state = buildArtifactOperationState({
    semanticIntent: {
      goalText: "Use PlayerController.gd on root node",
      goalType: "modify",
      refs: {
        targetNodeRef: "root node",
        scriptRef: "PlayerController.gd",
      },
    },
  });
  assert.equal(state.mode, "attach_existing");
  assert.equal(state.expectedEffects.artifactAttached, true);
});

test("executor attach verification: skips script read-back verification when step has no script target", async () => {
  const executor = new Executor();
  const result = await executor._verifyAttachApplied({
    args: {
      scenePath: "boot/Gameplay.tscn",
      targetNodeRef: "root node",
      rootNodeType: "Node2D",
    },
    client: null,
    inventory: null,
    workflowState: {
      artifactOperation: {
        mode: "create_then_attach",
      },
    },
  });
  assert.equal(result.ok, true);
});

test("executor fails create-tool execution when expected artifact path does not exist on disk", async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gmcp-false-positive-"));
  try {
    const executor = new Executor();
    const inventory = {
      getTool(name) {
        if (name !== "create-scene") return null;
        return {
          name: "create-scene",
          inputSchema: {
            required: ["projectPath", "scenePath"],
            properties: {
              projectPath: { type: "string" },
              scenePath: { type: "string" },
            },
          },
        };
      },
      getInventory() {
        return { tools: [] };
      },
    };
    const client = {
      async callTool() {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ scenePath: "res://boot/Gameplay.tscn" }),
            },
          ],
        };
      },
    };
    const result = await executor.executeTool({
      toolName: "create-scene",
      args: {
        projectPath: projectRoot,
        scenePath: "boot/Gameplay.tscn",
      },
      client,
      inventory,
      workflowState: {
        artifactOperation: {
          mode: "create_new",
          expectedEffects: {
            artifactCreated: true,
          },
        },
      },
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /expected artifact path\(s\) do not exist on disk/i);
  } finally {
    await fs.rm(projectRoot, { recursive: true, force: true });
  }
});

test("executor passes create-tool execution when artifact file exists after tool call", async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gmcp-created-artifact-"));
  try {
    const executor = new Executor();
    const inventory = {
      getTool(name) {
        if (name !== "create-scene") return null;
        return {
          name: "create-scene",
          inputSchema: {
            required: ["projectPath", "scenePath"],
            properties: {
              projectPath: { type: "string" },
              scenePath: { type: "string" },
            },
          },
        };
      },
      getInventory() {
        return { tools: [] };
      },
    };
    const client = {
      async callTool(_toolName, args) {
        const absScenePath = path.resolve(args.projectPath, args.scenePath);
        await fs.mkdir(path.dirname(absScenePath), { recursive: true });
        await fs.writeFile(absScenePath, "[gd_scene format=3]\n");
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ scenePath: "res://boot/Gameplay.tscn" }),
            },
          ],
        };
      },
    };
    const result = await executor.executeTool({
      toolName: "create-scene",
      args: {
        projectPath: projectRoot,
        scenePath: "boot/Gameplay.tscn",
      },
      client,
      inventory,
      workflowState: {
        artifactOperation: {
          mode: "create_new",
          expectedEffects: {
            artifactCreated: true,
          },
        },
      },
    });
    assert.equal(result.ok, true);
  } finally {
    await fs.rm(projectRoot, { recursive: true, force: true });
  }
});

test("executor passes create-tool execution when artifact file already exists", async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gmcp-existing-artifact-"));
  try {
    const existingScenePath = path.resolve(projectRoot, "boot/Gameplay.tscn");
    await fs.mkdir(path.dirname(existingScenePath), { recursive: true });
    await fs.writeFile(existingScenePath, "[gd_scene format=3]\n");
    const executor = new Executor();
    const inventory = {
      getTool(name) {
        if (name !== "create-scene") return null;
        return {
          name: "create-scene",
          inputSchema: {
            required: ["projectPath", "scenePath"],
            properties: {
              projectPath: { type: "string" },
              scenePath: { type: "string" },
            },
          },
        };
      },
      getInventory() {
        return { tools: [] };
      },
    };
    const client = {
      async callTool() {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ scenePath: "res://boot/Gameplay.tscn" }),
            },
          ],
        };
      },
    };
    const result = await executor.executeTool({
      toolName: "create-scene",
      args: {
        projectPath: projectRoot,
        scenePath: "boot/Gameplay.tscn",
      },
      client,
      inventory,
      workflowState: {
        artifactOperation: {
          mode: "create_new",
          expectedEffects: {
            artifactCreated: true,
          },
        },
      },
    });
    assert.equal(result.ok, true);
  } finally {
    await fs.rm(projectRoot, { recursive: true, force: true });
  }
});

test("executor passes add-node execution against existing scene file", async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gmcp-add-node-existing-scene-"));
  try {
    const sceneFilePath = path.resolve(projectRoot, "Gameplay.tscn");
    await fs.writeFile(sceneFilePath, "[gd_scene format=3]\n");
    const executor = new Executor();
    const inventory = {
      getTool(name) {
        if (name !== "add-node") return null;
        return {
          name: "add-node",
          inputSchema: {
            required: ["projectPath", "scenePath", "nodeType", "nodeName"],
            properties: {
              projectPath: { type: "string" },
              scenePath: { type: "string" },
              nodeType: { type: "string" },
              nodeName: { type: "string" },
            },
          },
        };
      },
      getInventory() {
        return { tools: [] };
      },
    };
    const client = {
      async callTool() {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ scenePath: "res://Gameplay.tscn" }),
            },
          ],
        };
      },
    };
    const result = await executor.executeTool({
      toolName: "add-node",
      args: {
        projectPath: projectRoot,
        scenePath: "Gameplay.tscn",
        nodeType: "Node2D",
        nodeName: "Player",
      },
      client,
      inventory,
      workflowState: {
        artifactOperation: {
          mode: "create_new",
          expectedEffects: {
            artifactCreated: true,
          },
        },
      },
    });
    assert.equal(result.ok, true);
  } finally {
    await fs.rm(projectRoot, { recursive: true, force: true });
  }
});
