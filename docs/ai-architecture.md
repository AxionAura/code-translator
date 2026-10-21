# AI Architecture

Status: port 1 (`resolveAmbiguity`), the secret gate, caps/cache/journal, and the pipeline/CLI integration are **implemented (M8)**; port 2 (`proposeRepairPatch`) is the M9 repair loop; `polishIdioms` stays deferred. Governing rules: AI is an *escalation resolver*, never the translation engine (AGENTS.md §9; OWASP LLM v2 mitigations apply).

## 0. Implementation status (M8, 2026-10-21)

`@ctrans/ai` implements the `ChatModel` contract from §2 with adapters for OpenAI-compatible endpoints (OpenAI, vLLM, llama.cpp server, Ollama's OpenAI endpoint, LM Studio via `baseUrl`), Anthropic Messages, and a user-templated custom endpoint; `FakeChatModel` is the only model the deterministic suites use. `AiAmbiguityResolver` implements the core `AmbiguityResolver` port: packer (§3) → secretlint hard gate → caps → cache → model → strict JSON option validation with ONE bounded re-ask → decision (`{optionId, escalation}`) or `null` (heuristic fallback). Escalation requests reach it only for constructs the ENGINE classified `ambiguous` with more than one emitted strategy — currently Python `match` with literal/capture cases (language-support §2.4: `if-chain` heuristic vs `switch`). The pipeline resolves ambiguities BEFORE lowering (translation stays synchronous/deterministic), validates the chosen id against the offered set (`validateAmbiguityDecision`), and records `candidates` + `escalation` in the ledger. CLI: `--ai-provider openai|anthropic`, `--ai-model`, `--ai-base-url`, key from `CTRANS_AI_KEY`; journal at `.ctrans/ai-journal.json`. Caps default to 20 calls / 50k tokens / 60 s per request / 300 s run. Providers report usage; USD caps enforce only when reported. See ADR D-025.

## 1. What AI is used for — exactly three ports

| Port | Trigger | Input | Output constraint |
| --- | --- | --- | --- |
| `resolveAmbiguity` | engine-classified `ambiguous` construct, heuristic default exists but alternatives matter | unit AST, direct-dep module contracts, construct span, **enumerated candidate options**, project constraints | must select one of the offered options (may not invent behavior); stored in ledger with prompt hash |
| `proposeRepairPatch` | validation failure after deterministic diagnosis | failing unit AST, dep contracts, diagnostic list, span→source mapping, prior repair history (for loop detection) | unified diff scoped to the failing unit; must apply cleanly; re-enters full validation |
| `polishIdioms` (optional, off by default) | explicit user request on an already-valid result | emitted unit + source | stylistic edits only; must re-pass S1–S3 and never alter ledger semantics |

Everything else — parsing, scopes, symbols, types, lowering, codegen, dependency resolution, validation verdicts — is deterministic and has no AI path. If a case has a deterministic strategy, using AI is a bug (AGENTS.md §10).

## 2. Provider independence

```ts
interface ChatModel {
  readonly id: string;                       // e.g. "anthropic:claude-…", "openai:gpt-…", "local:llama-…"
  complete(req: ChatRequest, signal?: AbortSignal): Promise<ChatResult>;
}
interface ChatRequest {
  system?: string;                           // our fixed instruction block (never user-authored)
  messages: ChatMessage[];                   // user content = code-as-data payloads (§4)
  schema?: JsonSchema;                       // structured output where supported
  maxTokens?: number; temperature?: number;
}
```

- Adapters (all behind this interface): **OpenAI-compatible** (`baseUrl` + key → covers OpenAI, vLLM, llama.cpp server, Ollama's OpenAI endpoint, LM Studio), **Anthropic**, **custom endpoint** (user-supplied request/response templates). No provider SDK types leak into engine code.
- Structured outputs: JSON-schema-constrained where the provider supports it; otherwise schema-checked with one bounded re-ask on malformed JSON. Two malformed responses = escalation failure → deterministic fallback.
- Model config is data: `ai: { enabled, provider: {kind, baseUrl?, model, keyRef}, caps }` in `ctrans.config.json`; `keyRef` points at keychain entry or env var — **keys never live in the config file** (security.md §4).
- Offline default: AI disabled ⇒ escalations emit heuristic default + `TODO(ctrans)` + warning. The pipeline's guarantees never depend on a provider being reachable.

## 3. Context packing (project-scale discipline)

Unlimited project context ≠ unlimited model context. Escalation payloads are assembled from:

1. The failing unit's AST (or emitted text for repair).
2. `ModuleContract`s of its direct dependencies (export signatures only).
3. Failure diagnostics with span→source mapping.
4. A budget: hard token cap per payload; overflow drops lowest-priority contracts first (farthest in topo order). The packer is deterministic and unit-tested with a fake tokenizer-like counter (no live calls).

Whole-project prompts are forbidden. If a fix needs more context than the budget allows, that is itself a diagnostic ("fix requires cross-unit change") and the repair loop escalates to a multi-unit plan — still per-unit patched.

## 4. Prompt-injection and data protection (OWASP LLM v2 mapping)

- **Code is data**: user source is embedded inside explicit data delimiters with a system instruction that content within delimiters is never instructions. Delimiters are content-derived (random nonce per request) so they cannot be forged by code comments.
- **LLM01 prompt injection**: model output is either an option-choice (enum-validated) or a patch (applied through the diff path after parse+type validation). No model output is ever interpreted as commands, file paths outside the patch, or config.
- **LLM02 sensitive disclosure**: pre-flight secret scan (embedded secretlint rules) is a hard gate before every request; failure blocks the call and reports findings. Source never leaves the machine otherwise.
- **LLM05 improper output handling**: all AI output re-enters the deterministic validation pipeline; validation verdicts are computed by the engine, never by the model.
- **LLM06 excessive agency**: `ChatModel.complete` is the only capability an adapter has — no tools, no function-calling, no execution.
- **LLM10 unbounded consumption**: caps enforced in code — `maxCallsPerRun`, `maxTokensPerRun`, `maxUsdPerRun` (when usage is reported), per-request timeout, global wall-clock. Exceeding a cap degrades to deterministic fallback, never aborts the run.

## 5. Caching, cost, determinism

- Response cache keyed by (model id, prompt hash, params): identical escalations within/across runs are free.
- All AI interactions are journaled (prompt hash, not full prompt, to avoid storing user code; full prompt optionally kept with explicit `--journal-prompts`).
- Benchmarks and fixture CI never enable AI (`deterministic CI` rule) — AI-assisted runs are measured separately and reported as such.

## 6. Testing the AI layer without AI

- `FakeChatModel` implements `ChatModel` with scripted responses (successes, malformed JSON, injection attempts, budget exhaustion). All engine-side logic (packing, caps, cache, validation-after-AI, repair-loop bookkeeping) is tested against fakes only.
- Live-provider smoke tests exist behind an explicit env flag and are never part of default CI.
