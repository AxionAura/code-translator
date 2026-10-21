import { beforeAll, describe, expect, it } from "vitest";

import { createRequire } from "node:module";
import { join } from "node:path";

import { PyrightTypeValidator, pyrightEntryPath } from "../src/pyright.js";

const require = createRequire(import.meta.url);
const packageJsonPath = require.resolve("pyright/package.json");
const pyrightPath = join(packageJsonPath.replace(/package\.json$/, ""), "index.js");

describe("pyright S2 adapter (WS E)", () => {
  let validator: PyrightTypeValidator;

  beforeAll(() => {
    validator = new PyrightTypeValidator({
      pyrightPath: pyrightPath || pyrightEntryPath(import.meta.url),
      nodePath: process.execPath,
      timeoutMs: 120000,
    });
  });

  it("passes strict type validation for clean generated Python", async () => {
    const result = await validator.validate([
      {
        path: "mod.py",
        content: [
          "def add(a: int, b: int) -> int:",
          "    return a + b",
          "",
          "",
          "if __name__ == '__main__':",
          "    print(add(1, 2))",
        ].join("\n"),
      },
    ]);
    expect(result.status, result.details.join("; ")).toBe("pass");
  }, 180000);

  it("fails with structured diagnostics for type errors", async () => {
    const result = await validator.validate([
      {
        path: "bad.py",
        content:
          "def add(a: int, b: int) -> int:\n    return a + b\n\n\nresult: int = add('x', 2)\n",
      },
    ]);
    expect(result.status).toBe("fail");
    expect(result.details.some((detail) => detail.includes("bad.py"))).toBe(true);
  }, 180000);

  it("resolves intra-project imports in a materialized project", async () => {
    const result = await validator.validate([
      {
        path: "pkg/util.py",
        content: "def helper(value: int) -> int:\n    return value * 2\n",
      },
      {
        path: "pkg/main.py",
        content:
          "from .util import helper\n\n\ndef run(value: int) -> int:\n    return helper(value)\n",
      },
    ]);
    expect(result.status, result.details.join("; ")).toBe("pass");
  }, 180000);

  it("reports skipped honestly when pyright cannot run", async () => {
    const broken = new PyrightTypeValidator({
      pyrightPath: "/nonexistent/pyright",
      nodePath: process.execPath,
      timeoutMs: 30000,
    });
    const result = await broken.validate([{ path: "mod.py", content: "x: int = 1\n" }]);
    expect(result.status).toBe("skipped");
    expect(result.reason).toMatch(/crashed|spawn/);
  }, 60000);
});
