# Benchmarks

Status: **approved blueprint**. The benchmark framework ships with the repository (not an afterthought) and measures honest translation quality over time.

## 1. Metrics (per suite run)

| Metric | Definition |
| --- | --- |
| Translation success | % of constructs classified `deterministic`/`semantic` (vs `ambiguous`/`unsupported`) over the ConstructMatrix + corpus |
| Syntax success | % of emitted units passing S1 |
| Build success | % of emitted projects passing S4 (where capability exists) |
| Test pass rate | % of translated tests passing (S5) |
| Differential equivalence | % of tests with matching source-vs-target outcomes (S6) — the headline metric |
| Runtime failures | uncaught exceptions/timeouts during S5/S6 |
| Dependency failures | S3 unresolved symbols/projects |
| Warnings | count by code (`CTW-*`) |
| Manual intervention | constructs left as `TODO(ctrans)` requiring human decisions |
| Translation time | wall-clock per unit / per project (p50/p95) |
| AI repair attempts | calls, accepted patches, reverts, exhausted units (AI-enabled runs reported separately) |

## 2. Suites

- `micro` — ConstructMatrix aggregate (fast, per-commit).
- `mini-projects` — 3–5 small real projects (license-clean, vendored under `benchmarks/projects/` with `ATTRIBUTION.md`), each with its own test suite, translated end-to-end in project mode. Target V1 selections: a pure-Python CLI utility, a small data-structure library, a JS utility library for the reverse direction.
- `corpus` — property sweep over `tests/corpus/` (termination + report integrity for every file × direction).
- `perf` — timing on a synthetic large project (≥500 files) to guard the "large project" design (graph ordering, context packing, memory).

## 3. Harness

`ctrans benchmark run [--suite …] [--ai]` executes suites, writes `benchmarks/results/<date>-<suite>.json`, and renders `benchmarks/results/latest.md` (tables + trend vs previous committed result). CI runs `micro` per commit and `mini-projects` nightly; trends beyond thresholds (−2% differential equivalence) open a regression task, not a red build (benchmarks are noisy).

## 4. Integrity rules

- Results are committed artifacts; editing them by hand is a forbidden shortcut.
- AI-enabled runs are tagged and never mixed into deterministic trends.
- Benchmark projects are pinned (commit hash) and updated deliberately, so changes reflect engine quality, not target drift.
- Every metric has a definition in this file; changing a definition is an ADR.
