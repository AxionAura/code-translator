// S3 dependency validation (WS G): mapped, external-verbatim, unsupported, and
// unresolved verdicts are DISTINCT — a registry miss is not an unresolved project
// import. Positive and negative cases pinned per docs/validation.md §1 stage 3.
import { describe, expect, it } from "vitest";

import { validateDependencies, type S3Input } from "../src/s3-dependencies.js";

function makeInput(overrides: Partial<S3Input> = {}): S3Input {
  return {
    files: new Map<string, string>([
      ["helper.ts", "export const one = 1;\n"],
      ["main.ts", "import { one } from './helper.js';\n"],
    ]),
    mappedModules: new Set(["math", "json", "sys", "random", "requests"]),
    unsupportedModules: new Set(["ctypes", "curses"]),
    sourceImports: new Map<string, readonly string[]>([
      ["main.py", ["helper", "math", "boto3", "ctypes", "./missing"]],
      ["helper.py", []],
    ]),
    targetPathFor: (sourceModuleId: string) => sourceModuleId.replace(/\.py$/, ".ts"),
    ...overrides,
  };
}

describe("S3 dependency validation", () => {
  it("classifies emitted-local, mapped, external-verbatim, and unsupported distinctly", () => {
    const result = validateDependencies(makeInput());
    const bySpecifier = new Map(result.findings.map((f) => [f.specifier, f.verdict]));
    expect(bySpecifier.get("helper")).toBe("emitted-local");
    expect(bySpecifier.get("math")).toBe("mapped");
    expect(bySpecifier.get("boto3")).toBe("external-verbatim");
    expect(bySpecifier.get("ctypes")).toBe("unsupported");
    // A RELATIVE import that resolves to no emitted module is unresolved; a
    // non-relative unknown name is external-verbatim (an installed package may
    // exist — the graph cannot know, so it passes through with a warning).
    expect(bySpecifier.get("./missing")).toBe("unresolved");
  });

  it("fails on unresolved relative imports (missing project module)", () => {
    const result = validateDependencies(makeInput());
    expect(result.status).toBe("fail");
    expect(result.reason).toContain("unresolved project import");
  });

  it("warns (not fails) on registry-unsupported modules with exact detail", () => {
    const result = validateDependencies(
      makeInput({
        sourceImports: new Map<string, readonly string[]>([["main.py", ["ctypes"]]]),
      }),
    );
    expect(result.status).toBe("warn");
    expect(result.reason).toContain("registry-unsupported");
    expect(result.details.join("; ")).toContain("ctypes");
  });

  it("warns on unmapped externals passing through verbatim (never guesses)", () => {
    const result = validateDependencies(
      makeInput({
        sourceImports: new Map<string, readonly string[]>([["main.py", ["boto3"]]]),
      }),
    );
    expect(result.status).toBe("warn");
    expect(result.details.join("; ")).toContain("passes through verbatim");
    expect(result.details.join("; ")).toContain("boto3");
  });

  it("passes when every import resolves (mapped or emitted-local)", () => {
    const result = validateDependencies(
      makeInput({
        sourceImports: new Map<string, readonly string[]>([
          ["main.py", ["helper", "math", "requests"]],
        ]),
      }),
    );
    expect(result.status).toBe("pass");
    expect(result.reason).toBeNull();
  });

  it("keeps verdicts deterministic for repeated runs", () => {
    const first = validateDependencies(makeInput());
    const second = validateDependencies(makeInput());
    expect(first.findings).toEqual(second.findings);
    expect(first.status).toBe(second.status);
  });
});
