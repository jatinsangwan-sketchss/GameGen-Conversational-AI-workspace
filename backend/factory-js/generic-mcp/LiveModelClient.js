/**
 * LiveModelClient
 * -----------------------------------------------------------------------------
 * Adapter for live LLM planning calls used by ToolPlanner.
 *
 * This client is intentionally model-only:
 * - no MCP logic
 * - no tool logic
 * - no execution semantics
 *
 * Ollama model names use a `name:tag` form (e.g. `gpt-oss:20b`). A typo like
 * `gpt-oss-20b` yields 404 from the API — that is wiring/config, not MCP.
 */

/** Default when CLI and GENERIC_MCP_MODEL_NAME are unset (Ollama). */
export const DEFAULT_OLLAMA_MODEL_NAME = "gpt-oss:20b";

function safeString(value) {
  return value == null ? "" : String(value);
}
function normalizeResponseFormat(value) {
  const v = safeString(value).trim().toLowerCase();
  return v === "json_object" ? "json_object" : null;
}

export class LiveModelClient {
  constructor({
    backend = process.env.GENERIC_MCP_MODEL_BACKEND || "llama",
    model = process.env.GENERIC_MCP_MODEL_NAME || DEFAULT_OLLAMA_MODEL_NAME,
    baseUrl = process.env.GENERIC_MCP_MODEL_BASE_URL || "http://127.0.0.1:11434",
    apiKey = process.env.GENERIC_MCP_MODEL_API_KEY || "",
    timeoutMs = Number(process.env.GENERIC_MCP_MODEL_TIMEOUT_MS || 120000),
    debug = process.env.GENERIC_MCP_MODEL_DEBUG === "1" || process.env.GENERIC_MCP_MODEL_DEBUG === "true",
  } = {}) {
    this._backend = safeString(backend).trim().toLowerCase();
    this._model = safeString(model).trim();
    this._baseUrl = safeString(baseUrl).trim().replace(/\/+$/, "");
    this._apiKey = safeString(apiKey).trim();
    this._timeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 120000;
    this._debug = Boolean(debug);
  }

  _logModelRequestDebug() {
    if (!this._debug) return;
    console.error(
      `[generic-mcp][model] backend=${this._backend} model=${this._model} baseUrl=${this._baseUrl}`
    );
  }

  async generate({ prompt, responseFormat = null } = {}) {
    const p = safeString(prompt);
    if (!p.trim()) throw new Error("LiveModelClient requires non-empty prompt.");
    this._logModelRequestDebug();
    const format = normalizeResponseFormat(responseFormat);
    if (this._backend === "openai") return this._generateOpenAiCompatible(p, { responseFormat: format });
    return this._generateLlama(p);
  }

  async _generateLlama(prompt) {
    const url = `${this._baseUrl}/api/generate`;
    const body = {
      model: this._model,
      prompt,
      stream: false,
      options: { temperature: 0 },
    };
    const json = await this._postJson(url, body, { contentType: "application/json" });
    const text = safeString(json?.response ?? json?.text ?? "");
    if (!text.trim()) throw new Error("Model returned empty response.");
    return { text };
  }

  async _generateOpenAiCompatible(prompt, { responseFormat = null } = {}) {
    const format = normalizeResponseFormat(responseFormat);
    const useJsonMode = format === "json_object";
    const url = useJsonMode ? `${this._baseUrl}/v1/chat/completions` : `${this._baseUrl}/v1/responses`;
    const body = useJsonMode
      ? {
          model: this._model,
          messages: [{ role: "user", content: prompt }],
          response_format: { type: "json_object" },
          temperature: 0,
        }
      : {
          model: this._model,
          input: prompt,
          temperature: 0,
        };
    const headers = this._apiKey ? { Authorization: `Bearer ${this._apiKey}` } : {};
    const json = await this._postJson(url, body, {
      contentType: "application/json",
      extraHeaders: headers,
    });
    const text =
      safeString(json?.output_text) ||
      safeString(json?.choices?.[0]?.message?.content) ||
      safeString(json?.text) ||
      "";
    if (!text.trim()) throw new Error("Model returned empty response.");
    return { text };
  }

  async _postJson(url, body, { contentType = "application/json", extraHeaders = {} } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this._timeoutMs);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": contentType,
          ...extraHeaders,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        const msg = await res.text();
        throw new Error(`Model request failed (${res.status}): ${msg}`);
      }
      return res.json();
    } finally {
      clearTimeout(timer);
    }
  }
}

