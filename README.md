# Code Translator

A behavior-preserving source-code translator for **Python ↔ JavaScript ↔ TypeScript**, designed to translate whole projects — not just snippets — with explicit, honest reporting of what was translated deterministically, what was adapted semantically, what was ambiguous, and what was not supported.

**Status: M6 complete — whole-project Python → TypeScript with sandboxed validation** (M5's registry/async/bigint/string semantics included). Whole projects translate end-to-end — including pytest test modules to vitest — and every run is validated in an isolated sandbox: the translated suite executes (S5) and the source suite runs in the same sandbox for a per-test differential comparison (S6), supporting claim-ladder level 5. Reverse directions are next; see [docs/roadmap.md](docs/roadmap.md) and [PROJECT_STATE.md](PROJECT_STATE.md).

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

Prerequisites: Node.js ≥ 22.12 with Corepack (the pnpm version is pinned via the `packageManager` field).

```bash
corepack enable        # first use of pnpm may ask to download the pinned version
pnpm install
pnpm verify            # typecheck → lint → format check → tests → documentation links
```
