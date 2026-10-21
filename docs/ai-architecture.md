# AI Architecture

Status: port 1 (`resolveAmbiguity`), port 2 (`proposeRepairPatch`), the secret gate, caps/cache/journals, and the pipeline/CLI integrations are **implemented (M8/M9)**; `polishIdioms` stays deferred. Governing rules: AI is an *escalation resolver*, never the translation engine (AGENTS.md §9; OWASP LLM v2 mitigations apply).

## 0. Implementation status (M9, 2026-10-21)

**Port 1 — implemented (M8).** `@ctrans/ai` implements the `ChatModel` contract from §2 with adapters for OpenAI-compatible endpoints (OpenAI, vLLM, llama.cpp server, Ollama's OpenAI endpoint, LM Studio via `baseUrl`), Anthropic Messages, and a user-templated custom endpoint; `FakeChatModel` is the only model the deterministic suites use. `AiAmbiguityResolver` implements the core `AmbiguityResolver` port: packer (§3) → secretlint hard gate → caps → cache → model → strict JSON option validation with ONE bounded re-ask → decision (`{optionId, escalation}`) or `null` (heuristic fallback). Escalation requests reach it only for constructs the ENGINE classified `ambiguous` with more than one emitted strategy — currently Python `match` with literal/capture cases (language-support §2.4: `if-chain` heuristic vs `switch`). The pipeline resolves ambiguities BEFORE lowering (translation stays synchronous/deterministic), validates the chosen id against the offered set (`validateAmbiguityDecision`), and records `candidates` + `escalation` in the ledger. CLI: `--ai-provider openai|anthropic`, `--ai-model`, `--ai-base-url`, key from `CTRANS_AI_KEY`; journal at `.ctrans/ai-journal.json`. Caps default to 20 calls / 50k tokens / 60 s per request / 300 s run.

**Port 2 — implemented (M9).** `@ctrans/repair` classifies failed validation stages (validation.md §8), scopes one unit, and asks `AiRepairProposer` for a unified diff. The proposer reuses the **same** M8 stack (`ChatModel`, secret gate on every payload including the re-ask, `AiBudget` shared across the whole repair run, `ResponseCache`, typed `ChatError` handling) — there is no second model client. Reply shape is strict JSON `{unit, diff, rationale}`; `unit` must equal the requested unit; `rationale` ≤ 2000 chars; diff ≤ 64 KiB; the diff must parse under the restricted grammar (no binary/rename/new-file/combined diffs, `---`/`+++` headers only for the scoped target, content-exact old lines with patch(1)-style offset tolerance) and must pass the policy guard (no added `@ts-ignore`/`@ts-nocheck`/`@ts-expect-error`, `declare module/global`, lint/coverage suppression, or test `.skip`/`.only`). `""` is an explicit decline. One bounded re-ask carries the rejection reason (re-scanned by the gate), then the outcome is typed (`declined`, `invalid-output`, `provider-error`, `cap-exhausted`, `packet-too-large`, `blocked-secret`). The orchestrator owns the bounds: 3 attempts/unit, 8/run, duplicate-patch rejection, state-hash loop detection, monotone acceptance with strictly higher claim level, and exact rollback. History is hash-only at `.ctrans/repairs/repairs.json`. CLI: `translate --repair` (AI optional; disabled ⇒ `repair-unavailable` with the deterministic output untouched). See ADR D-026.

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

Whole-project prompts are forbidden. If a fix needs more context than the budget allows, that is itself a diagnostic ("fix requires cross-unit change"). M9 patches are strictly **single-unit**: a patch can change one emitted file only, and cross-unit repairs are out of scope (reported as no eligible repair or patch rejection, never approximated by editing other files).

## 4. Prompt-injection and data protection (OWASP LLM v2 mapping)

- **Code is data**: user source is embedded inside explicit data delimiters with a system instruction that content within delimiters is never instructions. Delimiters are content-derived (random nonce per request) so they cannot be forged by code comments.
- **LLM01 prompt injection**: model output is either an option-choice (enum-validated) or a patch (applied through the diff path after parse+type validation). No model output is ever interpreted as commands, file paths outside the patch, or config.
- **LLM02 sensitive disclosure**: pre-flight secret scan (embedded secretlint rules) is a hard gate before every request; failure blocks the call and reports findings. Source never leaves the machine otherwise.
- **LLM05 improper output handling**: all AI output re-enters the deterministic validation pipeline; validation verdicts are computed by the engine, never by the model.
- **LLM06 excessive agency**: `ChatModel.complete` is the only capability an adapter has — no tools, no function-calling, no execution.
- **LLM10 unbounded consumption**: caps enforced in code — `maxCallsPerRun`, `maxTokensPerRun`, `maxUsdPerRun` (when usage is reported), per-request timeout, global wall-clock. Exceeding a cap degrades to deterministic fallback, never aborts the run.

## 5. Caching, cost, determinism

- Response cache keyed by (model id, prompt hash, params): identical escalations are free within a run (in-memory default). M11 adds an **opt-in** cross-run file cache (`--ai-cache disk` / `ai.cache: "disk"`): per-user `0700` directory, `0600` files named by sha256 key, symlink/oversize/malformed entries ignored, atomic writes, and pruning beyond 2000 entries. It is opt-in because cached model text may contain code-derived content.
- Key resolution (M11): `CTRANS_AI_KEY` → OS keychain (`security`/`secret-tool`) → 0600 `~/.config/ctrans/keys.json` with a warning; insecure permissions and symlinks are rejected. Keychain retrieval is not exercised against a live credential in this environment; Windows CredMan is not implemented (documented).
- All AI interactions are journaled by prompt hash, never full prompt text: `.ctrans/ai-journal.json` for ambiguity escalations and the hash-only `.ctrans/repairs/repairs.json` for repair attempts (no diffs, responses, or source content). Full-prompt journaling is not implemented.
- Benchmarks and fixture CI never enable AI (`deterministic CI` rule) — AI-assisted runs are measured separately and reported as such.

## 6. Testing the AI layer without AI

- `FakeChatModel` implements `ChatModel` with scripted responses (successes, malformed JSON, injection attempts, budget exhaustion). All engine-side logic (packing, caps, cache, validation-after-AI, repair-loop bookkeeping) is tested against fakes only.
- Live-provider smoke tests exist behind an explicit env flag and are never part of default CI.

## 7. Repair loop guarantees and limits (M9)

- **Provenance:** a repair patch is never a new source of truth — it is a candidate file map that must pass the real validators again. The Transformation Ledger is not rewritten by a repair; the unit's emitted text changes, its ledger entries remain the deterministic engine's provenance. (Repairing a construct the ledger classifies `unsupported` is refused outright.)
- **Acceptance is necessary, not sufficient:** the guard proves no previously passing stage regressed and the claim level strictly improved. It cannot prove semantic equivalence of added/removed code — S5/S6 remain the only behavioral evidence. A patch that makes types pass by deleting behavior can still satisfy S1–S3; this is why project-mode repair (S5/S6 re-validation) is deferred rather than approximated.
- **No test/config edits:** test modules, generated shared artifacts (no source text), and any path outside the unit's emitted target are not patchable. The policy guard rejects suppression constructs.
- **Budgets:** one `AiBudget` per proposer (= per run) governs calls/tokens/wall-clock; the orchestrator caps attempts centrally. Replays of identical requests are served from the response cache and re-validated.
- **Failure is degrading, never fatal:** AI disabled, gate-blocked, provider errors, declines, caps, oversized packets, and invalid output all leave the deterministic output untouched and are reported with typed outcomes/stop reasons.
