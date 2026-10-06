# Benchmarks

Benchmark framework per [docs/benchmarks.md](../docs/benchmarks.md). Populated from M11 (micro suite exists earlier, behind the CLI).

```
benchmarks/
  projects/        # vendored license-clean mini-projects (with ATTRIBUTION.md), pinned by commit
  results/         # committed JSON + markdown reports (never hand-edited)
```

- `ctrans benchmark run --suite micro|mini-projects|corpus|perf`
- Headline metric: **differential equivalence** (source-vs-target test outcome match rate, S6).
- AI-enabled runs are tagged separately and never mixed into deterministic trends.
