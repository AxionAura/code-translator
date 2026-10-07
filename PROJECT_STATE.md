# Code Translator — Project State

> Canonical handoff document. An AI reading **only this file** must understand the project and be able to produce the next engineering prompt. Detailed design lives in `docs/` (linked, not duplicated). Maintenance rules: `AGENTS.md` §13.
> Last updated: **2026-10-07** (M3 — semantic layer & module graph — complete; every claim below verified in this working session).

## 1. Project Identity

- **Project name:** Code Translator
- **Current version:** 0.0.0 (no release yet)
- **Current milestone:** **M3 — Semantic layer & module graph (`@ctrans/core`): complete** (2026-10-07; `pnpm verify` green, 205/205 tests). Next: **M4 — Pipeline skeleton + Python→JS/TS code generation**.
- **Overall status:** Both language front-ends and the semantic foundation (CommonType, scope/symbol resolution, ModuleGraph with SCCs, ModuleContracts, ledger/report schemas) implemented and verified; code generation and everything downstream remains spec-only.

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
      deterministic | semantic | ambiguous | unsupported)                             [M4+: spec only]
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
| Ledger/reports | `TransformationLedger` schema (4 decision kinds, escalation provenance) + `TranslationReport` schema (claim ladder 0–5) | **Implemented** (schema + validation; producers arrive M4+) |
| Output checkers | `tsc --noEmit` (typescript@6) for TS; pyright CLI `--outputjson` (pinned) + optional mypy for Python (D-005) | Not implemented |
| Database | None (file/JSON artifacts under `.ctrans/`) | — |
| Sandbox | Hardened `spawn` + `prlimit` + auto-detected bubblewrap; Docker/Podman strict mode opt-in (D-009) | Not implemented |
| AI | Provider-agnostic `ChatModel` interface; OpenAI-compatible/Anthropic/custom adapters; 3 escalation ports only; offline default (D-010) | Not implemented |
| Testing | Vitest 5; golden fixtures (`tests/fixtures/`), ConstructMatrix, benchmarks (D-012) | Implemented: Vitest 5.0.3, 205/205 tests green in `pnpm verify` |

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
packages/parser-js/           # JS/TS front-end: oxc primary + Babel fallback + typescript@6 oracle, src/{normalize,oxc-parser,babel-parser,module-info,ts-oracle,safety,select}.ts, tests/, README.md
packages/{codegen-js,codegen-py,registry,validator,sandbox,repair,ai}/   # skeletons (M4+)
apps/cli/                     # CLI foundation: runCli + executable bin/ctrans.mjs (Node type stripping)
.gitignore
human-style-code.md           # engineering-judgment style guide (provided by human; AGENTS.md defers to it where compatible)
docs/                         # research, architecture, translation-pipeline, language-support,
                              # dependency-mapping, ai-architecture, validation, security, testing,
                              # benchmarks, decisions (21 ADRs), roadmap
tests/fixtures/               # fixture format contract + format-sample (input/expected/manifest)
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
| CLI foundation (`--help`, `--version`, honest rejection of unimplemented commands) | Implemented | `apps/cli/` | Unit tests + direct executable run; no fake commands |
| Documentation-link checker | Implemented | `scripts/check-doc-links.mjs` | Runs in `pnpm verify`; caught a real broken link in M0 |
| Python→TS translation | Not implemented | — | — |
| Dependency registry / validation engine / AI layer / sandbox | Not implemented | — | — |

## 8. Current Milestone

**Milestone objective: M4 — Pipeline skeleton + Python→TS/JS codegen** (`docs/roadmap.md` M4).
- **Status:** not started (M3 completed 2026-10-07).
- **M3 completed:** `CommonType` v1 with `AnnotatedType` provenance (origin explicit/inferred/oracle; confidence exact/approximate/unknown; honest `unknown` for dynamic values); Python semantic analyzer (symtable-driven scope tree; declarations/references from the AST; closures via free-variable resolution; `global`/`nonlocal` writes resolve to their home scope; class-scope invisibility modeled explicitly; PEP 709 comprehension inlining; 3.14 `__annotate__` scopes; conservative type inference from literals/annotations — Python `int`/`float` distinction preserved for D-006); JS/TS semantic analyzer built in core from the normalized AST (var hoisting to function scopes, let/const block scopes, catch/loop scopes, class scopes with methods/properties, closures, import bindings with specifier provenance, TS type namespaces + enum/namespace kinds, TS annotation → CommonType mapping with annotation-over-inference precedence); `ModuleGraph` (Python dotted/relative resolution incl. `__init__.py`, JS/TS relative resolution with extension + index + `.js`→`.ts` swapping, externals and unresolved explicit, dynamic-import edges, `__main__` entry detection, test-module detection, iterative Tarjan SCCs, dependency-first deterministic ordering); `ModuleContracts` (`__all__`/public-name convention for Python, export surfaces for JS/TS, oracle displays as separate provenance); `TransformationLedger` schema (4 decision kinds, escalation provenance hash-only) + `TranslationReport` schema (claim ladder 0–5) with hand-written validation and round-trip tests; bridge module-info extension (D-021) with tolerant client mapping.
- **In progress:** nothing.
- **Remaining for M4:** pipeline orchestration (per-unit stages, ordering over the ModuleGraph), lowering rules + TS/JS emitter for the core subset, `__ctrans_runtime.ts` helper injection, prettier finalization, ledger-driven provenance in emission, per-unit S1 + project S2 validation, ConstructMatrix fixtures, claim ladder v1.

## 9. Important Technical Decisions

Full log: `docs/decisions.md` (21 ADRs). The ones another AI must not accidentally reverse:

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

## 10. Translation Pipeline

- **Current actual pipeline:** parsing **and semantic analysis** are real for both language families: `source → ParseResult → analyzeModule → SemanticModel (scopes/symbols/types/resolution)`; `buildModuleGraph` turns parsed inputs into a resolved, SCC-aware, deterministically ordered graph; `extractModuleContract` derives honest export surfaces. Codegen, dependency mapping, validation, and repair are approved spec (ledger JSON schema exists; ambiguity-resolution order: heuristic default → optional AI escalation → `TODO(ctrans)` + warning; never block on AI).
- **Determinism guarantee:** semantic analysis and graph construction are deterministic with AI disabled (tested by double-run JSON equality); the future AI-repair stage re-enters deterministic validation.

## 11. AI Architecture

- **AI is used (spec):** (1) `resolveAmbiguity` for engine-classified `ambiguous` constructs — must *choose among offered options*, never invent behavior; (2) `proposeRepairPatch` in the bounded repair loop (unit-scoped unified diffs, re-validated); (3) optional off-by-default idiom polish.
- **AI is not used (spec):** parsing, symbol/type resolution, lowering, codegen, dependency registry lookups, validation verdicts. CI goldens never call AI.
- **Provider abstraction (spec):** `ChatModel.complete()` interface; adapters for OpenAI-compatible endpoints (incl. Ollama/vLLM/llama.cpp), Anthropic, custom endpoints; secretlint-based hard gate before any request; caps (calls/tokens/USD/wall-clock) enforced in code; prompt payloads = unit AST + direct-dep ModuleContracts + diagnostics, token-budgeted — whole-project prompts forbidden.
- All of the above is **Not implemented**; the layer must work with AI fully disabled (offline default).

## 12. Testing

- **Framework:** Vitest 5.0.3 (single root `vitest.config.ts`).
- **Number of tests:** 205 (41 files; M3 added 47: CommonType provenance, Python scopes/closures/globals/nonlocals/class-scope/comprehensions/type inference, JS var-hoisting/block/catch/loops/imports/exports/TS types, ModuleGraph resolution incl. `__init__.py` + `.js`→`.ts` swapping + cycles + ordering determinism, contracts incl. `__all__` + oracle provenance, ledger/report validation + round-trips, hostile truncations, graph performance sanity).
- **Passing / Failing / Skipped:** 205 / 0 / 0 (verified 2026-10-07 via `pnpm verify`).
- **Planned strategy** (`docs/testing.md`): ConstructMatrix (every entry of `language-support.md` §2 × direction, incl. negative tests for `unsupported`), golden fixtures with canonical-formatter normalization + review-required acceptance, registry usage tests in CI, validation/repair tests with FakeChatModel, e2e CLI tests, license-clean corpus. Coverage floors from M4: core ≥85%, parser/codegen ≥90%. Regression rule: every bug fix lands with a fixture.

## 13. Benchmark Results

None yet. Framework designed (`docs/benchmarks.md`): headline metric = **differential equivalence** (source-vs-target test outcome match rate, S6); suites micro / mini-projects / corpus / perf; AI-enabled runs reported separately from deterministic trends. M3 added a graph-construction performance sanity test (60-module chain).

## 14. Known Bugs

None open. Fixed with regression tests during M1: bridge complex-scalar serializer used `.imaginary` instead of Python's `.imag`; token spans crashed with IndexError on sources lacking a trailing newline (phantom tokenizer line, now clamped). During M2: module-map extraction walked the AST in reverse order (LIFO bug); Babel's `export * as ns` shape normalized to oxc's `star-as`. During M3: Python function/class bodies were never walked (list-vs-node envelope bug) which silently dropped all nested symbols; assignment targets created bogus locals for `global`/`nonlocal` writes (now resolved to their home scope, with read-only unassigned names left honestly unresolved); comprehension targets were not bound (PEP 709 inlining); module ids didn't collapse inner `./` segments; TS `TSTypeAnnotation` wasn't unwrapped (types came out unknown); annotations now outrank inference.

## 15. Known Limitations

Intentional, documented V1 limitations (all produce loud warnings, never silent misbehavior — `docs/language-support.md` §4):
- `unsupported`: metaclasses, descriptors, `except*`/exception groups, class/sequence/mapping `match` patterns, `__hash__`-dependent keying, threads/multiprocessing, C-extension stdlib modules, PEP 750 t-strings.
- Sync→async propagation (e.g., `requests`→`fetch`) changes public signatures — reported per-signature.
- Python grammar range 3.12–3.14; tree-sitter fallback is explicitly lower-fidelity.
- JS→TS emits honest `unknown`s, not invented types; Python/JS CommonType inference is deliberately conservative (literals, common containers, annotations) — everything dynamic is `unknown`.
- Registry v1 covers a fixed module list; unmapped third-party deps are reported, never guessed.
- Full-fidelity int arithmetic requires `intMode=bigint`; default `number` mode warns on precision-risky patterns.
- CLI executable runs from TS sources via Node type stripping (`apps/cli/bin/ctrans.mjs`), hence `engines >= 22.18`; replaced by a compiled dist entry in M4.
- No build/dist emission yet (deliberate); packages resolve via `exports -> src/index.ts` under `tsc --noEmit`.
- ESLint is non-type-aware for now (recommended set).
- Prettier deliberately excludes `*.md` and `tests/fixtures/**`.
- `parse(source: string)` transports decoded text as UTF-8: non-UTF-8 source files must be decoded by the caller (project intake, M6).
- Python front-end verified on 3.14.7; 3.12/3.13 accepted by the handshake but not exercised here.
- tree-sitter fallback is CST-shaped with no scope analysis — always `fidelity: "degraded"`.
- JS/TS parse uses module semantics (e.g. `with` fails); Babel's recoverable/unrecoverable boundary differs from oxc's — both outcomes structured.
- oxc depth screen: nesting above 2000 rejected with a typed limit error (D-020).
- ModuleGraph resolution is against the analyzed file set only — no tsconfig paths, no namespace packages, `importlib` dynamic imports untracked (approximate).
- Semantic `this`-binding and TDZ semantics are not yet modeled (documented; needed before JS→X codegen claims).

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

**Installed (root devDependencies, lockfile committed):** `@types/node` 24.19.1, `eslint` 10.12.0, `prettier` 3.9.9, `typescript` 6.0.3, `typescript-eslint` 8.71.1, `vitest` 5.0.3, plus workspace links (`@ctrans/core`, `@ctrans/parser-py`, `@ctrans/parser-js`) for repo-level guard/contract tests. **Package dependencies:** `@ctrans/parser-py` → `@ctrans/core` (workspace), `web-tree-sitter` 0.27.0, `tree-sitter-python` 0.25.0 (prebuilt wasm only; native build scripts stay blocked); `@ctrans/parser-js` → `@ctrans/core` (workspace), `oxc-parser` 0.153.0 (MIT), `@babel/parser` 8.0.6 (MIT), `typescript` ~6.0.3 (Apache-2.0, pinned by ADR D-004 + CI guard). `@ctrans/core` itself: **zero runtime dependencies** (semantic layer, graph algorithms, and schemas are hand-written — no graph/schema libraries, per AGENTS.md §5). `pnpm.onlyBuiltDependencies: ["esbuild"]` (explicit allowlist). Runtime deps of *generated output*: **zero by policy (D-007)**.

## 19. Recent Changes

- **2026-10-06 (Phase 1):** created repository; 4-track verified research → `docs/research.md`; 12 design docs + 16 ADRs; monorepo scaffolding; `AGENTS.md`; fixture-format contract; `PROJECT_STATE.md`.
- **2026-10-06 (M0):** git initialized; pnpm 10.26.0 workspace via corepack; strict TS 6.0.3 + ESLint 10 + Prettier 3 + Vitest 5; 10 package skeletons + CLI app; `pnpm verify` composed; doc-link checker (caught one real broken link); fresh-clone flow verified.
- **2026-10-06 (M1):** Python front-end: protocol-v1 bridge (ast + symtable + tokenize → JSON; iterative stack-safe encoders; tagged scalars; byte-grid spans), TS client (spawn lifecycle, timeouts, typed error taxonomy), tree-sitter fallback behind `PythonParser`; ADRs D-017 (core = base type layer) + D-018 (bridge protocol); 2 bridge bugs fixed with regressions; 80/80 tests.
- **2026-10-06 (M2):** JS/TS front-end: oxc primary (ESTree→AstNode normalization, UTF-16→byte conversion), Babel 8 fallback, module map, TypeScript 6 oracle + runtime 6.x guard, **oxc ~8000-deep SIGSEGV discovered and contained** (D-020), core contract extended (D-019), TS7 CI guard, cross-frontend contract tests, module-map reverse-order bug fixed; 158/158 tests.
- **2026-10-07 (M3):** semantic layer implemented in `@ctrans/core`: CommonType v1 with honest provenance; Python analyzer (symtable-driven scopes; closures/globals/nonlocals; class-scope invisibility; PEP 709; conservative types preserving int/float); JS/TS analyzer built in core (var hoisting, block/catch/loop scopes, closures, imports/exports, TS type namespaces and annotation mapping); ModuleGraph (dotted/relative Python + extension/index JS resolution against the file set, explicit externals/unresolved, dynamic-import edges, `__main__`/test detection, iterative Tarjan SCCs, dependency-first deterministic ordering); ModuleContracts (`__all__` convention, oracle displays as separate provenance); TransformationLedger + TranslationReport schemas with validation; bridge module-info extension (D-021); fixed 7 M3 bugs with regression tests (incl. the function-body walk envelope bug and global/nonlocal target binding); 205/205 tests green. *Note: the M2 commit had captured a stale PROJECT_STATE header (M1-era milestone lines) — corrected in this update; milestone/status lines are now verified against the repository.*
- **Repository hygiene note (2026-10-07):** state-file updates for M2 were partially lost before the M2 commit (only the header/milestone rows); §7/§8/§12 content had landed. The M3 commit contains the fully reconciled file.

## 20. Current Blockers

None. Environmental note: the npm registry was intermittently throttled during M0–M2 installs — pnpm retries handle it. Corepack downloads the pinned pnpm 10.26.0 automatically on fresh machines.

## 21. Next Recommended Actions

Ordered (detail in `docs/roadmap.md` M4):
1. M4 (`@ctrans/core` + `@ctrans/codegen-js`): pipeline orchestrator (unit ordering from ModuleGraph, per-unit context assembly via ModuleContracts); lowering-rule registry keyed to `language-support.md` §2 ids; TS/JS emitter + `__ctrans_runtime.ts` helper injection (truthy/floorDiv/mod/strSlice/exception hierarchy); prettier finalization; ledger entries emitted per construct; S1 per-unit + S2 project validation; claim ladder v1; ConstructMatrix fixtures for the core subset.
2. M5: runtime semantics depth (numeric policy per D-006, code-point strings, async boundary propagation) + registry v1.
3. Build/dist strategy stays deferred until a runtime consumer needs compiled output.

## 22. Definition of Done (current milestone, M4)

Per `docs/roadmap.md` M4 + AGENTS.md §12: `ctrans check file.py --to ts` produces an accurate ledger + warnings; `ctrans translate` (file mode) output passes S1+S2 on all fixtures; ConstructMatrix covers every M4 construct × Py→TS and Py→JS with expected decision classes; golden file fixtures (≥15) with manifest-asserted claim ladders; emitted output re-parses; prettier idempotence holds; M0–M3 tests stay green; `PROJECT_STATE.md` updated with verified claims.

## 23. Handoff Notes

- **Read `AGENTS.md` first** — its rules are binding (forbidden shortcuts incl. regex-based "parsing", emitting code without ledger provenance, claiming unrun validation, weakening sandbox/tests, copying GPL code). `human-style-code.md` is the judgment baseline; AGENTS.md wins on overlap.
- **Deviations from the original prompt, all documented and reasoned:** (1) "Intermediate Representation" → Semantic Layer without a universal AST IR (D-002); (2) "Basic GUI" moved out of V1 (D-013); (3) translation directions framed as a *graded support matrix* with explicit `unsupported` classes (product principle: never silently pretend correctness). If the human wants these reversed, they are deliberate change requests, not omissions.
- **Verified facts that must not drift:** TypeScript 7.0 has no JS API (pin typescript@6); TC39 decorators are Stage 2.7; Temporal is Stage 4 (Node ≥26 ships it); `fetch` has no sync variant; the semantic divergences are source-verified in `docs/research.md` §3. Re-verify pinned versions when installing dependencies (research date: 2026-10-06).
- **Honesty invariant:** every emitted construct needs a ledger entry; validation reports `skipped(reason)` rather than assuming capabilities; the claim ladder caps what a run may assert — "Generated ≠ Validated". `CommonType` never invents concrete types for dynamic values (`unknown` + confidence).
- Where to look: roadmap = `docs/roadmap.md`; per-construct mapping rules = `docs/language-support.md`; ledger/JSON schemas = `docs/translation-pipeline.md` + `docs/architecture.md` §4 + `packages/core/src/{ledger,report}.ts`; ADRs = `docs/decisions.md`.
- **M0–M2 mechanics still apply:** `pnpm verify` composition; `noEmit` packages via `exports -> src/index.ts`; layer rules in `scripts/workspace-boundaries.test.ts`; bridge protocol contract in `packages/parser-py/README.md` (bridge emits, protocol.ts validates — change together); byte-grid positions everywhere; oxc/Babel report UTF-16 indices (normalize.ts converts); oxc paths must go through `safety.ts` (D-020); compiler API only in `packages/parser-js/src/ts-oracle.ts` (CI-enforced).
- **M3 mechanics:** the semantic analyzers consume the `{kind, span, fields}` envelope — ALWAYS access child data through the `fields` record (the M3 function-body bug came from reading a list child with the single-child accessor). Python scope/symbol sets come from symtable (authoritative); the AST supplies declarations/references/spans/types. JS scope building lives in `@ctrans/core/src/semantic-javascript.ts` (do NOT move it back into parser-js). Symbol/scope ids are deterministic opaque paths — never parse meaning out of them. `flagsByScopeName` must be built before the walk (declaration eligibility for `global`/`nonlocal` targets). ModuleGraph resolution is against the provided file set only; `.js` specifiers may mean `.ts` files (TS convention). Module-map/ledger iteration order is deterministic because walks push children reversed onto their LIFO stacks — preserve that when editing.
- Environment: Node 24.15 (LTS), Python 3.14.7, Docker 29.8.1 + Podman 5.8.7 available locally; Rust toolchain present (unused by design).
