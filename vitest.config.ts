import { defineConfig } from "vitest/config";

export default defineConfig({
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
