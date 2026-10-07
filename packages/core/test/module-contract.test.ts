import { beforeAll, describe, expect, it } from "vitest";

import { analyzeModule } from "../src/semantic.js";
import { extractModuleContract } from "../src/module-contract.js";
import { TypeScriptSemanticOracle } from "../../parser-js/src/ts-oracle.js";
import { parseJs, parsePython } from "./helpers.js";

let py: (
  source: string,
  filename?: string,
) => Promise<import("../src/parse-result.js").ParseResult>;
let js: (
  source: string,
  filename?: string,
  language?: "javascript" | "typescript",
) => Promise<import("../src/parse-result.js").ParseResult>;

beforeAll(async () => {
  py = parsePython;
  js = parseJs;
});

describe("module contracts", () => {
  it("honors __all__ for python exports", async () => {
    const source = [
      "__all__ = ['public_fn']",
      "",
      "def public_fn():",
      "    return 1",
      "",
      "def _private():",
      "    return 2",
      "",
      "def unlisted():",
      "    return 3",
      "",
    ].join("\n");
    const parseResult = await py(source, "api.py");
    const contract = extractModuleContract({
      filename: "api.py",
      source,
      parseResult,
      model: analyzeModule(parseResult),
    });
    expect(contract.exports.map((entry) => entry.name)).toEqual(["public_fn"]);
    expect(contract.exports[0]!.kind).toBe("function");
  });

  it("falls back to public top-level names without __all__", async () => {
    const source = ["def public():", "    return 1", "", "def _hidden():", "    return 2", ""].join(
      "\n",
    );
    const parseResult = await py(source, "api.py");
    const contract = extractModuleContract({
      filename: "api.py",
      source,
      parseResult,
      model: analyzeModule(parseResult),
    });
    expect(contract.exports.map((entry) => entry.name)).toEqual(["public"]);
  });

  it("describes js export surfaces honestly (unknown types stay null)", async () => {
    const source =
      "export const limit = 10;\nexport function greet(name) { return name; }\nconst internal = 1;\n";
    const parseResult = await js(source, "mod.js");
    const contract = extractModuleContract({
      filename: "mod.js",
      source,
      parseResult,
      model: analyzeModule(parseResult),
    });
    const byName = new Map(contract.exports.map((entry) => [entry.name, entry]));
    expect(byName.get("limit")?.kind).toBe("value");
    expect(byName.get("limit")?.type).toMatchObject({
      type: { kind: "number", numberKind: "int" },
    });
    expect(byName.get("greet")?.kind).toBe("function");
    // Unannotated JS parameter types are unknown, not invented.
    expect(byName.get("greet")?.type).toBeNull();
    expect(byName.has("internal")).toBe(false);
  });

  it("adds oracle type displays as separate provenance for TypeScript", async () => {
    const source = "export const answer: number = 42;\nexport interface Shape { area(): number }\n";
    const parseResult = await js(source, "mod.ts", "typescript");
    const contract = extractModuleContract(
      {
        filename: "mod.ts",
        source,
        parseResult,
        model: analyzeModule(parseResult),
      },
      new TypeScriptSemanticOracle(),
    );
    const byName = new Map(contract.exports.map((entry) => [entry.name, entry]));
    expect(byName.get("answer")?.type).toMatchObject({
      type: { kind: "number" },
      origin: "explicit",
    });
    expect(byName.get("answer")?.oracleTypeDisplay).toBe("number");
    expect(byName.get("Shape")?.kind).toBe("type");
    // The declared type of an interface prints as its own name.
    expect(byName.get("Shape")?.oracleTypeDisplay).toBe("Shape");
  });

  it("reports star re-exports as info instead of inlining them", async () => {
    const source = "export * from './everything.js';\nexport const own = 1;\n";
    const parseResult = await js(source, "mod.js");
    const contract = extractModuleContract({
      filename: "mod.js",
      source,
      parseResult,
      model: analyzeModule(parseResult),
    });
    expect(contract.exports.map((entry) => entry.name)).toEqual(["own"]);
    expect(contract.diagnostics.some((d) => d.code === "SEM-STAR-REEXPORT")).toBe(true);
  });
});
