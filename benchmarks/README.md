# Benchmarks

Implemented harness per [docs/benchmarks.md](../docs/benchmarks.md).

```
benchmarks/
  corpus/          # small original Python inputs (MIT), see ATTRIBUTION.md
  projects/        # three original mini-projects (MIT) with pytest suites
  results/         # committed, schema-validated JSON results (never hand-edited)
  ATTRIBUTION.md
```

- `pnpm benchmark` / `ctrans benchmark --suite micro` — parse/translate cases with correctness checks.
- `pnpm benchmark:mini` — end-to-end project mode (S5/S6), explicit/nightly.
- `pnpm benchmark:perf` — 500-module synthetic JS→TS chain.
- `pnpm benchmark:nightly` — mini + perf, writes `results/<date>-<suite>.json`.
- Timings are machine-local observations, not performance claims; AI is never
  called by these suites.
