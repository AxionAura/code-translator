// Reverse golden (roadmap M7 WS H): a JavaScript mini-project translates through
// the real CLI pipeline to Python and validates: S1 re-parse (bridge), S2 pyright
// (pinned), S3 dependency resolution. The emitted tree is pinned under expected/
// (accept mode FIXTURES_ACCEPT_REVERSE=1 — review the diff, AGENTS §11).
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

import { checkPath } from "../apps/cli/src/translate.ts";
import { translatePath } from "../apps/cli/src/translate.ts";

const FIXTURE = new URL("./fixtures/reverse-js-project/", import.meta.url).pathname;
const ACCEPT = process.env["FIXTURES_ACCEPT_REVERSE"] === "1";

let workspace: string;

beforeAll(() => {
  workspace = join(tmpdir(), `ctrans-reverse-golden-${String(process.pid)}`);
  rmSync(workspace, { recursive: true, force: true });
  mkdirSync(workspace, { recursive: true });
});

describe("reverse golden: JS project → Python (roadmap M7)", () => {
  it("validates at the documented claim level with the pinned emitted tree", async () => {
    const outcome = await checkPath(join(FIXTURE, "input"), "python");
    // Claim level 3: S1 (bridge re-parse) + S2 (pyright) + S3 (dependencies).
    // S5/S6 are Python-target stages that require reverse test translation
    // (roadmap: later milestone) — the ladder caps honestly at 3.
    expect(outcome.report.claimLevel).toBe(3);
    const stages = new Map(outcome.report.validationStages.map((stage) => [stage.stage, stage]));
    expect(stages.get("S1-syntax")?.status).toBe("pass");
    expect(stages.get("S2-types")?.status, "pyright errors").toBe("pass");
    expect(stages.get("S3-dependencies")?.status).toBe("pass");
    expect(
      outcome.report.decisionTotals.unsupported,
      "no unsupported constructs in the golden",
    ).toBe(0);

    const outputRoot = join(workspace, "out");
    await translatePath(join(FIXTURE, "input"), "python", outputRoot);

    const emittedPaths: string[] = [];
    const walk = (relative: string): void => {
      for (const entry of readdirSync(join(outputRoot, relative), { withFileTypes: true })) {
        const child = relative === "" ? entry.name : `${relative}/${entry.name}`;
        if (entry.isDirectory()) walk(child);
        else emittedPaths.push(child);
      }
    };
    walk("");
    const expectedDir = join(FIXTURE, "expected");
    if (ACCEPT) {
      rmSync(expectedDir, { recursive: true, force: true });
      mkdirSync(expectedDir, { recursive: true });
      for (const path of emittedPaths) {
        const destination = join(expectedDir, path);
        mkdirSync(join(destination, ".."), { recursive: true });
        writeFileSync(destination, readFileSync(join(outputRoot, path), "utf8"));
      }
    } else {
      expect(existsSync(expectedDir), "expected/ directory present").toBe(true);
      const expectedPaths: string[] = [];
      const walkExpected = (relative: string): void => {
        for (const entry of readdirSync(join(expectedDir, relative), { withFileTypes: true })) {
          const child = relative === "" ? entry.name : `${relative}/${entry.name}`;
          if (entry.isDirectory()) walkExpected(child);
          else expectedPaths.push(child);
        }
      };
      walkExpected("");
      expect(emittedPaths.sort()).toEqual(expectedPaths.sort());
      for (const path of emittedPaths) {
        expect(readFileSync(join(outputRoot, path), "utf8"), `${path}`).toBe(
          readFileSync(join(expectedDir, path), "utf8"),
        );
      }
    }
  }, 300000);
});
