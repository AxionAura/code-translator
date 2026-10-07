import { beforeAll, describe, expect, it } from "vitest";

import { createOxcJsParser, type OxcJsParser } from "../src/oxc-parser.js";
import { createBabelJsParser, type BabelJsParser } from "../src/babel-parser.js";

let oxc: OxcJsParser;
let babel: BabelJsParser;

beforeAll(async () => {
  oxc = await createOxcJsParser();
  babel = await createBabelJsParser();
});

const RICH_SOURCE = [
  "import defaults, { named, renamed as alias } from './mod.js';",
  "import * as ns from './ns.js';",
  "import 'side-effect-only';",
  "import type { TypeOnly } from './types.js';",
  "export const direct = 1;",
  "export { renamed as outbound };",
  "export { helper } from './helpers.js';",
  "export * from './everything.js';",
  "export * as grouped from './grouped.js';",
  "export default function main() {}",
  "const lazy = () => import('./lazy.js');",
  "",
].join("\n");

describe("module map extraction", () => {
  it("extracts the full import/export surface (oxc)", async () => {
    const result = await oxc.parse(RICH_SOURCE, { language: "typescript" });
    const moduleInfo = result.module!;
    expect(moduleInfo.hasModuleSyntax).toBe(true);
    expect(moduleInfo.imports.map((entry) => [entry.kind, entry.moduleSpecifier])).toEqual([
      ["default", "./mod.js"],
      ["named", "./mod.js"],
      ["named", "./mod.js"],
      ["namespace", "./ns.js"],
      ["side-effect", "side-effect-only"],
      ["named", "./types.js"],
    ]);
    expect(moduleInfo.imports[0]?.localName).toBe("defaults");
    expect(moduleInfo.imports[1]).toMatchObject({ importedName: "named", localName: "named" });
    expect(moduleInfo.imports[2]).toMatchObject({ importedName: "renamed", localName: "alias" });
    expect(moduleInfo.exports.map((entry) => [entry.kind, entry.exportedName])).toEqual([
      ["named", "direct"],
      ["named", "outbound"],
      ["named", "helper"],
      ["star", null],
      ["star-as", "grouped"],
      ["default", "default"],
    ]);
    expect(moduleInfo.exports[2]?.moduleSpecifier).toBe("./helpers.js");
    expect(moduleInfo.dynamicImports).toHaveLength(1);
  });

  it("produces the same module surface through the Babel fallback", async () => {
    const oxcResult = await oxc.parse(RICH_SOURCE, { language: "typescript" });
    const babelResult = await babel.parse(RICH_SOURCE, { language: "typescript" });
    expect(babelResult.module).toEqual(oxcResult.module);
  });

  it("records dynamic imports for both parsers", async () => {
    for (const parser of [oxc, babel]) {
      const result = await parser.parse("if (lazy) { const m = await import('./late.js'); }\n", {
        language: "javascript",
      });
      expect(result.module!.dynamicImports).toHaveLength(1);
      expect(result.module!.dynamicImports[0]!.startByteOffset).toBeGreaterThan(0);
    }
  });

  it("marks script sources without import/export as non-modules", async () => {
    for (const parser of [oxc, babel]) {
      const result = await parser.parse("const local = 1;\nfunction use() { return local; }\n", {
        language: "javascript",
      });
      expect(result.module!.hasModuleSyntax).toBe(false);
      expect(result.module!.imports).toEqual([]);
      expect(result.module!.exports).toEqual([]);
    }
  });
});
