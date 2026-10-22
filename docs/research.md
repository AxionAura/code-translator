# Research — Verified Technology Survey (2026-10-06)

All facts below were verified against primary sources on **2026-10-06** (web research pass with four parallel tracks: parsers/semantic analysis, prior art, cross-language semantics & dependency mapping, security/toolchain). Facts that could not be confirmed from a primary source are marked **UNVERIFIED**. Do not treat unmarked claims as re-verified after this date; re-check pinned versions during milestone M0.

Local environment observed on 2026-10-06 (dev machine): Node 24.15.0, npm 11.12.1, Python 3.14.7, pip 26.2.1, git 2.55.0, Docker 29.8.1, Podman 5.8.7, Rust 1.98.1. pnpm not installed (via corepack/pnpm@10 per `package.json`).

---

## 1. Parsing and semantic analysis

### 1.1 Candidate comparison

| Tool | Version (verified) | License | TS support | Error recovery | Comments | Semantic info | Verdict for us |
| --- | --- | --- | --- | --- | --- | --- | --- |
| CPython `ast`/`symtable`/`tokenize` | ships with CPython | PSF | n/a (Python) | none (valid code only) | via `tokenize` | **full** scope/symbol tables | **Primary Python front-end** |
| tree-sitter (web-tree-sitter WASM) | 0.27.0; `tree-sitter-python` 0.25.0 | MIT | via grammar | yes (`ERROR`/`MISSING` nodes) | grammar `extra` nodes | none (CST only) | **Fallback Python parser** |
| oxc-parser | 0.153.0 (0.x) | MIT | yes, incl. JSX | yes (`errors[]`) | separate `comments[]` | module map; scope errors optional | **Primary JS/TS parser** |
| @babel/parser | 7.29.9 | MIT | yes (incl. proposals) | yes (`errorRecovery`) | attached to nodes | none | Fallback JS/TS parser |
| typescript (JS API) | **6.x only** | Apache-2.0 | native | tolerant parser | leading/trailing ranges | **full Checker/Program** | **Semantic oracle for JS/TS** |
| typescript 7 (tsgo, Go) | 7.0.2 stable (GA 2026-07-08) | Apache-2.0 | native | — | — | **no JS API in 7.0** (7.1 expected) | Build/check speed only; API via `@typescript/typescript6` |
| @swc/core | 1.16.13 | Apache-2.0 | yes | limited | separate structure | none | Avoid (non-ESTree AST; no gain for us) |
| esprima | 4.0.1 (last release 2018) | BSD-2 | no | — | — | none | Avoid (dormant, ES2017-era) |
| acorn (+ acorn-jsx) | 8.19.0 | MIT | no | — | `onComment` | none | Reference only |
| pyright (CLI `--outputjson`) | 1.1.414 | MIT | n/a | — | — | diagnostics + ranges (0-based) | **Primary Python-output type checker** |
| pyright (embedded) | — | MIT | — | — | — | full internals, **unstable** | Avoid unless fork-and-pin (basedpyright pattern) |
| mypy (`mypy.api`, `--output json`) | 2.4.0 (JSON output new in 2.4.0) | MIT | n/a | — | — | diagnostics | Secondary Python-output checker |

### 1.2 Load-bearing findings

- **TypeScript 7.0 (native Go port, GA July 2026) ships no programmatic API.** Official announcement: "TypeScript 7.0 … does not ship with an API. We expect TypeScript 7.1 to ship with a new (and different) API." The classic JS API (`ts.createSourceFile`, `ts.createProgram`, `Checker.getTypeAtLocation`) is complete only in the 5.x/6.x lines. Microsoft ships the compatibility package **`@typescript/typescript6` 6.0.2** for the side-by-side pattern. **Consequence:** the engine pins the TS 6.x line for all compiler-API work and wraps it behind an adapter so the 7.1 API can be adopted later without engine rewrites.
- **Python parsing should not be re-implemented in JS.** The CPython stdlib gives, for free and always in sync with the running interpreter: full AST with exact start/end positions (`lineno/col_offset/end_lineno/end_col_offset`; columns are UTF-8 byte offsets), true scope analysis (`symtable`: local/global/free/parameter/imported flags per block), and a lossless token stream with comments, INDENT/DEDENT and encodings (`tokenize`). JSON serialization must be written by us (walk `_fields`), handling operator/context singletons and deep-recursion limits. Python grammar notes: 3.12 added PEP 695 type-parameter nodes and PEP 701 f-string tokenization; 3.14 added PEP 750 t-strings (`TemplateStr`) — bridge must declare a supported grammar range.
- **web-tree-sitter (WASM, 0.27.0) is the maintainable tree-sitter embedding path from Node**; the native `tree-sitter` npm binding has recurring node-gyp/build pain (Node 24 breakage reported Jan 2026). Tree-sitter's value for us: always-well-formed CST with `ERROR`/`MISSING` nodes → tolerant fallback parsing of partially broken input, and no dependency on a local `python3`.
- **oxc-parser is the strongest JS/TS front-end** for our purposes: ESTree-conformant output (TS output matches ts-estree), error recovery with a collected `errors[]`, comments, ranges, and a static import/export module map; MIT; prebuilt napi binaries. Reservation: pre-1.0 versioning.
- **pyright as a library is a trap** (no public API; internals unstable between releases — the proven embedding pattern is basedpyright's fork-and-pin). CLI `--outputjson` is de-facto stable but not formally guaranteed → pin the version, parse tolerantly.
- Node's bundled TS type stripper is **Amaro** 1.2.1 (wraps `@swc/wasm-typescript`; `strip-only` preserves line/columns; default-on in Node ≥22.18) — useful as an external cross-check for the TS→JS direction, not as our codegen.

### 1.3 Decisions

See `docs/decisions.md` D-003/D-004/D-005. Summary: Python front-end = CPython stdlib bridge (primary) + web-tree-sitter (fallback); JS/TS front-end = oxc-parser (primary) + @babel/parser (fallback), with typescript@6 as the semantic oracle; output type checking = tsc 6.x for TS output, pyright CLI (pinned) + optional mypy 2.4 for Python output.

---

## 2. Prior art: existing translators and LLM-era systems

### 2.1 Survey (all statuses verified on GitHub 2026-10-06)

| Tool | What it actually is | License | Last activity | Verdict |
| --- | --- | --- | --- | --- |
| Transcrypt | True AOT Python→JS compiler (CPython parser, readable JS + sourcemaps, small runtime, stdlib subset: math, cmath, copy, dataclasses, datetime, inspect, itertools, logging, math, random, re, sys, time, typing, unicodedata, warnings) | Apache-2.0 (reported; UNVERIFIED this session — confirm before code reuse) | v3.9.5 2026-06-20; low-frequency | **Learn-from**; architecture reference |
| Brython | Python 3 runtime implemented in JS (translates in-browser at load; ships `brython_stdlib.js`) | BSD-3-Clause | active (2026-10-02) | Learn-from (not reusable server-side) |
| Pyodide | CPython compiled to WASM (v314, 2026-06) | MPL-2.0 | very active | **Reuse as validation oracle** (execute source Python safely for pure-Python tests) |
| RapydScript | Python-*dialect* → JS | BSD-2 (PyPI GPL claim conflict UNVERIFIED) | dead (2023) | Avoid |
| PythonJS | Python→JS translator | UNVERIFIED | dead | Avoid |
| js2py | JS interpreter in Python | MIT (not LGPL as often claimed) | unmaintained; **CVE-2024-28397 sandbox-escape RCE unpatched** | **Avoid** |
| metapensiero.pj (JavaScripthon) | Python AST→ES6/ES5, readable output | **GPL-3.0** | stalled (2024) | Learn-from only; never copy |
| sucrase / esbuild / swc / Amaro / babel TS preset | Intra-language TS→JS transformers/strippers | MIT/Apache | active/mature | Reuse as plumbing where needed |
| ts-migrate (Airbnb) | JS→TS codemods inserting `any` until it compiles | MIT | frozen (2022 npm) | Learn-from ("compile-first, types-later" staging) |
| TypeStat | Incremental type improver | MIT | low maintenance | Learn-from |
| jest-codemods | jscodeshift API-surface codemods (Mocha/Chai/Jasmine→Jest) | MIT | **pushed 2026-10-05 (active)** | **Reuse pattern** (proof 1:1 API codemods work) |
| pytest→Jest/Vitest translator | **Does not exist** (searched GitHub: only manual guides) | — | — | **Whitespace = our opportunity** |
| py2ts / python-to-typescript | Only schema converters exist (pydantic/dataclass→TS interfaces); **no mature full-language Python→TS translator** | — | — | Whitespace confirmed |
| ast-grep | tree-sitter structural search/rewrite, ~25 languages | MIT | very active | **Reuse** for in-language fixups; not a cross-language substrate |
| semgrep | Pattern scanner | LGPL-2.1 (engine) | active | Avoid as substrate (license + scan-oriented) |
| GitHub `semantic` | tree-sitter parsing/diffing libs | BSD historically | **archived** | Avoid |

### 2.2 Neural/LLM translation research

- **TransCoder** (Meta, 2020): unsupervised seq2seq, C++/Java/Python functions. License **CC-BY-NC 4.0 (non-commercial)**, repo archived (2021). Learn-from only.
- **TestTrans / TransCoder-ST** (ICLR 2023, arXiv 2110.06773): auto-generated unit tests used to *filter invalid translations* before acceptance — the single most transferable idea from the neural era.
- **AlphaTrans** (FSE 2024; artifact NCSA-licensed, active): **closest architecture template to ours** — decomposes the repository via program analysis, prompts per fragment, validates semantic equivalence using the translated test suite.
- **UniTrans** (FSE 2024): prompt framework + optimize-then-execute loop against unit tests; no fine-tuning.
- Naive one-shot LLM translation measured at only ~26.65% correctness in a 2024 ACL study; scaffolding (tests + repair loops) is decisive. Historical TransCoder-era function-level rates were ~34–60%.
- **jTrans is NOT a translation paper** (binary-code similarity; commonly miscited).
- Products: GitHub Copilot app modernization (agentic plan→apply→build/test→fix; .NET/Java; no Python target); Amazon Q Developer transformation is being sunset (end-of-support announced 2026-04-30) — a cautionary product lesson.

### 2.3 What the prior art teaches

1. Survivors share three traits: **readable, sourcemapped output**; **deliberate incompleteness** with loud failures (Transcrypt's "better 90% complete"); **leveraging the host language's own parser**. Projects died chasing full semantic coverage (the "just run CPython-in-WASM" collapse) or dialect drift.
2. Intra-language transformation (esbuild/swc/Babel/Amaro) thrives; **cross-language full-fidelity deterministic translation does not exist as mature infrastructure** — which is why our architecture pairs a deterministic core with explicit classification, validation, and optional AI escalation rather than pretending determinism can cover 100%.
3. Every credible modern system (TestTrans, UniTrans, AlphaTrans, Copilot app-mod) wraps generation in a **test-driven validate-repair loop**. Our Validation Engine is the differentiator, not an afterthought.

---

## 3. Semantic differences (verified against Python docs, PEPs, MDN, TC39)

Each item below was verified with a primary source on 2026-10-06. Full engineering treatment (mappings, classifications per direction) lives in `docs/language-support.md`.

| # | Area | Verified divergence |
| --- | --- | --- |
| 1 | Truthiness | Python falsy: `None, False, 0, 0.0, 0j, '', [], {}, set(), range(0)` (+ `__bool__`/`__len__`); **`NaN` is truthy in Python**. JS falsy: `false, 0, -0, 0n, NaN, '', null, undefined`; **`[]`/`{}` are truthy in JS**. Sources: docs.python.org stdtypes §truth; MDN Falsy. |
| 2 | Equality | Python `==` is overloadable value comparison; `is` is identity. JS `===` no coercion; `==` coerces (`[] == false` → true; `null == undefined` → true). |
| 3 | Numbers | Python `int` arbitrary-precision; `float` = IEEE-754 double. JS `Number` = double only (+`BigInt`, which **cannot mix with Number**). `//` floor division (toward −∞) vs BigInt/Number truncation toward zero. `%`: Python takes divisor's sign; JS dividend's sign. |
| 4 | Strings | Python `str` = Unicode code points. JS string = **UTF-16 code units** (`"😄".length === 2`). `slice(start,end)` has no step; Python slicing has step `s[i:j:k]`. |
| 5 | Scoping | Python: function/module/class/comprehension scopes only; **no block scope**; class body scope is invisible to methods; comprehensions have own scope. JS: `let/const` block scope + TDZ; `var` function-scoped + hoisted. |
| 6 | Classes | Python: C3 MRO, multiple inheritance, dunder protocols (`__str__ __repr__ __eq__ __iter__ __next__ __getitem__ __call__ __enter__/__exit__`). JS: single prototype chain, `#private` fields (not proxyable), `Symbol.iterator`/`Symbol.toPrimitive`, `Proxy`. |
| 7 | Decorators | **TC39 decorators: Stage 2.7, not shipped in engines** (verified on the official proposals tracker; the proposal repo's "stage 3" FAQ sentence is stale). TypeScript 5.0+ ships ES-style decorators without a flag; legacy `experimentalDecorators` is incompatible. Python decorators are higher-order function application — we do not need TS decorators at all. |
| 8 | Generators | Near 1:1: `send`↔`next(value)`, `throw`↔`.throw()`, `close`↔`.return()`, `StopIteration.value`↔`done:true`+value, `yield from`↔`yield*`. Divergence: Python's catchable `GeneratorExit` vs JS return-completion. |
| 9 | Async | Python: coroutines + explicit loop (`asyncio.run`), **synchronous stdlib I/O** (`open()`, `requests`). JS: microtask-primed event loop; **`fetch()` has no synchronous variant** (sync XHR deprecated). Sync→async call-chain propagation is the one structural breaker. |
| 10 | Exceptions | Python: only `BaseException` subclasses throwable; hierarchy + `try/except/else/finally`; exception groups (`except*`, 3.11). JS: any value throwable; `Error.cause`; **no `else` clause**. |
| 11 | Modules | Python: `__init__.py` packages, relative imports, circular imports yield **partially-initialized modules** (some patterns work). ESM: static linking, live bindings, hoisting, cycles can hit TDZ `ReferenceError`. |
| 12 | `match` | PEP 634 structural patterns (sequence/mapping/class/capture/guards) — **no JS equivalent** (`switch` is `===`-only). |
| 13 | Misc | Walrus `:=` (PEP 572); f-string `=` debug spec; chained comparisons evaluate the middle operand **once** (`a < b < c`); Python operator overloading is full (JS **withdrawn** the operator-overloading proposal April 2025; only `Symbol.toPrimitive`/`valueOf`). |
| 14 | Regex | Named groups `(?P<n>…)` vs `(?<n>…)`; backrefs `(?P=n)` vs `\k<n>`; Python 3.11 atomic groups/possessive quantifiers have **no JS equivalent**; lookbehind fine both ways (JS Baseline since 2023-03; Python restricted to fixed width). |
| 15 | Datetime | **TC39 Temporal: Stage 4** (verified on proposal README); shipped Firefox 139 (2025-05-27), Chrome 144 (2026-01-13), **Node.js 26 (2026-05-05)**; Safari pending. Legitimate mapping target with runtime gating. |

---

## 4. Dependency mapping precedents

- **No machine-readable Python-stdlib→Node mapping dataset exists publicly** (targeted searches found none; Transcrypt ships hand-written JS module implementations for ~17 stdlib modules; Brython ships CPython's pure-Python stdlib for the browser). The registry we build in `packages/registry` is **original work**, informed by (not copied from) Transcrypt's module list.
- `fetch` is global in Node 18+; `requests`→`fetch` implies **sync→async re-writing** (no sync variant exists).
- **Vitest** deliberately provides pytest-adjacent surfaces: `test.extend` fixtures (docs credit Playwright, semantics are close enough for basic mapping), `test.each` ≈ `pytest.mark.parametrize`, `vi.mock` (hoisted) ≈ `unittest.mock.patch`. **No `monkeypatch` equivalent.** pytest→Vitest mapping is feasible for the common surface; gaps must be classified honestly.
- Node/Python versions as of 2026-10-06: Node 24 Active LTS (Node 26 LTS late Oct 2026), Python 3.14 stable (3.13 in maintenance).

---

## 5. Security, sandboxing, toolchain

### 5.1 Sandboxing (verified)

- **Baseline (always):** Node `child_process.spawn` hardening — argv arrays (`shell:false`), explicit env whitelist, temp `cwd`, `timeout`+kill, captured stdio. Node exposes **no rlimits**; resource caps need a `prlimit(1)` wrapper or helper.
- **Optional layer:** **bubblewrap (bwrap)** — unprivileged, LGPL, actively maintained; suid mode removed in 0.12 (user namespaces only); `--unshare-net` for network isolation; degrades on hardened kernels where unprivileged userns is disabled → capability detection required. firejail (suid-root history, ~19 CVEs) and systemd-run (non-root can't do PrivateNetwork) rejected.
- **Strict mode (opt-in):** Docker/Podman; gVisor (runsc, Apache-2.0, CNCF) for stronger isolation. Requiring containers would break local-first UX → V1 keeps it optional.
- **In-process/WASM:** quickjs-emscripten (MIT, active-ish) for JS snippet eval; isolated-vm (ISC) **maintenance mode** with a 2026 sandbox-escape report — avoid; Pyodide **is not a security boundary** and can't run subprocess-using test suites — useful only as an optional oracle for pure-Python tests; WASI 0.2/0.3 not ready for arbitrary project test runs.

### 5.2 Secrets, keys, LLM security

- Secret scanning: **secretlint** (MIT, TypeScript, embeddable in Node) chosen; gitleaks (MIT, Go binary) optional external; **trufflehog excluded (AGPL-3.0)**.
- API keys: keytar deprecated; Electron safeStorage N/A for CLI. Adopt the **gh CLI model**: OS keychain first (macOS `security`, Linux `secret-tool`, Windows CredMan) → fallback plaintext config with 0600/0700 permissions + warning.
- **OWASP Top 10 for LLM Applications v2.0 (2025)** is current. Applicable risks for us: LLM01 prompt injection (user code inside prompts), LLM02 sensitive-data disclosure (code sent to providers → pre-flight secret scan), LLM05 improper output handling (model output gets executed later → mechanical validation gates), LLM06 excessive agency (zero model-driven tool execution), LLM10 unbounded consumption (hard cost caps).

### 5.3 Toolchain pins (verified 2026-10-06)

| Component | Version / status |
| --- | --- |
| Node.js | 24 = Active LTS; 26 LTS late Oct 2026 (ships Temporal). Adopted engine floor: `>=22.18` (raised from the initial 22.12 research note for unflagged TypeScript type stripping); recommend ≥26 for datetime fidelity |
| pnpm | 10.x (10.26); build-script blocking on by default |
| TypeScript | **6.x for compiler API** (`typescript@6` / `@typescript/typescript6` 6.0.2); 7.x fine for plain build/check |
| ESLint | 10 (flat config only) |
| Prettier | 3.x (3.7) |
| Vitest | 5.0 (2026-09-03) |
| Python | 3.12–3.14 supported grammar range (3.14.0 released 2025-10-07; free-threading Phase II) |
| ruff / uv | ruff active (0.16); uv MIT/Apache de-facto standard |
| pytest | 9.0.0 (2025-11-08) |
| npm supply chain | provenance GA but **633 malicious versions passed provenance on 2026-05-19** → provenance is necessary, not sufficient: pin lockfile, avoid lifecycle scripts |

---

## 6. Consolidated verdict

The research supports the architecture in `docs/architecture.md`:

1. A **deterministic multi-front-end compiler** is buildable from mature, permissively licensed parts (CPython stdlib, oxc, typescript@6, pyright) without inventing parsers.
2. **No universal AST IR**: prior art (Transcrypt, metapensiero.pj, Babel) all translate AST→AST with a thin semantic layer; a universal IR would add design risk with no payoff at N=3 languages. Shared *semantic* model + per-language lowering is the proven pattern.
3. The **validation engine + test-driven repair** is where every credible modern system (TestTrans, UniTrans, AlphaTrans, commercial products) converged; it is also confirmed whitespace (no pytest→Vitest translator exists, no Python→TS translator exists).
4. **Sandboxing** has a realistic no-root story (hardened spawn + optional bwrap) and a strict story (Docker/Podman/gVisor) — both fit the local-first product.
5. **AI** belongs at two escalation points only, provider-agnostic, with secret screening and hard caps — consistent with OWASP LLM v2 and with the deterministic-first principle.

## Source index (primary)

- Parsers: docs.python.org/3/library/{ast,symtable,tokenize}.html; registry.npmjs.org (oxc-parser, @babel/parser, typescript, @typescript/typescript6, @swc/core, esprima, acorn, pyright, amaro, ts-blank-space, sucrase, esbuild, web-tree-sitter, tree-sitter-python); devblogs.microsoft.com/typescript (TS 7.0 announcement — "does not ship with an API"); crates.io/tree-sitter; oxc.rs docs; pyright docs/command-line.md; mypy 2.4.0 release notes.
- Prior art: github.com/QQuick/Transcrypt (+ modules/ tree), brython-dev/brython, pyodide/pyodide, atsepkov/rapydscript, PythonJS/PythonJS, PiotrDabkowski/Js2Py (+ CVE-2024-28397, SentinelOne), metapensiero/metapensiero.pj, airbnb/ts-migrate, JoshuaKGoldberg/TypeStat, skovhus/jest-codemods, ast-grep/ast-grep, semgrep, github/semantic (archived), facebookresearch/TransCoder (CC-BY-NC), arXiv 2110.06773 (TestTrans), 2207.03565 (TransCoder-IR), 2205.12713 (jTrans — miscitation note), Intelligent-CAT-Lab/AlphaTrans, yz1019117968/FSE-24-UniTrans, AWS end-of-support notice for Amazon Q transformation.
- Semantics: docs.python.org/3 (reference/expressions, reference/datamodel, reference/executionmodel, reference/import, library/stdtypes, library/exceptions, library/re, library/asyncio-task, whatsnew/3.8, whatsnew/3.11, whatsnew/3.14); peps.python.org 572/634/636; developer.mozilla.org (Falsy, Equality, Strict_equality, Number, BigInt, Remainder, String.length, String.slice, let, var, Event loop, yield*, Fetch_API, sync XHR, Error, try...catch, switch, Symbol.toPrimitive, prototype chain, Private properties, Modules, Named capturing group, Lookbehind); github.com/tc39/proposals, tc39/proposal-decorators, tc39/proposal-operator-overloading (withdrawn 2025-04-03), tc39/proposal-temporal (Stage 4; Firefox 139 / Chrome 144 / Node 26); nodejs.org v18 announcement (global fetch).
- Security/toolchain: nodejs.org/en/about/previous-releases; manpages.debian.org bubblewrap; firejail GitHub; systemd issue #40138/#40165 context via GHAF docs; gvisor.dev; github.com/laverdet/isolated-vm; justjake/quickjs-emscripten; pyodide.org; wasi.dev; secretlint; OWASP genai.owasp.org (Top 10 v2.0); npm docs (provenance); VentureBeat 2026-05-19 provenance-bypass report; gh CLI credential handling (login.go); vitest.dev (5.0 blog, test-context, vi.mock); pypi.org/project/pytest/9.0.0; docs.astral.sh (ruff, uv).
