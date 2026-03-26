/**
 * Local llama-backed LLM client implementation.
 *
 * Uses an OpenAI-compatible endpoint exposed locally for gpt-oss:20b tests.
 */

import { BaseLLMClient, LLMClientError } from "./client.js";

export class LlamaLLMClient extends BaseLLMClient {
  /**
   * @param {object} params
   * @param {string} params.host
   * @param {number} params.port
   * @param {number} params.timeoutSeconds
   */
  constructor({ host = "127.0.0.1", port = 11434, timeoutSeconds = 120, backendName = "llama" }) {
    super(backendName);
    this.host = host;
    this.port = port;
    this.timeoutSeconds = timeoutSeconds;
    this.backendName = backendName;
  }

  static fromConfig(config) {
    const host = String(config?.host ?? "127.0.0.1").trim();
    const port = Number(config?.port ?? 11434);
    const timeoutSeconds = Number(config?.timeout_seconds ?? config?.timeoutSeconds ?? 120);
    return new LlamaLLMClient({ host, port, timeoutSeconds, backendName: "llama" });
  }

  async generateText({ prompt, model, temperature = 0.0, maxTokens = undefined }) {
    const endpoint = `http://${this.host}:${this.port}/v1/chat/completions`;
    const payload = buildChatPayload({ model, prompt, temperature, maxTokens });

    const raw = await postJson({ endpoint, payload, timeoutSeconds: this.timeoutSeconds, backend: "llama" });
    const text = extractChatText(raw, { backend: "llama" });

    return { text, backend: this.backendName, model, raw };
  }
}

function buildChatPayload({ model, prompt, temperature, maxTokens }) {
  const payload = {
    model,
    messages: [{ role: "user", content: prompt }],
    temperature,
  };
  if (maxTokens !== undefined && maxTokens !== null) payload.max_tokens = maxTokens;
  return payload;
}

async function postJson({ endpoint, payload, timeoutSeconds, backend }) {
  const controller = new AbortController();
  const timeoutMs = timeoutSeconds != null ? Math.max(0, timeoutSeconds * 1000) : undefined;
  let timer;
  if (timeoutMs != null) timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const bodyText = await res.text();

    if (!res.ok) {
      throw new LLMClientError({
        code: "http_error",
        message: `HTTP ${res.status} from llama endpoint: ${bodyText}`,
        backend,
        retriable: res.status >= 500 && res.status < 600,
      });
    }

    let parsed;
    try {
      parsed = JSON.parse(bodyText);
    } catch {
      throw new LLMClientError({
        code: "invalid_response_json",
        message: "Llama endpoint returned non-JSON response.",
        backend,
        retriable: false,
      });
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new LLMClientError({
        code: "invalid_response_shape",
        message: "Llama endpoint response JSON must be an object.",
        backend,
        retriable: false,
      });
    }

    return parsed;
  } catch (err) {
    if (err?.name === "AbortError") {
      throw new LLMClientError({
        code: "timeout_error",
        message: `Request timed out after ${timeoutSeconds} seconds.`,
        backend,
        retriable: true,
      });
    }
    if (err instanceof LLMClientError) throw err;
    throw new LLMClientError({
      code: "network_error",
      message: `Could not reach llama endpoint: ${err?.message ?? String(err)}`,
      backend,
      retriable: true,
    });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function extractChatText(responseJson, { backend }) {
  const choices = responseJson?.choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new LLMClientError({
      code: "missing_choices",
      message: "Llama response missing choices array.",
      backend,
      retriable: false,
    });
  }

  const first = choices[0];
  const message = first?.message;
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    throw new LLMClientError({
      code: "missing_message",
      message: "Llama response missing message object.",
      backend,
      retriable: false,
    });
  }

  const content = message?.content;
  if (typeof content === "string" && content.trim()) return content;

  throw new LLMClientError({
    code: "unsupported_content",
    message: "Llama response content is missing or unsupported.",
    backend,
    retriable: false,
  });
}

