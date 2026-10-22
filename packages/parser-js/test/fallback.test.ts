import { beforeAll, describe, expect, it, vi } from "vitest";

import { createBabelJsParser, type BabelJsParser } from "../src/babel-parser.js";
import { createOxcJsParser, type OxcJsParser } from "../src/oxc-parser.js";
import { createJsParser } from "../src/select.js";

let oxc: OxcJsParser;
let babel: BabelJsParser;

beforeAll(async () => {
  oxc = await createOxcJsParser();
  babel = await createBabelJsParser();
});

const PARITY_SOURCE = [
  "import { helper } from './helper.js';",
  "",
  "export function greet(who = 'wörld') {",
  "  return `héllo ${who} ${helper()}`;",
  "}",
  "",
].join("\n");

describe("Babel fallback parity", () => {
  it("produces the same public contract as oxc", async () => {
    const oxcResult = await oxc.parse(PARITY_SOURCE, { language: "javascript" });
    const babelResult = await babel.parse(PARITY_SOURCE, { language: "javascript" });
    expect(babelResult.language).toBe(oxcResult.language);
    expect(babelResult.ast.kind).toBe(oxcResult.ast.kind);
    expect(babelResult.module!.hasModuleSyntax).toBe(true);
    expect(babelResult.comments.length).toBe(oxcResult.comments.length);
    // Identical byte spans for the function declaration across front-ends.
    const oxcFn = (oxcResult.ast.fields["body"] as import("@axion-ct/core").AstNode[]).find(
      (node) => node.kind === "FunctionDeclaration",
    );
    const babelFn = (babelResult.ast.fields["body"] as import("@axion-ct/core").AstNode[]).find(
      (node) => node.kind === "FunctionDeclaration",
    );
    expect(babelFn?.span).toEqual(oxcFn?.span);
  });

  it("marks itself honestly in parser metadata", async () => {
    const result = await babel.parse("x = 1;\n", { language: "javascript" });
    expect(result.parser.id).toBe("babel");
    expect(result.parser.fidelity).toBe("full");
    expect(result.parser.parserVersion).toMatch(/^\d+\./);
  });
});

// vi.mock is hoisted to the top of the file; the switchable state lets one test
// simulate a native load failure while the others use the real oxc parser.
const oxcState = vi.hoisted(() => ({ broken: false }));

vi.mock("../src/oxc-parser.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/oxc-parser.js")>();
  const { JsParserUnavailableError } = await import("../src/errors.js");
  const realCreate = actual.OxcJsParser.create.bind(actual.OxcJsParser);
  return {
    ...actual,
    OxcJsParser: {
      create: () =>
        oxcState.broken
          ? Promise.reject(new JsParserUnavailableError("simulated native load failure"))
          : realCreate(),
    },
  } as unknown as typeof actual;
});

describe("selection policy", () => {
  it("defaults to oxc", async () => {
    const parser = await createJsParser();
    const result = await parser.parse("x = 1;\n", { language: "javascript" });
    expect(result.parser.id).toBe("oxc");
  });

  it("activates the Babel fallback only when explicitly allowed", async () => {
    oxcState.broken = true;
    try {
      // Hard failure without opt-in:
      await expect(createJsParser()).rejects.toMatchObject({ code: "JS-PARSER-UNAVAILABLE" });
      // Recorded downgrade with opt-in:
      const parser = await createJsParser({ allowFallback: true });
      const result = await parser.parse("x = 1;\n", { language: "javascript" });
      expect(result.parser.id).toBe("babel");
    } finally {
      oxcState.broken = false;
    }
  });
});
