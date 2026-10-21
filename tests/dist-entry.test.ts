// Compiled distribution entry (M11): the packaged bin must run from dist without
// repository TypeScript sources. Builds once if dist is absent, then exercises the
// real CLI entry point.
import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const exec = promisify(execFile);
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DIST_ENTRY = join(ROOT, "apps/cli/bin/ctrans-dist.mjs");
const DIST_MAIN = join(ROOT, "apps/cli/dist/main.js");
const workspace = mkdtempSync(join(tmpdir(), "ctrans-dist-e2e-"));
afterAll(() => rmSync(workspace, { recursive: true, force: true }));

beforeAll(() => {
  if (!existsSync(DIST_MAIN)) {
    execFileSync("pnpm", ["build"], {
      cwd: ROOT,
      stdio: "ignore",
      timeout: 300000,
    });
  }
}, 320000);

describe("compiled distribution", () => {
  it("emits dist entries and package exports that point at them", () => {
    expect(existsSync(DIST_MAIN)).toBe(true);
    expect(existsSync(join(ROOT, "packages/core/dist/index.js"))).toBe(true);
    const core = JSON.parse(readFileSync(join(ROOT, "packages/core/package.json"), "utf8")) as {
      version: string;
      exports: { ".": { default: string } };
      files: string[];
    };
    expect(core.version).toBe("0.1.0");
    expect(core.exports["."].default).toBe("./dist/index.js");
    expect(core.files).toContain("dist");
    const cli = JSON.parse(readFileSync(join(ROOT, "apps/cli/package.json"), "utf8")) as {
      bin: { ctrans: string };
      files: string[];
    };
    expect(cli.bin.ctrans).toBe("./bin/ctrans-dist.mjs");
    expect(cli.files).toContain("dist");
    // Compiled sources reference sibling .js modules, never repository .ts files.
    const main = readFileSync(DIST_MAIN, "utf8");
    expect(main).not.toMatch(/from "\.\/[^"]+\.ts"/);
  });

  it("reports the release version and translates via the dist entry", async () => {
    const version = await exec(process.execPath, [DIST_ENTRY, "--version"], { cwd: ROOT });
    expect(version.stdout.trim()).toBe("0.1.0");
    const source = join(workspace, "calc.py");
    writeFileSync(source, "def add(a: int, b: int) -> int:\n    return a + b\n", "utf8");
    const checked = await exec(process.execPath, [DIST_ENTRY, "check", source, "--to", "ts"], {
      cwd: ROOT,
      timeout: 120000,
    });
    expect(checked.stdout).toContain("claim level 3");
    const out = join(workspace, "out");
    await exec(process.execPath, [DIST_ENTRY, "translate", source, "--to", "ts", "-o", out], {
      cwd: ROOT,
      timeout: 120000,
    });
    expect(readFileSync(join(out, "calc.ts"), "utf8")).toContain("function add");
  }, 180000);
});
