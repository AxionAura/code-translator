# Dependency Mapping

Status: **approved blueprint**. Decisions D-007 (zero runtime deps in output), D-011 (hybrid registry), D-014 (license rules).

## 1. Problem

Translating a project means translating its *ecosystem*: stdlib calls, third-party libraries, manifests, and test frameworks. Python's stdlib is synchronous; Node's is largely asynchronous (`fetch` has no sync variant — verified); the test frameworks differ in shape (pytest vs vitest). Research found **no existing machine-readable stdlib→Node mapping dataset** (Transcrypt's ~17 hand-written module implementations are the closest precedent), so the registry is original work.

## 2. Architecture: hybrid (registry + heuristics + AI fallback)

```
             ┌────────────────────────────────────────────────┐
source symbol│  1. REGISTRY (versioned JSON data, in-repo)    │ → exact mapping + notes
reference    │  2. HEURISTICS (structural rules, deterministic)│ → mapping + confidence
             │  3. AI RESOLVER (optional, ambiguous-only)      │ → proposal, human-reviewable
             └────────────────────────────────────────────────┘
                          all results → ledger entry
```

- **Registry (primary, deterministic).** Declarative JSON data files in `packages/registry/data/` with a JSON schema, validated in CI. Every entry carries usage tests (see §5). Covers: Python stdlib → Node/TS; selected third-party (requests → fetch; pytest → vitest; dataclasses/pydantic-lite → interfaces + validation helpers); test-framework APIs; JS/TS → Python reverse entries.
- **Heuristics (deterministic fallback).** For unmapped symbols: name/shape-based rules (e.g., `is_*` predicate → `isX()`; `snake_case` → `camelCase` with collision detection; getter pairs → accessors) with explicit `confidence` recorded in the ledger.
- **AI resolver (optional).** Only for `ambiguous` third-party mapping (unknown libraries with plausible equivalents); output is a *proposal* that must match the registry entry schema and is validated (parses, type-checks) before use. Never for stdlib (registry is authoritative).

Rationale: a static registry alone can't cover ecosystem breadth; heuristics alone are unreliable; AI alone is unverifiable and non-deterministic. The hybrid keeps the 90% deterministic and auditable.

## 3. Registry entry schema

```jsonc
{
  "id": "py.stdlib.pathlib",
  "source": { "language": "python", "module": "pathlib", "symbols": ["Path", "PurePath"] },
  "target": {
    "language": "typescript",
    "modules": ["node:path", "node:fs"],      // emitted imports
    "emit": "helper-class",                    // native | helper-class | function-set | rewire
    "helper": "PathWrapper"                    // generated into __ctrans_runtime when emit=helper-*
  },
  "syncAsync": "sync-to-sync",                 // or "sync-to-async" (triggers chain propagation)
  "fidelity": "full",                          // full | partial | lossy
  "coverage": { "full": ["exists","read_text","joinpath"], "lossy": ["glob (pattern dialect)"] },
  "semanticsNotes": ["Path.glob uses JS glob dialect — verified divergence listed"],
  "minRuntime": { "node": ">=22" },
  "usageTest": "registry/tests/pathlib.spec.ts",
  "confidence": "high"
}
```

Rules: an entry without a passing usage test cannot ship (`fidelity` claims are tested, not asserted); `lossy` entries always produce warnings at use sites; entries are versioned together with the registry package.

## 4. V1 registry scope (Python → TS/JS) — IMPLEMENTED (M5, 2026-10-18)

The M5 registry (`@ctrans/registry`) implements the deterministic layer with usage-tested entries consumed through the core `RegistryLookup` interface (D-017 injection):

- **Builtins (10):** `sorted` (stable, code-point ordering, mixed-type TypeError), `list`, `min`/`max` (ValueError on empty), `reversed` (materialized — documented), `zip` (shortest-truncation, materialized pairs), `next` (StopIteration raise), `abs`, `bool` (= truthy), `enumerate`. kwargs forms outside the M4/M5 call surface stay unsupported-loud.
- **Methods (32 entries):** list (`append`→push, `pop`, `clear`→length-0, `copy`→slice, `index`/`count`/`remove` with == semantics + ValueError, `insert`→splice, `extend`→push-spread, `reverse`), dict (`get`/`keys`/`values`/`items`/`pop` with KeyError), str (`upper`/`lower`/`strip`/`lstrip`/`rstrip`/`startswith`/`endswith`/`replace`→replaceAll/`split` (whitespace-run form)/`join`/`find`/`capitalize`), set (`add`/`discard`/`remove`/`clear`). Dynamically typed receivers dispatch identically through `__ctrans_callMethod` — one semantic authority for both paths.
- **Modules (5):** `math`, `json`, `sys`, `random` (generated `__ctrans_<name>` modules, only-when-referenced), `requests` (sync-to-async boundary → fetch; see §6). `pathlib`/`datetime`/`re`/`itertools`/`functools`/`enum`/`dataclasses`/`typing`/`abc`/`logging`/`statistics`/`decimal` remain unmapped (reported, never guessed) until helper-class wrappers and usage tests exist.

Every entry carries usage tests executing generated code against Python semantics (`registry-usage.test.ts`); structural invariants (unique ids, fidelity-honesty, deterministic lookups) are pinned in `registry.test.ts`.

## 4a. Original V1 scope table (planning reference)

| Module | Fidelity | Notes |
| --- | --- | --- |
| `math`, `random`, `string` | full | |
| `json` | full | `json.dumps` sort/indent options mapped |
| `re` | partial | syntax rewrites per language-support.md §2.8; atomic groups unsupported |
| `os` / `os.path` | full (path ops) | `os.system`/`popen` → unsupported (security policy) |
| `sys` | partial | `argv`, `exit`, `platform`; `sys.modules` tricks unsupported |
| `pathlib` | partial→full | helper-class wrapper |
| `datetime`, `time` | partial | Temporal primary (Node ≥26) / Date-helpers fallback; timezone caveats documented |
| `collections` | partial | `defaultdict`, `Counter` helpers; `OrderedDict` → Map note |
| `itertools`, `functools` | partial | common functions (`chain`, `islice`, `lru_cache`, `partial`, `reduce`) |
| `enum`, `dataclasses`, `typing` | partial | `enum` → const-object/union; `dataclass` → interface + factory; typing subset per language-support §2.7 |
| `abc` | partial | abstract methods → TS `abstract` |
| `io`, `os` file I/O | partial | `node:fs` sync variants preferred (keeps call chains sync) |
| `logging` | partial | → leveled console/winston-free helper |
| `statistics`, `decimal` | lossy/partial | documented |
| C-extension modules (`ctypes`, `curses`, …) | unsupported | loud |

Third-party V1: `requests` → global `fetch` (`sync-to-async`: triggers the propagation algorithm, §6); `unittest.mock` → `vitest` `vi` (test mapping); everything else: unknown-package detection → explicit "third-party dependency requires manual mapping or AI proposal" warning.

Test frameworks: `pytest` → `vitest` basic surface (test functions, `assert` → `expect`, `parametrize` → `test.each`, simple fixtures → `test.extend`); `monkeypatch` and advanced fixture graphs → unsupported warnings (verified: no vitest equivalent).

Reverse registry (TS/JS → Python) mirrors the same schema (`node:fs` → `pathlib`/`os`, `JSON` → `json`, `Math` → `math`, `fetch` → `urllib.request` sync helper with warnings).

## 5. Registry validation (self-testing data)

- Every entry's `usageTest` runs in CI against fixture programs exercising its `coverage.full` symbols; failures fail CI (a mapping claim without a test is a bug).
- Property: registry tests are deterministic (no AI, no network beyond localhost stubs).
- `pnpm registry:check` validates all data files against the JSON schema and cross-references coverage symbols against real module docs snapshots (vendored, license-clean excerpts for the symbol *names* only).

## 6. Sync→async boundary propagation (the hard case)

Verified: Python network/file APIs are sync; JS `fetch` is async-only. Algorithm (deterministic):

1. Registry marks sync-only target APIs (`fetch`, and any chosen async third-party).
2. Call-graph analysis over the ModuleGraph finds transitive callers of any sync-only API.
3. Those functions are asyncified bottom-up: `async` added, call sites `await`ed, returns wrapped; signatures that changed are listed in warnings with spans.
4. Entry points get async runners (IIFE or `main().catch()` emission).
5. Config `--no-async-rewire` instead maps such APIs to an explicit error-marker stub + warning (never fake sync behavior).
6. Ledger records every changed signature as `semantic` with `adaptation: "asyncified (requests.get → await fetch)"`.

Known cost: this changes public signatures — the report says so explicitly, per the product principle (never pretend an uncertain translation is behavior-preserving).

## 7. Manifest generation

- `requirements.txt` / `pyproject.toml` → `package.json` skeleton: mapped dependencies get entries only when a registry mapping exists; unmapped ones are listed under `"ctransUnmapped"` with warnings (never silently dropped).
- `package.json` → `pyproject.toml` in reverse mode: same policy.
- No install commands are run by the translator (security.md §5); validation may install *only* with explicit user consent inside the sandbox.
