// Installs a published @axion-ct/cli release from the public npm registry in a
// temporary directory outside this repository, then exercises the CLI surface.
// This is a smoke test: it catches broken installs/output and records claim
// levels; it does not prove universal semantic equivalence.
import { execFile } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const expectedVersion = process.argv[2] ?? "0.1.1";
const root = fileURLToPath(new URL("..", import.meta.url));
const temp = mkdtempSync(join(tmpdir(), "ctrans-public-cli-"));
const cli = join(temp, "node_modules/.bin/ctrans");

const internalPackages = [
  "core",
  "parser-py",
  "parser-js",
  "registry",
  "sandbox",
  "codegen-js",
  "codegen-py",
  "ai",
  "validator",
  "repair",
  "cli",
];

async function run(command, args, options = {}) {
  const { cwd, timeout = 120_000 } = options;
  return execFileAsync(command, args, {
    cwd,
    timeout,
    maxBuffer: 32 * 1024 * 1024,
    encoding: "utf8",
  });
}

function claimLevel(output, label) {
  const match = /claim level (\d+)/.exec(output);
  if (match === null) throw new Error(`${label}: no claim level in CLI output`);
  return Number(match[1]);
}

function mustContain(value, fragment, label) {
  if (!value.includes(fragment)) throw new Error(`${label}: missing ${JSON.stringify(fragment)}`);
}

async function verifyRegistryInstall() {
  await run("npm", ["init", "-y"], { cwd: temp });
  await run(
    "npm",
    ["install", "--ignore-scripts", "--no-audit", "--no-fund", `@axion-ct/cli@${expectedVersion}`],
    { cwd: temp, timeout: 300_000 },
  );

  const lock = JSON.parse(readFileSync(join(temp, "package-lock.json"), "utf8"));
  for (const shortName of internalPackages) {
    const packageName = `@axion-ct/${shortName}`;
    const lockEntry = lock.packages?.[`node_modules/${packageName}`];
    if (lockEntry?.version !== expectedVersion) {
      throw new Error(`${packageName}: lockfile resolved ${lockEntry?.version ?? "nothing"}`);
    }
    if (!lockEntry.resolved?.startsWith("https://registry.npmjs.org/")) {
      throw new Error(`${packageName}: did not resolve from the public registry`);
    }

    const manifest = JSON.parse(
      readFileSync(join(temp, "node_modules/@axion-ct", shortName, "package.json"), "utf8"),
    );
    if (manifest.version !== expectedVersion) {
      throw new Error(`${packageName}: installed ${manifest.version}`);
    }
    for (const [dependency, range] of Object.entries(manifest.dependencies ?? {})) {
      if (dependency.startsWith("@axion-ct/") && range !== expectedVersion) {
        throw new Error(`${packageName}: internal dependency ${dependency}@${range}`);
      }
    }
  }
  console.log(
    `registry install: all ${internalPackages.length} internal packages at ${expectedVersion}`,
  );
}

async function verifyDoctor() {
  const versionOutput = await run(cli, ["--version"]);
  if (versionOutput.stdout.trim() !== expectedVersion) {
    throw new Error(`ctrans --version returned ${versionOutput.stdout.trim()}`);
  }
  console.log(`ctrans version: ${versionOutput.stdout.trim()}`);

  const doctorOutput = await run(cli, ["doctor", "--json"]);
  const doctor = JSON.parse(doctorOutput.stdout);
  if (doctor.requiredAvailable !== true) {
    throw new Error("doctor did not report requiredAvailable=true");
  }
  const capabilities = Object.values(doctor.capabilities ?? {});
  for (const requiredName of ["node", "python3", "bwrap", "pyright", "tsc", "vitest"]) {
    const capability = capabilities.find((entry) => entry.name === requiredName);
    if (capability?.state !== "available") {
      throw new Error(`doctor required capability unavailable: ${requiredName}`);
    }
  }
  console.log("doctor: required capabilities available");
}

async function verifySixDirections() {
  const smokeDir = join(temp, "smoke");
  mkdirSync(smokeDir, { recursive: true });
  const py = join(smokeDir, "min.py");
  const js = join(smokeDir, "min.js");
  const ts = join(smokeDir, "min.ts");
  writeFileSync(py, "def add(a: int, b: int) -> int:\n    return a + b\n", "utf8");
  writeFileSync(js, "export function add(a, b) {\n  return a + b;\n}\n", "utf8");
  writeFileSync(
    ts,
    "export function add(a: number, b: number): number {\n  return a + b;\n}\n",
    "utf8",
  );

  const directions = [
    {
      label: "python-to-typescript",
      source: py,
      target: "ts",
      output: "min.ts",
      claim: 3,
      fragment: "function add",
    },
    {
      label: "python-to-javascript",
      source: py,
      target: "js",
      output: "min.js",
      claim: 1,
      fragment: "function add",
    },
    {
      label: "javascript-to-typescript",
      source: js,
      target: "ts",
      output: "min.ts",
      claim: 3,
      fragment: "function add",
    },
    {
      label: "javascript-to-python",
      source: js,
      target: "py",
      output: "min.py",
      claim: 3,
      fragment: "def add",
    },
    {
      label: "typescript-to-javascript",
      source: ts,
      target: "js",
      output: "min.js",
      claim: 1,
      fragment: "function add",
    },
    {
      label: "typescript-to-python",
      source: ts,
      target: "py",
      output: "min.py",
      claim: 3,
      fragment: "def add",
    },
  ];

  for (const direction of directions) {
    const outputDir = join(smokeDir, `out-${direction.label}`);
    const result = await run(cli, [
      "translate",
      direction.source,
      "--to",
      direction.target,
      "-o",
      outputDir,
    ]);
    const claim = claimLevel(result.stdout, direction.label);
    if (claim !== direction.claim) {
      throw new Error(`${direction.label}: claim ${claim}, expected ${direction.claim}`);
    }
    const output = readFileSync(join(outputDir, direction.output), "utf8");
    mustContain(output, direction.fragment, direction.label);
    if (direction.target === "py" && !existsSync(join(outputDir, "__ctrans_runtime.py"))) {
      throw new Error(`${direction.label}: Python runtime helper is missing`);
    }
    console.log(`${direction.label}: exit 0, claim ${claim}, output present`);
  }
}

async function verifyProjectWorkflow() {
  const fixture = join(root, "tests/fixtures/project-barrels-multi-module/input");
  if (!existsSync(fixture)) throw new Error("project smoke fixture is missing from the checkout");
  const source = join(temp, "project-input");
  const output = join(temp, "project-output");
  cpSync(fixture, source, { recursive: true });
  const result = await run(cli, ["project", source, "--to", "ts", "-o", output], {
    timeout: 300_000,
  });
  if (claimLevel(result.stdout, "project") !== 5) {
    throw new Error("project workflow did not reach claim 5");
  }
  mustContain(result.stdout, "S5 tests: pass", "project");
  mustContain(result.stdout, "5 matched", "project");

  const report = JSON.parse(readFileSync(join(output, ".ctrans/report.json"), "utf8"));
  if (report.claimLevel !== 5) throw new Error("project report did not record claim 5");
  const stages = new Map(
    (report.validationStages ?? []).map((stage) => [stage.stage, stage.status]),
  );
  for (const stage of [
    "S1-syntax",
    "S2-types",
    "S3-dependencies",
    "S4-build",
    "S5-tests",
    "S6-differential",
  ]) {
    if (stages.get(stage) !== "pass") throw new Error(`project stage ${stage} is not pass`);
  }
  console.log("project: exit 0, claim 5, S1-S6 pass, S5 5/5, S6 5 matched");
}

try {
  await verifyRegistryInstall();
  await verifyDoctor();
  await verifySixDirections();
  await verifyProjectWorkflow();
  console.log(`public @axion-ct/cli@${expectedVersion} smoke verification passed`);
} catch (error) {
  console.error(`public @axion-ct/cli@${expectedVersion} smoke verification failed`);
  if (error instanceof Error) {
    console.error(error.message);
    if (typeof error.stderr === "string" && error.stderr.trim() !== "") {
      console.error(error.stderr.trim());
    }
  } else {
    console.error(String(error));
  }
  process.exitCode = 1;
} finally {
  rmSync(temp, { recursive: true, force: true });
}
