import { beforeAll, describe, expect, it } from "vitest";

import { createOxcJsParser, type OxcJsParser } from "../src/oxc-parser.js";
import { createBabelJsParser, type BabelJsParser } from "../src/babel-parser.js";

let oxc: OxcJsParser;
let babel: BabelJsParser;

beforeAll(async () => {
  oxc = await createOxcJsParser();
  babel = await createBabelJsParser();
});

const SOURCE = [
  "// leading file comment",
  "import { a } from './m.js'; // trailing on import",
  "",
  "/* block between declarations",
  "   spanning lines */",
  "const value = 1; /* inline after statement */",
  "export { value }; // trailing on export",
  "",
].join("\n");

for (const [name, parserFactory] of [
  ["oxc", () => oxc],
  ["babel", () => babel],
] as const) {
  describe(`comment preservation (${name})`, () => {
    it("captures comments in every position with exact source slices", async () => {
      const result = await parserFactory().parse(SOURCE, { language: "javascript" });
      const texts = result.comments.map((comment) => comment.text);
      expect(texts.some((text) => text === "// leading file comment")).toBe(true);
      expect(texts.some((text) => text === "// trailing on import")).toBe(true);
      expect(texts.some((text) => text.startsWith("/* block between declarations"))).toBe(true);
      expect(texts.some((text) => text === "/* inline after statement */")).toBe(true);
      expect(texts.some((text) => text === "// trailing on export")).toBe(true);
      // Comment spans reproduce the exact source bytes.
      for (const comment of result.comments) {
        const slice = Buffer.from(SOURCE, "utf8").subarray(
          comment.span.startByteOffset,
          comment.span.endByteOffset,
        );
        expect(slice.toString("utf8")).toBe(comment.text);
      }
    });

    it("does not treat comments as AST content", async () => {
      const result = await parserFactory().parse("// only a comment\n", {
        language: "javascript",
      });
      expect(result.comments.map((comment) => comment.text)).toEqual(["// only a comment"]);
      expect(result.ast.fields["body"] as unknown[]).toEqual([]);
    });
  });
}
