import test from "node:test";
import assert from "node:assert/strict";

import { buildGenericMcpServerConfig } from "../config/genericMcpServer.config.js";

test("sidecar config enables startup auto-init by default", () => {
  const config = buildGenericMcpServerConfig({ argv: [], env: {} });
  assert.equal(config.autoInitializeOnStart, true);
});

test("sidecar config disables startup auto-init via flag", () => {
  const config = buildGenericMcpServerConfig({ argv: ["--no-auto-init"], env: {} });
  assert.equal(config.autoInitializeOnStart, false);
});

test("sidecar config disables startup auto-init via env", () => {
  const config = buildGenericMcpServerConfig({
    argv: [],
    env: { GENERIC_MCP_AUTO_INIT_ON_START: "false" },
  });
  assert.equal(config.autoInitializeOnStart, false);
});

test("sidecar config allows explicit --auto-init override", () => {
  const config = buildGenericMcpServerConfig({
    argv: ["--auto-init"],
    env: { GENERIC_MCP_AUTO_INIT_ON_START: "false" },
  });
  assert.equal(config.autoInitializeOnStart, true);
});
