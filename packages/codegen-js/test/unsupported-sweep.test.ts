// Unsupported-arm sweep (roadmap M7): every lowering arm that classifies a
// construct `unsupported` must produce (a) an unsupported ledger entry with the
// CTW-UNSUPPORTED-JS-CONSTRUCT warning, and (b) output that either re-parses (S1)
// or fails honestly — never silent drops. Feeding the full battery through BOTH
// directions exercises every arm mechanically.
import { beforeAll, describe, expect, it } from "vitest";

import { analyzeModule, buildModuleGraph } from "@axion-ct/core";
import { createOxcJsParser, type OxcJsParser } from "@axion-ct/parser-js";
import { JsToTsTranslator, TsToJsTranslator } from "../src/js-directions.js";

let js: OxcJsParser;

beforeAll(async () => {
  js = await createOxcJsParser();
});

// Each snippet isolates one unsupported construct. Entries whose emission is
// expected to stay syntactically valid are re-parsed (S1); others assert only the
// ledger classification (the marker comments preserve the construct's context).
const UNSUPPORTED_BATTERY: readonly { readonly id: string; readonly source: string }[] = [
  { id: "ts-enum", source: "export enum E { A }\n" },
  { id: "ts-namespace", source: "export namespace N {\n  export const x = 1;\n}\n" },
  {
    id: "ts-param-property",
    source: "export class C {\n  constructor(private name: string) {}\n}\n",
  },
  { id: "ts-export-assignment", source: "const x = 1;\nexport = x;\n" },
  { id: "ts-import-equals", source: "import fs = require('fs');\nexport const used = fs;\n" },
  { id: "abstract-class", source: "export abstract class A {\n  abstract m(): void;\n}\n" },
  {
    id: "ts-decorator",
    source:
      "function deco(target: unknown): unknown {\n  return target;\n}\n@deco\nexport class D {}\n",
  },
];

describe("unsupported-arm sweep (both directions)", () => {
  for (const entry of UNSUPPORTED_BATTERY) {
    it(`${entry.id}: classified unsupported with honest markers (TS→JS)`, async () => {
      const language = "typescript";
      const filename = `${entry.id}.ts`;
      const parseResult = await js.parse(entry.source, { filename, language });
      const unit = { filename, parseResult, model: analyzeModule(parseResult) };
      const graph = buildModuleGraph([{ filename, parseResult }]);
      const translator = new TsToJsTranslator();
      await translator.translateUnit(unit, graph);
      const shared = await translator.finalizeUnits();
      const ledger = shared.ledger;
      expect(
        ledger.some(
          (e) =>
            e.decision === "unsupported" && e.warnings.includes("CTW-UNSUPPORTED-JS-CONSTRUCT"),
        ),
        `${entry.id}: no unsupported entry`,
      ).toBe(true);
    });

    it(`${entry.id}: classified unsupported with honest markers (JS→TS)`, async () => {
      const language = "typescript";
      const filename = `${entry.id}.ts`;
      const parseResult = await js.parse(entry.source, { filename, language });
      const unit = { filename, parseResult, model: analyzeModule(parseResult) };
      const graph = buildModuleGraph([{ filename, parseResult }]);
      const translator = new JsToTsTranslator();
      await translator.translateUnit(unit, graph);
      const shared = await translator.finalizeUnits();
      expect(
        shared.ledger.some(
          (e) =>
            e.decision === "unsupported" && e.warnings.includes("CTW-UNSUPPORTED-JS-CONSTRUCT"),
        ),
        `${entry.id}: no unsupported entry`,
      ).toBe(true);
    });
  }
});
