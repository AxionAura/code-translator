# Fixtures

Golden-fixture system per [docs/testing.md](../../docs/testing.md). Layout:

```
tests/fixtures/<name>/
  manifest.json   # direction, config, expected claim level, expected decision counts
  input/          # source project
  expected/       # target project the engine must emit (canonical-formatted)
  notes.md        # optional
```

- Both sides are compared **after** canonical formatting (prettier / `ruff format`, decision D-012); provenance headers and `TODO(ctrans)` texts are normalized; ledgers are compared structurally.
- Expected outputs are accepted via `pnpm fixtures:accept <name>` and must be reviewed with a stated rationale (AGENTS.md §11).
- Every bug fix lands with a fixture that failed before (regression rule, testing.md §2).

`format-sample/` below pins the **format contract only** (directory layout, manifest schema, naming conventions). Its `expected/` file was hand-written at design time to illustrate the target shape; once M4 lands, the engine's real output for this input is reviewed and becomes the first engine-generated golden.
