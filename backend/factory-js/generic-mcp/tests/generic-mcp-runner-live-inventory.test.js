import test from "node:test";
import assert from "node:assert/strict";

import { GenericMcpRunner } from "../GenericMcpRunner.js";

function makeInventoryApi({ refreshResult, tools }) {
  return {
    async refresh() {
      return refreshResult;
    },
    getInventory() {
      return {
        toolCount: Array.isArray(tools) ? tools.length : 0,
        fetchedAt: "2026-04-06T00:00:00.000Z",
        tools: Array.isArray(tools) ? tools.map((name) => ({ name })) : [],
      };
    },
  };
}

test("runner live inventory validation fails when planned tool is missing and reports alias-drift candidates", async () => {
  const runner = new GenericMcpRunner();
  const inventoryApi = makeInventoryApi({
    refreshResult: { ok: true },
    tools: ["create-scene", "add-node", "save-scene"],
  });
  const validation = await runner._refreshAndValidateExecutionTools({
    toolInventory: inventoryApi,
    resolvedPlan: {
      tools: [{ name: "scene-create", args: {} }],
    },
  });
  assert.equal(validation.ok, false);
  assert.match(validation.error, /scene-create/);
  assert.match(validation.error, /create-scene/);
  assert.match(validation.error, /alias drift/i);
});

test("runner live inventory validation fails when refresh fails", async () => {
  const runner = new GenericMcpRunner();
  const inventoryApi = makeInventoryApi({
    refreshResult: { ok: false, error: "transport timeout" },
    tools: ["create-scene"],
  });
  const validation = await runner._refreshAndValidateExecutionTools({
    toolInventory: inventoryApi,
    resolvedPlan: {
      tools: [{ name: "create-scene", args: {} }],
    },
  });
  assert.equal(validation.ok, false);
  assert.match(validation.error, /refresh failed/i);
  assert.match(validation.error, /transport timeout/i);
});

test("runner live inventory validation passes when planned tools match refreshed inventory", async () => {
  const runner = new GenericMcpRunner();
  const inventoryApi = makeInventoryApi({
    refreshResult: { ok: true },
    tools: ["create-scene", "add-node"],
  });
  const validation = await runner._refreshAndValidateExecutionTools({
    toolInventory: inventoryApi,
    resolvedPlan: {
      tools: [
        { name: "create-scene", args: {} },
        { name: "add-node", args: {} },
      ],
    },
  });
  assert.equal(validation.ok, true);
  assert.equal(validation.error, null);
});
