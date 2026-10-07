# Code Translator — Project State

> Canonical handoff document. An AI reading **only this file** must understand the project and be able to produce the next engineering prompt. Detailed design lives in `docs/` (linked, not duplicated). Maintenance rules: `AGENTS.md` §13.
> Last updated: **2026-10-06** (M1 — Python front-end — complete; every claim below verified in this working session).

## 1. Project Identity

- **Project name:** Code Translator
- **Current version:** 0.0.0 (no release yet)
- **Current milestone:** **M1 — Python front-end (`@ctrans/parser-py`): complete** (2026-10-06; `pnpm verify` green, 80/80 tests). Next: **M2 — JS/TS front-end**.
- **Overall status:** Blueprint approved; toolchain foundation and the Python parsing front-end implemented and verified; everything downstream (semantics, codegen, validation, AI) remains spec-only.

## 2. Product Goal

A serious developer tool that translates source code and complete multi-file projects between **Python, JavaScript, and TypeScript** (all 6 directions) while preserving behavior as accurately as technically possible — and that **honestly reports** what was translated deterministically, what was adapted semantically, what was ambiguous, and what was unsupported. It never presents an unvalidated translation as correct. Long-term: extensible to additional languages.

## 3. Current Scope

**Designed and approved for V1** (nothing implemented yet):
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
  → Project Analysis (ModuleGraph: imports, SCCs, topo order, entry points, tests)
  → Parsing            [Python: CPython stdlib bridge (ast+symtable+tokenize→JSON), tree-sitter fallback]
                       [JS/TS: oxc-parser, @babel/parser fallback]
  → Annotated AST + Semantic Layer (CommonType model, symbol/scope tables, ModuleContracts)
  → Lowering + Code Generation (per direction; TransformationLedger records EVERY decision as
      deterministic | semantic | ambiguous | unsupported)
  → Dependency Mapping (in-repo registry + heuristics + AI proposals)
  → Test Translation   (pytest↔vitest, best effort)
  → Validation Engine  (S1 syntax → S2 types → S3 deps → S4 build → S5 tests → S6 differential; each
      stage = pass|fail|warn|skipped(reason); "claim ladder" caps what may be asserted)
  → Bounded AI-assisted Repair → Re-validation
  → Final Target Project + Reports (.ctrans/ ledger, source map, validation report, repair journal)
```

Monorepo layout (planned, created in M0/M1+): `packages/{core,parser-py,parser-js,codegen-js,codegen-py,registry,validator,sandbox,repair,ai}`, `apps/cli` (binary `ctrans`). Dependency direction acyclic: `cli → repair → {validator, ai} → core → {parser-*, codegen-*, registry, sandbox}`.

## 5. Technology Stack

| Area | Decision | Status |
| --- | --- | --- |
| Frontend | **None in V1** — CLI only (D-013); UI deferred to V2 | Decision made; nothing built |
| Engine | TypeScript (strict) on Node ≥22.18, pnpm 10.26.0 monorepo (D-001) | Implemented: 12 workspace projects, `tsc --noEmit` green (TS 6.0.3) |
| Python parser | `python3` subprocess bridge over stdlib `ast`/`symtable`/`tokenize` → JSON; `web-tree-sitter` fallback (D-003, D-018) | **Implemented** (protocol v1; verified on Python 3.14.7) |
| JS/TS parser | `oxc-parser` primary + `@babel/parser` fallback behind `JsParser`; `typescript@6` semantic oracle behind `TsSemanticOracle` (D-004, D-019, D-020) | **Implemented** (oxc-parser 0.153.0, @babel/parser 8.0.6, typescript 6.0.3) |
| IR | **No universal AST IR**; Semantic Layer = CommonType + symbols + ModuleGraph + TransformationLedger (D-002) | Spec written in `docs/architecture.md` §4 |
| Output checkers | `tsc --noEmit` (typescript@6) for TS; pyright CLI `--outputjson` (pinned) + optional mypy 2.4 for Python (D-005) | Not implemented |
| Database | None (file/JSON artifacts under `.ctrans/`) | — |
| Sandbox | Hardened `spawn` + `prlimit` + auto-detected bubblewrap; Docker/Podman strict mode opt-in (D-009) | Not implemented |
| AI | Provider-agnostic `ChatModel` interface; OpenAI-compatible/Anthropic/custom adapters; 3 escalation ports only; offline default (D-010) | Not implemented |
| Testing | Vitest 5; golden fixtures (`tests/fixtures/`), ConstructMatrix, benchmarks (D-012) | Implemented: Vitest 5.0.3, 18/18 tests green in `pnpm verify` |

**Critical version fact (verified 2026-10-06):** TypeScript 7.0 (native Go) ships **no JS API**; all compiler-API use must pin `typescript@6` / `@typescript/typescript6` behind an adapter until TS 7.1's new API lands.

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
packages/<10 packages>/       # workspace packages resolving via exports -> src/index.ts (noEmit)
packages/parser-py/           # Python front-end: python/bridge.py (protocol v1), src/{client,protocol,errors,fallback,select}.ts, tests/, README.md (protocol contract)
packages/parser-js/           # JS/TS front-end: oxc primary + Babel fallback + typescript@6 oracle, src/{normalize,oxc-parser,babel-parser,module-info,ts-oracle,safety,select}.ts, tests/, README.md
packages/core/                # base type layer: ParseResult contract, spans, tokens, scopes, diagnostics, CTransError
apps/cli/                     # CLI foundation: runCli + executable bin/ctrans.mjs (Node type stripping)
.gitignore
human-style-code.md           # engineering-judgment style guide (provided by human; AGENTS.md defers to it where compatible)
docs/
  research.md                 # verified tech survey w/ sources (parsers, prior art, semantics, security)
  architecture.md             # system architecture, package layout, core data model
  translation-pipeline.md     # stage graph, ledger schema, determinism guarantees
  language-support.md         # verified semantic divergences + per-construct mapping policy + direction matrix
  dependency-mapping.md       # registry schema, V1 module scope, sync→async propagation algorithm
  ai-architecture.md          # 3 AI ports, provider abstraction, OWASP v2 mitigations
  validation.md               # stage pipeline, claim ladder, capability matrix, failure codes
  security.md                 # threat model T1–T9, sandbox design, secrets policy
  testing.md                  # test pyramid, fixture system, ConstructMatrix, coverage floors
  benchmarks.md               # metrics (incl. differential equivalence), suites, integrity rules
  decisions.md                # 16 ADRs (D-001…D-016)
  roadmap.md                  # M0–M11 milestone plan w/ tests + DoD per milestone
tests/fixtures/               # fixture format contract + format-sample (input/expected/manifest)
benchmarks/README.md          # benchmark scaffold (populated from M4/M11)
```

## 7. Implemented Features

| Feature | Status | Location | Validation status |
| --- | --- | --- | --- |
| Engineering blueprint (13 docs) | Implemented | `docs/` | Research source-verified 2026-10-06 |
| Engineering rules (AGENTS.md) | Implemented | `AGENTS.md` | — |
| Monorepo toolchain (pnpm 10.26.0, TS 6.0.3, ESLint 10.12.0, Prettier 3.9.9, Vitest 5.0.3) | Implemented | root `package.json`, `eslint.config.js`, `vitest.config.ts`, `.prettierrc.json`, per-package `tsconfig.json` | Verified: `pnpm i && pnpm verify` green |
| Package skeletons (10 packages + CLI app) | Implemented | `packages/*/`, `apps/cli/` | Typecheck + smoke test per package; workspace layer rules test-enforced |
| Python front-end — CPython bridge (protocol v1) | Implemented | `packages/parser-py/python/bridge.py`, `src/client.ts`, `src/protocol.ts` | 80/80 tests incl. spans (multibyte/CRLF), symtable, tokens/comments, tagged constants, JSON round-trip, hostile-input security proofs |
| Python front-end — tree-sitter fallback | Implemented (degraded fidelity, documented) | `packages/parser-py/src/fallback.ts` | Parity smoke tests vs bridge (byte spans agree); selection policy tests |
| JS/TS front-end — oxc primary + Babel fallback | Implemented | `packages/parser-js/src/{oxc-parser,babel-parser,normalize,module-info,select}.ts` | 56 tests: JS/TS/JSX/TSX grammar, spans (multibyte/CRLF/BOM), comments, module map parity, error recovery, selection policy |
| TypeScript 6 semantic oracle | Implemented | `packages/parser-js/src/ts-oracle.ts` behind core `TsSemanticOracle` | Export-surface/type-at queries with contract spans; version guard refuses non-6.x |
| TS7 compiler-API boundary guard | Implemented | `scripts/ts7-guard.test.ts` | CI test: compiler-API imports restricted to the oracle adapter; 6.x pin checked in manifests + lockfile; tsgo references rejected |
| Native hostile-input containment (oxc segfault guard) | Implemented | `packages/parser-js/src/safety.ts` (ADR D-020) | Verified: ~8000-deep input (SIGSEGV before the fix) now yields typed `JsSourceLimitError`; hostile-input tests green |
| Cross-frontend parser contract tests | Implemented | `scripts/parser-contract.test.ts` | Shared invariants (metadata, span grid, comments, diagnostics, JSON round-trip, hostile nesting) across all four front-ends |
| Typed error taxonomy + bridge lifecycle (spawn/timeout/crash/protocol) | Implemented | `packages/parser-py/src/errors.ts`, `src/client.ts` | Failure-injection stub tests (hang/crash/malformed/mismatch/usage) |
| Parser contract types in `@ctrans/core` | Implemented | `packages/core/src/*` | Typechecked; consumed by parser-py (first cross-package edge) |
| CLI foundation (`--help`, `--version`, honest rejection of unimplemented commands) | Implemented | `apps/cli/src/main.ts`, `apps/cli/bin/ctrans.mjs` | 3 unit tests + direct executable run verified; no fake commands |
| Documentation-link checker | Implemented | `scripts/check-doc-links.mjs` (+ tests) | Caught and fixed one real broken Phase-1 link on first run |
| Fixture format contract + sample | Implemented | `tests/fixtures/` | Sample input parses (verified via `ast`); expected output is illustrative until M4 goldens exist |
| Python→TS translation | Not implemented | — | — |
| All translation directions | Not implemented | — | — |
| Parser front-ends | Not implemented | — | — |
| Semantic layer / module graph | Not implemented | — | — |
| Dependency registry | Not implemented | — | — |
| Validation pipeline | Not implemented | — | — |
| AI layer / repair loop | Not implemented | — | — |
| Sandbox | Not implemented | — | — |

## 8. Current Milestone

**Milestone objective: M3 — Semantic layer & module graph (`@ctrans/core`)** (`docs/roadmap.md`).
- **Status:** not started (M2 completed 2026-10-06).
- **M2 completed:** CPython bridge (stdlib-only `bridge.py`, protocol v1: one-shot stdin→stdout JSON envelopes, handshake + per-response header revalidation, exit-code contract); typed error taxonomy with failure-injection tests (hang→SIGKILL timeout, crash, malformed JSON, protocol mismatch, unsupported runtime, usage errors); exact byte-grid spans (UTF-8 byte offsets + 0-based line/byte column; multibyte, CRLF, phantom-final-line clamping); token/comment stream (INDENT/DEDENT/NL/NEWLINE/COMMENTS); symtable capture (module/function/class/annotation scopes, free/global/nonlocal/parameter flags, PEP 709 inlining documented); tagged constants (bigint/bytes/complex/inf/ellipsis, surrogate-safe); iterative AST encoders on both sides (stack-safe); tree-sitter fallback behind the same `PythonParser` interface with degraded fidelity + selection policy; package layering corrected (D-017) and first cross-package dependency wired (`parser-py` → `core`); protocol contract documented in `packages/parser-py/README.md`.
- **M2 delivered (detail):** oxc-parser primary wrapper (ESTree→AstNode normalization with memoized UTF-16→byte conversion, iterative stack-safe walk, dotted flattening of plain-object props); Babel fallback behind the same `JsParser` interface with recorded downgrades; module map (imports/exports/dynamic/hasModuleSyntax) extracted from the normalized AST so both parsers share one path; TypeScript 6 semantic oracle (`summarizeModule`, `typeAt`) with runtime 6.x guard; TS7 CI guard; hostile-input containment for the verified oxc ~8000-deep SIGSEGV (D-020); core contract extended (comments + module fields, `error` severity, `JsParser`, `TsSemanticOracle`, `ModuleInfo`, shared line-grid utils) per D-019.
- **In progress:** nothing.
- **Remaining for M3:** CommonType v1, scope/symbol resolution over both front-ends, ModuleGraph with SCC/topo ordering, ModuleContracts, ledger/report JSON schemas.

## 9. Important Technical Decisions

Full log: `docs/decisions.md` (16 ADRs). The ones another AI must not accidentally reverse:

| Decision | Reason | Alternatives considered & rejected |
| --- | --- | --- |
| D-001 TS/Node engine (pnpm monorepo) | in-process oxc + tsc Checker; both runtimes needed for validation anyway | Python engine (worse JS/TS API access); Rust (slower iteration, unneeded speed) |
| D-002 **No universal AST IR** — Semantic Layer instead | prior art (Transcrypt, metapensiero.pj, Babel) all do AST→AST + thin semantic layer; IR loses idiom fidelity; no N×M payoff at N=3 | Universal IR (rejected: design risk, comment/provenance loss). Revisit only if a non-JS/Python language family is added |
| D-003 Python parsing via CPython stdlib bridge | reference semantics, always matches interpreter, free symtable | Reimplementing Python parsing in JS (dead-end per prior art); tree-sitter primary (CST-only, no scopes, grammar lag → fallback only) |
| D-004 oxc-parser + typescript@6 oracle | TS 7.0 verified to ship no JS API; oxc: ESTree + error recovery + MIT | SWC (non-ESTree AST); Esprima (dormant); Acorn (no TS) |
| D-017 package layering: core = base type layer | AGENTS.md requires cross-package types in core; M1's normalization flow needs parser→core; the old `core → parser-*` arrow was internally inconsistent | Original arrow (would create cycles) |
| D-018 bridge protocol: one-shot JSON over stdin/stdout | deterministic, versioned, crash-isolated per file, no user-code execution surface | Persistent-process RPC (unneeded complexity for M1; batching can be protocol v2) |
| D-019 ParseResult: comments + module fields; JS emits comment-only tokens; `error` severity | M2 needs comments/module info; oxc recovery yields error-level findings; no JS token stream exists or is needed | Overloading `tokens` for JS comments (misleading); inventing a universal token model |
| D-020 depth screening before the native oxc call | verified: ~8000-deep input SIGSEGVs the process via oxc; no depth option exists; hostile input must never crash the host | Subprocess-per-parse containment (heavy); raw-scan-only (bypassable); Babel-first ordering (loses oxc recovery/metadata) |
| D-006 int→`number` default + precision diagnostics; `bigint` opt-in | Transcrypt precedent; BigInt can't mix with Number | bigint-by-default (verified semantically exact but ecosystem-hostile); revisit trigger documented |
| D-007 helpers codegen'd into output; zero runtime deps | local-first, no supply chain in user projects | runtime npm package |
| D-009 hardened spawn + bwrap autodetect; Docker strict opt-in | only realistic no-root cross-distro isolation (verified) | firejail (suid CVE history); systemd-run (no non-root network isolation); Docker-required (kills local-first) |
| D-010 AI = 3 escalation ports only, provider-agnostic, offline default | deterministic-first principle; OWASP LLM v2 | LLM-centric translation (verified ~27% naive correctness) |
| D-011 dependency mapping = registry + heuristics + AI proposals; entries must have usage tests | no public machine-readable stdlib→Node dataset exists (verified); AI-only is unverifiable | pure-AI mapping; pure-heuristics |
| D-012/D-015 canonical formatters finalize all emitted code (prettier/ruff format) | stable reviewable goldens; idiomatic output | hand-formatted emitters (churn) |
| D-013 CLI-first, no GUI in V1 | validate engine value first | Electron/Tauri/web UI now |

## 10. Translation Pipeline

- **Current actual pipeline:** the **parse stage is real for both language families**: `Python source → bridge (CPython stdlib) → validated JSON → ParseResult` and `JS/TS source → oxc (Babel fallback) → normalized ParseResult + module map`; TypeScript additionally answers symbol/type queries via the pinned TS 6 oracle. Everything after parsing (semantic layer, lowering, codegen, dependency mapping, validation, repair) is approved spec (ledger JSON schema, ambiguity-resolution order: heuristic default → optional AI escalation → `TODO(ctrans)` + warning; never block on AI).
- **Determinism guarantee (spec):** stages 0–8 byte-identical for identical inputs/config/toolchain; stage 10 (AI repair) non-deterministic by nature and therefore re-enters deterministic validation.

## 11. AI Architecture

- **AI is used (spec):** (1) `resolveAmbiguity` for engine-classified `ambiguous` constructs — must *choose among offered options*, never invent behavior; (2) `proposeRepairPatch` in the bounded repair loop (unit-scoped unified diffs, re-validated); (3) optional off-by-default idiom polish.
- **AI is not used (spec):** parsing, symbol/type resolution, lowering, codegen, dependency registry lookups, validation verdicts. CI goldens never call AI.
- **Provider abstraction (spec):** `ChatModel.complete()` interface; adapters for OpenAI-compatible endpoints (incl. Ollama/vLLM/llama.cpp), Anthropic, custom endpoints; secretlint-based hard gate before any request; caps (calls/tokens/USD/wall-clock) enforced in code; prompt payloads = unit AST + direct-dep ModuleContracts + diagnostics, token-budgeted — whole-project prompts forbidden.
- All of the above is **Not implemented**; the layer must work with AI fully disabled (offline default).

## 12. Testing

- **Framework:** Vitest 5.0.3 (installed; single root `vitest.config.ts`).
- **Number of tests:** 158 (34 files; M2 added 78: JS/TS/JSX/TSX grammar coverage, spans incl. multibyte/CRLF/BOM, comments in all positions, module-map parity, oxc error recovery, Babel fallback + selection policy, TS oracle queries, hostile inputs incl. the depth screen, cross-frontend contract tests, TS7 boundary guard).
- **Passing / Failing / Skipped:** 158 / 0 / 0 (verified 2026-10-06 via `pnpm verify`).
- **Planned strategy** (`docs/testing.md`): ConstructMatrix (every entry of `language-support.md` §2 × direction, incl. negative tests for `unsupported`), golden fixtures with canonical-formatter normalization + review-required acceptance, registry usage tests in CI, validation/repair tests with FakeChatModel, e2e CLI tests, license-clean corpus. Coverage floors from M4: core ≥85%, parser/codegen ≥90%. Regression rule: every bug fix lands with a fixture.

## 13. Benchmark Results

None yet. Framework designed (`docs/benchmarks.md`): headline metric = **differential equivalence** (source-vs-target test outcome match rate, S6); suites micro / mini-projects / corpus / perf; AI-enabled runs reported separately from deterministic trends.

## 14. Known Bugs

None open. Fixed with regression tests during M1: bridge complex-scalar serializer used `.imaginary` instead of Python's `.imag`; token spans crashed with IndexError on sources lacking a trailing newline (phantom tokenizer line, now clamped to end-of-file). Fixed during M2: the module-map extraction walked the AST in reverse order (LIFO stack bug) producing reversed import/export lists; `export * as ns` from Babel (a namespace specifier inside a named export) now normalizes to the same `star-as` entry as oxc.

## 15. Known Limitations

Intentional, documented V1 limitations (all produce loud warnings, never silent misbehavior — `docs/language-support.md` §4):
- `unsupported`: metaclasses, descriptors, `except*`/exception groups, class/sequence/mapping `match` patterns, `__hash__`-dependent keying, threads/multiprocessing, C-extension stdlib modules, PEP 750 t-strings.
- Sync→async propagation (e.g., `requests`→`fetch`) changes public signatures — reported per-signature.
- Python grammar range 3.12–3.14; tree-sitter fallback is explicitly lower-fidelity.
- JS→TS emits honest `unknown`s, not invented types (ts-migrate's `any`-flooding rejected as a failure mode).
- Registry v1 covers a fixed module list; unmapped third-party deps are reported, never guessed.
- Full-fidelity int arithmetic requires `intMode=bigint`; default `number` mode warns on precision-risky patterns.
- CLI executable runs from TS sources via Node type stripping (`apps/cli/bin/ctrans.mjs`), hence `engines >= 22.18`; replaced by a compiled dist entry in M4.
- No build/dist emission yet (deliberate — nothing consumes compiled output before M1); packages resolve via `exports -> src/index.ts` under `tsc --noEmit`.
- No cross-package dependencies declared yet (wired when real imports appear; layer rules already enforced by `scripts/workspace-boundaries.test.ts`).
- ESLint is non-type-aware for now (recommended set); type-aware linting is a candidate from M1.
- Prettier deliberately excludes `*.md` and `tests/fixtures/**` (hand-written docs; golden data with its own formatting pipeline).
- `parse(source: string)` transports decoded text as UTF-8: source files in non-UTF-8 encodings must be decoded by the caller (project intake, M6); UTF-8 with/without BOM parses directly.
- Python front-end verified on the environment's 3.14.7 interpreter; 3.12/3.13 are accepted by the version handshake but were not exercised here.
- tree-sitter fallback is CST-shaped (`children` fields, no CPython field names) with **no scope analysis** — always `fidelity: "degraded"` + visible diagnostics; consumers must check the parser metadata.
- pnpm blocks `tree-sitter-python`'s native build scripts by design; only the prebuilt `.wasm` grammar is consumed.
- JS/TS parse uses module semantics: script-only constructs modules forbid (e.g. `with`) fail to parse; `hasModuleSyntax` still distinguishes scripts.
- Babel's recoverable/unrecoverable boundary differs from oxc's; both outcomes are structured (result diagnostics or typed `JsSyntaxError`).
- oxc crash window: inputs nesting above `MAX_SAFE_NESTING_DEPTH` (2000) are rejected with a typed limit error (D-020) — far above real code.
- JS scopes are `null` until M3; TypeScript symbol/type needs are covered meanwhile by the semantic oracle.

## 16. Failed Approaches (researched and rejected, with reasons)

- **Universal intermediate representation** — rejected for D-002 reasons (see §9); the strongest prior art does not use one.
- **Embedding pyright internals as a library** — no public API; unstable between releases; only proven pattern is a fork-and-pin (basedpyright). Using pinned CLI + JSON instead.
- **TypeScript 7 (tsgo) as semantic engine** — verified: 7.0 ships no JS API; would require waiting for 7.1. Pinned `typescript@6` behind an adapter instead.
- **js2py as JS-execution substrate** — unpatched sandbox-escape RCE (CVE-2024-28397); unmaintained.
- **trufflehog for secret scanning** — AGPL-3.0; embedding license risk. secretlint (MIT) chosen.
- **semgrep / GitHub `semantic` as rewrite substrate** — LGPL + scan-oriented; archived respectively.
- **firejail / systemd-run for sandboxing** — suid-root CVE history; non-root cannot isolate network.
- **island-style WASM execution (Pyodide) for validation** — not a security boundary; cannot run subprocess-using test suites. Optional pure-Python oracle only.
- **LLM-as-translator architecture** — verified ~26.65% naive correctness; every credible system wraps generation in test-driven validation → our deterministic-first + escalation design.
- **ts-migrate-style JS→TS (blanket `any`)** — dishonest types; our JS→TS emits `unknown` + diagnostics instead.

## 17. Security

Model (`docs/security.md`): local-first; user code is untrusted data; parsing never executes (Python bridge imports only stdlib `ast`/`symtable`/`tokenize` on the file's *syntax*, never user modules); all execution (S5/S6 tests) through `@ctrans/sandbox` with no network by default, timeouts, output caps, temp cwd, env whitelist; strict mode (Docker/Podman, gVisor optional) **errors rather than downgrades** when unavailable; secret-scan hard gate before any AI request; keys in OS keychain → 0600 file fallback with warning (gh CLI model); never run `pip install`/`npm install` of translated projects without explicit consent; model output is data (option-choices or validated diffs), never commands. Known concerns: bwrap unavailable on hardened kernels (capability-detected); npm supply-chain risk mitigated by lockfile pinning + pnpm script-blocking.

## 18. Dependencies

**Installed (root devDependencies, lockfile committed):** `@types/node` 24.19.1, `eslint` 10.12.0, `prettier` 3.9.9, `typescript` 6.0.3, `typescript-eslint` 8.71.1, `vitest` 5.0.3, plus workspace links (`@ctrans/core`, `@ctrans/parser-py`, `@ctrans/parser-js`) for repo-level guard/contract tests. **Package dependencies:** `@ctrans/parser-py` → `@ctrans/core` (workspace), `web-tree-sitter` 0.27.0, `tree-sitter-python` 0.25.0 (prebuilt wasm only; native build scripts stay blocked); `@ctrans/parser-js` → `@ctrans/core` (workspace), `oxc-parser` 0.153.0 (MIT), `@babel/parser` 8.0.6 (MIT), `typescript` ~6.0.3 (Apache-2.0, pinned by ADR D-004 + CI guard). `pnpm.onlyBuiltDependencies: ["esbuild"]` (explicit allowlist). Runtime deps of *generated output*: **zero by policy (D-007)**.

## 19. Recent Changes

- **2026-10-06 (Phase 1):** created repository; ran 4-track verified research (parsers, prior art, semantics/deps, security/toolchain) → `docs/research.md`; wrote 12 design docs + 16 ADRs; scaffolded monorepo configs; created `AGENTS.md`; created fixture-format contract + sample; referenced human-provided `human-style-code.md` from AGENTS.md; created this `PROJECT_STATE.md`.
- **2026-10-06 (M0):** git initialized (commits: Phase-1 blueprint, then M0 foundation); pnpm 10.26.0 workspace installed via corepack (registry throttling slowed install — retried with patient fetch settings); strict TS 6.0.3 + ESLint 10 flat config + Prettier 3 + Vitest 5 wired; 10 package skeletons + CLI app with executable `bin/ctrans.mjs` (Node type stripping); `pnpm verify` composed (typecheck → lint → format:check → test → docs:check); doc-link checker caught and fixed one real broken link in `tests/fixtures/README.md`; fresh-clone flow verified (`git clone` → `pnpm i` → `pnpm verify` green).
- **2026-10-06 (M1):** implemented the Python front-end: protocol-v1 bridge (`bridge.py`: ast + symtable + tokenize → one JSON envelope; iterative stack-safe encoders; tagged scalars; byte-grid spans), TS client (spawn lifecycle, 30s timeout + SIGKILL, size caps, typed error taxonomy, per-response header revalidation), tree-sitter fallback behind the same `PythonParser` interface (degraded fidelity, selection policy `createPythonParser({allowFallback})`); fixed architecture layering via ADR D-017 (core = base type layer) and recorded the protocol as D-018; wired the first cross-package dependency (`parser-py` → `core`) and updated the boundary test; found and fixed 2 bridge bugs (complex `.imag`; phantom final line IndexError) with regression tests; documented the protocol in `packages/parser-py/README.md`; 80/80 tests green.
- **2026-10-06 (M2):** implemented the JS/TS front-end: oxc-parser primary with ESTree→AstNode normalization (memoized UTF-16→byte conversion, iterative stack-safe walk, dotted flattening of plain-object props); Babel 8 fallback behind the same `JsParser` interface with recorded downgrades; module map extracted from the normalized AST (imports/exports/dynamic/hasModuleSyntax, parser-shape differences normalized); TypeScript 6 semantic oracle (`summarizeModule`/`typeAt`, plain-data interface, runtime 6.x guard) as the repository's only compiler-API consumer; **discovered and contained a real oxc segfault** (~8000-deep nesting SIGSEGVs the process; verified 4000 parses) via depth screening + typed limit errors (ADR D-020); core contract extended per D-019 (comments + module fields, `error` severity, `JsParser`, `TsSemanticOracle`, `ModuleInfo`, shared line-grid utils moved to core); TS7 CI guard (`scripts/ts7-guard.test.ts`); cross-frontend contract tests; fixed module-map reverse-order walk bug; documented in `packages/parser-js/README.md`; 158/158 tests green.

## 20. Current Blockers

None. Environmental note: the npm registry was intermittently throttled during M0/M1 installs — pnpm retries handle it; no repo impact. Corepack downloads the pinned pnpm 10.26.0 automatically on fresh machines (first use may prompt).

## 21. Next Recommended Actions

Ordered (detail in `docs/roadmap.md` M0, then M1):
1. M3 (`@ctrans/core`): CommonType v1; scope/symbol resolution over both front-ends (JS scopes are built here — front-ends report `scopes: null`); ModuleGraph builder with SCC condensation + topological ordering; ModuleContracts; TransformationLedger + report JSON schemas. Python imports join `result.module` here (bridge extension).
2. M4 (`@ctrans/core` + `@ctrans/codegen-js`): pipeline skeleton + Python→TS/JS codegen for the core subset; ConstructMatrix fixtures; claim ladder v1.
3. Build/dist strategy stays deferred until a runtime consumer needs compiled output (packages are `noEmit` resolving via `exports -> src/index.ts`; the CLI runs via Node type stripping).

## 22. Definition of Done (current milestone, M0)

Per `docs/roadmap.md` M3 + AGENTS.md §12: scope/symbol resolution verified against fixtures for both languages (closures, class-scope invisibility, comprehension scoping, imports); CommonType inference snapshot matrix; ModuleGraph fixtures (packages, `__init__.py`, cycles, dynamic imports) proving dependents-after-dependencies ordering; ModuleContracts matching the real export surface (cross-checked against tsc/pyright on fixtures); ledger/report JSON schemas validated on round-trip; all `pnpm verify` gates stay green; `PROJECT_STATE.md` updated with verified claims.

## 23. Handoff Notes

- **Read `AGENTS.md` first** — its rules are binding (forbidden shortcuts incl. regex-based "parsing", emitting code without ledger provenance, claiming unrun validation, weakening sandbox/tests, copying GPL code). `human-style-code.md` is the judgment baseline; AGENTS.md wins on overlap.
- **Deviations from the original prompt, all documented and reasoned:** (1) "Intermediate Representation" → Semantic Layer without a universal AST IR (D-002); (2) "Basic GUI" moved out of V1 (D-013); (3) translation directions framed as a *graded support matrix* with explicit `unsupported` classes rather than uniform coverage (product principle: never silently pretend correctness). If the human wants these reversed, they are deliberate change requests, not omissions.
- **Verified facts that must not drift:** TypeScript 7.0 has no JS API (pin typescript@6); TC39 decorators are Stage 2.7; Temporal is Stage 4 (Node ≥26 ships it); `fetch` has no sync variant; `int`/`%`/truthiness/string divergences are source-verified in `docs/research.md` §3. Re-verify pinned versions when installing dependencies (research date: 2026-10-06).
- **Honesty invariant:** every emitted construct needs a ledger entry (`deterministic|semantic|ambiguous|unsupported`); validation reports `skipped(reason)` rather than assuming capabilities; the claim ladder (`docs/validation.md` §2) caps what a run may assert — "Generated ≠ Validated".
- Where to look: roadmap = `docs/roadmap.md`; per-construct mapping rules = `docs/language-support.md`; ledger/JSON schemas = `docs/translation-pipeline.md` + `docs/architecture.md` §4; ADRs = `docs/decisions.md`.
- **M0 mechanics the next implementer must keep:** `pnpm verify` = root `tsc -p tsconfig.json` (scripts/configs) + `pnpm -r typecheck` + ESLint + `prettier --check` + `vitest run` + `node scripts/check-doc-links.mjs`. Packages are `noEmit` and will resolve future cross-package imports via `exports -> src/index.ts`; dist emission is deliberately deferred. Workspace layer rules live in `scripts/workspace-boundaries.test.ts` (`LAYERS` map). `bin/ctrans.mjs` relies on Node type stripping (Node ≥22.18) until M4's build step. Never run Prettier over `*.md` or `tests/fixtures/**` (ignored on purpose); ESLint likewise ignores fixture data.
- **M1 mechanics:** the bridge protocol contract (envelope shapes, exit codes, span units, tagged scalars, limits) is specified in `packages/parser-py/README.md` and implemented twice-by-design (bridge.py emits, protocol.ts validates) — change both together. Bridge output is semi-trusted: never consume it without `protocol.ts` guards. The `PythonParser` interface lives in `@ctrans/core/src/parser.ts`; new front-ends implement it. Positions everywhere are UTF-8 byte offsets + 0-based line / byte column (tokenize/tree-sitter code-point columns are converted at the boundary). Behavior verified on Python 3.14: comprehension scopes may be inlined (PEP 709) and `__annotate__` scopes hang off the *enclosing* scope — scope-shape assumptions must stay version-tolerant.
- **M2 mechanics:** the JS/TS contract details live in `packages/parser-js/README.md`. oxc and Babel both report UTF-16 indices — `normalize.ts` converts to the byte grid; never trust parser columns. oxc segfaults on deep nesting (D-020): any new native-parser path must go through `safety.ts` screening. The compiler API is ONLY allowed in `packages/parser-js/src/ts-oracle.ts` (CI-enforced); TS 6 quirks already hit: no `SourceFile.symbol`/`getTokenAtPosition` on the public surface (use `checker.getSymbolAtLocation` / manual descent), Babel 8 string plugins need a documented cast, TS 2322 anchors at the declarator. Module-map entries are order-stable because the AST walk pushes children reversed onto its LIFO stack — preserve that when editing `module-info.ts`.
- Environment: Node 24.15 (LTS), Python 3.14.7, Docker 29.8.1 + Podman 5.8.7 available locally; Rust toolchain present (unused by design). `ctrans doctor` (M10) will formalize capability reporting.
