import { beforeAll, describe, expect, it } from "vitest";

import { buildModuleGraph } from "../src/module-graph.js";
import type { ParseResult } from "../src/parse-result.js";
import { parseJs, parsePython } from "./helpers.js";

let py: (source: string, filename?: string) => Promise<ParseResult>;
let js: (
  source: string,
  filename?: string,
  language?: "javascript" | "typescript",
) => Promise<ParseResult>;

beforeAll(async () => {
  py = parsePython;
  js = parseJs;
});

describe("module graph", () => {
  it("resolves python absolute imports against the file set; stdlib stays external", async () => {
    const inputs = [
      {
        filename: "proj/main.py",
        parseResult: await py(
          "import proj.util\nfrom proj.util import thing\nimport os\n",
          "proj/main.py",
        ),
      },
      { filename: "proj/util.py", parseResult: await py("thing = 1\n", "proj/util.py") },
      { filename: "proj/__init__.py", parseResult: await py("", "proj/__init__.py") },
    ];
    const graph = buildModuleGraph(inputs);
    const main = graph.modules["proj/main.py"]!;
    const statuses = main.imports.map((entry) => [
      entry.specifier,
      entry.status,
      entry.resolvedModuleId,
    ]);
    expect(statuses).toEqual([
      ["proj.util", "resolved", "proj/util.py"],
      ["proj.util", "resolved", "proj/util.py"],
      ["os", "external", null],
    ]);
    expect(graph.externalModules).toEqual(["os"]);
  });

  it("resolves python relative imports including packages", async () => {
    const inputs = [
      {
        filename: "pkg/mod.py",
        parseResult: await py(
          "from . import helper\nfrom .helper import thing\nfrom ..other import x\n",
          "pkg/mod.py",
        ),
      },
      { filename: "pkg/__init__.py", parseResult: await py("", "pkg/__init__.py") },
      { filename: "pkg/helper.py", parseResult: await py("thing = 1\n", "pkg/helper.py") },
      { filename: "other.py", parseResult: await py("x = 1\n", "other.py") },
    ];
    const graph = buildModuleGraph(inputs);
    const mod = graph.modules["pkg/mod.py"]!;
    expect(mod.imports.map((entry) => [entry.specifier, entry.resolvedModuleId])).toEqual([
      [".", "pkg/__init__.py"],
      [".helper", "pkg/helper.py"],
      ["..other", "other.py"],
    ]);
  });

  it("reports unresolved relative imports as warnings (never guesses)", async () => {
    const inputs = [
      { filename: "pkg/mod.py", parseResult: await py("from .missing import x\n", "pkg/mod.py") },
    ];
    const graph = buildModuleGraph(inputs);
    expect(graph.modules["pkg/mod.py"]!.imports[0]!.status).toBe("unresolved");
    expect(graph.diagnostics.some((d) => d.code === "SEM-UNRESOLVED-MODULE")).toBe(true);
  });

  it("resolves js/ts relative imports with extension and index handling", async () => {
    const inputs = [
      {
        filename: "src/a.ts",
        parseResult: await js(
          "import { b } from './b.js';\nimport './c';\nimport util from './util.ts';\n",
          "src/a.ts",
          "typescript",
        ),
      },
      {
        filename: "src/b.ts",
        parseResult: await js("export const b = 1;\n", "src/b.ts", "typescript"),
      },
      { filename: "src/c.ts", parseResult: await js("export {};\n", "src/c.ts", "typescript") },
      {
        filename: "src/util.ts",
        parseResult: await js("export default 1;\n", "src/util.ts", "typescript"),
      },
    ];
    const graph = buildModuleGraph(inputs);
    const a = graph.modules["src/a.ts"]!;
    expect(a.imports.map((entry) => [entry.specifier, entry.resolvedModuleId])).toEqual([
      ["./b.js", "src/b.ts"],
      ["./c", "src/c.ts"],
      ["./util.ts", "src/util.ts"],
    ]);
  });

  it("marks bare specifiers as external and records dynamic imports", async () => {
    const inputs = [
      {
        filename: "app.js",
        parseResult: await js(
          "import fs from 'node:fs';\nimport lodash from 'lodash';\nconst m = await import('./late.js');\n",
          "app.js",
        ),
      },
      { filename: "late.js", parseResult: await js("export default 1;\n", "late.js") },
    ];
    const graph = buildModuleGraph(inputs);
    const app = graph.modules["app.js"]!;
    expect(
      app.imports.filter((entry) => entry.status === "external").map((entry) => entry.specifier),
    ).toEqual(["node:fs", "lodash", "(dynamic)"]);
    expect(app.imports.find((entry) => entry.importKind === "dynamic")?.span).not.toBeNull();
    expect(graph.externalModules).toEqual(["(dynamic)", "lodash", "node:fs"]);
  });

  it("detects python __main__ guards and test modules", async () => {
    const inputs = [
      {
        filename: "tool.py",
        parseResult: await py(
          "def main():\n    pass\n\nif __name__ == '__main__':\n    main()\n",
          "tool.py",
        ),
      },
      {
        filename: "tests/test_tool.py",
        parseResult: await py("def test_tool():\n    pass\n", "tests/test_tool.py"),
      },
    ];
    const graph = buildModuleGraph(inputs);
    expect(graph.modules["tool.py"]!.isEntry).toBe(true);
    expect(graph.modules["tests/test_tool.py"]!.isTestModule).toBe(true);
  });

  it("groups A -> B -> C -> A into one SCC and refuses to call the graph acyclic", async () => {
    const inputs = [
      { filename: "a.py", parseResult: await py("from .b import x\n", "a.py") },
      { filename: "b.py", parseResult: await py("from .c import y\n", "b.py") },
      { filename: "c.py", parseResult: await py("from .a import z\n", "c.py") },
    ];
    const graph = buildModuleGraph(inputs);
    expect(graph.sccs).toEqual([["a.py", "b.py", "c.py"]]);
    expect(graph.order).toEqual(["a.py", "b.py", "c.py"]);
    expect(graph.diagnostics.some((d) => d.code === "SEM-CYCLE" && d.severity === "info")).toBe(
      true,
    );
  });

  it("orders acyclic chains dependencies-first and separates independent SCCs", async () => {
    const inputs = [
      {
        filename: "main.py",
        parseResult: await py("from .util import u\nfrom .helpers.leaf import l\n", "main.py"),
      },
      { filename: "util.py", parseResult: await py("from .helpers.leaf import l\n", "util.py") },
      { filename: "helpers/leaf.py", parseResult: await py("l = 1\n", "helpers/leaf.py") },
      { filename: "x1.py", parseResult: await py("from .x2 import v\n", "x1.py") },
      { filename: "x2.py", parseResult: await py("v = 1\n", "x2.py") },
    ];
    const graph = buildModuleGraph(inputs);
    // Every SCC is a singleton (acyclic); independent chains may interleave in the
    // emission order, so compare as a set of sorted groups.
    expect([...graph.sccs].map((scc) => [...scc].sort()).sort()).toEqual([
      ["helpers/leaf.py"],
      ["main.py"],
      ["util.py"],
      ["x1.py"],
      ["x2.py"],
    ]);
    expect(graph.order.indexOf("helpers/leaf.py")).toBeLessThan(graph.order.indexOf("util.py"));
    expect(graph.order.indexOf("util.py")).toBeLessThan(graph.order.indexOf("main.py"));
    expect(graph.order.indexOf("x2.py")).toBeLessThan(graph.order.indexOf("x1.py"));
  });

  it("is deterministic across repeated builds", async () => {
    const mk = async () => {
      const inputs = [
        { filename: "a.py", parseResult: await py("from .b import x\nx = 1\n", "a.py") },
        { filename: "b.py", parseResult: await py("from .a import y\n", "b.py") },
      ];
      return buildModuleGraph(inputs);
    };
    const first = JSON.stringify(await mk());
    const second = JSON.stringify(await mk());
    expect(first).toBe(second);
  });

  it("handles hostile graphs: missing module field and self-imports", async () => {
    // A hand-built ParseResult without module info must not crash the builder.
    const bare = await py("x = 1\n");
    const stripped = { ...bare, module: null } as ParseResult;
    const graph = buildModuleGraph([{ filename: "solo.py", parseResult: stripped }]);
    expect(graph.order).toEqual(["solo.py"]);
    const selfImport = await py("import solo\n");
    const selfGraph = buildModuleGraph([{ filename: "solo.py", parseResult: selfImport }]);
    // Self-edges are ignored; the module still appears.
    expect(selfGraph.order).toEqual(["solo.py"]);
  });
});
