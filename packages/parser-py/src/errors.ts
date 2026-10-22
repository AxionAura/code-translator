import { CTransError } from "@axion-ct/core";
import type { SourceSpan } from "@axion-ct/core";

// Machine-readable codes for the Python front-end (AGENTS.md §7). Exported as constants
// so callers (and the fallback selector) can branch on codes without instanceof chains.
export const PY_SYNTAX = "PY-SYNTAX";
export const PY_ENCODING = "PY-ENCODING";
export const PY_SOURCE_LIMIT = "PY-SOURCE-LIMIT";
export const PY_BRIDGE_UNAVAILABLE = "PY-BRIDGE-UNAVAILABLE";
export const PY_RUNTIME_UNSUPPORTED = "PY-RUNTIME-UNSUPPORTED";
export const PY_BRIDGE_PROTOCOL = "PY-BRIDGE-PROTOCOL";
export const PY_BRIDGE_TIMEOUT = "PY-BRIDGE-TIMEOUT";
export const PY_BRIDGE_CRASH = "PY-BRIDGE-CRASH";
export const PY_BRIDGE_RESPONSE = "PY-BRIDGE-RESPONSE";
export const PY_BRIDGE_INTERNAL = "PY-BRIDGE-INTERNAL";
export const PY_TS_PARSE = "PY-TS-PARSE";

export class PythonSyntaxError extends CTransError {
  // Locations in contract units (0-based line, UTF-8 byte column); null when CPython
  // reported none. Byte offsets into the source are derivable via span fields.
  readonly span: SourceSpan | null;

  constructor(message: string, span: SourceSpan | null) {
    super(PY_SYNTAX, message);
    this.span = span;
  }
}

export class PythonEncodingError extends CTransError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(PY_ENCODING, message, options);
  }
}

export class PythonSourceLimitError extends CTransError {
  // Which limit fired: "maxSourceBytes" or "parserDepth".
  readonly limit: string;

  constructor(message: string, limit: string) {
    super(PY_SOURCE_LIMIT, message);
    this.limit = limit;
  }
}

export class PythonBridgeUnavailableError extends CTransError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(PY_BRIDGE_UNAVAILABLE, message, options);
  }
}

export class PythonRuntimeUnsupportedError extends CTransError {
  constructor(message: string) {
    super(PY_RUNTIME_UNSUPPORTED, message);
  }
}

export class PythonBridgeProtocolError extends CTransError {
  constructor(message: string) {
    super(PY_BRIDGE_PROTOCOL, message);
  }
}

export class PythonBridgeTimeoutError extends CTransError {
  constructor(message: string) {
    super(PY_BRIDGE_TIMEOUT, message);
  }
}

export class PythonBridgeCrashError extends CTransError {
  readonly exitCode: number | null;
  readonly stderrTail: string;

  constructor(message: string, exitCode: number | null, stderrTail: string) {
    super(PY_BRIDGE_CRASH, message);
    this.exitCode = exitCode;
    this.stderrTail = stderrTail;
  }
}

export class PythonBridgeResponseError extends CTransError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(PY_BRIDGE_RESPONSE, message, options);
  }
}

export class PythonBridgeInternalError extends CTransError {
  constructor(message: string) {
    super(PY_BRIDGE_INTERNAL, message);
  }
}

export class TreeSitterParseError extends CTransError {
  constructor(message: string) {
    super(PY_TS_PARSE, message);
  }
}
