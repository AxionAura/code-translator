// Responsibility (docs/architecture.md §3): Python front-end — CPython bridge
// (ast/symtable/tokenize via a subprocess, D-003/D-018) with a tree-sitter fallback
// behind the same @ctrans/core PythonParser interface.
export const packageName = "@ctrans/parser-py";

export { PythonBridgeParser, createPythonBridgeParser } from "./client.js";
export type { PythonBridgeParserOptions } from "./client.js";
export { TreeSitterPythonParser, createTreeSitterPythonParser } from "./fallback.js";
export { createPythonParser } from "./select.js";
export type { PythonParserSelection } from "./select.js";
export {
  PY_BRIDGE_CRASH,
  PY_BRIDGE_INTERNAL,
  PY_BRIDGE_PROTOCOL,
  PY_BRIDGE_RESPONSE,
  PY_BRIDGE_TIMEOUT,
  PY_BRIDGE_UNAVAILABLE,
  PY_ENCODING,
  PY_RUNTIME_UNSUPPORTED,
  PY_SOURCE_LIMIT,
  PY_SYNTAX,
  PY_TS_PARSE,
  PythonBridgeCrashError,
  PythonBridgeInternalError,
  PythonBridgeProtocolError,
  PythonBridgeResponseError,
  PythonBridgeTimeoutError,
  PythonBridgeUnavailableError,
  PythonEncodingError,
  PythonRuntimeUnsupportedError,
  PythonSourceLimitError,
  PythonSyntaxError,
  TreeSitterParseError,
} from "./errors.js";
export { BRIDGE_PROTOCOL_VERSION } from "./protocol.js";
