# Code Translator

A behavior-preserving source-code translator for **Python ↔ JavaScript ↔ TypeScript**, designed to translate whole projects — not just snippets — with explicit, honest reporting of what was translated deterministically, what was adapted semantically, what was ambiguous, and what was not supported.

**Status: M9 complete — bounded repair loop live.** Six translation directions (M7), whole-project Python → TypeScript with sandboxed validation to claim level 5 (M6), the provider-agnostic AI layer (M8), and now a bounded, observable repair loop over the SAME model/secret-gate/caps/cache stack (M9): failures are classified, one unit gets a strict unified-diff proposal, the engine re-runs the real validators, and only a monotone claim improvement is accepted (otherwise the baseline is restored exactly). History is hash-only under `.ctrans/repairs/`. AI stays off by default. See [docs/roadmap.md](docs/roadmap.md) and [PROJECT_STATE.md](PROJECT_STATE.md).

## Quickstart

```bash
corepack enable && pnpm install

# Analyze + validate a Python file without writing output (exit 0 = translated)
node apps/cli/bin/ctrans.mjs check sample.py --to ts

# Translate a file or a whole project directory (writes target files + .ctrans/ artifacts)
node apps/cli/bin/ctrans.mjs translate sample.py --to ts -o out/
node apps/cli/bin/ctrans.mjs translate my-project/ --to js -o out-js/

# Translate a whole project INCLUDING its pytest test modules (→ vitest) and validate
# it in the sandbox: translated tests run (S5), source tests run sandboxed and are
# compared per-test against the target outcomes (S6 → claim level 5)
node apps/cli/bin/ctrans.mjs project my-project/ --to ts -o out/

# Reverse directions: JS/TS → Python, TS → JS, JS → TS (direction from the source)
node apps/cli/bin/ctrans.mjs translate web-src/ --to py -o out-py/   # S1 bridge + S2 pyright + S3
node apps/cli/bin/ctrans.mjs translate legacy.ts --to js -o out-js/  # type erasure
node apps/cli/bin/ctrans.mjs translate app.js --to ts -o out-ts/     # honest unknown types

# Optional AI escalation (OFF by default): let a model choose among the options the
# engine already offers for AMBIGUOUS constructs (never anything else). A secretlint
# scan gates every request; caps + cache + journal are enforced; the heuristic default
# applies when the provider is unavailable or the answer is not an offered option.
CTRANS_AI_KEY=... node apps/cli/bin/ctrans.mjs check mod.py --to ts \
  --ai-provider openai --ai-model gpt-4o-mini   # or --ai-provider anthropic

# M9: bounded repair after translation (translate only). The model may propose ONE
# unit-scoped unified diff per attempt (3/unit, 8/run); the engine re-runs the same
# S1–S3 validators and accepts only a strictly higher claim level with no passing
# stage regressed. Rejected patches are discarded exactly; the journal records hashes
# only. Without --ai-provider the run reports `repair-unavailable` and writes the
# deterministic output unchanged.
CTRANS_AI_KEY=... node apps/cli/bin/ctrans.mjs translate mod.py --to ts -o out/ \
  --ai-provider openai --repair
```

The CLI prints the claim-ladder level (what validation actually proved), per-file status, and decision counts. Translated output is finalized through Prettier; runtime helpers land in a generated `__ctrans_runtime.ts|js` that carries **zero** dependencies.

## Documentation index

| Document | Purpose |
| --- | --- |
| [PROJECT_STATE.md](PROJECT_STATE.md) | **Canonical handoff state** — current status, milestone, what works/doesn't; read this first for progress |
| [docs/research.md](docs/research.md) | Verified technology survey: parsers, prior art, semantics, security (researched 2026-10-06) |
| [docs/architecture.md](docs/architecture.md) | System architecture, package layout, core data model |
| [docs/translation-pipeline.md](docs/translation-pipeline.md) | Stage-by-stage pipeline, artifacts, decision ledger |
| [docs/language-support.md](docs/language-support.md) | Semantic differences between the three languages; support matrix |
| [docs/dependency-mapping.md](docs/dependency-mapping.md) | Stdlib/third-party/test-framework mapping architecture |
| [docs/ai-architecture.md](docs/ai-architecture.md) | Where AI is used, provider-independent model layer |
| [docs/validation.md](docs/validation.md) | Validation pipeline, capability reporting, differential testing |
| [docs/security.md](docs/security.md) | Threat model, sandboxing, secret handling |
| [docs/testing.md](docs/testing.md) | Test strategy and fixture system (`input/` vs `expected/`) |
| [docs/benchmarks.md](docs/benchmarks.md) | Benchmark framework and metrics |
| [docs/decisions.md](docs/decisions.md) | Architecture decision records (ADR log) |
| [docs/roadmap.md](docs/roadmap.md) | Milestone plan M0–M11 with completion criteria |
| [AGENTS.md](AGENTS.md) | Engineering rules — read before modifying this repository |

## Core principles

1. **Deterministic first.** AI is an optional resolver for ambiguous cases, never the translation engine.
2. **Never claim correctness that was not validated.** Every validation stage reports `pass / fail / skipped(reason)`.
3. **Every emitted construct carries provenance** via a decision ledger: deterministic, semantic, ambiguous, or unsupported.
4. **Local-first.** Source code never leaves the machine unless the user explicitly enables an AI provider.
5. **Zero runtime dependencies in generated output.** Translated projects are self-contained.

## Development

Prerequisites: Node.js ≥ 22.18 with Corepack (the pnpm version is pinned via the `packageManager` field).

```bash
corepack enable        # first use of pnpm may ask to download the pinned version
pnpm install
pnpm verify            # typecheck → lint → format check → tests → documentation links
```
