// Project orchestration (roadmap M6 WS A): deterministic discovery of a Python
// project's source files, safe traversal (symlink + cap policies), and the
// project runner that feeds the existing pipeline. Parsing, the ModuleGraph, and
// translation stay in their existing modules — this module only orchestrates.
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, sep } from "node:path";

import type { ParseResult } from "./parse-result.js";

// Default intake exclusions (docs/security.md §6 caps; deterministic ordering):
// VCS metadata, dependency/environment folders, our own output, caches, and
// compiled artifacts are never translated.
const EXCLUDED_DIRECTORIES: ReadonlySet<string> = new Set([
  ".git",
  ".hg",
  ".svn",
  ".ctrans",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  "node_modules",
  ".venv",
  "venv",
  "env",
  ".tox",
  ".nox",
  "dist",
  "build",
  ".eggs",
]);

export interface ProjectIntakeCaps {
  readonly maxFiles: number;
  readonly maxFileBytes: number;
}

export const DEFAULT_INTAKE_CAPS: ProjectIntakeCaps = {
  maxFiles: 25000,
  maxFileBytes: 5 * 1024 * 1024,
};

export interface DiscoveredFile {
  // Path relative to the project root, '/'-separated, deterministic order.
  readonly relativePath: string;
  readonly bytes: number;
}

export interface ProjectDiscovery {
  readonly files: readonly DiscoveredFile[];
  // Honest exclusions: what was skipped and why (reported, never silent).
  readonly excludedDirectories: readonly string[];
  readonly skippedSymlinks: readonly string[];
  readonly skippedOversized: readonly string[];
  readonly capExceeded: "file-count" | null;
}

// Deterministic project discovery: sorted walk, exclusion list, symlink policy
// (directory symlinks inside the root are not followed; file symlinks are read
// through only when they resolve inside the root), size/count caps.
export function discoverProjectFiles(
  root: string,
  caps: ProjectIntakeCaps = DEFAULT_INTAKE_CAPS,
): ProjectDiscovery {
  const files: DiscoveredFile[] = [];
  const excludedDirectories: string[] = [];
  const skippedSymlinks: string[] = [];
  const skippedOversized: string[] = [];
  let capExceeded: "file-count" | null = null;
  const rootReal = realpathSync(root);

  const walk = (relativeDir: string): void => {
    if (capExceeded !== null) return;
    const absoluteDir = relativeDir === "" ? root : join(root, relativeDir);
    const entries = readdirSync(absoluteDir, { withFileTypes: true }).sort((left, right) =>
      left.name < right.name ? -1 : 1,
    );
    for (const entry of entries) {
      const childRelative = relativeDir === "" ? entry.name : `${relativeDir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRECTORIES.has(entry.name)) {
          excludedDirectories.push(`${childRelative}/`);
          continue;
        }
        // Directory symlinks are not followed (traversal safety).
        if (entry.isSymbolicLink()) {
          skippedSymlinks.push(`${childRelative}/`);
          continue;
        }
        walk(childRelative);
        continue;
      }
      if (!entry.name.endsWith(".py")) continue;
      if (entry.isSymbolicLink()) {
        // File symlinks are read through only when they resolve inside the root.
        try {
          const resolved = realpathSync(join(root, childRelative));
          if (!resolved.startsWith(rootReal + sep) && resolved !== rootReal) {
            skippedSymlinks.push(childRelative);
            continue;
          }
        } catch {
          skippedSymlinks.push(childRelative);
          continue;
        }
      }
      if (files.length >= caps.maxFiles) {
        capExceeded = "file-count";
        return;
      }
      const bytes = statSync(join(root, childRelative)).size;
      if (bytes > caps.maxFileBytes) {
        skippedOversized.push(childRelative);
        continue;
      }
      files.push({ relativePath: childRelative, bytes });
    }
  };
  walk("");
  files.sort((left, right) => (left.relativePath < right.relativePath ? -1 : 1));
  return { files, excludedDirectories, skippedSymlinks, skippedOversized, capExceeded };
}

// Read a discovered file (decoded by the caller per the ParseResult contract —
// non-UTF-8 sources are the caller's skip-with-reason).
export function readProjectFile(root: string, file: DiscoveredFile): string {
  return readFileSync(join(root, file.relativePath), "utf8");
}

// The translated target path for a source module (the pipeline's module policy:
// pkg/mod.py -> pkg/mod.<ext>, pkg/__init__.py -> pkg/index.<ext>).
export function targetPathForModule(sourceModuleId: string, extension: ".js" | ".ts"): string {
  const withoutExt = sourceModuleId.replace(/\.py$/, "");
  if (sourceModuleId.endsWith("__init__.py")) {
    return `${withoutExt.slice(0, -"__init__".length)}index${extension}`;
  }
  return `${withoutExt}${extension}`;
}

export interface ProjectTestModule {
  readonly sourcePath: string;
  readonly kind: "pytest";
}

// Test-file discovery (the M6 subset: pytest-style test modules). A file is a
// test module when its NAME matches the pytest convention — content inspection
// happens in the mapper.
export function isTestModulePath(relativePath: string): boolean {
  const base = relativePath.split("/").pop() ?? "";
  return (base.startsWith("test_") || base.endsWith("_test")) && base.endsWith(".py");
}

export interface ParsedProjectUnit {
  readonly moduleId: string;
  readonly path: string;
  readonly parseResult: ParseResult;
  readonly isTest: boolean;
}

export interface ProjectIntakeResult {
  readonly units: readonly ParsedProjectUnit[];
  readonly discovery: ProjectDiscovery;
  // Files skipped for decode failure — reported, never silent.
  readonly undecodable: readonly string[];
}
