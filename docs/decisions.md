# Architecture Decision Records

Format: Context → Decision → Consequences → Status. Superseded ADRs stay for history.

## D-001 — Engine language: TypeScript on Node.js (pnpm monorepo)
**Context.** Engine could be Python, Rust, or TypeScript. Both runtimes are needed at *validation* time regardless (run Python tests on source, JS tests on target). Decisive factors: in-process access to oxc (JS/TS parsing) and typescript@6 Checker (semantic oracle for JS/TS); mature CLI/testing/lint tooling; autonomous-agent maintainability.
**Decision.** TypeScript (strict) monorepo, Node ≥22.12, pnpm 10 workspaces. Python appears only as the dependency-free bridge script.
**Consequences.** Single language for engine code; Python semantics sourced via subprocess bridge instead of native imports; Rust possible later for hot paths (out of scope V1).
**Status.** Accepted (2026-10-06).

## D-002 — No universal AST IR; Semantic Layer instead
**Context.** Prompt-level assumption favors "AST → IR → translation". Prior art (Transcrypt, metapensiero.pj, Babel ecosystem) translates AST→AST with a thin semantic layer; a universal IR loses source idiom, complicates comment/provenance preservation, and saves nothing at N=3 languages.
**Decision.** Keep per-language source-shaped ASTs. Cross-language reasoning via a shared Semantic Layer: `CommonType` algebra, symbol/scope tables, ModuleGraph, ModuleContracts, TransformationLedger. Revisit if a non-JS/non-Python language family is added.
**Consequences.** Two lowering implementations instead of N back-ends off one IR; higher per-pair fidelity; IR-free design must still serialize analysis artifacts (ParseResult/SemanticModel JSON) for tests.
**Status.** Accepted (2026-10-06).

## D-003 — Python front-end: CPython stdlib bridge (primary), web-tree-sitter (fallback)
**Context.** CPython's `ast`+`symtable`+`tokenize` are the reference implementation of Python syntax/scopes, always matching the running interpreter (3.12–3.14 verified range); re-implementing Python parsing in JS is prior-art-proven dead weight. tree-sitter gives tolerance for broken input but a CST, no scopes, grammar lag.
**Decision.** Spawn a stdlib-only `bridge.py` → JSON (AST + symtable + tokens/comments + interpreter version). Fallback parser (no `python3` present): `web-tree-sitter` + `tree-sitter-python`, explicitly flagged lower-fidelity in reports.
**Consequences.** Requires `python3` for full fidelity (acceptable: also needed to run source tests); JSON serialization is ours (singletons, recursion caps); bridge version-gates grammar.
**Status.** Accepted (2026-10-06).

## D-004 — JS/TS front-end: oxc-parser + typescript@6 oracle; TS 7 pinned out of API paths
**Context.** Verified 2026-10-06: TypeScript 7.0 (Go) ships **no JS API**; the classic `Program`/`Checker` API is complete only in 5.x/6.x; `@typescript/typescript6` 6.0.2 exists for the side-by-side pattern. oxc-parser: ESTree-conformant, error recovery, comments, ranges, module map, MIT, prebuilt. Babel: fine but no type info; SWC: non-ESTree AST; Esprima dormant; Acorn no TS.
**Decision.** oxc-parser primary for parsing JS/TS (fallback @babel/parser); typescript@6 compiler API as the semantic oracle (mandatory for TS input, best-effort checkJs for JS). All compiler-API use behind an adapter (`@ctrans/parser-js`) so the TS 7.1 API can slot in later. tsgo/TS7 allowed only for repo-internal build/check speed.
**Consequences.** Dependency on TS 6.x line until 7.1 API stabilizes; adapter is a mandatory abstraction (the only place we accept an unstable upstream).
**Status.** Accepted (2026-10-06).

## D-005 — Output checkers: tsc 6 for TS output; pyright CLI (pinned) + optional mypy for Python output
**Context.** pyright internals are unstable to embed (basedpyright fork-and-pin is the only proven pattern); CLI `--outputjson` is de-facto stable, zero-based ranges, MIT, weekly releases. mypy 2.4.0 added `--output json`.
**Decision.** Validate TS output with typescript@6 (same adapter as D-004) via `--noEmit`; validate Python output with pinned pyright CLI JSON (primary) and mypy JSON (secondary/optional). Never embed pyright internals.
**Consequences.** Checker output shapes are pinned + tolerantly parsed; a checker-format change is a contained fix in one adapter module.
**Status.** Accepted (2026-10-06).

## D-006 — Integer policy: `number` default with precision diagnostics; `bigint` opt-in
**Context.** Verified: Python `int` is arbitrary precision; JS `Number` is float64; `BigInt` can't mix with `Number` (TypeError) and changes JSON/serialization ergonomics. Transcrypt precedent maps int→number.
**Decision.** Default `intMode=number`: emit `number`, and statically detect precision-risky patterns (literals >2^53, bitwise ops, `//`, `%`, int-typed arithmetic on unbounded inputs) emitting precision warnings (`CTW-NUM-*`). `intMode=bigint` emits semantically exact `bigint` with explicit boundary conversions. Revisit trigger: differential benchmarks showing silent precision bugs at scale → flip default with an ADR.
**Consequences.** Default is fast/idiomatic but flagged; exact mode available; neither mode is silent.
**Status.** Accepted (2026-10-06).

## D-007 — Zero runtime dependencies in generated output; helpers are codegen'd
**Context.** Generated projects must be inspectable, auditable, and free of our supply chain. Truthiness/NaN, slice-step, floor-div/mod, exception hierarchy all need helpers.
**Decision.** Emit only-referenced helpers into the output project (`__ctrans_runtime.ts` / `__ctrans_runtime.py`), small enough to read in one sitting, with provenance header.
**Consequences.** Slight output duplication across files is avoided by one helper module per project; helper evolution is versioned with the generator.
**Status.** Accepted (2026-10-06).

## D-008 — Datetime: Temporal primary (runtime-gated), Date-helpers fallback
**Context.** Verified: TC39 Temporal is Stage 4; shipped Firefox 139 (2025-05), Chrome 144 (2026-01), **Node 26 (2026-05)**; Safari pending. `Date` is mutable, 0-indexed months — a bug farm.
**Decision.** `datetimeMode=temporal` (default when target runtime ≥ Node 26 / evergreen), else `date-helpers` fallback with explicit warnings. Registry entries encode the choice.
**Consequences.** Version-gated fidelity; both paths tested in ConstructMatrix.
**Status.** Accepted (2026-10-06).

## D-009 — Sandboxing: hardened spawn baseline; bwrap auto-detect; Docker/Podman strict mode
**Context.** Verified: Node has no rlimits; firejail is suid-root (CVE history); systemd-run non-root can't isolate network; bwrap is unprivileged and maintained but needs user namespaces; containers raise the install floor.
**Decision.** V1 baseline = hardened spawn (argv, env whitelist, temp cwd, timeout+kill, stdio caps) + `prlimit` wrapper when present + bubblewrap auto-detected layer (`--unshare-net` etc.). `sandbox: "strict"` requires Docker/Podman (gVisor if configured) and *errors* rather than downgrades if unavailable.
**Consequences.** Works cross-distro without root; strongest isolation optional; capability report always states what actually ran.
**Status.** Accepted (2026-10-06).

## D-010 — AI: optional, provider-agnostic, escalation-only
**Context.** Verified: naive LLM translation ~26.65% correctness; every credible modern system wraps generation in test-driven validation; OWASP LLM v2 risks apply.
**Decision.** Three ports only (`resolveAmbiguity`, `proposeRepairPatch`, opt-in `polishIdioms`); `ChatModel` interface with OpenAI-compatible/Anthropic/custom adapters; offline default; caps in code; AI output always re-validated deterministically.
**Consequences.** The product works with no keys; provider churn is contained in adapters.
**Status.** Accepted (2026-10-06).

## D-011 — Dependency mapping: registry (authoritative) + heuristics + AI proposals
**Context.** Verified: no public machine-readable stdlib→Node mapping exists; pure-AI mapping is unverifiable; pure-registry can't cover long tail.
**Decision.** In-repo versioned JSON registry with schema + per-entry usage tests (CI-enforced); deterministic heuristics as fallback; AI only proposes registry-shaped entries for unknown third-party libs (validated before use).
**Consequences.** Registry authoring is a recurring cost (V1 scope fixed in dependency-mapping.md §4); mapping claims are test-backed.
**Status.** Accepted (2026-10-06).

## D-012 — Golden stability via canonical formatters
**Context.** Emitter formatting churn makes goldens unreviewable; hand-formatting is non-deterministic.
**Decision.** All emitted code passes `prettier` (TS/JS) or `ruff format` (Python) as the final codegen stage; fixtures diff canonical forms; `fixtures:accept` requires review rationale.
**Consequences.** Goldens are stable and reviewable; formatter pinning matters (recorded per lockfile).
**Status.** Accepted (2026-10-06).

## D-013 — CLI-first; no UI in V1
**Context.** Frontend options (React/Electron/Tauri) add build+security surface without validating the core value.
**Decision.** V1 is a CLI (`ctrans`) + JSON artifacts. Web UI/VS Code extension deferred to V2/V3.
**Consequences.** Faster path to a trustworthy engine; UI later rides the same core.
**Status.** Accepted (2026-10-06).

## D-014 — Licensing: MIT (ours); MIT/Apache/BSD-only dependencies; GPL family = learn-only
**Context.** Reuse candidates span Apache-2.0 (Transcrypt — learn-from), GPL-3 (metapensiero.pj — learn-only), AGPL (trufflehog — excluded), CC-BY-NC (TransCoder — non-commercial).
**Decision.** Our code: MIT. Dependencies and copied snippets: MIT/Apache-2.0/BSD only, each recorded in ADRs. Learning from copyleft/non-commercial sources is allowed; copying is not.
**Consequences.** Clean distribution story; registry data written from scratch (informed by, not copied from, Transcrypt's module list).
**Status.** Accepted (2026-10-06).

## D-015 — Exception model: generated Error-subclass hierarchy mirroring Python builtins
**Context.** Verified: Python allows only BaseException subclasses; JS allows throwing anything and lacks `else` clauses; `except*` has no JS equivalent.
**Decision.** JS output throws only `Error` subclasses from a generated `__ctrans` hierarchy (ValueError, TypeError, …) preserving `instanceof`-style matching; `try/except/else` restructured deterministically; `except*` unsupported.
**Consequences.** `catch` blocks map cleanly; cross-boundary exception handling has defined behavior.
**Status.** Accepted (2026-10-06).

## D-016 — int-mode/precision, truthiness, strings: explicit helpers over implicit coercion
**Context.** Verified divergences: NaN truthiness, `[]`/`{}` truthiness, UTF-16 vs code points, slice step, floor-div/mod signs.
**Decision.** Boolean contexts emit `truthy()` unless statically provable equivalent; string index/len/iteration/slice-with-step use code-point helpers; numeric helpers per D-006. Helper use is minimized by static provability analysis (no blanket wrapping).
**Consequences.** Correct-by-default output; provability analysis keeps idiomatic cases clean.
**Status.** Accepted (2026-10-06).

## D-017 — Package layering: core is the base type layer; implementations depend on core
**Context.** The original architecture diagram drew `core → parser-*` while AGENTS.md §3 requires all cross-package types to live in `@ctrans/core`, and the M1 parser contract requires parser packages to normalize into shared core shapes. The original arrow was also internally inconsistent (it showed `core → sandbox` while stating "sandbox depends only on core"). M1 forced the decision.
**Decision.** `@ctrans/core` is the lowest layer: it defines all cross-package types and engine interfaces (e.g. `PythonParser`) and orchestrates via those interfaces with implementations injected by `apps/cli`. Layers: core(0) ← {parser-*, codegen-*, registry, sandbox}(1) ← {validator, ai}(2) ← repair(3) ← cli(4). A package may depend only on strictly lower layers.
**Consequences.** Adding a front/back-end means implementing a core interface; core never imports implementations; `scripts/workspace-boundaries.test.ts` enforces the direction mechanically.
**Status.** Accepted (2026-10-06), clarifying D-001/D-002.

## D-018 — Python bridge protocol: one-shot JSON over stdin/stdout, protocol version 1
**Context.** The CPython front-end (D-003) needs a process protocol that is deterministic, versioned, robust against malformed input, and free of user-code execution.
**Decision.** `python3 -I -B bridge.py` is spawned per request. Two modes: `--mode handshake` (emit header, exit 0) and `--mode parse` (read raw source bytes from stdin, emit exactly one JSON envelope on stdout). Envelope: `{ok, header, result?, diagnostics?}` or `{ok:false, header, error:{kind,...}}`; exit 0 = well-formed envelope (parse errors are *data*, mapped to typed errors client-side), exit 2 = usage error, anything else = crash. The header (`{protocol, python:{version, full}}`) is embedded in every response, so each parse re-validates runtime/protocol. JSON is ASCII-escaped (`ensure_ascii`) — lone surrogates survive as `\uXXXX` escapes, lossless through `JSON.parse`. Spans are UTF-8 byte offsets + 0-based line / UTF-8-byte column, exclusive end; token columns are converted from code points to bytes in the bridge so the whole contract is byte-based. Non-JSON-native scalars are tagged (`int` beyond 2^53, non-finite floats like `1e999`, `bytes`, `complex`, `ellipsis`). The AST encoder is iterative (explicit stack) so pathological AST depth cannot exhaust the process stack.
**Consequences.** ~30–60 ms process spawn per file (acceptable; batching can come as protocol v2). Client validates every response with hand-written guards — bridge output is semi-trusted data, never trusted structure.

## D-019 — ParseResult gains comments + module fields; JS front-ends emit comment-only token streams; diagnostics gain an `error` severity
**Context.** M2's JS/TS front-ends expose comments and module/import/export information (roadmap M2). oxc recovers from syntax errors and returns partial trees with error-level findings, which the M1 diagnostic vocabulary (`warning|info`) could not represent. A full JS token stream is not needed downstream (provenance derives from the AST + comments), and neither oxc nor Babel exposes one.
**Decision.** `ParseResult` gains two required fields: `comments: readonly TokenInfo[]` (exact source slices) and `module: ModuleInfo | null` (parser-level import/export map; null until a front-end extracts it). JS front-ends set `tokens = []` and put comments in `comments`; the Python bridge keeps its full token stream (comments appear in both places). `DiagnosticSeverity` gains `error` for recovered-parse findings. Fatal parse failures remain thrown typed errors.
**Consequences.** Consumers must not assume `tokens` is a full stream for every language — the meaning is documented per front-end. Module-graph work in M3 can start from `result.module` for JS and extracts Python imports from the AST (bridge extension deferred to M3).
**Status.** Accepted (2026-10-06).

## D-020 — Native-parser hostile-input containment: depth screening before oxc
**Context.** Verified on oxc-parser 0.153.0: deeply nested sources (~8000 levels) SIGSEGV the entire process during native parse/serialization; ~4000 levels parse cleanly; oxc exposes no depth option. A native crash cannot be caught, and hostile input must never crash the host (M2 contract §16).
**Decision.** Every input passes a linear bracket-depth scan (a resource-limit prefilter, not parsing — no syntax claims, so AGENTS.md §11 is not violated). Inputs above `MAX_SAFE_NESTING_DEPTH` (2000) are measured exactly via the pure-JS Babel parser (catchable RangeError) or our normalized-tree walk; true depth beyond the limit yields a typed `JsSourceLimitError` and oxc is never called. 2000 sits far above real-world code and far below the verified crash window.
**Consequences.** Pathological inputs produce structured errors instead of dead workers; the rare bracket-heavy-but-shallow source pays one extra Babel parse; thresholds and the crash window are test-covered. Revisit if oxc ships a depth option or fixes the native recursion.
**Status.** Accepted (2026-10-06).

## D-021 — Python bridge emits module info (protocol v1, additive)
**Context.** The ModuleGraph (M3) needs import edges for both language families; M2 gave JS a parser-level module map, but the Python bridge did not extract imports (they lived only in the AST).
**Decision.** `bridge.py` extracts `result.module` from Import/ImportFrom nodes (dotted specifiers preserved; relative imports carry their leading dots as the level, e.g. ".mod", "..pkg.mod"; `import a.b` binds a module object → kind "namespace"; `from m import n` → kind "named"; `from m import *` → namespace with importedName "*"). Protocol stays v1: the field is additive and the client validates it tolerantly (absent → null). Kinds are a documented subset of the core ImportKind union.
**Consequences.** Both front-ends now feed the ModuleGraph through the same `ParseResult.module` shape; the graph resolver reads leading dots as relative levels. Dynamic `importlib` usage is not tracked (documented approximation).
**Status.** Accepted (2026-10-07).

## D-022 — JS-target runtime helpers: single TypeScript source + Node type stripping
**Context.** The generated `__ctrans_runtime` module needs types for TS targets (strict `tsc` rejects untyped helpers) while JS targets must receive valid plain JavaScript that re-parses and executes. Hand-maintaining a TS and a JS twin per helper would double the review surface and drift.
**Decision.** Helper bodies are authored once in TypeScript. For JS targets the emitter erases annotations with Node's built-in `module.stripTypeScriptTypes(code, { mode: "strip" })` (available unflagged from the engine floor, Node ≥ 22.18) — no new dependency, one source of truth. Helper sources stay strip-safe by rule: type annotations only, no enums/namespaces/overloads/parameter properties. A runtime behavior test executes BOTH variants against Python-divergent edges (floor-division signs, NaN truthiness, code-point iteration, error surfaces) so the strip cannot silently alter semantics.
**Consequences.** One helper source; the JS variant is generated deterministically from the same templates; the strip step failing is a typed generation error (`CG-RUNTIME-STRIP-FAILED`), never a silent fallback. Revisit if strip mode proves insufficient (transform mode or a build step remain fallbacks).
**Status.** Accepted (2026-10-18).

## D-023 — Dynamic-operand lowering: helpers over silent coercion (M4 posture)
**Context.** TypeScript cannot compile arithmetic/comparison/member access on `unknown` values, and JS operator semantics silently diverge from Python's (`+` coercion, relational coercion, missing-key → undefined). The M5 provability analyzer will skip helpers where types prove equivalence; M4 has no such analyzer yet.
**Decision.** In M4, lowering is type-directed at the granularity available from the semantic layer and from emitted text: statically typed operands lower to native JS operators (`a + b`, `a < b`, `this.count += by`, native `[]`/`.slice()`); statically unknown operands lower to `__ctrans_runtime` helpers that reproduce Python's operand rules and raise the Python `TypeError` family. Unannotated Python parameters are annotated `unknown` in TS output — never left implicit-`any`, never invented types. Known-divergence choices are recorded per construct in the ledger with the documented adaptation.
**Consequences.** Output is type-valid under strict TS even for untyped Python input; idiomatic native operators survive exactly where types prove them safe; helper density drops automatically as the M5 provability analyzer lands. The known gaps (dict methods, string-vs-UTF-16 length semantics, external import mapping) stay unsupported/verbatim with warnings until the registry + string work lands in M5.
**Status.** Accepted (2026-10-18).

## D-024 — Python-output toolchain: pinned pyright CLI + ruff WASM formatter
**Context.** M7 adds Python as a translation target. D-005 already pinned pyright CLI (MIT, weekly releases) for Python-output type validation; D-012/D-015 mandate `ruff format` as the canonical Python formatter, but no ruff binary exists on dev/CI hosts, the npm name `ruff` is an unrelated 2017 package, and Astral ships the formatter as WASM bindings (`@astral-sh/ruff-wasm-nodejs`, MIT, actively released).
**Decision.** Two pinned devDependencies: `pyright@1.1.406` (CLI, spawned with `--outputjson` for S2 of Python output — subprocess, controlled env, timeout, no network) and `@astral-sh/ruff-wasm-nodejs@0.17.1` (in-process `Workspace.format` for emitted-Python finalization — no subprocess, deterministic output for goldens). Both recorded in the lockfile; formatting via WASM and validation via CLI keeps the two lifecycle models explicit.
**Consequences.** Formatter behavior is pinned by the lockfile (formatter upgrades regenerate goldens through `fixtures:accept` with review); pyright upgrades re-run the Python-output validation tests. The WASM binding covers `format` only — lint rules stay out of scope (we emit already-clean code and pyright validates types).
**Status.** Accepted (2026-10-20).

## D-025 — AI layer dependencies and escalation transport (M8)
**Context.** M8 needs (a) the mandated embedded secret scan (security.md §4: "secretlint rules, MIT") and (b) a provider transport without leaking provider SDKs into engine code. `secretlint` 13.0.7 and `@secretlint/core` 13.0.7 (MIT, actively released) expose `lintSource()` for in-memory string scanning; the preset `@secretlint/secretlint-rule-preset-recommend` (MIT) is the documented rule set. Node ≥22 ships a global `fetch` with `AbortSignal`, so no HTTP dependency is needed.
**Decision.** Add `secretlint@13.0.7`, `@secretlint/core@13.0.7`, `@secretlint/secretlint-rule-preset-recommend@13.0.7` to `@ctrans/ai` only. The secret gate scans the exact outgoing payload (system + message contents) through `lintSource` with the preset's rules wrapped as `{ id, rule }` descriptors and `noPhysicFilePath: true`; any finding, thrown error, or empty-rule configuration BLOCKS the request (fail-closed). Provider adapters speak JSON over `fetch` (OpenAI-compatible `POST {baseUrl}/chat/completions`, Anthropic `POST {baseUrl}/v1/messages`, and a minimal user-templated custom endpoint); no provider SDK is imported anywhere. Credentials come from environment references only (`CTRANS_AI_KEY`) in M8 — OS-keychain storage remains the M11 hardening scope; keys never enter config files, logs, journals, or cache keys.
**Consequences.** The scan's allowlist behavior is the upstream preset's (documented placeholder keys like AWS's `AKIAIOSFODNN7EXAMPLE` stay allowed upstream — tests use a GitHub-token-shaped value that the preset does detect). Adapter tests run against a loopback `node:http` stub, never a real provider. Malformed or oversized responses are typed failures; retries are bounded to one schema re-ask (ai-architecture.md §2).
**Status.** Accepted (2026-10-21).

## D-026 — Bounded repair loop: unit-scoped patches, monotone acceptance, hash-only journal (M9)
**Context.** M9 adds the second AI port (`proposeRepairPatch`) over the M8 transport. The risk profile differs from ambiguity resolution: the model now proposes arbitrary text edits to generated code. Three failure modes must be structurally impossible or provably rejected: (a) editing anything outside the failing unit (tests, configs, other files, generated runtime artifacts), (b) weakening the validation that judges the patch (suppressions, ambient declarations, focused/skipped tests), and (c) an "accepted" repair that actually regresses previously passing checks or is not persisted/rolled back exactly.
**Decision.** (1) The proposer may only return a unified diff scoped to one emitted target path; the grammar rejects file headers for other paths, binary/rename/new-file/combined diffs, and any hunk whose old lines do not match the current text exactly (declared line numbers may drift, content may not). (2) A policy guard inspects ADDED lines and rejects `@ts-ignore`/`@ts-nocheck`/`@ts-expect-error`, `declare module/global`, eslint/istanbul suppressions, and test `.skip`/`.only`; the guard runs in both the proposer and the orchestrator (defense in depth for non-AI proposers). Tests and shared generated artifacts (no source text) are never eligible targets. (3) Acceptance requires every baseline-passing stage to remain `pass` in the candidate AND `computeClaimLevel(candidate) > computeClaimLevel(baseline)` (strictly higher; skipped stages never count). The orchestrator never mutates the baseline file map, so rejection and validator exceptions roll back exactly (state-hash verified). (4) Caps are centralized: 3 attempts/unit, 8/run; callers may tighten, never raise. Identical patch hashes are duplicates; any candidate state already seen stops the run (`loop-detected`). (5) The journal at the fixed path `.ctrans/repairs/repairs.json` is hash-only (state/patch hashes, classification, decisions, bounded reasons, stage snapshots, token counts, secret-rule ids) — never diffs, prompts, responses, or source. Writing is mode 0600 and containment-checked; corrupt/partial files are preserved aside and recovery is reported; write failures raise typed errors.
**Consequences.** The engine, not the model, decides repair success. Acceptance proves monotonic claim improvement, not semantic equivalence — S5/S6 remain the behavioral authority, which is why project-mode repair is deferred instead of approximated. The model cannot hand itself better grades or touch the tests. Journal contents are intentionally insufficient to replay a patch; they are audit evidence, and the accepted bytes live in the output tree with the deterministic ledger.
**Status.** Accepted (2026-10-21).
