# Validation

Status: S1–S3 **implemented (M4/M5)**, S5/S6 **implemented (M6)**, S2-for-Python **implemented (M7, pyright)**, the bounded repair integration **implemented (M9)** for the `translate` path (S1–S3 re-validation); S4/S7 and S5/S6-driven repair remain **blueprint**. The validation engine is the product's trust boundary: it decides what the tool is allowed to claim.

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

**S3 verdict classes (M5, implemented):** `emitted-local` (import resolves to an emitted project module), `mapped` (registry v1 entry), `external-verbatim` (unmapped third-party — exact warning, passes through, never guessed), `unsupported` (declared non-goal — warns), `unresolved` (relative import to no emitted module — FAILS the stage). S3 pass extends the claim ladder to level 3. A registry miss is NEVER conflated with a missing project module.

**S5/S6 as implemented (M6):** S5 runs the translated vitest suite inside `@ctrans/sandbox` — the toolchain's `node_modules` enters the workspace as a per-package writable symlink (nothing is installed; security.md §5 holds) and the vitest json reporter is pinned to stdout. S6 materializes the SOURCE project plus a tool-provided stdlib runner and `pytest` stub in the same sandbox and executes it there (source code is untrusted — it never runs on the host); parametrize cases and same-module fixture factories are reproduced so the comparison is per-test AND per-case, matched by pytest-convention names. Both stages demand enforced network isolation (`requireNetworkIsolation: true`) — without bwrap they are refused (`SandboxIsolationError`) and reported `skipped(reason)`, never downgraded. S4 is recorded `skipped` (no build stage wired) and does not block the ladder.

**Direction-aware stages (M7):** S1 validates the TARGET language — oxc re-parses JS/TS output, the CPython bridge re-parses Python output (reference grammar). S2 for Python output uses the pinned pyright CLI (D-005/D-024): the emitted project is materialized into an owned temp workspace (preserving relative layout so intra-project imports resolve), pyright runs with `--outputjson` under a controlled environment and timeout, findings become structured `fail` details, and unavailable/crashed/pathological runs report `skipped(reason)` — a pass verdict is never reported without executing. S3's specifier normalization understands both JS/TS (`./x.js` → emitted `.py` module, directory imports → barrel) and Python (dotted absolute imports) sources.

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

## 7. Repair loop integration (implemented, M9)

S1–S6 failures flow to `@ctrans/repair` with structured classification (§8). The loop is **bounded and observable**:

1. **Classify** the stages the engine actually executed (`classifyFailures`). `pass`/`warn` are not failures; `skipped` is inconclusive and never becomes a pass; infrastructure evidence (timeout/spawn/isolation/unavailable) is `V-S<stage>-INFRA` and is **never** repair-eligible; unsupported ledger entries are `V-UNSUPPORTED` and also never eligible.
2. **Attribute** failures to a unit only by exact target-path prefix in the stage details. Unattributable failures are never guessed onto a unit. Test modules and generated shared artifacts (no source text) are never exposed to the model.
3. **Propose** one unit-scoped unified diff through the existing `ChatModel` stack (secret gate → M8 caps → cache → provider). The diff must parse under the restricted grammar, name only the scoped target, apply content-exactly to the current unit text, and pass the policy guard (no `@ts-ignore`/`@ts-nocheck`/`declare module`/lint-coverage suppression/test `.skip`/`.only` additions). Invalid output gets ONE bounded re-ask, then a typed failure. `""` is an explicit decline.
4. **Re-validate** the candidate file map with the caller's real validators (the CLI reuses the same S1/S2/S3 wiring as the pipeline — never fresh "pass" defaults).
5. **Accept monotonically**: no stage that passed at baseline may become non-pass (including pass→skipped), and the candidate's `computeClaimLevel` must be **strictly higher** than the baseline's. Equal level = rejected ("no demonstrated improvement"). Skipped stages cannot lift the claim.
6. **Roll back exactly**: the baseline file map is never mutated. Rejected candidates exist only in the loop's local copy, so the written state is byte-identical to the baseline (verified by state hashes).
7. **Stop** with a typed reason: `no-failures`, `success`, `no-eligible-failures`, `repair-unavailable`, `declined`, `attempts-exhausted`, `run-cap`, `loop-detected`, `validation-error`.

Caps are enforced centrally in the orchestrator: **3 attempts/unit and 8 attempts/run**; callers may tighten but never raise them. Identical patch hashes are rejected as duplicates; a candidate state equal to any already-seen state stops the run with `loop-detected`. A thrown validator stops the run with `validation-error` and the exact baseline state. Model success is never treated as repair success — only the engine's re-validation decides.

History is hash-only at `.ctrans/repairs/repairs.json` (see security.md §6): per attempt the unit/target path, attempt number, failure code/category, baseline/candidate state hashes, patch hash, proposal outcome, decision + reason, stage snapshot, provider/model, token counts, secret-rule ids, timestamp; per run the stop reason, state hashes, accepted units, files changed. Diffs, prompts, model responses, and source content are never persisted. Corrupt/partial journals are recovered with the unreadable file preserved aside, and a journal write failure surfaces as an error (it is never reported as a successful repair).

The CLI writes only the accepted state and regenerates `.ctrans/report.json` from the final stages (claim level recomputed), recording `repairJournal`. `--repair` is available for `translate`; project mode (`project`) rejects the flag until S5/S6 re-validation is wired (M10).

## 8. Failure classification (input to repair)

| Code | Source | Repair eligibility |
| --- | --- | --- |
| `V-S1-PARSE` | S1 | yes (AI patch) |
| `V-S2-TYPE` | S2 | yes (AI patch) |
| `V-S3-IMPORT` | S3 | yes (AI patch); deterministic registry lookup is the preferred future strategy |
| `V-S4-BUILD` | S4 | classifier supports it; no S4 stage is wired yet |
| `V-S5-TEST` | S5 | classifier supports it; CLI repair currently re-validates S1–S3 only |
| `V-S6-DIVERGE` | S6 | classifier supports it; needs the triage artifact wired (M10) |
| `V-S<stage>-INFRA` | any | **never** — timeout/spawn/isolation/crash evidence is classified first (slow vs infinite loop), never blind-retried |
| `V-UNSUPPORTED` | ledger | **never** — the engine cannot emit behavior it does not support |
