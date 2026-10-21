#!/usr/bin/env node
// Nightly benchmark runner (M11): expensive suites are explicit/nightly, not part
// of `pnpm verify`. Results are committed artifacts under benchmarks/results/
// (never hand-edited). Usage: node scripts/benchmark-nightly.mjs [mini-projects|perf|all]
import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("..", import.meta.url));
const cli = join(root, "apps", "cli", "bin", "ctrans.mjs");
const requested = process.argv.slice(2);
const suites =
  requested.length === 0 || requested.includes("all") ? ["mini-projects", "perf"] : requested;
const invalid = suites.filter((suite) => suite !== "mini-projects" && suite !== "perf");
if (invalid.length > 0) {
  console.error(`unknown nightly suite(s): ${invalid.join(", ")}`);
  process.exit(2);
}

const resultsDir = join(root, "benchmarks", "results");
mkdirSync(resultsDir, { recursive: true });
const now = new Date();
const date = `${String(now.getFullYear())}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
let failed = false;
for (const suite of suites) {
  const started = Date.now();
  try {
    const { stdout } = await exec(
      process.execPath,
      [cli, "benchmark", "--suite", suite, "--iterations", "1", "--json"],
      { cwd: root, timeout: 30 * 60 * 1000, maxBuffer: 32 * 1024 * 1024 },
    );
    const parsed = JSON.parse(stdout);
    const target = join(resultsDir, `${date}-${suite}.json`);
    writeFileSync(target, JSON.stringify(parsed, null, 2) + "\n");
    const status = parsed.suites?.[0]?.status ?? "unknown";
    console.log(`${suite}: ${status} (${String(Date.now() - started)} ms) -> ${target}`);
    if (status !== "ok") failed = true;
  } catch (error) {
    failed = true;
    console.error(`${suite}: failed — ${error instanceof Error ? error.message : String(error)}`);
  }
}
process.exitCode = failed ? 1 : 0;
