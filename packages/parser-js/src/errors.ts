import { CTransError } from "@axion-ct/core";
import type { SourceSpan } from "@axion-ct/core";

export const JS_SYNTAX = "JS-SYNTAX";
export const JS_SOURCE_LIMIT = "JS-SOURCE-LIMIT";
export const JS_PARSER_UNAVAILABLE = "JS-PARSER-UNAVAILABLE";
export const JS_PARSER_INTERNAL = "JS-PARSER-INTERNAL";
export const TS_ORACLE_VERSION = "TS-ORACLE-VERSION";

export class JsSyntaxError extends CTransError {
  // Contract span (UTF-8 byte offsets) of the failure, null when the parser reported none.
  readonly span: SourceSpan | null;

  constructor(message: string, span: SourceSpan | null) {
    super(JS_SYNTAX, message);
    this.span = span;
  }
}

export class JsParserUnavailableError extends CTransError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(JS_PARSER_UNAVAILABLE, message, options);
  }
}

export class JsSourceLimitError extends CTransError {
  constructor(message: string) {
    super(JS_SOURCE_LIMIT, message);
  }
}

export class JsParserInternalError extends CTransError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(JS_PARSER_INTERNAL, message, options);
  }
}

export class TsOracleVersionError extends CTransError {
  constructor(message: string) {
    super(TS_ORACLE_VERSION, message);
  }
}
