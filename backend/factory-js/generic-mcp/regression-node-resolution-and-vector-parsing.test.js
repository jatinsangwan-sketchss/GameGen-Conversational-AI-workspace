import test from "node:test";
import assert from "node:assert/strict";
import { NodeResolver } from "./NodeResolver.js";
import { interpretGoalIntent } from "./GoalIntentInterpreter.js";
import { coercePropertyLikeArgs } from "./PropertyValueCoercer.js";

test("NodeResolver resolves prefixed-mismatch node target via fallback variants", async () => {
  const fakeClient = {
    async callTool() {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              nodes: [
                { name: "World", path: "World", type: "Node2D" },
                { name: "PlayerSpawn", path: "World/PlayerSpawn", type: "Marker2D" },
                { name: "BoundLeft", path: "BoundLeft", type: "StaticBody2D" },
              ],
            }),
          },
        ],
      };
    },
  };
  const resolver = new NodeResolver({
    sessionManager: {
      client: fakeClient,
      getClient() {
        return fakeClient;
      },
      getStatus() {
        return {};
      },
    },
    inventory: {
      getInventory() {
        return {
          tools: [
            {
              name: "list-scene-nodes",
              inputSchema: { type: "object", properties: { scenePath: { type: "string" } } },
            },
          ],
        };
      },
    },
  });

  const result = await resolver.resolve({
    toolName: "set-node-properties",
    argKey: "nodeRef",
    value: "World/BoundLeft",
    scenePath: "scenes/Game.tscn",
  });

  assert.equal(result.status, "resolved");
  assert.equal(result.value, "BoundLeft");
});

test("GoalIntentInterpreter parses Vector2 literals into structured targeted edits", () => {
  const intent = interpretGoalIntent({
    userRequest: "Use set_node_properties to set PlayerSpawn.position to Vector2(540, 1400).",
  });
  assert.ok(Array.isArray(intent.targetedEdits));
  assert.equal(intent.targetedEdits.length, 1);
  assert.deepEqual(intent.targetedEdits[0], {
    kind: "set_value",
    field: "PlayerSpawn.position",
    newValue: { type: "Vector2", x: 540, y: 1400 },
    oldValue: null,
  });
});

test("PropertyValueCoercer coerces vector-like property values generically", () => {
  const fromString = coercePropertyLikeArgs({
    toolName: "set-node-properties",
    args: {
      properties: { position: "Vector2(540, 1400)" },
    },
  });
  assert.deepEqual(fromString.args.properties.position, { type: "Vector2", x: 540, y: 1400 });

  const fromObject = coercePropertyLikeArgs({
    toolName: "set-node-properties",
    args: {
      properties: { position: { x: 90, y: 0 } },
    },
  });
  assert.deepEqual(fromObject.args.properties.position, { type: "Vector2", x: 90, y: 0 });
});
