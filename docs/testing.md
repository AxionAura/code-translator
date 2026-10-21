# Testing Strategy

Status: **approved blueprint**. Governs all test code from M1 onward.

## 1. Test pyramid for a translator

| Layer | What it proves | Where it lives |
| --- | --- | --- |
| Unit | one mapping rule, one resolver, one emitter function, one ledger behavior | `packages/*/test/` |
| Parser tests | front-end fidelity: spans, comments, error recovery, symtable accuracy | `packages/parser-*/test/` |
| IR/semantic tests | CommonType inference, symbol resolution, ModuleGraph construction (SCCs, ordering) | `packages/core/test/` |
| **ConstructMatrix** | every §2 entry of language-support.md × every direction, as minimal input→expected pairs | `tests/constructs/` |
| Golden fixtures | whole-file translations (stable, reviewed) | `tests/fixtures/` |
| Dependency tests | registry entries behave as claimed (usage tests) | `packages/registry/tests/` |
| Validation tests | stage pipeline produces exactly the expected verdicts (positive + negative) | `packages/validator/test/` |
| Repair tests | classification, caps, loop detection, revert-on-regression with FakeChatModel | `packages/repair/test/` |
| Repair E2E | real pipeline + real S1/S2 validators, scripted model; accepted and rejected outcomes | `packages/repair/test/pipeline-repair.test.ts` |
| Repair CLI | `--repair` journal/report wiring, no-AI degradation, rejected patch leaves baseline | `apps/cli/test/repair-cli.test.ts` |
| Validation engine (M10) | stage × capability skip matrix, claim ladder, flaky rerun, S4/S7, evidence rejection | `packages/validator/test/`, `packages/core/test/claim-ladder.test.ts` |
| Strict sandbox driver | argv security flags, daemon-vs-binary detection, refusal, cleanup, real run when available | `packages/sandbox/test/container.test.ts` |
| Project repair | real S1–S6 re-validation: accept/reject, regression, skipped evidence, infra failure, caps, journal | `apps/cli/test/project-repair.test.ts` |
| CLI doctor / strict / smoke | observed capability report, fail-closed gates, S7 harness in the sandbox | `apps/cli/test/doctor-smoke.test.ts` |
| CLI M11 | config schema/precedence, JSON stdout discipline, progress stderr, key storage/cache, validate/benchmark commands, dist entry | `apps/cli/test/{cli-m11,commands-m11,keys}.test.ts`, `packages/ai/test/disk-cache.test.ts`, `tests/dist-entry.test.ts` |
| Benchmarks | deterministic micro/corpus/perf correctness, result-schema negatives, 500-file smoke, nightly mini-projects | `tests/benchmark.test.ts`, `tests/perf-smoke.test.ts`, CLI benchmark tests |
| E2E | CLI runs against fixture projects, produces reports | `tests/e2e/` |
| Benchmarks | aggregate quality/perf over time (not pass/fail per commit) | `benchmarks/` |

## 2. Fixture system (`tests/fixtures/`)

Layout per fixture:

```
tests/fixtures/<name>/
  manifest.json        # metadata, direction, config overrides, claim-ladder expectation
  input/               # source project (may be multi-file)
  expected/            # target project as the engine must emit it
  notes.md             # optional: what this fixture pins
```

Rules:

- `manifest.json` declares `{ "name", "from", "to", "config": {...}, "expectedClaimLevel": 1..5, "expectedDecisionCounts": {...} }`. Tests assert both the emitted tree **and** the ledger/claim numbers — golden tests verify honesty, not just bytes.
- **Normalization:** both sides pass through the canonical formatter (prettier / `ruff format`) before diffing (D-012); generated provenance headers and `TODO(ctrans)` comment *text* are normalized; ledger JSON is compared structurally, not byte-wise.
- **Acceptance workflow:** `pnpm fixtures:accept <name>` regenerates `expected/` and requires a human-readable diff review in the same commit; auto-accepting without review is a forbidden shortcut (AGENTS.md §11). In autonomous phases, the reviewing agent must state *why* the new expected output is correct in the commit message.
- **Reverse goldens (M7):** `tests/fixtures/reverse-*` are reverse-direction projects run through the real CLI pipeline by `tests/reverse-golden.test.ts` — the emitted Python tree is pinned under `expected/` and the documented claim level (3: S1 bridge re-parse + S2 pyright + S3 dependencies) is asserted. Accept mode: `FIXTURES_ACCEPT_REVERSE=1 vitest run tests/reverse-golden.test.ts`.
- **Behavior differentials (M7):** `apps/cli/test/directions-behavior.test.ts` executes SOURCE and GENERATED code under the same sandbox with an identical call harness (JS→Py, TS→JS via Node type stripping, JS→TS via stripped execution) and compares JSON results; `tests/round-trip.test.ts` executes Python→TS→Python output against the original. Every execution path goes through `@ctrans/sandbox`.
- **Project goldens (M6):** fixtures named `project-*` are whole mini-projects run through the project runner (`tests/golden-projects.test.ts`), not the single-unit pipeline: they are translated, their translated vitest suites run in the sandbox (S5), the source suites run in the same sandbox (S6), and the manifests pin the claim level (5), the differential matched-name list, and the emitted tree incl. `.ctrans/` artifacts. Accept mode: `FIXTURES_ACCEPT_PROJECTS=1 vitest run tests/golden-projects.test.ts`. On hosts without enforced network isolation (bwrap) or python3, the runner asserts the honest refusal path (S5/S6 skipped-with-reason) instead of the level-5 claims.
- **Regression rule:** every bug fix lands with a fixture (or ConstructMatrix entry) that failed before and passes after.
- **Repair tests (M9):** deterministic only — `FakeChatModel` or scripted proposers, no live provider. Coverage: every `V-*` category + unknown input, infrastructure refusal, valid/malformed/out-of-scope/binary/combined diffs, policy-guard rejections, AI-disabled/provider-error/timeout/decline/cap/oversized-packet outcomes, 3-per-unit and 8-per-run caps, duplicate patches, state-hash loop detection, monotone acceptance (improve/equal/regress/pass→skipped), exact rollback (content + state hash) after rejection and after validator exceptions, journal creation/round-trip/corruption recovery/sanitization/path containment, and M8 regression (ambiguity resolution through the same model contract). Translated code is never executed by these tests; the CLI/repair E2E uses real validators but no execution.
- **Validation-engine tests (M10):** claim-ladder boundaries (skipped/warn never pass; S4 executed-failure cap; S7 independent); capability detection with functional-probe fakes (missing daemon vs missing binary vs optional gVisor); evidence rejection (duplicates, order, missing stages, inconsistent claims); a documented skip-reason matrix for S4/S5/S6/S7; flaky rerun-once (clean pass, fail→pass, fail→fail, all-flaky warn, pass→fail-on-rerun visibility, infra no-rerun); S4/S7 contracts with scripted sandbox results. Project repair tests run the REAL tsc/vitest/source-runner path and assert acceptance, rejection on S5 failure/regression, `validation-unavailable` when behavior cannot run, infrastructure preservation, cap exhaustion, and report/journal consistency. A real container run is executed only when a Docker/Podman daemon **and** a local image exist; otherwise the test asserts the refusal path and prints the environment limitation (no successful isolation claim is invented).
- **M11 CLI/distribution tests:** configuration discovery/precedence and strict rejection (unknown/secret keys, unsafe images, malformed JSON); unknown options and missing values; `--json` stdout purity vs progress/errors on stderr; key resolution (env/keychain stub/0600 file, permission and symlink rejection); opt-in disk cache (permissions, corruption, symlink root, cross-run hit); `validate` and `benchmark` commands; benchmark schema negatives and the 500-file smoke; compiled `dist` entry E2E from `apps/cli/bin/ctrans-dist.mjs`. Clean-clone/quickstart and package packing are verified as release checks rather than in the unit suite (they need a fresh install and are reported separately).

## 3. ConstructMatrix

Machine-readable index (`tests/constructs/index.json`) enumerating every construct in language-support.md §2 with: id, direction(s), input snippet, expected output, expected decision class (`deterministic|semantic|ambiguous|unsupported`), expected warning codes. A generator expands it into test cases. Adding a construct to the support matrix **without** adding a ConstructMatrix entry fails CI. `unsupported` classifications get negative tests too (asserting the warning/marker, not absence of output).

## 4. Determinism & hermeticity

- No network, no live AI, no wall-clock assertions, no parallel-unsafe shared state. Sandbox-dependent tests use capability detection and skip-with-reason only when the optional tool is genuinely absent (skip list is reported in CI output — AGENTS.md §4 forbids silent skips).
- Bridge failure modes (timeout, crash, malformed protocol, unsupported runtime) are tested by injecting POSIX stub interpreter scripts through the client's `pythonPath` option — no shell-out from production code; the stub tests are skipped only on Windows where shebang execution does not apply.
- The Python bridge tests run against the local interpreter and assert grammar-range behavior (3.12–3.14).
- Parser error-recovery tests feed mutated/truncated sources and assert graceful diagnostics.

## 5. Corpus for stress testing

A vendored corpus of small, license-clean (MIT/BSD/Apache) real-world files with attribution file (`tests/corpus/ATTRIBUTION.md`), used by benchmarks and fuzz-ish property checks: "translation always terminates, always produces a report, never crashes" for every corpus file × direction. Corpus files are never added to goldens wholesale (they're too big to review); they feed property tests and metrics.

## 6. Coverage & gates

- Floors from M4: core ≥85%, parser/codegen ≥90% line coverage (CI-enforced).
- Every milestone's DoD includes its test gate (roadmap.md).
- Tests may not mock what they own: pipeline internals are tested for real; only `ChatModel`, sandbox process edges, and clocks are faked.

## 7. Manual-quality gate (autonomous phases)

Before a milestone closes, the implementing agent must sample-review 10 emitted outputs against their sources for *idiomatic quality*, not just test passage — emission quality is part of DoD ("emit what a competent developer would write"), and gets recorded in the milestone report.
