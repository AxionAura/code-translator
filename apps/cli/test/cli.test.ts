// CLI tests: help/version (M0 contract, sync facade) plus the M4 translation
// commands. Translation tests cover exit codes (0 translated / 3 partially
// translated / 2 usage / 1 failure), emitted files, and .ctrans/ artifacts.
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterAll, describe, expect, it } from "vitest";

import { runCli, runCliCommand } from "../src/main.js";

const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  version: string;
};

const tempRoot = mkdtempSync(join(tmpdir(), "ctrans-cli-test-"));

afterAll(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

function writeProject(name: string, files: Record<string, string>): string {
  const root = join(tempRoot, name);
  for (const [path, content] of Object.entries(files)) {
    const absolute = join(root, path);
    mkdirSync(join(absolute, ".."), { recursive: true });
    writeFileSync(absolute, content);
  }
  return root;
}

describe("runCli (sync facade: help/version)", () => {
  it("prints help on no arguments and --help", () => {
    for (const argv of [[], ["-h"], ["--help"]]) {
      const result = runCli(argv);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("Usage: ctrans");
      expect(result.stdout).toContain("check");
      expect(result.stdout).toContain("translate");
      expect(result.stderr).toBe("");
    }
  });

  it("prints the package version on --version", () => {
    const result = runCli(["--version"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(`${manifest.version}\n`);
  });

  it("rejects translation commands on the sync facade (async only), with usage help", () => {
    const result = runCli(["translate", "x.py", "--to", "ts"]);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("runCliCommand");
  });
});

describe("runCliCommand: usage errors", () => {
  it("requires --to with a known target", async () => {
    const missing = await runCliCommand(["check", "x.py"]);
    expect(missing.code).toBe(2);
    expect(missing.stderr).toContain("--to");
    const unknownTarget = await runCliCommand(["check", "x.py", "--to", "rs"]);
    expect(unknownTarget.code).toBe(2);
    const unknownCommand = await runCliCommand(["frobnicate"]);
    expect(unknownCommand.code).toBe(2);
  });
});

describe("runCliCommand: check (in-memory pipeline)", () => {
  it("reports a clean file as translated with claim level 3 for --to ts", async () => {
    const root = writeProject("clean", {
      "calc.py": "def add(a: int, b: int) -> int:\n    return a + b\n",
    });
    const result = await runCliCommand(["check", join(root, "calc.py"), "--to", "ts"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("claim level 3");
    expect(result.stdout).toContain("S1-syntax:pass");
    expect(result.stdout).toContain("S2-types:pass");
    expect(result.stdout).toContain("calc.py -> calc.ts [translated]");
    // Emitted files are available in memory for check.
    expect(result.stdout).toContain("decisions:");
  }, 30000);

  it("reports unsupported constructs honestly: partially translated, exit code 3", async () => {
    const root = writeProject("unsupported", {
      "dispatch.py":
        "def f(x):\n    match x:\n        case 1:\n            return 1\n        case _:\n            return 0\n",
    });
    const result = await runCliCommand(["check", join(root, "dispatch.py"), "--to", "ts"]);
    expect(result.code).toBe(3);
    expect(result.stdout).toContain("dispatch.py -> dispatch.ts [partially-translated]");
    expect(result.stdout).toContain("unsupported");
    expect(result.stdout).toContain("CTW-UNSUPPORTED");
  }, 30000);

  it("skips S2 honestly for --to js (no JS type checker) and claims level 1", async () => {
    const root = writeProject("jscheck", { "m.py": "x = 1\n" });
    const result = await runCliCommand(["check", join(root, "m.py"), "--to", "js"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("claim level 1");
    expect(result.stdout).toContain("S2-types:skipped");
  });
});

describe("runCliCommand: translate (writes output + .ctrans artifacts)", () => {
  it("translates a single file to TypeScript with ledger and report", async () => {
    const root = writeProject("translate-ts", {
      "mathx.py": "def clamp(v: int, lo: int = 0) -> int:\n    return lo if v < lo else v\n",
    });
    const out = join(tempRoot, "out-ts");
    const result = await runCliCommand([
      "translate",
      join(root, "mathx.py"),
      "--to",
      "ts",
      "-o",
      out,
    ]);
    expect(result.code).toBe(0);
    const emitted = readFileSync(join(out, "mathx.ts"), "utf8");
    expect(emitted).toContain("export function clamp(v: number, lo: number = 0): number");
    expect(readFileSync(join(out, ".ctrans", "ledger.json"), "utf8")).toContain("py.IfExp");
    const report = JSON.parse(readFileSync(join(out, ".ctrans", "report.json"), "utf8")) as {
      claimLevel: number;
    };
    // S3 (M5) runs and passes for this import-free file: claim level 3.
    expect(report.claimLevel).toBe(3);
  }, 30000);

  it("translates a multi-file project, rewriting local imports to target paths", async () => {
    const root = writeProject("translate-project", {
      "pkg/__init__.py": "from .helper import thing\n",
      "pkg/helper.py": "thing = 1\n",
      "pkg/main.py": "from .helper import thing\n\ndef use() -> int:\n    return thing\n",
    });
    const out = join(tempRoot, "out-project");
    const result = await runCliCommand(["translate", root, "--to", "ts", "-o", out]);
    expect(result.code).toBe(0);
    // Dependency-first order: helper and barrel before main.
    expect(result.stdout.indexOf("pkg/helper.py")).toBeLessThan(
      result.stdout.indexOf("pkg/main.py"),
    );
    expect(existsSync(join(out, "pkg", "index.ts"))).toBe(true);
    expect(existsSync(join(out, "pkg", "helper.ts"))).toBe(true);
    const main = readFileSync(join(out, "pkg", "main.ts"), "utf8");
    expect(main).toContain('import { thing } from "./helper.ts"');
  }, 30000);

  it("translates to JavaScript without type annotations and claims level 1", async () => {
    const root = writeProject("translate-js", {
      "simple.py": "def f(a: int) -> int:\n    return a // 2\n",
    });
    const out = join(tempRoot, "out-js");
    const result = await runCliCommand([
      "translate",
      join(root, "simple.py"),
      "--to",
      "js",
      "-o",
      out,
    ]);
    expect(result.code).toBe(0);
    const emitted = readFileSync(join(out, "simple.js"), "utf8");
    expect(emitted).toContain("__ctrans_floorDiv(a, 2)");
    expect(emitted).not.toContain(": number");
    // The JS runtime is type-stripped (ADR D-022): valid plain JavaScript — no type
    // annotation syntax may survive in signatures.
    const runtime = readFileSync(join(out, "__ctrans_runtime.js"), "utf8");
    expect(runtime).toContain("export function __ctrans_floorDiv(a, b)");
    expect(runtime).not.toMatch(/function\s+\w+\s*\((?:\.\.\.)?\w+:\s/);
    expect(result.stdout).toContain("claim level 1");
  });

  it("fails with a structured error for a path with no Python files", async () => {
    const root = writeProject("empty-project", { "README.txt": "not code\n" });
    const result = await runCliCommand(["check", root, "--to", "ts"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("no translatable source files");
  });
});

describe("ctrans executable (bin/ctrans.mjs)", () => {
  const run = promisify(execFile);

  it("prints help and runs a translation end-to-end", async () => {
    const bin = new URL("../bin/ctrans.mjs", import.meta.url);
    const help = await run(process.execPath, [bin.pathname, "--help"]);
    expect(help.stdout).toContain("Usage: ctrans");
    const root = writeProject("bin-e2e", { "hi.py": "print('hello')\n" });
    const out = join(tempRoot, "out-bin");
    const translated = await run(process.execPath, [
      bin.pathname,
      "translate",
      join(root, "hi.py"),
      "--to",
      "js",
      "-o",
      out,
    ]);
    expect(translated.stdout).toContain("hi.py -> hi.js");
    const emitted = readFileSync(join(out, "hi.js"), "utf8");
    expect(emitted).toContain("__ctrans_print");
  }, 60000);
});
