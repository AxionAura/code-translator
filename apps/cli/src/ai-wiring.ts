// CLI wiring for the optional AI layer (M8). AI stays OFF by default; flags opt in
// with provider configuration, and the API key comes from the environment only
// (`CTRANS_AI_KEY`) — never from flags, config files, or the repository
// (docs/security.md §4, ADR D-025).
import { CTransError } from "@ctrans/core";
import {
  AiAmbiguityResolver,
  AiJournal,
  AnthropicModel,
  OpenAiCompatibleModel,
  type AiCaps,
  type ChatModel,
} from "@ctrans/ai";
import { AiRepairProposer } from "@ctrans/repair";

export interface AiFlags {
  // "openai" (OpenAI-compatible: OpenAI, vLLM, llama.cpp server, Ollama) or
  // "anthropic". Absent = AI disabled (the default).
  readonly provider?: string;
  readonly model?: string;
  readonly baseUrl?: string;
  // Test seam: a scripted model bypasses provider construction and the key.
  readonly modelFactory?: (provider: string, model: string, baseUrl: string) => ChatModel;
}

export interface AiWiring {
  readonly resolver: AiAmbiguityResolver;
  // M9: the repair proposer shares the SAME model, caps, gate, and cache stack as
  // ambiguity resolution — there is no second client implementation.
  readonly repairProposer: AiRepairProposer;
  readonly journal: AiJournal;
  readonly provider: string;
  readonly model: string;
}

const DEFAULT_MODELS: Readonly<Record<string, string>> = {
  openai: "gpt-4o-mini",
  anthropic: "claude-3-5-haiku-latest",
};

const DEFAULT_BASE_URLS: Readonly<Record<string, string>> = {
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com",
};

// Build the resolver from CLI flags. Throws typed errors for missing
// configuration; AI configuration problems never silently disable a requested
// feature (the CLI reports the error and exits).
export function buildAiWiring(flags: AiFlags, caps?: Partial<AiCaps>): AiWiring | null {
  if (flags.provider === undefined) return null;
  const provider = flags.provider;
  const model = flags.model ?? DEFAULT_MODELS[provider];
  if (model === undefined) {
    throw new CTransError(
      "AI-PROVIDER-UNKNOWN",
      `unknown AI provider "${provider}" (supported: ${Object.keys(DEFAULT_MODELS).join(", ")})`,
    );
  }
  const baseUrl = flags.baseUrl ?? DEFAULT_BASE_URLS[provider] ?? "";
  if (flags.modelFactory !== undefined) {
    const scripted = flags.modelFactory(provider, model, baseUrl);
    const journal = new AiJournal();
    return {
      resolver: new AiAmbiguityResolver({
        model: scripted,
        journal,
        ...(caps === undefined ? {} : { caps }),
      }),
      repairProposer: new AiRepairProposer({
        model: scripted,
        ...(caps === undefined ? {} : { caps }),
      }),
      journal,
      provider,
      model,
    };
  }
  const apiKey = process.env["CTRANS_AI_KEY"];
  if (apiKey === undefined || apiKey === "") {
    throw new CTransError(
      "AI-KEY-MISSING",
      "AI provider selected but no key is configured — set CTRANS_AI_KEY in the environment",
    );
  }
  const modelAdapter =
    provider === "anthropic"
      ? new AnthropicModel({ baseUrl, model, apiKey })
      : provider === "openai"
        ? new OpenAiCompatibleModel({ baseUrl, model, apiKey })
        : (() => {
            throw new CTransError(
              "AI-PROVIDER-UNKNOWN",
              `unsupported AI provider "${provider}" (supported: openai, anthropic)`,
            );
          })();
  const journal = new AiJournal();
  return {
    resolver: new AiAmbiguityResolver({
      model: modelAdapter,
      journal,
      ...(caps === undefined ? {} : { caps }),
    }),
    repairProposer: new AiRepairProposer({
      model: modelAdapter,
      ...(caps === undefined ? {} : { caps }),
    }),
    journal,
    provider,
    model,
  };
}

// One-line summary of AI activity for the CLI output (deterministic counts).
export function summarizeAiJournal(journal: AiJournal): string {
  const entries = journal.entriesView();
  if (entries.length === 0) return "ai: no escalations";
  const counts = new Map<string, number>();
  for (const entry of entries) {
    counts.set(entry.outcome, (counts.get(entry.outcome) ?? 0) + 1);
  }
  const parts = [...counts.entries()]
    .sort(([left], [right]) => (left < right ? -1 : 1))
    .map(([outcome, count]) => `${outcome}: ${String(count)}`);
  return `ai escalations: ${String(entries.length)} (${parts.join(", ")})`;
}
