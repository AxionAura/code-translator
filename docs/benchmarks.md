# Benchmarks

Status: **implemented (M11)**. The harness separates deterministic correctness
cases from machine-local timings, rejects malformed results, and never presents a
fast run as a performance improvement. AI-enabled runs are not part of these
suites (no provider is called).

## Suites

| Suite | Contents | When |
| --- | --- | --- |
| `micro` | parse + translate a small Python module to TS/JS; correctness: S1 pass, emitted files, ledger counts | every `pnpm verify` (a one-iteration correctness run in `tests/benchmark.test.ts`) and on demand |
| `corpus` | every `benchmarks/corpus/*.py` translated to TS; correctness: S1 pass | on demand |
| `mini-projects` | three vendored mini-projects (`benchmarks/projects/*/input`) translated end-to-end in project mode; correctness: no failed files, S1 pass; metrics include claim level, S5/S6 status, differential matched count | explicit/nightly (`pnpm benchmark:mini`) |
| `perf` | 500-module synthetic JS dependency chain translated to TS (no execution); correctness: 500 emitted files + S1 pass | explicit/nightly and the 500-file smoke test |

Corpus and project inputs are original to this repository (MIT); see
[`benchmarks/ATTRIBUTION.md`](../benchmarks/ATTRIBUTION.md).

## CLI

```bash
ctrans benchmark [--suite micro|corpus|mini-projects|perf] [--iterations N]
                 [--json] [--results <file>]
pnpm benchmark                  # micro, 3 iterations
pnpm benchmark:mini             # mini-projects, 1 iteration
pnpm benchmark:perf             # perf, 1 iteration
pnpm benchmark:nightly          # mini-projects + perf, writes benchmarks/results/
```

Benchmark output is JSON on stdout with `--json`; progress stays on stderr.
`--results` writes the same validated JSON to a file. `benchmarks/results/` holds
committed artifacts; do not hand-edit them. `scripts/benchmark-nightly.mjs` runs
the expensive suites and writes `<date>-<suite>.json`.

## Result schema (version 1)

```json
{
  "version": 1,
  "generatedAt": "ISO-8601",
  "nodeVersion": "v24.x",
  "deterministic": true,
  "suites": [
    {
      "name": "micro",
      "status": "ok | failed | skipped",
      "cases": [
        {
          "name": "parse/python-small",
          "status": "ok | failed | skipped",
          "iterations": 3,
          "correctness": true,
          "wallMs": { "median": 0, "p95": 0, "total": 0 },
          "metrics": { "bytes": 177 },
          "details": []
        }
      ]
    }
  ]
}
```

`parseBenchmarkResult` rejects missing/non-finite timings, empty `ok` suites,
unknown suite names, missing case names, non-boolean correctness, and malformed
metrics. `tests/benchmark.test.ts` covers these negative cases plus the micro/perf
correctness gates.

## Methodology

- Timings are wall-clock around each iteration on the development/CI host; they are
  **not** cross-machine comparisons and no improvement claims are derived.
- Correctness is asserted inside each case; a failed correctness check makes the
  case/suite `failed` and the CLI exits 1.
- The perf suite parses and translates in-process; it does not execute generated
  code. Mini-projects execute tests only through the sandbox (S5/S6).
- The 500-file smoke test asserts completion inside a deliberately generous 120 s
  budget; the measured translation phase on the reference host was ~0.3 s.

## Recorded result (2026-10-22, reference host)

Committed under `benchmarks/results/2026-10-22-*.json` (Node 24.15, Linux x64;
three iterations except mini/perf as recorded):

| Case | Status | Median wall | Notes |
| --- | --- | --- | --- |
| micro parse/python-small | ok | 25.6 ms | 177-byte module |
| micro translate/python-to-typescript | ok | 28.7 ms | 2 emitted files (module + runtime), claim 1 |
| micro translate/python-to-javascript | ok | 20.2 ms | 2 emitted files, claim 1 |
| corpus arithmetic/classes/collections | ok | 19.0 / 19.4 / 21.5 ms | S1 pass, 22–24 ledger entries each |
| mini-projects arithmetic/classes/collections | ok | 1216 / 1254 / 1196 ms | claim 5, S5+S6 pass, 2/2/3 differential matches |
| perf 500 modules JS→TS | ok | 311.9 ms | 500 emitted files, 2996 ledger entries, claim 1 |

These are observations from one host and one run; they are reproducibility
evidence, not cross-machine or historical comparisons.

## Future metrics

The original blueprint also listed differential equivalence as a headline corpus
metric, dependency failures, warnings by code, manual interventions, and AI repair
attempts. The implemented suites expose claim level, S1 status, ledger counts, and
S5/S6/differential results where those stages run; a broader corpus and historical
trend reporting remain future work (M11+).
