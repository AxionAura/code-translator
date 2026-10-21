// Toolchain entry resolution for the sandbox runners (nothing is installed at
// validation time): the repo's node_modules and the vitest/TypeScript entries
// inside it. Shared by the project runner, repair re-validation, and doctor.
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

export interface RunnerToolchain {
  readonly nodeModulesPath: string;
  readonly vitestEntryPath: string;
  readonly typescriptEntryPath: string;
}

export function runnerToolchain(): RunnerToolchain {
  const require = createRequire(import.meta.url);
  const vitestPackageJson = require.resolve("vitest/package.json");
  const nodeModulesPath = dirname(dirname(vitestPackageJson));
  const typescriptPackageJson = require.resolve("typescript/package.json");
  return {
    nodeModulesPath,
    vitestEntryPath: join(nodeModulesPath, "vitest", "vitest.mjs"),
    typescriptEntryPath: join(dirname(typescriptPackageJson), "bin", "tsc"),
  };
}
