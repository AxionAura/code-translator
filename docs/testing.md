# Testing Strategy

Status: **approved blueprint**. Governs all test code from M1 onward.

## 1. Test pyramid for a translator

| Layer | What it proves | Where it lives |
| --- | --- | --- |
| Unit | one mapping rule, one resolver, one emitter function, one ledger behavior | `packages/*/test/` |
| Parser tests | front-end fidelity: spans, comments, error recovery, symtable accuracy | `packages/parser-*/test/` |
| IR/semantic tests | CommonType inference, symbol resolution, ModuleGraph construction (SCCs, ordering) | `packages/core/test/` |
| **ConstructMatrix** | every §2 entry of language-support.md × every direction, as minimal input→expected pairs | `tests/constructs/` |
| Golden fixtures | whole-file translations (stable, reviewed) | `tests/fixtures/` |
| Dependency tests | registry entries behave as claimed (usage tests) | `packages/registry/tests/` |
| Validation tests | stage pipeline produces exactly the expected verdicts (positive + negative) | `packages/validator/test/` |
| Repair tests | classification, caps, loop detection, revert-on-regression with FakeChatModel | `packages/repair/test/` |
| E2E | CLI runs against fixture projects, produces reports | `tests/e2e/` |
| Benchmarks | aggregate quality/perf over time (not pass/fail per commit) | `benchmarks/` |

## 2. Fixture system (`tests/fixtures/`)

Layout per fixture:

```
tests/fixtures/<name>/
  manifest.json        # metadata, direction, config overrides, claim-ladder expectation
  input/               # source project (may be multi-file)
  expected/            # target project as the engine must emit it
  notes.md             # optional: what this fixture pins
```

Rules:

- `manifest.json` declares `{ "name", "from", "to", "config": {...}, "expectedClaimLevel": 1..5, "expectedDecisionCounts": {...} }`. Tests assert both the emitted tree **and** the ledger/claim numbers — golden tests verify honesty, not just bytes.
- **Normalization:** both sides pass through the canonical formatter (prettier / `ruff format`) before diffing (D-012); generated provenance headers and `TODO(ctrans)` comment *text* are normalized; ledger JSON is compared structurally, not byte-wise.
- **Acceptance workflow:** `pnpm fixtures:accept <name>` regenerates `expected/` and requires a human-readable diff review in the same commit; auto-accepting without review is a forbidden shortcut (AGENTS.md §11). In autonomous phases, the reviewing agent must state *why* the new expected output is correct in the commit message.
- **Regression rule:** every bug fix lands with a fixture (or ConstructMatrix entry) that failed before and passes after.

## 3. ConstructMatrix

Machine-readable index (`tests/constructs/index.json`) enumerating every construct in language-support.md §2 with: id, direction(s), input snippet, expected output, expected decision class (`deterministic|semantic|ambiguous|unsupported`), expected warning codes. A generator expands it into test cases. Adding a construct to the support matrix **without** adding a ConstructMatrix entry fails CI. `unsupported` classifications get negative tests too (asserting the warning/marker, not absence of output).

## 4. Determinism & hermeticity

- No network, no live AI, no wall-clock assertions, no parallel-unsafe shared state. Sandbox-dependent tests use capability detection and skip-with-reason only when the optional tool is genuinely absent (skip list is reported in CI output — AGENTS.md §4 forbids silent skips).
- The Python bridge tests run against the local interpreter and assert grammar-range behavior (3.12–3.14).
- Parser error-recovery tests feed mutated/truncated sources and assert graceful diagnostics.

## 5. Corpus for stress testing

A vendored corpus of small, license-clean (MIT/BSD/Apache) real-world files with attribution file (`tests/corpus/ATTRIBUTION.md`), used by benchmarks and fuzz-ish property checks: "translation always terminates, always produces a report, never crashes" for every corpus file × direction. Corpus files are never added to goldens wholesale (they're too big to review); they feed property tests and metrics.

## 6. Coverage & gates

- Floors from M4: core ≥85%, parser/codegen ≥90% line coverage (CI-enforced).
- Every milestone's DoD includes its test gate (roadmap.md).
- Tests may not mock what they own: pipeline internals are tested for real; only `ChatModel`, sandbox process edges, and clocks are faked.

## 7. Manual-quality gate (autonomous phases)

Before a milestone closes, the implementing agent must sample-review 10 emitted outputs against their sources for *idiomatic quality*, not just test passage — emission quality is part of DoD ("emit what a competent developer would write"), and gets recorded in the milestone report.
