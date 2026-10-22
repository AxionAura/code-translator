// TypeScript semantic oracle (D-004, roadmap M2): the ONLY place in the repository
// allowed to touch the TypeScript compiler API. TypeScript 7.0 ships no JavaScript API
// (verified 2026-10-06), so this adapter pins the 6.x line, refuses anything else at
// construction time, and exposes plain-data queries (docs/decisions.md D-004) that the
// future TypeScript 7.1+ API can replace behind the same core interface.
import * as ts from "typescript";
import type {
  SourceLines,
  SourceSpan,
  TsDiagnostic,
  TsExportKind,
  TsExportSummary,
  TsModuleSummary,
  TsModuleSummaryQuery,
  TsOracleSourceFile,
  TsTypeAtQuery,
  TsTypeSummary,
} from "@axion-ct/core";
import { lineIndexOf, scanSourceLines } from "@axion-ct/core";
import { TsOracleVersionError } from "./errors.js";
import { ByteOffsetMap } from "./normalize.js";

// Numeric bit-flag enums (ts.SymbolFlags, ts.TypeFlags) -> flag names.
function flagNames(table: Record<string, unknown>, value: number): string[] {
  const names: string[] = [];
  for (const [name, flag] of Object.entries(table)) {
    if (typeof flag === "number" && flag !== 0 && (value & flag) === flag) {
      names.push(name);
    }
  }
  return names;
}

function exportKindOf(symbolFlags: number): TsExportKind {
  const typeMask = ts.SymbolFlags.Interface | ts.SymbolFlags.TypeAlias | ts.SymbolFlags.Enum;
  const namespaceMask = ts.SymbolFlags.Namespace | ts.SymbolFlags.Module;
  const valueMask =
    ts.SymbolFlags.Function |
    ts.SymbolFlags.Class |
    ts.SymbolFlags.Variable |
    ts.SymbolFlags.Property |
    ts.SymbolFlags.EnumMember |
    ts.SymbolFlags.Accessor;
  if ((symbolFlags & typeMask) !== 0) return "type";
  if ((symbolFlags & namespaceMask) !== 0) return "namespace";
  if ((symbolFlags & valueMask) !== 0) return "value";
  return "other";
}

interface FileContext {
  readonly source: string;
  readonly lines: SourceLines;
  readonly converter: ByteOffsetMap;
}

// UTF-8 byte offset -> UTF-16 index (the inverse of ByteOffsetMap, needed for
// compiler positions). Linear scan; queries are per-call and inputs are capped.
function utf16IndexForByteOffset(source: string, byteOffset: number): number {
  let byte = 0;
  let index = 0;
  for (const ch of source) {
    if (byte >= byteOffset) return index;
    byte += Buffer.byteLength(ch, "utf8");
    index += ch.length;
  }
  return index;
}

export class TypeScriptSemanticOracle {
  constructor() {
    // TypeScript 7.0 (native port) ships no JavaScript API; refuse it loudly instead
    // of failing obscurely deep inside the compiler (docs/research.md §1).
    if (!ts.version.startsWith("6.")) {
      throw new TsOracleVersionError(
        `the TypeScript semantic oracle requires the 6.x compiler API; found ${ts.version}`,
      );
    }
  }

  summarizeModule(query: TsModuleSummaryQuery): TsModuleSummary {
    const { program, contexts, toVirtual } = buildProgram(query.files);
    const sourceFile = program.getSourceFile(absoluteSourceName(query.filename));
    if (sourceFile === undefined) {
      throw new Error(`oracle input does not contain "${query.filename}"`);
    }
    const checker = program.getTypeChecker();
    const diagnostics = ts
      .getPreEmitDiagnostics(program, sourceFile)
      .map((diagnostic) => toDiagnostic(diagnostic, contexts, toVirtual));
    // TS 6 exposes no SourceFile.symbol on its public surface; the module symbol is
    // reachable through the checker for module files and undefined for scripts.
    const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
    const exports: TsExportSummary[] = [];
    if (moduleSymbol !== undefined && (moduleSymbol.flags & ts.SymbolFlags.Module) !== 0) {
      for (const exported of checker.getExportsOfModule(moduleSymbol)) {
        exports.push(toExportSummary(checker, exported, contexts, toVirtual));
      }
    } else if (moduleSymbol?.exports !== undefined) {
      for (const exported of moduleSymbol.exports.values()) {
        exports.push(toExportSummary(checker, exported, contexts, toVirtual));
      }
    }
    return { filename: query.filename, diagnostics, exports };
  }

  typeAt(query: TsTypeAtQuery): TsTypeSummary | null {
    const { program, contexts } = buildProgram(query.files);
    const sourceFile = program.getSourceFile(absoluteSourceName(query.filename));
    const context = contexts.get(normalizeName(query.filename));
    if (sourceFile === undefined || context === undefined) {
      throw new Error(`oracle input does not contain "${query.filename}"`);
    }
    const position = utf16IndexForByteOffset(context.source, query.byteOffset);
    const checker = program.getTypeChecker();
    const type = checker.getTypeAtLocation(tokenAtPosition(sourceFile, position));
    return {
      display: checker.typeToString(type, undefined, ts.TypeFormatFlags.NoTruncation),
      flags: flagNames(ts.TypeFlags as unknown as Record<string, unknown>, type.flags),
    };
  }
}

// TS 6 dropped getTokenAtPosition from its public surface; the deepest node containing
// the position is the same query target for type purposes.
function tokenAtPosition(sourceFile: ts.SourceFile, position: number): ts.Node {
  let current: ts.Node = sourceFile;
  descend: for (;;) {
    for (const child of current.getChildren(sourceFile)) {
      if (position >= child.getStart(sourceFile) && position < child.getEnd()) {
        current = child;
        continue descend;
      }
    }
    return current;
  }
}

function normalizeName(filename: string): string {
  // The compiler host normalizes path separators; keys must match its behavior.
  return filename.replaceAll("\\", "/");
}

function buildProgram(files: readonly TsOracleSourceFile[]): {
  program: ts.Program;
  contexts: Map<string, FileContext>;
  toVirtual: (name: string) => string | null;
} {
  const contexts = new Map<string, FileContext>();
  for (const file of files) {
    contexts.set(normalizeName(file.filename), {
      source: file.source,
      lines: scanSourceLines(file.source),
      converter: new ByteOffsetMap(file.source),
    });
  }
  const compilerOptions: ts.CompilerOptions = {
    strict: true,
    noEmit: true,
    allowImportingTsExtensions: true,
    allowJs: true,
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    skipLibCheck: true,
    types: [],
  };
  const baseHost = ts.createCompilerHost(compilerOptions, /*setParentNodes*/ true);
  const virtualLookup = (name: string): string | null => {
    const normalized = normalizeName(name);
    if (contexts.has(normalized)) return normalized;
    const stripped = normalized.startsWith(VIRTUAL_ROOT)
      ? normalized.slice(VIRTUAL_ROOT.length).replace(/^\//, "")
      : null;
    return stripped !== null && contexts.has(stripped) ? stripped : null;
  };
  const host: ts.CompilerHost = {
    ...baseHost,
    getSourceFile: (name, languageVersion, onError, shouldCreate) => {
      const virtualKey = virtualLookup(name);
      if (virtualKey !== null) {
        // Virtual files are parsed fresh; lib declarations load from the pinned
        // typescript package on disk (our own dependency, never user code).
        return ts.createSourceFile(name, contexts.get(virtualKey)!.source, languageVersion, true);
      }
      return baseHost.getSourceFile(name, languageVersion, onError, shouldCreate);
    },
    fileExists: (name) => virtualLookup(name) !== null || baseHost.fileExists(name),
    readFile: (name) => {
      const virtualKey = virtualLookup(name);
      if (virtualKey !== null) return contexts.get(virtualKey)!.source;
      return baseHost.readFile(name);
    },
    directoryExists: (name) => {
      const normalized = normalizeName(name).replace(/\/$/, "");
      if (normalized === VIRTUAL_ROOT || normalized.startsWith(`${VIRTUAL_ROOT}/`)) {
        const stripped = normalized.slice(VIRTUAL_ROOT.length).replace(/^\//, "");
        if (stripped === "") return true; // the virtual workspace root itself
        return [...contexts.keys()].some((key) => key.startsWith(`${stripped}/`));
      }
      return baseHost.directoryExists?.(name) ?? false;
    },
    // The standard resolver verifies paths through realpath; keep virtual files
    // resolvable by mapping them onto the synthetic root namespace.
    realpath: (name) => {
      const virtualKey = virtualLookup(name);
      return virtualKey !== null ? `${VIRTUAL_ROOT}/${virtualKey}` : name;
    },
    writeFile: () => {},
  };
  const program = ts.createProgram(
    files.map((file) => absoluteName(file.filename)),
    compilerOptions,
    host,
  );
  return { program, contexts, toVirtual: virtualLookup };
}

// Absolute synthetic namespace for virtual files (module resolution operates on
// absolute paths; project-relative names are treated as being below this root).
const VIRTUAL_ROOT = "/__ctrans_virtual_workspace";

function absoluteName(filename: string): string {
  return `${VIRTUAL_ROOT}/${normalizeName(filename)}`;
}

// Absolute form of a project-relative virtual name (program root names must be
// absolute for the standard resolver to combine containing directories).
function absoluteSourceName(filename: string): string {
  return absoluteName(filename);
}

function toDiagnostic(
  diagnostic: ts.Diagnostic,
  contexts: Map<string, FileContext>,
  toVirtual: (name: string) => string | null,
): TsDiagnostic {
  let span: SourceSpan | null = null;
  if (diagnostic.file !== undefined && typeof diagnostic.start === "number") {
    const context = contexts.get(toVirtual(diagnostic.file.fileName) ?? "");
    if (context !== undefined) {
      const start = context.converter.toByte(diagnostic.start);
      const end = context.converter.toByte(
        typeof diagnostic.length === "number"
          ? diagnostic.start + diagnostic.length
          : diagnostic.start,
      );
      const startLine = lineIndexOf(context.lines.lineStarts, start);
      const endLine = lineIndexOf(context.lines.lineStarts, end);
      span = {
        start: { line: startLine, column: start - (context.lines.lineStarts[startLine] ?? 0) },
        end: { line: endLine, column: end - (context.lines.lineStarts[endLine] ?? 0) },
        startByteOffset: start,
        endByteOffset: end,
      };
    }
  }
  return {
    severity:
      diagnostic.category === ts.DiagnosticCategory.Error
        ? "error"
        : diagnostic.category === ts.DiagnosticCategory.Warning
          ? "warning"
          : diagnostic.category === ts.DiagnosticCategory.Suggestion
            ? "suggestion"
            : "message",
    code: diagnostic.code,
    message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
    span,
  };
}

function toExportSummary(
  checker: ts.TypeChecker,
  symbol: ts.Symbol,
  contexts: Map<string, FileContext>,
  toVirtual: (name: string) => string | null,
): TsExportSummary {
  const declaration = symbol.declarations?.[0];
  let type: TsTypeSummary | null = null;
  if (declaration !== undefined) {
    try {
      // Type-namespace symbols (interfaces, aliases) need their DECLARED type; the
      // type-at-declaration of an interface is `any`. Values use the declaration site.
      const symbolType =
        exportKindOf(symbol.flags) === "type"
          ? checker.getDeclaredTypeOfSymbol(symbol)
          : checker.getTypeOfSymbolAtLocation(symbol, declaration);
      type = {
        display: checker.typeToString(symbolType, undefined, ts.TypeFormatFlags.NoTruncation),
        flags: flagNames(ts.TypeFlags as unknown as Record<string, unknown>, symbolType.flags),
      };
    } catch {
      // Some compiler-generated symbols have no meaningful type; that is data, not a
      // failure.
      type = null;
    }
  }
  return {
    name: symbol.getName(),
    symbolFlags: flagNames(ts.SymbolFlags as unknown as Record<string, unknown>, symbol.flags),
    type,
    exportKind: exportKindOf(symbol.flags),
    declarations: declarationSpans(symbol, contexts, toVirtual),
  };
}

function declarationSpans(
  symbol: ts.Symbol,
  contexts: Map<string, FileContext>,
  toVirtual: (name: string) => string | null,
): SourceSpan[] {
  const spans: SourceSpan[] = [];
  for (const declaration of symbol.declarations ?? []) {
    const context = contexts.get(toVirtual(declaration.getSourceFile().fileName) ?? "");
    if (context === undefined) continue; // declarations in lib files are not ours to span
    const start = context.converter.toByte(declaration.getStart());
    const end = context.converter.toByte(declaration.getEnd());
    const startLine = lineIndexOf(context.lines.lineStarts, start);
    const endLine = lineIndexOf(context.lines.lineStarts, end);
    spans.push({
      start: { line: startLine, column: start - (context.lines.lineStarts[startLine] ?? 0) },
      end: { line: endLine, column: end - (context.lines.lineStarts[endLine] ?? 0) },
      startByteOffset: start,
      endByteOffset: end,
    });
  }
  return spans;
}
