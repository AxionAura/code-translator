// Selection policy for the JS/TS front-end (D-004): oxc is primary; Babel is used only
// when explicitly allowed and oxc cannot be loaded. The selected parser is always
// visible in result metadata (parser.id), so this is a recorded downgrade, never a
// silent switch.
import type { CTransError, JsParser } from "@ctrans/core";
import { BabelJsParser } from "./babel-parser.js";
import { JS_PARSER_UNAVAILABLE } from "./errors.js";
import { OxcJsParser } from "./oxc-parser.js";

export interface JsParserSelection {
  // Default false: an unusable primary parser is a hard error unless the caller opts in.
  readonly allowFallback?: boolean;
}

export async function createJsParser(options: JsParserSelection = {}): Promise<JsParser> {
  try {
    return await OxcJsParser.create();
  } catch (error) {
    const eligible =
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as CTransError).code === JS_PARSER_UNAVAILABLE;
    if (!options.allowFallback || !eligible) {
      throw error;
    }
    return BabelJsParser.create();
  }
}
