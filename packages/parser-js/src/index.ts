// Responsibility (docs/architecture.md §3): JavaScript/TypeScript front-end — oxc
// primary (D-004), Babel fallback behind the same JsParser interface, and the pinned
// typescript@6 semantic oracle (the only compiler-API consumer in the repository).
export const packageName = "@axion-ct/parser-js";

export { BabelJsParser, createBabelJsParser } from "./babel-parser.js";
export { OxcJsParser, createOxcJsParser } from "./oxc-parser.js";
export type { OxcJsParserOptions } from "./oxc-parser.js";
export { createJsParser } from "./select.js";
export type { JsParserSelection } from "./select.js";
export { TypeScriptSemanticOracle } from "./ts-oracle.js";
export { OxcSyntaxValidator, createOxcSyntaxValidator, OracleTypeValidator } from "./validators.js";
export {
  JS_PARSER_INTERNAL,
  JS_PARSER_UNAVAILABLE,
  JS_SOURCE_LIMIT,
  JS_SYNTAX,
  TS_ORACLE_VERSION,
  JsParserInternalError,
  JsParserUnavailableError,
  JsSourceLimitError,
  JsSyntaxError,
  TsOracleVersionError,
} from "./errors.js";
export { ByteOffsetMap } from "./normalize.js";
