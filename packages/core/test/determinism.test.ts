import { beforeAll, describe, expect, it } from "vitest";

import { analyzeModule } from "../src/semantic.js";
import { buildModuleGraph } from "../src/module-graph.js";
import { extractModuleContract } from "../src/module-contract.js";
import type { ParseResult } from "../src/parse-result.js";
import { parseJs, parsePython } from "./helpers.js";

const PY_SOURCE = [
  "import os",
  "from .helper import thing",
  "",
  "def compute(x: int) -> int:",
  "    total = 0",
  "    for i in range(x):",
  "        total += i",
  "    return total",
  "",
].join("\n");

const JS_SOURCE =
  "import { helper } from './helper.js';\nexport function main(x) { return helper(x); }\n";

let pyResult: ParseResult;
let jsResult: ParseResult;

beforeAll(async () => {
  pyResult = await parsePython(PY_SOURCE, "pkg/main.py");
  jsResult = await parseJs(JS_SOURCE, "src/main.js");
});

describe("semantic layer determinism (AI disabled by construction)", () => {
  it("produces identical models for identical inputs", () => {
    const first = JSON.stringify(analyzeModule(pyResult));
    const second = JSON.stringify(analyzeModule(pyResult));
    expect(first).toBe(second);
    const jsFirst = JSON.stringify(analyzeModule(jsResult));
    const jsSecond = JSON.stringify(analyzeModule(jsResult));
    expect(jsFirst).toBe(jsSecond);
  });

  it("produces identical graphs and contracts for identical inputs", () => {
    const graph = () =>
      JSON.stringify(
        buildModuleGraph([
          { filename: "pkg/main.py", parseResult: pyResult },
          { filename: "pkg/helper.py", parseResult: pyResult },
          { filename: "src/main.js", parseResult: jsResult },
        ]),
      );
    expect(graph()).toBe(graph());
    const contract = () =>
      JSON.stringify(
        extractModuleContract({
          filename: "src/main.js",
          source: JS_SOURCE,
          parseResult: jsResult,
          model: analyzeModule(jsResult),
        }),
      );
    expect(contract()).toBe(contract());
  });

  it("survives mutated and truncated sources without crashing (fixed offsets)", async () => {
    for (const cut of [0, 1, 7, 23, PY_SOURCE.length - 1]) {
      const truncated = PY_SOURCE.slice(0, cut);
      let parsed: ParseResult;
      try {
        // Parse failures are expected for truncations; they must be structured errors.
        parsed = await parsePython(truncated, "truncated.py");
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        continue;
      }
      const model = analyzeModule(parsed);
      expect(model.rootScopeId.length).toBeGreaterThan(0);
    }
  });

  it("keeps ordinary project graphs fast (sanity, not a benchmark)", async () => {
    const inputs: Array<{ filename: string; parseResult: ParseResult }> = [
      { filename: "pkg/m000.py", parseResult: pyResult },
    ];
    for (let i = 1; i < 60; i += 1) {
      const previous = `m${String(i - 1).padStart(3, "0")}`;
      const current = `m${String(i).padStart(3, "0")}`;
      const source = `from .${previous} import x\nx = ${i}\n`;
      inputs.push({
        filename: `pkg/${current}.py`,
        parseResult: await parsePython(source, `pkg/${current}.py`),
      });
    }
    const started = Date.now();
    const graph = buildModuleGraph(inputs);
    const elapsed = Date.now() - started;
    expect(graph.order).toHaveLength(60);
    // Dependencies (low indices) before dependents.
    expect(graph.order.indexOf("pkg/m000.py")).toBeLessThan(graph.order.indexOf("pkg/m059.py"));
    expect(elapsed).toBeLessThan(10_000);
  });
});
