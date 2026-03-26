/**
 * API-backed LLM client implementation.
 *
 * Isolates transport logic for remote OpenAI-compatible endpoints.
 */

import { BaseLLMClient, LLMClientError } from "./client.js";

export class APILLMClient extends BaseLLMClient {
  /**
   * @param {object} params
   * @param {string} params.baseUrl
   * @param {string | undefined} [params.apiKey]
   * @param {number} [params.timeoutSeconds]
   */
  constructor({ baseUrl, apiKey = undefined, timeoutSeconds = 60, backendName = "api" }) {
    super(backendName);
    this.baseUrl = String(baseUrl).replace(/\/+$/, "");
    this.apiKey = apiKey;
    this.timeoutSeconds = timeoutSeconds;
    this.backendName = backendName;
  }

  static fromConfig(config) {
    const baseUrl = String(config?.base_url ?? config?.baseUrl ?? "").trim();
    if (!baseUrl) {
      throw new LLMClientError({
        code: "missing_base_url",
        message: "API backend requires 'base_url'.",
        backend: "api",
        retriable: false,
      });
    }

    const apiKey = config?.api_key ?? config?.apiKey;
    const timeoutSeconds = Number(config?.timeout_seconds ?? config?.timeoutSeconds ?? 60);

    return new APILLMClient({
      baseUrl,
      apiKey: apiKey ? String(apiKey) : undefined,
      timeoutSeconds,
      backendName: "api",
    });
  }

  async generateText({ prompt, model, temperature = 0.0, maxTokens = undefined }) {
    const payload = buildChatPayload({ model, prompt, temperature, maxTokens });
    const endpoint = `${this.baseUrl}/v1/chat/completions`;

    const raw = await postJson({
      endpoint,
      payload,
      timeoutSeconds: this.timeoutSeconds,
      apiKey: this.apiKey,
      backend: "api",
    });

    const text = extractChatText(raw, { backend: "api" });
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

async function postJson({ endpoint, payload, timeoutSeconds, apiKey, backend }) {
  const controller = new AbortController();
  const timeoutMs = timeoutSeconds != null ? Math.max(0, timeoutSeconds * 1000) : undefined;
  let timer;
  if (timeoutMs != null) {
    timer = setTimeout(() => controller.abort(), timeoutMs);
  }

  try {
    const headers = { "Content-Type": "application/json" };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

    const res = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const bodyText = await res.text();

    if (!res.ok) {
      throw new LLMClientError({
        code: "http_error",
        message: `HTTP ${res.status} from LLM endpoint: ${bodyText}`,
        backend,
        retriable: res.status >= 500 && res.status < 600,
      });
    }

    let parsed;
    try {
      parsed = JSON.parse(bodyText);
    } catch (err) {
      throw new LLMClientError({
        code: "invalid_response_json",
        message: "LLM endpoint returned non-JSON response.",
        backend,
        retriable: false,
      });
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new LLMClientError({
        code: "invalid_response_shape",
        message: "LLM endpoint response JSON must be an object.",
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
      message: `Could not reach LLM endpoint: ${err?.message ?? String(err)}`,
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
      message: "LLM response missing choices array.",
      backend,
      retriable: false,
    });
  }

  const first = choices[0];
  const message = first?.message;
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    throw new LLMClientError({
      code: "missing_message",
      message: "LLM response missing message object.",
      backend,
      retriable: false,
    });
  }

  const content = message?.content;
  if (typeof content === "string") {
    if (!content.trim()) {
      throw new LLMClientError({
        code: "empty_content",
        message: "LLM response content is empty.",
        backend,
        retriable: false,
      });
    }
    return content;
  }

  if (Array.isArray(content)) {
    const textParts = [];
    for (const part of content) {
      if (part && typeof part === "object" && part.type === "text") {
        const value = part.text;
        if (typeof value === "string") textParts.push(value);
      }
    }
    const merged = textParts.map((s) => s.trim()).filter(Boolean).join("\n").trim();
    if (merged) return merged;
  }

  throw new LLMClientError({
    code: "unsupported_content",
    message: "LLM response message content is missing or unsupported.",
    backend,
    retriable: false,
  });
}

