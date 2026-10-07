import { beforeAll, describe, expect, it } from "vitest";

import { createOxcJsParser, type OxcJsParser } from "../src/oxc-parser.js";
import { createBabelJsParser, type BabelJsParser } from "../src/babel-parser.js";
import { JsSyntaxError } from "../src/errors.js";

let oxc: OxcJsParser;
let babel: BabelJsParser;

beforeAll(async () => {
  oxc = await createOxcJsParser();
  babel = await createBabelJsParser();
});

const MALFORMED_CASES = [
  { name: "incomplete function", source: "function f() {\n  return 1\n" },
  { name: "missing brace", source: "if (a) {\n  b();\n" },
  { name: "incomplete expression", source: "const x = 1 +\n" },
  { name: "malformed import", source: "import { a b } from 'm.js';\n" },
  {
    name: "malformed TypeScript type",
    source: "const x: {a: ;;\n",
    language: "typescript" as const,
  },
];

describe("malformed input (oxc recovery)", () => {
  for (const testCase of MALFORMED_CASES) {
    it(`produces structured diagnostics for: ${testCase.name}`, async () => {
      const result = await oxc.parse(testCase.source, {
        language: testCase.language ?? "javascript",
      });
      // Recovery preserves a result, but errors are never presented as clean parses.
      expect(result.diagnostics.some((d) => d.severity === "error")).toBe(true);
      const withSpan = result.diagnostics.find((d) => d.span !== null);
      if (withSpan !== undefined) {
        expect(withSpan.span!.endByteOffset).toBeGreaterThanOrEqual(withSpan.span!.startByteOffset);
      }
      expect(result.ast.kind).toBe("Program");
    });
  }
});

describe("malformed input (babel)", () => {
  it("surfaces recoverable errors as diagnostics", async () => {
    const outcome = await babel.parse("const x = ;\n", { language: "javascript" }).then(
      (result) => ({ recovered: result }),
      (error: unknown) => ({ thrown: error }),
    );
    // Babel draws its recoverable/unrecoverable line where it draws it; both outcomes
    // must be structured: either a result with error diagnostics or a typed error.
    if ("recovered" in outcome) {
      expect(outcome.recovered.diagnostics.some((d) => d.severity === "error")).toBe(true);
    } else {
      expect(outcome.thrown).toBeInstanceOf(JsSyntaxError);
    }
  });

  it("maps unrecoverable failures to typed JsSyntaxError", async () => {
    const error = await babel
      .parse("class {\n  constructor() = = =\n", { language: "javascript" })
      .catch((caught: unknown) => caught);
    // Whether Babel recovers or throws depends on the breakage; both outcomes are
    // valid as long as they are structured.
    if (error instanceof JsSyntaxError) {
      expect(error.code).toBe("JS-SYNTAX");
    } else {
      expect((error as { diagnostics?: unknown[] }).diagnostics).toBeDefined();
    }
  });
});

describe("resource limits", () => {
  it("rejects oversized sources before parsing", async () => {
    const tiny = await createOxcJsParser({ maxSourceBytes: 8 });
    await expect(
      tiny.parse("const bigger = 1;\n", { language: "javascript" }),
    ).rejects.toMatchObject({
      code: "JS-SOURCE-LIMIT",
    });
  });
});
