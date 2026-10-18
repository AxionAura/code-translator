// Pipeline validation implementations (docs/validation.md §1): S1 re-parses emitted
// target files with the same production parser; S2 type-checks TypeScript targets
// through the pinned TypeScript 6 oracle. Both return honest stage results -
// `skipped(reason)` when they cannot meaningfully run.
import type { StageResult, SyntaxValidator, TypeValidator } from "@ctrans/core";
import { OxcJsParser, createOxcJsParser } from "./oxc-parser.js";
import { TypeScriptSemanticOracle } from "./ts-oracle.js";

export class OxcSyntaxValidator implements SyntaxValidator {
  private readonly parser: OxcJsParser;

  private constructor(parser: OxcJsParser) {
    this.parser = parser;
  }

  static async create(): Promise<OxcSyntaxValidator> {
    return new OxcSyntaxValidator(await createOxcJsParser());
  }

  async validate(
    files: readonly { path: string; content: string; language: "javascript" | "typescript" }[],
  ): Promise<StageResult> {
    const details: string[] = [];
    let failures = 0;
    for (const file of files) {
      const result = await this.parser.parse(file.content, {
        filename: file.path,
        language:
          file.path.endsWith(".ts") || file.path.endsWith(".tsx") ? "typescript" : "javascript",
        jsx: file.path.endsWith(".jsx") || file.path.endsWith(".tsx"),
      });
      const errors = result.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
      if (errors.length > 0) {
        failures += 1;
        for (const error of errors) {
          details.push(`${file.path}: ${error.message}`);
        }
      }
    }
    if (failures > 0) {
      return {
        stage: "S1-syntax",
        status: "fail",
        reason: `${String(failures)} file(s) failed to re-parse`,
        details,
      };
    }
    return { stage: "S1-syntax", status: "pass", reason: null, details: [] };
  }
}

export async function createOxcSyntaxValidator(): Promise<OxcSyntaxValidator> {
  return OxcSyntaxValidator.create();
}

export class OracleTypeValidator implements TypeValidator {
  private readonly oracle = new TypeScriptSemanticOracle();

  async validate(files: readonly { path: string; content: string }[]): Promise<StageResult> {
    // All emitted files go into ONE program so cross-module imports resolve.
    const tsFiles = files
      .filter((file) => file.path.endsWith(".ts") || file.path.endsWith(".tsx"))
      .map((file) => ({ filename: file.path, source: file.content }));
    const details: string[] = [];
    let failures = 0;
    for (const file of tsFiles) {
      const summary = this.oracle.summarizeModule({ files: tsFiles, filename: file.filename });
      for (const diagnostic of summary.diagnostics) {
        if (diagnostic.severity === "error") {
          failures += 1;
          details.push(`${file.filename}: ${diagnostic.message} (code ${String(diagnostic.code)})`);
        }
      }
    }
    if (failures > 0) {
      return {
        stage: "S2-types",
        status: "fail",
        reason: `${String(failures)} type error(s)`,
        details,
      };
    }
    return { stage: "S2-types", status: "pass", reason: null, details: [] };
  }
}
