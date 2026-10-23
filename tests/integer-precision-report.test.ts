// Report/claim-level regression for P0 integer precision: a warning and semantic
// ledger decision must be visible in the pipeline report, while the numeric claim
// remains the validation claim it actually is (S1-S3, not semantic proof).
import { beforeAll, describe, expect, it } from "vitest";

import type { PipelineInput } from "@axion-ct/core";
import { runPipeline, type TargetLanguage } from "@axion-ct/core";
import { createPyToJsTranslator } from "@axion-ct/codegen-js";
import { createPythonBridgeParser, type PythonBridgeParser } from "@axion-ct/parser-py";
import { createOxcSyntaxValidator, OracleTypeValidator } from "@axion-ct/parser-js";

const PRECISION = "CTW-NUM-INT-ARBITRARY-PRECISION";

let py: PythonBridgeParser;

beforeAll(async () => {
  py = await createPythonBridgeParser();
});

async function run(
  source: string,
  target: TargetLanguage,
  intMode: "number" | "bigint",
): Promise<{
  report: Awaited<ReturnType<typeof runPipeline>>["report"];
  ledger: Awaited<ReturnType<typeof runPipeline>>["ledger"];
  files: Awaited<ReturnType<typeof runPipeline>>["emittedFiles"];
}> {
  const filename = "mod.py";
  const parseResult = await py.parse(source, { filename });
  const inputs: PipelineInput[] = [{ filename, parseResult }];
  const result = await runPipeline(
    inputs,
    {
      target,
      intMode,
      translateUnit: await createPyToJsTranslator(target, { intMode }),
      validateSyntax: await createOxcSyntaxValidator(),
      validateTypes: new OracleTypeValidator(),
    },
    {
      sourceImports: new Map([[filename, []]]),
      mappedModules: new Set(),
      unsupportedModules: new Set(),
    },
  );
  return { report: result.report, ledger: result.ledger, files: result.emittedFiles };
}

describe("integer precision report and claim", () => {
  it("reports the unsafe constant expression while keeping claim 3 as a validation claim", async () => {
    const { report, ledger, files } = await run("x = 2 ** 53 + 1\n", "typescript", "number");
    expect(report.warnings).toContain(PRECISION);
    expect(report.claimLevel).toBe(3);
    expect(report.files[0]?.status).toBe("translated");
    expect(report.unsupported).toHaveLength(0);
    expect(ledger.some((entry) => entry.decision === "semantic")).toBe(true);
    expect(files.some((file) => file.content.includes("2 ** 53 + 1"))).toBe(true);
  });

  it("does not report the safe 2 ** 53 - 1 boundary", async () => {
    const { report, ledger } = await run("x = 2 ** 53 - 1\n", "typescript", "number");
    expect(report.warnings).not.toContain(PRECISION);
    expect(report.claimLevel).toBe(3);
    expect(ledger.every((entry) => entry.decision === "deterministic")).toBe(true);
  });

  it("keeps bigint mode exact and warning-free in the report", async () => {
    const { report, files } = await run("x = 2 ** 100\n", "typescript", "bigint");
    expect(report.warnings).not.toContain(PRECISION);
    expect(report.claimLevel).toBe(3);
    expect(files.some((file) => file.content.includes("2n ** 100n"))).toBe(true);
  });

  it("reports the same precision warning for JavaScript output", async () => {
    const { report } = await run("x = 2 ** 100\n", "javascript", "number");
    expect(report.warnings).toContain(PRECISION);
    // S2 is intentionally skipped for JS targets; the numeric level is not a
    // semantic-equivalence claim.
    expect(report.claimLevel).toBe(1);
  });
});
