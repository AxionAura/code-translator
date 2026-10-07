# Architecture

Status: **approved blueprint** (M0 not started). Decisions referenced as D-xxx live in [decisions.md](decisions.md).

## 1. System overview

Code Translator is a deterministic compiler pipeline with two escalation points into an optional AI layer, wrapped by a validation engine that refuses to overclaim.

```
Source Project
   ↓
Project Analysis ──────────────► Module Graph (imports, symbols, entry points, tests)
   ↓
Language Parsing        (per front-end: CPython bridge | oxc + typescript@6)
   ↓
Annotated AST + Semantic Layer  (CommonType, symbols, scopes — D-002: no universal AST)
   ↓
Lowering & Code Generation      (per direction; ledger records every decision)
   ↓
Target Project + Registry-driven dependency mapping
   ↓
Test Translation                (pytest→vitest / vitest→pytest, best effort)
   ↓
Validation Engine               (syntax → types → dependencies → build → tests → differential)
   ↓
Failure? ──► Classification ──► Bounded AI-assisted Repair ──► Re-validation (bounded)
   ↓
Final Target Project + Reports  (translation report, decision ledger, validation report)
```

## 2. Non-negotiable architectural principles

1. **Deterministic engine + AI resolver + validation engine** are three separate components. The deterministic engine must produce a complete (possibly warning-laden) result with AI disabled.
2. **No universal AST IR (D-002).** Each language keeps its own source-shaped AST. Cross-language reasoning happens only through the Semantic Layer: a normalized type model, symbol/scope tables, and the module graph. Rationale: every mature prior art system (Transcrypt, metapensiero.pj, Babel ecosystem) translates AST→AST with a thin semantic layer; a universal IR at N=3 languages adds design risk and destroys source-idiom fidelity for zero N×M savings. Revisit trigger: adding a language outside the JS/Python family.
3. **Four decision classes (product principle).** Every emitted construct gets a ledger entry:
   - `deterministic` — provably equivalent mapping applied.
   - `semantic` — deliberate adaptation applied (e.g., truthiness helper, floor-division correction); carries an `adaptation` description.
   - `ambiguous` — multiple plausible mappings; resolved by documented heuristic default, optional AI escalation, or explicit `TODO(ctrans)` marker.
   - `unsupported` — no safe mapping; original code preserved as a comment + warning; counts as a failure in reports. **Never fabricated behavior.**
4. **Zero runtime dependencies in output (D-007).** Helpers (`truthy()`, slicing, exception classes, int coercion) are generated into the output project (`__ctrans_runtime.ts` / `__ctrans_runtime.py`), only when used.
5. **Unlimited project context ≠ unlimited model context.** AI escalations and repair prompts receive *module-contract subgraphs* (§7), never whole projects.
6. **Local-first.** No network calls unless an AI provider is explicitly configured and content passed the secret-scanning gate.

## 3. Monorepo layout

pnpm workspaces, TypeScript (Node ≥22.12; ≥26 recommended for Temporal-based datetime fidelity).

```
packages/
  core/          @ctrans/core    — semantic layer, module graph, ledger, pipeline
                                 — orchestration, config schema, error model, logger
  parser-py/     @ctrans/parser-py   — CPython bridge (ast+symtable+tokenize → JSON) + tree-sitter fallback
  parser-js/     @ctrans/parser-js   — oxc-parser wrapper + typescript@6 semantic oracle adapter
  codegen-js/    @ctrans/codegen-js  — Python AST → TS/JS lowering + emitter (+ helper template)
  codegen-py/    @ctrans/codegen-py  — JS/TS AST → Python lowering + emitter (+ helper template)
  registry/      @ctrans/registry    — dependency-mapping data (JSON) + schema + resolver queries
  validator/     @ctrans/validator   — validation stages, capability detection, reports
  sandbox/       @ctrans/sandbox     — process execution: hardened spawn, prlimit, bwrap, docker driver
  repair/        @ctrans/repair      — failure classification, bounded repair loop, change tracking
  ai/            @ctrans/ai          — ChatModel interface, provider adapters, prompt packer, secret gate
apps/
  cli/           ctrans              — CLI (commander-style, zero framework religion)
```

Dependency direction (acyclic, one-way for types; ADR D-017): `@ctrans/core` is the **base layer** — it owns every cross-package type (`ParseResult`, spans, diagnostics, token/scope shapes, the error base) and the engine interfaces (e.g. `PythonParser`), and orchestrates through those interfaces instead of importing implementations. Implementation packages depend on core; `apps/cli` wires the concrete implementations:

```
cli(4) → repair(3) → {validator(2), ai(2)} → {parser-*, codegen-*, registry, sandbox}(1) → core(0)
```

Numbers are layers; a package may depend only on strictly lower layers, enforced mechanically by `scripts/workspace-boundaries.test.ts`. Package internals are private.

Not a package on purpose: the **Python bridge parser script** (`parser-py/python/bridge.py`) — a dependency-free Python 3.12+ script that the TS side spawns; it is shipped inside the `parser-py` package and version-gated against the interpreter found at runtime.

## 4. Core data model (in `@ctrans/core`)

| Artifact | Contents | Notes |
| --- | --- | --- |
| `ParseResult` | language, source AST (source-shaped), token/comment stream, diagnostics, exact spans (byte offset + line/col, start & end) | one per file; identical top-level shape for both front-ends |
| `SemanticModel` | scopes, symbol tables, resolved references, `CommonType` annotations (best effort; `unknown` when absent) | built per module from ParseResult + front-end-specific resolvers |
| `ModuleGraph` | nodes = modules, edges = imports (static + dynamic), SCCs, topological order, entry points, test modules | drives translation order and context packing |
| `ModuleContract` | export surface: symbol name → signature summary + `CommonType` | the "header" of a module; what dependents are allowed to know |
| `TransformationLedger` | per-construct entries: `DecisionKind`, mapping id, span, rationale, warnings, AI escalation ref (if any) | schema + validation live in `@ctrans/core` (`src/ledger.ts`); M4's lowering produces entries; serialized to `.ctrans/ledger.json` |
| `SemanticModel` (M3) | per-module scopes, symbols (declarations + references), conservative `AnnotatedType`s, unresolved references, semantic diagnostics | built by `analyzeModule` (core) from a ParseResult; Python is symtable-driven, JS/TS is built from the normalized AST (language differences modeled explicitly — D-002) |
| `ModuleGraph` (M3) | modules, resolved/unresolved/external imports, dynamic-import edges, entry/test flags, iterative-Tarjan SCCs, deterministic dependency-first ordering | built by `buildModuleGraph` from parsed inputs; resolution is against the analyzed file set only — never the filesystem, never guessed |
| `ModuleContract` (M3) | export surface with `CommonType`s, oracle type displays as separate provenance | `extractModuleContract`; Python honors `__all__` else the public-name convention |
| `TranslationResult` | emitted files, helper files used, source↔target map, ledger, warnings | input to validation |
| `ValidationReport` | per-stage `pass \| fail \| skipped(reason) \| warn` + details | never a boolean "correct" |
| `RunReport` | aggregate: files, decisions histogram, validation summary, repair history, timing | final CLI output |

`CommonType` is a small normalized algebra — `unknown, any, none-null-undefined (tri-state), bool, int, float, bigint?, str, bytes, list/tuple/set/dict/map, function(params, ret, async), union, optional, class-ref, literal, generic` — with per-direction mapping tables and **lossiness tracking** (a `float→int` narrowing is recorded, never silent). It models *shared* concepts only; language-specific types stay in the source AST.

## 5. Front-ends

- **Python** (`parser-py`): spawns `python3 bridge.py` (stdlib only) → JSON: AST, symtable per block, token/comment stream, interpreter version. Primary parser is the reference implementation of Python semantics. Fallback: `web-tree-sitter` + `tree-sitter-python` (tolerant CST) for environments without `python3` — explicitly lower fidelity, flagged in reports. Grammar range: Python 3.12–3.14 (PEP 695/701 baseline; PEP 750 t-strings classified `unsupported` in V1 with warning).
- **JS/TS** (`parser-js`): `oxc-parser` for AST + comments + module map + error recovery. `typescript@6` (`ts.createProgram` + `Checker`) as the semantic oracle for symbol resolution and expression types — mandatory for TS inputs, best-effort for JS (checkJs mode). TS 7.x is build-tooling only until its API lands (D-004). Fallback parser: `@babel/parser` with `errorRecovery`.

## 6. Back-ends (codegen)

Both emitters share the same contract: lowering pass (source AST → target AST, ledger-driven) → emission → **canonical formatter finalization** (`prettier` for TS/JS, `ruff format` for Python — D-012/D-015, keeps goldens stable and output idiomatic) → helper-file injection when used → source map.

- `codegen-js`: emits TypeScript (primary target; JS by erasure through the same pipeline, validated with tsc). Idiom policy: emit what a competent developer would write, not interpreter-style code — lessons from Transcrypt/metapensiero.pj.
- `codegen-py`: emits typed Python (annotations from `CommonType` where available; `from __future__ import annotations`), validated with pyright.

## 7. Project mode and context packing

- Translation unit = file. Order = reverse topological over the ModuleGraph's SCC condensation (leaf modules first), so `ModuleContract`s of dependencies exist before dependents are translated.
- **Module contracts** are the context-packing currency: when translating unit U, the deterministic engine needs U's AST + contracts of direct deps; an AI escalation for U receives U's AST, direct-dep contracts, and the failure diagnostics — bounded by a token budget (oldest/least-relevant contracts dropped first). Whole-project prompts are forbidden (D-002 principle 5).
- `__init__.py` → `index.ts` re-exports; relative imports rewritten from the ModuleGraph; circular imports (SCCs) are detected and classified: Python patterns that rely on partial initialization are `semantic`-adapted or flagged `ambiguous` with an explanation, because ESM handles cycles differently (TDZ errors).
- Project outputs include: translated sources, `package.json` (from requirements/pyproject when mapping known), translated tests, `__ctrans_runtime.*` when needed, `.ctrans/` reports.

## 8. AI layer boundaries (summary)

`ai` exposes `ChatModel` (provider-agnostic; adapters: OpenAI-compatible, Anthropic, local OpenAI-compatible endpoints). Engine calls it only through two ports: `resolveAmbiguity(payload) → choice` and `proposeRepairPatch(context) → diff`. Secret-scanning gate in front of every call; hard caps on calls/tokens/wall-time; cache by payload hash. Details: [ai-architecture.md](ai-architecture.md).

## 9. Validation engine boundaries (summary)

Stages S1 syntax → S2 types → S3 dependencies → S4 build → S5 unit tests (translated, in sandbox) → S6 differential (source-vs-target behavior on tests) — each reports `pass/fail/skipped(reason)/warn`. The engine may claim equivalence only over executed stages. Details: [validation.md](validation.md).

## 10. Configuration & UX

- `ctrans.config.json` (schema-validated): `from`, `to`, `intMode: number|bigint`, `datetime: temporal|date-helpers`, `ai: {enabled, provider, caps}`, `sandbox: auto|strict|off(strict refused on request)`, `format: true`, include/exclude globs.
- CLI: `ctrans translate <path> [-o out] [--project]`, `ctrans check <path>` (parse+analyze+report only, no output), `ctrans validate <dir>`, `ctrans doctor` (capability report: runtimes, bwrap, docker, providers), `ctrans benchmark run`.
- All reports written under `<out>/.ctrans/` as JSON; CLI prints the human summary.
- Distribution: npm package, `ctrans` bin. No UI in V1 (D-013).

## 11. Error model

Typed error hierarchy rooted at `CTransError` with `code` (machine), `message` (human), `spans?`, `cause?`. Subsystem failures degrade to `skipped(reason)` artifacts, never silent continuation. Structural logger emits JSON events; no source contents or secrets in logs.
