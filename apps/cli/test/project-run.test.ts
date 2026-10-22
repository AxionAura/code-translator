// Project-runner integration (roadmap M6 WS D/E/F): translate a mini project,
// run its translated vitest suite under the sandbox (S5), run the source suite
// under the same sandbox with the tool-provided runner (S6), and assert the
// differential verdict plus the extended claim ladder and .ctrans/ artifacts.
// Capability gates: without bwrap the stages must be REFUSED (skipped), never
// downgraded; without python3 the differential reports its own skip.
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { detectCapabilities } from "@axion-ct/sandbox";

import { runnerToolchain } from "../src/main.ts";
import { runProject, type ProjectRunReport } from "../src/project-run.ts";

const exec = promisify(execFile);

const CALC_PY = `"""Arithmetic helpers used by the test modules."""


def add(a: int, b: int) -> int:
    return a + b


def floor_div(a: int, b: int) -> int:
    return a // b
`;

const TEST_CALC_PY = `import pytest

from calc import add, floor_div


def test_add():
    assert add(2, 3) == 5


@pytest.mark.parametrize("a,b,expected", [(1, 2, 3), (0, 0, 0), (-1, 1, 0)])
def test_add_parametrized(a, b, expected):
    assert add(a, b) == expected


def test_floor_div():
    assert floor_div(7, 2) == 3


def test_floor_div_zero():
    with pytest.raises(ZeroDivisionError):
        floor_div(1, 0)
`;

const PROJECT_FILES: Readonly<Record<string, string>> = {
  "calc.py": CALC_PY,
  "tests/test_calc.py": TEST_CALC_PY,
};

function materializeProject(root: string, files: Readonly<Record<string, string>>): void {
  for (const [path, content] of Object.entries(files)) {
    const absolute = join(root, path);
    mkdirSync(join(absolute, ".."), { recursive: true });
    writeFileSync(absolute, content);
  }
}

let workspace: string;
let capabilities: Awaited<ReturnType<typeof detectCapabilities>>;
let pythonAvailable = true;
const createdDirs: string[] = [];

beforeAll(async () => {
  capabilities = await detectCapabilities();
  try {
    await exec("python3", ["--version"]);
  } catch {
    pythonAvailable = false;
  }
  workspace = mkdtempSync(join(tmpdir(), "ctrans-project-"));
  createdDirs.push(workspace);
});

afterAll(() => {
  for (const dir of createdDirs.reverse()) {
    rmSync(dir, { recursive: true, force: true });
  }
});

async function runMiniProject(
  files: Readonly<Record<string, string>> = PROJECT_FILES,
): Promise<ProjectRunReport> {
  const sourceRoot = join(workspace, "src");
  const outputRoot = join(workspace, "out");
  rmSync(sourceRoot, { recursive: true, force: true });
  rmSync(outputRoot, { recursive: true, force: true });
  materializeProject(sourceRoot, files);
  return runProject({
    sourceRoot,
    outputRoot,
    target: "typescript",
    intMode: "number",
    sandbox: capabilities,
    nodePath: process.execPath,
    pythonPath: "python3",
    ...runnerToolchain(),
    timeoutMs: 120000,
  });
}

describe("project runner: translation", () => {
  it("emits sources, translated tests, the shared runtime, and .ctrans artifacts", async () => {
    await runMiniProject();
    const outputRoot = join(workspace, "out");
    expect(existsSync(join(outputRoot, "calc.ts"))).toBe(true);
    expect(existsSync(join(outputRoot, "tests", "test_calc.test.ts"))).toBe(true);
    expect(existsSync(join(outputRoot, "__ctrans_runtime.ts"))).toBe(true);
    // The translated test imports the runtime through its parent directory.
    const testContent = readFileSync(join(outputRoot, "tests", "test_calc.test.ts"), "utf8");
    expect(testContent).toContain('from "../__ctrans_runtime.ts"');
    expect(existsSync(join(outputRoot, ".ctrans", "ledger.json"))).toBe(true);
    expect(existsSync(join(outputRoot, ".ctrans", "report.json"))).toBe(true);
    // The ledger covers source AND test decisions (pytest provenance included).
    const ledger = JSON.parse(readFileSync(join(outputRoot, ".ctrans", "ledger.json"), "utf8")) as {
      unit: string;
    }[];
    expect(ledger.some((entry) => entry.unit === "tests/test_calc.py")).toBe(true);
  }, 120000);
});

describe("project runner: sandboxed test validation (S5) + differential (S6)", () => {
  it("refuses to execute without enforced network isolation (no silent downgrade)", async () => {
    if (capabilities.bwrap.available) {
      return; // enforced isolation is available on this host; the next test covers it
    }
    const report = await runMiniProject();
    expect(report.s5).toBeNull();
    expect(
      report.skipped.some((skip) => skip.what === "S5-tests" && skip.reason.includes("isolation")),
    ).toBe(true);
    expect(report.pipeline.report.claimLevel).toBeLessThanOrEqual(3);
  }, 120000);

  it("runs the translated suite and matches source outcomes test-by-test", async () => {
    if (!capabilities.bwrap.available || !pythonAvailable) {
      return; // capability-gated: asserted on hosts with bwrap + python3
    }
    const report = await runMiniProject();
    expect(report.s5).not.toBeNull();
    expect(report.s5!.status, report.s5!.details.join("; ")).toBe("pass");
    expect(report.s5!.outcomes.length).toBeGreaterThanOrEqual(6);
    expect(report.s6).not.toBeNull();
    expect(report.s6!.status, report.s6!.reason ?? "s6 pass").toBe("pass");
    const matchedNames = report.s6!.matched.map((entry) => entry.name);
    expect(matchedNames).toContain("test_add");
    expect(matchedNames).toContain("test_floor_div");
    expect(matchedNames).toContain("test_floor_div_zero");
    expect(matchedNames.filter((name) => name.startsWith("test_add_parametrized")).length).toBe(3);
    // Claim level 5: syntax + types + dependencies + tests + differential.
    expect(report.pipeline.report.claimLevel).toBe(5);
    // The differential artifact carries the evidence.
    const differential = JSON.parse(
      readFileSync(join(workspace, "out", ".ctrans", "differential.json"), "utf8"),
    ) as { status: string; matched: unknown[] };
    expect(differential.status).toBe("pass");
    expect(differential.matched.length).toBe(report.s6!.matched.length);
    const testResults = JSON.parse(
      readFileSync(join(workspace, "out", ".ctrans", "test-results.json"), "utf8"),
    ) as { status: string; outcomes: unknown[] };
    expect(testResults.status).toBe("pass");
  }, 180000);
});

describe("project runner: honest reporting of unsupported test constructs", () => {
  it("reports monkeypatch-style fixtures as unsupported and still validates the rest", async () => {
    if (!capabilities.bwrap.available || !pythonAvailable) {
      return; // capability-gated
    }
    const report = await runMiniProject({
      "calc.py": CALC_PY,
      "tests/test_calc.py": `${TEST_CALC_PY}
def test_with_monkeypatch(monkeypatch):
    assert add(1, 1) == 2
`,
    });
    expect(
      report.unsupportedTestConstructs.some((entry) => entry.reason.includes("monkeypatch")),
    ).toBe(true);
    // The unsupported PARAM binding is marked loudly (ledger + warnings + the
    // per-file status), but the translated suite still covers the test body, so
    // the differential matches it. Nothing is inflated: the file status and the
    // unsupported-construct report carry the honest limitation.
    expect(report.s6!.status).toBe("pass");
    expect(report.pipeline.report.claimLevel).toBe(5);
    const testModuleEntry = report.pipeline.report.files.find(
      (file) => file.source === "tests/test_calc.py",
    );
    expect(testModuleEntry?.status).toBe("partially-translated");
  }, 180000);

  it("skips S5/S6 entirely when test execution is disabled", async () => {
    const sourceRoot = join(workspace, "src-noexec");
    const outputRoot = join(workspace, "out-noexec");
    rmSync(sourceRoot, { recursive: true, force: true });
    rmSync(outputRoot, { recursive: true, force: true });
    materializeProject(sourceRoot, PROJECT_FILES);
    const report = await runProject({
      sourceRoot,
      outputRoot,
      target: "typescript",
      intMode: "number",
      runTests: false,
      sandbox: capabilities,
      nodePath: process.execPath,
      pythonPath: "python3",
      ...runnerToolchain(),
    });
    expect(report.s5).toBeNull();
    expect(report.skipped.some((skip) => skip.what === "S5-tests")).toBe(true);
    expect(existsSync(join(outputRoot, ".ctrans", "test-results.json"))).toBe(false);
    expect(existsSync(join(outputRoot, ".ctrans", "differential.json"))).toBe(false);
  }, 120000);
});
