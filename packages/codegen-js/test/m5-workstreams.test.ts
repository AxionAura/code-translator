// M5 workstream integration tests: async boundary propagation (WS F) and the
// registry-injection surface (WS E) exercised through the REAL translator with the
// real registry data — emission, ledger provenance, and executed behavior where
// the mapping warrants it. Complements the golden fixture (async-requests) by
// pinning the per-rule decisions and the non-propagation guarantee.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  analyzeModule,
  buildModuleGraph,
  collectFunctionCalls,
  collectImportedFunctions,
  propagateAsync,
  ASYNC_BOUNDARY_MODULE,
  NO_REGISTRY,
  type RegistryLookup,
} from "@ctrans/core";
import { createPythonBridgeParser, type PythonBridgeParser } from "@ctrans/parser-py";
import { createRegistryLookup } from "@ctrans/registry";
import { createPyToJsTranslator } from "../src/translator.js";

let py: PythonBridgeParser;
let registry: RegistryLookup;

const OUT_DIR = join(import.meta.dirname, ".tmp-m5-ws");

beforeAll(async () => {
  py = await createPythonBridgeParser();
  registry = createRegistryLookup();
  mkdirSync(OUT_DIR, { recursive: true });
});

afterAll(() => {
  rmSync(OUT_DIR, { recursive: true, force: true });
});

interface Unit {
  readonly filename: string;
  readonly source: string;
}

async function translateProject(
  units: readonly Unit[],
  options: { withRegistry?: boolean; withAsync?: boolean } = {},
): Promise<{
  files: Map<string, string>;
  ledger: readonly {
    rule: string;
    decision: string;
    warnings: readonly string[];
    targetSummary: string | null;
  }[];
}> {
  const inputs = [];
  for (const unit of units) {
    const parseResult = await py.parse(unit.source, { filename: unit.filename });
    inputs.push({ filename: unit.filename, parseResult, model: analyzeModule(parseResult) });
  }
  const graph = buildModuleGraph(
    inputs.map((input) => ({ filename: input.filename, parseResult: input.parseResult })),
  );
  const translator = await createPyToJsTranslator("typescript", {
    registry: options.withRegistry === false ? NO_REGISTRY : registry,
  });
  // WS F: same propagation wiring as the pipeline — when the boundary module is
  // imported anywhere, compute the async set and pass it through the context.
  let asyncFunctions: Map<string, Set<string>> | undefined;
  if (options.withAsync !== false) {
    const unitFunctions = new Map(
      inputs.map((input) => [
        input.filename,
        collectFunctionCalls(input.filename, input.parseResult.ast),
      ]),
    );
    const moduleIds = new Set(inputs.map((input) => input.filename));
    const unitImports = new Map(
      inputs.map((input) => [
        input.filename,
        collectImportedFunctions(input.filename, input.parseResult.ast, graph, moduleIds),
      ]),
    );
    const boundaryUsed = units.some((unit) => unit.source.includes(ASYNC_BOUNDARY_MODULE));
    if (boundaryUsed) {
      asyncFunctions = propagateAsync(unitFunctions, unitImports, ASYNC_BOUNDARY_MODULE);
    }
  }
  const ledger = [];
  const files = new Map<string, string>();
  for (const input of inputs) {
    const emission = await translator.translateUnit(input, graph, {
      analyzed: new Map(inputs.map((candidate) => [candidate.filename, candidate])),
      ...(asyncFunctions === undefined ? {} : { asyncFunctions }),
    });
    ledger.push(...emission.ledger);
    for (const file of emission.files) files.set(file.targetPath, file.content);
  }
  const shared = await translator.finalizeUnits();
  for (const file of shared.files) files.set(file.targetPath, file.content);
  return { files, ledger };
}

describe("WS F: async propagation engine", () => {
  it("marks the boundary caller and propagates through from-imports", () => {
    // fetcher calls requests.get (boundary); main imports fetch_title.
    const fetcherAst = {
      kind: "Module",
      span: null,
      fields: {
        body: [
          {
            kind: "FunctionDef",
            span: null,
            fields: {
              name: "fetch_title",
              body: [
                {
                  kind: "Assign",
                  span: null,
                  fields: {
                    targets: [{ kind: "Name", span: null, fields: { id: "response" } }],
                    value: {
                      kind: "Call",
                      span: null,
                      fields: {
                        func: {
                          kind: "Attribute",
                          span: null,
                          fields: {
                            attr: "get",
                            value: { kind: "Name", span: null, fields: { id: "requests" } },
                          },
                        },
                        args: [],
                      },
                    },
                  },
                },
              ],
            },
          },
        ],
      },
    };
    const unitFunctions = new Map([
      ["fetcher.py", collectFunctionCalls("fetcher.py", fetcherAst as never)],
    ]);
    const asyncSet = propagateAsync(unitFunctions, new Map(), ASYNC_BOUNDARY_MODULE);
    expect(asyncSet.get("fetcher.py")?.has("fetch_title")).toBe(true);
  });

  it("does NOT asyncify when no boundary module participates", () => {
    const ast = {
      kind: "Module",
      span: null,
      fields: {
        body: [
          {
            kind: "FunctionDef",
            span: null,
            fields: {
              name: "compute",
              body: [
                {
                  kind: "Assign",
                  span: null,
                  fields: {
                    targets: [{ kind: "Name", span: null, fields: { id: "x" } }],
                    value: { kind: "Constant", span: null, fields: { value: 1 } },
                  },
                },
              ],
            },
          },
        ],
      },
    };
    const unitFunctions = new Map([["mod.py", collectFunctionCalls("mod.py", ast as never)]]);
    const asyncSet = propagateAsync(unitFunctions, new Map(), "requests");
    expect(asyncSet.get("mod.py")?.size ?? 0).toBe(0);
  });

  it("emits await at cross-unit call sites and async signatures through the translator", async () => {
    const { files, ledger } = await translateProject([
      {
        filename: "fetcher.py",
        source:
          "import requests\n\ndef fetch(url: str) -> str:\n    r = requests.get(url)\n    return r.text\n",
      },
      {
        filename: "main.py",
        source: "from fetcher import fetch\n\ndef run(url: str) -> str:\n    return fetch(url)\n",
      },
    ]);
    // Both functions asyncified; cross-unit call awaited; response surface mapped.
    expect(files.get("fetcher.ts")).toContain(
      "export async function fetch(url: string): Promise<string>",
    );
    expect(files.get("fetcher.ts")).toContain("await fetch(url");
    expect(files.get("fetcher.ts")).toContain("await r.text()");
    expect(files.get("main.ts")).toContain(
      "export async function run(url: string): Promise<string>",
    );
    expect(files.get("main.ts")).toContain("await fetch(url)");
    const asyncified = ledger.filter(
      (entry) =>
        entry.rule === "py.function→js.function" && entry.targetSummary?.startsWith("async"),
    );
    expect(asyncified.length).toBe(2);
  });

  it("leaves signatures synchronous when no boundary is involved", async () => {
    const { files } = await translateProject(
      [{ filename: "mod.py", source: "def compute(x: int) -> int:\n    return x + 1\n" }],
      { withAsync: false },
    );
    expect(files.get("mod.ts")).toContain("function compute(x: number): number");
    expect(files.get("mod.ts")).not.toContain("async");
  });
});

describe("WS E: registry injection surface", () => {
  it("maps registry methods when the lookup is injected (rename path)", async () => {
    const { files, ledger } = await translateProject([
      { filename: "mod.py", source: "def add(xs: list[int]) -> None:\n    xs.append(1)\n" },
    ]);
    expect(files.get("mod.ts")).toContain("xs.push(1);");
    const entry = ledger.find((item) => item.targetSummary === "xs.push(1)");
    expect(entry?.decision).toBe("deterministic");
  });

  it("keeps the unmapped warning when NO_REGISTRY is injected", async () => {
    const { ledger } = await translateProject(
      [{ filename: "mod.py", source: "def add(xs: list[int]) -> None:\n    xs.append(1)\n" }],
      { withRegistry: false },
    );
    const entry = ledger.find((item) => item.targetSummary === "xs.append(1)");
    expect(entry?.warnings).toContain("CTW-METHOD-UNMAPPED");
  });

  it("maps builtins through the registry helper (sorted) with honest provenance", async () => {
    const { files, ledger } = await translateProject([
      { filename: "mod.py", source: "def sort(xs):\n    return sorted(xs)\n" },
    ]);
    expect(files.get("mod.ts")).toContain("__ctrans_sorted(xs)");
    const entry = ledger.find((item) => item.rule === "py.sorted→__ctrans.sorted");
    expect(entry?.decision).toBe("semantic"); // partial fidelity (kwargs surface documented)
  });

  it("emits the registry module (math) once when referenced", async () => {
    const { files } = await translateProject([
      {
        filename: "mod.py",
        source: "import math\n\ndef f(x: float) -> float:\n    return math.floor(x)\n",
      },
    ]);
    const mathModule = files.get("__ctrans_math.ts");
    expect(mathModule).toBeDefined();
    expect(mathModule).toContain("export function floor");
    // math.floor on a typed float lowers to the module call.
    expect(files.get("mod.ts")).toContain("math.floor(x)");
  });

  it("executes the generated math module with Python-identical results", async () => {
    const { files } = await translateProject([
      {
        filename: "mod.py",
        source:
          "import math\n\ndef values(x: float) -> list:\n    return [math.floor(x), math.ceil(x), math.sqrt(x)]\n",
      },
    ]);
    const dir = join(OUT_DIR, "math-exec");
    mkdirSync(dir, { recursive: true });
    for (const [path, content] of files) writeFileSync(join(dir, path), content);
    try {
      const generated = (await import(join(dir, "mod.ts"))) as {
        values: (x: number) => [number, number, number];
      };
      // Python: floor(3.7)=3, ceil(3.7)=4, sqrt(3.7)=1.9235384061671346
      expect(generated.values(3.7)).toEqual([3, 4, 1.9235384061671346]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
