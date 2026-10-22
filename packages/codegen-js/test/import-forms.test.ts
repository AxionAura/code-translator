// Import-form coverage through the real unit translator: the import prologue is the
// surface CLI users hit on every multi-file project (barrels, sibling modules,
// externals, unresolved specifiers). Each case pins the emitted import/export form
// and its honest classification (ModuleContracts: re-exports follow the `__all__`
// convention; unknown absolute modules are externals; bare-relative imports need a
// package __init__.py — namespace packages are out of M4 scope).
import { beforeAll, describe, expect, it } from "vitest";

import { analyzeModule, buildModuleGraph, type ParseResult } from "@axion-ct/core";
import { createPythonBridgeParser, type PythonBridgeParser } from "@axion-ct/parser-py";
import { createPyToJsTranslator, type PyToJsTranslator } from "../src/translator.js";

let py: PythonBridgeParser;
let translator: PyToJsTranslator;

beforeAll(async () => {
  py = await createPythonBridgeParser();
  translator = await createPyToJsTranslator("typescript");
});

interface FileInput {
  readonly filename: string;
  readonly source: string;
}

async function translateProject(inputs: readonly FileInput[]): Promise<Map<string, string>> {
  const parsed: { filename: string; parseResult: ParseResult }[] = [];
  for (const input of inputs) {
    parsed.push({
      filename: input.filename,
      parseResult: await py.parse(input.source, { filename: input.filename }),
    });
  }
  const graph = buildModuleGraph(
    parsed.map((unit) => ({ filename: unit.filename, parseResult: unit.parseResult })),
  );
  for (const unit of parsed) {
    await translator.translateUnit(
      {
        filename: unit.filename,
        parseResult: unit.parseResult,
        model: analyzeModule(unit.parseResult),
      },
      graph,
    );
  }
  const shared = await translator.finalizeUnits();
  const files = new Map<string, string>();
  for (const file of shared.files) files.set(file.targetPath, file.content);
  return files;
}

describe("import prologue forms (multi-file)", () => {
  it("re-exports barrel names listed in __all__", async () => {
    const files = await translateProject([
      {
        filename: "pkg/__init__.py",
        source: 'from pkg.engine import start\n\n__all__ = ["start"]\n',
      },
      { filename: "pkg/engine.py", source: "def start():\n    return 1\n" },
    ]);
    const barrel = files.get("pkg/index.ts");
    expect(barrel).toBeDefined();
    expect(barrel).toContain('export { start } from "./engine.ts";');
  });

  it("binds non-exported from-imports as plain imports (no silent re-export)", async () => {
    const files = await translateProject([
      { filename: "pkg/__init__.py", source: "from pkg.engine import start\n" },
      { filename: "pkg/engine.py", source: "def start():\n    return 1\n" },
    ]);
    expect(files.get("pkg/index.ts")).toContain('import { start } from "./engine.ts";');
  });

  it("aliases renamed from-imports and forwards aliased __all__ re-exports", async () => {
    const files = await translateProject([
      {
        filename: "pkg/__init__.py",
        source: 'from pkg.tool import run as execute\n\n__all__ = ["execute"]\n',
      },
      { filename: "pkg/tool.py", source: "def run():\n    return 1\n" },
    ]);
    const barrel = files.get("pkg/index.ts");
    expect(barrel).toContain('export { run as execute } from "./tool.ts";');
  });

  it("binds `from . import helper` to the sibling module via the package", async () => {
    const files = await translateProject([
      { filename: "app/__init__.py", source: "" },
      {
        filename: "app/main.py",
        source: "from . import helper\n\ndef run():\n    return helper.value\n",
      },
      { filename: "app/helper.py", source: "value = 3\n" },
    ]);
    expect(files.get("app/main.ts")).toContain('import * as helper from "./helper.ts";');
  });

  it("emits external specifiers verbatim and relative-unresolved imports as comments", async () => {
    const files = await translateProject([
      {
        filename: "main.py",
        source:
          "import os\nfrom missing_mod import gone\nfrom .missing import later\n\ndef use():\n    return os.sep, gone\n",
      },
    ]);
    const module = files.get("main.ts")!;
    expect(module).toContain('import * as os from "os";');
    expect(module).toContain('import { gone } from "missing_mod";');
    expect(module).toContain('// ctrans: unresolved import ".missing"');
  });

  it("namespace-imports a local package through its barrel", async () => {
    const files = await translateProject([
      { filename: "main.py", source: "import pkg\n\ndef use():\n    return pkg.tool\n" },
      { filename: "pkg/__init__.py", source: "tool = 1\n" },
    ]);
    expect(files.get("main.ts")).toContain('import * as pkg from "./pkg/index.ts";');
  });

  it("marks module-bound from-imports of non-exported names as plain imports", async () => {
    // `from engine import start` where engine does not re-export through a barrel:
    // the import binds the name directly.
    const files = await translateProject([
      {
        filename: "main.py",
        source: "from engine import start\n\ndef go():\n    return start()\n",
      },
      { filename: "engine.py", source: "def start():\n    return 1\n" },
    ]);
    expect(files.get("main.ts")).toContain('import { start } from "./engine.ts";');
  });
});
