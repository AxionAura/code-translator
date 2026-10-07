// Repository guard for the TypeScript version boundary (D-004, roadmap M2): the
// compiler API may only be touched by the pinned-6 oracle adapter. TypeScript 7.0
// ships no JavaScript API, so any new compiler-API import anywhere else is a future
// break-in-waiting and must fail CI rather than surface at runtime.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = new URL("..", import.meta.url).pathname;
const SKIP_DIRS = new Set([".git", ".ctrans", "coverage", "dist", "node_modules"]);
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".js", ".mjs"]);

// The single sanctioned compiler-API consumer (ADR D-004). Extend only via ADR.
const TYPESCRIPT_API_ALLOWLIST = new Set(["packages/parser-js/src/ts-oracle.ts"]);

function* sourceFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) yield* sourceFiles(path);
    } else if (SOURCE_EXTENSIONS.has(entry.name.slice(entry.name.lastIndexOf(".")))) {
      yield path;
    }
  }
}

function relative(path: string): string {
  return path.slice(REPO_ROOT.length);
}

function importPatternsFor(specifier: string): RegExp[] {
  const q = String.raw`["']${specifier}["']`;
  return [
    new RegExp(String.raw`from\s+${q}`),
    new RegExp(String.raw`import\(\s*${q}\s*\)`),
    new RegExp(String.raw`require\(\s*${q}\s*\)`),
  ];
}

describe("TypeScript compiler-API boundary", () => {
  it("restricts 'typescript' imports to the pinned oracle adapter", () => {
    const violations: string[] = [];
    for (const path of sourceFiles(REPO_ROOT)) {
      const relativePath = relative(path);
      if (TYPESCRIPT_API_ALLOWLIST.has(relativePath)) continue;
      const content = readFileSync(path, "utf8");
      for (const pattern of importPatternsFor("typescript")) {
        if (pattern.test(content)) violations.push(`${relativePath}: imports "typescript"`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("keeps the typescript dependency pinned to the 6.x line in manifests and lockfile", () => {
    const parserJs = JSON.parse(
      readFileSync(join(REPO_ROOT, "packages/parser-js/package.json"), "utf8"),
    ) as { dependencies?: Record<string, string> };
    const root = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
      devDependencies?: Record<string, string>;
    };
    const parserJsRange = parserJs.dependencies?.["typescript"] ?? "";
    const rootRange = root.devDependencies?.["typescript"] ?? "";
    expect(parserJsRange.startsWith("~6.") || parserJsRange.startsWith("^6.")).toBe(true);
    expect(rootRange.startsWith("~6.") || rootRange.startsWith("^6.")).toBe(true);
    const lockfile = readFileSync(join(REPO_ROOT, "pnpm-lock.yaml"), "utf8");
    expect(lockfile).toMatch(/typescript@6\.\d+\.\d+/);
    expect(lockfile).not.toMatch(/typescript@7\./);
  });

  it("rejects accidental tsgo/TS7-native tooling references in sources", () => {
    // This guard file itself names the forbidden tool to forbid it - exempt it.
    const violations: string[] = [];
    for (const path of sourceFiles(REPO_ROOT)) {
      if (relative(path) === "scripts/ts7-guard.test.ts") continue;
      const content = readFileSync(path, "utf8");
      if (content.includes("tsgo")) violations.push(`${relative(path)}: references "tsgo"`);
    }
    expect(violations).toEqual([]);
  });
});
