# Code Translator — Project State

> Canonical handoff document. An AI reading **only this file** must understand the project and be able to produce the next engineering prompt. Detailed design lives in `docs/` (linked, not duplicated). Maintenance rules: `AGENTS.md` §13.
> Last updated: **2026-10-18** (M5 — runtime semantics depth + dependency registry v1 — complete; every claim below verified in this working session).

## 1. Project Identity

- **Project name:** Code Translator
- **Current version:** 0.0.0 (no release yet)
- **Current milestone:** **M5 — runtime semantics depth + dependency registry v1: complete** (2026-10-18; `pnpm verify` green, **618/618 tests, 58 files**; all coverage floors met including codegen-js 90.19% ≥ 90). Next: **M6 — project mode + test translation + differential runner**.
- **Overall status:** Python → JS/TS translation now carries M5 runtime-semantics depth: `intMode=bigint` (exact Python ints), code-point string semantics (len/index/compare/slice), the truthiness provability analyzer, Python-exact float `str()`, the dependency registry v1 (10 builtins + 32 method entries + 5 modules, all usage-tested, injected through the D-017 `RegistryLookup` interface), sync→async boundary propagation (`requests`→`fetch` with graph-wide signature recording), and S3 dependency validation (claim ladder to level 3). M4's audited surface is intact; reverse directions, sandbox-based stages, test translation, and AI remain later milestones.

## 2. Product Goal

A serious developer tool that translates source code and complete multi-file projects between **Python, JavaScript, and TypeScript** (all 6 directions) while preserving behavior as accurately as technically possible — and that **honestly reports** what was translated deterministically, what was adapted semantically, what was ambiguous, and what was unsupported. It never presents an unvalidated translation as correct. Long-term: extensible to additional languages.

## 3. Current Scope

**Designed and approved for V1**:
- Single-file and project-level translation, 6 directions with a graded support matrix.
- Core construct matrix (expressions, control flow, functions, classes, exceptions, comprehensions, f-strings, slicing, generators, decorators-as-application, async syntax; explicit `unsupported` list: metaclasses, descriptors, `except*`, class-pattern `match`, threads, etc. — see `docs/language-support.md` §4).
- Dependency mapping registry v1 (~15 stdlib modules, `requests`→`fetch`, `pytest`→`vitest` basic).
- Validation pipeline (syntax → types → dependencies → build → tests → differential) with a "claim ladder".
- Bounded, AI-optional repair loop. CLI. Fixture + benchmark infrastructure. Sandboxed test execution.

**Explicitly deferred** (decisions D-002/D-013 in `docs/decisions.md`): no universal IR (a Semantic Layer replaces it — see §9/§16); **no GUI in V1** (CLI-first; web UI/VS Code extension deferred to V2 — documented deviation from the original "Basic GUI" V1 requirement).

## 4. Architecture

Target architecture (approved blueprint, `docs/architecture.md`):

```
Source Project
  → Project Analysis (ModuleGraph: imports, SCCs, topo order, entry points, tests)   [M3: implemented]
  → Parsing            [Python: CPython stdlib bridge (ast+symtable+tokenize→JSON), tree-sitter fallback]  [M1: implemented]
                       [JS/TS: oxc-parser, @babel/parser fallback]                    [M2: implemented]
  → Semantic Layer     (CommonType model, symbol/scope resolution, ModuleContracts)   [M3: implemented]
  → Lowering + Code Generation (per direction; TransformationLedger records EVERY decision as
      deterministic | semantic | ambiguous | unsupported)                             [M4: implemented for py→js/ts]
  → Dependency Mapping (in-repo registry + heuristics + AI proposals)
  → Test Translation   (pytest↔vitest, best effort)
  → Validation Engine  (S1 syntax → S2 types → S3 deps → S4 build → S5 tests → S6 differential; each
      stage = pass|fail|warn|skipped(reason); "claim ladder" caps what may be asserted)
  → Bounded AI-assisted Repair → Re-validation
  → Final Target Project + Reports (.ctrans/ ledger, source map, validation report, repair journal)
```

Monorepo layout: `packages/{core,parser-py,parser-js,codegen-js,codegen-py,registry,validator,sandbox,repair,ai}`, `apps/cli` (binary `ctrans`). Dependency direction acyclic (ADR D-017): `core` is the base type layer; implementation packages depend on core and strictly lower layers; `apps/cli` wires concrete implementations. Enforced by `scripts/workspace-boundaries.test.ts`.

## 5. Technology Stack

| Area | Decision | Status |
| --- | --- | --- |
| Frontend | **None in V1** — CLI only (D-013); UI deferred to V2 | Decision made; nothing built |
| Engine | TypeScript (strict) on Node ≥22.18, pnpm 10.26.0 monorepo (D-001) | Implemented: 12 workspace projects, `tsc --noEmit` green (TS 6.0.3) |
| Python parser | `python3` subprocess bridge over stdlib `ast`/`symtable`/`tokenize` → JSON; `web-tree-sitter` fallback (D-003, D-018, D-021) | **Implemented** (protocol v1 incl. module info; verified on Python 3.14.7) |
| JS/TS parser | `oxc-parser` primary + `@babel/parser` fallback behind `JsParser`; `typescript@6` semantic oracle behind `TsSemanticOracle` (D-004, D-019, D-020) | **Implemented** (oxc-parser 0.153.0, @babel/parser 8.0.6, typescript 6.0.3) |
| Semantic layer | **No universal AST IR** (D-002): `CommonType` + `AnnotatedType` provenance, scope/symbol resolution per language, `ModuleGraph` (resolution + Tarjan SCCs + deterministic ordering), `ModuleContracts` | **Implemented** (M3, in `@ctrans/core`) |
| Ledger/reports | `TransformationLedger` schema (4 decision kinds, escalation provenance) + `TranslationReport` schema (claim ladder 0–5) | **Implemented** (schema + validation; producers live in the M4 pipeline — every emitted construct carries an entry) |
| Output checkers | `tsc --noEmit` (typescript@6) for TS; pyright CLI `--outputjson` (pinned) + optional mypy for Python (D-005) | **S2 implemented** for TS targets via the pinned typescript@6 oracle (whole-program, virtualized cross-module resolution); pyright for Python targets arrives with reverse directions (M7) |
| Database | None (file/JSON artifacts under `.ctrans/`) | — |
| Sandbox | Hardened `spawn` + `prlimit` + auto-detected bubblewrap; Docker/Podman strict mode opt-in (D-009) | Not implemented |
| AI | Provider-agnostic `ChatModel` interface; OpenAI-compatible/Anthropic/custom adapters; 3 escalation ports only; offline default (D-010) | Not implemented |
| Registry | `@ctrans/registry` v1 (D-011): 10 builtins, 32 method entries, 5 modules; consumed via the core `RegistryLookup` interface (D-017 injection) | **Implemented** (M5) — every entry usage-tested (`registry-usage.test.ts`); structural invariants pinned (`registry.test.ts`) |
| Validation stages | S1 syntax (oxc), S2 types (typescript@6 oracle), S3 dependencies (registry/graph verdicts) | **S1+S2+S3 implemented** (M5); S4–S7 arrive with the sandbox (M6/M10) |
| Testing | Vitest 5; golden fixtures (`tests/fixtures/`), ConstructMatrix, benchmarks (D-012) | Implemented: Vitest 5.0.5 + coverage-v8, **618/618 tests green** in `pnpm verify` (58 files); `pnpm test:coverage`; `pnpm fixtures:accept` |

**Critical version fact (verified 2026-10-06):** TypeScript 7.0 (native Go) ships **no JS API**; all compiler-API use must pin `typescript@6` behind an adapter (CI-enforced by `scripts/ts7-guard.test.ts`) until TS 7.1's new API lands.

## 6. Repository Structure

```
AGENTS.md                     # binding engineering rules (read first; §13 = state-file rules)
PROJECT_STATE.md              # this file — the handoff contract
README.md                     # product overview + doc index
LICENSE                       # MIT
package.json / pnpm-workspace.yaml / tsconfig.base.json   # monorepo scaffolding (strict TS)
pnpm-lock.yaml                # committed lockfile (exact dependency resolution)
tsconfig.json                 # root typecheck scope (scripts/ + tool configs); each package has its own
eslint.config.js              # ESLint 10 flat config (no-any, no-default-export, unused-vars)
vitest.config.ts              # single root Vitest config (packages, apps, scripts)
.prettierrc.json / .prettierignore   # code only; *.md and tests/fixtures/ deliberately excluded
scripts/check-doc-links.mjs   # dependency-free Markdown link checker (`pnpm docs:check`) + .d.mts + tests
scripts/workspace-boundaries.test.ts  # enforces the architecture's package layer rules (D-017: core = layer 0)
scripts/ts7-guard.test.ts     # TypeScript compiler-API boundary guard (oracle adapter only; 6.x pin)
scripts/parser-contract.test.ts  # cross-frontend parser contract invariants (all four front-ends)
packages/core/                # base type layer + semantic layer: ParseResult contract, CommonType,
                              # SemanticModel (analyzeModule: scopes/symbols/resolution per language),
                              # ModuleGraph (buildModuleGraph: resolution + Tarjan SCCs + ordering),
                              # ModuleContracts, TransformationLedger + report schemas, CTransError
packages/parser-py/           # Python front-end: python/bridge.py (protocol v1), src/{client,protocol,errors,fallback,select}.ts, tests/, README.md (protocol contract)
packages/parser-js/           # JS/TS front-end: oxc primary + Babel fallback + typescript@6 oracle, src/{normalize,oxc-parser,babel-parser,module-info,ts-oracle,safety,select,validators}.ts, tests/, README.md
packages/codegen-js/          # M4 codegen: src/{context,helpers,lower,translator}.ts — lowering rules, __ctrans_runtime templates, TS/JS emitter, tests/ (ConstructMatrix, runtime semantics, translator), README.md
packages/{codegen-py,registry,validator,sandbox,repair,ai}/               # skeletons (M5+)
apps/cli/                     # CLI: runCli/runCliCommand — check/translate (file + project mode), bin/ctrans.mjs executable (Node type stripping + resolve hook)
.gitignore
human-style-code.md           # engineering-judgment style guide (provided by human; AGENTS.md defers to it where compatible)
docs/                         # research, architecture, translation-pipeline, language-support,
                              # dependency-mapping, ai-architecture, validation, security, testing,
                              # benchmarks, decisions (23 ADRs), roadmap
tests/fixtures/               # 16 golden fixtures (input/expected/manifest + notes) + tests/golden-fixtures.test.ts runner (FIXTURES_ACCEPT=1 regenerates)
docs/m4-audit.md              # independent M4 audit: evidence, defect verdicts, fixes, runtime proof
benchmarks/README.md          # benchmark scaffold (populated from M4/M11)
```

## 7. Implemented Features

| Feature | Status | Location | Validation status |
| --- | --- | --- | --- |
| Engineering blueprint + ADRs + rules | Implemented | `docs/`, `AGENTS.md` | Research source-verified 2026-10-06; ADRs D-001…D-021 |
| Monorepo toolchain (pnpm 10.26.0, TS 6.0.3, ESLint 10.12.0, Prettier 3.9.9, Vitest 5.0.3) | Implemented | root configs | `pnpm i && pnpm verify` green, fresh-clone verified |
| Python front-end — CPython bridge (protocol v1 incl. module info, D-021) | Implemented | `packages/parser-py/` | spans (multibyte/CRLF), symtable, tokens/comments, tagged constants, JSON round-trip, hostile-input security proofs |
| Python front-end — tree-sitter fallback | Implemented (degraded fidelity, documented) | `packages/parser-py/src/fallback.ts` | Parity smoke tests vs bridge; selection policy tests |
| JS/TS front-end — oxc primary + Babel fallback | Implemented | `packages/parser-js/src/` | JS/TS/JSX/TSX grammar, spans (multibyte/CRLF/BOM), comments, module-map parity, error recovery, selection policy |
| TypeScript 6 semantic oracle | Implemented | `packages/parser-js/src/ts-oracle.ts` | Export-surface/type-at queries with contract spans; refuses non-6.x |
| TS7 compiler-API boundary guard | Implemented | `scripts/ts7-guard.test.ts` | Compiler-API imports restricted to the oracle adapter; 6.x pin in manifests + lockfile |
| Native hostile-input containment (oxc segfault guard, D-020) | Implemented | `packages/parser-js/src/safety.ts` | ~8000-deep input (SIGSEGV before the fix) → typed `JsSourceLimitError`; tests green |
| **Semantic layer — CommonType v1 + provenance** | Implemented | `packages/core/src/common-type.ts` | Honest unknown/approximate/exact confidence; explicit/inferred/oracle origins; fixture matrix |
| **Semantic layer — Python scope/symbol resolution** | Implemented | `packages/core/src/semantic-python.ts` | Symtable-driven scopes; closures (free vars), globals/nonlocals, class-scope invisibility, PEP 709 inlining, conservative type inference |
| **Semantic layer — JS/TS scope/symbol resolution** | Implemented (built in core, per M3) | `packages/core/src/semantic-javascript.ts` | var hoisting, block/catch/loop scopes, closures, imports/exports, TS type namespaces, enum/namespace kinds |
| **ModuleGraph + SCCs + deterministic ordering** | Implemented | `packages/core/src/module-graph.ts` | Python dotted/relative + JS extension/index resolution against the file set; externals explicit; iterative Tarjan; dependency-first order; determinism tested |
| **ModuleContracts** | Implemented | `packages/core/src/module-contract.ts` | `__all__`/public-name convention (Python), export surfaces (JS/TS), oracle displays as separate provenance |
| **TransformationLedger + report schemas** | Implemented (schema + validation; producers M4+) | `packages/core/src/{ledger,report}.ts` | 4 decision kinds, escalation provenance (hash only), claim ladder 0–5; validation + round-trip tests |
| Cross-frontend parser contract tests | Implemented | `scripts/parser-contract.test.ts` | Shared invariants across all four front-ends |
| **M4: Python→JS/TS pipeline orchestration** | Implemented | `packages/core/src/pipeline.ts` | parse→analyze→graph→lower→emit→format→validate→report; ModuleGraph dependency order; golden-fixture tested |
| **M4: lowering rules + TS/JS emitter** | Implemented | `packages/codegen-js/src/{lower,translator}.ts` | ConstructMatrix (129 entries × TS/JS); Prettier finalization + idempotence |
| **M4: `__ctrans_runtime` helpers (D-007/D-022)** | Implemented | `packages/codegen-js/src/helpers.ts` | closure-based injection only-when-referenced; strip-safe sources; behavior tests on both variants |
| **M4: ledger provenance per construct** | Implemented | `packages/codegen-js/src/context.ts` + pipeline | every emission carries a validated entry; unmapped builtins = `unsupported` (marker + `CTW-UNSUPPORTED-CALL-BUILTIN`); container methods verbatim carry `CTW-METHOD-UNMAPPED`; unsupported counts as report failure |
| **M4: runtime helper semantics suite** | Implemented | `packages/codegen-js/test/runtime-helpers.test.ts` | floor-div signs, NaN truthiness, code-point iteration, KeyError/IndexError surfaces, class-vs-function `call` — TS + stripped JS |
| **M4 audit: honesty regressions + import forms** | Implemented (2026-10-18 audit) | `packages/codegen-js/test/{lowering-regressions,import-forms}.test.ts` | Python-scope binding hoisting, builtin classification, strict-typing defaults, dict Record widening, comprehension iter routing, end-to-end workflow with strict S2 + execution; barrel/sibling/external/unresolved import forms |
| **M5: intMode=bigint (D-006)** | Implemented | `packages/codegen-js/src/{lower,helpers}.ts` + CLI `--int-mode` | bigint literals/annotations/arithmetic (native where provable), `/` always float, Number-boundary conversions warned, `rangeBig`/`toIntBig`; executed TS+JS vs Python (fib(200) exact) — `bigint-mode.test.ts` |
| **M5: code-point strings** | Implemented | `helpers.ts` (len/index/compare/slice) | astral-plane parity vs Python — `m5-semantics.test.ts` |
| **M5: truthiness provability (D-016)** | Implemented | `lower.ts` (`nativeTruthyProvable`, BoolOp native chains) | provable-native vs helper-retained matrix entries + workflow tests |
| **M5: Python float str()** | Implemented | `helpers.ts` (`__ctrans_floatStr`) | 19-value Python-repr matrix (integral `.0`, `-0.0`, inf/nan, 1e16/1e-4 thresholds, 2-digit exponents) — `m5-semantics.test.ts` |
| **M5: registry v1 (D-011)** | Implemented | `packages/registry/src/index.ts` + codegen integration | 10 builtins + 32 methods + 5 modules; executed usage tests vs Python (`registry-usage.test.ts`); `NO_REGISTRY` honest fallback tested |
| **M5: async propagation (WS F)** | Implemented | `packages/core/src/async-propagation.ts` + lowering | fixpoint over ModuleGraph; golden `async-requests` fixture; executed with stubbed fetch (byte-identical results) |
| **M5: S3 dependency validation (WS G)** | Implemented | `packages/core/src/s3-dependencies.ts` + pipeline stage | distinct verdicts (emitted-local/mapped/external-verbatim/unsupported/unresolved) — `s3-dependencies.test.ts` |
| CLI: `check`/`translate` (M4) | Implemented | `apps/cli/src/{main,translate}.ts` | file + project mode; exit codes 0/1/3; `.ctrans/ledger.json` + `report.json`; e2e tests incl. executable |
| Validator wiring (S1 oxс + S2 oracle) | Implemented | `packages/parser-js/src/validators.ts` | S1 re-parse; S2 whole-program virtualized resolution; JS target S2 = skipped(reason) honestly |
| Dependency registry / sandbox / repair / AI | Not implemented | skeletons | M5–M9 |
| Documentation-link checker | Implemented | `scripts/check-doc-links.mjs` | Runs in `pnpm verify`; caught a real broken link in M0 |
| Python→TS/JS translation (M4) | Implemented | `packages/codegen-js` + `packages/core/src/pipeline.ts` | audited 2026-10-18 (`docs/m4-audit.md`): ConstructMatrix 129 entries, golden fixtures, executed output byte-identical to Python on the supported surface |
| Dependency registry / validation engine / AI layer / sandbox | Not implemented | — | — |

## 8. Current Milestone

**Milestone objective: M5 — Runtime semantics depth + registry v1** (`docs/roadmap.md` M5).
- **Status:** **complete (2026-10-18).**
- **Delivered:** (1) `intMode=bigint` end-to-end (CLI `--int-mode`, pipeline option, lowering, helpers) — exact Python ints with `/` always float and warned Number-boundary conversions; (2) code-point string semantics for len/index/compare/slice; (3) the truthiness provability analyzer (`nativeTruthyProvable` + native BoolOp chains — helper only where NaN/[]/{} diverge); (4) Python-exact float `str()` (`__ctrans_floatStr` + str/f-string routing); (5) registry v1 in `@ctrans/registry` (10 builtins, 32 methods, 5 modules — every entry usage-tested, injected via the core `RegistryLookup` interface so the D-017 layering holds; `NO_REGISTRY` reproduces the honest M4 warnings); (6) sync→async boundary propagation (`requests`→`fetch`): fixpoint over the ModuleGraph, asyncified signatures recorded per-function in the ledger, cross-unit awaits, fetch response surface, golden `async-requests` fixture, executed with a stubbed fetch; (7) S3 dependency validation with distinct verdicts and the claim ladder extended to level 3.
- **Bugs found & fixed during M5 (regression-tested):** nested-unpack TDZ (`[b, c] = temp` without declaration when the nested pattern mixed member+fresh targets); instance-field CommonType round-trip losing int/float (broke bigint native arithmetic and float f-string layout on self-fields); field declarations not intMode-aware (`count: number` with bigint assignments); duplicated tail block in lower.ts from a scripted patch (removed, 208 lines).
- **Delivered:** pipeline orchestration in `@ctrans/core` (`runPipeline`: parse→analyze→graph→translate→format→validate→report; units ordered by ModuleGraph dependency order; `finalizeUnits` post-pass emits the shared runtime from the union of all units' helper requirements); lowering rules + TS/JS emitter in `@ctrans/codegen-js` (context = per-unit ledger + helper set + annotation-driven type hints; ~50 mapping rules with per-construct ledger provenance); `__ctrans_runtime` helper templates (truthy, eq, contains, len, iter, add/sub/mul/div/floorDiv/mod/pow/neg/pos, lt/lte/gt/ge, bit*, slice/index/setIndex/getattr/setattr, call/callMethod, toInt/toFloat, str, sum, print, range + generated Python-exception hierarchy) with transitive-closure injection — only referenced helpers are emitted; Prettier finalization (idempotence tested); S1 re-parse + S2 whole-program oracle validation with honest `skipped(reason)` for JS targets; claim ladder v1 (levels 0–2) asserted in every golden manifest; ConstructMatrix (129 entries × TS/JS directions, expected decision class asserted per entry, unsupported entries assert marker + warning); 16 golden fixtures with manifest-asserted claim/decisions/warnings and `pnpm fixtures:accept` regeneration workflow; CLI `check`/`translate` (file + directory project mode, exit codes 0/1/2/3, `.ctrans/ledger.json` + `report.json`).
- **Audit fixes (2026-10-18, regression-tested):** unmapped Python builtin calls reclassified `unsupported` with markers + `CTW-UNSUPPORTED-CALL-BUILTIN` (were silent bare identifiers claiming `deterministic`); Python-scope binding hoisting (first assignment inside a nested block hoists `let` to scope top — block-scoped `let` broke function/module-scope semantics); unannotated method/constructor params typed `unknown` (were implicit any, breaking strict S2); fresh empty-list bindings `: unknown[]`; fresh dict-literal bindings `: Record<string, V>` (open mapping — later key writes type-check); unpack bindings inherit known RHS element types else `unknown` (parallel rebind `a, b = b, a + b` stays legal); comprehensions over non-array iterables rerouted via `Object.keys`/`__ctrans_iter` (were `.map` on `unknown`); container-method verbatim calls now carry `CTW-METHOD-UNMAPPED`.
- **In progress:** nothing.
- **M6 (next):** project mode + test translation + differential runner (`docs/roadmap.md` M6): `__init__.py`→index, pytest→vitest mapping, sandbox v1 (hardened spawn + bwrap autodetect), S5/S6 stages, claim ladder to level 5.

## 9. Important Technical Decisions

Full log: `docs/decisions.md` (23 ADRs). The ones another AI must not accidentally reverse:

| Decision | Reason | Alternatives considered & rejected |
| --- | --- | --- |
| D-001 TS/Node engine (pnpm monorepo) | in-process oxc + tsc Checker; both runtimes needed for validation anyway | Python engine (worse JS/TS API access); Rust (slower iteration, unneeded speed) |
| D-002 **No universal AST IR** — Semantic Layer instead | prior art (Transcrypt, metapensiero.pj, Babel) all do AST→AST + thin semantic layer; IR loses idiom fidelity; no N×M payoff at N=3 | Universal IR (rejected: design risk, comment/provenance loss). Revisit only if a non-JS/Python language family is added |
| D-003 Python parsing via CPython stdlib bridge | reference semantics, always matches interpreter, free symtable | Reimplementing Python parsing in JS (dead-end per prior art); tree-sitter primary (CST-only, no scopes, grammar lag → fallback only) |
| D-004 oxc-parser + typescript@6 oracle | TS 7.0 verified to ship no JS API; oxc: ESTree + error recovery + MIT | SWC (non-ESTree AST); Esprima (dormant); Acorn (no TS) |
| D-006 int→`number` default + precision diagnostics; `bigint` opt-in | Transcrypt precedent; BigInt can't mix with Number | bigint-by-default (ecosystem-hostile); revisit trigger documented |
| D-007 helpers codegen'd into output; zero runtime deps | local-first, no supply chain in user projects | runtime npm package |
| D-009 hardened spawn + bwrap autodetect; Docker strict opt-in | only realistic no-root cross-distro isolation (verified) | firejail (suid CVE history); systemd-run (no non-root network isolation); Docker-required (kills local-first) |
| D-010 AI = 3 escalation ports only, provider-agnostic, offline default | deterministic-first principle; OWASP LLM v2 | LLM-centric translation (verified ~27% naive correctness) |
| D-011 dependency mapping = registry + heuristics + AI proposals; entries must have usage tests | no public machine-readable stdlib→Node dataset exists (verified); AI-only is unverifiable | pure-AI mapping; pure-heuristics |
| D-012/D-015 canonical formatters finalize all emitted code (prettier/ruff format) | stable reviewable goldens; idiomatic output | hand-formatted emitters (churn) |
| D-013 CLI-first, no GUI in V1 | validate engine value first | Electron/Tauri/web UI now |
| D-017 package layering: core = base type layer | AGENTS.md requires cross-package types in core; parsers normalize into core shapes; the old `core → parser-*` arrow was internally inconsistent | Original arrow (would create cycles) |
| D-018 bridge protocol: one-shot JSON over stdin/stdout | deterministic, versioned, crash-isolated per file, no user-code execution surface | Persistent-process RPC (unneeded complexity; batching can be protocol v2) |
| D-019 ParseResult: comments + module fields; JS emits comment-only tokens; `error` severity | M2 needs comments/module info; oxc recovery yields error-level findings; no JS token stream exists or is needed | Overloading `tokens` for JS comments (misleading); inventing a universal token model |
| D-020 depth screening before the native oxc call | verified: ~8000-deep input SIGSEGVs the process via oxc; no depth option exists; hostile input must never crash the host | Subprocess-per-parse containment (heavy); raw-scan-only (bypassable); Babel-first ordering (loses oxc recovery/metadata) |
| D-021 Python bridge emits module info (protocol v1, additive) | ModuleGraph needs import edges from both families; JS already had a parser-level map | Extracting Python imports in the graph builder from raw ASTs (duplicates parser responsibility) |
| D-022 JS runtime helpers: one TS source + Node type stripping | strict tsc needs typed helpers; JS targets need valid plain JS; hand-maintained twins would drift | Hand-maintained JS twins (drift); shipping @babel transform (extra dep); runtime npm package (D-007 violation) |
| D-023 M4 dynamic operands: helpers over silent coercion | TS can't compile ops on `unknown`; JS operators silently diverge (coercion, missing keys); the M5 provability analyzer will thin helpers where types prove equivalence | Implicit-`any` escape (dishonest); blanket BigInt; inventing types |

## 10. Translation Pipeline

- **Current actual pipeline:** full M4+M5 chain is real for py→js/ts: `source → ParseResult → analyzeModule → SemanticModel`; `buildModuleGraph` orders units; async-boundary propagation when a sync-to-async module participates; lowering+emission with per-construct ledger entries (registry lookups injected via `RegistryLookup`); Prettier finalization; S1 re-parse + S2 whole-program oracle validation + S3 dependency validation (registry/graph verdicts); claim ladder + report. Test translation (7) and sandboxed execution (9) are M6+.
- **Determinism guarantee:** lowering, emission, formatting, and validation are deterministic with AI disabled (double-run equality is golden-tested); the future AI-repair stage re-enters deterministic validation.
- **Per-unit detail (docs/translation-pipeline.md §2):** context = unit AST + direct-dep ModuleContracts (via cross-unit symbol kinds); helper import list is per-unit, runtime file content is the union (emitted once in `finalizeUnits`); barrel `__init__` modules re-export their `__all__`/public names.

## 11. AI Architecture

- **AI is used (spec):** (1) `resolveAmbiguity` for engine-classified `ambiguous` constructs — must *choose among offered options*, never invent behavior; (2) `proposeRepairPatch` in the bounded repair loop (unit-scoped unified diffs, re-validated); (3) optional off-by-default idiom polish.
- **AI is not used (spec):** parsing, symbol/type resolution, lowering, codegen, dependency registry lookups, validation verdicts. CI goldens never call AI.
- **Provider abstraction (spec):** `ChatModel.complete()` interface; adapters for OpenAI-compatible endpoints (incl. Ollama/vLLM/llama.cpp), Anthropic, custom endpoints; secretlint-based hard gate before any request; caps (calls/tokens/USD/wall-clock) enforced in code; prompt payloads = unit AST + direct-dep ModuleContracts + diagnostics, token-budgeted — whole-project prompts forbidden.
- All of the above is **Not implemented**; the layer must work with AI fully disabled (offline default).

## 12. Testing

- **Framework:** Vitest 5.0.5 (single root `vitest.config.ts`; coverage via `@vitest/coverage-v8`; `pnpm test:coverage`).
- **Number of tests:** 618 (58 files; M5 added ~76: bigint-mode emission+execution suite, M5 string/float semantics suite, registry structural + usage suites, M5 workstream integration (async propagation + registry injection), two coverage batches (method-shape arms, response surface, aug-assign operators, conditional defs, nested unpack), S3 verdict suite, async-propagation unit tests).
- **Passing / Failing / Skipped:** 618 / 0 / 0 (verified 2026-10-18 via `pnpm verify`; full verify = typecheck → lint → format → tests → docs-lint).
- **Coverage (floors: core ≥85%, parser/codegen ≥90% lines):** core 89.65% ✓, parser-py 91.82% ✓, parser-js 91.5% ✓, **codegen-js 90.19% ✓**, registry 94.73% ✓ (measured repo-wide 2026-10-18; remaining uncovered lines are unsupported-arm minutiae, error paths, and type-inference fallthroughs).
- **Strategy notes:** ConstructMatrix entries assert BOTH emitted code and the ledger's decision class (no silent downgrades); `pnpm fixtures:accept` regenerates goldens and AGENTS.md §11 requires review rationale with them; bugs fix red-first; registry entries are usage-tested against Python semantics, not just lookup-tested.

## 13. Benchmark Results

None yet. Framework designed (`docs/benchmarks.md`): headline metric = **differential equivalence** (source-vs-target test outcome match rate, S6); suites micro / mini-projects / corpus / perf; AI-enabled runs reported separately from deterministic trends. M3 added a graph-construction performance sanity test (60-module chain).

## 14. Known Bugs

None open. Fixed with regression tests during M1: bridge complex-scalar serializer used `.imaginary` instead of Python's `.imag`; token spans crashed with IndexError on sources lacking a trailing newline (phantom tokenizer line, now clamped). During M2: module-map extraction walked the AST in reverse order (LIFO bug); Babel's `export * as ns` shape normalized to oxc's `star-as`. During M3: Python function/class bodies were never walked (list-vs-node envelope bug) which silently dropped all nested symbols; assignment targets created bogus locals for `global`/`nonlocal` writes; comprehension targets were not bound (PEP 709 inlining); module ids didn't collapse inner `./` segments; TS `TSTypeAnnotation` wasn't unwrapped; annotations now outrank inference. During M4: CPython argument `defaults`/`kw_defaults` and `FormattedValue.format_spec` read from the wrong AST shape (defaults and format specs were silently dropped); `except … as e` binding — CPython's handler name is a plain string, was read as a node (binding disappeared → unresolved names); generators lowered without `function*` (yield inside non-generator → invalid JS); async functions lacked `Promise<T>` return types; `super().__init__(…)` didn't lower to `super(…)`; builtin-exception `__init__` re-export barrels imported but never re-exported (`__all__` handling); static class-attribute assignments read `target` instead of `targets[0]` (class attributes unsupported-by-mistake); runtime-module emission race with multi-unit runs (union emitted once via `finalizeUnits`); instance-field inference read the literal off the node instead of `node.fields`; unpacking of `xs[0], y = pair` emitted a read helper as an assignment target (now setattr/setIndex or parenthesized destructuring); statement-position destructuring starting with `[` parsed as array literal; else-clause was inside the try so its exceptions were caught by the same handlers; oracle nested relative imports failed to resolve (missing `directoryExists`/`realpath`/absolute root names in the virtual compiler host); Babel probe wrapped stack-exhaustion RangeError as JsSyntaxError defeating D-020 mapping. During the **M4 audit (2026-10-18, all regression-tested, see `docs/m4-audit.md` §4):** unmapped Python builtin calls (`sorted`, `list`, `next`, `max`, `min`, `reversed`, `zip`, …) were emitted as silent bare identifiers classified `deterministic` (guaranteed ReferenceError, false provenance) — now `unsupported` with marker + `CTW-UNSUPPORTED-CALL-BUILTIN`; names first assigned inside nested blocks emitted block-scoped `let` breaking Python function/module-scope binding (used-after-if produced TS2304 + runtime ReferenceError) — now hoisted to the scope top; unannotated method/constructor parameters were implicit any (free functions already typed `unknown`) breaking strict S2 — `lowerMethodDef` now routes through `declaredParamText`; fresh empty-list bindings were implicit `any[]` — now `: unknown[]`; fresh dict-literal bindings inferred narrow object types so later key writes failed strict S2 — now `: Record<string, V>`; parallel/unpack bindings inferred literal types so Python rebinding (`a, b = b, a + b`) failed strict S2 — now inherit known RHS element types else `unknown`; comprehensions over unknown iterables emitted `.map` directly on `unknown` — now rerouted through `Object.keys`/`__ctrans_iter` like for-loops; container-method verbatim calls (`list.append`, `dict.get`) carried no warning despite the documented "warnings, never silent" contract — now `CTW-METHOD-UNMAPPED`. During **M5 (all regression-tested):** nested-unpack TDZ — a nested pattern mixing member+fresh targets emitted `[b, c] = temp[1]` with b,c never declared (the parent declared all leaves before element emission, so fresh-detection saw them as bound) — fixed with a pre-declaration snapshot threaded into `emitUnpackElement`; instance-field CommonType lost int/float through the tsType-text round-trip (`tsTextToCommonType`), breaking bigint native arithmetic and float f-string layout on self-fields — fixed by carrying the CommonType (with `numberKind` recovered from the initializer constant) alongside the text; field declarations were not intMode-aware (`count: number` with `0n` assignments) — declarations now consult the CommonType kind; a scripted patch duplicated lower.ts's tail block (208 lines) — removed before commit.

## 15. Known Limitations

Intentional, documented V1 limitations (all produce loud warnings, never silent misbehavior — `docs/language-support.md` §4/§5):
- `unsupported` (M4): metaclasses, descriptors, `except*`/exception groups, `match` patterns (all), `assert`, `del`, decorators (functions/methods/classes), async generators, `__getattr__`, `eval`/`exec`/`compile`, threads/multiprocessing, C-extension stdlib modules, PEP 750 t-strings, **unmapped Python builtin calls (sorted/next/max/…)** — markers + `CTW-UNSUPPORTED-*` warnings; the unit still emits and the report counts it partially-translated.
- **Registry surface (updated M5):** mapped methods/builtins/modules lower through the registry (usage-tested); UNMAPPED methods still lower verbatim with `CTW-METHOD-UNMAPPED`, unmapped builtins stay `unsupported` with `CTW-UNSUPPORTED-CALL-BUILTIN`, and unmapped modules pass through verbatim with exact S3 warnings — the honest surface for everything the v1 registry does not cover.
- **String semantics split:** iteration is code-point-correct (`__ctrans_iter`), but `len()`, indexing of astral characters and lexicographic comparison still measure UTF-16 units — M5.
- **Float formatting (updated M5):** statically float-typed sites and non-integral numbers reproduce Python's repr exactly (`__ctrans_floatStr`); DYNAMIC integral numbers still print int-like in number mode (the int/float runtime distinction is lost — bigint mode is exact since Python ints are bigints there).
- **Dict key order:** iteration/print order of dicts with integer-like keys follows JS object property enumeration (integer-like keys first, numerically ascending) instead of Python insertion order; values are unaffected.
- **Registry v1 boundaries (M5):** `sorted`/`min`/`max`/`enumerate`/`next` kwargs forms outside the call surface; `reversed`/`zip`/`range` materialize (documented); `random` does not reproduce CPython's Mersenne Twister value-for-value; `json.dumps` allow_nan emits `null` for non-finite floats (Python emits `Infinity` literals); `math`/`json`/`sys`/`random` surface is the mapped subset (the full stdlib is M6+ registry scope); `requests` sessions/proxies/auth/`data=`/`json=` kwargs unsupported-loud; `pathlib`/`datetime`/`re`/`itertools`/`functools`/`enum`/`dataclasses`/`typing`/`abc`/`logging`/`statistics`/`decimal` remain unmapped (reported, never guessed).
- **Loop variables after their loop:** `for` targets keep JS block scoping — post-loop use is S2-flagged (out of scope), and C-style range loops already diverge on the post-loop value (last-yield vs end).
- **Helper-dense dynamic code:** statically unknown operands route through `__ctrans_` helpers (D-023); the M5 provability analyzer will thin them where types prove equivalence — `a + b` on unknowns is correct but not idiomatic.
- **Mutability/identity divergences (documented per construct):** Python default args share one object (M4 re-evaluates per call — the footgun deliberately not reproduced); tuples → arrays (immutability lost, warning); dict keys stringify; class attributes → static (instance access via class name only).
- Sync→async propagation (e.g., `requests`→`fetch`) changes public signatures — reported per-signature (M5 rewire).
- Python grammar range 3.12–3.14; tree-sitter fallback is explicitly lower-fidelity.
- JS→TS emits honest `unknown`s, not invented types; Python/JS CommonType inference is deliberately conservative (literals, common containers, annotations) — everything dynamic is `unknown`.
- Registry v1 covers a fixed module list (M5); unmapped third-party deps are reported, never guessed.
- Full-fidelity int arithmetic requires `intMode=bigint`; default `number` mode warns on precision-risky patterns (int annotations, bitwise).
- CLI executable runs from TS sources via Node type stripping (`apps/cli/bin/ctrans.mjs` with a `.js`→`.ts` resolve hook), hence `engines >= 22.18`; compiled dist entry still deferred.
- No build/dist emission yet (deliberate); packages resolve via `exports -> src/index.ts` under `tsc --noEmit`.
- ESLint is non-type-aware for now; Prettier deliberately excludes `*.md` and `tests/fixtures/**`.
- `parse(source: string)` transports decoded text as UTF-8: non-UTF-8 source files must be decoded by the caller (project intake, M6).
- Python front-end verified on 3.14.7; 3.12/3.13 accepted by the handshake but not exercised here.
- oxc depth screen: nesting above 2000 rejected with a typed limit error (D-020).
- ModuleGraph resolution is against the analyzed file set only — no tsconfig paths, no namespace packages (bare `from . import x` needs a package `__init__.py` — verified in the audit), `importlib` dynamic imports untracked (approximate).
- Semantic `this`-binding and TDZ semantics are not yet modeled (documented; needed before JS→X codegen claims).
- Remaining codegen-js uncovered lines (90.21% vs 100%) are unsupported-arm minutiae and type-inference fallthroughs — meaningful-behavior tests, not a floor gap (see §12).

## 16. Failed Approaches (researched and rejected, with reasons)

- **Universal intermediate representation** — rejected for D-002 reasons; the strongest prior art does not use one.
- **Embedding pyright internals as a library** — no public API; unstable between releases; pinned CLI + JSON instead.
- **TypeScript 7 (tsgo) as semantic engine** — verified: 7.0 ships no JS API. Pinned `typescript@6` behind an adapter instead.
- **js2py as JS-execution substrate** — unpatched sandbox-escape RCE (CVE-2024-28397); unmaintained.
- **trufflehog for secret scanning** — AGPL-3.0; embedding license risk. secretlint (MIT) chosen.
- **semgrep / GitHub `semantic` as rewrite substrate** — LGPL + scan-oriented; archived respectively.
- **firejail / systemd-run for sandboxing** — suid-root CVE history; non-root cannot isolate network.
- **Pyodide for validation execution** — not a security boundary; cannot run subprocess-using test suites.
- **LLM-as-translator architecture** — verified ~26.65% naive correctness; deterministic-first + escalation instead.
- **ts-migrate-style JS→TS (blanket `any`)** — dishonest types; our JS→TS emits `unknown` + diagnostics instead.
- **Recursive AST walkers for hostile input** — M2/M3 convert everything to explicit-stack iteration after the oxc segfault finding; recursion is only safe where depth is bounded by construction (Python's parser depth guard).

## 17. Security

Model (`docs/security.md`): local-first; user code is untrusted data; parsing never executes (Python bridge imports only stdlib `ast`/`symtable`/`tokenize` on the file's *syntax*, never user modules); semantic analysis and module resolution are pure data operations (resolution against the in-memory file set — the filesystem is never queried for user code); all execution (S5/S6 tests) through `@ctrans/sandbox` with no network by default, timeouts, output caps, temp cwd, env whitelist; strict mode (Docker/Podman, gVisor optional) **errors rather than downgrades** when unavailable; secret-scan hard gate before any AI request; keys in OS keychain → 0600 file fallback with warning (gh CLI model); never run installs of translated projects without explicit consent; model output is data, never commands. Known concerns: bwrap unavailable on hardened kernels (capability-detected); npm supply-chain risk mitigated by lockfile pinning + pnpm script-blocking.

## 18. Dependencies

**Installed (root devDependencies, lockfile committed):** `@types/node` 24.19.1, `eslint` 10.12.0, `prettier` 3.9.9, `typescript` 6.0.3, `typescript-eslint` 8.71.1, `vitest` 5.0.5, `@vitest/coverage-v8` 5.0.5 (M4 coverage tooling), plus workspace links (`@ctrans/core`, `@ctrans/parser-py`, `@ctrans/parser-js`, `@ctrans/codegen-js`) for repo-level guard/contract/fixture tests. **Package dependencies:** `@ctrans/parser-py` → `@ctrans/core` (workspace), `web-tree-sitter` 0.27.0, `tree-sitter-python` 0.25.0 (prebuilt wasm only; native build scripts stay blocked); `@ctrans/parser-js` → `@ctrans/core` (workspace), `oxc-parser` 0.153.0 (MIT), `@babel/parser` 8.0.6 (MIT), `typescript` ~6.0.3 (Apache-2.0, pinned by ADR D-004 + CI guard); `@ctrans/registry` → `@ctrans/core` (workspace, M5); `@ctrans/codegen-js` → `@ctrans/core` (workspace, M5 — the registry arrives via the injected `RegistryLookup` interface, no codegen→registry dependency, D-017). `@ctrans/core` itself: **zero runtime dependencies** (semantic layer, graph algorithms, and schemas are hand-written — no graph/schema libraries, per AGENTS.md §5). `pnpm.onlyBuiltDependencies: ["esbuild"]` (explicit allowlist). Runtime deps of *generated output*: **zero by policy (D-007)**.

## 19. Recent Changes

- **2026-10-18 (M5):** runtime semantics depth + registry v1 complete. `intMode=bigint` end-to-end (CLI flag → pipeline → lowering → helpers; exact ints, `/` always float, warned Number boundaries; executed fib(200) vs Python on TS+JS); code-point strings (len/index/compare/slice — astral parity); truthiness provability (native lowering when provable, native BoolOp chains); Python float `str()` (`__ctrans_floatStr` — 19-value repr matrix); registry v1 (10 builtins + 32 methods + 5 modules in `@ctrans/registry`, injected through the core `RegistryLookup` interface — the boundary test caught and fixed a D-017 codegen→registry lateral dependency; usage tests execute generated code vs Python); sync→async propagation (`requests`→`fetch` fixpoint over the ModuleGraph, signatures recorded, golden `async-requests` fixture, executed with a stubbed fetch); S3 dependency validation (distinct verdicts, claim level 3). ConstructMatrix grew to ~140 entries; 17 golden fixtures (16 + async-requests); 618/618 tests, coverage floors all met (codegen-js 90.19%). M5 bugs fixed red-first: nested-unpack TDZ, field CommonType int/float loss, intMode-unaware field declarations.

- **2026-10-06 (Phase 1):** created repository; 4-track verified research → `docs/research.md`; 12 design docs + 16 ADRs; monorepo scaffolding; `AGENTS.md`; fixture-format contract; `PROJECT_STATE.md`.
- **2026-10-06 (M0):** git initialized; pnpm 10.26.0 workspace via corepack; strict TS 6.0.3 + ESLint 10 + Prettier 3 + Vitest 5; 10 package skeletons + CLI app; `pnpm verify` composed; doc-link checker (caught one real broken link); fresh-clone flow verified.
- **2026-10-06 (M1):** Python front-end: protocol-v1 bridge (ast + symtable + tokenize → JSON; iterative stack-safe encoders; tagged scalars; byte-grid spans), TS client (spawn lifecycle, timeouts, typed error taxonomy), tree-sitter fallback behind `PythonParser`; ADRs D-017 (core = base type layer) + D-018 (bridge protocol); 2 bridge bugs fixed with regressions; 80/80 tests.
- **2026-10-06 (M2):** JS/TS front-end: oxc primary (ESTree→AstNode normalization, UTF-16→byte conversion), Babel 8 fallback, module map, TypeScript 6 oracle + runtime 6.x guard, **oxc ~8000-deep SIGSEGV discovered and contained** (D-020), core contract extended (D-019), TS7 CI guard, cross-frontend contract tests, module-map reverse-order bug fixed; 158/158 tests.
- **2026-10-07 (M3):** semantic layer implemented in `@ctrans/core`: CommonType v1 with honest provenance; Python analyzer (symtable-driven scopes; closures/globals/nonlocals; class-scope invisibility; PEP 709; conservative types preserving int/float); JS/TS analyzer built in core (var hoisting, block/catch/loop scopes, closures, imports/exports, TS type namespaces and annotation mapping); ModuleGraph (dotted/relative Python + extension/index JS resolution against the file set, explicit externals/unresolved, dynamic-import edges, `__main__`/test detection, iterative Tarjan SCCs, dependency-first deterministic ordering); ModuleContracts (`__all__` convention, oracle displays as separate provenance); TransformationLedger + TranslationReport schemas with validation; bridge module-info extension (D-021); fixed 7 M3 bugs with regression tests (incl. the function-body walk envelope bug and global/nonlocal target binding); 205/205 tests green. *Note: the M2 commit had captured a stale PROJECT_STATE header (M1-era milestone lines) — corrected in this update; milestone/status lines are now verified against the repository.*
- **Repository hygiene note (2026-10-07):** state-file updates for M2 were partially lost before the M2 commit (only the header/milestone rows); §7/§8/§12 content had landed. The M3 commit contains the fully reconciled file.
- **2026-10-18 (M4):** first real translation direction live: pipeline orchestration in core (`runPipeline` + `finalizeUnits` post-pass for shared runtime emission); `@ctrans/codegen-js` lowering rules + TS/JS emitter with per-construct ledger provenance; `__ctrans_runtime` helper templates w/ closure injection + Node type-stripping for JS targets (D-022); dynamic-operand helper policy (D-023); S1/S2 validators wired through the oracle (virtual workspace resolution for cross-module imports); claim ladder v1 asserted in goldens; ConstructMatrix 111 entries × both directions; 16 golden fixtures + `pnpm fixtures:accept`; CLI `check`/`translate` (file+project, exit codes, `.ctrans/` artifacts); docs/ADR D-022 + D-023; 502/502 tests green. Bugs found & fixed during M4 with regressions: AST-shape mismatches (defaults/formatSpec/handler-name/targets), generator/async lowering, exception naming + barrel re-exports, oracle nested-import resolution, Babel probe RangeError identity (D-020), runtime emission ordering, unpack/attr-write lvalue forms.
- **2026-10-18 (M4 independent audit):** a fresh session re-verified every M4 claim from source, tests, and reproducible execution (`docs/m4-audit.md`). `pnpm verify` was genuinely green (505/505) but hands-on translation of a representative project exposed 8 honesty/correctness defects the curated fixtures never touched (§14 audit entries) — all fixed red-first with 11 regression tests, 6 new audit matrix entries, and 6 previously-untested-arm matrix entries; import-prologue forms pinned by a new `import-forms.test.ts` suite (also documenting the namespace-package limitation); 4 matrix entries reclassified honestly (comprehensions over unknown iterables → `semantic`); goldens regenerated with review. Supported-surface workflow verified **byte-identical to Python on both TS and JS targets**; coverage floor closed (codegen-js 90.21% ≥ 90). Final: **542/542 tests, 50 files, `pnpm verify` exit 0**.

## 20. Current Blockers

None. Environmental note: the npm registry was intermittently throttled during M0–M2 installs — pnpm retries handle it. Corepack downloads the pinned pnpm 10.26.0 automatically on fresh machines.

## 21. Next Recommended Actions

Ordered (detail in `docs/roadmap.md` M6):
1. M6 (`@ctrans/core` + `@ctrans/validator` + `@ctrans/sandbox` + `apps/cli`): project orchestrator (ordering, per-unit pipeline, `__init__.py`→index), sandbox v1 (hardened spawn + prlimit + bwrap autodetect, capability report), pytest→vitest mapper, differential comparator, S5/S6 stages, claim ladder to level 5, `.ctrans/` run artifacts.
2. M7+ (reverse directions) follows; registry scope expansion (pathlib/datetime/re wrappers) rides the M6+ test-translation work.

## 22. Definition of Done (current milestone, M6)

Per `docs/roadmap.md` M6 + AGENTS.md §12: 3 golden mini-projects translated + validated to claim level 5 in CI; sandbox negative tests (timeout kill, output caps, no-network verification) with capability-skip honesty; pytest→vitest ConstructMatrix (incl. unsupported monkeypatch warning); a fixture project with tests shows a source-vs-target equivalence report; M0–M5 tests stay green (coverage floors hold); docs + `PROJECT_STATE.md` updated with verified claims.

## 23. Handoff Notes

- **Read `AGENTS.md` first** — its rules are binding (forbidden shortcuts incl. regex-based "parsing", emitting code without ledger provenance, claiming unrun validation, weakening sandbox/tests, copying GPL code). `human-style-code.md` is the judgment baseline; AGENTS.md wins on overlap.
- **Deviations from the original prompt, all documented and reasoned:** (1) "Intermediate Representation" → Semantic Layer without a universal AST IR (D-002); (2) "Basic GUI" moved out of V1 (D-013); (3) translation directions framed as a *graded support matrix* with explicit `unsupported` classes (product principle: never silently pretend correctness). If the human wants these reversed, they are deliberate change requests, not omissions.
- **Verified facts that must not drift:** TypeScript 7.0 has no JS API (pin typescript@6); TC39 decorators are Stage 2.7; Temporal is Stage 4 (Node ≥26 ships it); `fetch` has no sync variant; the semantic divergences are source-verified in `docs/research.md` §3. Re-verify pinned versions when installing dependencies (research date: 2026-10-06).
- **Honesty invariant:** every emitted construct needs a ledger entry; validation reports `skipped(reason)` rather than assuming capabilities; the claim ladder caps what a run may assert — "Generated ≠ Validated". `CommonType` never invents concrete types for dynamic values (`unknown` + confidence).
- Where to look: roadmap = `docs/roadmap.md`; per-construct mapping rules = `docs/language-support.md`; ledger/JSON schemas = `docs/translation-pipeline.md` + `docs/architecture.md` §4 + `packages/core/src/{ledger,report}.ts`; ADRs = `docs/decisions.md`.
- **M0–M2 mechanics still apply:** `pnpm verify` composition; `noEmit` packages via `exports -> src/index.ts`; layer rules in `scripts/workspace-boundaries.test.ts`; bridge protocol contract in `packages/parser-py/README.md` (bridge emits, protocol.ts validates — change together); byte-grid positions everywhere; oxc/Babel report UTF-16 indices (normalize.ts converts); oxc paths must go through `safety.ts` (D-020); compiler API only in `packages/parser-js/src/ts-oracle.ts` (CI-enforced).
- **M3 mechanics:** the semantic analyzers consume the `{kind, span, fields}` envelope — ALWAYS access child data through the `fields` record (the M3 function-body bug came from reading a list child with the single-child accessor). Python scope/symbol sets come from symtable (authoritative); the AST supplies declarations/references/spans/types. JS scope building lives in `@ctrans/core/src/semantic-javascript.ts` (do NOT move it back into parser-js). Symbol/scope ids are deterministic opaque paths — never parse meaning out of them. `flagsByScopeName` must be built before the walk (declaration eligibility for `global`/`nonlocal` targets). ModuleGraph resolution is against the provided file set only; `.js` specifiers may mean `.ts` files (TS convention). Module-map/ledger iteration order is deterministic because walks push children reversed onto their LIFO stacks — preserve that when editing.
- **M4 mechanics:** lowering consumes the `{kind, span, fields}` envelope via the `kid/kids/scalar` accessors in `lower.ts` — CPython AST shapes matter (defaults live on the `arguments` node tail-aligned; `ExceptHandler.name` is a plain string; `Assign.targets` is a list; `FormattedValue.format_spec` is snake_case). Every emission goes through `LoweringContext.record` — never emit without a ledger entry; helpers/exceptions are tracked per-unit, the runtime file is the cross-unit union emitted in `finalizeUnits` (keep `helperClosure` in sync with helper `requires`/`exceptions`). Type hints: `declaredType`/`operandKind` drive native-vs-helper decisions — keep `commonTypeFromAnnotation`, `tsTypeFromAnnotation`, and `tsTextToCommonType` consistent when adding annotation forms. The oracle resolves virtual files through a synthetic workspace root (`VIRTUAL_ROOT` + `directoryExists`/`realpath`) — nested relative imports depend on it. JS targets strip helper types with `module.stripTypeScriptTypes` — keep helper sources strip-safe (no enums/overloads/param properties).
- **M4 audit mechanics (2026-10-18):** Python-scope bindings are pre-scanned per scope (`collectAssignedNames` in `lower.ts`); first assignments to pre-scanned names inside nested blocks hoist `let` to the scope top via `hoistBinding`/`flushHoists` (frames align with `declaredPerScope` pushes: module body, `lowerFunctionDef`, `lowerMethodDef`) — keep those frames aligned when adding new scope kinds. Unmapped-builtin classification consults `UNMAPPED_PYTHON_BUILTINS` **and** `unitDefinedNames` (a builtin shadowed by a unit def is a forward reference); mapped builtins must stay in `lowerBuiltinCall`'s switch. Method params must route through `declaredParamText` (declares scope types AND types unknown — `defaultParamText` alone does not declare). Fresh-let annotations (`freshLetTypeSuffix`: empty list → `unknown[]`, dict → `Record<string, V>`) and unpack annotations (known RHS element types inherited, else `unknown`) are TS-target-only — JS matrix entries must use `tsOnly: true` when asserting them. The import prologue pairs graph imports with parse imports by index and classifies unknown absolute modules as `external` (not `unresolved`) — bare `from . import x` needs a package `__init__.py` (namespace packages unmodeled).
- **M5 mechanics:** the registry lookup is INJECTED through the core `RegistryLookup` interface (`createPyToJsTranslator(target, { intMode, registry })`; `NO_REGISTRY` = honest unmapped surface) — never import `@ctrans/registry` from codegen (D-017, enforced by `scripts/workspace-boundaries.test.ts`). Runtime helpers are mode-agnostic: widened numeric helpers use the `__CTRANS_NUM__` placeholder, substituted per intMode at render time (`INT_RESULT_TYPE`); the bigint branches carry `as unknown as __CTRANS_NUM__` casts that are dead code in number mode. `exprIsInt`/`exprIsFloat` are the provability gates for native bigint/float lowering — extend them (conservatively) when adding operand kinds. Instance-field types carry a CommonType WITH numberKind (`attribute.commonType`) — do not round-trip through tsType text. Nested-unpack freshness uses the pre-declaration snapshot (`preDeclared`) threaded into `emitUnpackElement`. Async propagation: `collectFunctionCalls`/`propagateAsync` in core, consumed through `UnitTranslationContext.asyncFunctions`; the golden `async-requests` fixture pins the graph-wide behavior. S3: `runPipeline(inputs, options, s3)` — the wiring layer supplies sourceImports/mapped/unsupported sets.
- Environment: Node 24.15 (LTS), Python 3.14.7, Docker 29.8.1 + Podman 5.8.7 available locally; Rust toolchain present (unused by design).
