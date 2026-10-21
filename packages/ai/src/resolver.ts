// The ambiguity resolver (docs/ai-architecture.md §1 port 1): gate → budget →
// cache → model → strict validation (one bounded re-ask on malformed JSON). Any
// failure returns null so the engine keeps the deterministic heuristic default.
// The model may ONLY select an offered option id; everything else is rejected.
import {
  type AmbiguityDecision,
  type AmbiguityRequest,
  type AmbiguityResolver,
  type LedgerEscalation,
} from "@ctrans/core";

import { AiBudget, estimateTokens, type AiCaps } from "./budget.js";
import { ResponseCache } from "./cache.js";
import { AiJournal, type JournalOutcome } from "./journal.js";
import { packAmbiguityPrompt, type PackOptions } from "./packer.js";
import { SecretlintGate, type SecretGate } from "./secret-gate.js";
import { providerAndModel, type ChatModel, type ChatRequest, type ChatUsage } from "./types.js";

export interface AiResolverOptions {
  readonly model: ChatModel;
  readonly caps?: Partial<AiCaps>;
  // Defaults to the secretlint preset gate (fail-closed).
  readonly gate?: SecretGate;
  readonly cache?: ResponseCache;
  readonly journal?: AiJournal;
  readonly pack?: PackOptions;
  // Test seam for deterministic durations; production omits it.
  readonly clock?: () => number;
}

export class AiAmbiguityResolver implements AmbiguityResolver {
  private readonly model: ChatModel;
  private readonly gate: SecretGate;
  private readonly cache: ResponseCache;
  private readonly journal: AiJournal;
  private readonly budget: AiBudget;
  private readonly packOptions: PackOptions;

  constructor(options: AiResolverOptions) {
    this.model = options.model;
    this.gate = options.gate ?? new SecretlintGate();
    this.cache = options.cache ?? new ResponseCache();
    this.journal = options.journal ?? new AiJournal();
    this.budget = new AiBudget(options.caps ?? {}, options.clock);
    this.packOptions = options.pack ?? {};
  }

  journalEntries(): ReturnType<AiJournal["entriesView"]> {
    return this.journal.entriesView();
  }

  budgetState(): ReturnType<AiBudget["state"]> {
    return this.budget.state();
  }

  cacheStats(): ReturnType<ResponseCache["stats"]> {
    return this.cache.stats();
  }

  async resolve(
    request: AmbiguityRequest,
    signal?: AbortSignal,
  ): Promise<AmbiguityDecision | null> {
    const packed = packAmbiguityPrompt(request, this.packOptions);
    if (packed === null) {
      this.record(request, "packet-too-large", null, "construct does not fit the input budget");
      return null;
    }
    // Hard gate: scan the EXACT outgoing payload (system + user) before any call.
    const gateResult = await this.gate.scan(`${packed.system}\n\n${packed.user}`);
    if (gateResult.blocked) {
      this.record(
        request,
        "blocked-secret",
        null,
        gateResult.reason,
        gateResult.findings.map((finding) => finding.ruleId),
      );
      return null;
    }
    const chatRequest: ChatRequest = {
      system: packed.system,
      messages: [{ role: "user", content: packed.user }],
      schema: packed.schema,
      maxTokens: 128,
      temperature: 0,
    };
    const cacheKey = this.cache.key(this.model.id, chatRequest);
    const cached = this.cache.get(cacheKey);
    if (cached !== undefined) {
      const optionId = parseOptionId(cached.text);
      if (optionId !== null && isOffered(request, optionId)) {
        this.record(request, "cache-hit", optionId, null);
        return this.decision(request, optionId, packed.promptHash);
      }
      // A cached invalid answer is ignored (never trusted).
    }
    const admission = this.budget.tryAcquire(packed.estimatedInputTokens);
    if (!admission.ok) {
      this.record(request, "cap-exhausted", null, `cap exceeded: ${admission.reason}`);
      return null;
    }
    const startedAt = this.journal.now();
    let result: { text: string; usage: ChatUsage | null };
    try {
      result = await this.model.complete(chatRequest, signal);
    } catch (error) {
      this.record(
        request,
        "provider-error",
        null,
        error instanceof Error ? error.message.slice(0, 200) : String(error),
        [],
        this.journal.elapsed(startedAt),
      );
      return null;
    }
    this.budget.record(result.usage);
    if (this.budget.usdExceeded()) {
      this.record(
        request,
        "cap-exhausted",
        null,
        "usd cap exceeded",
        [],
        this.journal.elapsed(startedAt),
      );
      return null;
    }
    const first = parseOptionId(result.text);
    if (first !== null && isOffered(request, first)) {
      this.cache.set(cacheKey, result);
      this.record(
        request,
        "resolved",
        first,
        null,
        [],
        this.journal.elapsed(startedAt),
        result.usage,
      );
      return this.decision(request, first, packed.promptHash);
    }
    // ONE bounded re-ask on malformed output or an unoffered option.
    const reaskRequest: ChatRequest = {
      system: packed.system,
      messages: [
        { role: "user", content: packed.user },
        { role: "assistant", content: result.text.slice(0, 500) },
        {
          role: "user",
          content: `Your answer was invalid. Reply with JSON only: {"optionId": "<one of: ${request.options
            .map((option) => option.id)
            .join(", ")}>"}.`,
        },
      ],
      schema: packed.schema,
      maxTokens: 128,
      temperature: 0,
    };
    // The re-ask payload contains the model's own text — it must pass the gate too.
    const reaskGate = await this.gate.scan(
      `${reaskRequest.system ?? ""}\n\n${reaskRequest.messages.map((message) => message.content).join("\n")}`,
    );
    if (reaskGate.blocked) {
      this.record(
        request,
        "blocked-secret",
        null,
        `re-ask payload blocked: ${reaskGate.reason}`,
        reaskGate.findings.map((finding) => finding.ruleId),
      );
      return null;
    }
    const reaskAdmission = this.budget.tryAcquire(
      estimateTokens(reaskRequest.messages.map((message) => message.content).join("\n")),
    );
    if (!reaskAdmission.ok) {
      this.record(
        request,
        "cap-exhausted",
        null,
        `cap exceeded on re-ask: ${reaskAdmission.reason}`,
      );
      return null;
    }
    let reaskResult: { text: string; usage: ChatUsage | null };
    try {
      reaskResult = await this.model.complete(reaskRequest, signal);
    } catch (error) {
      this.record(
        request,
        "provider-error",
        null,
        error instanceof Error ? error.message.slice(0, 200) : String(error),
        [],
        this.journal.elapsed(startedAt),
      );
      return null;
    }
    this.budget.record(reaskResult.usage);
    const second = parseOptionId(reaskResult.text);
    if (second !== null && isOffered(request, second)) {
      this.record(
        request,
        "resolved-after-reask",
        second,
        null,
        [],
        this.journal.elapsed(startedAt),
        reaskResult.usage,
      );
      return this.decision(request, second, packed.promptHash);
    }
    this.record(
      request,
      "invalid-output",
      null,
      "model returned no offered option after one re-ask",
      [],
      this.journal.elapsed(startedAt),
      reaskResult.usage,
    );
    return null;
  }

  private decision(
    request: AmbiguityRequest,
    optionId: string,
    promptHash: string,
  ): AmbiguityDecision {
    void request;
    const { provider, model } = providerAndModel(this.model.id);
    const escalation: LedgerEscalation = { provider, model, promptHash };
    return { optionId, escalation };
  }

  private record(
    request: AmbiguityRequest,
    outcome: JournalOutcome,
    optionId: string | null,
    reason: string | null,
    secretRuleIds: readonly string[] = [],
    durationMs: number | null = null,
    usage: ChatUsage | null = null,
  ): void {
    const { provider, model } = providerAndModel(this.model.id);
    this.journal.record({
      unit: request.unit,
      rule: request.rule,
      provider,
      model,
      promptHash: null,
      outcome,
      optionId,
      reason,
      ...AiJournal.usageFields(usage),
      durationMs,
      secretRuleIds,
    });
  }
}

// Strict parse: the answer must be a JSON object with a string optionId. Fenced
// markdown is tolerated (models habitually wrap JSON) but nothing else is.
export function parseOptionId(text: string): string | null {
  const trimmed = text.trim();
  const candidate = trimmed.startsWith("```")
    ? trimmed.replace(/^```[a-zA-Z]*\n?/, "").replace(/```\s*$/, "")
    : trimmed;
  try {
    const parsed = JSON.parse(candidate) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const optionId = (parsed as Record<string, unknown>)["optionId"];
    return typeof optionId === "string" ? optionId : null;
  } catch {
    return null;
  }
}

function isOffered(request: AmbiguityRequest, optionId: string): boolean {
  return request.options.some((option) => option.id === optionId);
}
