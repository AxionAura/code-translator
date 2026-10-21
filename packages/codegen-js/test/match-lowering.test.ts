// M8: `match` statement lowering — the engine-classified AMBIGUOUS construct that
// hosts the AI escalation port. Both offered strategies are engine-implemented;
// the heuristic default (if-chain) applies with AI disabled, and the ledger
// records candidates + the chosen strategy (+ escalation provenance when AI
// resolved it).
import { beforeAll, describe, expect, it } from "vitest";

import {
  runPipeline,
  type AmbiguityDecision,
  type AmbiguityRequest,
  type AmbiguityResolver,
} from "@ctrans/core";
import { createPythonBridgeParser, type PythonBridgeParser } from "@ctrans/parser-py";
import { createOxcSyntaxValidator } from "@ctrans/parser-js";
import { createPyToJsTranslator } from "../src/translator.js";

let py: PythonBridgeParser;

beforeAll(async () => {
  py = await createPythonBridgeParser();
});

const MATCH_LITERALS = [
  "def classify(value):",
  "    match value:",
  "        case 1:",
  "            return 'one'",
  "        case 'two':",
  "            return 'two'",
  "        case _:",
  "            return 'other'",
].join("\n");

async function translate(
  source: string,
  resolver?: AmbiguityResolver,
): Promise<{ output: string; ledger: Awaited<ReturnType<typeof runPipeline>>["ledger"] }> {
  const parseResult = await py.parse(source, { filename: "mod.py" });
  const result = await runPipeline([{ filename: "mod.py", parseResult }], {
    target: "typescript",
    translateUnit: await createPyToJsTranslator("typescript"),
    validateSyntax: await createOxcSyntaxValidator(),
    ...(resolver === undefined ? {} : { resolveAmbiguity: resolver }),
  });
  return {
    output: result.emittedFiles.find((file) => file.targetPath === "mod.ts")!.content,
    ledger: result.ledger,
  };
}

function resolverReturning(
  choice: string | null,
  calls: AmbiguityRequest[] = [],
): AmbiguityResolver {
  return {
    async resolve(request: AmbiguityRequest): Promise<AmbiguityDecision | null> {
      calls.push(request);
      if (choice === null) return null;
      return {
        optionId: choice,
        escalation: { provider: "fake", model: "fake-1", promptHash: "abc123" },
      };
    },
  };
}

describe("match lowering: ambiguous strategy", () => {
  it("AI disabled and AI-unavailable produce byte-identical output (heuristic path)", async () => {
    // docs/roadmap M8 completion: with AI disabled the pipeline output is exactly
    // the deterministic result — a resolver that declines/times out never changes
    // the bytes or the ledger decisions.
    const disabled = await translate(MATCH_LITERALS);
    const declining = await translate(MATCH_LITERALS, resolverReturning(null));
    expect(declining.output).toBe(disabled.output);
    const stripped = (ledger: typeof disabled.ledger): string =>
      JSON.stringify(ledger.map(({ escalation: _escalation, ...rest }) => rest));
    expect(stripped(declining.ledger)).toBe(stripped(disabled.ledger));
  });

  it("applies the if-chain heuristic by default (AI disabled) and records candidates", async () => {
    const { output, ledger } = await translate(MATCH_LITERALS);
    expect(output).toContain("if (__ctrans_eq(__ctrans_match1, 1))");
    expect(output).toContain('} else if (__ctrans_eq(__ctrans_match1, "two"))');
    expect(output).toContain("} else {");
    const entry = ledger.find((candidate) => candidate.sourceKind === "py.Match")!;
    expect(entry.decision).toBe("ambiguous");
    expect(entry.candidates).toEqual(["if-chain", "switch"]);
    expect(entry.escalation).toBeNull();
    expect(entry.targetSummary).toBe("if-chain");
  });

  it("accepts the switch option when a resolver chooses it and records provenance", async () => {
    const calls: AmbiguityRequest[] = [];
    const { output, ledger } = await translate(MATCH_LITERALS, resolverReturning("switch", calls));
    expect(calls.length).toBe(1);
    expect(calls[0]!.unit).toBe("mod.py");
    expect(calls[0]!.options.map((option) => option.id)).toEqual(["if-chain", "switch"]);
    expect(calls[0]!.summary).toContain("match on value");
    expect(output).toContain("switch (__ctrans_match1)");
    expect(output).toContain("case 1: {");
    expect(output).toContain("default: {");
    const entry = ledger.find((candidate) => candidate.sourceKind === "py.Match")!;
    expect(entry.rule).toBe("py.Match→js.switch");
    expect(entry.escalation).toEqual({ provider: "fake", model: "fake-1", promptHash: "abc123" });
  });

  it("rejects an option the engine did not offer (falls back to the heuristic)", async () => {
    const { output, ledger } = await translate(
      MATCH_LITERALS,
      resolverReturning("invented-strategy"),
    );
    expect(output).toContain("if (__ctrans_eq(__ctrans_match1, 1))");
    const entry = ledger.find((candidate) => candidate.sourceKind === "py.Match")!;
    expect(entry.targetSummary).toBe("if-chain");
    expect(entry.escalation).toBeNull();
  });

  it("falls back to the heuristic when the resolver returns null or throws", async () => {
    const nullResult = await translate(MATCH_LITERALS, resolverReturning(null));
    expect(nullResult.output).toContain("if (__ctrans_eq(");
    const throwing: AmbiguityResolver = {
      async resolve() {
        throw new Error("provider down");
      },
    };
    const thrown = await translate(MATCH_LITERALS, throwing);
    expect(thrown.output).toContain("if (__ctrans_eq(");
    expect(thrown.ledger.find((entry) => entry.sourceKind === "py.Match")!.escalation).toBeNull();
  });

  it("lowers captures and guards through the if-chain and binds capture names", async () => {
    const { output } = await translate(
      [
        "def describe(value):",
        "    match value:",
        "        case 0 if value > 10:",
        "            return 'positive zero?'",
        "        case other:",
        "            return other",
      ].join("\n"),
    );
    expect(output).toContain("__ctrans_eq(__ctrans_match1, 0) && __ctrans_gt(value, 10)");
    expect(output).toContain("const other = __ctrans_match1;");
    expect(output).toContain("return other;");
  });

  it("offers only the if-chain when captures are present (switch is not applicable)", async () => {
    const calls: AmbiguityRequest[] = [];
    await translate(
      [
        "def describe(value):",
        "    match value:",
        "        case 'x':",
        "            return 1",
        "        case other:",
        "            return other",
      ].join("\n"),
      resolverReturning("switch", calls),
    );
    // A single applicable strategy is not an escalation request.
    expect(calls.length).toBe(0);
  });

  it("keeps pattern kinds outside the subset unsupported-loud", async () => {
    const { output, ledger } = await translate(
      [
        "def f(value):",
        "    match value:",
        "        case [a, b]:",
        "            return a",
        "        case _:",
        "            return None",
      ].join("\n"),
    );
    expect(output).toContain("ctrans: unsupported py.Match");
    const entry = ledger.find((candidate) => candidate.sourceKind === "py.Match")!;
    expect(entry.decision).toBe("unsupported");
  });

  it("translates nested matches in function bodies (collector walks the AST)", async () => {
    const calls: AmbiguityRequest[] = [];
    const { output } = await translate(
      [
        "def f(outer, inner):",
        "    match outer:",
        "        case 1:",
        "            match inner:",
        "                case 2:",
        "                    return 'both'",
        "                case _:",
        "                    return 'outer-only'",
        "        case _:",
        "            return 'none'",
      ].join("\n"),
      resolverReturning("switch", calls),
    );
    expect(calls.length).toBe(2);
    expect(output).toContain("switch (__ctrans_match1)");
    expect(output).toContain("switch (__ctrans_match2)");
  });
});
