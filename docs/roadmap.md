# Implementation Roadmap

Status: **approved blueprint** (2026-10-06). Milestones are sequential; each has an objective, expected components, a test gate, completion criteria, and dependencies. AGENTS.md §12 (definition of done) applies to every milestone. Supporting docs: [architecture.md](architecture.md), [language-support.md](language-support.md), [validation.md](validation.md), [testing.md](testing.md).

Deliberate sequencing rationale: front-ends before semantics, semantics before codegen, Py→TS before reverse directions, AI last (the deterministic engine must be complete enough to make AI escalation meaningful and testable via fakes).

---

## M0 — Repository foundation & toolchain
**Objective.** Working monorepo: strict TS, lint, format, test runner, scripts, doc checks — no engine code yet.
**Components.** `packages/*` + `apps/cli` skeletons (empty, wired); ESLint 10 flat config; Prettier 3; Vitest 5; `pnpm verify` (typecheck+lint+test+docs-lint); CI config; `docs/` doc-index lint (all README links resolve).
**Tests.** One smoke test per package skeleton (proves runner wiring); `pnpm verify` green.
**Completion criteria.** Fresh clone → `corepack enable && pnpm i && pnpm verify` passes in one command; AGENTS.md §2-§5 rules mechanically enforced where possible (lint rules for `any`, default exports).
**Depends on.** Nothing.

## M1 — Python front-end (`@ctrans/parser-py`)
**Objective.** Python source → normalized `ParseResult` (source-shaped AST + tokens/comments + spans + symtable) via the bridge; tree-sitter fallback behind the same interface.
**Components.** `parser-py/python/bridge.py` (stdlib-only; version handshake; JSON protocol; recursion caps); TS bridge client (spawn lifecycle, timeouts, error taxonomy); AST normalization to `core` node shapes; fallback parser via `web-tree-sitter`.
**Tests.** Span fidelity (byte offsets + line/col, incl. multibyte); comment/token round-trip on a 50-file corpus; symtable snapshot tests (scopes, free vars, globals); malformed-input handling (bridge exits cleanly, typed error); interpreter version gate (3.12–3.14; t-strings → classified `unsupported`); fallback parser parity smoke tests.
**Completion criteria.** Every ParseResult serializes/deserializes losslessly; bridge never imports user modules (verified by test with a hostile fixture); corpus property test: no crash, always a report.
**Depends on.** M0.

## M2 — JS/TS front-end (`@ctrans/parser-js`)
**Objective.** Same `ParseResult` contract for JS/TS via oxc-parser; typescript@6 semantic oracle adapter (Program/Checker queries); @babel/parser fallback.
**Components.** oxc wrapper (AST normalize, comments, ranges, module map, error collection); TS adapter: `ts.createProgram`, symbol resolution, `getTypeAtLocation` queries, diagnostic extraction; checker capability detection.
**Tests.** ParseResult parity with M1 contract (spans, comments); TS-only syntax fixtures (generics, enums, decorators, satisfies); type-query snapshot tests (inference on untyped JS); oxc error-recovery on broken sources; adapter isolation test (proof no TS7 API usage — grep gate in CI).
**Completion criteria.** A single `ParseResult` type drives both front-ends; fuzz-ish test: mutated sources never crash the front-end.
**Depends on.** M0 (independent of M1; both must land before M3).

## M3 — Semantic layer & module graph (`@ctrans/core`)
**Objective.** `CommonType` v1, scope/symbol resolution over both front-ends, ModuleGraph with SCC/topo ordering, ModuleContracts, ledger and report schemas.
**Components.** Scope builder (Python from symtable; JS/TS from oxc+tsc binder); CommonType inference (local + annotation-driven; `unknown` honest); ModuleGraph builder (static imports; dynamic edges approximate); SCC condensation + ordering; contract extractor; JSON schemas + validators for all artifacts.
**Tests.** Scope resolution fixtures per language (closures, class-scope invisibility, comprehension scopes); type inference snapshot matrix; graph fixtures (packages, `__init__.py`, cycles, dynamic imports); schema validation round-trips.
**Completion criteria.** For any fixture project: graph order guarantees dependents-after-dependencies; contracts list exactly the export surface (verified against tsc/pyright on fixtures).
**Depends on.** M1, M2.

## M4 — Pipeline skeleton + Python→TS/JS core codegen (`@ctrans/core`, `@ctrans/codegen-js`)
**Objective.** End-to-end single-file translation for the core subset: expressions, statements, control flow, functions, classes (single inheritance), exceptions, comprehensions, f-strings, slices, with→try/finally; ledger v1; S1+S2 validation; CLI `translate` (file mode) + `check`.
**Components.** Lowering rules engine (rule registry keyed to language-support §2 ids); TS/JS emitter; prettier finalization; helper injection (`__ctrans_runtime.ts` subset: truthy, floorDiv, mod, strSlice, exception hierarchy); per-unit S1; project-less S2; claim ladder v1 (levels 1–2); provenance headers.
**Tests.** ConstructMatrix for all M4 constructs × Py→TS and Py→JS (expected outputs + expected decision classes); golden file fixtures (≥15); emitted-output re-parse assertions; prettier-idempotence test (format(format(x)) == format(x)).
**Completion criteria.** `ctrans check file.py --to ts` produces accurate ledger + warnings; `ctrans translate` output passes S1+S2 on all fixtures; claim ladder asserted in every golden manifest.
**Depends on.** M3.

## M5 — Runtime semantics depth + registry v1 (`@ctrans/codegen-js`, `@ctrans/registry`)
**Objective.** The hard-fidelity work: truthiness provability analysis, numeric policy (D-006) with `bigint` mode, code-point string semantics, async boundary propagation v1 (`node:fs` sync variants, `requests`→`fetch` rewire), registry v1 (dependency-mapping.md §4 scope) with usage tests.
**Components.** Provability analyzer (skip-helper when provable); `__ctrans_runtime` full helper set; `intMode=bigint` lowering; async-rewire engine (call-graph propagation over ModuleGraph); registry package (schema, data, usage tests); S3 dependency validation.
**Tests.** ConstructMatrix: truthiness edge cases (NaN/[]/{}), int overflow, floor-div/mod negatives, astral strings, slice steps, kwargs/rest; registry usage tests green in CI; async-rewire golden (signature changes recorded in ledger); S3 negative tests (unmapped dep → exact warning).
**Completion criteria.** Zero known-incorrect silent behaviors: every verified divergence from language-support §2 either handled or classified; registry entries all test-backed.
**Depends on.** M4.

## M6 — Project mode + test translation + differential runner (`@ctrans/core`, `@ctrans/validator`, `apps/cli`)
**Objective.** Multi-file project translation: `__init__.py`→index, import rewriting from graph, manifest generation, pytest→vitest basic mapping, sandboxed S5/S6 execution, claim ladder to level 5, `.ctrans/` artifacts.
**Components.** Project orchestrator (ordering, per-unit pipeline); sandbox package v1 (hardened spawn + prlimit + bwrap autodetect, capability report); vitest project scaffolding for output; pytest→vitest mapper (test/parametrize/assert basic); differential comparator; RunReport CLI rendering.
**Tests.** 3 golden mini-projects (pure stdlib, no network) translated + validated to claim level 5 in CI; sandbox negative tests (timeout kill, output caps, no-network verification); capability-skip tests (no bwrap → skipped-with-reason, never failure); pytest→vitest ConstructMatrix (incl. unsupported monkeypatch warning).
**Completion criteria.** A fixture project with tests shows source-vs-target equivalence report; sandbox refuses network by default (verified); claim ladder ≤5 enforced by tests.
**Depends on.** M5.

## M7 — Reverse directions: JS/TS → Python (+ TS→JS, JS→TS) (`@ctrans/codegen-py`)
**Objective.** Python emitter + reverse lowering; TS→JS and JS→TS through the same pipeline; graded direction matrix documented (language-support §3).
**Components.** Lowering rules (reverse table); Python emitter + `ruff format` finalization; `__ctrans_runtime.py`; pyright-based S2 for Python output; TS→JS erasure path; JS→TS honest-types path.
**Tests.** ConstructMatrix reverse goldens for every M4/M5 construct; round-trip property tests (Py→TS→Py structural equivalence on the ConstructMatrix subset — known-lossy cases enumerated, not hidden); pyright validation green on all Python-output goldens; direction matrix docs updated same-commit.
**Completion criteria.** All 6 directions produce S1-valid output for the full ConstructMatrix; reverse claim ladder asserted in goldens.
**Depends on.** M5 (not M6 — can parallelize with M6 if needed, but sequential by default).

## M8 — AI layer (`@ctrans/ai`)
**Objective.** Provider-agnostic ChatModel with adapters; prompt packer (module-contract subgraphs, token budgets); `resolveAmbiguity` escalation wired into pipeline; secret gate; caps/cache/journal.
**Components.** Interface + OpenAI-compatible/Anthropic/custom adapters; FakeChatModel; packer with deterministic budgeting; secretlint-based pre-send gate; caps enforcement; ledger `escalation` refs.
**Tests.** Fake-model tests: option-selection contract, malformed JSON re-ask then fallback, injection attempts (model tries to emit commands → rejected), caps exhaustion → deterministic degradation; packer budget tests; secret-gate blocking tests; zero-network proof (CI asserts no outbound calls in default mode).
**Completion criteria.** With AI disabled, full pipeline behavior identical to M7 (byte-identical goldens); with FakeChatModel, ambiguity escalation end-to-end tested; no provider SDK types outside `@ctrans/ai`.
**Depends on.** M6.

## M9 — Repair loop (`@ctrans/repair`)
**Objective.** Bounded, observable repair: classification → root-cause → scoped patch → re-validation, with loop detection and revert-on-regression.
**Components.** Failure classifier (validation.md §8 codes); repair orchestrator (caps: 3/unit, 8/run default); state-hash loop detection; monotone validation guard + auto-revert; patch journal (`.ctrans/repairs/`); CLI reporting of repair history.
**Tests.** Scripted failure suites (each V-* code) repaired by FakeChatModel; loop-detection test (same failure twice → exhausted, reported); regression test (patch breaks S5 → reverted, history shows revert); cap tests; diff-apply validation tests.
**Completion criteria.** Every repair-path test passes with AI disabled producing "repair unavailable" degradation; repair never violates monotonicity in any test.
**Depends on.** M8.

## M10 — Validation engine completion (`@ctrans/validator`)
**Objective.** Full S1–S7 pipeline with capability matrix, flaky policy, differential polish, strict sandbox mode (docker/podman driver), doctor command.
**Components.** Stage orchestration + claim ladder final; docker/podman driver (gVisor-optional); `ctrans doctor`; flaky rerun-once; S7 smoke harness.
**Tests.** Stage×capability matrix tests (every skip reason exercised); claim-ladder pure-function tests; strict-mode refusal test (no daemon → error, not downgrade); validator-on-validator negative suite.
**Completion criteria.** `ctrans doctor` output matches observed environment in CI containers (with and without docker); all validation.md claims have tests.
**Depends on.** M6 (sandbox v1), M9.

## M11 — CLI hardening, benchmarks, release prep
**Objective.** Product-quality CLI, benchmark suite live, docs current, security review pass, v0.1.0 ready.
**Components.** Full CLI surface (`translate/check/validate/doctor/benchmark`), config schema + validation, progress events, error UX; benchmark suites (micro always; mini-projects + perf nightly scripts); corpus + ATTRIBUTION; security review checklist executed (security.md §1 threats each mapped to a test or doc).
**Tests.** E2E CLI tests (all commands, exit codes, report files); benchmark harness self-test (deterministic micro suite); perf smoke (500-file synthetic < budget); docs-link lint.
**Completion criteria.** README quickstart works from a clean clone; all milestones' DoD items re-verified; final report states exactly what works and what remains.
**Depends on.** M10.

---

## V2/V3 backlog (deliberately deferred)
- Web UI (local server) and/or VS Code extension (D-013).
- `unsupported` promotions: metaclasses (via opt-in Proxy emulation), descriptors, `except*` decomposition, class-pattern `match`, `__hash__`-based keying.
- Registry expansion beyond V1 scope; community mapping contributions.
- gVisor/WASM execution paths; Landlock integration (npm story immature — verified).
- Multi-repo workspaces; monorepo build systems (bazel/nx) awareness in ModuleGraph.
- Additional language family (triggers D-002 revisit).
