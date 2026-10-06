# @ctrans/parser-py

Python front-end for Code Translator: parses Python source into the shared parser contract defined in `@ctrans/core` (`ParseResult`, spans, tokens, scopes — see `docs/architecture.md` §4).

## Front-ends

| Front-end | Selection | Fidelity | Provides |
| --- | --- | --- | --- |
| `createPythonBridgeParser()` (primary, D-003) | explicit | `full` | CPython AST, token/comment stream, symtable scopes, exact spans |
| `createTreeSitterPythonParser()` (fallback, D-003) | explicit | `degraded` | tree-sitter CST (`children` fields, not CPython field names), leaf tokens, **no scopes** |
| `createPythonParser({ allowFallback })` | policy wrapper | either | bridge; falls back to tree-sitter only when `allowFallback` is set and the bridge is unavailable or the runtime is unsupported |

Fallback downgrades are always visible in the result (`parser.id`, `parser.fidelity`, diagnostics) — never silent.

## Bridge protocol (D-018, version 1)

The bridge is `python/bridge.py`, a **stdlib-only** Python script. The client spawns one
short-lived process per request:

```text
python3 -I -B bridge.py --mode handshake
  → {"ok": true, "header": {"protocol": 1, "python": {"version": "3.14.7", "full": ...}}}

python3 -I -B bridge.py --mode parse [--max-source-bytes N]   # source bytes on stdin
  → {"ok": true,  "header": ..., "result": {...}, "diagnostics": [...]}
  | {"ok": false, "header": ..., "error": {"kind": "syntax|encoding|limit|internal", ...}}
```

- Exit **0** = well-formed envelope (parse failures are *data* in the envelope, mapped to
  typed errors by the client). Exit **2** = usage error → `PythonBridgeProtocolError`.
  Any other exit = crash → `PythonBridgeCrashError`.
- `handshake` is run once at client construction; every parse response re-carries the
  header, and the client re-validates protocol and interpreter version on each result.
- Supported interpreters: **Python 3.12–3.14**. Verified in CI on the environment's
  interpreter (3.14.x); 3.12/3.13 are accepted by the handshake but were not exercised here.

## Data contract

- **Spans:** UTF-8 byte offsets (`startByteOffset`/`endByteOffset`, end exclusive) plus
  0-based line and UTF-8 byte column. The bridge normalizes CPython's byte columns and
  tokenize's 1-based rows / code-point columns into this one grid; the tree-sitter
  front-end converts its code-point columns the same way.
- **AST:** generic envelope `{kind, span, fields}` — `kind` is the CPython node class
  name ("Module", "FunctionDef", ...); operator/context nodes have `span: null`.
- **Scalars JSON cannot hold** are tagged: `{"tag": "int", "decimal"}` (beyond 2^53),
  `{"tag": "float", "value": "inf"|"−inf"|"nan"}` (e.g. `1e999`), `{"tag": "bytes",
  "base64"}`, `{"tag": "complex", "real", "imaginary"}`, `{"tag": "ellipsis"}`.
- **JSON is ASCII-escaped** in both directions, so lone surrogates in string literals
  survive losslessly through `JSON.parse`.
- **Scope quirks captured as-is:** 3.12+ may inline comprehension scopes (PEP 709);
  3.14 reports `annotation` scopes (PEP 749) as children of the *enclosing* scope.
- Sources without a trailing newline: the tokenizer's phantom final line is clamped to
  end-of-file for token spans.

## Limits and lifecycle

- Source cap 5 MiB, output cap 64 MiB, wall-clock timeout 30 s (all constructor options:
  `maxSourceBytes`, `maxOutputBytes`, `timeoutMs`); a hung bridge is SIGKILLed and
  reported as `PythonBridgeTimeoutError`.
- CPython's parser-depth guard ("too many nested parentheses") is classified as a
  resource limit (`PY-SOURCE-LIMIT`, `limit: "parserDepth"`), not a syntax error.
- The AST encoder is iterative (explicit stack) on both the Python and TypeScript sides;
  pathological AST depth cannot exhaust the process stack.

## Security boundary

- The bridge operates **only on the input's syntax**: it never imports user modules,
  never executes user code (module-level statements, decorators, default values), never
  reads user files, and never spawns anything.
- Spawned with `-I` (isolated: `PYTHON*` env and user site-packages ignored; cwd is not
  on the import path), `-B` (no bytecode files), and a whitelisted environment.
- Hostile-input tests (`test/security.test.ts`) prove the boundary: side-effect-laden
  modules produce parse results and no observable effects.

## API note

`parse(source: string)` accepts **decoded text** and always transports it as UTF-8, so
source files in non-UTF-8 encodings must be decoded (and their coding declarations
normalized) by the caller before parsing — project intake handles this in a later
milestone. Files in UTF-8 (with or without BOM) parse directly.
