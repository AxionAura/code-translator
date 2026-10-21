// Deterministic response cache (docs/ai-architecture.md §5): keyed by model id +
// the canonical prompt + parameters. Cache values hold only the model's text and
// usage — never credentials, never the prompt (the prompt lives in the journal by
// hash only unless full-prompt journaling is explicitly enabled).
import { createHash } from "node:crypto";

import type { ChatRequest, ChatResult } from "./types.js";

export function canonicalRequest(modelId: string, request: ChatRequest): string {
  return JSON.stringify({
    v: 1,
    model: modelId,
    system: request.system ?? "",
    messages: request.messages.map((message) => [message.role, message.content]),
    schema: request.schema ?? null,
    maxTokens: request.maxTokens ?? null,
    temperature: request.temperature ?? null,
  });
}

export function hashText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export interface CacheStats {
  readonly hits: number;
  readonly misses: number;
}

export class ResponseCache {
  private readonly entries = new Map<string, ChatResult>();
  private hits = 0;
  private misses = 0;

  key(modelId: string, request: ChatRequest): string {
    return hashText(canonicalRequest(modelId, request));
  }

  get(key: string): ChatResult | undefined {
    const hit = this.entries.get(key);
    if (hit === undefined) {
      this.misses += 1;
      return undefined;
    }
    this.hits += 1;
    return hit;
  }

  set(key: string, result: ChatResult): void {
    this.entries.set(key, result);
  }

  stats(): CacheStats {
    return { hits: this.hits, misses: this.misses };
  }

  size(): number {
    return this.entries.size;
  }
}
