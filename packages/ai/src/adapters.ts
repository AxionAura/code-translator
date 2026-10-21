// HTTP adapters (docs/ai-architecture.md §2): OpenAI-compatible, Anthropic, and a
// minimal user-templated custom endpoint. All speak JSON over the global fetch
// with an AbortSignal (no provider SDK), bound response sizes, and map every
// failure into ChatError codes. Adapter tests run against a loopback HTTP stub.
import {
  ChatError,
  chatError,
  type ChatModel,
  type ChatRequest,
  type ChatResult,
  type ChatUsage,
} from "./types.js";

export const MAX_RESPONSE_BYTES = 256 * 1024;

interface AdapterBaseOptions {
  readonly baseUrl: string;
  readonly model: string;
  readonly apiKey: string;
  // Per-request timeout; callers may also pass their own AbortSignal.
  readonly timeoutMs?: number;
  // Test seam: fetch implementation (defaults to the global).
  readonly fetchImpl?: typeof fetch;
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${path}`;
}

async function readBounded(response: Response): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    throw chatError(
      "AI-OVERSIZED-RESPONSE",
      `response body declares ${String(declared)} bytes (cap ${String(MAX_RESPONSE_BYTES)})`,
    );
  }
  const text = await response.text();
  if (text.length > MAX_RESPONSE_BYTES) {
    throw chatError(
      "AI-OVERSIZED-RESPONSE",
      `response body is ${String(text.length)} characters (cap ${String(MAX_RESPONSE_BYTES)})`,
    );
  }
  return text;
}

// Combine the caller's cancellation with the per-request timeout.
function requestSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
}

async function postJson(
  options: AdapterBaseOptions,
  url: string,
  headers: Readonly<Record<string, string>>,
  body: unknown,
  signal: AbortSignal | undefined,
): Promise<unknown> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 60000;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: requestSignal(signal, timeoutMs),
    });
  } catch (error) {
    if (signal?.aborted === true) {
      throw chatError("AI-ABORTED", "request cancelled by the caller", error);
    }
    const timedOut =
      error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    throw chatError(
      timedOut ? "AI-TIMEOUT" : "AI-UNAVAILABLE",
      timedOut
        ? `provider request exceeded ${String(timeoutMs)}ms`
        : `provider unreachable: ${error instanceof Error ? error.message : String(error)}`,
      error,
    );
  }
  const text = await readBounded(response);
  if (!response.ok) {
    // Bounded, key-free failure description (the request body echo is never
    // included; only status and a short reason phrase).
    throw chatError(
      "AI-HTTP-ERROR",
      `provider returned HTTP ${String(response.status)} ${response.statusText}: ${text.slice(0, 200)}`,
    );
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw chatError("AI-MALFORMED-RESPONSE", "provider returned non-JSON", error);
  }
}

function usageOrNull(input: unknown, output: unknown, usd: unknown = null): ChatUsage | null {
  if (typeof input !== "number" && typeof output !== "number") return null;
  return {
    inputTokens: typeof input === "number" ? input : null,
    outputTokens: typeof output === "number" ? output : null,
    usd: typeof usd === "number" ? usd : null,
  };
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

// ---- OpenAI-compatible -----------------------------------------------------------
// Covers OpenAI, vLLM, llama.cpp server, Ollama's OpenAI endpoint, LM Studio.
export class OpenAiCompatibleModel implements ChatModel {
  readonly id: string;
  private readonly options: AdapterBaseOptions;

  constructor(options: AdapterBaseOptions) {
    this.options = options;
    this.id = `openai:${options.model}`;
  }

  async complete(request: ChatRequest, signal?: AbortSignal): Promise<ChatResult> {
    const messages = [
      ...(request.system === undefined ? [] : [{ role: "system", content: request.system }]),
      ...request.messages.map((message) => ({ role: message.role, content: message.content })),
    ];
    const body: Record<string, unknown> = {
      model: this.options.model,
      messages,
      ...(request.maxTokens === undefined ? {} : { max_tokens: request.maxTokens }),
      ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
      ...(request.schema === undefined
        ? {}
        : {
            response_format: {
              type: "json_schema",
              json_schema: { name: "ctrans_choice", strict: true, schema: request.schema },
            },
          }),
    };
    const payload = await postJson(
      this.options,
      joinUrl(this.options.baseUrl, "/chat/completions"),
      { authorization: `Bearer ${this.options.apiKey}` },
      body,
      signal,
    );
    const root = recordOf(payload);
    const choices = root?.["choices"];
    const first = Array.isArray(choices) ? recordOf(choices[0]) : null;
    const message = first === null ? null : recordOf(first["message"]);
    const text = message === null ? null : message["content"];
    if (typeof text !== "string") {
      throw new ChatError("AI-MALFORMED-RESPONSE", "response has no choices[0].message.content");
    }
    const usage = recordOf(root?.["usage"]);
    return {
      text,
      usage:
        usage === null ? null : usageOrNull(usage["prompt_tokens"], usage["completion_tokens"]),
    };
  }
}

// ---- Anthropic -------------------------------------------------------------------
export class AnthropicModel implements ChatModel {
  readonly id: string;
  private readonly options: AdapterBaseOptions;

  constructor(options: AdapterBaseOptions) {
    this.options = options;
    this.id = `anthropic:${options.model}`;
  }

  async complete(request: ChatRequest, signal?: AbortSignal): Promise<ChatResult> {
    const body: Record<string, unknown> = {
      model: this.options.model,
      // The Messages API requires max_tokens; default to a bounded value.
      max_tokens: request.maxTokens ?? 1024,
      messages: request.messages.map((message) => ({
        role: message.role,
        content: message.content,
      })),
      ...(request.system === undefined ? {} : { system: request.system }),
      ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
      // Structured output: the schema travels as an instruction; the caller
      // validates the parsed text against it (one bounded re-ask on failure).
    };
    if (request.schema !== undefined) {
      body["system"] =
        `${request.system ?? ""}\nRespond with JSON matching this schema and nothing else:\n${JSON.stringify(request.schema)}`.trim();
    }
    const payload = await postJson(
      this.options,
      joinUrl(this.options.baseUrl, "/v1/messages"),
      {
        "x-api-key": this.options.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body,
      signal,
    );
    const root = recordOf(payload);
    const content = root?.["content"];
    const first = Array.isArray(content) ? recordOf(content[0]) : null;
    const text = first === null ? null : first["text"];
    if (typeof text !== "string") {
      throw new ChatError("AI-MALFORMED-RESPONSE", "response has no content[0].text");
    }
    const usage = recordOf(root?.["usage"]);
    return {
      text,
      usage: usage === null ? null : usageOrNull(usage["input_tokens"], usage["output_tokens"]),
    };
  }
}

// ---- Custom endpoint (user-supplied request/response templates) -------------------
export interface CustomEndpointOptions {
  readonly url: string;
  readonly model: string;
  readonly apiKey: string;
  // JSON body template with {{system}}, {{user}}, {{schema}} placeholders
  // (values are JSON-escaped before substitution).
  readonly bodyTemplate: string;
  // Extra headers (never logged).
  readonly headers?: Readonly<Record<string, string>>;
  // Dot path to the response text inside the JSON reply (default "text").
  readonly responsePath?: string;
  readonly inputTokensPath?: string;
  readonly outputTokensPath?: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

function dotGet(value: unknown, path: string): unknown {
  let current: unknown = value;
  for (const segment of path.split(".")) {
    const record = recordOf(current);
    if (record === null) return undefined;
    current = record[segment];
  }
  return current;
}

export class CustomEndpointModel implements ChatModel {
  readonly id: string;
  private readonly options: CustomEndpointOptions;

  constructor(options: CustomEndpointOptions) {
    this.options = options;
    this.id = `custom:${options.model}`;
  }

  async complete(request: ChatRequest, signal?: AbortSignal): Promise<ChatResult> {
    const userContent = request.messages.map((message) => message.content).join("\n");
    const substitute = (template: string): string =>
      template
        .replaceAll("{{system}}", JSON.stringify(request.system ?? ""))
        .replaceAll("{{user}}", JSON.stringify(userContent))
        .replaceAll("{{schema}}", JSON.stringify(request.schema ?? {}));
    let body: unknown;
    try {
      body = JSON.parse(substitute(this.options.bodyTemplate)) as unknown;
    } catch (error) {
      throw chatError(
        "AI-CUSTOM-TEMPLATE",
        "custom body template is not valid JSON after substitution",
        error,
      );
    }
    const postOptions: AdapterBaseOptions = {
      baseUrl: "",
      model: this.options.model,
      apiKey: this.options.apiKey,
      ...(this.options.timeoutMs === undefined ? {} : { timeoutMs: this.options.timeoutMs }),
      ...(this.options.fetchImpl === undefined ? {} : { fetchImpl: this.options.fetchImpl }),
    };
    const payload = await postJson(
      postOptions,
      this.options.url,
      { authorization: `Bearer ${this.options.apiKey}`, ...(this.options.headers ?? {}) },
      body,
      signal,
    );
    const text = dotGet(payload, this.options.responsePath ?? "text");
    if (typeof text !== "string") {
      throw new ChatError(
        "AI-MALFORMED-RESPONSE",
        `custom response has no string at path "${this.options.responsePath ?? "text"}"`,
      );
    }
    const inputTokens =
      this.options.inputTokensPath === undefined
        ? null
        : dotGet(payload, this.options.inputTokensPath);
    const outputTokens =
      this.options.outputTokensPath === undefined
        ? null
        : dotGet(payload, this.options.outputTokensPath);
    return {
      text,
      usage:
        typeof inputTokens === "number" || typeof outputTokens === "number"
          ? usageOrNull(inputTokens, outputTokens)
          : null,
    };
  }
}
