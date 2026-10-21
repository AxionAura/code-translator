# Code Translator

A behavior-preserving source-code translator for **Python ↔ JavaScript ↔ TypeScript**, designed to translate whole projects — not just snippets — with explicit, honest reporting of what was translated deterministically, what was adapted semantically, what was ambiguous, and what was not supported.

**Status: M11 complete — v0.1.0 release candidate (not published).** Six translation directions (M7), whole-project validation S1–S7 (M6/M10), the provider-agnostic AI layer (M8), bounded repair (M9), and the M11 CLI: config schema, `validate`/`benchmark` commands, `--json` machine output with stderr-only progress, keychain/0600-file credentials, opt-in disk cache, a compiled `dist` entry, benchmark suites/corpus, and a security review checklist. See [docs/roadmap.md](docs/roadmap.md), [docs/release.md](docs/release.md), and [PROJECT_STATE.md](PROJECT_STATE.md).

## Quickstart

```bash
corepack enable && pnpm install
pnpm build                      # compiled packages + CLI (dist)

# Compiled entry (release path):
node apps/cli/bin/ctrans-dist.mjs check sample.py --to ts
node apps/cli/bin/ctrans-dist.mjs translate sample.py --to ts -o out/
node apps/cli/bin/ctrans-dist.mjs project my-project/ --to ts -o out/
node apps/cli/bin/ctrans-dist.mjs doctor
node apps/cli/bin/ctrans-dist.mjs benchmark --suite micro --iterations 3
node apps/cli/bin/ctrans-dist.mjs validate out/          # validate an existing target project
```

Development/test commands use the source-mode launcher (Node type stripping):

```bash
# Analyze + validate a Python file without writing output (exit 0 = translated)
node apps/cli/bin/ctrans.mjs check sample.py --to ts

# Translate a file or a whole project directory (writes target files + .ctrans/ artifacts)
node apps/cli/bin/ctrans.mjs translate sample.py --to ts -o out/
node apps/cli/bin/ctrans.mjs translate my-project/ --to js -o out-js/

# Translate a whole project INCLUDING its pytest test modules (→ vitest) and validate
# S1-S7 in the sandbox: build, translated tests (S5), source-vs-target differential
# (S6), optional smoke harness (S7), claim ladder + .ctrans/ evidence
node apps/cli/bin/ctrans.mjs project my-project/ --to ts -o out/

# Report observed environment capabilities (runtimes, validators, bwrap,
# docker/podman, gVisor). Exit 1 only when a REQUIRED capability is missing.
node apps/cli/bin/ctrans.mjs doctor

# Strict execution: every executed stage runs in a Docker/Podman container with no
# network, read-only rootfs, dropped capabilities, and no host fallback. Requires a
# usable runtime and an image that provides the validation toolchain; pulls disabled.
CTRANS_SANDBOX_IMAGE=my-ctrans-toolchain:1 \
  node apps/cli/bin/ctrans.mjs project my-project/ --to ts -o out/ --strict

# Opt-in S7 smoke: run a harness against the translated project in the sandbox
node apps/cli/bin/ctrans.mjs project my-project/ --to ts -o out/ --smoke smoke.json

# Reverse directions: JS/TS → Python, TS → JS, JS → TS (direction from the source)
node apps/cli/bin/ctrans.mjs translate web-src/ --to py -o out-py/   # S1 bridge + S2 pyright + S3
node apps/cli/bin/ctrans.mjs translate legacy.ts --to js -o out-js/  # type erasure
node apps/cli/bin/ctrans.mjs translate app.js --to ts -o out-ts/     # honest unknown types

# Configuration is optional and strictly validated (ctrans.config.json beside the
# input or via --config). CLI flags win; unknown/secret-bearing keys are rejected.
node apps/cli/bin/ctrans.mjs check mod.py --config ctrans.config.json

# Machine-readable output: JSON on stdout, progress/errors on stderr.
node apps/cli/bin/ctrans.mjs check mod.py --to ts --json --progress json

# Optional AI escalation (OFF by default): let a model choose among the options the
# engine already offers for AMBIGUOUS constructs (never anything else). A secretlint
# scan gates every request; caps + cache + journal are enforced; the heuristic default
# applies when the provider is unavailable or the answer is not an offered option.
# Keys: CTRANS_AI_KEY, OS keychain, or a 0600 ~/.config/ctrans/keys.json file.
CTRANS_AI_KEY=... node apps/cli/bin/ctrans.mjs check mod.py --to ts \
  --ai-provider openai --ai-model gpt-4o-mini   # or --ai-provider anthropic

# M9/M10: bounded repair after translation. translate re-validates S1-S3; project
# re-validates the REAL S1-S6 path and refuses when behavioral validation cannot run.
# The model may propose ONE unit-scoped unified diff per attempt (3/unit, 8/run); the
# engine accepts only a strictly higher claim with no passing stage regressed.
CTRANS_AI_KEY=... node apps/cli/bin/ctrans.mjs translate mod.py --to ts -o out/ \
  --ai-provider openai --repair
CTRANS_AI_KEY=... node apps/cli/bin/ctrans.mjs project my-project/ --to ts -o out/ \
  --ai-provider openai --repair

# Benchmarks: micro runs in verify; corpus/perf/mini are explicit, nightly script.
pnpm benchmark
pnpm benchmark:mini
pnpm benchmark:perf
pnpm benchmark:nightly
```

The CLI prints the claim-ladder level (what validation actually proved), per-file status, and decision counts. Translated output is finalized through Prettier; runtime helpers land in a generated `__ctrans_runtime.ts|js` that carries **zero** dependencies. No release has been published; see [docs/release.md](docs/release.md).

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
| [docs/security-review-checklist.md](docs/security-review-checklist.md) | Executed security review with per-threat evidence and residual risks |
| [docs/configuration.md](docs/configuration.md) | `ctrans.config.json` schema, discovery, precedence |
| [docs/release.md](docs/release.md) | v0.1.0 build/packaging/publishing instructions and limits |
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
pnpm build             # compiled dist/ for all packages (release path)
pnpm verify            # build → typecheck → lint → format check → tests → documentation links
pnpm test:coverage
```

Release status: version `0.1.0`, MIT, compiled `dist` entries, packed contents
verified; **nothing has been published** (see [docs/release.md](docs/release.md)).
