// Cross-frontend parser contract: every front-end (Python bridge, tree-sitter
// fallback, oxc, Babel) must satisfy the same structural invariants of the
// @axion-ct/core ParseResult — without flattening language-specific ASTs (D-002).
import { beforeAll, describe, expect, it } from "vitest";
import type { AstNode, ParseResult, SourceSpan } from "@axion-ct/core";
import { scanSourceLines } from "@axion-ct/core";
import { createPythonBridgeParser, type PythonBridgeParser } from "@axion-ct/parser-py";
import { createOxcJsParser, type OxcJsParser } from "@axion-ct/parser-js";
import { createBabelJsParser, type BabelJsParser } from "@axion-ct/parser-js";
import { createTreeSitterPythonParser, type TreeSitterPythonParser } from "@axion-ct/parser-py";

let pythonBridge: PythonBridgeParser;
let treeSitter: TreeSitterPythonParser;
let oxc: OxcJsParser;
let babel: BabelJsParser;

beforeAll(async () => {
  pythonBridge = await createPythonBridgeParser();
  treeSitter = await createTreeSitterPythonParser();
  oxc = await createOxcJsParser();
  babel = await createBabelJsParser();
});

interface Case {
  readonly name: string;
  readonly source: string;
  readonly parse: () => Promise<ParseResult>;
}

const CASES: Case[] = [
  {
    name: "cpython-bridge",
    source: "import os\n# note\ndef f(x):\n    return f'{x} é'\n",
    parse: () => pythonBridge.parse("import os\n# note\ndef f(x):\n    return f'{x} é'\n"),
  },
  {
    name: "tree-sitter",
    source: "import os\n# note\ndef f(x):\n    return f'{x} é'\n",
    parse: () => treeSitter.parse("import os\n# note\ndef f(x):\n    return f'{x} é'\n"),
  },
  {
    name: "oxc",
    source: "import { a } from './m.js';\n// note\nexport function f(x) { return `${x} é`; }\n",
    parse: () =>
      oxc.parse(
        "import { a } from './m.js';\n// note\nexport function f(x) { return `${x} é`; }\n",
        { language: "javascript" },
      ),
  },
  {
    name: "babel",
    source: "import { a } from './m.js';\n// note\nexport function f(x) { return `${x} é`; }\n",
    parse: () =>
      babel.parse(
        "import { a } from './m.js';\n// note\nexport function f(x) { return `${x} é`; }\n",
        { language: "javascript" },
      ),
  },
];

function collectSpans(node: AstNode, into: SourceSpan[]): void {
  if (node.span !== null) into.push(node.span);
  for (const value of Object.values(node.fields)) {
    const values = Array.isArray(value) ? value : [value];
    for (const item of values) {
      if (typeof item === "object" && item !== null && "kind" in item) {
        collectSpans(item as AstNode, into);
      }
    }
  }
}

const HOSTILE: Array<{ name: string; parse: () => Promise<unknown> }> = [
  {
    name: "cpython-bridge",
    parse: () => pythonBridge.parse(`x = ${"f(".repeat(2000)}1${")".repeat(2000)}\n`),
  },
  {
    name: "tree-sitter",
    parse: () => treeSitter.parse(`x = ${"f(".repeat(20000)}1${")".repeat(20000)}\n`),
  },
  {
    name: "oxc",
    parse: () =>
      oxc.parse(`const x = ${"f(".repeat(20000)}1${")".repeat(20000)};\n`, {
        language: "javascript",
      }),
  },
  {
    name: "babel",
    parse: () =>
      babel.parse(`const x = ${"f(".repeat(20000)}1${")".repeat(20000)};\n`, {
        language: "javascript",
      }),
  },
];

describe("cross-frontend parser contract", () => {
  for (const testCase of CASES) {
    describe(testCase.name, () => {
      it("returns complete parser metadata for valid source", async () => {
        const result = await testCase.parse();
        expect(result.language).toMatch(/^(python|javascript|typescript)$/);
        expect(result.filename.length).toBeGreaterThan(0);
        expect(result.parser.id.length).toBeGreaterThan(0);
        expect(result.parser.parserVersion.length).toBeGreaterThan(0);
        expect(["full", "degraded"]).toContain(result.parser.fidelity);
      });

      it("emits spans that are ordered, in-bounds, and grid-consistent", async () => {
        const source = testCase.source;
        const result = await testCase.parse();
        const lines = scanSourceLines(source);
        const spans: SourceSpan[] = [];
        collectSpans(result.ast, spans);
        for (const comment of result.comments) spans.push(comment.span);
        for (const token of result.tokens) spans.push(token.span);
        expect(spans.length).toBeGreaterThan(5);
        for (const span of spans) {
          expect(span.endByteOffset).toBeGreaterThanOrEqual(span.startByteOffset);
          expect(span.startByteOffset).toBeGreaterThanOrEqual(0);
          expect(span.endByteOffset).toBeLessThanOrEqual(Buffer.byteLength(source, "utf8"));
          const startLine = lines.lineTexts.findIndex((_, index) => {
            const start = lines.lineStarts[index]!;
            const next = lines.lineStarts[index + 1] ?? Number.POSITIVE_INFINITY;
            return span.startByteOffset >= start && span.startByteOffset < next;
          });
          expect(span.start.line).toBe(startLine);
          expect(span.start.column).toBe(span.startByteOffset - (lines.lineStarts[startLine] ?? 0));
        }
      });

      it("captures comments with exact source slices", async () => {
        const result = await testCase.parse();
        expect(result.comments.length).toBeGreaterThanOrEqual(1);
        for (const comment of result.comments) {
          const slice = Buffer.from(testCase.source, "utf8").subarray(
            comment.span.startByteOffset,
            comment.span.endByteOffset,
          );
          expect(slice.toString("utf8")).toBe(comment.text);
        }
      });

      it("keeps diagnostics structured and serializes losslessly", async () => {
        const result = await testCase.parse();
        for (const diagnostic of result.diagnostics) {
          expect(["error", "warning", "info"]).toContain(diagnostic.severity);
          expect(diagnostic.code.length).toBeGreaterThan(0);
          expect(typeof diagnostic.message).toBe("string");
        }
        expect(JSON.parse(JSON.stringify(result))).toEqual(result);
      });
    });
  }

  describe("hostile inputs never crash the host", () => {
    for (const hostile of HOSTILE) {
      it(`${hostile.name}: deep nesting yields a result or a controlled error`, async () => {
        const outcome = await hostile.parse().then(
          () => "result" as const,
          (error: unknown) => ({ error }),
        );
        if (outcome !== "result") {
          expect(outcome.error).toBeInstanceOf(Error);
        }
      });
    }
  });
});
