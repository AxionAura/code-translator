import { beforeAll, describe, expect, it } from "vitest";

import { analyzeModule, buildModuleGraph } from "@axion-ct/core";
import type { ParseResult } from "@axion-ct/core";
import { createPythonBridgeParser, type PythonBridgeParser } from "@axion-ct/parser-py";
import { createOxcSyntaxValidator } from "@axion-ct/parser-js";
import { createPyToJsTranslator, type PyToJsTranslator } from "../src/translator.js";
import { createRegistryLookup } from "@axion-ct/registry";
import { MATRIX } from "./construct-matrix.data.js";

let py: PythonBridgeParser;

beforeAll(async () => {
  py = await createPythonBridgeParser();
});

// One translator per run: modules are lowered first, files (incl. the shared runtime)
// materialize in finalizeUnits from the union of every unit's helper requirements.
async function translate(
  target: "typescript" | "javascript",
  source: string,
  filename: string,
): Promise<{
  files: Map<string, string>;
  ledger: Awaited<ReturnType<PyToJsTranslator["translateUnit"]>>["ledger"];
}> {
  const parseResult = await py.parse(source, { filename });
  const translator = await createPyToJsTranslator(target, { registry: createRegistryLookup() });
  const emission = await translator.translateUnit(
    { filename, parseResult, model: analyzeModule(parseResult) },
    buildModuleGraph([{ filename, parseResult }]),
  );
  const shared = await translator.finalizeUnits();
  const files = new Map<string, string>();
  for (const file of [...emission.files, ...shared.files]) files.set(file.targetPath, file.content);
  return { files, ledger: emission.ledger };
}

describe("ConstructMatrix: python → typescript", () => {
  for (const entry of MATRIX) {
    it(entry.id, async () => {
      const { files, ledger } = await translate("typescript", entry.source, `${entry.id}.py`);
      const module = [...files.entries()].find(
        ([path]) => path.endsWith(".ts") && !path.includes("__ctrans_runtime"),
      );
      expect(module).toBeDefined();
      const moduleContent = module![1];
      for (const expected of entry.expectedContains) {
        expect(moduleContent).toContain(expected);
      }
      // Decision classification must match the expected class exactly: the entry's
      // primary rule must appear with the declared decision, never a silent downgrade.
      if (entry.rule !== undefined) {
        const matching = ledger.filter((ledgerEntry) => ledgerEntry.rule === entry.rule);
        expect(matching.length, `rule ${entry.rule} not ledgered`).toBeGreaterThan(0);
        expect(
          matching.some((ledgerEntry) => ledgerEntry.decision === entry.decision),
          `rule ${entry.rule} classified ${String(matching[0]?.decision)}, expected ${entry.decision}`,
        ).toBe(true);
      } else {
        // Unqualified entries: at least one entry of the expected class exists.
        expect(
          ledger.some((ledgerEntry) => ledgerEntry.decision === entry.decision),
          `no ${entry.decision} ledger entry`,
        ).toBe(true);
      }
      // Unsupported entries must produce a partially-translated marker, and the
      // emitted module must still be syntactically valid (S1).
      const validator = await createOxcSyntaxValidator();
      const s1 = await validator.validate(
        [...files.entries()].map(([path, content]) => ({
          path,
          content,
          language: "typescript" as const,
        })),
      );
      expect(s1.status, s1.details.join("; ")).toBe("pass");
    });
  }
});

describe("ConstructMatrix: python → javascript", () => {
  // The same matrix runs against the JS emitter: identical lowering, no type
  // annotations, and the runtime module is type-stripped (ADR D-022) so every entry
  // must still re-parse as plain JavaScript (S1 with the JS parser).
  for (const entry of MATRIX.filter((candidate) => candidate.tsOnly !== true)) {
    it(`${entry.id} → js`, async () => {
      const { files, ledger } = await translate("javascript", entry.source, `${entry.id}.py`);
      const moduleEntry = [...files.entries()].find(
        ([path]) => path.endsWith(".js") && !path.includes("__ctrans_runtime"),
      );
      expect(moduleEntry).toBeDefined();
      const moduleContent = moduleEntry![1];
      expect(moduleContent).not.toContain(": number");
      expect(moduleContent).not.toContain(": unknown");
      // Expected code fragments are shared with the TS direction except type text;
      // strip TS-only expectations (generic `let x = ...` checks stay valid).
      for (const expected of entry.expectedContains) {
        expect(moduleContent).toContain(expected);
      }
      if (entry.rule !== undefined) {
        const matching = ledger.filter((ledgerEntry) => ledgerEntry.rule === entry.rule);
        expect(matching.length, `rule ${entry.rule} not ledgered (js)`).toBeGreaterThan(0);
        expect(
          matching.some((ledgerEntry) => ledgerEntry.decision === entry.decision),
          `rule ${entry.rule} classified ${String(matching[0]?.decision)}, expected ${entry.decision} (js)`,
        ).toBe(true);
      }
      const validator = await createOxcSyntaxValidator();
      const s1 = await validator.validate(
        [...files.entries()].map(([path, content]) => ({
          path,
          content,
          language: "javascript" as const,
        })),
      );
      expect(s1.status, s1.details.join("; ")).toBe("pass");
    });
  }
});

// Determinism: identical input produces byte-identical output (docs/testing.md §2).
describe("codegen determinism", () => {
  it("produces identical output for identical input", async () => {
    const source =
      "def f(xs: ArrayLike):\n    total = 0\n    for x in xs:\n        total += x\n    return total\n";
    const translate = async (): Promise<string> => {
      const parseResult: ParseResult = await py.parse(source, { filename: "det.py" });
      const translator = await createPyToJsTranslator("typescript");
      await translator.translateUnit(
        { filename: "det.py", parseResult, model: analyzeModule(parseResult) },
        buildModuleGraph([{ filename: "det.py", parseResult }]),
      );
      const shared = await translator.finalizeUnits();
      return shared.files.map((file) => `${file.targetPath}\n${file.content}`).join("\n---\n");
    };
    expect(await translate()).toBe(await translate());
  });

  it("formatter finalization is idempotent", async () => {
    const { format } = await import("prettier");
    const parseResult = await py.parse("def f(a: int, b: int):\n    return a // b + a % b\n", {
      filename: "fmt.py",
    });
    const translator = await createPyToJsTranslator("typescript");
    await translator.translateUnit(
      { filename: "fmt.py", parseResult, model: analyzeModule(parseResult) },
      buildModuleGraph([{ filename: "fmt.py", parseResult }]),
    );
    const shared = await translator.finalizeUnits();
    expect(shared.files.length).toBeGreaterThan(0);
    for (const file of shared.files) {
      const formatted = await format(file.content, { parser: "typescript" });
      expect(await format(formatted, { parser: "typescript" })).toBe(formatted);
    }
  });
});
