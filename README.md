# Code Translator

[![npm](https://img.shields.io/npm/v/@axion-ct/cli.svg)](https://www.npmjs.com/package/@axion-ct/cli)
[![CI](https://github.com/AxionAura/code-translator/actions/workflows/ci.yml/badge.svg)](https://github.com/AxionAura/code-translator/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A deterministic source-code translator for **Python ↔ JavaScript ↔ TypeScript** that works on whole projects and reports honestly what it did: every translated construct carries provenance, and every validation claim reflects evidence that was actually obtained.

Most translators promise fidelity and deliver silence. Code Translator is built on the opposite premise — a compiler pipeline (parse → semantic analysis → module graph → lowering → code generation → validation) with a **decision ledger** that classifies each construct as `deterministic`, `semantic`, `ambiguous`, or `unsupported`, and a **claim ladder** that reports exactly which validation stages ran and passed. AI is available, off by default, and only ever chooses among options the engine itself offered.

> **Release status:** v0.1.2 is published on npm (all eleven `@axion-ct/*` packages, `latest` = `0.1.2`; verified by CI against the public registry — [run 40119673859](https://github.com/AxionAura/code-translator/actions/runs/40119673859)). The `v0.1.2` tag points at release commit `742f3ee`. See [docs/release-notes-v0.1.2.md](docs/release-notes-v0.1.2.md) for what shipped.

## Language directions

| Direction | Support | Notes |
| --- | --- | --- |
| Python → TypeScript | Implemented | Full pipeline; project mode validates up to claim level 5 |
| Python → JavaScript | Implemented | Same pipeline; JS targets have no type oracle (see ladder below) |
| TypeScript → JavaScript | Implemented | Per-construct type erasure with ledger provenance |
| JavaScript → TypeScript | Implemented | Honest `unknown`-based types; output passes strict `tsc` |
| JavaScript → Python | Implemented | JS runtime semantics via a generated zero-dependency runtime module |
| TypeScript → Python | Implemented | Type erasure + the same Python runtime strategy |

The supported language surface is deliberately scoped — see [docs/language-support.md](docs/language-support.md) for the full matrix, including what is unsupported and where Python/JS/TS semantics genuinely diverge (integer precision, truthiness, division by zero, string formatting, and more).

## Quick start

Requires Node.js ≥ 22.18 and Python 3 (the Python parser uses a small CPython bridge; sandboxed execution stages additionally want `bubblewrap`).

```bash
npm install -g @axion-ct/cli

ctrans --version
ctrans doctor          # report environment capabilities; exit 1 if a required one is missing
```

Or from a checkout (Node with Corepack, pnpm pinned via `packageManager`):

```bash
corepack enable && pnpm install && pnpm build
node apps/cli/bin/ctrans-dist.mjs --version
```

## CLI examples

```bash
# Analyze + validate without writing anything (exit 0 = translatable at the reported claim)
ctrans check sample.py --to ts

# Translate a single file (writes target file + .ctrans/ ledger and report artifacts)
ctrans translate sample.py --to ts -o out/

# Translate a directory of sources
ctrans translate web-src/ --to py -o out-py/

# Translate a whole Python project INCLUDING its pytest suite (mapped to vitest),
# then validate S1–S7 in the sandbox: build, translated tests, source-vs-target
# differential, optional smoke — claim ladder + evidence in .ctrans/
ctrans project my-project/ --to ts -o out/

# Validate an existing translated project (S1–S5/S7 where inputs exist)
ctrans validate out/

# Reverse directions: JS/TS → Python (S1 bridge + S2 pyright + S3), TS → JS, JS → TS
ctrans translate legacy.ts --to js -o out-js/
ctrans translate app.js --to ts -o out-ts/

# Strict execution: every executed stage runs in a Docker/Podman container —
# no network, read-only rootfs, dropped capabilities, no host fallback.
ctrans project my-project/ --to ts -o out/ --strict --sandbox-image my-toolchain:1

# Machine-readable output: JSON on stdout, progress/diagnostics on stderr
ctrans check mod.py --to ts --json --progress json

# Reproducible benchmark suites (micro/corpus/perf/mini-projects)
ctrans benchmark --suite micro --iterations 3
```

AI is opt-in and narrowly scoped (details under [Security and privacy](#security-and-privacy)):

```bash
# Resolve AMBIGUOUS constructs among the engine's offered options (AI off by default)
ctrans check mod.py --to ts --ai-provider openai --ai-model gpt-4o-mini

# Bounded repair loop: one unit-scoped diff per attempt, 3/unit and 8/run caps,
# accepted only if the claim strictly improves with no passing stage regressed
ctrans translate mod.py --to ts -o out/ --ai-provider openai --repair
```

## How translation is validated

Two mechanisms keep the tool honest:

- **Decision ledger** — every emitted construct records its classification and rationale (with source spans). `deterministic` means provable correspondence; `semantic` means a documented adaptation; `ambiguous` offers engine-vetted options (heuristic by default, model-assisted only if you enable AI); `unsupported` constructs are never silently dropped — they produce loud markers and warnings.
- **Validation claim ladder** — reports what was actually proven: S1 syntax re-parse, S2 type check (tsc/pyright), S3 dependency resolution, S4 build, S5 translated tests, S6 source-vs-target differential, S7 optional smoke. A claim level of 5 means those stages *ran and passed* — it is evidence of validation, not a universal correctness guarantee. Stages that cannot run are reported `skipped(reason)`, never counted as passing. (JS targets have no type oracle, so JS-bound translations cap lower on the ladder — by design.)

Generated projects are self-contained: runtime helpers are emitted into the output with **zero runtime dependencies** on this tool.

## Core capabilities

- Six translation directions across Python, JavaScript, and TypeScript, at file and project scope.
- Project mode: pytest→vitest test mapping, sandboxed S1–S7 validation, `.ctrans/` evidence artifacts (ledger, report, test results, differential).
- A provider-agnostic, optional AI layer (OpenAI-compatible, Anthropic, or custom endpoints) restricted to ambiguity resolution and bounded, policy-guarded repair.
- Sandboxed execution (bwrap network/PID/filesystem isolation; optional strict Docker/Podman mode) for every stage that runs translated or source code.
- Strictly-validated optional configuration (`ctrans.config.json`), JSON machine output, reproducible benchmark suites.

## Limitations and honest semantics

- Behavior preservation is **not guaranteed**. The ledger tells you which constructs are exact, which are adapted (and how), and which were not translated at all.
- Real semantic gaps are documented, not hidden: Python arbitrary-precision integers vs. JS numbers (exact in `--int-mode bigint`, warned in number mode), truthiness differences, division-by-zero and `%` semantics, string formatting, dict ordering, and more — see [docs/language-support.md](docs/language-support.md).
- Reverse (JS/TS → Python) validation currently caps at claim level 3; translating test suites in reverse directions is not yet supported.
- Executed differentials compare observed behavior on supported subsets; they do not prove universal equivalence.

## Security and privacy

- **Local-first:** source code never leaves the machine unless you explicitly enable an AI provider. When enabled, every request passes a fail-closed `secretlint` scan, and calls are capped, journaled (hash-only), and cacheable only by explicit opt-in.
- **Credentials:** API keys come from `CTRANS_AI_KEY`, the OS keychain, or a `0600` permission-checked file — never from logs, reports, or the repository.
- **Sandboxing:** user source and translated code are treated as untrusted. Executed stages run under bwrap (network/PID isolation plus a least-privilege filesystem allowlist — the host root is never mounted), or in `--strict` containers with no network and a read-only root filesystem. Policy-only mode is never used for execution stages.

Details: [docs/security.md](docs/security.md) and the executed [security review checklist](docs/security-review-checklist.md).

## Documentation

**Using the tool**

- [Language support and semantic differences](docs/language-support.md)
- [Configuration reference](docs/configuration.md)
- [Validation and the claim ladder](docs/validation.md)
- [Benchmarks](docs/benchmarks.md)

**Architecture**

- [System architecture](docs/architecture.md) · [Translation pipeline](docs/translation-pipeline.md) · [AI architecture](docs/ai-architecture.md)
- [Decision records (ADR log)](docs/decisions.md) · [Dependency mapping](docs/dependency-mapping.md) · [Technology research](docs/research.md)

**Quality and security**

- [Testing strategy](docs/testing.md) · [Security model](docs/security.md) · [Security review checklist](docs/security-review-checklist.md)

**Development and releases**

- [PROJECT_STATE.md](PROJECT_STATE.md) — canonical current state; read this first for progress
- [Contributing rules (AGENTS.md)](AGENTS.md) · [Milestone roadmap](docs/roadmap.md) · [v1 roadmap](docs/v1-roadmap.md)
- Releases: [v0.1.2 notes](docs/release-notes-v0.1.2.md) · [release guide](docs/release.md) · [release-plan-v0.1.2](docs/release-plan-v0.1.2.md) · historical reports for [v0.1.1](docs/release-report-v0.1.1.md) and [v0.1.0](docs/release-report-v0.1.0.md)

## Development

```bash
corepack enable        # pnpm is pinned via the packageManager field
pnpm install
pnpm build             # compiled dist/ for all packages
pnpm verify            # build → typecheck → lint → format check → tests → doc links
pnpm test:coverage     # coverage with enforced per-package floors
```

Read [AGENTS.md](AGENTS.md) before changing anything — it defines the binding engineering rules for this repository (ledger completeness, testing gates, security boundaries, documentation requirements).

## License

[MIT](LICENSE). Generated translation output carries no dependency on this tool.
