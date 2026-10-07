import { beforeAll, describe, expect, it } from "vitest";

import { createOxcJsParser, type OxcJsParser } from "../src/oxc-parser.js";
import { createBabelJsParser, type BabelJsParser } from "../src/babel-parser.js";

let oxc: OxcJsParser;
let babel: BabelJsParser;

beforeAll(async () => {
  oxc = await createOxcJsParser();
  babel = await createBabelJsParser();
});

// Parsing is non-executing by construction: the parser libraries never evaluate
// input. These tests stress hostile shapes and assert controlled outcomes.
describe("hostile inputs", () => {
  it("survives extremely deep call nesting without crashing the host", async () => {
    const deep = `const x = ${"f(".repeat(8000)}1${")".repeat(8000)};\n`;
    for (const parser of [oxc, babel]) {
      const outcome = await parser.parse(deep, { language: "javascript" }).then(
        (_result) => "result" as const,
        (error: unknown) => ({ error }),
      );
      if (outcome === "result") {
        expect(true).toBe(true); // recovered tree or clean parse
      } else {
        const error = outcome.error as { code?: string };
        expect(typeof error.code === "string" || error instanceof Error).toBe(true);
      }
    }
  }, 20_000);

  it("survives huge literals and long identifier chains", async () => {
    const huge = `const s = "${"x".repeat(500_000)}";\n`;
    const chains = `const v = ${"obj.".repeat(2000)}prop;\n`;
    for (const source of [huge, chains]) {
      for (const parser of [oxc, babel]) {
        const result = await parser.parse(source, { language: "javascript" });
        expect(result.ast.kind).toBe("Program");
      }
    }
  }, 20_000);

  it("survives invalid escapes and unusual unicode", async () => {
    const cases = [
      "const bad = '\\u{FFFFFFFFFF}';\n",
      "const uni = '\u{1F600}\u{10FFFF}'.repeat(100);\n",
      "let \u{10FFFF}\u{10FFFE} = '\u0000\u0001';\n",
    ];
    for (const source of cases) {
      for (const parser of [oxc, babel]) {
        const outcome = await parser.parse(source, { language: "javascript" }).then(
          (result) => result.ast.kind === "Program",
          () => true,
        );
        expect(outcome).toBe(true);
      }
    }
  });

  it("survives comment-scanning stress", async () => {
    const stress = `${"/*".repeat(1000)}${"*/".repeat(1000)}\nconst after = 1; // tail\n`;
    for (const parser of [oxc, babel]) {
      const outcome = await parser.parse(stress, { language: "javascript" }).then(
        (result) => result.ast.kind === "Program" || result.diagnostics.length > 0,
        () => true,
      );
      expect(outcome).toBe(true);
    }
  });
});
