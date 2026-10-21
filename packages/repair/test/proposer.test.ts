// `proposeRepairPatch` contract (M9 WS B): strict JSON fields, unit-scoped diff,
// one bounded re-ask, no model call when the secret gate blocks, and typed
// outcomes for provider failures, declines, caps, and oversized packets.
import { describe, expect, it } from "vitest";

import { FakeChatModel, type FakeReply } from "@ctrans/ai";

import { AiRepairProposer } from "../src/index.js";
import { EMITTED_TEXT, FIX_DIFF, requestFor } from "./helpers.js";

const GITHUB_TOKEN_SHAPED = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij";

function reply(diff: string, unit = "calc.py"): string {
  return JSON.stringify({ unit, diff, rationale: "restore the missing operand" });
}

function modelWith(replies: readonly FakeReply[]): FakeChatModel {
  return new FakeChatModel(replies);
}

describe("AiRepairProposer: accepted output", () => {
  it("returns a validated, unit-scoped patch with provenance", async () => {
    const model = modelWith([
      { kind: "text", text: reply(FIX_DIFF), inputTokens: 120, outputTokens: 30 },
    ]);
    const proposer = new AiRepairProposer({ model });
    const proposal = await proposer.propose(requestFor());
    expect(proposal.outcome).toBe("patch");
    expect(proposal.patch).not.toBeNull();
    expect(proposal.patch!.unit).toBe("calc.py");
    expect(proposal.patch!.targetPath).toBe("calc.ts");
    expect(proposal.patch!.escalation).toEqual({
      provider: "fake",
      model: "scripted",
      promptHash: expect.any(String) as string,
    });
    expect(proposal.patch!.promptHash).toMatch(/^[a-f0-9]{64}$/);
    expect(proposal.patch!.promptHash).not.toBe(proposal.patch!.diffHash);
    expect(proposal.patch!.escalation.promptHash).toBe(proposal.patch!.promptHash);
    expect(proposal.inputTokens).toBe(120);
    expect(proposal.outputTokens).toBe(30);
    // The model receives the emitted baseline inside a fenced data block.
    const sent = model.calls[0]!.messages[0]!.content;
    expect(sent).toContain("CURRENT TRANSLATED FILE:");
    expect(sent).toContain("return a + ;");
    expect(sent).toContain("<<<CTRANS-REPAIR-DATA ");
  });

  it("tolerates fenced JSON but re-asks once when the first reply is malformed", async () => {
    const model = modelWith([
      { kind: "text", text: "not json at all" },
      { kind: "text", text: "```json\n" + reply(FIX_DIFF) + "\n```" },
    ]);
    const proposal = await new AiRepairProposer({ model }).propose(requestFor());
    expect(proposal.outcome).toBe("patch");
    expect(model.calls.length).toBe(2);
    expect(model.calls[1]!.messages[0]!.content).toContain("YOUR PREVIOUS REPLY WAS INVALID");
  });

  it("rejects a reply that targets a different unit (out of scope), after one re-ask", async () => {
    const model = modelWith([{ kind: "text", text: reply(FIX_DIFF, "other.py") }]);
    const proposal = await new AiRepairProposer({ model }).propose(requestFor());
    expect(proposal.outcome).toBe("invalid-output");
    expect(proposal.reason).toContain('instead of "calc.py"');
    expect(model.calls.length).toBe(2);
  });

  it("rejects diffs whose file header targets another file", async () => {
    const foreign = `--- a/other.ts\n+++ b/other.ts\n${FIX_DIFF}`;
    const model = modelWith([{ kind: "text", text: reply(foreign) }]);
    const proposal = await new AiRepairProposer({ model }).propose(requestFor());
    expect(proposal.outcome).toBe("invalid-output");
    expect(proposal.patch).toBeNull();
    expect(model.calls.length).toBe(2);
  });

  it("rejects forbidden patch operations instead of guessing them", async () => {
    for (const diff of [
      "Binary files a/calc.ts and b/calc.ts differ",
      `new file mode 100644\n${FIX_DIFF}`,
      `rename from calc.ts\nrename to gone.ts\n${FIX_DIFF}`,
      "@@ -1,1 +1,1 @@\n+inserted without context",
    ]) {
      const model = modelWith([{ kind: "text", text: reply(diff) }]);
      const proposal = await new AiRepairProposer({ model }).propose(requestFor());
      expect(proposal.outcome).toBe("invalid-output");
    }
  });

  it("rejects a diff that does not apply to the current unit text", async () => {
    const stale = FIX_DIFF.replace("  return a + ;", "  return totallyDifferent();");
    const model = modelWith([{ kind: "text", text: reply(stale) }]);
    const proposal = await new AiRepairProposer({ model }).propose(requestFor());
    expect(proposal.outcome).toBe("invalid-output");
    expect(proposal.reason).toContain("does not match");
  });

  it("rejects a diff that weakens validation (ts-nocheck) instead of applying it", async () => {
    const suppress = [
      "@@ -1,1 +1,2 @@",
      "+// @ts-nocheck",
      " export function add(a: number, b: number): number {",
      "",
    ].join("\n");
    const model = modelWith([{ kind: "text", text: reply(suppress) }]);
    const proposal = await new AiRepairProposer({ model }).propose(requestFor());
    expect(proposal.outcome).toBe("invalid-output");
    expect(proposal.reason).toContain("forbidden construct");
    expect(model.calls.length).toBe(2);
  });

  it("treats an explicitly empty diff as a decline, not a malformed patch", async () => {
    const model = modelWith([
      {
        kind: "text",
        text: JSON.stringify({ unit: "calc.py", diff: "", rationale: "no safe minimal fix" }),
      },
    ]);
    const proposal = await new AiRepairProposer({ model }).propose(requestFor());
    expect(proposal.outcome).toBe("declined");
    expect(proposal.reason).toContain("no safe minimal fix");
    expect(proposal.patch).toBeNull();
    expect(model.calls.length).toBe(1);
  });
});

describe("AiRepairProposer: gates, caps, and provider failures", () => {
  it("never calls the model when the secret gate blocks the payload", async () => {
    const model = modelWith([{ kind: "text", text: reply(FIX_DIFF) }]);
    const proposer = new AiRepairProposer({ model });
    const proposal = await proposer.propose(
      requestFor({ emittedText: `// token ${GITHUB_TOKEN_SHAPED}\n${EMITTED_TEXT}` }),
    );
    expect(proposal.outcome).toBe("blocked-secret");
    expect(proposal.secretRuleIds.length).toBeGreaterThan(0);
    expect(model.calls.length).toBe(0);
    // Rule ids only — the secret value is never echoed back.
    expect(JSON.stringify(proposal)).not.toContain(GITHUB_TOKEN_SHAPED);
  });

  it("maps provider errors to a typed outcome", async () => {
    const model = modelWith([{ kind: "error", code: "AI-HTTP-ERROR", message: "502 upstream" }]);
    const proposal = await new AiRepairProposer({ model }).propose(requestFor());
    expect(proposal.outcome).toBe("provider-error");
    expect(proposal.reason).toContain("502");
  });

  it("maps request timeouts to a typed provider error", async () => {
    const model = modelWith([{ kind: "delay", ms: 5000, text: reply(FIX_DIFF) }]);
    const proposer = new AiRepairProposer({ model, caps: { perRequestTimeoutMs: 20 } });
    const proposal = await proposer.propose(requestFor());
    expect(proposal.outcome).toBe("provider-error");
    expect(model.calls.length).toBe(1);
  });

  it("enforces the shared M8 call cap across propose() calls", async () => {
    const model = modelWith([{ kind: "text", text: "not json" }]);
    const proposer = new AiRepairProposer({ model, caps: { maxCallsPerRun: 2 } });
    expect((await proposer.propose(requestFor())).outcome).toBe("invalid-output");
    expect(model.calls.length).toBe(2);
    // Budget is run-scoped: the next propose cannot acquire a call.
    const blocked = await proposer.propose(requestFor({ attempt: 2 }));
    expect(blocked.outcome).toBe("cap-exhausted");
    expect(model.calls.length).toBe(2);
  });

  it("rejects oversized evidence packets without calling the model", async () => {
    const model = modelWith([{ kind: "text", text: reply(FIX_DIFF) }]);
    const proposer = new AiRepairProposer({ model, maxInputTokens: 5 });
    const proposal = await proposer.propose(requestFor());
    expect(proposal.outcome).toBe("packet-too-large");
    expect(model.calls.length).toBe(0);
  });

  it("serves an identical request from the cache without a second model call", async () => {
    const model = modelWith([
      { kind: "text", text: reply(FIX_DIFF), inputTokens: 10, outputTokens: 5 },
    ]);
    const proposer = new AiRepairProposer({ model });
    const first = await proposer.propose(requestFor());
    const second = await proposer.propose(requestFor());
    expect(first.outcome).toBe("patch");
    expect(second.outcome).toBe("patch");
    expect(model.calls.length).toBe(1);
  });

  it("rejects a diff above the configured byte cap", async () => {
    const model = modelWith([{ kind: "text", text: reply(FIX_DIFF) }]);
    const proposer = new AiRepairProposer({ model, maxDiffBytes: 10 });
    const proposal = await proposer.propose(requestFor());
    expect(proposal.outcome).toBe("invalid-output");
    expect(proposal.reason).toContain("byte cap");
  });
});
