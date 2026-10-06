import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "coverage/**",
      "pnpm-lock.yaml",
      // Fixture input/expected files are golden data compared after their own canonical
      // formatting pipeline (docs/decisions.md D-012); repo lint rules do not govern them.
      "tests/fixtures/**",
    ],
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      // AGENTS.md §2: no `any` outside process boundaries (boundaries must use `unknown` + guards).
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
      // AGENTS.md §2: named exports only. ESLint itself requires a default export from
      // eslint.config.js and vitest's defineConfig is consumed as a default export - the
      // narrow per-file exception below covers exactly those two files.
      "no-restricted-exports": ["error", { restrictedNamedExports: ["default"] }],
    },
  },
  {
    files: ["eslint.config.js", "vitest.config.ts"],
    rules: { "no-restricted-exports": "off" },
  },
);
