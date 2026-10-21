// Adapter contract tests (docs/ai-architecture.md §2/§6): every provider adapter
// runs against a loopback node:http stub — no live provider, no network beyond
// 127.0.0.1. Covered: request shape, response parsing, usage, HTTP errors, timeout,
// malformed/oversized responses, custom templates.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  AnthropicModel,
  ChatError,
  CustomEndpointModel,
  MAX_RESPONSE_BYTES,
  OpenAiCompatibleModel,
} from "../src/index.js";

interface CapturedRequest {
  readonly url: string;
  readonly headers: IncomingMessage["headers"];
  readonly body: string;
}

let server: Server;
let baseUrl: string;
const captured: CapturedRequest[] = [];
// Scripted replies: the handler pops the next behavior per request.
type Behavior =
  | { readonly kind: "json"; readonly status?: number; readonly body: unknown }
  | { readonly kind: "text"; readonly status?: number; readonly body: string }
  | { readonly kind: "hang" };
const behaviors: Behavior[] = [];

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
    });
    req.on("end", () => {
      captured.push({ url: req.url ?? "", headers: req.headers, body });
      const behavior = behaviors.shift() ?? { kind: "json", body: {} };
      if (behavior.kind === "hang") return; // never respond → client timeout
      res.statusCode = behavior.status ?? 200;
      res.setHeader("content-type", "application/json");
      res.end(behavior.kind === "json" ? JSON.stringify(behavior.body) : behavior.body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  baseUrl = `http://127.0.0.1:${String(address.port)}`;
});

afterAll(async () => {
  behaviors.length = 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function reply(behavior: Behavior): void {
  behaviors.push(behavior);
}

const REQUEST = {
  system: "system-instructions",
  messages: [{ role: "user" as const, content: "payload" }],
  maxTokens: 64,
  temperature: 0,
};

describe("OpenAI-compatible adapter", () => {
  it("posts chat/completions with the schema and parses content + usage", async () => {
    captured.length = 0;
    reply({
      kind: "json",
      body: {
        choices: [{ message: { content: '{"optionId":"if-chain"}' } }],
        usage: { prompt_tokens: 11, completion_tokens: 5 },
      },
    });
    const model = new OpenAiCompatibleModel({
      baseUrl,
      model: "gpt-test",
      apiKey: "test-key",
      timeoutMs: 5000,
    });
    const result = await model.complete({
      ...REQUEST,
      schema: { type: "object" },
    });
    expect(result.text).toBe('{"optionId":"if-chain"}');
    expect(result.usage).toEqual({ inputTokens: 11, outputTokens: 5, usd: null });
    expect(captured.length).toBe(1);
    expect(captured[0]!.url).toBe("/chat/completions");
    expect(captured[0]!.headers["authorization"]).toBe("Bearer test-key");
    const body = JSON.parse(captured[0]!.body) as Record<string, unknown>;
    expect(body["model"]).toBe("gpt-test");
    expect((body["messages"] as unknown[]).length).toBe(2);
    expect(body["response_format"]).toMatchObject({ type: "json_schema" });
  });

  it("maps HTTP failures, malformed JSON, and missing content to typed errors", async () => {
    const model = new OpenAiCompatibleModel({ baseUrl, model: "m", apiKey: "k", timeoutMs: 5000 });
    reply({ kind: "text", status: 500, body: "boom" });
    await expect(model.complete(REQUEST)).rejects.toMatchObject({ code: "AI-HTTP-ERROR" });
    reply({ kind: "text", status: 200, body: "not-json" });
    await expect(model.complete(REQUEST)).rejects.toMatchObject({ code: "AI-MALFORMED-RESPONSE" });
    reply({ kind: "json", body: { choices: [] } });
    await expect(model.complete(REQUEST)).rejects.toMatchObject({ code: "AI-MALFORMED-RESPONSE" });
  });

  it("bounds responses and times out hung requests", async () => {
    const model = new OpenAiCompatibleModel({ baseUrl, model: "m", apiKey: "k", timeoutMs: 300 });
    reply({ kind: "text", body: "x".repeat(MAX_RESPONSE_BYTES + 10) });
    await expect(model.complete(REQUEST)).rejects.toMatchObject({ code: "AI-OVERSIZED-RESPONSE" });
    reply({ kind: "hang" });
    await expect(model.complete(REQUEST)).rejects.toMatchObject({ code: "AI-TIMEOUT" });
  });

  it("honors caller cancellation via AbortSignal", async () => {
    const model = new OpenAiCompatibleModel({ baseUrl, model: "m", apiKey: "k", timeoutMs: 5000 });
    reply({ kind: "hang" });
    const controller = new AbortController();
    const promise = model.complete(REQUEST, controller.signal);
    setTimeout(() => controller.abort(), 20);
    await expect(promise).rejects.toBeInstanceOf(ChatError);
    await expect(promise).rejects.toMatchObject({ code: "AI-ABORTED" });
  });
});

describe("Anthropic adapter", () => {
  it("posts /v1/messages with system + usage parsing and schema instruction", async () => {
    captured.length = 0;
    reply({
      kind: "json",
      body: {
        content: [{ text: '{"optionId":"switch"}' }],
        usage: { input_tokens: 9, output_tokens: 3 },
      },
    });
    const model = new AnthropicModel({
      baseUrl,
      model: "claude-test",
      apiKey: "key-2",
      timeoutMs: 5000,
    });
    const result = await model.complete({ ...REQUEST, schema: { type: "object" } });
    expect(result.text).toBe('{"optionId":"switch"}');
    expect(result.usage).toEqual({ inputTokens: 9, outputTokens: 3, usd: null });
    expect(captured[0]!.url).toBe("/v1/messages");
    expect(captured[0]!.headers["x-api-key"]).toBe("key-2");
    const body = JSON.parse(captured[0]!.body) as Record<string, unknown>;
    expect(String(body["system"])).toContain("Respond with JSON");
    expect(body["max_tokens"]).toBe(64);
  });

  it("always sends max_tokens (API requirement) and surfaces malformed content", async () => {
    captured.length = 0;
    reply({ kind: "json", body: { content: [] } });
    const model = new AnthropicModel({ baseUrl, model: "c", apiKey: "k", timeoutMs: 5000 });
    await expect(model.complete({ messages: REQUEST.messages })).rejects.toMatchObject({
      code: "AI-MALFORMED-RESPONSE",
    });
    const body = JSON.parse(captured[0]!.body) as Record<string, unknown>;
    expect(typeof body["max_tokens"]).toBe("number");
  });
});

describe("custom endpoint adapter", () => {
  it("substitutes templates and extracts the configured response path", async () => {
    captured.length = 0;
    reply({ kind: "json", body: { result: { choice: "switch" } } });
    const model = new CustomEndpointModel({
      url: `${baseUrl}/custom`,
      model: "local-test",
      apiKey: "k",
      bodyTemplate: '{"sys": {{system}}, "input": {{user}}}',
      responsePath: "result.choice",
      timeoutMs: 5000,
    });
    const result = await model.complete(REQUEST);
    expect(result.text).toBe("switch");
    const body = JSON.parse(captured[0]!.body) as Record<string, unknown>;
    expect(body["sys"]).toBe("system-instructions");
    expect(body["input"]).toBe("payload");
  });

  it("rejects invalid templates and missing response paths", async () => {
    const badTemplate = new CustomEndpointModel({
      url: `${baseUrl}/custom`,
      model: "l",
      apiKey: "k",
      bodyTemplate: "not-json {{user}}",
    });
    await expect(badTemplate.complete(REQUEST)).rejects.toMatchObject({
      code: "AI-CUSTOM-TEMPLATE",
    });
    reply({ kind: "json", body: { other: 1 } });
    const missingPath = new CustomEndpointModel({
      url: `${baseUrl}/custom`,
      model: "l",
      apiKey: "k",
      bodyTemplate: '{"input": {{user}}}',
    });
    await expect(missingPath.complete(REQUEST)).rejects.toMatchObject({
      code: "AI-MALFORMED-RESPONSE",
    });
  });
});
