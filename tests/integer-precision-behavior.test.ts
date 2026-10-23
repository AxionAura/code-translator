// Sandbox-backed behavior check for the P0 integer-precision fix. The source
// Python and the generated JavaScript each execute under @axion-ct/sandbox; the
// host never executes generated output. This complements the ledger/report tests:
// it proves that the safe boundary remains exact in number mode and that bigint
// mode preserves a value that cannot fit safely in a JS number.
import { beforeAll, describe, expect, it } from "vitest";

import { analyzeModule, buildModuleGraph } from "@axion-ct/core";
import { createPyToJsTranslator, type PyToJsTranslator } from "@axion-ct/codegen-js";
import { createPythonBridgeParser, type PythonBridgeParser } from "@axion-ct/parser-py";
import { detectCapabilities, SandboxRunner } from "@axion-ct/sandbox";

let py: PythonBridgeParser;
let capabilities: Awaited<ReturnType<typeof detectCapabilities>>;

beforeAll(async () => {
  py = await createPythonBridgeParser();
  capabilities = await detectCapabilities();
});

async function translateToJs(
  translator: PyToJsTranslator,
  source: string,
): Promise<Record<string, string>> {
  const filename = "mod.py";
  const parseResult = await py.parse(source, { filename });
  const unit = { filename, parseResult, model: analyzeModule(parseResult) };
  const graph = buildModuleGraph([{ filename, parseResult }]);
  const emission = await translator.translateUnit(unit, graph);
  const shared = await translator.finalizeUnits();
  const files: Record<string, string> = {};
  for (const file of [...emission.files, ...shared.files]) files[file.targetPath] = file.content;
  return files;
}

async function run(
  files: Readonly<Record<string, string>>,
  argv: readonly string[],
): Promise<string> {
  const runner = new SandboxRunner({ capabilities });
  const result = await runner.run({
    argv: [...argv],
    files: Object.entries(files).map(([path, content]) => ({ path, content })),
    timeoutMs: 60000,
    stdoutCapBytes: 1024 * 1024,
    stderrCapBytes: 1024 * 1024,
    requireNetworkIsolation: true,
  });
  if (result.outcome !== "completed") {
    throw new Error(`sandbox run ${result.outcome}: ${result.stderr.slice(0, 300)}`);
  }
  return result.stdout.trim();
}

const PY_HARNESS = "from mod import value\nprint(value())\n";
const JS_HARNESS = 'import { value } from "./mod.js";\nconsole.log(String(value()));\n';

describe("P0 integer precision: sandbox behavior", () => {
  it("keeps 2 ** 53 - 1 exact in number mode", async () => {
    if (capabilities.networkIsolation !== "enforced") {
      console.log("[skip] enforced isolation unavailable; behavior assertion skipped");
      return;
    }
    const source = "def value():\n    return 2 ** 53 - 1\n";
    const target = await translateToJs(
      await createPyToJsTranslator("javascript", { intMode: "number" }),
      source,
    );
    const sourceOut = await run({ "mod.py": source, "harness.py": PY_HARNESS }, [
      "python3",
      "harness.py",
    ]);
    const targetOut = await run({ ...target, "harness.mjs": JS_HARNESS }, [
      process.execPath,
      "harness.mjs",
    ]);
    expect(targetOut).toBe(sourceOut);
  }, 180000);

  it("preserves 2 ** 100 exactly in bigint mode", async () => {
    if (capabilities.networkIsolation !== "enforced") {
      console.log("[skip] enforced isolation unavailable; behavior assertion skipped");
      return;
    }
    const source = "def value():\n    return 2 ** 100\n";
    const target = await translateToJs(
      await createPyToJsTranslator("javascript", { intMode: "bigint" }),
      source,
    );
    const sourceOut = await run({ "mod.py": source, "harness.py": PY_HARNESS }, [
      "python3",
      "harness.py",
    ]);
    const targetOut = await run({ ...target, "harness.mjs": JS_HARNESS }, [
      process.execPath,
      "harness.mjs",
    ]);
    expect(targetOut).toBe(sourceOut);
    expect(targetOut).toBe("1267650600228229401496703205376");
  }, 180000);
});
