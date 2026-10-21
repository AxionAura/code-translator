// Resource caps (docs/ai-architecture.md §4, OWASP LLM10): enforced in code, not
// prompts. Exhaustion degrades to the deterministic fallback — it never aborts
// the run and never silently continues spending.
import type { ChatUsage } from "./types.js";

export interface AiCaps {
  readonly maxCallsPerRun: number;
  // Input+output tokens per run (reported usage, else the deterministic estimate).
  readonly maxTokensPerRun: number;
  // Enforced only when the provider reports cost; null = not enforced.
  readonly maxUsdPerRun: number | null;
  readonly perRequestTimeoutMs: number;
  readonly maxRunWallClockMs: number;
}

export const DEFAULT_AI_CAPS: AiCaps = {
  maxCallsPerRun: 20,
  maxTokensPerRun: 50000,
  maxUsdPerRun: null,
  perRequestTimeoutMs: 60000,
  maxRunWallClockMs: 300000,
};

export type BudgetDenial = "calls" | "tokens" | "usd" | "wall-clock";

export interface BudgetState {
  readonly calls: number;
  readonly tokens: number;
  readonly usd: number;
  readonly elapsedMs: number;
}

// Deterministic token estimate (no tokenizer dependency): ~4 chars per token.
// Documented and stable so budget tests pin exact numbers.
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export class AiBudget {
  private readonly caps: AiCaps;
  private readonly clock: () => number;
  private readonly startedAt: number;
  private calls = 0;
  private tokens = 0;
  private usd = 0;

  constructor(caps: Partial<AiCaps> = {}, clock: () => number = () => performance.now()) {
    this.caps = { ...DEFAULT_AI_CAPS, ...caps };
    this.clock = clock;
    this.startedAt = clock();
  }

  // Reserve one call with an estimated token cost. Denial leaves the budget
  // untouched (a blocked call is not charged).
  tryAcquire(
    estimatedInputTokens: number,
  ): { readonly ok: true } | { readonly ok: false; readonly reason: BudgetDenial } {
    const elapsedMs = this.clock() - this.startedAt;
    if (elapsedMs > this.caps.maxRunWallClockMs) {
      return { ok: false, reason: "wall-clock" };
    }
    if (this.calls >= this.caps.maxCallsPerRun) {
      return { ok: false, reason: "calls" };
    }
    if (this.tokens + estimatedInputTokens > this.caps.maxTokensPerRun) {
      return { ok: false, reason: "tokens" };
    }
    this.calls += 1;
    this.tokens += estimatedInputTokens;
    return { ok: true };
  }

  // Reconcile with reported usage after the call (never below the estimate).
  record(usage: ChatUsage | null): void {
    if (usage === null) return;
    const reported = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
    if (reported > 0) this.tokens += reported;
    if (usage.usd !== null) this.usd += usage.usd;
  }

  // Whether a reported cost would exceed the cap (checked after each call).
  usdExceeded(): boolean {
    return this.caps.maxUsdPerRun !== null && this.usd > this.caps.maxUsdPerRun;
  }

  state(): BudgetState {
    return {
      calls: this.calls,
      tokens: this.tokens,
      usd: this.usd,
      elapsedMs: this.clock() - this.startedAt,
    };
  }

  capsView(): AiCaps {
    return this.caps;
  }
}
