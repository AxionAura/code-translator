import { beforeAll, describe, expect, it } from "vitest";

import { analyzeModule, buildModuleGraph } from "@ctrans/core";
import { createOxcJsParser, type OxcJsParser } from "@ctrans/parser-js";
import { createJsToPyTranslator } from "../src/index.js";
import { REVERSE_MATRIX } from "./reverse-matrix.data.js";

let js: OxcJsParser;

beforeAll(async () => {
  js = await createOxcJsParser();
});

// Reverse ConstructMatrix runner (roadmap M7 WS H): JS/TS sources → Python target.
// Every entry asserts the emitted fragments AND the primary ledger decision class;
// unsupported entries assert the marker. S1 (Python re-parse) runs for every
// non-unsupported entry so syntactic validity is pinned too.
describe("ReverseMatrix: javascript/typescript → python", () => {
  for (const entry of REVERSE_MATRIX) {
    it(entry.id, async () => {
      const parseResult = await js.parse(entry.source, {
        filename: `mod.${entry.language === "typescript" ? "ts" : "js"}`,
        language: entry.language,
      });
      const unit = {
        filename: parseResult.filename,
        parseResult,
        model: analyzeModule(parseResult),
      };
      const graph = buildModuleGraph([{ filename: parseResult.filename, parseResult }]);
      const translator = createJsToPyTranslator();
      const emission = await translator.translateUnit(unit, graph);
      const shared = await translator.finalizeUnits!();
      const files = new Map<string, string>();
      for (const file of [...emission.files, ...shared.files])
        files.set(file.targetPath, file.content);
      const output = files.get(parseResult.filename.replace(/\.(ts|js)$/, ".py"))!;

      for (const expected of entry.expectedContains) {
        expect(output, `${entry.id}: expected to contain ${JSON.stringify(expected)}`).toContain(
          expected,
        );
      }
      for (const forbidden of entry.expectedNotContains ?? []) {
        expect(
          output,
          `${entry.id}: expected NOT to contain ${JSON.stringify(forbidden)}`,
        ).not.toContain(forbidden);
      }

      if (entry.rule !== undefined) {
        if (entry.rule === "erased") {
          // Type-only erasure: the erased node records under the declaration rule.
          expect(
            emission.ledger.some(
              (ledgerEntry) =>
                ledgerEntry.decision === "deterministic" && ledgerEntry.rule.includes("erased"),
            ),
            `no erased ledger entry for ${entry.id}`,
          ).toBe(true);
        } else {
          const matching = emission.ledger.filter((ledgerEntry) => ledgerEntry.rule === entry.rule);
          expect(
            matching.length,
            `rule ${entry.rule} not ledgered for ${entry.id}`,
          ).toBeGreaterThan(0);
          expect(
            matching.some((ledgerEntry) => ledgerEntry.decision === entry.decision),
            `rule ${entry.rule} classified ${String(matching[0]?.decision)}, expected ${entry.decision}`,
          ).toBe(true);
        }
      } else {
        expect(
          emission.ledger.some((ledgerEntry) => ledgerEntry.decision === entry.decision),
          `no ${entry.decision} ledger entry for ${entry.id}`,
        ).toBe(true);
      }

      if (entry.unsupported === true) {
        expect(
          emission.ledger.some((ledgerEntry) => ledgerEntry.decision === "unsupported"),
          `no unsupported classification for ${entry.id}`,
        ).toBe(true);
      }

      // S1: the generated Python must re-parse through the bridge (reference
      // grammar) — unsupported entries still emit parseable code (markers are
      // comments), so this runs for ALL entries.
      const { createPythonBridgeParser } = await import("@ctrans/parser-py");
      const bridge = await createPythonBridgeParser();
      try {
        await bridge.parse(output, { filename: "out.py" });
      } catch (error) {
        throw new Error(
          `S1 failed for ${entry.id}: ${error instanceof Error ? error.message : String(error)}\n${output}`,
        );
      }
    });
  }
});
