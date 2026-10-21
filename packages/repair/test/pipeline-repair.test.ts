// End-to-end repair against the REAL pipeline: parse Python, translate with
// @ctrans/codegen-js, corrupt the emitted TypeScript, then let the bounded loop
// repair it using a deterministic FakeChatModel and the real S1/S2 validators.
// Also pins that the M8 ambiguity path still resolves through the same model
// contract (no regression from the repair layer).
import { beforeAll, describe, expect, it } from "vitest";

import { FakeChatModel, AiAmbiguityResolver } from "@ctrans/ai";
import {
  analyzeModule,
  buildModuleGraph,
  runPipeline,
  type AmbiguityRequest,
  type StageResult,
} from "@ctrans/core";
import { createPyToJsTranslator } from "@ctrans/codegen-js";
import { createOxcSyntaxValidator, OracleTypeValidator } from "@ctrans/parser-js";
import { createPythonBridgeParser, type PythonBridgeParser } from "@ctrans/parser-py";

import {
  AiRepairProposer,
  DisabledRepairProposer,
  RepairJournal,
  runRepairLoop,
  stateHash,
  type RepairProposer,
} from "../src/index.js";

const SOURCE = "def add(a: int, b: int) -> int:\n    return a + b\n";
const AST_MATCH = [
  "def classify(value):",
  "    match value:",
  "        case 1:",
  "            return 'one'",
  "        case _:",
  "            return 'other'",
].join("\n");

let py: PythonBridgeParser;
let pristine: Map<string, string>;

beforeAll(async () => {
  py = await createPythonBridgeParser();
  const translator = await createPyToJsTranslator("typescript");
  const parseResult = await py.parse(SOURCE, { filename: "calc.py" });
  const unit = { filename: "calc.py", parseResult, model: analyzeModule(parseResult) };
  const graph = buildModuleGraph([{ filename: "calc.py", parseResult }]);
  const emission = await translator.translateUnit(unit, graph);
  const shared = await translator.finalizeUnits();
  pristine = new Map();
  for (const file of [...emission.files, ...shared.files]) {
    pristine.set(file.targetPath, file.content);
  }
}, 60000);

async function validate(files: ReadonlyMap<string, string>): Promise<readonly StageResult[]> {
  const syntax = await createOxcSyntaxValidator();
  const s1 = await syntax.validate(
    [...files.entries()].map(([path, content]) => ({
      path,
      content,
      language: "typescript" as const,
    })),
  );
  const s2 = await new OracleTypeValidator().validate(
    [...files.entries()].map(([path, content]) => ({ path, content })),
  );
  return [s1, s2];
}

function corrupt(): { files: Map<string, string>; diff: (replacement: string) => string } {
  const files = new Map(pristine);
  const original = files.get("calc.ts")!;
  expect(original).toContain("return a + b;");
  const broken = original.replace("return a + b;", "return a + ;");
  files.set("calc.ts", broken);
  const lines = broken.split("\n");
  const index = lines.indexOf("  return a + ;");
  expect(index).toBeGreaterThan(0);
  const diff = (replacement: string): string =>
    [
      `@@ -${String(index)},3 +${String(index)},3 @@`,
      ` ${lines[index - 1]!}`,
      "-  return a + ;",
      `+${replacement}`,
      ` ${lines[index + 1]!}`,
      "",
    ].join("\n");
  return { files, diff };
}

function repairProposer(diff: string): { proposer: RepairProposer; model: FakeChatModel } {
  const model = new FakeChatModel([
    {
      kind: "text",
      text: JSON.stringify({
        unit: "calc.py",
        diff,
        rationale: "restore the missing operand",
      }),
      inputTokens: 400,
      outputTokens: 40,
    },
  ]);
  return { proposer: new AiRepairProposer({ model }), model };
}

describe("end-to-end repair (real validators, fake model)", () => {
  it("repairs a corrupted translation and commits the improved state", async () => {
    const { files, diff } = corrupt();
    const baseline = await validate(files);
    expect(baseline[0]!.status).toBe("fail");
    const { proposer, model } = repairProposer(diff("  return a + b;"));

    const result = await runRepairLoop(
      {
        files,
        units: [{ unit: "calc.py", targetPath: "calc.ts", sourceText: SOURCE }],
        stages: baseline,
      },
      { proposer, validate },
    );

    expect(result.stopReason).toBe("success");
    expect(result.acceptedUnits).toEqual(["calc.py"]);
    expect(result.finalStateHash).not.toBe(result.baselineStateHash);
    expect(result.files.get("calc.ts")).toContain("return a + b;");
    expect(result.files.get("calc.ts")).not.toContain("return a + ;");
    const finalStages = result.stages;
    expect(finalStages.find((stage) => stage.stage === "S1-syntax")!.status).toBe("pass");
    expect(finalStages.find((stage) => stage.stage === "S2-types")!.status).toBe("pass");
    expect(model.calls.length).toBe(1);

    // The journal records the accepted attempt with hashes only.
    const journal = new RepairJournal();
    journal.append({
      runId: "e2e-accepted",
      timestamp: "2026-10-21T00:00:00.000Z",
      stopReason: result.stopReason,
      baselineStateHash: result.baselineStateHash,
      finalStateHash: result.finalStateHash,
      acceptedUnits: result.acceptedUnits,
      filesChanged: ["calc.ts"],
      attempts: result.attempts,
    });
    const text = journal.toJson();
    expect(text).toContain('"decision": "accepted"');
    expect(text).not.toContain("return a + b;");
    expect(text).not.toContain("def add");
  }, 60000);

  it("negative: a still-broken patch is rejected and the baseline bytes stay", async () => {
    const { files, diff } = corrupt();
    const baseline = await validate(files);
    const originalHash = stateHash(files);
    const { proposer } = repairProposer(diff("  return a + b + ;"));

    const result = await runRepairLoop(
      {
        files,
        units: [{ unit: "calc.py", targetPath: "calc.ts", sourceText: SOURCE }],
        stages: baseline,
      },
      { proposer, validate },
    );

    expect(result.acceptedUnits).toEqual([]);
    expect(result.stopReason).toBe("attempts-exhausted");
    expect(result.files.get("calc.ts")).toBe(files.get("calc.ts"));
    expect(result.files.get("calc.ts")).toContain("return a + ;");
    expect(result.finalStateHash).toBe(originalHash);
    expect(result.attempts[0]!.decision).toBe("rejected");
    expect(result.stages).toEqual(baseline);
  }, 60000);

  it("AI disabled: no repair is attempted, output stays byte-identical", async () => {
    const { files } = corrupt();
    const baseline = await validate(files);
    const originalHash = stateHash(files);
    const result = await runRepairLoop(
      {
        files,
        units: [{ unit: "calc.py", targetPath: "calc.ts", sourceText: SOURCE }],
        stages: baseline,
      },
      { proposer: new DisabledRepairProposer(), validate },
    );
    expect(result.stopReason).toBe("repair-unavailable");
    expect(result.finalStateHash).toBe(originalHash);
    expect(result.attempts[0]!.proposalOutcome).toBe("ai-disabled");
  }, 60000);
});

describe("M8 regression: ambiguity resolution still works through the same model stack", () => {
  it("resolves a Python match strategy via AiAmbiguityResolver and records provenance", async () => {
    const model = new FakeChatModel([
      { kind: "text", text: '{"optionId":"switch"}', inputTokens: 100, outputTokens: 5 },
    ]);
    const resolver = new AiAmbiguityResolver({ model });
    const requests: AmbiguityRequest[] = [];
    const parseResult = await py.parse(AST_MATCH, { filename: "mod.py" });
    const result = await runPipeline([{ filename: "mod.py", parseResult }], {
      target: "typescript",
      translateUnit: await createPyToJsTranslator("typescript"),
      validateSyntax: await createOxcSyntaxValidator(),
      resolveAmbiguity: {
        async resolve(request) {
          requests.push(request);
          return resolver.resolve(request);
        },
      },
    });
    expect(requests.length).toBe(1);
    expect(requests[0]!.options.map((option) => option.id)).toContain("switch");
    const output = result.emittedFiles.find((file) => file.targetPath === "mod.ts")!;
    expect(output.content).toContain("switch (");
    const ambiguous = result.ledger.filter((entry) => entry.decision === "ambiguous");
    expect(ambiguous.length).toBeGreaterThan(0);
    expect(ambiguous[0]!.escalation?.provider).toBe("fake");
    expect(ambiguous[0]!.candidates).toContain("switch");
  }, 60000);
});
