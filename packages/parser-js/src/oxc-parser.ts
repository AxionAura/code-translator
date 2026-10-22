// Primary JS/TS front-end (D-004): oxc-parser behind the core JsParser contract.
// oxc emits ESTree-shaped trees with UTF-16 indices; normalization to the byte-grid
// contract happens in normalize.ts. Error recovery is preserved: recovered trees carry
// error-severity diagnostics and are never presented as clean parses. Grammar mode is
// selected deterministically from the requested language/jsx flags via a synthetic
// in-memory filename — the caller's filename label never changes parsing behavior.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type {
  Diagnostic,
  JsParser,
  JsParseOptions,
  ParseResult,
  ParserDescription,
} from "@axion-ct/core";
import { scanSourceLines } from "@axion-ct/core";
import { BabelJsParser } from "./babel-parser.js";
import {
  JsParserInternalError,
  JsParserUnavailableError,
  JsSourceLimitError,
  JsSyntaxError,
} from "./errors.js";
import { extractModuleInfo } from "./module-info.js";
import { MAX_SAFE_NESTING_DEPTH, maxAstDepth, maxBracketDepth } from "./safety.js";
import { ByteOffsetMap, convertProgram, toSpan } from "./normalize.js";

const DEFAULT_MAX_SOURCE_BYTES = 5 * 1024 * 1024;

export interface OxcJsParserOptions {
  readonly maxSourceBytes?: number;
}

type OxcModule = typeof import("oxc-parser");

interface OxcError {
  readonly severity: string;
  readonly message: string;
  readonly labels?: ReadonlyArray<{
    readonly start: number;
    readonly end: number;
    readonly message: string | null;
  }>;
}

export class OxcJsParser implements JsParser {
  private readonly oxc: OxcModule;
  private readonly version: string;
  private readonly maxSourceBytes: number;
  private probeParser: BabelJsParser | null = null;

  private constructor(oxc: OxcModule, version: string, maxSourceBytes: number) {
    this.oxc = oxc;
    this.version = version;
    this.maxSourceBytes = maxSourceBytes;
  }

  static async create(options: OxcJsParserOptions = {}): Promise<OxcJsParser> {
    let oxc: OxcModule;
    try {
      oxc = await import("oxc-parser");
    } catch (error) {
      throw new JsParserUnavailableError("oxc-parser could not be loaded", { cause: error });
    }
    const version = packageVersion("oxc-parser");
    return new OxcJsParser(oxc, version, options.maxSourceBytes ?? DEFAULT_MAX_SOURCE_BYTES);
  }
  async describe(): Promise<ParserDescription> {
    return {
      id: "oxc",
      available: true,
      runtimeVersion: null,
      protocolVersion: null,
      unavailableReason: null,
    };
  }

  private async ensureProbeParser(): Promise<void> {
    if (this.probeParser === null) {
      this.probeParser = await BabelJsParser.create();
    }
  }

  async parse(source: string, options: JsParseOptions): Promise<ParseResult> {
    if (Buffer.byteLength(source, "utf8") > this.maxSourceBytes) {
      throw new JsSourceLimitError(`source exceeds the ${String(this.maxSourceBytes)} byte limit`);
    }
    // Native-crash containment (ADR D-020): oxc segfaults on deeply nested sources,
    // so flag suspicious inputs and measure their exact depth via the pure-JS Babel
    // parser before letting the native layer anywhere near them.
    if (maxBracketDepth(source) > MAX_SAFE_NESTING_DEPTH) {
      await this.ensureProbeParser();
      try {
        const probeResult = await this.probeParser!.parse(source, options);
        const depth = maxAstDepth(probeResult.ast);
        if (depth > MAX_SAFE_NESTING_DEPTH) {
          throw new JsSourceLimitError(
            `source nesting (${String(depth)} levels) exceeds the supported limit of ${String(MAX_SAFE_NESTING_DEPTH)}`,
          );
        }
      } catch (error) {
        if (error instanceof JsSourceLimitError || error instanceof JsSyntaxError) throw error;
        if (error instanceof RangeError) {
          throw new JsSourceLimitError(
            "source nesting exceeds the supported limit (the parser ran out of stack measuring it)",
          );
        }
        throw error;
      }
    }
    const lines = scanSourceLines(source);
    const converter = new ByteOffsetMap(source);
    let raw: ReturnType<OxcModule["parseSync"]>;
    try {
      raw = this.oxc.parseSync(virtualFilename(options), source, {});
    } catch (error) {
      // With error recovery this should not happen; a native-layer crash must not
      // take the host down silently.
      throw new JsParserInternalError(
        `oxc-parser threw during parse: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    const ast = convertProgram(raw.program, converter, lines);
    return {
      language: options.language,
      filename: options.filename ?? "<source>",
      parser: { id: "oxc", fidelity: "full", parserVersion: this.version, runtimeVersion: null },
      ast,
      tokens: [], // JS front-ends emit comments only (D-019); provenance derives from the AST
      comments: raw.comments.map((comment) => ({
        kind: "COMMENT",
        text: source.slice(converter.toByte(comment.start), converter.toByte(comment.end)),
        span: toSpan(converter, lines, comment.start, comment.end),
      })),
      module: extractModuleInfo(ast),
      scopes: null, // JS scope analysis lands with the M3 semantic layer
      diagnostics: raw.errors.map((error) => oxcDiagnostic(error, converter, lines)),
    };
  }
}

// Grammar selection is driven by a synthetic extension so the caller's filename label
// can never change parsing behavior.
function virtualFilename(options: JsParseOptions): string {
  const extension =
    options.language === "typescript"
      ? options.jsx === true
        ? "tsx"
        : "ts"
      : options.jsx === true
        ? "jsx"
        : "js";
  return `<source>.${extension}`;
}

function oxcDiagnostic(
  error: OxcError,
  converter: ByteOffsetMap,
  lines: ReturnType<typeof scanSourceLines>,
): Diagnostic {
  const label = error.labels?.[0];
  const labelNote = label?.message === null || label === undefined ? null : label.message;
  return {
    severity:
      error.severity === "Error" ? "error" : error.severity === "Warning" ? "warning" : "info",
    code: "JS-PARSE",
    message: labelNote === null ? error.message : `${error.message} (${labelNote})`,
    span: label === undefined ? null : toSpan(converter, lines, label.start, label.end),
  };
}

function packageVersion(name: string): string {
  try {
    const manifestPath = createRequire(import.meta.url).resolve(`${name}/package.json`);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { version?: string };
    return manifest.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

export async function createOxcJsParser(options: OxcJsParserOptions = {}): Promise<OxcJsParser> {
  return OxcJsParser.create(options);
}
