import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPythonBridgeParser, type PythonBridgeParser } from "../src/client.js";

let parser: PythonBridgeParser;
const tempDirs: string[] = [];

beforeAll(async () => {
  parser = await createPythonBridgeParser();
});

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

// A module whose mere IMPORT (not parse) would produce observable side effects:
// subprocess, file writes, decorator execution, default-value execution, sys.exit.
const HOSTILE_SOURCE = [
  "import subprocess",
  "import sys",
  "subprocess.run(['touch', 'MARKER-subprocess'])",
  "open('MARKER-open', 'w').write('pwned')",
  "def decorator(fn):",
  "    open('MARKER-decorator', 'w').write('ran')",
  "    return fn",
  "@decorator",
  "def f(): pass",
  "def g(x=open('MARKER-default', 'w')): pass",
  "sys.exit(9)",
  "",
].join("\n");

// If any of those side effects ran, one of these files would exist in the bridge's cwd.
const MARKERS = ["MARKER-subprocess", "MARKER-open", "MARKER-decorator", "MARKER-default"];

function markersIn(dir: string): string[] {
  return readdirSync(dir).filter((entry) => MARKERS.includes(entry));
}

describe("security boundary: parsing never executes source", () => {
  it("parses hostile module-level code without side effects in the bridge cwd", async () => {
    const cwdBefore = process.cwd();
    const result = await parser.parse(HOSTILE_SOURCE, { filename: "evil.py" });
    expect(result.ast.kind).toBe("Module");
    expect((result.ast.fields["body"] as unknown[]).length).toBeGreaterThan(5);
    expect(markersIn(cwdBefore)).toEqual([]);
    expect(process.cwd()).toBe(cwdBefore); // the bridge never chdirs its parent
  });

  it("cannot import user modules: cwd is not on the bridge's import path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ctrans-hostile-"));
    tempDirs.push(dir);
    // A sibling module with a side effect at module level, imported by the parsed source.
    writeFileSync(join(dir, "side_effect_module.py"), "open('MARKER-import', 'w')\n");
    const source = "import side_effect_module\n";
    await parser.parse(source);
    expect(existsSync(join(dir, "MARKER-import"))).toBe(false);
    expect(existsSync(join(process.cwd(), "MARKER-import"))).toBe(false);
  });

  it("runs the bridge in isolated mode (-I): PYTHONPATH is ignored", async () => {
    // Spawn the real interpreter the way the client does, with a PYTHONPATH entry that
    // would let `import hostile_probe` resolve; the bridge imports only stdlib, and the
    // parse contract never imports user modules, so the probe can never run.
    const dir = mkdtempSync(join(tmpdir(), "ctrans-isolated-"));
    tempDirs.push(dir);
    writeFileSync(join(dir, "hostile_probe.py"), "raise SystemExit(7)\n");
    const output = execFileSync(
      "python3",
      ["-I", "-B", new URL("../python/bridge.py", import.meta.url).pathname, "--mode", "parse"],
      {
        input: "import hostile_probe\nx = 1\n",
        env: { PATH: process.env["PATH"] ?? "", PYTHONPATH: dir },
      },
    );
    expect(output.toString("utf8")).toContain('"ok": true');
    expect(existsSync(join(dir, "__pycache__"))).toBe(false); // -B: no bytecode files
  });
});
