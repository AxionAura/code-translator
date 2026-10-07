// Babel fallback front-end (D-004): @babel/parser behind the same JsParser contract.
// Used only when oxc cannot load (selection policy in select.ts); the downgrade is
// recorded in result metadata. Babel reports UTF-16 indices, attaches comments to
// `ast.comments`, and — under errorRecovery — returns recoverable errors on the File
// node; unrecoverable failures throw and map to JsSyntaxError.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type {
  Diagnostic,
  JsParser,
  JsParseOptions,
  ParseResult,
  ParserDescription,
} from "@ctrans/core";
import { scanSourceLines } from "@ctrans/core";
import { JsParserInternalError, JsParserUnavailableError, JsSyntaxError } from "./errors.js";
import { extractModuleInfo } from "./module-info.js";
import { ByteOffsetMap, convertProgram, toSpan } from "./normalize.js";

type BabelModule = typeof import("@babel/parser");

interface BabelErrorLike {
  readonly message: string;
  readonly loc?: { readonly index?: number } | null;
}

export class BabelJsParser implements JsParser {
  private constructor(
    private readonly babel: BabelModule,
    private readonly version: string,
  ) {}

  static async create(): Promise<BabelJsParser> {
    let babel: BabelModule;
    try {
      babel = await import("@babel/parser");
    } catch (error) {
      throw new JsParserUnavailableError("@babel/parser could not be loaded", { cause: error });
    }
    const version = packageVersion();
    return new BabelJsParser(babel, version);
  }

  async describe(): Promise<ParserDescription> {
    return {
      id: "babel",
      available: true,
      runtimeVersion: null,
      protocolVersion: null,
      unavailableReason: null,
    };
  }

  async parse(source: string, options: JsParseOptions): Promise<ParseResult> {
    const lines = scanSourceLines(source);
    const converter = new ByteOffsetMap(source);
    let file: ReturnType<BabelModule["parse"]>;
    try {
      // Babel 8 accepts bundled string plugin names at runtime (verified against
      // 8.0.6) but its shipped types only model plugin objects — one documented
      // assertion at this boundary.
      const parseOptions = {
        sourceType: "module",
        errorRecovery: true,
        plugins: pluginsFor(options),
      } as unknown as Parameters<BabelModule["parse"]>[1];
      file = this.babel.parse(source, parseOptions);
    } catch (error) {
      const babelError = error as BabelErrorLike;
      const index = babelError.loc?.index;
      throw new JsSyntaxError(
        babelError.message,
        typeof index === "number" ? toSpan(converter, lines, index, index) : null,
      );
    }
    if (file === null) {
      throw new JsParserInternalError("@babel/parser returned null");
    }
    const errors = (file as unknown as { errors?: readonly BabelErrorLike[] }).errors ?? [];
    const ast = convertProgram(file.program, converter, lines);
    return {
      language: options.language,
      filename: options.filename ?? "<source>",
      parser: { id: "babel", fidelity: "full", parserVersion: this.version, runtimeVersion: null },
      ast,
      tokens: [], // JS front-ends emit comments only (D-019); provenance derives from the AST
      comments: (file.comments ?? []).map((comment) => {
        const start = comment.start ?? 0;
        const end = comment.end ?? 0;
        return {
          kind: "COMMENT",
          text: source.slice(converter.toByte(start), converter.toByte(end)),
          span: toSpan(converter, lines, start, end),
        };
      }),
      module: extractModuleInfo(ast),
      scopes: null, // JS scope analysis lands with the M3 semantic layer
      diagnostics: errors.map((babelError) => babelDiagnostic(babelError, converter, lines)),
    };
  }
}

function pluginsFor(options: JsParseOptions): string[] {
  if (options.language === "typescript") {
    return options.jsx === true ? ["typescript", "jsx"] : ["typescript"];
  }
  return options.jsx === true ? ["jsx"] : [];
}

function babelDiagnostic(
  error: BabelErrorLike,
  converter: ByteOffsetMap,
  lines: ReturnType<typeof scanSourceLines>,
): Diagnostic {
  const index = error.loc?.index;
  return {
    severity: "error",
    code: "JS-PARSE",
    message: error.message,
    span: typeof index === "number" ? toSpan(converter, lines, index, index) : null,
  };
}

function packageVersion(): string {
  try {
    const manifestPath = createRequire(import.meta.url).resolve("@babel/parser/package.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { version?: string };
    return manifest.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

export async function createBabelJsParser(): Promise<BabelJsParser> {
  return BabelJsParser.create();
}
