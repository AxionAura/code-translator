# Roadmap to v1.0.0

Status: **planning only.** `v0.1.0` is published; a `v0.1.1` patch candidate is
prepared locally but not published; `v1.0.0` is not complete.
This roadmap is based on [the post-release product audit](../research/post-release-product-audit.md).
It deliberately excludes new languages and UI work; trustworthiness of the six
existing directions comes first.

## 1. Priorities

| Priority | Meaning |
| --- | --- |
| **P0** | Release-blocking correctness, security, or data-loss risk |
| **P1** | Essential for a trustworthy v1.0 contract |
| **P2** | High-value reliability/usability improvement |
| **P3** | Useful follow-up after v1.0 |

## 2. Prioritized backlog

### P0 — must be fixed before v1.0

#### P0-1. Eliminate silent integer precision loss in default mode

- **User problem:** Python arbitrary-precision integer expressions can become
  wrong JavaScript numbers without warning. `x = 2 ** 53 + 1` emits
  `2 ** 53 + 1`; `x = 2 ** 100` emits a plain exponentiation. Both report no
  warning and claim 3.
- **Evidence/subsystem:** Python→JS/TS lowering, numeric decision classification,
  precision warnings; sampled through `ctrans check`/`translate`.
- **Proposed outcome:** Detect precision-risky exponentiation and constant
  arithmetic; emit a `CTW-NUM-INT-ARBITRARY-PRECISION` warning and classify the
  affected operation as `semantic` (or reject in a strict mode). Preserve exact
  output when `--int-mode bigint` is selected.
- **Acceptance criteria:** Tests for `2 ** 100`, `2 ** 53 + 1`, `10 ** 30`, and
  annotated variants assert warning + semantic classification + report/CLI
  disclosure; an executed differential test with a safe integer workload passes;
  `--int-mode bigint` remains exact. No claim level is presented as semantic proof.
- **Dependencies/blockers:** Numeric provability helpers; possible golden updates.
- **Effort:** M.
- **Required for v1.0:** **Yes.**
- **Implementation status (2026-10-23): implemented and packaged as the v0.1.1
  release candidate; not published.** `constIntegerInfo` performs exact BigInt
  analysis for constant `Add`/`Sub`/`Mult`/`Pow`/`FloorDiv`/`Mod` and unary
  `USub`/`UAdd`; unsafe final or intermediate values are `semantic` +
  `CTW-NUM-INT-ARBITRARY-PRECISION`, safe boundaries remain deterministic, and
  bigint mode remains exact. Token-level float detection keeps integral float
  literals (`2.0`) as JS numbers and hex integers containing `e` as integers.
  Regression tests cover both targets, both int modes, positive/negative
  boundaries, composed/floor/mod/literal cases, negative and huge exponents,
  runtime unknowns, report/claim output, and sandbox-backed safe/bigint execution:
  **113 files, 1116/1116 tests**. The published v0.1.0 artifacts still contain the
  old behavior; v0.1.1 is prepared locally, not published. Indirect/runtime
  integer value tracking remains a follow-up, and number-mode `0 ** -1` remains a
  separately disclosed pre-existing gap. See
  [release-notes-v0.1.1.md](release-notes-v0.1.1.md).

### P1 — essential trustworthiness and core usability

#### P1-1. Make generated provenance report the real release version

- **User problem:** Generated headers and reports say `Code Translator 0.0.0`
  while the CLI/packages are `0.1.1` in the working tree (`0.1.0` published).
- **Evidence/subsystem:** `packages/core/src/pipeline.ts` report generator,
  `packages/codegen-js/src/translator.ts` header constant, golden outputs.
- **Proposed outcome:** One injected generator version source (package/version
  constant) used by headers and reports; no hand-maintained duplicate.
- **Acceptance criteria:** Generated header and `TranslationReport.generator.version`
  equal `--version`/package version; a regression test pins the relationship;
  goldens regenerated with reviewed diffs.
- **Dependencies/blockers:** Golden acceptance and release packaging version flow.
- **Effort:** S.
- **Required for v1.0:** **Yes.**

#### P1-2. Add CI and reproducible release/consumer matrices

- **User problem:** Verification and release checks currently exist only as local
  commands; there is no CI workflow and no remote. A local green suite cannot
  prove a contributor or release environment is equivalent.
- **Evidence/subsystem:** Repository workflow search found no `.github`,
  GitLab/CircleCI configuration; `git remote` is empty; `pnpm verify` is local.
- **Proposed outcome:** CI jobs for build/typecheck/lint/format/tests/docs,
  coverage floors, package packing, clean-clone install, published-CLI smoke, and
  a small OS/runtime matrix. Keep optional Docker/bwrap jobs capability-gated.
- **Acceptance criteria:** CI configuration is committed and runs on a clean
  checkout; a matrix covers Node 22.18/24 (and 26 where available), Python
  3.12/3.13/3.14, and at least Linux+bwrap for executed validation; failures are
  visible; the release job is reproducible without manual local state.
- **Dependencies/blockers:** Remote/repository hosting decision; operator-owned CI;
  secrets policy for optional AI tests (deterministic suites must not need AI keys).
- **Effort:** M.
- **Required for v1.0:** **Yes.**

#### P1-3. Make behavioral/differential coverage symmetric across six directions

- **User problem:** The project advertises six directions, but S5/S6 project
  validation is strongest for Python→TypeScript and reverse directions lack
  equivalent executed test evidence. Output generation is not the same as
  behavioral validation.
- **Evidence/subsystem:** three project goldens exercise Python→TS S5/S6; reverse
  behavior has three differential tests plus a round trip; reverse validation is
  capped at claim 3 and reverse test translation is deferred.
- **Proposed outcome:** A documented behavioral matrix with at least one executed
  source-vs-target workload for every direction, plus project S5/S6 for the
  supported project directions. Where a direction cannot be behaviorally
  validated, the report says so and cannot claim beyond level 3.
- **Acceptance criteria:** Test matrix enumerates all six directions; each has an
  executed fixture or an explicit `unsupported/no-differential` reason; Python→JS
  and Python→TS both have S5/S6; reverse claim caps are asserted; no output-only
  test is labeled behavioral evidence.
- **Dependencies/blockers:** Test translation scope decision (P2-2); sandbox
  capability matrix; runtime availability.
- **Effort:** L.
- **Required for v1.0:** **Yes**, at least for the supported project directions;
  reverse project/test translation may be explicitly out of scope if disclosed.

#### P1-4. Return actionable diagnostics with source spans

- **User problem:** Syntax failures return only `invalid syntax`; missing files
  return raw `ENOENT`; users and automation cannot identify the failing location or
  correct it.
- **Evidence/subsystem:** `ctrans check invalid.py`/`--json`; CLI error rendering;
  parser error types.
- **Proposed outcome:** Typed errors with file, line, column, byte span, offending
  source excerpt where safe, stable error code, and a remediation hint. Missing
  inputs become structured CLI errors, not raw filesystem exceptions.
- **Acceptance criteria:** Invalid-syntax tests assert span/line/column in human
  and JSON modes; missing-input tests assert a typed code and no raw path leakage
  beyond the project; all error codes are documented; JSON remains one document.
- **Dependencies/blockers:** Parser error propagation; CLI error schema.
- **Effort:** M.
- **Required for v1.0:** **Yes.**

#### P1-5. Bound external dependency drift and verify clean consumer installs

- **User problem:** Published packages use ranges for external runtime
  dependencies (`prettier ^`, `@babel/parser ^`, `oxc-parser ^`, tree-sitter
  ranges); consumers do not get the repository lockfile, so an install may resolve
  versions that were never tested.
- **Evidence/subsystem:** package manifests; release report isolated install (149
  packages); no CI consumer matrix.
- **Proposed outcome:** Decide and enforce a policy: exact-pin runtime
  dependencies, or test the allowed range in CI with a generated consumer
  lockfile. Publish a documented consumer install check.
- **Acceptance criteria:** A clean consumer install from the packed/public
  packages resolves the documented set; a matrix pins or tests ranges; dependency
  changes require a documented review; install does not execute untrusted project
  lifecycle scripts.
- **Dependencies/blockers:** P1-2 CI; maintainer policy on dependency ranges.
- **Effort:** M.
- **Required for v1.0:** **Yes.**

#### P1-6. Make partiality and validation claims machine-readable and unambiguous

- **User problem:** A partially translated file can carry claim 3 while containing
  unsupported markers; consumers reading only `claimLevel` may infer more than the
  run proves.
- **Evidence/subsystem:** sampled unsupported metaclass/eval cases; report schema
  and CLI summary; docs already say claim levels are not semantic proof.
- **Proposed outcome:** Add explicit machine-readable status (`partial`,
  `unsupportedCount`, `claimBasis`) and make the human headline say “validation
  claim 3; partial translation” rather than an unqualified claim. Do not raise the
  semantic claim; keep the ladder evidence-based.
- **Acceptance criteria:** JSON schema and CLI tests assert partial/unsupported
  fields; unsupported output cannot be reported as fully translated; docs and
  help explain the distinction; claim-level tests remain unchanged in meaning.
- **Dependencies/blockers:** Report schema versioning; fixture updates.
- **Effort:** S/M.
- **Required for v1.0:** **Yes.**

#### P1-7. Exercise the strict validation path end-to-end

- **User problem:** Strict Docker/Podman mode is implemented but a full S4–S7 run
  inside an operator-provided toolchain image has not been exercised; gVisor is
  detect-only.
- **Evidence/subsystem:** release report and validation limits; real Docker test
  uses `fedora:44` for the driver, not a complete toolchain image.
- **Proposed outcome:** A documented, reproducible strict image and CI job (or a
  documented manual acceptance run) covering S4–S7; gVisor either tested or
  explicitly optional and unsupported.
- **Acceptance criteria:** A clean project reaches the documented stages in the
  strict image; failures are classified as infrastructure vs source; no host
  fallback; image digest/pull policy documented; gVisor status is explicit.
- **Dependencies/blockers:** CI/container operator; image build and registry
  authorization; may be an operator acceptance rather than default CI.
- **Effort:** M/L.
- **Required for v1.0:** **Yes** if v1.0 claims strict validation; otherwise the
  strict claim must remain explicitly conditional.

### P2 — high-value improvements

#### P2-1. Decide and document mutable-default semantics

- **User problem:** Python shared mutable defaults are intentionally re-evaluated
  per call in generated JS; a warning is emitted, but this is a behavioral
  divergence rather than an explicit mode.
- **Evidence/subsystem:** sampled `def f(x=[]): ...`; `CTW-MUTABLE-DEFAULT`;
  language-support limitations.
- **Proposed outcome:** Either preserve Python shared-default semantics or expose
  an explicit fidelity mode; classify the decision in the ledger and docs.
- **Acceptance criteria:** Executed fixture distinguishes shared vs re-created
  default behavior; report clearly labels the chosen semantics.
- **Effort:** M.
- **Required for v1.0:** **No**, if the documented divergence is accepted.

#### P2-2. Define reverse project/test-translation scope

- **User problem:** Reverse directions cap at claim 3 because vitest→pytest test
  translation is deferred; project S5/S6 cannot validate Python output.
- **Proposed outcome:** Explicitly declare reverse project/test translation as out
  of v1.0 scope, or implement the mapper and extend S5/S6. Do not leave the
  supported matrix ambiguous.
- **Acceptance criteria:** Support matrix and release gate state the scope; tests
  assert claim caps and skipped reasons; no unverified equivalence claim.
- **Effort:** L if implemented; S if explicitly out of scope.
- **Required for v1.0:** **Depends on the chosen scope**; the disclosure is required.

#### P2-3. Stabilize wall-clock-sensitive tests

- **User problem:** The Anthropic adapter’s 5-second timeout failed under host load
  during release verification and passed in isolation/final runs.
- **Proposed outcome:** Increase bounded headroom or use a deterministic
  non-wall-clock synchronization stub; keep the timeout test for the actual
  timeout contract.
- **Acceptance criteria:** Repeated loaded-suite runs do not flake; the test still
  proves timeout behavior; CI uses the same settings.
- **Effort:** S.
- **Required for v1.0:** **Yes** (CI stability).

#### P2-4. Complete package registry metadata and documentation index

- **User problem:** Published packages lack `description`, `repository`, and
  `homepage`; npm pages are minimal. `PROJECT_STATE` has a few historical rows
  that still say “nothing published.”
- **Proposed outcome:** Add maintainer-approved metadata once the repository URL
  exists; correct stale historical rows without rewriting release history.
- **Acceptance criteria:** All 11 manifests carry consistent metadata or explicitly
  document its absence; docs links resolve; release history remains accurate.
- **Effort:** S.
- **Required for v1.0:** **No**, presentation only.

#### P2-5. Broaden benchmark and real-world corpus evidence

- **User problem:** Benchmarks cover a small original corpus and correct/claim
  metrics; they do not establish broad real-world translation quality.
- **Proposed outcome:** Add a curated, licensed corpus and trend report; keep
  timings host-local and correctness assertions separate.
- **Acceptance criteria:** CI/nightly suite is deterministic for correctness;
  corpus attribution and licensing are documented; regressions are visible.
- **Effort:** L.
- **Required for v1.0:** **No**, but useful for confidence.

### P3 — optional follow-ups

- **P3-1. Clean up `0.0.0-stage` registry artifacts** if the maintainer chooses;
  this requires explicit registry authorization and must not touch `0.1.0`.
- **P3-2. Expand the stdlib/module registry** beyond the tested subset, with usage
  tests and no silent unmapped lowering.
- **P3-3. Additional languages or UI** only after the six-direction trust gate;
  explicitly out of v1.0 scope.

## 3. Milestone sequence

1. **Trust fixes:** P0-1, P1-1, P1-4, P1-6. Lock behavior with tests and regenerate
   fixtures.
2. **Reproducibility:** P1-2 and P1-5. CI, clean clone, package/consumer install,
   dependency policy.
3. **Behavioral breadth:** P1-3 and P1-7. Six-direction differential matrix,
   project S5/S6, strict image acceptance.
4. **Scope decisions:** P2-1 and P2-2. Mutable defaults and reverse validation
   boundary.
5. **Hardening:** P2-3, P2-4, P2-5. Then run the v1.0 gate.

P1-2 is deliberately early: without CI, later fixes cannot be reliably verified
across environments. P0-1 precedes broad coverage because a known silent
correctness loss invalidates confidence in the tested surface.

## 4. v1.0 release gate

`v1.0.0` may be released only when all applicable conditions below have evidence
recorded in the release report. Claim levels remain evidence-based; “v1.0” is not a
promise of universal semantic equivalence.

### 4.1 Supported matrix

- File translation: all six directions, with the documented core construct matrix.
- Project translation: Python→TypeScript and Python→JavaScript with pytest→vitest
  S5/S6 for the supported test subset. Reverse project/test translation must be
  either implemented and validated or explicitly declared out of scope.
- Runtime: Node 22.18/24 (and 26 where available); Python 3.12/3.13/3.14.
- Platform: Linux x64 with bubblewrap for executed validation; other platforms may
  translate but must report skipped/unavailable execution honestly.
- Strict mode: operator-provided image, no pulls, no host fallback; gVisor either
  tested or explicitly optional/unsupported.

### 4.2 Correctness and honesty

- No known P0/P1 silent semantic-loss defect, including the integer precision
  boundary.
- Every emitted construct has ledger provenance; unsupported constructs are
  explicit markers + warnings, never silently dropped or faked.
- Partial translations cannot be presented as complete; claim level and partiality
  are both machine-readable.
- Known divergences are documented with tests or explicit limitations.

### 4.3 Verification

- `pnpm verify` exits 0 with no skipped source tests; coverage floors hold.
- CI matrix passes, including clean clone and packed/public package install.
- Behavioral/differential fixtures cover each supported direction; project S5/S6
  pass for the supported project directions.
- Sandbox tests cover network/filesystem denials, timeouts, output caps, cleanup,
  broad-mount rejection, and fail-closed fallback.
- Strict image acceptance (if claimed) passes S4–S7 in the documented image.
- No test flake policy is violated; the suite is stable under normal CI load.

### 4.4 Packaging and release

- All 11 packages are versioned consistently; tarballs contain expected files and
  no workspace specifiers, tests, sources, caches, or credentials.
- Clean consumer install resolves declared dependencies and runs `--version`,
  `doctor`, representative translations, and a supported project run.
- Release docs, limitations, and the supported matrix match the artifact.
- Tag/registry actions are explicit, immutable, and authorized; no republish of an
  existing version.

### 4.5 Explicit non-goals / disclosed limitations

- Universal semantic equivalence is not claimed.
- New languages and GUI/IDE integration are out of scope until after v1.0.
- gVisor, live Windows CredMan, and live keychain may remain operator-dependent if
  clearly disclosed.
- Reverse test translation may remain deferred only if the support matrix and
  claim caps say so.
