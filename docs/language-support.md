# Language Support

Status: **approved blueprint**. Semantic facts are source-verified (see [research.md](research.md) §3). This document defines *what maps, how, and how honestly* for each direction. It is the contract that `codegen-js` and `codegen-py` implement and that the ConstructMatrix fixtures test.

## 1. Decision classes recap

`deterministic` — provably equivalent. `semantic` — adapted with documented deviation. `ambiguous` — heuristic default + alternatives documented (AI may resolve). `unsupported` — marker + warning, counts as failure. A construct's class can differ **per direction** (e.g., TS types → Python annotations is `semantic`; Python metaclasses → TS is `unsupported`).

## 2. Verified semantic divergences and the mapping policy

### 2.1 Values, numbers, strings

| Divergence (verified) | Py → TS/JS policy | TS/JS → Py policy |
| --- | --- | --- |
| `int` arbitrary precision vs `Number` float64 | Default: `number` + **precision diagnostics** (constants >2^53, bitwise ops, `//`, `%`, `int`-typed params) — D-006. `intMode=bigint` emits `bigint` with explicit boundary conversions | `number` → `float` annotation; `bigint` → `int`; integral-valued literals annotated `int` when inferable |
| `//` floor division (toward −∞) vs truncation | `semantic`: helper `__ctrans.floorDiv` (correct for negatives; bigint-correct in bigint mode) | deterministic (Python `//` is the target semantics) |
| `%` sign (divisor vs dividend) | `semantic`: helper `__ctrans.mod` = `((a % b) + b) % b` | deterministic |
| `NaN` truthy (Py) vs falsy (JS) | covered by truthiness helper below | n/a (Python keeps NaN truthy) |
| Strings: code points (Py) vs UTF-16 units (JS); slice step | `semantic`: code-point helpers for `len`/index/iterate when the value may be astral; `s[i:j:k]` → `__ctrans.strSlice` (step expansion); plain ASCII-safe cases may compile to native ops when provable | deterministic (Python str is the target semantics) |
| `is` / `===` | deterministic (`is` → `===` on primitives; object identity → helper note) | deterministic (`is` on None → `is None` stays) |
| `==` overloading vs `===` | `==` between primitives → `===`; when either operand has `__eq__` (user class) → `semantic`: `.equals()` method emitted + call-site rewrite | `==` → `==` (Python semantics superset); `===` → `==` with class note |

### 2.2 Truthiness — always explicit

Boolean contexts (`if`, `while`, `!x`, `&&`, ternaries) never rely on JS coercion for values that can diverge (`NaN`, `[]`, `{}` — verified divergence). Policy: emit `__ctrans.truthy(x)` unless the static type proves the coercion equivalent (e.g., `boolean`, `string`, `null|undefined` checks). TS/JS→Py: truthiness maps to Python semantics (which is a superset here); `undefined`/`null` → `None` normalization is `semantic` (tri-state collapse documented).

### 2.3 None / null / undefined

`None` → `undefined` by default (`--null-mode=null` optional); `undefined` in JS input collapses to `None` — `semantic` (tri-state → one state; recorded when the distinction was observable). `Optional[T]` ↔ `T | undefined`/`T | null` per null-mode. `noUncheckedIndexedAccess`-style guards are emitted rather than assumed.

### 2.4 Control flow & functions

| Construct | Py → TS/JS | TS/JS → Py |
| --- | --- | --- |
| Chained comparisons (`a < b < c`) | `deterministic` (single-eval temp) | deterministic (emit chain) |
| Walrus `:=` | `deterministic` (expression → statement + temp; or inline where legal) | n/a (Python native) |
| f-strings / template literals, f-string `=` spec | deterministic (`=` spec expands to `name=${name}` literally) | deterministic |
| Comprehensions | list/set/dict comp → `.map/.filter/…`, `Object.fromEntries`, `new Set`; nested/multi-loop comps → emitted loops when clearer (`semantic`) | `deterministic` (comprehensions are the target idiom) |
| Slices (lists/strings) | `__ctrans.slice` helper (negatives + step) | deterministic (`[i:j:k]`) |
| `for…else` / `while…else` | `semantic` (flag-variable rewrite, documented) | n/a |
| `try/except/else/finally` | `else` → inlined into `try` tail after last fallible stmt (`semantic`, documented); `except` order preserved | deterministic (`else` clause regenerated) |
| Exception types | generated `__ctrans` hierarchy mirroring Python builtins (ValueError, TypeError, …); only `Error` subclasses thrown; `except*`/ExceptionGroups → `unsupported` (V1) | JS `Error` family → mapped hierarchy; non-Error throwables → `RuntimeError` wrap (`semantic`) |
| `*args/**kwargs` | rest/spread (`semantic`: kwargs typing via `Record<string, unknown>` or typed options object when inferable) | `*args` → `*args: object`; `**kwargs` → `**kwargs: object` (`semantic`) |
| Default mutable args (`def f(x=[])`) | `semantic`: None-sentinel rewrite (also fixes a Python footgun) | n/a |
| `global`/`nonlocal` | `deterministic` mostly (module-level `let` + closure mutation); escapes analysis → `ambiguous` | n/a |
| `match` (PEP 634) | `ambiguous`: if/else-chain codegen for literal/capture cases; sequence/mapping/class patterns → `unsupported` (V1) with precise span | n/a |
| Generators (`yield`, `yield from`, send/throw/close) | `deterministic` core (`yield`→`yield`, `yield from`→`yield*`); `GeneratorExit`-dependent logic → `semantic` warning | `deterministic` core; `next(value)` injection → `send` (`semantic`) |
| Decorators (functions/classes/methods) | `deterministic` in principle: Python decorators are higher-order application — emit `f = deco(f)` composition; descriptor/`__set_name__` subtleties → `semantic`. TS 5 decorators are **not** used as the mapping (TC39 stage 2.7, semantics differ) | decorator syntax emitted for function decorators; parameter decorators (JS frameworks) → `unsupported` |
| `async def`/`await` ↔ `async`/`await` | deterministic at syntax level; **event-loop semantics differ** — concurrency constructs (locks, queues, gather≠asyncio.gather nuances) → `semantic`/`ambiguous` | deterministic syntax; `asyncio.run` at entry → IIFE/documentable runner |
| **Sync I/O → async boundary** | `requests`/`open`-over-network → **async chain propagation** (documented algorithm: dependency map marks sync-only APIs; callers are transitively asyncified; every changed signature gets a warning). Where a sync JS equivalent exists (`node:fs` readFileSync), it is chosen first | JS promises → Python: `await` maps to `await`; top-level event-loop bridging flagged |

### 2.5 Objects, classes, protocols

| Construct | Py → TS/JS | TS/JS → Py |
| --- | --- | --- |
| Classes, inheritance | `deterministic` single inheritance; constructors, `super` | deterministic |
| **Multiple inheritance** | `semantic`: C3 linearization computed at translation time → mixin-chain emission; conflicting layouts → `ambiguous` | n/a |
| Dunders: `__str__`, `__repr__` | `semantic`: `toString()` override (documented distinction repr/str collapses) | `semantic`: `__str__` from `toString` |
| `__eq__`/`__hash__` | `semantic`: `.equals()` method (no JS operator overloading — proposal withdrawn 2025); `__hash__` → `unsupported` unless unused | `semantic`: `__eq__` from `equals` |
| `__iter__`/`__next__`/`__getitem__` | `semantic`: `Symbol.iterator` / index-method emission; negative indices → helper | deterministic (Python protocol is richer; emitted as dunders) |
| `__call__` | `semantic`: `.call()` method (not callable) | n/a (JS has no callable objects) |
| Context managers (`with`) | `semantic`: `try/finally` for cleanup-only; resource protocol → `using` (TS 5.2 `Symbol.dispose`) where target allows, else helper `.close()` | `deterministic`: `with` from context-manager pattern where detectable |
| Descriptors, `__slots__`, `__getattr__`/`__setattr__`, metaclasses | `unsupported` (V1): detected, warned, preserved as comments. `__getattr__` partial case → `ambiguous` (Proxy-based, opt-in) | `unsupported` (Proxy → descriptor emulation) |
| Private (`__name` mangling, `#field`) | name-mangling → TS `private` + rename (NOT `#private`: not proxyable — verified); `#field` → `_name` convention (`semantic`) | mirrored |
| `@property`/`@staticmethod`/`@classmethod` | deterministic (`get`/`static`; `classmethod` → static taking cls-like param, `semantic`) | `@property` from getter; `classmethod` `semantic` |

### 2.6 Modules & project

- `__init__.py` → `index.ts` re-export barrel; package-relative imports rewritten via ModuleGraph (`deterministic`).
- Circular imports: per-cycle classification — safe (deferred access) `deterministic`; function-scoped import fix `semantic`; else `ambiguous` with explanation (TDZ divergence verified).
- Dynamic import (`importlib`, `await import()`) — `semantic`, graph edge approximate.
- `if __name__ == "__main__"` → entry-point guard emission (`semantic`).
- `sys.argv`, `os.environ`, `os.path`/`pathlib`, `json`, `re`, `math`, `random`, `time`, `datetime`, `logging`, `itertools`, `functools`, `collections`, `enum`, `dataclasses`, `typing`, `abc`, `io`, `string` — V1 registry scope (see dependency-mapping.md for per-module fidelity).

### 2.7 Typing (TS ↔ Python annotations)

- TS annotations → Python annotations: `deterministic` for the shared subset (primitives, arrays/tuples, unions, generics, literal types, interfaces→`Protocol`/`TypedDict` choice `ambiguous`); TS-specific (conditional types, mapped types, `infer`, template literal types, `unique symbol`) → `unsupported` (erased with warning).
- Python annotations → TS: `deterministic` for the shared subset; `Protocol` → structural interface (`deterministic`); `TypedDict` → interface with index signature nuances (`semantic`); runtime-checked typing (`isinstance` on generics, `TypeVar` bounds at runtime) → `semantic`/`ambiguous`.
- Type-directed improvements are **out of scope for the deterministic engine** (that's ts-migrate's failure mode); JS→TS emits valid TS with `unknown`/inferred types + diagnostics, not blanket `any`.

### 2.8 Regex

Source-level rewrite with verification: `(?P<n>…)`→`(?<n>…)`, `(?P=n)`→`\k<n>` (`deterministic`); atomic groups/possessive quantifiers → `unsupported` (no JS equivalent — verified); flags audited (`re.S`→`s` etc.); Python-only methods (`re.split` with captures, `scanning`) → helper (`semantic`).

### 2.9 Datetime

`datetime` → **Temporal** when target runtime supports it (Node ≥26 verified to ship Temporal), else `Date`-helper layer; both paths `semantic` with an explicit `datetimeMode` config (D-008). `timedelta` arithmetic → Temporal `Duration` / helper.

## 3. Direction support matrix (V1 target)

| Direction | Status target at V1 | Notes |
| --- | --- | --- |
| Python → TypeScript | **Full** core matrix (§2) | flagship direction |
| Python → JavaScript | Full core matrix (TS emitted then erased+validated) | |
| TypeScript → JavaScript | Full (types erased by our pipeline; enum/namespace lowering) | competes with esbuild/Amaro; included for pipeline uniformity |
| JavaScript → TypeScript | Good (valid TS, honest `unknown`s, no fake types) | deliberately not "invent types" |
| TypeScript → Python | Core matrix minus TS-specific type system (erased w/ warnings) | |
| JavaScript → Python | Core matrix | |

"Full core matrix" = everything classified `deterministic`/`semantic` in §2; `unsupported` classes (metaclasses, descriptors, `except*`, class-pattern `match`, `__hash__`) remain unsupported **in all directions** until explicitly promoted.

## 4. Explicit V1 non-supports (always loud)

Metaclasses; descriptors (`__get__`/`__set__` data protocol); `except*` / exception groups; class/sequence/mapping patterns in `match`; operator overloading semantics (incl. `__hash__`-dependent dict keying of user objects); threads/`multiprocessing`; `asyncio` synchronization primitives beyond `gather`/`sleep`; `eval`/`exec`/`compile`; C-extension stdlib modules; PEP 750 t-strings (3.14); `__getattr__` by default (opt-in Proxy experiment).

Each entry here lists: detection span, warning code (`CTW-UNSUPPORTED-*`), comment preservation strategy, and report accounting. Promoting any of them is a roadmap event, never a silent fallback.

## 5. Implementation status (Python → JS/TS — M4 subset + M5 runtime semantics)

**M5 runtime semantics (2026-10-18, all usage-tested in `packages/codegen-js/test/`):**

- **`intMode=bigint` (D-006):** `--int-mode bigint` maps Python ints to JS `bigint` exactly — integer literals (`42n`), `int` annotations (parameters, returns, fields), native arithmetic/bitwise/comparison on provable-int operands, `range` elements (`__ctrans_rangeBig`), `int()` (`__ctrans_toIntBig`). `/` ALWAYS produces a Python float (`__ctrans_div` converts through Number even for bigints). A provable int mixed with a provable float converts across the documented Number boundary (`CTW-NUM-BIGINT-FLOAT-BOUNDARY` warning, semantic). Default `number` mode is unchanged (precision diagnostics intact). Floor-div/mod of provable ints narrow their helper result to `bigint` (sound: bigint inputs always produce bigint results).
- **Code-point strings (WS B):** `len()`, indexing (including negative), and lexicographic comparison use Unicode code points — `__ctrans_len`, `__ctrans_index`, and the comparison core compare code-point sequences; slices join code points. Astral-plane characters (`😀`, `𠮷`) measure, index, and order exactly as Python.
- **Truthiness provability (WS C, D-016):** `__ctrans_truthy` is emitted only when JS truthiness could diverge. Provable-native cases (booleans, strings, null/None, ints/bigints, comparison results, and `and`/`or` chains whose operands are all provable) lower to native conditions with a `py.test→js.native` deterministic ledger entry; NaN-divergent numbers, empty containers, and unknown values keep the helper (`py.test→js.truthy`, semantic).
- **Python float str() (WS D):** `__ctrans_floatStr` reproduces Python's repr layout — `.0` on integral floats, `-0.0`, `inf`/`-inf`/`nan`, scientific notation exactly when `abs(x) >= 1e16` or `0 < abs(x) < 1e-4`, two-digit exponents. `str()` on non-integral numbers and f-string interpolation of float-typed expressions use it (`f"{100.0}"` → `"100.0"`); `bool`/`None` spellings (`True`/`False`/`None`) apply everywhere through `__ctrans_str`.
- **Registry v1 (D-011, WS E):** `@ctrans/registry` ships deterministic mapping data (10 builtins, 32 method entries across list/dict/str/set, 5 module entries) consumed through the core-defined `RegistryLookup` interface (D-017 layer injection — the CLI wires `createRegistryLookup()`; codegen never imports the registry package). Mapped builtins (`sorted`, `list`, `min`, `max`, `reversed`, `zip`, `next`, `abs`, `bool`, `enumerate`) emit `__ctrans_` helpers reproducing Python semantics exactly (mixed-type TypeError, code-point ordering, shortest-truncation zip, ValueError on empty min/max); mapped methods rename to JS equivalents where semantics match (`append`→`push`, `upper`→`toUpperCase`, …) or route through Python-semantics helpers (`index`, `count`, `remove`, `get`, `pop`, `split`, `join`, `capitalize`); dynamically-typed receivers dispatch through the same surface inside `__ctrans_callMethod` (one authority for both paths). `math`/`json`/`sys`/`random` imports emit generated `__ctrans_<name>` modules (only-when-referenced). The `sorted`/`list`/`next`/… M4 unsupported markers are retired for mapped names; genuinely unmapped calls still warn (`CTW-UNSUPPORTED-CALL-BUILTIN`, `CTW-METHOD-UNMAPPED`). Every entry has executed usage tests (registry-usage.test.ts).
- **Async boundary propagation (WS F):** `requests.get/post/head/delete(url)` lowers to `await fetch(url, {method})` (semantic, sync-to-async boundary per D-011 §6). The deterministic fixpoint in `@ctrans/core` (`collectFunctionCalls`/`collectImportedFunctions`/`propagateAsync`) marks transitive callers through the ModuleGraph; asyncified signatures are recorded per-function in the ledger, cross-unit call sites await, entry `main()` calls run through the natural ESM top-level await. The response surface (`text`/`json` async methods, `status_code`, `ok`, `raise_for_status()` → `__ctrans_raiseForStatus`) maps on fetch-assigned receivers. Unmapped surface (sessions, proxies, `data=`/`json=` kwargs) stays unsupported-loud. Programs without boundary imports keep fully synchronous signatures.
- **S3 dependency validation (WS G):** the pipeline's third stage classifies every import — `emitted-local` (resolved project module), `mapped` (registry), `external-verbatim` (unmapped third-party passes through with an exact warning), `unsupported` (declared non-goal, warns), `unresolved` (relative import to no emitted module — FAILS). A registry miss is never conflated with a missing project module. S3 pass extends the claim ladder to level 3.

**Remaining known divergences after M5 (documented, honest):** float `str()` on DYNAMIC integral numbers still prints int-like in number mode (the int/float runtime distinction is lost; statically float-typed sites and bigint mode are exact); `random` does not reproduce CPython's Mersenne Twister value-for-value; `json.dumps` allow_nan emits `null` for non-finite floats (Python emits `Infinity` literals — invalid JSON either way); dict iteration order for integer-like keys; loop variables after their loop; `requests` sessions/proxies/auth objects.

## 5a. M4 implementation status (superseded surface notes)

**Implemented as specified (verified by ConstructMatrix + golden fixtures):** literals and names; arithmetic/comparison/boolean operators (typed operands → native operators, unknown operands → `__ctrans_` helpers per D-016/D-023); f-strings → template literals (format specs unsupported, loud); comprehensions (list/set/dict, single-for + filter; non-array iterables rerouted through `Object.keys`/`__ctrans_iter`, matching for-loop classification); slices (constant non-negative → native, otherwise `__ctrans_slice`); functions with defaults (definition-time sharing divergence documented), closures, nested defs, `*args`/`**kwargs` parameter forms; classes with single inheritance, `super().__init__` → `super()`, instance fields, class attributes → static (warning), dunder methods beyond `__init__` unsupported; try/except/else/finally with the generated exception hierarchy; generators (`def`+`yield` → `function*`, `yield from` → `yield*`); `async def`/`await` with `Promise<T>` return types (async generators unsupported); `with` → `__enter__`/`try/finally`+`__exit__` (exit args lost — warning); tuple unpacking (parallel/mixed via temp, nested patterns); imports resolved through the ModuleGraph (`__init__` → index barrel with re-exports).

**Python scope binding (M4 audit fix):** Python binds names at function/module scope. A name whose FIRST assignment occurs inside a nested control-flow block (if/for/while/try/with body) gets its `let` declaration hoisted to the enclosing scope top and the assignment is emitted plain — block-scoped declarations would hide the binding from later statements. Unannotated method/constructor parameters are typed `unknown` (never implicit any, matching free functions); fresh empty-list bindings are `unknown[]`; fresh dict-literal bindings are `Record<string, V>` (open mapping — later key writes type-check); parallel-assignment/unpack bindings inherit the RHS element type when statically known, else `unknown` (rebinding by construction). Loop targets keep JS block scoping — using a `for` loop variable after the loop is flagged by S2 (out-of-scope), and C-style range loops already diverge on the post-loop value.

**Deliberately verbatim/unsupported in M4 (warnings, never silent):** keyword/`**kwargs` call sites; stdlib & third-party method/name mappings (`list.append`, `math.*`, `dict.get`, … — registry is M5; native calls on known array/map receivers carry `CTW-METHOD-UNMAPPED`); Python builtin calls with no M4 mapping (`sorted`, `list`, `next`, `max`, `min`, `reversed`, `zip`, … — classified `unsupported` with a marker and `CTW-UNSUPPORTED-CALL-BUILTIN`, never emitted as silent bare identifiers); string code-point length/indexing (iteration is code-point-correct via `__ctrans_iter`; `len()` still UTF-16 — M5); `match`/`assert`/`del`/decorators/async generators/`except*`/metaclasses/descriptors.

**Verified observable divergences within the supported surface (documented, not warned per-site):** Python float `str()` formatting is not reproduced (`100.0` prints `100` in f-strings/`__ctrans_str` — full float repr parity is M5+); dict iteration/print order follows JS object property enumeration (integer-like keys enumerate first, numerically — Python preserves insertion order; values are unaffected).

Coverage floors from AGENTS.md §4, measured repo-wide at M4 audit close (2026-10-18): core 88.41% lines ✓ (floor 85), parser-py 91.82% ✓, parser-js 91.5% ✓, codegen-js 90.21% ✓ (floor 90 — closed by the audit's import-forms suite and ConstructMatrix batch; remaining uncovered lines are unsupported-arm minutiae and type-inference fallthroughs).
