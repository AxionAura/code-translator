# Code Translator v0.1.2 — release notes (prepared, NOT published)

> **Preparation record.** As of **2026-10-24** these notes describe the
> v0.1.2 candidate in the working tree only. All twelve workspace manifests
> are bumped to `0.1.2` (the private root and the eleven `@axion-ct/*`
> release packages); **nothing has been committed, tagged, packed, or
> published**, npm `latest` remains `0.1.0`→`0.1.1` history
> (`v0.1.1` published 2026-10-23), and no tarball or clean-install check has
> run yet — those belong to the separately approved packaging stage.

Release prepared: **2026-10-24**. Previous release:
[v0.1.1](release-notes-v0.1.1.md) (published 2026-10-23, immutable).

## Changes since v0.1.1

### Forward numeric reliability (audit REL findings)

- Number-mode `0 ** -1` (and zero bases `0`, `0.0`, `-0.0` with negative or
  statically unknown exponents) raises Python's `ZeroDivisionError` through
  `__ctrans_pow` instead of returning `Infinity`; bigint mode was already exact.
- Runtime-integer precision uncertainty for int-evidenced `**` outside the
  constant boundary is disclosed as `semantic` +
  `CTW-NUM-INT-RUNTIME-UNCERTAIN` (provable floats, safe constants, and bigint
  mode do not warn).
- Genuinely unresolved direct calls on JS/TS targets are no longer classified
  `deterministic`; they are `semantic` + `CTW-CALL-UNRESOLVED` while unit-local
  forward references stay deterministic.
- `@axion-ct/core` exports `ENGINE_VERSION` from its own manifest; pipeline
  reports and generated headers print it — the `0.0.0` provenance is gone.

### Reverse numeric/console semantics (JS/TS → Python)

- `Math.*` emits and defines one import-consistent dispatcher
  (`__ctrans_math_entry`) with tested JS edge semantics (`pow(0,-1)` →
  +Infinity with sign, `log(0)` → -Infinity, `sqrt(-1)`/`sign(NaN)` → NaN).
- `/` routes through `__ctrans_js_div` (signed Infinity for ±div-by-zero, NaN
  for 0/0, divisor signed zero honored: `1 / -0` → `-Infinity`); `%` through
  `__ctrans_js_mod` (NaN for a zero divisor, truncated like JS, integer
  operands keep exact integer results — arbitrary precision, a documented
  beyond-JS breadth); `==`/`!=` through `__ctrans_js_loose_eq` for the tested
  scalar subset; `Number()` through `__ctrans_js_number` (decimal/exponent
  strings plus the `0x`/`0b`/`0o` radix prefixes case-insensitively with signs;
  Python-only spellings such as `inf` and digit underscores yield NaN like JS);
  `NaN`/`Infinity` lower to executable constants; bare `undefined` lowers to
  `None`.
- The narrow `console.log/info` (stdout) and `console.warn/error` (stderr)
  subset maps to space-separated `String()` helpers with one accurate ledger
  entry per call; printf-style directives are not interpreted and warn
  (`CTW-CONSOLE-FORMAT-DIRECTIVE`, scanned across every string-literal
  argument).

### Runnable generated Python (D-029)

- Runtime imports use a dual-resolving `try:`/`except ImportError:` shape, so
  the same output runs as a package and as a flat directory; named, default,
  and namespace runtime imports all bind correctly and force runtime emission.
- Translated code references helpers through `_ctrans_` aliases (Python
  class-body mangling would rewrite `__ctrans_*` inside methods).
- `super(...args)` forwards its arguments to `super().__init__(...)`
  (`semantic`); method calls and field reads/writes on receivers provably
  constructed from an earlier-declared class (and `this`) use direct attribute
  dispatch; array-method callbacks deliver the full JS arity
  (`(item, index, array)`; reduce `(accumulator, item, index, array)`); every
  helper-emitted array/dict method call records its own ledger entry.
- The round-trip runtime bridge defines ALL 58 importable codegen-js runtime
  helper names with Python semantics (enforced by
  `tests/runtime-bridge-consistency.test.ts`); `__ctrans_truthy` is bridged as
  Python `bool()` (NaN is truthy in Python but falsy in JS; empty containers
  are falsy in Python but truthy in JS), with the same-name collision resolved
  deliberately in `renderPyRuntime`.

### Testing integrity

- The four reverse behavior differentials and the round-trip test previously
  passed vacuously (both sandboxed sides crashed; `"" == ""`). They now assert
  exit code 0 and non-empty output on both sides and genuinely execute; fixing
  them exposed and fixed four latent reverse-defect classes (helper def-name
  mismatches, callback arity, class-body mangling, missing runtime emission).
- New suites: sandbox-executed helper behavior (`runtime-behavior`), executed
  reverse differentials (`reverse-execution`), bridge consistency
  (`runtime-bridge-consistency`), and reliability regressions in both codegen
  packages plus the root suite.

## Verification (preparation time)

`pnpm verify` exit 0 — build, typecheck, lint, format, **1159/1159 tests
(119 files)**, doc links. Coverage floors: core 91.89%, parser-py 91.82%,
parser-js 91.75%, codegen-js 90.93%, codegen-py 90.76% (floors unchanged and
passing). `git diff --check` clean. Tarball contents, registry readiness, and
clean-install behavior are explicitly NOT claimed here — they require the
separately approved packaging stage.

## Remaining limitations

Carried from v0.1.1 plus this cycle's documented boundaries: leg-1 unsupported
Python builtins (`min`/`max`/`zip`/`list`/`sorted`, …) keep round-trip
evidence on the doubly-supported subset; mixed-module `__ctrans_truthy`
resolves to JS semantics; instance dispatch requires source-order class
declaration; callbacks longer than the method's JS arity and missing instance
members have documented error-type divergences; call-arity enforcement for
Python calls and full source spans in diagnostics remain deferred.
