r"""CTrans Python parse bridge - protocol v1 (docs/decisions.md D-018).

Stdlib-only parser process for @ctrans/parser-py. Reads Python source bytes on
stdin, emits exactly one JSON envelope on stdout. The bridge operates purely on
the input's *syntax* (ast / symtable / tokenize): it never imports or executes
user source, never reads user files, and is spawned in isolated mode
(`python3 -I -B bridge.py`) so user environment and paths stay out.

Protocol contract (see packages/parser-py/README.md):
- `--mode handshake`: emit {"ok": true, "header": ...}, exit 0.
- `--mode parse`: read source from stdin, emit one envelope, exit 0.
  Exit 0 always means "well-formed envelope" - parse failures are data in the
  envelope ("ok": false), not crashes. Exit 2 = usage error. Anything else = crash.
- Header: {"protocol": 1, "python": {"version": "3.14.7", "full": ...}}.
- Spans: UTF-8 byte offsets + 0-based line / UTF-8-byte column, exclusive end.
  tokenize rows/columns (1-based rows, code-point columns) are converted here so
  the whole contract is byte-based, matching ast col_offset semantics.
- JSON is ASCII-escaped: lone surrogates survive as \uXXXX escapes and stay
  lossless through JSON.parse.
"""

import ast
import base64
import io
import json
import math
import symtable
import sys
import token as token_module
import tokenize

PROTOCOL_VERSION = 1
MAX_SOURCE_BYTES_DEFAULT = 5 * 1024 * 1024

# Boundaries of IEEE-754 double round-tripping through JSON numbers (JS Number.isSafeInteger).
_MAX_SAFE_INTEGER = 2**53 - 1


class BridgeUsageError(Exception):
    """Invalid bridge invocation; reported on stderr with exit code 2."""


class BridgePayloadError(Exception):
    """Structured failure reported as an {"ok": false} envelope with exit code 0."""

    def __init__(self, payload):
        super().__init__(payload.get("message", "bridge error"))
        self.payload = payload


def header():
    return {
        "protocol": PROTOCOL_VERSION,
        "python": {
            "version": ".".join(str(part) for part in sys.version_info[:3]),
            "full": sys.version,
        },
    }


def emit(payload):
    sys.stdout.write(json.dumps(payload, allow_nan=False) + "\n")
    sys.stdout.flush()


def parse_args(argv):
    mode = None
    max_source_bytes = MAX_SOURCE_BYTES_DEFAULT
    i = 0
    while i < len(argv):
        arg = argv[i]
        if arg == "--mode" and i + 1 < len(argv):
            mode = argv[i + 1]
            i += 2
        elif arg == "--max-source-bytes" and i + 1 < len(argv):
            try:
                max_source_bytes = int(argv[i + 1])
            except ValueError as exc:
                raise BridgeUsageError("--max-source-bytes expects an integer") from exc
            i += 2
        else:
            raise BridgeUsageError(f"unexpected argument: {arg}")
    if mode not in ("handshake", "parse"):
        raise BridgeUsageError("--mode handshake|parse is required")
    if max_source_bytes <= 0:
        raise BridgeUsageError("--max-source-bytes must be positive")
    return mode, max_source_bytes


def scan_lines(text):
    """Split source into lines exactly like the Python tokenizer: \n, \r\n, \r end a
    line (form feeds and other Unicode line boundaries do not). Returns
    (line_texts, line_start_bytes) with 0-based lines."""
    entries = []  # (line_text, terminator_length)
    line_start = 0
    i = 0
    n = len(text)
    while i < n:
        ch = text[i]
        if ch == "\n":
            entries.append((text[line_start:i], 1))
            i += 1
            line_start = i
        elif ch == "\r":
            term = 2 if i + 1 < n and text[i + 1] == "\n" else 1
            entries.append((text[line_start:i], term))
            i += term
            line_start = i
        else:
            i += 1
    entries.append((text[line_start:], 0))
    line_texts = [line_text for line_text, _ in entries]
    starts = []
    byte_pos = 0
    for line_text, term_len in entries:
        starts.append(byte_pos)
        byte_pos += len(line_text.encode("utf-8")) + term_len
    return line_texts, starts


def byte_column(line_text, char_column):
    """CPython reports token columns in code points but ast columns in UTF-8 bytes;
    this converts token columns into the byte-based contract."""
    return len(line_text[:char_column].encode("utf-8"))


def position(line_texts, line_starts, row, char_column):
    """(1-based row, code-point column) -> contract position."""
    line = row - 1
    if line >= len(line_texts):
        # Without a trailing newline the tokenizer places the ENDMARKER (and implicit
        # NEWLINE) on a phantom line past the source grid; clamp to end of file.
        line = len(line_texts) - 1
        end_column = len(line_texts[line].encode("utf-8"))
        return {"line": line, "column": end_column}, line_starts[line] + end_column
    line_text = line_texts[line] if line >= 0 else ""
    column = byte_column(line_text, char_column)
    return {"line": line, "column": column}, line_starts[line] + column


def span_from(line_texts, line_starts, start, end):
    start_pos, start_byte = position(line_texts, line_starts, start[0], start[1])
    end_pos, end_byte = position(line_texts, line_starts, end[0], end[1])
    return {
        "start": start_pos,
        "end": end_pos,
        "startByteOffset": start_byte,
        "endByteOffset": end_byte,
    }


def node_span(node, line_texts, line_starts):
    lineno = getattr(node, "lineno", None)
    if not isinstance(lineno, int):
        # Operator/context and similar helper nodes carry no source positions.
        return None
    end_lineno = getattr(node, "end_lineno", None)
    end_lineno = end_lineno if isinstance(end_lineno, int) else lineno
    col = getattr(node, "col_offset", 0)
    end_col = getattr(node, "end_col_offset", col)
    start_byte = line_starts[lineno - 1] + col
    end_byte = line_starts[end_lineno - 1] + end_col
    return {
        "start": {"line": lineno - 1, "column": col},
        "end": {"line": end_lineno - 1, "column": end_col},
        "startByteOffset": start_byte,
        "endByteOffset": end_byte,
    }


def encode_scalar(value):
    if value is None or isinstance(value, bool):
        return value
    if isinstance(value, int):
        if -_MAX_SAFE_INTEGER <= value <= _MAX_SAFE_INTEGER:
            return value
        return {"tag": "int", "decimal": str(value)}
    if isinstance(value, float):
        # Float literals like 1e999 overflow to inf at parse time.
        if value != value:
            return {"tag": "float", "value": "nan"}
        if value == math.inf:
            return {"tag": "float", "value": "inf"}
        if value == -math.inf:
            return {"tag": "float", "value": "-inf"}
        return value
    if isinstance(value, str):
        return value
    if isinstance(value, bytes):
        return {"tag": "bytes", "base64": base64.b64encode(value).decode("ascii")}
    if isinstance(value, complex):
        return {
            "tag": "complex",
            "real": encode_scalar(value.real),
            "imaginary": encode_scalar(value.imag),
        }
    if value is Ellipsis:
        return {"tag": "ellipsis"}
    raise BridgePayloadError(
        {"kind": "internal", "message": f"unexpected AST scalar type {type(value).__name__}"}
    )


def encode_ast(root, line_texts, line_starts):
    """Serialize the AST iteratively (explicit stack, post-order): a node's JSON needs
    its children complete first, and recursive encoding could exhaust the process
    stack on pathologically deep ASTs (legal Python allows very deep call chains)."""
    pop_marker = object()  # distinct from scalar None, which is a legitimate slot value
    finished = []  # completed JSON values, consumed by their parent in post-order
    work = [("node", root)]
    while work:
        op, payload = work.pop()
        if op == "assemble":
            frame, plan = payload
            # This frame's children are the tail of `finished`, in reverse field/item
            # order (LIFO). Take the tail, restore forward order, consume with a cursor.
            pop_count = sum(1 for _, _, slots in plan for slot in slots if slot is pop_marker)
            children = finished[len(finished) - pop_count :] if pop_count else []
            if pop_count:
                del finished[len(finished) - pop_count :]
            children.reverse()
            cursor = iter(children)
            fields = {}
            for name, shape, slots in plan:
                values = [next(cursor) if slot is pop_marker else slot for slot in slots]
                fields[name] = values[0] if shape == "single" else values
            frame["fields"] = fields
            finished.append(frame)
            continue
        node = payload
        frame = {
            "kind": type(node).__name__,
            "span": node_span(node, line_texts, line_starts),
            "fields": {},
        }
        plan = []  # (field name, "single"|"list", slots; pop_marker = one pop from finished)
        # Assemble must be pushed BEFORE the children: the stack pops LIFO, so the
        # children complete (and land in `finished`) before this frame is assembled.
        work.append(("assemble", (frame, plan)))
        for name in node._fields:
            value = getattr(node, name)
            if isinstance(value, ast.AST):
                plan.append((name, "single", [pop_marker]))
                work.append(("node", value))
            elif isinstance(value, list):
                slots = []
                for item in value:
                    if isinstance(item, ast.AST):
                        slots.append(pop_marker)
                        work.append(("node", item))
                    else:
                        slots.append(encode_scalar(item))
                plan.append((name, "list", slots))
            else:
                plan.append((name, "single", [encode_scalar(value)]))
    return finished.pop()


def encode_tokens(text, line_texts, line_starts):
    tokens = []
    try:
        for tok in tokenize.generate_tokens(io.StringIO(text).readline):
            tokens.append(
                {
                    "kind": token_module.tok_name[tok.type],
                    "text": tok.string,
                    "span": span_from(line_texts, line_starts, tok.start, tok.end),
                }
            )
    except (tokenize.TokenError, IndentationError, SyntaxError, ValueError) as exc:
        # ast accepted the source but the token stream disagrees (rare grammar
        # edges). Keep the parse result and report the gap honestly instead of
        # failing the whole parse.
        diagnostic = {
            "severity": "warning",
            "code": "CTP-TOKENIZE-PARTIAL",
            "message": f"tokenize stopped after {len(tokens)} tokens: {exc}",
            "span": None,
        }
        return tokens, [diagnostic]
    return tokens, []


SYMBOL_FLAG_METHODS = (
    ("isLocal", "is_local"),
    ("isGlobal", "is_global"),
    ("isParameter", "is_parameter"),
    ("isFree", "is_free"),
    ("isImported", "is_imported"),
    ("isAssigned", "is_assigned"),
    ("isReferenced", "is_referenced"),
    ("isDeclaredGlobal", "is_declared_global"),
    ("isNonlocal", "is_nonlocal"),
)


def encode_scope(table):
    symbols = []
    for sym in table.get_symbols():
        symbols.append(
            {
                "name": sym.get_name(),
                "flags": {flag: getattr(sym, method)() for flag, method in SYMBOL_FLAG_METHODS},
            }
        )
    lineno = table.get_lineno()
    return {
        "kind": table.get_type(),
        "name": table.get_name(),
        "line": None if lineno is None or lineno <= 0 else lineno - 1,
        "symbols": symbols,
        "children": [encode_scope(child) for child in table.get_children()],
    }


def encode_module(tree, line_texts, line_starts):
    """Extract import/export-shaped module information (M3 ModuleGraph input).

    Python module specifiers keep their dotted form; relative imports appear with
    their leading dots (".mod", "..pkg.mod") so the resolver can read the level.
    `import a.b` binds a module object -> kind "namespace"; `from m import n` ->
    kind "named" with the imported name; `from m import *` -> namespace with
    importedName "*". importlib/dynamic imports are not tracked here."""
    imports = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                imports.append(
                    {
                        "kind": "namespace",
                        "moduleSpecifier": alias.name,
                        "importedName": None,
                        "localName": alias.asname or alias.name.split(".")[0],
                        "span": node_span(node, line_texts, line_starts),
                    }
                )
        elif isinstance(node, ast.ImportFrom):
            module = node.module or ""
            specifier = "." * node.level + module
            for alias in node.names:
                if alias.name == "*":
                    imports.append(
                        {
                            "kind": "namespace",
                            "moduleSpecifier": specifier,
                            "importedName": "*",
                            "localName": None,
                            "span": node_span(node, line_texts, line_starts),
                        }
                    )
                else:
                    imports.append(
                        {
                            "kind": "named",
                            "moduleSpecifier": specifier,
                            "importedName": alias.name,
                            "localName": alias.asname or alias.name,
                            "span": node_span(node, line_texts, line_starts),
                        }
                    )
    return {
        "hasModuleSyntax": len(imports) > 0,
        "imports": imports,
        "exports": [],
        "dynamicImports": [],
    }


def run_parse(max_source_bytes):
    raw = sys.stdin.buffer.read(max_source_bytes + 1)
    if len(raw) > max_source_bytes:
        raise BridgePayloadError(
            {
                "kind": "limit",
                "message": f"source exceeds the {max_source_bytes} byte limit",
                "limit": "maxSourceBytes",
            }
        )
    try:
        encoding, _bom = tokenize.detect_encoding(io.BytesIO(raw).readline)
    except (SyntaxError, UnicodeDecodeError) as exc:
        raise BridgePayloadError(
            {"kind": "encoding", "message": f"cannot detect source encoding: {exc}"}
        ) from exc
    try:
        text = raw.decode(encoding)
    except (UnicodeDecodeError, LookupError) as exc:
        raise BridgePayloadError(
            {"kind": "encoding", "message": f"cannot decode source as {encoding}: {exc}"}
        ) from exc

    try:
        tree = ast.parse(text, "<source>", "exec")
        scopes = encode_scope(symtable.symtable(text, "<source>", "exec"))
    except SyntaxError as exc:
        if exc.msg == "too many nested parentheses":
            # CPython's parser depth guard has no structured code; classify it as a
            # resource limit, not a user syntax error.
            raise BridgePayloadError(
                {"kind": "limit", "message": str(exc.msg), "limit": "parserDepth"}
            ) from exc
        raise BridgePayloadError(
            {
                "kind": "syntax",
                "message": exc.msg,
                "lineno": exc.lineno,
                "offset": exc.offset,
                "endLineno": exc.end_lineno,
                "endOffset": exc.end_offset,
            }
        ) from exc
    except RecursionError as exc:
        raise BridgePayloadError(
            {"kind": "limit", "message": f"source too complex for the parser: {exc}"}
        ) from exc

    line_texts, line_starts = scan_lines(text)
    tokens, diagnostics = encode_tokens(text, line_texts, line_starts)
    emit(
        {
            "ok": True,
            "header": header(),
            "result": {
                "sourceEncoding": encoding,
                "ast": encode_ast(tree, line_texts, line_starts),
                "tokens": tokens,
                "scopes": scopes,
                "module": encode_module(tree, line_texts, line_starts),
            },
            "diagnostics": diagnostics,
        }
    )


def main():
    try:
        mode, max_source_bytes = parse_args(sys.argv[1:])
    except BridgeUsageError as exc:
        sys.stderr.write(f"bridge usage error: {exc}\n")
        return 2
    try:
        if mode == "handshake":
            emit({"ok": True, "header": header()})
        else:
            run_parse(max_source_bytes)
    except BridgePayloadError as exc:
        emit({"ok": False, "header": header(), "error": exc.payload})
    except Exception as exc:  # last-resort envelope for an unexpected bridge fault
        try:
            emit(
                {
                    "ok": False,
                    "header": header(),
                    "error": {"kind": "internal", "message": f"{type(exc).__name__}: {exc}"},
                }
            )
        except Exception:
            return 3
    return 0


if __name__ == "__main__":
    sys.exit(main())
