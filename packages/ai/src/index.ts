// Responsibility (docs/architecture.md section 3): the optional, provider-agnostic
// AI escalation layer (M8). Exactly the ports of docs/ai-architecture.md §1:
// `AmbiguityResolver` (implemented here) and — M9 — the repair-patch port. No
// provider SDK types, no tools, no execution.
export {
  ChatError,
  chatError,
  providerAndModel,
  type ChatMessage,
  type ChatModel,
  type ChatRequest,
  type ChatResult,
  type ChatUsage,
  type JsonSchema,
} from "./types.js";
export { FakeChatModel, type FakeReply } from "./fake.js";
export {
  AnthropicModel,
  CustomEndpointModel,
  OpenAiCompatibleModel,
  MAX_RESPONSE_BYTES,
  type CustomEndpointOptions,
} from "./adapters.js";
export {
  AiBudget,
  DEFAULT_AI_CAPS,
  estimateTokens,
  type AiCaps,
  type BudgetDenial,
  type BudgetState,
} from "./budget.js";
export { ResponseCache, canonicalRequest, hashText, type CacheStats } from "./cache.js";
export {
  SecretlintGate,
  type GateOutcome,
  type SecretFinding,
  type SecretGate,
} from "./secret-gate.js";
export { packAmbiguityPrompt, type PackOptions, type PackedPrompt } from "./packer.js";
export { AiJournal, type JournalEntry, type JournalOutcome } from "./journal.js";
export { AiAmbiguityResolver, parseOptionId, type AiResolverOptions } from "./resolver.js";
export const packageName = "@ctrans/ai";
