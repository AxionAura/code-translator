import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const workspaceSource = (name: string): string =>
  fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    // Tests exercise sources; package "exports" point at dist for the release build.
    alias: {
      "@axion-ct/core": workspaceSource("core"),
      "@axion-ct/parser-py": workspaceSource("parser-py"),
      "@axion-ct/parser-js": workspaceSource("parser-js"),
      "@axion-ct/codegen-js": workspaceSource("codegen-js"),
      "@axion-ct/codegen-py": workspaceSource("codegen-py"),
      "@axion-ct/registry": workspaceSource("registry"),
      "@axion-ct/sandbox": workspaceSource("sandbox"),
      "@axion-ct/validator": workspaceSource("validator"),
      "@axion-ct/ai": workspaceSource("ai"),
      "@axion-ct/repair": workspaceSource("repair"),
    },
  },
  test: {
    coverage: {
      reporter: ["text", "json-summary", "json", "lcov"],
    },
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
