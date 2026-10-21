// M8 CLI integration (docs/ai-architecture.md §6): AI is off by default and the
// pipeline must work with no network; enabling it wires the resolver from flags;
// the journal lands in .ctrans/ with hash-only provenance.
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import { FakeChatModel, type ChatModel } from "@ctrans/ai";

import { buildAiWiring, summarizeAiJournal } from "../src/ai-wiring.ts";
import { runCliCommand } from "../src/main.ts";
import { checkPath, translatePath } from "../src/translate.ts";
import type { AmbiguityResolver } from "@ctrans/core";

const dirs: string[] = [];
const originalFetch = globalThis.fetch;

function makeProject(name: string, files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), `ctrans-m8-${name}-`));
  dirs.push(root);
  for (const [path, content] of Object.entries(files)) {
    const absolute = join(root, path);
    mkdirSync(join(absolute, ".."), { recursive: true });
    writeFileSync(absolute, content);
  }
  return root;
}

const MATCH_PY = (tokenFree = true) =>
  [
    `"""Match demo${tokenFree ? "" : ""}."""`,
    "",
    "def classify(value):",
    "    match value:",
    "        case 1:",
    "            return 'one'",
    "        case 'two':",
    "            return 'two'",
    "        case _:",
    "            return 'other'",
    "",
  ].join("\n");

afterAll(() => {
  globalThis.fetch = originalFetch;
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("AI disabled by default (zero-network proof)", () => {
  it("translates with fetch patched to throw — no outbound call is attempted", async () => {
    globalThis.fetch = (() => {
      throw new Error("network access attempted in AI-disabled mode");
    }) as typeof fetch;
    const root = makeProject("offline", { "mod.py": MATCH_PY() });
    const result = await runCliCommand(["check", join(root, "mod.py"), "--to", "ts"]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("claim level");
    expect(result.stdout).not.toContain("ai escalations");
  });

  it("applies the documented heuristic default and records candidates", async () => {
    const root = makeProject("heuristic", { "mod.py": MATCH_PY() });
    const outcome = await checkPath(join(root, "mod.py"), "typescript");
    const entry = outcome.report.ambiguous.find((candidate) => candidate.rule.includes("py.Match"));
    expect(entry?.chosen).toBe("if-chain");
    expect(outcome.files.get("mod.ts")!).toContain("__ctrans_eq(");
  });
});

describe("AI enabled via flags (scripted model)", () => {
  function scriptedFactory(): (provider: string, model: string, baseUrl: string) => ChatModel {
    return (_provider, model) =>
      new FakeChatModel([{ kind: "text", text: '{"optionId":"switch"}' }], `fake:${model}`);
  }

  it("buildAiWiring requires a key for real providers and builds scripted models in tests", () => {
    expect(buildAiWiring({})).toBeNull();
    const previous = process.env["CTRANS_AI_KEY"];
    delete process.env["CTRANS_AI_KEY"];
    expect(() => buildAiWiring({ provider: "openai" })).toThrowError(/CTRANS_AI_KEY/);
    expect(() => buildAiWiring({ provider: "mystery" })).toThrowError(/unknown AI provider/);
    if (previous !== undefined) process.env["CTRANS_AI_KEY"] = previous;
    const scripted = buildAiWiring({ provider: "openai", modelFactory: scriptedFactory() });
    expect(scripted?.provider).toBe("openai");
    expect(scripted?.resolver).toBeDefined();
  });

  it("escalation through a resolver selects switch and writes the journal", async () => {
    const root = makeProject("escalate", { "mod.py": MATCH_PY() });
    const out = join(root, "out");
    const model = new FakeChatModel(
      [{ kind: "text", text: '{"optionId":"switch"}', inputTokens: 30, outputTokens: 5 }],
      "fake:fake-1",
    );
    const wiring = buildAiWiring({
      provider: "openai",
      modelFactory: () => model,
    })!;
    const outcome = await translatePath(
      join(root, "mod.py"),
      "typescript",
      out,
      "number",
      wiring.resolver,
    );
    expect(model.calls.length).toBe(1);
    const emitted = outcome.files.get("mod.ts")!;
    expect(emitted).toContain("switch (__ctrans_match1)");
    expect(summarizeAiJournal(wiring.journal)).toBe("ai escalations: 1 (resolved: 1)");
    // The ledger carries escalation provenance; the journal has no prompt text.
    const ledger = JSON.parse(readFileSync(join(out, ".ctrans", "ledger.json"), "utf8")) as {
      rule: string;
      escalation: { provider: string; model: string; promptHash: string } | null;
    }[];
    const matchEntry = ledger.find((entry) => entry.rule.includes("py.Match"))!;
    expect(matchEntry.escalation).toMatchObject({ provider: "fake", model: "fake-1" });
    expect(matchEntry.escalation!.promptHash).toMatch(/^[0-9a-f]{64}$/);
    const journalText = JSON.stringify(wiring.journal.toJson());
    expect(journalText).not.toContain("case 1");
    expect(journalText).not.toContain("system-instructions");
  });
});

describe("AI + validation interplay", () => {
  it("a model choice cannot bypass validation or the claim ladder", async () => {
    const root = makeProject("ladder", {
      // Match output is valid; S2 must still run and the claim derives from stages.
      "mod.py": MATCH_PY(),
    });
    const resolver: AmbiguityResolver = {
      async resolve() {
        return {
          optionId: "switch",
          escalation: { provider: "fake", model: "m", promptHash: "h" },
        };
      },
    };
    const outcome = await checkPath(join(root, "mod.py"), "typescript", "number", resolver);
    expect(outcome.report.claimLevel).toBe(3);
    const stages = new Map(
      outcome.report.validationStages.map((stage) => [stage.stage, stage.status]),
    );
    expect(stages.get("S1-syntax")).toBe("pass");
    expect(stages.get("S2-types")).toBe("pass");
  });
});
