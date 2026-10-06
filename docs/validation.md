# Validation

Status: **approved blueprint**. The validation engine is the product's trust boundary: it decides what the tool is allowed to claim.

## 1. Stage pipeline

| Stage | Name | What runs | Requires | Failure means |
| --- | --- | --- | --- | --- |
| S1 | Syntax | emitted units re-parse in target grammar (tsc/oxc parse; `ast.parse` for Python output) | nothing | translation bug — repair loop eligible |
| S2 | Types | `tsc --noEmit` (TS out, typescript@6); `pyright --outputjson` (pinned) for Python out; mypy optional secondary | checker availability | type-level semantic drift |
| S3 | Dependencies | import/export resolution of the emitted project against ModuleGraph + registry manifest; unresolved symbols listed | project mode | missing mapping / wrong module paths |
| S4 | Build | `tsc -b` or bundler dry-run; `python -m compileall` | toolchain present | structural breakage beyond per-file checks |
| S5 | Unit tests | translated tests executed under target runtime **in the sandbox** | runtime + sandbox; tests exist | behavioral divergence candidates |
| S6 | Differential | same tests run on **source** runtime; per-test outcomes compared (name-mapped) | source runtime + sandbox | behavioral divergence — strongest signal |
| S7 | Smoke | run translated entry point with sample input, capture stdout/exit (opt-in) | user provides harness or entry is pure | integration drift |

Every stage result is one of: `pass`, `fail`, `warn`, `skipped(reason)`. **A skipped stage is reported as skipped, forever visible in the report.** Nothing downgrades a failure to a warning.

## 2. What may be claimed (claim ladder)

The run report computes the strongest claim supported by executed stages:

1. "Emits valid target syntax" (S1 only)
2. "+ type-checks under strict settings" (S2)
3. "+ resolves its declared dependencies" (S3)
4. "+ passes N translated tests" (S5)
5. "+ behaves identically to the source on the translated test suite: M/N tests matched" (S6)

It may never say "the translation is correct". The CLI headline is always the claim ladder position plus counts of `semantic`/`ambiguous`/`unsupported` decisions. Example: *"Equivalent on 41/44 translated tests; 3 divergences listed; 2 unsupported constructs; claims capped at level 5."*

## 3. Capability matrix

Not every project can run every stage; the engine detects capabilities up front (`ctrans doctor`):

| Capability | Detection | Unlocks |
| --- | --- | --- |
| `python3 ≥3.12` | PATH probe | Python front-end (primary), S6 for py sources |
| `node ≥22` | runtime | JS/TS emission validation, S5 (JS targets) |
| `tsc 6` / bundled | dependency | S2/S4 for TS |
| `pyright` (bundled, pinned) | dependency | S2 for Python output |
| `vitest` / `pytest` | detected in target/source project manifests | S5 |
| sandbox `bwrap` | probe `bwrap --ro-bind / / true` | network-isolated S5/S6 |
| sandbox `docker/podman` | probe + daemon check | strict-mode S5/S6 |
| provider reachable | explicit ping only when `ai.enabled` | repair escalation |

Missing capabilities produce skipped stages — with reasons in the report. No capability is ever *assumed*.

## 4. Differential testing (S6) design

- Source tests are executed first (sandboxed), recording per-test outcome (`pass/fail/error`) and normalized stdout where the test asserts it.
- Translated tests must preserve test names (pytest `test_x[params]` → vitest `test_x[params]` mapping rules; unmappable names are reported, not guessed).
- Comparison: per-test outcome equality. Duration is never compared. Output-compared tests use normalized whitespace/floats (documented normalization list).
- Divergences produce a triage artifact: source span of the test, failing assertion, both outputs — this is the repair loop's highest-quality input.
- If source tests cannot run (e.g., missing fixtures), S6 is skipped(reason); S5 alone supports only claim level 4.

## 5. Flakiness & timeouts policy

- Every sandboxed execution: wall-clock timeout (default 60s per test file, configurable), stdout/stderr caps, kill on timeout → recorded as `error(timeout)`, not `fail`.
- A test that fails, then passes on one rerun, is marked `flaky` and excluded from the claim count while listed in the report (rerun-once policy; no infinite retry).
- The sandbox never runs with network by default; tests requiring network are detected (best-effort: sockets module usage in source) and reported as candidates for strict-mode or explicit opt-in.

## 6. Validation of the validator

- The validation pipeline is itself under test: scripted bad-output fixtures must produce exactly the expected stage failures (negative tests); known-good goldens must produce level-5 claims.
- Claim-ladder computation is unit-tested as a pure function.
- Any change to stage semantics requires updating `docs/validation.md` in the same change (AGENTS.md §8).

## 7. Repair loop integration

S1–S6 failures flow to `@ctrans/repair` with structured classification (§8). The loop re-runs validation after each accepted patch. Validation results are **monotone within a run**: a patch that breaks a previously passing stage is reverted automatically (change tracking in `.ctrans/repairs/`).

## 8. Failure classification (input to repair)

| Code | Source | Repair eligibility |
| --- | --- | --- |
| `V-S1-PARSE` | S1 | yes (AI patch) |
| `V-S2-TYPE` | S2 | yes (AI patch) |
| `V-S3-IMPORT` | S3 | deterministic first (registry lookup), AI fallback |
| `V-S4-BUILD` | S4 | yes (AI patch) |
| `V-S5-TEST` | S5 | yes, after divergence triage |
| `V-S6-DIVERGE` | S6 | yes — highest value; triage artifact attached |
| `V-*-TIMEOUT` | any | classification first (test too slow vs infinite loop); never blind-retry |
