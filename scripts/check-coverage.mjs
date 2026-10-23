// Enforces the documented per-package line-coverage floors from the JSON summary
// emitted by `pnpm test:coverage`. Keep the floors in sync with docs/testing.md.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const FLOORS = {
  core: 85,
  "parser-py": 90,
  "parser-js": 90,
  "codegen-js": 90,
  "codegen-py": 90,
};

const summaryPath = resolve(process.cwd(), "coverage/coverage-summary.json");
if (!existsSync(summaryPath)) {
  console.error("coverage/coverage-summary.json is missing; run `pnpm test:coverage` first");
  process.exit(1);
}

const summary = JSON.parse(readFileSync(summaryPath, "utf8"));
const totals = new Map();
for (const [path, file] of Object.entries(summary)) {
  const match = /\/packages\/([^/]+)\/src\//.exec(path.replaceAll("\\", "/"));
  if (!match) continue;
  const name = match[1];
  if (name === undefined) continue;
  const current = totals.get(name) ?? { covered: 0, total: 0 };
  current.covered += file.lines.covered;
  current.total += file.lines.total;
  totals.set(name, current);
}

let failed = false;
for (const [name, floor] of Object.entries(FLOORS)) {
  const total = totals.get(name);
  if (total === undefined || total.total === 0) {
    console.error(`${name}: no line-coverage data found`);
    failed = true;
    continue;
  }
  const percentage = (total.covered / total.total) * 100;
  const passed = percentage >= floor;
  console.log(
    `${name}: ${percentage.toFixed(2)}% lines (floor ${floor}%) ${passed ? "PASS" : "FAIL"}`,
  );
  if (!passed) failed = true;
}

if (failed) process.exit(1);
