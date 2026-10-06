# Code Translator — Project State

> Canonical handoff document. An AI reading **only this file** must understand the project and be able to produce the next engineering prompt. Detailed design lives in `docs/` (linked, not duplicated). Maintenance rules: `AGENTS.md` §13.
> Last updated: **2026-10-06** (Phase 1 — research & blueprint — completed; verified against the actual repository on this date).

## 1. Project Identity

- **Project name:** Code Translator
- **Current version:** 0.0.0 (design phase — no engine code exists yet)
- **Current milestone:** Phase 1 (research + architecture blueprint) **complete**. Next: **M0 — Repository foundation & toolchain** (first implementation milestone).
- **Overall status:** Blueprint approved and documented; repository scaffolded; implementation not started.

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
| Engine | TypeScript (strict) on Node ≥22.12, pnpm 10 monorepo (D-001) | Config scaffolded; packages not yet created |
| Python parser | `python3` subprocess bridge over stdlib `ast`/`symtable`/`tokenize` → JSON; `web-tree-sitter` fallback (D-003) | Not implemented |
| JS/TS parser | `oxc-parser` (primary), `@babel/parser` (fallback), `typescript@6` compiler API as semantic oracle (D-004) | Not implemented |
| IR | **No universal AST IR**; Semantic Layer = CommonType + symbols + ModuleGraph + TransformationLedger (D-002) | Spec written in `docs/architecture.md` §4 |
| Output checkers | `tsc --noEmit` (typescript@6) for TS; pyright CLI `--outputjson` (pinned) + optional mypy 2.4 for Python (D-005) | Not implemented |
| Database | None (file/JSON artifacts under `.ctrans/`) | — |
| Sandbox | Hardened `spawn` + `prlimit` + auto-detected bubblewrap; Docker/Podman strict mode opt-in (D-009) | Not implemented |
| AI | Provider-agnostic `ChatModel` interface; OpenAI-compatible/Anthropic/custom adapters; 3 escalation ports only; offline default (D-010) | Not implemented |
| Testing | Vitest 5; golden fixtures (`tests/fixtures/`), ConstructMatrix, benchmarks (D-012) | Framework chosen; not installed yet |

**Critical version fact (verified 2026-10-06):** TypeScript 7.0 (native Go) ships **no JS API**; all compiler-API use must pin `typescript@6` / `@typescript/typescript6` behind an adapter until TS 7.1's new API lands.

## 6. Repository Structure

```
AGENTS.md                     # binding engineering rules (read first; §13 = state-file rules)
PROJECT_STATE.md              # this file — the handoff contract
README.md                     # product overview + doc index
LICENSE                       # MIT
package.json / pnpm-workspace.yaml / tsconfig.base.json   # monorepo scaffolding (strict TS)
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
| Monorepo scaffolding configs | Implemented | `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `.gitignore` | JSON/YAML validated; **toolchain not yet installed/run** |
| Fixture format contract + sample | Implemented | `tests/fixtures/` | Sample input parses (verified via `ast`); expected output is illustrative until M4 goldens exist |
| Python→TS translation | Not implemented | — | — |
| All translation directions | Not implemented | — | — |
| Parser front-ends | Not implemented | — | — |
| Semantic layer / module graph | Not implemented | — | — |
| Dependency registry | Not implemented | — | — |
| Validation pipeline | Not implemented | — | — |
| AI layer / repair loop | Not implemented | — | — |
| Sandbox | Not implemented | — | — |
| CLI | Not implemented | — | — |

## 8. Current Milestone

**Milestone objective (next): M0 — Repository foundation & toolchain** (`docs/roadmap.md`).
- **Status:** not started.
- **Completed:** all Phase-1 prerequisites (docs, decisions, roadmap, scaffolding configs).
- **In progress:** nothing.
- **Remaining:** pnpm workspace install (`corepack enable && pnpm i` — pnpm not yet installed locally); ESLint 10 flat config; Prettier 3; Vitest 5 wiring; `pnpm verify` script (typecheck+lint+test+docs-link-lint); empty package skeletons for `packages/*` + `apps/cli`; smoke test per package.
- **M0 DoD:** fresh clone → one command (`pnpm i && pnpm verify`) passes; lint rules mechanically enforce AGENTS.md §2 basics (no `any` outside boundaries, no default exports).

## 9. Important Technical Decisions

Full log: `docs/decisions.md` (16 ADRs). The ones another AI must not accidentally reverse:

| Decision | Reason | Alternatives considered & rejected |
| --- | --- | --- |
| D-001 TS/Node engine (pnpm monorepo) | in-process oxc + tsc Checker; both runtimes needed for validation anyway | Python engine (worse JS/TS API access); Rust (slower iteration, unneeded speed) |
| D-002 **No universal AST IR** — Semantic Layer instead | prior art (Transcrypt, metapensiero.pj, Babel) all do AST→AST + thin semantic layer; IR loses idiom fidelity; no N×M payoff at N=3 | Universal IR (rejected: design risk, comment/provenance loss). Revisit only if a non-JS/Python language family is added |
| D-003 Python parsing via CPython stdlib bridge | reference semantics, always matches interpreter, free symtable | Reimplementing Python parsing in JS (dead-end per prior art); tree-sitter primary (CST-only, no scopes, grammar lag → fallback only) |
| D-004 oxc-parser + typescript@6 oracle | TS 7.0 verified to ship no JS API; oxc: ESTree + error recovery + MIT | SWC (non-ESTree AST); Esprima (dormant); Acorn (no TS) |
| D-006 int→`number` default + precision diagnostics; `bigint` opt-in | Transcrypt precedent; BigInt can't mix with Number | bigint-by-default (verified semantically exact but ecosystem-hostile); revisit trigger documented |
| D-007 helpers codegen'd into output; zero runtime deps | local-first, no supply chain in user projects | runtime npm package |
| D-009 hardened spawn + bwrap autodetect; Docker strict opt-in | only realistic no-root cross-distro isolation (verified) | firejail (suid CVE history); systemd-run (no non-root network isolation); Docker-required (kills local-first) |
| D-010 AI = 3 escalation ports only, provider-agnostic, offline default | deterministic-first principle; OWASP LLM v2 | LLM-centric translation (verified ~27% naive correctness) |
| D-011 dependency mapping = registry + heuristics + AI proposals; entries must have usage tests | no public machine-readable stdlib→Node dataset exists (verified); AI-only is unverifiable | pure-AI mapping; pure-heuristics |
| D-012/D-015 canonical formatters finalize all emitted code (prettier/ruff format) | stable reviewable goldens; idiomatic output | hand-formatted emitters (churn) |
| D-013 CLI-first, no GUI in V1 | validate engine value first | Electron/Tauri/web UI now |

## 10. Translation Pipeline

- **Current actual pipeline:** none implemented. Parser front-ends, semantic layer, codegen, validation, and repair exist only as approved specs (sections 1–11 of `docs/translation-pipeline.md`, including the ledger JSON schema and the ambiguity-resolution order: heuristic default → optional AI escalation → `TODO(ctrans)` + warning; never block on AI).
- **Determinism guarantee (spec):** stages 0–8 byte-identical for identical inputs/config/toolchain; stage 10 (AI repair) non-deterministic by nature and therefore re-enters deterministic validation.

## 11. AI Architecture

- **AI is used (spec):** (1) `resolveAmbiguity` for engine-classified `ambiguous` constructs — must *choose among offered options*, never invent behavior; (2) `proposeRepairPatch` in the bounded repair loop (unit-scoped unified diffs, re-validated); (3) optional off-by-default idiom polish.
- **AI is not used (spec):** parsing, symbol/type resolution, lowering, codegen, dependency registry lookups, validation verdicts. CI goldens never call AI.
- **Provider abstraction (spec):** `ChatModel.complete()` interface; adapters for OpenAI-compatible endpoints (incl. Ollama/vLLM/llama.cpp), Anthropic, custom endpoints; secretlint-based hard gate before any request; caps (calls/tokens/USD/wall-clock) enforced in code; prompt payloads = unit AST + direct-dep ModuleContracts + diagnostics, token-budgeted — whole-project prompts forbidden.
- All of the above is **Not implemented**; the layer must work with AI fully disabled (offline default).

## 12. Testing

- **Framework:** Vitest 5 (chosen, not yet installed).
- **Number of tests: 0** (no engine code exists; M0 wires the runner).
- **Passing / Failing / Skipped:** n/a.
- **Planned strategy** (`docs/testing.md`): ConstructMatrix (every entry of `language-support.md` §2 × direction, incl. negative tests for `unsupported`), golden fixtures with canonical-formatter normalization + review-required acceptance, registry usage tests in CI, validation/repair tests with FakeChatModel, e2e CLI tests, license-clean corpus. Coverage floors from M4: core ≥85%, parser/codegen ≥90%. Regression rule: every bug fix lands with a fixture.

## 13. Benchmark Results

None yet. Framework designed (`docs/benchmarks.md`): headline metric = **differential equivalence** (source-vs-target test outcome match rate, S6); suites micro / mini-projects / corpus / perf; AI-enabled runs reported separately from deterministic trends.

## 14. Known Bugs

None — no engine code exists to contain bugs. (This section will list: bug, severity, status, component.)

## 15. Known Limitations

Intentional, documented V1 limitations (all produce loud warnings, never silent misbehavior — `docs/language-support.md` §4):
- `unsupported`: metaclasses, descriptors, `except*`/exception groups, class/sequence/mapping `match` patterns, `__hash__`-dependent keying, threads/multiprocessing, C-extension stdlib modules, PEP 750 t-strings.
- Sync→async propagation (e.g., `requests`→`fetch`) changes public signatures — reported per-signature.
- Python grammar range 3.12–3.14; tree-sitter fallback is explicitly lower-fidelity.
- JS→TS emits honest `unknown`s, not invented types (ts-migrate's `any`-flooding rejected as a failure mode).
- Registry v1 covers a fixed module list; unmapped third-party deps are reported, never guessed.
- Full-fidelity int arithmetic requires `intMode=bigint`; default `number` mode warns on precision-risky patterns.

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

**Currently installed: none** (scaffolding only). Planned (all to be recorded per AGENTS.md §5 with license check): `oxc-parser`, `typescript@6` (+ `@typescript/typescript6`), `@babel/parser` (fallback), `web-tree-sitter` + `tree-sitter-python` (fallback), `pyright` (pinned CLI), `prettier`, `ruff` (external binary, Python output formatting), `secretlint` (or its rules), `vitest`, `eslint@10`, `typescript` (build). Runtime deps of *generated output*: **zero by policy (D-007)**. License allowlist: MIT/Apache-2.0/BSD only; GPL/AGPL/CC-BY-NC = learn-only (D-014).

## 19. Recent Changes

- **2026-10-06 (Phase 1):** created repository; ran 4-track verified research (parsers, prior art, semantics/deps, security/toolchain) → `docs/research.md`; wrote 12 design docs + 16 ADRs; scaffolded monorepo configs; created `AGENTS.md`; created fixture-format contract + sample; referenced human-provided `human-style-code.md` from AGENTS.md; created this `PROJECT_STATE.md`.

## 20. Current Blockers

None. Minor environmental note: `pnpm` is not installed on the dev machine yet (Node 24.15 and corepack are available) — that is the first M0 task, not a blocker. No git history yet (repo not initialized; make `git init` + initial commit the first M0 action).

## 21. Next Recommended Actions

Ordered (detail in `docs/roadmap.md` M0, then M1):
1. `git init`, initial commit of the blueprint state.
2. M0: install/enable pnpm (corepack), `pnpm i`; add ESLint 10 flat config, Prettier 3, Vitest 5; create `pnpm verify` (typecheck + lint + test + docs-link lint); create empty package skeletons per `docs/architecture.md` §3; one smoke test per package.
3. M1 (`@ctrans/parser-py`): stdlib-only `bridge.py` (AST + symtable + tokens/comments → JSON, version handshake, recursion caps), TS bridge client with typed errors, AST normalization, tree-sitter fallback behind the same interface; span-fidelity/symtable/hostile-input tests.
4. M2 (`@ctrans/parser-js`): oxc wrapper + typescript@6 oracle adapter (CI grep-gate: no TS7 API usage).
5. M3 (`@ctrans/core`): CommonType, scope/symbol resolution, ModuleGraph + SCC ordering, ModuleContracts, ledger/report JSON schemas.

## 22. Definition of Done (current milestone, M0)

Per `docs/roadmap.md` M0 + AGENTS.md §12: fresh-clone `pnpm i && pnpm verify` passes in one command; strict TS compiles; lint/format configured and clean; Vitest runs one smoke test per package skeleton; docs-link lint passes; no engine logic pretended into existence; `PROJECT_STATE.md` updated to reflect M0 completion with verified claims.

## 23. Handoff Notes

- **Read `AGENTS.md` first** — its rules are binding (forbidden shortcuts incl. regex-based "parsing", emitting code without ledger provenance, claiming unrun validation, weakening sandbox/tests, copying GPL code). `human-style-code.md` is the judgment baseline; AGENTS.md wins on overlap.
- **Deviations from the original prompt, all documented and reasoned:** (1) "Intermediate Representation" → Semantic Layer without a universal AST IR (D-002); (2) "Basic GUI" moved out of V1 (D-013); (3) translation directions framed as a *graded support matrix* with explicit `unsupported` classes rather than uniform coverage (product principle: never silently pretend correctness). If the human wants these reversed, they are deliberate change requests, not omissions.
- **Verified facts that must not drift:** TypeScript 7.0 has no JS API (pin typescript@6); TC39 decorators are Stage 2.7; Temporal is Stage 4 (Node ≥26 ships it); `fetch` has no sync variant; `int`/`%`/truthiness/string divergences are source-verified in `docs/research.md` §3. Re-verify pinned versions when installing dependencies (research date: 2026-10-06).
- **Honesty invariant:** every emitted construct needs a ledger entry (`deterministic|semantic|ambiguous|unsupported`); validation reports `skipped(reason)` rather than assuming capabilities; the claim ladder (`docs/validation.md` §2) caps what a run may assert — "Generated ≠ Validated".
- Where to look: roadmap = `docs/roadmap.md`; per-construct mapping rules = `docs/language-support.md`; ledger/JSON schemas = `docs/translation-pipeline.md` + `docs/architecture.md` §4; ADRs = `docs/decisions.md`.
- Environment: Node 24.15 (LTS), Python 3.14.7, Docker 29.8.1 + Podman 5.8.7 available locally; Rust toolchain present (unused by design). `ctrans doctor` (M10) will formalize capability reporting.
