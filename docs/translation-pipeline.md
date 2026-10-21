# Translation Pipeline

Status: **approved blueprint**. Companion to [architecture.md](architecture.md).

## 1. Stage graph

```
 0. Intake        — locate project, detect languages, size caps, path confinement
 1. Parse         — per-file ParseResult (source-shaped AST + tokens/comments + diagnostics)
 2. Analyze       — SemanticModel per file (scopes, symbols, CommonType best effort)
 3. Graph         — ModuleGraph: imports (static/dynamic), SCCs, topo order, entries, tests
 4. Plan          — translation units ordered leaf-first; contracts of deps computed
 5. Lower+Emit    — per unit: lowering rules → target AST → emit → canonical format
                  — every construct logged to TransformationLedger (4 decision classes)
 6. Map deps      — registry-driven: stdlib/3rd-party/test-framework rewrites; manifest generation
 7. Translate tests — pytest↔vitest best-effort; unmappable fixtures → warnings, not fake tests
 8. Helpers       — inject __ctrans_runtime.* (only what's referenced)
 9. Validate      — S1→S6 pipeline (see validation.md); sandboxed execution
10. Repair        — on failure: classify → root-cause via spans → bounded AI patch → re-validate
11. Report        — RunReport + ledger + validation artifacts written; CLI summary
```

Stages 1–8 are fully deterministic and run with AI disabled by default. Stage 10 is the only AI consumer (besides explicit `ambiguous` escalation during stage 5).

## 2. Per-unit pipeline detail (stage 5)

For each translation unit (file), in dependency order:

1. **Context assembly** — unit AST + `ModuleContract`s of direct dependencies (from stage 4). No other context exists, by design.
2. **Lowering** — tree-walk over the source AST applying the direction's mapping table (`docs/language-support.md`). Each rule application appends a ledger entry:
   ```jsonc
   {
     "unit": "src/api.py", "span": [1204, 1268],
     "kind": "semantic",              // deterministic | semantic | ambiguous | unsupported
     "rule": "py.comprehension→js.map+filter",
     "adaptation": "list comprehension over str: code-point iteration via [...str]",
     "warnings": [],                  // non-empty for semantic/ambiguous/unsupported
     "candidates": null,              // ambiguous entries: offered option ids
     "escalation": null               // {provider, model, promptHash} when AI resolved
   }
   ```
3. **Emission** — target AST printed, then canonical formatter (`prettier` / `ruff format`) finalizes formatting (D-015). Formatter output is the canonical form used in goldens.
4. **Post conditions** — emitted unit must re-parse in the target language (S1 runs per-unit inline, not only project-wide).

Failure posture: a unit with `unsupported` constructs is still emitted (markers + comments preserved), but the unit's validation ceiling is capped and the run report counts it as not fully translated. Nothing is dropped silently.

## 3. Ambiguity resolution order (per ambiguous construct)

1. **Documented heuristic default** applied; ledger entry says which alternative was rejected and why.
2. If `ai.enabled`: escalation payload = `{unit AST, dep contracts, construct span, candidate options, constraints}` → `resolveAmbiguity`. Response must select an option (it may not invent new behavior); recorded with prompt hash; still validated like any output.
3. If AI disabled or escalation fails: emit heuristic default + `TODO(ctrans)` comment + warning. Never block the run on AI. **Implemented (M8):** the pipeline resolves ambiguities before lowering (AI port injected into `runPipeline`), validates the answer against the engine-offered `candidates`, and records `escalation` provenance in the ledger; the AI journal (`.ctrans/ai-journal.json`) keeps prompt hashes only.

## 4. Project graph rules

- **Static imports only** form the ModuleGraph; `importlib`/dynamic `import()` edges are marked *approximate* and only affect warnings, not ordering guarantees.
- **SCC handling:** Python tolerates some circular imports (partially-initialized modules). ESM raises TDZ errors on some of the same patterns. Graph analysis classifies each cycle: safe (deferred access), adaptable (move import into function — `semantic`), or flagged `ambiguous`. Cycles are never silently translated.
- **Entry points** detected from `pyproject.toml` scripts, `if __name__ == "__main__"` modules, `main` fields — emitted as `package.json` bin/scripts hints.
- **Tests** (`test_*.py` / `*_test.py`, `tests/` dirs) are graph nodes too: they translate last, after the code they exercise.

## 5. Source↔target mapping artifacts

- `.ctrans/source-map.json` — target span → source span (both files' spans are byte-offset based; all four front-end/back-end components provide exact positions).
- `.ctrans/ledger.json` — full decision ledger (schema above).
- `.ctrans/validation.json` — ValidationReport.
- `.ctrans/repairs/NNN.patch` — every AI repair patch as a unified diff with its classification and re-validation outcome.
- Provenance header comment in each emitted file: generator, direction, ledger ref, generator version. Suppressed with `--no-provenance`.

## 6. Determinism guarantees

Given identical inputs, config, and toolchain versions: stages 0–8 are byte-identical (enforced by fixture goldens). Stage 9 is deterministic modulo sandbox timing (flaky policy in validation.md). Stage 10 with AI enabled is non-deterministic by nature — which is exactly why its outputs re-enter the same deterministic validation gates.

## 7. What the pipeline explicitly does NOT do

- No interpretation or execution of source code during translation (parsing is non-executing; the Python bridge only imports stdlib `ast`/`symtable`/`tokenize` modules on the input's *syntax*, it does not import user modules).
- No dependency installation (`pip`/`npm`) during translation — only manifest generation. Execution-time installs require explicit user consent (validation.md, security.md).
- No rewriting of user files in place; output goes to a separate directory.
