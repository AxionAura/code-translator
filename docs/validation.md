# Validation

Status: S1–S7 **implemented (M4–M10)** for project mode, S2-for-Python **implemented (M7, pyright)**, the bounded repair integration **implemented (M9)** and extended to project-mode S1–S6 re-validation **(M10)**. The `translate` command remains a file/directory translation surface with S1–S3 validation + optional repair; S4/S7 require whole-project context and run in `project` mode. The validation engine is the product's trust boundary: it decides what the tool is allowed to claim.

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

**S5/S6 as implemented (M6):** S5 runs the translated vitest suite inside `@axion-ct/sandbox` — the toolchain's `node_modules` enters the workspace as a per-package writable symlink (nothing is installed; security.md §5 holds) and the vitest json reporter is pinned to stdout. S6 materializes the SOURCE project plus a tool-provided stdlib runner and `pytest` stub in the same sandbox and executes it there (source code is untrusted — it never runs on the host); parametrize cases and same-module fixture factories are reproduced so the comparison is per-test AND per-case, matched by pytest-convention names. Both stages demand enforced network isolation (`requireNetworkIsolation: true`) — without bwrap they are refused (`SandboxIsolationError`) and reported `skipped(reason)`, never downgraded. S4 is recorded `skipped` (no build stage wired) and does not block the ladder.

**Direction-aware stages (M7):** S1 validates the TARGET language — oxc re-parses JS/TS output, the CPython bridge re-parses Python output (reference grammar). S2 for Python output uses the pinned pyright CLI (D-005/D-024): the emitted project is materialized into an owned temp workspace (preserving relative layout so intra-project imports resolve), pyright runs with `--outputjson` under a controlled environment and timeout, findings become structured `fail` details, and unavailable/crashed/pathological runs report `skipped(reason)` — a pass verdict is never reported without executing. S3's specifier normalization understands both JS/TS (`./x.js` → emitted `.py` module, directory imports → barrel) and Python (dotted absolute imports) sources.

**S4 build as implemented (M10).** TypeScript runs the pinned `tsc --noEmit -p tsconfig.json` CLI inside the sandbox over a tool-generated strict tsconfig (`allowImportingTsExtensions`, bundler resolution, `skipLibCheck`, no ambient types); the toolchain's `typescript` and `vitest` packages enter the workspace as symlinks (nothing is installed), so emitted test modules resolve their imports. Python output runs `python3 -m compileall -q .` under network isolation (compile only — user modules are never imported). JavaScript targets have no build step and are reported `skipped` with that reason. Timeout/output-cap/spawn/container failures are infrastructure → `skipped`, never `fail`. Build diagnostics are normalized to `target: message` so repair attribution sees the emitted path.

**S7 smoke as implemented (M10).** Opt-in via `project --smoke <harness.json>`. The manifest provides `argv`, optional `stdin`, optional `harness.files` (workspace-relative, ≤20 files × 64 KiB), and an expectation (`expectedExitCode`, exact `expectedStdout` or `stdoutIncludes`). The harness and the translated project are materialized together in the sandbox workspace and executed with enforced network isolation; stdout/stderr are captured in memory for the verdict but never written to `.ctrans/` (only the stage status, reason, and exit code are). Timeouts/spawn/container failures and isolation refusal are `skipped`. **S7 is outside the claim ladder**: it neither raises nor lowers the S1–S6 claim, but an executed failure is reported as `fail` and shown by the CLI.

**Orchestration and prerequisites (M10).** Project mode always assembles all seven stage entries in canonical order; a stage that did not execute is recorded as `skipped(reason)`, never omitted. Prerequisites: S4 requires S1 not to have failed; S5 requires translated tests, a supported target, and enforced isolation (it still runs when S2/S4 fail so behavior is observed rather than guessed); S6 requires usable S5 outcomes; S7 requires a harness and a non-failed S4. `assertStageEvidence` rejects duplicate/out-of-order/unknown stages, missing required entries, pass-with-failure-reason, and a reported claim inconsistent with the executed evidence.

## 2. What may be claimed (claim ladder)

The run report computes the strongest claim supported by executed stages:

1. "Emits valid target syntax" (S1 only)
2. "+ type-checks under strict settings" (S2)
3. "+ resolves its declared dependencies" (S3)
4. "+ passes N translated tests" (S5)
5. "+ behaves identically to the source on the translated test suite: M/N tests matched" (S6)

It may never say "the translation is correct". The CLI headline is always the claim ladder position plus counts of `semantic`/`ambiguous`/`unsupported` decisions. Example: *"Equivalent on 41/44 translated tests; 3 divergences listed; 2 unsupported constructs; claims capped at level 5."*

Rules enforced by `computeClaimLevel` (pure function, unit-tested):
- Every lower stage must be `pass`; `skipped` and `warn` never count as pass.
- An **executed** S4 failure caps the claim at level 3 (the project does not build, so test/differential claims are not supported). A skipped S4 (no build toolchain, JS target, or S1 already failed) is non-blocking, preserving pre-M10 behavior.
- S7 is outside the ladder: a failed smoke run leaves the numeric claim unchanged and is reported separately (the run is not presented as integration-verified).
- Reports are validated against the stage evidence before being written; an inconsistent claim is an error, not a display bug.

## 3. Capability matrix

Not every project can run every stage; the engine detects capabilities up front. `ctrans doctor` and the validation reports consume the same model (`@axion-ct/validator` `detectValidationCapabilities`). Every check is functional: an executable that exists but fails its probe is not "available".

| Capability | Detection (functional probe) | Unlocks | Required? |
| --- | --- | --- | --- |
| `node` (≥22.18 engine floor) | `<node> --version` | emission runtime, S4 tsc, S5 vitest, S7 | yes |
| `python3 ≥3.12` | `python3 --version` | Python front-end, S6 source runner, Python-output S1/S4 | yes |
| `tsc 6` (bundled, pinned) | `node <typescript>/bin/tsc --version` | S2/S4 for TS | yes |
| `pyright` (bundled, pinned) | `node <pyright entry> --version` | S2 for Python output (M7) | yes |
| `vitest` (bundled) | `node <vitest entry> --version` | S5 | yes |
| sandbox `bwrap` | executable version + real `--unshare-net --unshare-pid` profile run | network-isolated S5/S6/S7/Python-S4 | yes for default execution |
| `prlimit` | `prlimit --version` | CPU/address-space rlimits | optional (limits degrade, reported) |
| sandbox `docker` | `--version` AND a daemon query (`version --format {{.Server.Version}}`) | strict-mode S4/S5/S6/S7 | optional |
| sandbox `podman` | `--version` AND `info --format {{.Version.Version}}` | strict-mode S4/S5/S6/S7 | optional |
| gVisor `runsc` | `runsc --version` | optional strict runtime (`--runtime runsc`) | optional |

States are distinct: `available`, `unavailable` (required but missing/failed), `optional` (not installed; no failure of the install), and `probeFailed` (the executable exists but its functional query failed — e.g. docker client without a daemon). Missing required capabilities produce skipped stages with the recorded reason; a skipped stage never supports a claim. Doctor exits 1 only when a required capability is unavailable. Strict mode requires a usable container runtime **and** an explicit image; its absence is a hard refusal, never a host fallback.

## 4. Differential testing (S6) design

- Source tests are executed first (sandboxed), recording per-test outcome (`pass/fail/error`) and normalized stdout where the test asserts it.
- Translated tests must preserve test names (pytest `test_x[params]` → vitest `test_x[params]` mapping rules; unmappable names are reported, not guessed).
- Comparison: per-test outcome equality. Duration is never compared. Output-compared tests use normalized whitespace/floats (documented normalization list).
- Divergences produce a triage artifact: source span of the test, failing assertion, both outputs — this is the repair loop's highest-quality input.
- If source tests cannot run (e.g., missing fixtures), S6 is skipped(reason); S5 alone supports only claim level 4.

## 5. Flakiness & timeouts policy (implemented M10)

- Every sandboxed execution: wall-clock timeout, stdout/stderr caps, kill on timeout → recorded as infrastructure (`skipped(reason)` for stages; never a source-type `fail`).
- **Rerun-once:** when an S5 run *completes* with per-test failures, the suite is rerun exactly once. Only first-attempt failures are re-evaluated:
  - failed → passed: the test is `flaky`, its final outcome is `passed` with `flaky: true` and both attempts preserved; it is **excluded from the claim count** and listed in S5/S6 details.
  - failed → failed/absent: final failure, both attempts preserved.
  - passed first → failed/absent on rerun: the first-attempt pass stands (the rerun cannot overturn it), but the instability is reported in S5 details.
- A rerun is never attempted after timeout/output-limit/spawn/container-error, and never recursively (`rerunFlaky: false` disables it; one rerun maximum).
- S5 status: `fail` when non-flaky failures remain; `warn` when every test was flaky (no stable first-attempt evidence); `pass` only with at least one clean first-attempt pass and no non-flaky failures.
- S6 excludes flaky target names from `matched`/`mismatched`/`targetOnly`, lists them in `flaky`, and reports `warn` when no stable outcomes remain.

## 6. Validation of the validator

- The validation pipeline is itself under test: scripted bad-output fixtures must produce exactly the expected stage failures (negative tests); known-good goldens must produce level-5 claims.
- **Evidence validation (M10):** `assertStageEvidence` rejects missing required stages, duplicates, out-of-order/unknown stages, passes carrying failure reasons, failures without reasons, and a claimed level that differs from `computeClaimLevel`. Reports are built only from the accepted evidence.
- **Validator-on-validator suite:** `packages/validator/test/{capabilities-evidence,skip-matrix,stages,build-smoke}.test.ts` exercise every skip reason, every infrastructure classification, flaky bookkeeping, S4/S7 behavior, and inconsistent-evidence rejection without executing project code (scripted sandbox results). Real execution appears only in project/golden/containment tests.
- Claim-ladder computation is unit-tested as a pure function, including S4 gating and S7 independence.
- Any change to stage semantics requires updating `docs/validation.md` in the same change (AGENTS.md §8).

## 7. Repair loop integration (implemented, M9)

S1–S6 failures flow to `@axion-ct/repair` with structured classification (§8). The loop is **bounded and observable**:

1. **Classify** the stages the engine actually executed (`classifyFailures`). `pass`/`warn` are not failures; `skipped` is inconclusive and never becomes a pass; infrastructure evidence (timeout/spawn/isolation/unavailable) is `V-S<stage>-INFRA` and is **never** repair-eligible; unsupported ledger entries are `V-UNSUPPORTED` and also never eligible.
2. **Attribute** failures to a unit only by exact target-path prefix in the stage details. Unattributable failures are never guessed onto a unit. Test modules and generated shared artifacts (no source text) are never exposed to the model.
3. **Propose** one unit-scoped unified diff through the existing `ChatModel` stack (secret gate → M8 caps → cache → provider). The diff must parse under the restricted grammar, name only the scoped target, apply content-exactly to the current unit text, and pass the policy guard (no `@ts-ignore`/`@ts-nocheck`/`declare module`/lint-coverage suppression/test `.skip`/`.only` additions). Invalid output gets ONE bounded re-ask, then a typed failure. `""` is an explicit decline.
4. **Re-validate** the candidate file map with the caller's real validators (the CLI reuses the same S1/S2/S3 wiring as the pipeline — never fresh "pass" defaults).
5. **Accept monotonically**: no stage that passed at baseline may become non-pass (including pass→skipped), and the candidate's `computeClaimLevel` must be **strictly higher** than the baseline's. Equal level = rejected ("no demonstrated improvement"). Skipped stages cannot lift the claim.
6. **Roll back exactly**: the baseline file map is never mutated. Rejected candidates exist only in the loop's local copy, so the written state is byte-identical to the baseline (verified by state hashes).
7. **Stop** with a typed reason: `no-failures`, `success`, `no-eligible-failures`, `repair-unavailable`, `declined`, `attempts-exhausted`, `run-cap`, `loop-detected`, `validation-error`.

Caps are enforced centrally in the orchestrator: **3 attempts/unit and 8 attempts/run**; callers may tighten but never raise them. Identical patch hashes are rejected as duplicates; a candidate state equal to any already-seen state stops the run with `loop-detected`. A thrown validator stops the run with `validation-error` and the exact baseline state. Model success is never treated as repair success — only the engine's re-validation decides.

History is hash-only at `.ctrans/repairs/repairs.json` (see security.md §6): per attempt the unit/target path, attempt number, failure code/category, baseline/candidate state hashes, patch hash, proposal outcome, decision + reason, stage snapshot, provider/model, token counts, secret-rule ids, timestamp; per run the stop reason, state hashes, accepted units, files changed. Diffs, prompts, model responses, and source content are never persisted. Corrupt/partial journals are recovered with the unreadable file preserved aside, and a journal write failure surfaces as an error (it is never reported as a successful repair).

The CLI writes only the accepted state and regenerates `.ctrans/report.json` from the final stages (claim level recomputed), recording `repairJournal`. `translate --repair` re-validates S1–S3 (the translate surface's stages). `project --repair` (M10) re-validates the **real S1–S6 project path** for every candidate — the same validators, toolchain, sandbox/container configuration, test mapping, and S5/S6 implementations as the baseline — and requires `S5-tests` and `S6-differential` to be executable in the baseline and `pass` on every accepted candidate. If behavioral validation cannot run (no tests, `--no-tests`, isolation unavailable, container failure), repair stops with `validation-unavailable` and the CLI exits 1; it never downgrades to S1–S3-only acceptance. Candidate evidence is cached by state hash so final reports cannot refer to stale files. Test failures are attributed to source units through direct test-module import edges (never guessed).

## 8. Failure classification (input to repair)

| Code | Source | Repair eligibility |
| --- | --- | --- |
| `V-S1-PARSE` | S1 | yes (AI patch) |
| `V-S2-TYPE` | S2 | yes (AI patch) |
| `V-S3-IMPORT` | S3 | yes (AI patch); deterministic registry lookup is the preferred future strategy |
| `V-S4-BUILD` | S4 | classifier supports it; no S4 stage is wired yet |
| `V-S5-TEST` | S5 | classifier supports it; CLI repair currently re-validates S1–S3 only |
| `V-S6-DIVERGE` | S6 | classifier supports it; project repair re-runs S6 |
| `V-S7-SMOKE` | S7 | classifier supports it; S7 is outside the claim ladder, so a smoke-only repair has no claim room to improve |
| `V-S<stage>-INFRA` | any | **never** — timeout/spawn/isolation/crash evidence is classified first (slow vs infinite loop), never blind-retried |
| `V-UNSUPPORTED` | ledger | **never** — the engine cannot emit behavior it does not support |
