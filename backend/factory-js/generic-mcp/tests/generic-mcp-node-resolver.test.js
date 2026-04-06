import test from "node:test";
import assert from "node:assert/strict";

import { NodeResolver } from "../NodeResolver.js";

test("node resolver: parses tree-shaped list_scene_nodes payloads", () => {
  const resolver = new NodeResolver();
  const nodes = resolver._extractNodes({
    content: [
      {
        type: "text",
        text: JSON.stringify({
          ok: true,
          tree: {
            name: "Root",
            path: ".",
            type: "Node2D",
            children: [
              {
                name: "Player",
                path: "Player",
                type: "Node2D",
                children: [],
              },
            ],
          },
        }),
      },
    ],
  });
  const player = nodes.find((node) => node.path === "Player");
  assert.ok(player);
  assert.equal(player.name, "Player");
});

test("node resolver: resolves node by name from tree payload and forwards active project path", async () => {
  const calls = [];
  const resolver = new NodeResolver({
    sessionManager: {
      getClient() {
        return {
          async callTool(name, args) {
            calls.push({ name, args });
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    ok: true,
                    tree: {
                      name: "Root",
                      path: ".",
                      type: "Node2D",
                      children: [
                        {
                          name: "Player",
                          path: "Player",
                          type: "Node2D",
                          children: [],
                        },
                      ],
                    },
                  }),
                },
              ],
            };
          },
        };
      },
      getStatus() {
        return {
          connectedProjectPath: "/tmp/game-project",
        };
      },
    },
    inventory: {
      getInventory() {
        return {
          tools: [{ name: "list-scene-nodes" }],
        };
      },
    },
  });
  const result = await resolver.resolve({
    toolName: "set-node-properties",
    argKey: "nodeRef",
    value: "Player",
    scenePath: "Gameplay.tscn",
  });
  assert.equal(result.status, "resolved");
  assert.equal(result.value, "Player");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "list-scene-nodes");
  assert.equal(calls[0].args.scenePath, "Gameplay.tscn");
  assert.equal(calls[0].args.projectPath, "/tmp/game-project");
});
