// Golden mini-PROJECT runner (roadmap M6 WS G): the three project-* fixtures are
// translated end-to-end through runProject — discovery, source translation, pytest
// mapper, sandboxed S5 (translated vitest) and S6 (differential vs the sandboxed
// source run) — and must reach the manifest's claim level with the declared
// matched-test surface. The emitted tree and .ctrans/ artifacts are pinned under
// expected/ (accept mode: FIXTURES_ACCEPT_PROJECTS=1 — review the diff, AGENTS §11).
//
// Capability gate (testing.md §4): these goldens execute code, so they need
// enforced network isolation (bwrap) + python3. On hosts without them the runner
// asserts the HONEST refusal path (stages skipped, no silent downgrade) instead of
// the level-5 claims.
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";
import { format } from "prettier";

import { detectCapabilities } from "@ctrans/sandbox";

import { runnerToolchain } from "../apps/cli/src/main.ts";
import { runProject, type ProjectRunReport } from "../apps/cli/src/project-run.ts";

const exec = promisify(execFile);
const FIXTURES_ROOT = new URL("./fixtures/", import.meta.url).pathname;
const ACCEPT = process.env["FIXTURES_ACCEPT_PROJECTS"] === "1";

interface ProjectManifest {
  name: string;
  description: string;
  expectedClaimLevel: number;
  expectedDecisionCounts: Record<string, string | number>;
  expectedWarnings?: string[];
  expectedMatchedTests: string[];
}

const PROJECT_FIXTURES = readdirSync(FIXTURES_ROOT, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && entry.name.startsWith("project-"))
  .map((entry) => entry.name)
  .sort();

let workspace: string | null = null;
let capabilities: Awaited<ReturnType<typeof detectCapabilities>> | null = null;
let pythonAvailable = true;

beforeAll(async () => {
  capabilities = await detectCapabilities();
  try {
    await exec("python3", ["--version"]);
  } catch {
    pythonAvailable = false;
  }
  workspace = join(tmpdir(), `ctrans-golden-projects-${String(process.pid)}`);
  rmSync(workspace, { recursive: true, force: true });
  mkdirSync(workspace, { recursive: true });
});

async function runFixture(fixture: string): Promise<ProjectRunReport> {
  return runProject({
    sourceRoot: join(FIXTURES_ROOT, fixture, "input"),
    outputRoot: join(workspace!, fixture, "out"),
    target: "typescript",
    intMode: "number",
    sandbox: capabilities!,
    nodePath: process.execPath,
    pythonPath: "python3",
    ...runnerToolchain(),
    timeoutMs: 180000,
  });
}

function manifestFor(fixture: string): ProjectManifest {
  return JSON.parse(
    readFileSync(join(FIXTURES_ROOT, fixture, "manifest.json"), "utf8"),
  ) as ProjectManifest;
}

describe("golden mini-projects (roadmap M6 WS G)", () => {
  it("sandbox refusal path: without enforced isolation the stages are skipped honestly", () => {
    if (capabilities!.bwrap.available && pythonAvailable) return;
    // Covered per-fixture below: every project assertion branches on the
    // capability report, refusing execution rather than downgrading.
    expect(capabilities!.networkIsolation).toBe("policy-only");
  });

  for (const fixture of PROJECT_FIXTURES) {
    it(`${fixture}: translate, run, and differentially verify`, async () => {
      const manifest = manifestFor(fixture);
      const report = await runFixture(fixture);
      const outputRoot = join(workspace!, fixture, "out");

      if (!capabilities!.bwrap.available || !pythonAvailable) {
        // Honest refusal: S5/S6 skipped, no claim inflation (no silent downgrade).
        expect(
          report.skipped.some(
            (skip) => skip.what === "S5-tests" && skip.reason.includes("isolation"),
          ) ||
            report.stages.some((stage) => stage.stage === "S5-tests" && stage.status === "skipped"),
        ).toBe(true);
        return;
      }

      // S5: the translated vitest suite runs under the sandbox and passes.
      expect(report.s5, "S5 ran").not.toBeNull();
      expect(report.s5!.status, report.s5!.details.join("; ")).toBe("pass");

      // S6: per-test differential evidence, pinned by name.
      expect(report.s6, "S6 ran").not.toBeNull();
      expect(report.s6!.status, report.s6!.reason ?? "s6 pass").toBe("pass");
      const matchedNames = report.s6!.matched.map((entry) => entry.name).sort();
      expect(matchedNames, "differential matched names").toEqual(
        [...manifest.expectedMatchedTests].sort(),
      );
      expect(report.s6!.mismatched).toEqual([]);
      expect(report.s6!.sourceOnly).toEqual([]);
      expect(report.s6!.targetOnly).toEqual([]);

      // Claim ladder + decision/warning expectations.
      expect(report.pipeline.report.claimLevel, "claim level").toBe(manifest.expectedClaimLevel);
      for (const [kind, expected] of Object.entries(manifest.expectedDecisionCounts)) {
        const actual = report.pipeline.report.decisionTotals[kind] as number | undefined;
        if (typeof expected === "number") {
          expect(actual, `decision ${kind}`).toBe(expected);
        } else if (typeof expected === "string" && expected.startsWith(">=")) {
          expect(actual, `decision ${kind} (>= ${expected.slice(2)})`).toBeGreaterThanOrEqual(
            Number(expected.slice(2)),
          );
        }
      }
      for (const warning of manifest.expectedWarnings ?? []) {
        expect(report.pipeline.report.warnings).toContain(warning);
      }

      // Emitted tree + .ctrans/ artifacts pinned under expected/ (deterministic).
      const emittedPaths: string[] = [];
      const walkEmitted = (root: string, relative: string): void => {
        for (const entry of readdirSync(join(root, relative), { withFileTypes: true })) {
          const child = relative === "" ? entry.name : `${relative}/${entry.name}`;
          if (entry.isDirectory()) walkEmitted(root, child);
          else emittedPaths.push(child);
        }
      };
      walkEmitted(outputRoot, "");
      const expectedDir = join(FIXTURES_ROOT, fixture, "expected");
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
          const actual = readFileSync(join(outputRoot, path), "utf8");
          const expected = readFileSync(join(expectedDir, path), "utf8");
          if (path.endsWith(".ts")) {
            const normalized = await format(actual, { parser: "typescript" });
            expect(normalized, `${fixture}/${path}`).toBe(
              expected.endsWith("\n") ? expected : expected + "\n",
            );
          } else {
            expect(actual, `${fixture}/${path}`).toBe(
              expected.endsWith("\n") ? expected : expected + "\n",
            );
          }
        }
      }
    }, 300000);
  }
});
