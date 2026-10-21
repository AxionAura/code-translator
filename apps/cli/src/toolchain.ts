// Toolchain entry resolution for the sandbox runners (nothing is installed at
// validation time): the workspace node_modules directory and the vitest/TypeScript
// entries inside it. Shared by the project runner, repair re-validation, and doctor.
//
// `require.resolve` follows pnpm symlinks into `.pnpm/<pkg>/node_modules`, whose
// dependency links point back into the pnpm store. Mounting only that inner
// directory breaks dependency resolution inside the sandbox (especially when the
// workspace lives under the shadowed host /tmp); resolve the OUTER node_modules
// directory instead by walking require.resolve.paths.
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

export interface RunnerToolchain {
  readonly nodeModulesPath: string;
  readonly vitestEntryPath: string;
  readonly typescriptEntryPath: string;
}

function outerNodeModules(require: NodeRequire, packageName: string): string {
  for (const searchPath of require.resolve.paths(packageName) ?? []) {
    if (existsSync(join(searchPath, packageName))) return searchPath;
  }
  const packageJson = require.resolve(`${packageName}/package.json`);
  return dirname(dirname(packageJson));
}

export function runnerToolchain(): RunnerToolchain {
  const require = createRequire(import.meta.url);
  const nodeModulesPath = outerNodeModules(require, "vitest");
  const typescriptPackageJson = require.resolve("typescript/package.json");
  return {
    nodeModulesPath,
    vitestEntryPath: join(nodeModulesPath, "vitest", "vitest.mjs"),
    typescriptEntryPath: join(dirname(typescriptPackageJson), "bin", "tsc"),
  };
}
