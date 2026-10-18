# M4 Independent Audit — Pipeline skeleton + Python→TS/JS codegen

**Date:** 2026-10-18. **Auditor:** independent session (ZCode), per the recovery-and-verification
brief: audit first, fix verified defects second, never trust a completion claim without evidence.

`PROJECT_STATE.md` claimed M4 complete (502/502 tests). This audit independently verified the
claim from source, tests, and reproducible execution, then fixed the defects it confirmed. All M4
work was (and remains) uncommitted working-tree state — the last commit is M3.

## 1. What existed before the audit

- Full M4 implementation in the working tree: `packages/core/src/pipeline.ts`,
  `packages/codegen-js/src/{context,helpers,lower,translator}.ts`, CLI wiring in
  `apps/cli/src/{main,translate}.ts` + `bin/ctrans.mjs`, S1/S2 validators in
  `packages/parser-js/src/validators.ts`, ConstructMatrix (111 entries × TS/JS), 16 golden
  fixtures, CLI e2e tests.
- `pnpm verify` (typecheck → lint → format → tests → docs-lint) was **genuinely green**:
  505/505 tests in 48 files. The claim was accurate as far as it went.
- Coverage matched the state-file numbers exactly: core 88.41%, parser-py 91.82%, parser-js
  91.5%, codegen-js 87.66% (below the AGENTS.md §4 90% floor, honestly documented as tracked).

## 2. Commands actually executed

| Command | Result |
| --- | --- |
| `pnpm verify` (before fixes) | exit 0 — 505/505 tests, 48 files |
| `pnpm test:coverage` (before fixes) | core 88.41 / parser-py 91.82 / parser-js 91.5 / **codegen-js 87.66 ✗** |
| `node apps/cli/bin/ctrans.mjs translate <13-function project> --to ts` | claim level 1, S2 fail (37 errors), silent-builtin defects (§3) |
| `node --experimental-strip-types main.ts` (generated) | ran until `seq.append` TypeError; `sorted(...)` etc. would be ReferenceErrors |
| `pnpm verify` (after fixes) | exit 0 — **542/542 tests, 50 files** |
| `pnpm test:coverage` (after fixes) | core 88.41 ✓ / parser-py 91.82 ✓ / parser-js 91.5 ✓ / **codegen-js 90.21 ✓** |
| Supported-surface workflow, `--to ts` and `--to js`, executed vs Python | **byte-identical output** except one documented divergence (§5) |

## 3. Requirement-by-requirement verdict (M4 DoD)

| # | Requirement | Verdict before audit | Verdict after fixes |
| --- | --- | --- | --- |
| 1 | Py→JS and Py→TS file translation | PASS (verified by execution) | PASS |
| 2 | Multi-file project translation + module ordering | PASS (imports rewritten, dependency order) | PASS |
| 3 | CLI `check`/`translate` + exit codes | PASS (0/1/2/3 verified; 3 = partially translated) | PASS |
| 4 | Ledger entries per emitted construct | **FAIL** — unmapped builtin calls were classified `deterministic` (false provenance) | PASS — classified `unsupported`, marker + warning |
| 5 | Honest unsupported/ambiguous handling | **FAIL** — builtins and container methods silently verbatim, no warnings | PASS — `CTW-UNSUPPORTED-CALL-BUILTIN`, `CTW-METHOD-UNMAPPED` |
| 6 | Runtime helper injection + cross-module collection | PASS (union runtime emitted once in `finalizeUnits`) | PASS |
| 7 | Prettier finalization + idempotence | PASS | PASS |
| 8 | S1 + S2 validation incl. honest `skipped(reason)` | PASS (JS target S2 honestly skipped) | PASS |
| 9 | ConstructMatrix + golden coverage | **PARTIAL** — matrix curated to avoid the gaps: no builtin-call entries, no branch-binding case, no dict mutation | PASS — 12 new matrix entries added (6 audit regressions + 6 previously untested arms) |
| 10 | Runtime behavior of generated code | **PARTIAL** — supported surface ran; common builtins crashed silently | PASS on supported surface (byte-identical to Python); deferred surface fails loudly with warnings |
| 11 | Regression tests for M4 bug classes | PASS (M4 fixed its found bugs red-first) | PASS (+ 11 new audit regressions, written red-first) |
| 12 | Coverage floors | **FAIL** — codegen-js 87.66% < 90 | PASS — codegen-js 90.21% |

## 4. Confirmed defects, root causes, fixes

All fixes were regression-tested red-first (`packages/codegen-js/test/lowering-regressions.test.ts`
and new ConstructMatrix entries), then fixed, then re-run green.

1. **Unmapped Python builtins emitted as silent bare calls classified `deterministic`.**
   `sorted(...)`, `list(...)`, `next(...)`, `max(...)`, `min(...)`, `reversed(...)`, `zip(...)`
   were lowered to bare identifiers that cannot resolve (guaranteed `ReferenceError`), with a
   ledger entry claiming `deterministic` and no warning. This violated AGENTS.md §3/§11 (no
   silent unsupported constructs, no downgrading unsupported to look complete) and
   `docs/language-support.md` §5 ("warnings, never silent").
   *Fix:* `lower.ts` now classifies calls to Python builtins without an M4 mapping as
   `unsupported` (marker comment + `CTW-UNSUPPORTED-CALL-BUILTIN` + failure counting), guarded
   by a unit-level def/class name scan so genuine forward references and imports stay native.
2. **Python-scope binding broken by block-scoped `let`.** A variable first assigned inside an
   if/else (or any nested block) and used afterwards produced invalid TS (`TS2304`) and a runtime
   `ReferenceError`, classified `deterministic`. Python binds at function/module scope.
   *Fix:* each Python scope pre-scans its body for assignment targets; first bindings inside
   nested blocks are hoisted to the scope top (`let name: unknown;`) and assignments emit plain
   rebinding. Applies to `Assign`/`AnnAssign`/unpack elements; loop targets keep JS scoping
   (S2 flags post-loop use honestly; C-style range loops already diverge on the post-loop value).
3. **Unannotated method/constructor parameters emitted untyped** (implicit `any` under strict
   S2), violating the emitter's own documented policy in `defaultParamText` ("unannotated Python
   parameters are `unknown`, never implicit any") — free functions had the policy, methods did not.
   *Fix:* `lowerMethodDef` routes through `declaredParamText` like free functions. (An
   intermediate swap to `defaultParamText` alone silently dropped scope declarations and degraded
   typed arithmetic to helpers — caught because the classes-inheritance golden failed S2, fixed
   by using the declaring wrapper.)
4. **Empty-list bindings emitted without a type** (`let seq = []` → implicit `any[]`, strict S2
   failure). *Fix:* fresh empty-list bindings annotate `: unknown[]` (TS target).
5. **Dict literals emitted without a type** — TS inferred a narrow object type, so a later key
   write (`d["c"] = 3`, core Python) failed strict S2. *Fix:* fresh dict-literal bindings
   annotate `: Record<string, V>` where V is the sorted union of literal value types (`unknown`
   when empty or non-literal) — an open, string-keyed mapping like Python's dict.
6. **Container-method calls emitted verbatim without the promised warning.**
   `list.append`/`dict.get` are documented M4-verbatim ("warnings, never silent") but produced no
   warning. *Fix:* native method calls on statically known array/map receivers carry
   `CTW-METHOD-UNMAPPED` (new code, exported from `@ctrans/codegen-js`).
7. **Parallel-assignment bindings got literal-inferred types that broke Python rebinding.**
   `a, b = 0, 1` then `a, b = b, a + b` failed S2 (`__ctrans_add` returns a union).
   *Fix:* unpack destructures inherit the RHS element type when statically known (annotated
   `list[int]` etc. keep native typing — verified against the collections golden); otherwise they
   declare `unknown` (parallel tuples rebinding by construction).
8. **Comprehensions over non-array iterables emitted `.map/.filter` directly on `unknown`.**
   `{c for c in word}` produced `word.map(...)` — a TS error and a semantic divergence (Python
   iterates strings by code point, dicts by key, sets, generators). For-loops already routed
   through `__ctrans_iter`; comprehensions did not. *Fix:* comprehensions share the for-loop
   classification (known map → `Object.keys`, string/unknown → `__ctrans_iter`, known arrays and
   `__ctrans_range` results stay native) and the rerouted ledger entries are honestly `semantic`.

Additional verification findings (not defects, now documented):
- `from . import helper` without a package `__init__.py` resolves to nothing — the documented
  "no namespace packages" ModuleGraph limitation; with `__init__.py` the sibling-module binding
  works (pinned by the new `import-forms.test.ts` suite, which also covers barrel re-export via
  `__all__`, aliased re-exports, external vs unresolved classification, and namespace imports).
- The 16 golden fixtures used none of the unmapped builtins, no dict mutation, no branch-bound
  variables — the goldens were curated around the implemented surface, which is why 502 green
  tests coexisted with the defects above. The ConstructMatrix now probes those gaps.

## 5. Real translation/runtime evidence (post-fix)

A 13-function workflow (fibonacci via list concatenation and parallel assignment, classes with
instance state, dict classification built by subscript stores, try/except/finally, dict
comprehensions, generators, stepped slicing, branch-bound variable used after the if/else,
negative-operand floor division and modulo) was translated with the real CLI and executed:

- **TypeScript target:** output byte-identical to the Python reference except ONE documented
  divergence (dict print order for integer-like keys — JS object property enumeration).
- **JavaScript target:** identical result (type-stripped runtime, D-022).
- CLI verdicts stay honest: the workflow reaches claim level 2 (S1+S2 pass); projects touching
  the deferred M4 surface report partially-translated with exact warnings, exit code 3.
- The deliberately-verbatim surface (`sorted`, `next`, `.append`, `.get`) now fails loudly:
  markers + warnings at translation time, honest S2/claim reporting, no silent misbehavior.

## 6. Coverage after fixes

Repo-wide `pnpm test:coverage` (2026-10-18): core 88.41% (floor 85) ✓, parser-py 91.82% ✓,
parser-js 91.5% ✓, **codegen-js 90.21% (floor 90) ✓** — the M4 delta is closed. Remaining
uncovered lines in `lower.ts` are unsupported-arm minutiae and type-inference fallthroughs;
`translator.ts` uncovered lines are format-failure/strip-failure error paths and prologue
fallthroughs.

## 7. Remaining limitations (unchanged or newly documented)

- Method/name mappings (`list.append` → `push`, stdlib) wait for the M5 registry; until then the
  surface is verbatim-with-warning and fails at runtime.
- Python float `str()` formatting (`100.0` → JS `100`) is not reproduced — M5+.
- Dict iteration/print order follows JS object property enumeration for integer-like keys.
- Loop variables used after their loop are S2-flagged (out of scope), not hoisted.
- Everything in `docs/language-support.md` §4 (metaclasses, `match`, threads, …) stays
  unsupported.

## 8. What could not be verified

- Node type stripping was exercised on Node 24.15 only (the documented floor is ≥22.18).
- Python bridge verified on 3.14.7 only (3.12/3.13 accepted by handshake, not run here).
- No sandboxed execution stages exist yet (M6+); generated code was executed directly under a
  short `timeout` in a temp directory, with no network use by the programs.
- Reverse directions, registry, AI layer: not implemented (per plan), not audited.
