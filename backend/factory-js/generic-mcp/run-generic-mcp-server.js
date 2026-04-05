#!/usr/bin/env node
import path from "node:path";
import { pathToFileURL } from "node:url";

import { SessionManager } from "./SessionManager.js";
import { ToolInventory } from "./ToolInventory.js";
import { ToolPlanner } from "./ToolPlanner.js";
import { ArgumentResolver } from "./ArgumentResolver.js";
import { Executor } from "./Executor.js";
import { ResultPresenter } from "./ResultPresenter.js";
import { GenericMcpRunner } from "./GenericMcpRunner.js";
import { LiveModelClient } from "./LiveModelClient.js";
import { ProjectFileIndex } from "./ProjectFileIndex.js";
import { ResourceResolver } from "./ResourceResolver.js";
import { NodeResolver } from "./NodeResolver.js";
import { McpConfigLoader } from "./McpConfigLoader.js";

import { GenericMcpSessionStore } from "./api/GenericMcpSessionStore.js";
import { GenericMcpHttpAdapter } from "./api/GenericMcpHttpAdapter.js";
import { GenericMcpHttpServer } from "./api/GenericMcpHttpServer.js";
import { buildGenericMcpServerConfig, genericMcpServerUsage } from "./config/genericMcpServer.config.js";

function safeString(value) {
  return value == null ? "" : String(value);
}

function hasArg(argv, name) {
  return argv.includes(name);
}

async function loadCreateClient(clientModulePath) {
  const abs = path.resolve(clientModulePath);
  const mod = await import(pathToFileURL(abs).href);
  const fn =
    (typeof mod.createClient === "function" && mod.createClient) ||
    (typeof mod.default === "function" && mod.default) ||
    (typeof mod.default?.createClient === "function" && mod.default.createClient) ||
    null;
  if (!fn) {
    throw new Error(`Client module must export createClient(...): ${abs}`);
  }
  return fn;
}

function isMainModule() {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(path.resolve(entry)).href;
}

export async function createGenericMcpSidecarRuntime({ argv = [], env = process.env } = {}) {
  const config = buildGenericMcpServerConfig({ argv, env });
  const configLoader = new McpConfigLoader();
  const configResult = await configLoader.load({
    mcpConfigPath: config.mcpConfigPath,
    mcpConfigJson: config.mcpConfigJson,
  });

  if (!configResult.ok) {
    throw new Error(`Failed to load MCP config: ${safeString(configResult.error)}`);
  }

  const mcpConfig = configResult.mcpConfig;
  const createClient = await loadCreateClient(config.clientModulePath);
  const modelClient = new LiveModelClient(config.model);

  const sessionManager = new SessionManager({
    mcpConfig,
    createClient: async ({ mcpConfig: cfg }) => createClient({ mcpConfig: cfg }),
    debug: config.debug,
  });

  const toolInventory = new ToolInventory({ sessionManager });
  const fileIndex = new ProjectFileIndex({ debug: config.debug });
  const resourceResolver = new ResourceResolver({ fileIndex, debug: config.debug });
  const nodeResolver = new NodeResolver({ sessionManager, inventory: toolInventory });
  const toolPlanner = new ToolPlanner({ toolInventory, modelClient });
  const argumentResolver = new ArgumentResolver({
    sessionManager,
    fileResolver: resourceResolver,
    nodeResolver,
    toolInventory,
    debug: config.debug,
  });
  const executor = new Executor({
    sessionManager,
    toolInventory,
    fileIndex,
    debug: config.debug,
  });
  const resultPresenter = new ResultPresenter({ debug: config.debug });

  const runner = new GenericMcpRunner({
    sessionManager,
    toolInventory,
    toolPlanner,
    argumentResolver,
    executor,
    resultPresenter,
    fileIndex,
    resourceResolver,
    modelClient,
    mcpConfig,
    debug: config.debug,
  });

  const sessionStore = new GenericMcpSessionStore({ maxSessions: config.maxSessions });
  const adapter = new GenericMcpHttpAdapter({
    runner,
    sessionStore,
    mcpConfig,
    defaultProjectPath: config.defaultProjectPath,
    debug: config.debug,
  });
  const server = new GenericMcpHttpServer({
    adapter,
    host: config.host,
    port: config.port,
    maxBodyBytes: config.maxBodyBytes,
    debug: config.debug,
  });

  let stopped = false;
  return {
    config,
    mcpConfig,
    sessionManager,
    runner,
    sessionStore,
    adapter,
    server,
    async start() {
      const address = await server.start();
      return address;
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      await server.stop();
      await sessionManager.shutdown();
    },
  };
}

async function main() {
  const argv = process.argv.slice(2);
  if (hasArg(argv, "--help")) {
    console.log(genericMcpServerUsage());
    process.exit(0);
  }

  const runtime = await createGenericMcpSidecarRuntime({ argv, env: process.env });
  const address = await runtime.start();
  console.error(
    `[generic-mcp] sidecar listening on http://${address?.host || "127.0.0.1"}:${address?.port || runtime.config.port}`
  );
  console.error(
    `[generic-mcp] workflow source of truth: GenericMcpRunner | client module: ${runtime.config.clientModulePath}`
  );

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error(`[generic-mcp] received ${signal}; shutting down sidecar...`);
    await runtime.stop();
    process.exit(0);
  };

  process.once("SIGINT", () => {
    shutdown("SIGINT").catch((err) => {
      console.error("[generic-mcp] shutdown error:", safeString(err?.message ?? err));
      process.exit(1);
    });
  });
  process.once("SIGTERM", () => {
    shutdown("SIGTERM").catch((err) => {
      console.error("[generic-mcp] shutdown error:", safeString(err?.message ?? err));
      process.exit(1);
    });
  });
}

if (isMainModule()) {
  main().catch((err) => {
    console.error("run-generic-mcp-server failed:", safeString(err?.message ?? err));
    process.exit(1);
  });
}

