# @ctrans/parser-js

JavaScript/TypeScript front-end for Code Translator: parses JS/TS/JSX/TSX into the shared parser contract defined in `@ctrans/core` (`ParseResult`, spans, comments, module info — see `docs/architecture.md` §4).

## Front-ends

| Front-end | Role | Fidelity | Provides |
| --- | --- | --- | --- |
| `createOxcJsParser()` (primary, D-004) | default | `full` | source-shaped ESTree AST, error recovery with diagnostics, comments, module map (extracted from the normalized AST) |
| `createBabelJsParser()` (fallback, D-004) | only via policy | `full` | same contract through `@babel/parser`; used when oxc cannot load |
| `createJsParser({ allowFallback })` | selection policy | either | oxc; falls back to Babel only when `allowFallback` is set and oxc cannot load — the downgrade is recorded in `parser.id`, never silent |
| `TypeScriptSemanticOracle` | semantic queries (D-004) | — | pinned `typescript@6` Program/TypeChecker behind a plain-data interface; the only compiler-API consumer in the repository (enforced by `scripts/ts7-guard.test.ts`) |

Parser instances are language-agnostic; the grammar mode is chosen per parse and never
guessed: `parse(source, { language: "javascript" | "typescript", jsx?: boolean,
filename? })`. The caller's `filename` label never changes parsing behavior — a
synthetic in-memory name (`<source>.ts`, `<source>.tsx`, …) drives the grammar.

## Data contract

- **Spans:** UTF-8 byte offsets (`startByteOffset`/`endByteOffset`, end exclusive) plus
  0-based line and UTF-8 byte column. oxc and Babel both report UTF-16 code-unit
  indices; `normalize.ts` converts them through a memoized byte-offset map and derives
  line/column on the shared line grid — parser columns are never trusted.
- **AST:** the generic `AstNode` envelope (`kind` = ESTree node type: "Program",
  "FunctionDeclaration", "JSXElement", "TSInterfaceDeclaration", …). Plain-object
  properties expand into dotted sibling fields (`regex.pattern`, `regex.flags`,
  `extra.raw`) so the scalar-only `AstValue` contract holds without information loss.
- **Comments** travel in `result.comments` as `TokenInfo` entries whose text is the
  exact source slice (with markers). JS front-ends emit a comment-only token stream
  (`tokens = []`); the full token stream is a Python-bridge convention (D-019).
- **Module info** (`result.module`): imports (named/default/namespace/side-effect),
  exports (named/default/star/star-as, with re-export specifiers), dynamic imports with
  static specifiers, and `hasModuleSyntax`. Extracted from the normalized AST so oxc
  and Babel share one code path; the oxc native module map is cross-checked in tests.
  Babel shapes `export * as ns` as a namespace specifier inside a named export and oxc
  as an export-all declaration with an exported name — both normalize to `star-as`
  with the full declaration span.
- **Diagnostics:** oxc recovers from syntax errors and returns `error`-severity
  diagnostics with spans alongside the recovered tree; malformed source is never
  presented as clean. Babel does the same under `errorRecovery` and maps
  unrecoverable failures to typed `JsSyntaxError` (with span when Babel reports one).
- **Scopes:** `null` for all JS front-ends in M2 — JS/TS scope analysis lands with the
  M3 semantic layer (for TypeScript the oracle covers symbol/type queries meanwhile).

## Hostile-input containment (ADR D-020)

oxc-parser is a native binding and **segfaults the whole process on deeply nested
sources** (verified on 0.153.0: ~4000 nesting levels parse cleanly, ~8000 SIGSEGV), and
it exposes no depth option. `safety.ts` therefore screens every input with a linear
bracket scan; flagged inputs are measured exactly via the pure-JS Babel parser (whose
stack overflow is a catchable RangeError, never a crash) or our own normalized-tree
walk. True nesting beyond `MAX_SAFE_NESTING_DEPTH` (2000) becomes a typed
`JsSourceLimitError` — the native layer never sees input it cannot survive. The scan is
a resource-limit prefilter, not parsing: it makes no syntax claims (AGENTS.md §11).

Additional caps: sources above 5 MiB are rejected before parsing (`maxSourceBytes`
option). Parsing never evaluates input — the parser libraries only construct trees.

## TypeScript semantic oracle

`TypeScriptSemanticOracle` uses the pinned `typescript@6` compiler API behind the core
`TsSemanticOracle` interface (plain data in/out; no compiler objects leak):

- `summarizeModule({files, filename})` → diagnostics (syntactic + semantic, contract
  spans) and the module export surface (names, export kinds, symbol flags, type
  display + type flags, declaration spans). Sources are in-memory virtual files;
  library declarations load from the pinned typescript package on disk.
- `typeAt({files, filename, byteOffset})` → type display + flags for the deepest node
  at a UTF-8 byte offset.

The adapter refuses to construct on any non-6.x compiler (`TsOracleVersionError`), and
`scripts/ts7-guard.test.ts` fails CI if `"typescript"` is imported anywhere outside the
adapter, if the manifests/lockfile drift off the 6.x line, or if TS7-native tooling
(`tsgo`) is referenced. When the TypeScript 7.1+ API ships, only this adapter changes.

## Known limitations

- `sourceType: "module"` semantics: script-only constructs that modules forbid (e.g.
  `with`) fail to parse; scripts are still detected via `hasModuleSyntax === false`.
- Babel's recoverable/unrecoverable boundary differs from oxc's; both outcomes are
  structured (diagnostics on a result, or a typed error).
- `parse()` accepts decoded text; encodings are handled upstream (project intake, M6).
- The depth screen uses `MAX_SAFE_NESTING_DEPTH = 2000`, far above real code (engines
  and CPython give up far earlier) and far below the verified crash window.
