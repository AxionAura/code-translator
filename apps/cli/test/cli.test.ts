import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { runCli } from "../src/main.js";

const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  version: string;
};

describe("runCli", () => {
  it("prints help on no arguments and --help", () => {
    for (const argv of [[], ["-h"], ["--help"]]) {
      const result = runCli(argv);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("Usage: ctrans");
      expect(result.stderr).toBe("");
    }
  });

  it("prints the package version on --version", () => {
    const result = runCli(["--version"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(`${manifest.version}\n`);
  });

  it("rejects unknown options without pretending translation exists", () => {
    const result = runCli(["translate", "x.py"]);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("do not exist yet");
  });
});
