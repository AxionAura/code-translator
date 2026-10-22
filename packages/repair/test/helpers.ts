// Shared fixtures for the repair tests. Deterministic only: no clocks, no
// network, no providers (FakeChatModel / scripted proposers).
import { hashText } from "@axion-ct/ai";
import type { LedgerEntry, StageResult, ValidationStageName } from "@axion-ct/core";

import { classifyFailures, type ClassifiedFailure } from "../src/categories.js";
import type { RepairProposal, RepairProposer, RepairRequest } from "../src/types.js";

export const EMITTED_TEXT = [
  "export function add(a: number, b: number): number {",
  "  return a + ;",
  "}",
  "",
].join("\n");

export const FIX_DIFF = [
  "@@ -1,3 +1,3 @@",
  " export function add(a: number, b: number): number {",
  "-  return a + ;",
  "+  return a + b;",
  " }",
  "",
].join("\n");

export function stageResult(
  stage: ValidationStageName,
  status: StageResult["status"],
  reason: string | null = null,
  details: readonly string[] = [],
): StageResult {
  return { stage, status, reason, details };
}

// The two stages a real repair run sees for a TypeScript target (S1 syntax,
// S2 types); everything else is out of scope for unit-level repair tests.
export function twoStage(
  s1: StageResult["status"],
  s2: StageResult["status"],
  details: readonly string[] = [],
): StageResult[] {
  return [
    stageResult(
      "S1-syntax",
      s1,
      s1 === "fail" ? "syntax error" : null,
      s1 === "fail" ? details : [],
    ),
    stageResult("S2-types", s2, s2 === "fail" ? "type error" : null, s2 === "fail" ? details : []),
  ];
}

export function failureFor(
  stages: readonly StageResult[] = [
    stageResult("S1-syntax", "fail", "syntax error", ["calc.ts: Unexpected token"]),
  ],
): ClassifiedFailure {
  return classifyFailures(stages)[0]!;
}

export function requestFor(overrides: Partial<RepairRequest> = {}): RepairRequest {
  const failure = overrides.failure ?? failureFor();
  return {
    unit: "calc.py",
    targetPath: "calc.ts",
    sourceText: "def add(a, b):\n    return a + b\n",
    emittedText: EMITTED_TEXT,
    failure,
    diagnostics: [...failure.details],
    ledgerSummary: ["py.FunctionDef [semantic]"],
    attempt: 1,
    priorAttempts: [],
    ...overrides,
  };
}

export function patchProposal(
  request: RepairRequest,
  diff: string,
  rationale = "test patch",
): RepairProposal {
  return {
    outcome: "patch",
    patch: {
      unit: request.unit,
      targetPath: request.targetPath,
      diff,
      rationale,
      promptHash: hashText(`prompt:${request.unit}`),
      escalation: { provider: "fake", model: "scripted", promptHash: hashText(diff) },
      diffHash: hashText(diff),
    },
    reason: null,
    inputTokens: 10,
    outputTokens: 5,
    secretRuleIds: [],
  };
}

export function nonPatchProposal(
  outcome: RepairProposal["outcome"],
  reason: string,
  secretRuleIds: readonly string[] = [],
): RepairProposal {
  return {
    outcome,
    patch: null,
    reason,
    inputTokens: null,
    outputTokens: null,
    secretRuleIds,
  };
}

// Deterministic proposer: records every request, replies from a handler.
export class ScriptedProposer implements RepairProposer {
  readonly requests: RepairRequest[] = [];
  private readonly handler: (request: RepairRequest) => RepairProposal | Promise<RepairProposal>;

  constructor(handler: (request: RepairRequest) => RepairProposal | Promise<RepairProposal>) {
    this.handler = handler;
  }

  async propose(request: RepairRequest): Promise<RepairProposal> {
    this.requests.push(request);
    return this.handler(request);
  }
}

// A patch that rewrites the marker line; distinct `value`s yield distinct diffs.
export function markerDiff(value: string, declaredLine = 1): string {
  return [
    `@@ -${String(declaredLine)},2 +${String(declaredLine)},2 @@`,
    "-// attempt marker",
    `+// attempt marker ${value}`,
    " export const value = 1;",
    "",
  ].join("\n");
}

export const MARKER_TEXT = "// attempt marker\nexport const value = 1;\n";

export function ledgerEntry(overrides: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    id: "calc.py#001",
    unit: "calc.py",
    span: null,
    sourceKind: "py.FunctionDef",
    rule: "py.FunctionDef",
    decision: "semantic",
    rationale: "test",
    adaptation: null,
    targetSummary: null,
    warnings: [],
    escalation: null,
    ...overrides,
  };
}
