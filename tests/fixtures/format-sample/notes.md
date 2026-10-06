# format-sample notes

What this fixture pins once M4 exists:

- `list[int]` -> `Array<number>`; default args -> default params (deterministic).
- f-string -> template literal (deterministic).
- Ternary `x if c else y` -> conditional expression with `length > 0` guard instead of truthiness (provability analysis, D-016).
- `text[::2]` -> `__ctrans.strSlice` (semantic, D-016) with ledger entry.
- `int(raw)` -> `__ctrans.intFromString` (semantic: Python `int()` semantics).
- `raise ValueError(...)` -> generated `__ctrans.ValueError` (D-015).
- `None` -> `undefined` per `nullMode` in manifest.
- Warning `CTW-NUM-INT-ARBITRARY-PRECISION` expected once per file using `int` (D-006).

Expected output here is illustrative (hand-written at design time). The binding golden is generated and reviewed in M4 per tests/fixtures/README.md.
