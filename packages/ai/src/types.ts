// Provider-agnostic model transport (docs/ai-architecture.md §2, ADR D-010/D-025).
// The ONLY capability an adapter has is `complete()` — no tools, no function
// calling, no execution (OWASP LLM06 mitigation). Provider specifics stay inside
// adapters; engine code only sees this interface.
import { CTransError } from "@ctrans/core";

export interface ChatMessage {
  readonly role: "user" | "assistant";
  readonly content: string;
}

// Minimal JSON-schema shape handed to adapters that support structured output.
// Adapters that cannot enforce it fall back to schema-checking the text.
export type JsonSchema = Readonly<Record<string, unknown>>;

export interface ChatRequest {
  // Our fixed instruction block — never user-authored content.
  readonly system?: string;
  readonly messages: readonly ChatMessage[];
  readonly schema?: JsonSchema;
  readonly maxTokens?: number;
  readonly temperature?: number;
}

export interface ChatUsage {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  // Provider-reported cost when available; null otherwise (caps only enforce it
  // when reported).
  readonly usd: number | null;
}

export interface ChatResult {
  readonly text: string;
  readonly usage: ChatUsage | null;
}

export interface ChatModel {
  // "provider:model" — e.g. "openai:gpt-x", "anthropic:claude-x", "fake:scripted".
  readonly id: string;
  complete(request: ChatRequest, signal?: AbortSignal): Promise<ChatResult>;
}

// Typed transport failures: every adapter maps its errors into this taxonomy so
// callers can degrade deterministically (never a bare throw).
export class ChatError extends CTransError {}

export function chatError(code: string, message: string, cause?: unknown): ChatError {
  return new ChatError(code, message, cause === undefined ? undefined : { cause });
}

export function providerAndModel(modelId: string): { provider: string; model: string } {
  const separator = modelId.indexOf(":");
  if (separator <= 0) return { provider: modelId, model: modelId };
  return { provider: modelId.slice(0, separator), model: modelId.slice(separator + 1) };
}
