// Golden fixture runner (docs/testing.md §2): every fixture under tests/fixtures/
// is run through the pipeline; the emitted tree must match expected/ (after
// canonical formatting), and report/claim/decision/warning expectations from
// manifest.json must hold — goldens verify honesty, not just bytes.
//
// Acceptance mode: `pnpm fixtures:accept` regenerates expected/ from the engine
// (review the diff before committing; auto-accepting without review is a
// forbidden shortcut, AGENTS.md §11).
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { format } from "prettier";

import type { PipelineInput } from "@ctrans/core";
import { runPipeline, type TargetLanguage } from "@ctrans/core";
import { createPyToJsTranslator } from "@ctrans/codegen-js";
import { createRegistryLookup } from "@ctrans/registry";
import { createPythonBridgeParser, type PythonParser } from "@ctrans/parser-py";
import { createOxcSyntaxValidator, OracleTypeValidator } from "@ctrans/parser-js";

const FIXTURES_ROOT = new URL("./fixtures/", import.meta.url).pathname;
const ACCEPT = process.env["FIXTURES_ACCEPT"] === "1";

interface FixtureManifest {
  name: string;
  description: string;
  from: string;
  to: string;
  entry?: string[];
  expectedClaimLevel: number;
  expectedDecisionCounts: Record<string, number | string>;
  expectedWarnings?: string[];
}

function listFixtures(): string[] {
  return readdirSync(FIXTURES_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function collectInputs(fixtureDir: string): string[] {
  // Module ids STRIP the input/ prefix (matching the CLI's directory translation):
  // Python 3 implicit-relative imports resolve against the project root, so the
  // prefixed ids would misclassify intra-project imports as external.
  const inputs: string[] = [];
  const walk = (relative: string): void => {
    for (const entry of readdirSync(join(fixtureDir, relative), { withFileTypes: true })) {
      const child = relative === "" ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) walk(child);
      else if (entry.name.endsWith(".py")) {
        inputs.push(child.startsWith("input/") ? child.slice("input/".length) : child);
      }
    }
  };
  walk("");
  return inputs.sort();
}

function manifestFor(fixture: string): FixtureManifest {
  const path = join(FIXTURES_ROOT, fixture, "manifest.json");
  return JSON.parse(readFileSync(path, "utf8")) as FixtureManifest;
}

async function runFixture(
  py: PythonParser,
  fixture: string,
): Promise<{ report: ReturnType<typeof JSON.parse>; files: Map<string, string> }> {
  const manifest = manifestFor(fixture);
  const target: TargetLanguage = manifest.to === "typescript" ? "typescript" : "javascript";
  const fixtureDir = join(FIXTURES_ROOT, fixture);
  const inputs: PipelineInput[] = [];
  for (const moduleFile of collectInputs(fixtureDir)) {
    const source = readFileSync(join(fixtureDir, "input", moduleFile), "utf8");
    inputs.push({
      filename: moduleFile,
      parseResult: await py.parse(source, { filename: moduleFile }),
    });
  }
  const result = await runPipeline(
    inputs,
    {
      target,
      translateUnit: await createPyToJsTranslator(target, { registry: createRegistryLookup() }),
      validateSyntax: await createOxcSyntaxValidator(),
      validateTypes: new OracleTypeValidator(),
      // Same wiring as the CLI: sync-to-async boundary propagation + S3 data.
      asyncBoundaryModules: ["requests"],
    },
    {
      sourceImports: collectSourceImports(inputs),
      mappedModules: new Set(["math", "json", "sys", "random", "requests"]),
      unsupportedModules: new Set(["ctypes", "curses", "tkinter"]),
    },
  );
  const files = new Map<string, string>();
  for (const file of result.emittedFiles) files.set(file.targetPath, file.content);
  return { report: result.report as unknown as ReturnType<typeof JSON.parse>, files };
}

function collectSourceImports(inputs: readonly PipelineInput[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const input of inputs) {
    map.set(
      input.filename,
      (input.parseResult.module?.imports ?? []).map((entry) => entry.moduleSpecifier),
    );
  }
  return map;
}

describe("golden fixtures (docs/testing.md §2)", () => {
  let py: PythonParser;

  it("prepares the parser", async () => {
    py = await createPythonBridgeParser();
    expect(py).toBeDefined();
  }, 60000);

  for (const fixture of listFixtures()) {
    it(
      fixture,
      async () => {
        expect(py).toBeDefined();
        const manifest = manifestFor(fixture);
        const { report, files } = await runFixture(py, fixture);

        // Claim ladder + decision counts + warnings (honesty assertions).
        expect(report.claimLevel, "claim level").toBe(manifest.expectedClaimLevel);
        for (const [kind, expected] of Object.entries(manifest.expectedDecisionCounts)) {
          const actual = report.decisionTotals[kind] as number | undefined;
          if (typeof expected === "number") {
            expect(actual, `decision ${kind} (exact)`).toBe(expected);
          } else if (typeof expected === "string" && expected.startsWith(">=")) {
            const minimum = Number(expected.slice(2));
            expect(actual, `decision ${kind} (>= ${String(minimum)})`).toBeGreaterThanOrEqual(
              minimum,
            );
          }
        }
        for (const warning of manifest.expectedWarnings ?? []) {
          expect(report.warnings).toContain(warning);
        }

        // Emitted tree must match expected/ after canonical formatting.
        const expectedDir = join(FIXTURES_ROOT, fixture, "expected");
        const targetPaths = [...files.keys()].sort();
        if (ACCEPT) {
          rmSync(expectedDir, { recursive: true, force: true });
          mkdirSync(expectedDir, { recursive: true });
          for (const path of targetPaths) {
            const destination = join(expectedDir, path);
            mkdirSync(join(destination, ".."), { recursive: true });
            writeFileSync(destination, files.get(path));
          }
        } else {
          expect(existsSync(expectedDir), "expected/ directory present").toBe(true);
          const expectedPaths: string[] = [];
          const walk = (relative: string): void => {
            for (const entry of readdirSync(join(expectedDir, relative), { withFileTypes: true })) {
              const child = relative === "" ? entry.name : `${relative}/${entry.name}`;
              if (entry.isDirectory()) walk(child);
              else expectedPaths.push(child);
            }
          };
          walk("");
          expectedPaths.sort();
          expect(targetPaths).toEqual(expectedPaths);
          for (const path of targetPaths) {
            const expectedPath = join(expectedDir, path);
            const expectedContent = readFileSync(expectedPath, "utf8");
            const formatter = path.endsWith(".ts") ? "typescript" : "babel";
            const normalizedActual = await format(files.get(path)!, { parser: formatter });
            expect(normalizedActual, `${fixture}/${path} mismatch`).toBe(
              expectedContent.endsWith("\n") ? expectedContent : expectedContent + "\n",
            );
          }
        }
      },
      120000,
    );
  }
});
