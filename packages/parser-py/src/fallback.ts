// Documented fallback front-end (D-003): web-tree-sitter with the tree-sitter-python
// grammar. Produces a concrete-syntax-tree-shaped AstNode ("children" fields, not
// CPython field names) and a leaf token stream, but no scope analysis — results are
// marked fidelity "degraded" and consumers that need semantic information must check
// parser.id / parser.fidelity instead of assuming.
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type {
  AstNode,
  Diagnostic,
  ParseResult,
  ParserDescription,
  PythonParseOptions,
  PythonParser,
  SourceSpan,
  TokenInfo,
} from "@ctrans/core";
import { TreeSitterParseError } from "./errors.js";
import { byteColumn, scanSourceLines } from "@ctrans/core";

type WebTreeSitter = typeof import("web-tree-sitter");
type TSParser = InstanceType<WebTreeSitter["Parser"]>;
type TSTree = NonNullable<ReturnType<TSParser["parse"]>>;
type TSNode = TSTree["rootNode"];

const POP_MARKER = Symbol("ctrans.pop");

export class TreeSitterPythonParser implements PythonParser {
  private initPromise: Promise<void> | null = null;
  private initFailure: string | null = null;
  private parser: TSParser | null = null;
  private grammarVersion: string | null = null;

  private async ensureInitialized(): Promise<void> {
    if (this.parser !== null) return;
    if (this.initPromise === null) {
      this.initPromise = this.initialize().catch((error: unknown) => {
        this.initFailure = error instanceof Error ? error.message : String(error);
        throw error;
      });
    }
    await this.initPromise;
  }

  private async initialize(): Promise<void> {
    const require = createRequire(import.meta.url);
    const grammarPackagePath = require.resolve("tree-sitter-python/package.json");
    const grammarPackage = JSON.parse(await readFile(grammarPackagePath, "utf8")) as {
      version: string;
    };
    const grammarWasm = await readFile(
      join(dirname(grammarPackagePath), "tree-sitter-python.wasm"),
    );
    const treeSitter: WebTreeSitter = await import("web-tree-sitter");
    await treeSitter.Parser.init();
    const language = await treeSitter.Language.load(grammarWasm);
    const parser = new treeSitter.Parser();
    parser.setLanguage(language);
    this.parser = parser;
    this.grammarVersion = grammarPackage.version;
  }

  async describe(): Promise<ParserDescription> {
    try {
      await this.ensureInitialized();
      return {
        id: "tree-sitter",
        available: true,
        runtimeVersion: null,
        protocolVersion: null,
        unavailableReason: null,
      };
    } catch (error) {
      return {
        id: "tree-sitter",
        available: false,
        runtimeVersion: null,
        protocolVersion: null,
        unavailableReason:
          this.initFailure ?? (error instanceof Error ? error.message : String(error)),
      };
    }
  }

  async parse(source: string, options?: PythonParseOptions): Promise<ParseResult> {
    await this.ensureInitialized();
    const parser = this.parser;
    if (parser === null || this.grammarVersion === null) {
      throw new TreeSitterParseError("tree-sitter parser is not initialized");
    }
    const tree = parser.parse(source);
    if (tree === null) {
      throw new TreeSitterParseError("tree-sitter failed to produce a syntax tree");
    }
    const lines = scanSourceLines(source);
    const { ast, tokens } = convertTree(tree.rootNode, source, lines);
    const diagnostics: Diagnostic[] = [
      {
        severity: "info",
        code: "CTP-TS-DEGRADED",
        message: "tree-sitter fallback: CST-shaped AST, no scope analysis",
        span: null,
      },
    ];
    if (tree.rootNode.hasError) {
      diagnostics.push({
        severity: "warning",
        code: "CTP-TS-SYNTAX-RECOVERY",
        message: "tree-sitter recovered from syntax errors; the tree may be incomplete",
        span: null,
      });
    }
    return {
      language: "python",
      filename: options?.filename ?? "<source>",
      parser: {
        id: "tree-sitter",
        fidelity: "degraded",
        parserVersion: this.grammarVersion,
        runtimeVersion: null,
      },
      ast,
      tokens,
      comments: tokens.filter((token) => token.kind === "comment"),
      module: null, // JS-style module info does not apply to Python sources
      scopes: null,
      diagnostics,
    };
  }
}

function toSpan(
  source: string,
  lines: ReturnType<typeof scanSourceLines>,
  node: TSNode,
): SourceSpan {
  const startLine = node.startPosition.row;
  const endLine = node.endPosition.row;
  const startText = lines.lineTexts[startLine] ?? "";
  const endText = lines.lineTexts[endLine] ?? "";
  const startBase = lines.lineStarts[startLine] ?? 0;
  const endBase = lines.lineStarts[endLine] ?? 0;
  // tree-sitter reports code-point columns and UTF-16 indices; convert both to bytes.
  const startColumn = byteColumn(startText, node.startPosition.column);
  const endColumn = byteColumn(endText, node.endPosition.column);
  return {
    start: { line: startLine, column: startColumn },
    end: { line: endLine, column: endColumn },
    startByteOffset: startBase + startColumn,
    endByteOffset: endBase + endColumn,
  };
}

// Iterative post-order conversion (same stack pattern as the bridge encoder): CST depth
// is attacker-influenced, so no recursion.
function convertTree(
  root: TSNode,
  source: string,
  lines: ReturnType<typeof scanSourceLines>,
): { ast: AstNode; tokens: TokenInfo[] } {
  const tokens: TokenInfo[] = [];
  const finished: AstNode[] = [];
  type AssembleFrame = { kind: string; span: SourceSpan; plan: Array<symbol> };
  type Entry = { readonly visit: TSNode } | { readonly assemble: AssembleFrame };
  const stack: Entry[] = [{ visit: root }];
  while (stack.length > 0) {
    const entry = stack.pop()!;
    if ("assemble" in entry) {
      const children = entry.assemble.plan.map(() => finished.pop()!);
      children.reverse();
      finished.push({
        kind: entry.assemble.kind,
        span: entry.assemble.span,
        fields: { children },
      });
      continue;
    }
    const node = entry.visit;
    const span = toSpan(source, lines, node);
    if (node.childCount === 0) {
      tokens.push({ kind: node.type, text: node.text, span });
      finished.push({ kind: node.type, span, fields: { text: node.text } });
      continue;
    }
    const plan: Array<symbol> = [];
    const frame: AssembleFrame = { kind: node.type, span, plan };
    stack.push({ assemble: frame });
    for (let i = node.namedChildCount - 1; i >= 0; i -= 1) {
      const child = node.namedChild(i);
      if (child === null) continue;
      plan.push(POP_MARKER);
      stack.push({ visit: child });
    }
  }
  if (finished.length !== 1) {
    throw new TreeSitterParseError("tree-sitter conversion did not yield a single root node");
  }
  return { ast: finished[0]!, tokens };
}

export async function createTreeSitterPythonParser(): Promise<TreeSitterPythonParser> {
  const parser = new TreeSitterPythonParser();
  await parser.describe(); // fail fast on a broken grammar installation
  return parser;
}
