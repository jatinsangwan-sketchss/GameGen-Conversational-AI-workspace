/**
 * Shared LLM client abstractions for the factory.
 *
 * Provides one backend-agnostic interface:
 * - generateText(prompt, model, ...)
 * - generateJson(prompt, model, ...) (parses JSON from generateText output)
 *
 * Backend transport details live in:
 * - api_client.js
 * - llama_client.js
 */

import { parseJsonPayloadFromText } from "./response_parser.js";

export class LLMClientError extends Error {
  /**
   * @param {object} params
   * @param {string} params.code
   * @param {string} params.message
   * @param {string} params.backend
   * @param {boolean} [params.retriable]
   */
  constructor({ code, message, backend, retriable = false }) {
    super(message);
    this.code = code;
    this.backend = backend;
    this.retriable = retriable;
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      backend: this.backend,
      retriable: this.retriable,
    };
  }
}

/**
 * @typedef {object} LLMResponse
 * @property {string} text
 * @property {string} backend
 * @property {string} model
 * @property {object | null} [raw]
 */

export class BaseLLMClient {
  /**
   * @param {string} backendName
   */
  constructor(backendName) {
    this.backendName = backendName;
  }

  /**
   * Generate raw text.
   * @abstract
   */
  async generateText({ prompt, model, temperature = 0.0, maxTokens = undefined }) {
    throw new Error("generateText not implemented");
  }

  /**
   * Generate structured JSON by parsing JSON from generateText output.
   * @param {object} params
   * @param {string} params.prompt
   * @param {string} params.model
   * @param {number} [params.temperature]
   * @param {number | undefined} [params.maxTokens]
   * @returns {Promise<object>}
   */
  async generateJson({ prompt, model, temperature = 0.0, maxTokens = undefined }) {
    const response = await this.generateText({ prompt, model, temperature, maxTokens });

    let jsonObj;
    try {
      jsonObj = parseJsonPayloadFromText(response.text);
    } catch (err) {
      if (err instanceof LLMClientError) throw err;
      throw new LLMClientError({
        code: "invalid_json_output",
        message: "Model output is not valid JSON.",
        backend: response.backend,
        retriable: false,
      });
    }

    if (typeof jsonObj !== "object" || jsonObj === null || Array.isArray(jsonObj)) {
      throw new LLMClientError({
        code: "non_object_json_output",
        message: "Model JSON output must be an object.",
        backend: response.backend,
        retriable: false,
      });
    }

    return jsonObj;
  }
}

/**
 * Create a backend-appropriate LLM client from config.
 *
 * Expected shape:
 * {
 *   backend: "api" | "llama",
 *   api: {...},
 *   llama: {...}
 * }
 */
export async function createLLMClient(config) {
  const backend = String(config?.backend ?? "").trim().toLowerCase();

  if (backend === "api") {
    const apiCfg = ensureMapping(config?.api, "api");
    const mod = await import("./api_client.js");
    return mod.APILLMClient.fromConfig(apiCfg);
  }

  if (backend === "llama") {
    const llamaCfg = ensureMapping(config?.llama, "llama");
    const mod = await import("./llama_client.js");
    return mod.LlamaLLMClient.fromConfig(llamaCfg);
  }

  throw new LLMClientError({
    code: "unsupported_backend",
    message: `Unsupported LLM backend: ${backend}. Expected 'api' or 'llama'.`,
    backend: "client_factory",
    retriable: false,
  });
}

function ensureMapping(value, key) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  throw new LLMClientError({
    code: "invalid_backend_config",
    message: `Missing or invalid backend config section: '${key}'.`,
    backend: "client_factory",
    retriable: false,
  });
}

