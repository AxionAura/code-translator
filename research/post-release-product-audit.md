# Post-release product audit — v0.1.0

Status: **audit and planning only.** No source, package version, dependency, tag,
or registry state was changed. This audit evaluates the published `v0.1.0` code at
`main`/`716a11b`; it does not claim that `v1.0.0` is complete.

- Audit date: **2026-10-22**
- Repository: `/home/sifat/project/code-translator`
- HEAD: **`716a11b`**; annotated tag `v0.1.0` points to the same commit
- Working tree at audit start: **clean**
- Remotes: **none**
- Environment: Node `24.15.0`, pnpm `10.26.0`, Python `3.14.8`,
  bubblewrap `0.12.0`, Docker `29.9.2`
- Release facts cross-checked: eleven `@axion-ct/*` packages at `0.1.0` with
  integrity metadata and `latest=0.1.0` (registry spot-check, 11/11).

## 1. Scope and method

Read the project state, release report, release plan, architecture/validation
documentation, language-support matrix, test suites, package manifests, and the
implementation paths they describe. Ran the documented full verification, coverage,
sandbox/container tests, project goldens, published CLI version/help checks, and a
small set of representative translation and CLI experiments. Generated code was
inspected but never executed outside the sandbox; no untrusted source was run on
the host.

## 2. Verification performed

| Command or experiment | Exit | Observed result | What it establishes |
| --- | --- | --- | --- |
| `pnpm verify` | 0 | Audit baseline: 110 test files, **1091/1091 tests**; build, typecheck, lint, format, docs links | Baseline tree was internally consistent and tested before the P0 fix |
| `pnpm test:coverage -- --maxWorkers=4` | 0 | Baseline 1091/1091; core 92.07%, parser-py 91.82%, parser-js 91.74%, codegen-js 90.68%, codegen-py 90.46%, registry 94.73%, ai 91.64%, repair 95.09%, validator 94.94%, sandbox 86.39%, CLI 82.56% lines | Coverage floors held; sandbox/CLI have no floor |
| `vitest run packages/sandbox/test/{sandbox,container}.test.ts` | 0 | **31/31**, including a real Docker `fedora:44` run and the synthetic sentinel test | Host bwrap boundary and container refusal/run paths exercised in this environment |
| `vitest run tests/golden-projects.test.ts` | 0 | **4/4**, three project fixtures at claim 5 plus the isolation-refusal path | Project S5/S6 behavior is exercised for the supported Python project path |
| `npm exec --yes --package=@axion-ct/cli@0.1.0 -- ctrans --version` | 0 | `0.1.0` | Published CLI is retrievable and reports the expected version |
| `... -- ctrans --help` | 0 | Expected commands/options | Published command surface is present |
| `ctrans doctor --json` | 0 | Node/Python/bwrap available; network isolation enforced; filesystem allowlist; strict available | Current host satisfies the required capability probes |
| Registry spot-check (11 packages) | 0 | All version `0.1.0`, integrity present, `latest=0.1.0` | Release metadata is still current |

The 113 `.test.ts` files on disk include three pinned translated test files under
`tests/fixtures/**`; the root Vitest configuration deliberately excludes that
directory, yielding the 110 executed test files.

### Representative behavioral experiments

| Case | Exit | Observed | Interpretation |
| --- | --- | --- | --- |
| Python metaclass class, `check --to ts` | 3 | Claim 3; file `partially-translated`; 2 `unsupported`; `CTW-UNSUPPORTED-*`; explicit marker comments | Unsupported handling is loud and reportable |
| Python `eval(...)`, `check --to ts` | 3 | Claim 3; 1 `unsupported`; `CTW-UNSUPPORTED-CALL-BUILTIN` | Declared non-goals are not silently translated |
| JS `for (;;)`, `check --to py` | 3 | Claim 3; 2 `unsupported`; `CTW-UNSUPPORTED-JS-CONSTRUCT` | Reverse unsupported behavior is loud |
| Invalid Python syntax | 1 | `ctrans: invalid syntax`; JSON `{code:"PY-SYNTAX",message:"invalid syntax"}` | Failure is typed but **has no source span/line/column** |
| Unknown CLI option | 2 | `ctrans: unknown option ...` | Usage errors use the documented exit code |
| `check --json` | 0 | One parseable JSON document on stdout; empty stderr | JSON stdout discipline holds |
| Project with no tests | 0 | Claim 3; S4 pass; S5/S6/S7 `skipped(reason)` | Missing tests are not treated as passing evidence |
| `2 ** 53 + 1` → JS/TS default number mode (pre-fix) | 0 | Emitted `2 ** 53 + 1`; **no warning**; decisions all deterministic; claim 3 | **Silent precision loss** found by the audit |
| `2 ** 100` and annotated `x: int = 2 ** 100` (pre-fix) | 0 | Emitted plain exponentiation; **no warning**; claim 3 | Same precision gap found by the audit |
| Integer literal above safe range | 0 | `CTW-NUM-INT-ARBITRARY-PRECISION` | Literal case is warned |
| `1 << 60` | 0 | `CTW-NUM-BITWISE` | Bitwise warning path works |
| Dict integer-like keys | 0 | `CTW-DICT-KEY-COERCION` | Known ordering/coercion gap is surfaced |
| Tuple value | 0 | `CTW-TUPLE-ARRAY` | Immutability gap is surfaced |
| Mutable Python default | 0 | Output re-creates the default per call; `CTW-MUTABLE-DEFAULT` | Deliberate divergence is warned, not silent |

## 3. Findings by subsystem

### 3.1 Translation correctness and semantic gaps

**P0 — default integer exponentiation can silently produce wrong values.**
`x = 2 ** 53 + 1` and `x = 2 ** 100` are emitted as JavaScript `2 ** 53 + 1` /
`2 ** 100` in the default `number` mode. The report has no warning and the ledger
classifies both operations as `deterministic`; the example evaluates incorrectly
in JS (the `+ 1` is lost at this magnitude). The documented literal and bitwise
warnings do not cover exponentiation or constant arithmetic. `--int-mode bigint`
is an exact alternative, but it is opt-in and claims only level 1 for JS output.
This is a correctness issue, not merely a polish item.

**P0 remediation (2026-10-22, unreleased working tree).** Root cause:
`lowerBinOp` recorded `Pow`/`Add`/`Sub`/`Mult` and unary `USub`/`UAdd` as
deterministic whenever both operands looked numeric; only literal and bitwise
checks existed. `packages/core/src/pipeline.ts` therefore reported a claim based
on S1–S3 while the emitted number expression could lose precision.

The fix adds `constIntegerInfo` in `packages/codegen-js/src/lower.ts`, an exact
BigInt analysis of constant integer `Add`/`Sub`/`Mult`/`Pow`/`FloorDiv`/`Mod` and
unary `USub`/`UAdd`. It tracks three things: the exact value, whether the value is
outside JavaScript's safe-integer range, and whether any final/intermediate value
is not exactly representable by float64. Unsafe expressions are now `semantic`
with `CTW-NUM-INT-ARBITRARY-PRECISION`; safe boundary cases such as `2 ** 53 - 1`
remain warning-free, and an enclosing safe result suppresses a boundary
subexpression warning (e.g. the `2 ** 53` inside `2 ** 53 - 1`). `intMode=bigint`
remains exact, deterministic, and warning-free. NUMBER-token detection keeps
integral float literals (`2.0`) as JS numbers in both modes (including bigint-mode
type inference) and preserves hex integers containing `e` (`0x1e2`) as integers.
Dynamic/runtime exponentiation still routes through the semantic helper; indirect
runtime values are not value-tracked.

Regression evidence: `packages/codegen-js/test/integer-precision.test.ts` and
`tests/integer-precision-report.test.ts` cover both JS/TS targets, both int modes,
`2 ** 53 - 1`/`2 ** 53`/`2 ** 53 + 1`/`2 ** 53 - 2`, negative safe-integer
boundaries, add/sub/mult/pow/floor-div/mod/negation, hex and large literals,
integral float literals and bigint inference, negative and very large exponents,
runtime-unknown exponents, warning/classification/report/claim behavior. A
sandbox-backed test also executes source Python and generated JavaScript for the
exact `2 ** 53 - 1` boundary in number mode and `2 ** 100` in bigint mode,
comparing outputs without host execution. Full suite: **113 files, 1116/1116
tests**; coverage floors held (codegen-js 90.86%). The published v0.1.0 tarballs
still contain the pre-fix behavior. A v0.1.1 release candidate with all eleven
packages and the P0 fix is prepared locally but **not published**; see
[docs/release-notes-v0.1.1.md](../docs/release-notes-v0.1.1.md).

**Reviewed but not fixed in this patch.** Exceptional exponentiation remains a
separate pre-existing numeric-semantics gap: `0 ** -1` routes through
`__ctrans_pow` and returns JavaScript `Infinity` instead of Python's
`ZeroDivisionError` in number mode; huge-constant comparisons and indirect
runtime integer values are also outside this constant-analysis patch. These are
not introduced by the precision fix and must not be read as complete numeric
soundness.

**Verified and documented gaps.** Dict integer-key ordering/coercion, tuple
immutability, dynamic float formatting, Python shared mutable defaults, and
unsupported constructs are warned or explicitly documented. The audit did not
find these being silently dropped in the sampled cases.

**Unsupported classification is generally honest.** Sampled unsupported
metaclass, `eval`, and general `for(;;)` cases produced explicit markers,
`unsupported` counts, `partially-translated` status, and exit 3.

### 3.2 Provenance and version identity

**P1 — generated output and reports still say `0.0.0`.** Generated headers print
`Code Translator 0.0.0`, and `TranslationReport.generator.version` is hardcoded to
`"0.0.0"` in `packages/core/src/pipeline.ts`; the codegen header constant is also
`"0.0.0"` in `packages/codegen-js/src/translator.ts`. The CLI and packages are
`0.1.0`. This does not change runtime behavior, but it breaks provenance and
fixture/report traceability and makes version-based consumer diagnostics
misleading. Golden fixtures currently pin `0.0.0`, so correcting it requires a
reviewed golden update and a test tying generator identity to the package version.

### 3.3 Validation claims and test evidence

- The claim ladder is implemented and guarded: skipped/warn never count as pass,
  S4 executed failure caps at 3, S7 is outside the ladder, and evidence validation
  rejects inconsistent reports. `pnpm verify` includes those tests.
- **A partially translated file can still carry claim 3** because S1–S3 pass while
  unsupported constructs are emitted as markers. The report and CLI do show
  `partially-translated` and unsupported counts, but automation reading only
  `claimLevel` can mistake the number for semantic completeness. This needs
  clearer machine-readable partiality, not necessarily a different ladder.
- **Behavioral evidence is asymmetric.** The three project goldens exercise
  Python→TypeScript with pytest→vitest S5/S6. Reverse directions have three
  browser/Node behavior differentials plus a Python→TS→Python round trip, but
  there is no equivalent S5/S6 behavioral suite for Python→JavaScript or for
  Python output. Reverse validation is explicitly capped at claim 3; reverse test
  translation remains deferred.
- S7 is opt-in and was skipped in the audited project run; the release report
  correctly does not present that as integration verification.

### 3.4 Diagnostics and CLI usability

- Exit-code discipline is good in the sampled surface: 0 success, 1 failure,
  2 usage, 3 partially translated.
- JSON mode emits exactly one parseable document on stdout with diagnostics on
  stderr in the sampled cases.
- **P1/P2 — errors lack actionable source locations.** `PY-SYNTAX` contains only
  `"invalid syntax"`; there is no file/line/column, offending text, or repair hint.
  A missing input reports a raw `ENOENT ... stat '...'` message rather than a
  typed, actionable input error. This limits both human and automation usability.
- `--help` and the documented options are present; `doctor` reports functional
  capabilities rather than merely checking executable presence.

### 3.5 Installation and package reproducibility

- The eleven published packages have exact internal `@axion-ct/*@0.1.0`
  dependencies; the published CLI installs and resolves in a clean project.
- **P1/P2 — external dependency drift is not bounded.** Published manifests use
  ranges such as `prettier ^3.9.9`, `@babel/parser ^8.0.6`, `oxc-parser ^0.153.0`,
  `tree-sitter-python ^0.25.0`, and `web-tree-sitter ^0.27.0`. Consumers do not
  receive the repository lockfile, so installs can resolve later versions than the
  tested lockfile. There is no consumer install matrix to detect breakage.
- The npm registry still exposes `0.0.0-stage` versions for every package; `latest`
  is `0.1.0`. This is staged-publication metadata, not a second release, but it is
  residual registry noise and a follow-up for the maintainer.

### 3.6 CI, release, and reproducibility

**P1 — there is no CI pipeline.** The repository contains no GitHub Actions,
GitLab CI, CircleCI, or equivalent workflow; only `pnpm-lock.yaml` and
`pnpm-workspace.yaml` match the config-file search. Release verification is
therefore a local-only claim. There is also **no Git remote**. The local annotated
tag exists, but nothing is pushed. A v1.0 release gate must include a reproducible
CI matrix (Node/Python versions, bwrap host, optional container job), artifact
inspection, and a clean-clone consumer test.

A separate test-stability risk was observed during release work: the Anthropic
adapter’s 5-second timeout failed under host load and passed in isolation and on
the final run. This is not a product failure, but CI needs deterministic timeout
headroom or a non-wall-clock stub for that test.

### 3.7 Sandbox and security boundaries

- The least-privilege bwrap profile and workspace-only write model are implemented;
  the synthetic sentinel, broad-root rejection, writable-mount rejection, network
  block, timeout, output-cap, and strict-container paths are covered by the 31/31
  sandbox/container run.
- Without bwrap, policy-only mode has no enforced filesystem or network boundary;
  S5/S6/S7 and Python S4 refuse, and only parse-only TypeScript S4 may proceed.
  This is documented and tested.
- Strict Docker/Podman mode requires an operator image and was exercised only with
  the local `fedora:44` test image, not with a full S4–S7 toolchain image. gVisor
  was not available and is detect-only. These remain disclosed limitations.
- Passing sandbox tests do not prove there is no escape; they establish the tested
  boundary cases and fail-closed behavior.

### 3.8 Privacy, AI, and external calls

- AI is off by default. Provider selection requires an explicit provider, and
  credentials resolve only from the environment, OS keychain, or a 0600 file;
  secret-bearing configuration keys are rejected.
- No telemetry/analytics code was found. Network calls are limited to explicit AI
  provider adapters (default provider URLs) and the documented local endpoints;
  deterministic tests use fake/loopback models. Live keychain and Windows CredMan
  were not exercised.
- The secret gate runs before outgoing AI payloads; tests cover fail-closed
  behavior. This audit did not send any source to an AI provider.

### 3.9 Documentation and examples

The release report, publication plan, README, and release instructions now agree
that `v0.1.0` is published. The support matrix and limitation sections are
detailed. The main documentation gaps are historical/stale table rows that still
say “nothing published” and the absence of a single v1.0 readiness contract; the
roadmap addresses the latter.

## 4. What the current tests do and do not establish

They establish:

- deterministic unit coverage across parsers, semantic analysis, codegen,
  registry, validation, sandbox, repair, AI contracts, and CLI;
- construct matrices for Python→JS/TS and reverse directions;
- golden translation outputs and three project S5/S6 goldens;
- sandbox boundary/fail-closed behavior;
- published CLI installation and basic command execution (release evidence).

They do not establish:

- semantic equivalence for arbitrary programs, or correctness outside the tested
  construct/workload surface;
- behavioral parity for every direction at the S5/S6 level;
- safety against every sandbox escape, or gVisor/strict-image behavior;
- reproducibility across Node/Python/bwrap/container matrices, because no CI
  matrix exists;
- that consumer installs resolve the same external dependency versions as the
  repository lockfile.

## 5. Unresolved questions

1. Should default integer mode reject/warn on unprovable exponentiation and
   constant arithmetic, or should bigint become the default for Python ints?
2. Is the mutable-default divergence acceptable permanently, or should v1.0
   preserve Python's shared-default behavior?
3. Which reverse directions must have S5/S6/project validation for v1.0, versus
   remaining claim-3 with documented evidence?
4. What Node/Python/platform matrix is officially supported for v1.0, and where is
   bwrap unavailable?
5. Should external runtime dependencies be exact-pinned, or tested against ranges?
6. Who will operate the CI/registry environment, and where will the remote live?
7. Is cleanup of the `0.0.0-stage` registry artifacts required before v1.0?

## 6. Evidence boundaries

The audit did not publish, unpublish, deprecate, retag, push, or mutate any npm
registry metadata. It did not execute generated output outside the sandbox. It did
not exercise Windows/macOS sandboxing, live keychain, gVisor, or a full
operator-provided strict toolchain image. Registry availability was spot-checked
from the public registry; package integrity beyond the reported metadata was not
re-derived from every tarball in this audit.

See [v1-roadmap.md](../docs/v1-roadmap.md) for the prioritized plan and measurable
v1.0 gate.
