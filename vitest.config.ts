import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const workspaceSource = (name: string): string =>
  fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    // Tests exercise sources; package "exports" point at dist for the release build.
    alias: {
      "@ctrans/core": workspaceSource("core"),
      "@ctrans/parser-py": workspaceSource("parser-py"),
      "@ctrans/parser-js": workspaceSource("parser-js"),
      "@ctrans/codegen-js": workspaceSource("codegen-js"),
      "@ctrans/codegen-py": workspaceSource("codegen-py"),
      "@ctrans/registry": workspaceSource("registry"),
      "@ctrans/sandbox": workspaceSource("sandbox"),
      "@ctrans/validator": workspaceSource("validator"),
      "@ctrans/ai": workspaceSource("ai"),
      "@ctrans/repair": workspaceSource("repair"),
    },
  },
  test: {
    environment: "node",
    include: [
      "packages/*/test/**/*.test.ts",
      "apps/*/test/**/*.test.ts",
      "scripts/**/*.test.ts",
      "tests/*.test.ts",
    ],
    // tests/fixtures/** holds golden projects' PINNED TRANSLATED OUTPUT — untrusted
    // generated code that must only ever execute inside the sandbox (S5), never as
    // part of this suite.
    exclude: ["**/node_modules/**", "tests/fixtures/**"],
  },
});
