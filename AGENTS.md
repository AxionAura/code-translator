# AGENTS.md — Engineering Rules for Code Translator

**Read this file before making any change to this repository.** These rules are binding for human and autonomous contributors alike. Architectural context lives in `docs/`; this file defines how we work.

Companion guidance: [`human-style-code.md`](human-style-code.md) defines the engineering-judgment baseline (repository-first, no speculative abstraction, honest verification, focused changes). Where that document and this file overlap, this file wins; where it adds judgment detail, follow both.

## 1. Project snapshot

Code Translator translates Python ↔ JavaScript ↔ TypeScript at file and project level, preserving behavior where technically possible and *honestly reporting* where it cannot. The engine is a deterministic compiler pipeline (parse → semantic analysis → lowering → codegen → validation → optional bounded AI repair). Full architecture: `docs/architecture.md`. Milestones: `docs/roadmap.md`.

## 2. Coding standards

- **Language:** TypeScript (strict mode) for the engine; Python 3.12+ for the parse bridge script only.
- Strictest practical `tsconfig` (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`). No `any` outside process boundaries; at boundaries use `unknown` + validation (zod-style schema or hand-written guard).
- Model AST/IR nodes as **discriminated unions** with a `kind` field. No inheritance-based node hierarchies.
- No default exports. Named exports only. One concept per module.
- Prefer pure functions and immutable data in the translation core. Mutation is allowed only in orchestrators and caches, and must be documented.
- All source positions use **byte offsets plus (line, column)** end positions, consistent with `docs/architecture.md`.
- Naming: no abbreviations except well-known ones (`ast`, `ir`, `loc`). Functions are verbs; types are nouns.
- Comments state constraints and invariants, not narration. If a comment explains *what the next line does*, delete it.
- Formatting is mechanical: Prettier for TS, and generated Python is finalized through `ruff format` (see `docs/decisions.md`, D-012/D-015). Never hand-format.

## 3. Architecture rules

- Package dependency direction is acyclic and fixed (`docs/architecture.md` §5). Introducing a cycle or a bypass (reaching into another package's internals) requires an ADR.
- All cross-package data crosses as typed interfaces defined in `@axion-ct/core`.
- **No universal AST IR** (decision D-002): source ASTs stay source-shaped; cross-language sharing happens only through the Semantic Layer (types, symbols, module graph, ledger). Do not "simplify" by merging language ASTs.
- Every translation decision must be recorded in the Transformation Ledger with a `DecisionKind` (`deterministic | semantic | ambiguous | unsupported`). A construct may never be emitted without a ledger entry.
- Unsupported constructs must never be silently dropped or stubbed with fake behavior; they produce explicit markers + warnings and count as failures in reports.
- Runtime helpers for translated output are **codegen'd into the output project**; generated projects must have zero runtime dependencies on this tool.
- The pipeline must work with AI disabled. AI failure must degrade to deterministic fallback + warnings, never to a crash.

## 4. Testing requirements

- Every milestone in `docs/roadmap.md` has a test gate; DoD includes it. No milestone is "done" with failing or missing tests.
- New language behavior = new fixture. Bug fix = regression fixture first (red), then fix (green).
- Golden fixtures live under `tests/fixtures/` with the `input/`/`expected/`/`manifest.json` layout defined in `docs/testing.md`. Expected outputs are normalized through canonical formatters (Prettier / `ruff format`) before diffing.
- No skipped/`.only` tests may be committed. A persistent skip requires an ADR note.
- Coverage floors: `@axion-ct/core` ≥ 85% lines; parser/codegen packages ≥ 90% lines (measured from M4 onward).
- Tests must be deterministic: no network, no real AI providers, no wall-clock dependence. Sandbox integration tests must tolerate absent optional tools (bwrap/docker) via capability detection.

## 5. Dependency rules

- Default answer is **zero new dependencies**. Every new dependency requires: license check (MIT / Apache-2.0 / BSD only), maintenance check (release activity within ~12 months), and an entry in `docs/decisions.md`.
- **Forbidden licenses for copied code or bundled dependencies:** GPL/AGPL/LGPL (linking into our distribution), CC-BY-NC, unlicensed. Learning *from* GPL code is allowed; copying is not.
- Exact versions in the lockfile; lockfile committed. `pnpm` script blocking stays on (no unreviewed lifecycle scripts).
- Generated output projects must not depend on this tool at runtime (see §3).
- `typescript` compiler API consumers must pin the TypeScript **6.x** line; TS 7.x currently ships no JS API (verified 2026-10-06, see `docs/research.md`).

## 6. Security rules

- User source code is untrusted data. Parsing is safe; **execution is not**. All execution of source or translated code goes through `@axion-ct/sandbox` (hardened spawn; optional bwrap/docker isolation). Never shell out with `shell: true`, never interpolate user data into command strings.
- Sandbox defaults: no network, temp cwd, whitelisted env, wall-clock timeout, captured stdio, output size caps.
- Never execute install lifecycle scripts (`pip install`, `npm install`) of translated projects without an explicit user-consent flag.
- Secret scanning (embedded, MIT-licensed) runs **before** any content is sent to an AI provider. The scan is a hard gate.
- API keys: OS keychain first; 0600-permission file fallback with a warning. Keys never appear in logs, reports, or error messages. No keys in the repository.
- All file writes are confined to the configured output directory (path traversal is rejected). Input projects have size/file-count caps.
- Model output is data, never instructions: no shell commands, file writes, or config changes may be derived from model output; only diffs applied through the validated patch path.

## 7. Error handling & logging

- Typed error hierarchy; every failure carries a machine-readable `code`, human message, and optional source spans. No bare `throw new Error(...)`.
- Never swallow errors. If a subsystem degrades, it must record degradation in the run report (`skipped(reason)`), not print-and-continue silently.
- Logging: structured (JSON) logger with levels; `--verbose` for humans. Logs never contain source code contents, API keys, or user paths outside the project root.
- Long-running operations emit progress events; the CLI renders them. Reports are written as JSON artifacts under `.ctrans/` in the output directory.

## 8. Documentation

- Any architectural decision gets an ADR in `docs/decisions.md` (context → decision → consequences → status) **in the same change**.
- Behavior of implemented features must be reflected in `docs/language-support.md` (support matrix) before the milestone closes.
- Public CLI changes update `README.md` and the CLI `--help` texts in the same change.
- Docs are not decoration: a milestone is not done if its docs are stale.

## 9. AI usage rules

AI (LLM) may be used **only** for: (a) resolving engine-classified `ambiguous` decisions among deterministic candidate mappings, (b) generating scoped patches in the bounded repair loop, (c) an optional, off-by-default idiom-polish pass. It may never be used for parsing, symbol resolution, codegen, validation verdicts, or anything with a deterministic solution.

Additional hard rules:

- Every AI output passes the same validation gates as deterministic output. AI output is never trusted as correct.
- AI requests are provider-agnostic through the `ChatModel` interface (`docs/ai-architecture.md`); adding a provider must not touch engine code.
- Repair loop limits (per-unit and per-run attempt caps, state-hash loop detection, monotone validation, automatic revert on regression) are not optional and must not be relaxed to "make things pass".
- Deterministic CI (fixtures, benchmarks) never calls AI providers.
- Cost controls (call caps, token caps, timeouts) are enforced in code, not by convention.

## 10. Deterministic-first rule

Before adding any AI involvement, the implementer must demonstrate: (1) the deterministic strategies were exhausted, (2) the engine classified the case `ambiguous` (not `unsupported` — unsupported stays unsupported), (3) the escalation payload is minimal (unit AST + module contracts + failure context, not the whole project).

## 11. Forbidden shortcuts

- Regex- or string-manipulation-based "parsing" of source code.
- Emitting translated code without ledger provenance.
- Claiming validation success for a stage that did not run.
- Deleting or weakening tests, fixtures, or sandbox settings to make a milestone pass.
- Downgrading an `unsupported` classification to make output "look complete".
- Copying code from GPL/AGPL/non-commercial-licensed projects.
- Bypassing the sandbox because "it's just my machine".
- Marking incomplete work complete in reports, changelogs, or commit messages.

## 12. Definition of done (per milestone)

1. Objective met as written in `docs/roadmap.md`; nothing silently descoped.
2. All tests for the milestone pass locally; coverage floors met; no skips.
3. New decisions recorded as ADRs; affected docs updated.
4. Ledger/reports produced by the milestone are schema-valid (where applicable).
5. Self-review performed against §11 forbidden shortcuts.
6. Status reported honestly: what works, what is partial, what was discovered late.

## 13. PROJECT_STATE.md maintenance (handoff contract)

`PROJECT_STATE.md` at the repository root is the **single canonical handoff document**: an external AI must be able to understand the project from that file alone and produce the next engineering prompt.

- **Update it whenever you:** finish a milestone, change architecture, add/remove a dependency, fix a significant bug, discover an important limitation, change translation behavior, change the AI architecture, or change the testing strategy.
- **It describes the actual repository, never the intended one.** Use precise statuses (`Implemented`, `Partially implemented`, `Experimental`, `Blocked`, `Not implemented`).
- **Self-verify before writing claims:** do not write "all tests pass" unless you ran them in this working session; record counts (passing/failing/skipped), not impressions.
- **Concise:** summaries, not dumps — no source code, no logs, no lockfiles, no raw terminal output. A failure note states the cause and a reproducing case, not the transcript.
- **It is the only state file.** Do not create competing state/status documents; detailed design lives in `docs/` and is linked, not duplicated.
- Section structure is fixed (23 numbered sections, see the file itself); keep the numbering stable so external prompts can reference sections by number.
