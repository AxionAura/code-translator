// Fail-closed and test-double contracts: the scanner error path must block, the
// USD/wall-clock caps must deny, and FakeChatModel's delay/error modes behave.
import { describe, expect, it } from "vitest";

import type { AmbiguityRequest } from "@ctrans/core";

import {
  AiAmbiguityResolver,
  AiBudget,
  AiJournal,
  FakeChatModel,
  type SecretGate,
} from "../src/index.js";

const REQUEST: AmbiguityRequest = {
  unit: "u.py",
  rule: "py.Match",
  sourceKind: "py.Match",
  span: null,
  summary: "match on value",
  contracts: [],
  diagnostics: [],
  options: [
    { id: "if-chain", description: "chain" },
    { id: "switch", description: "switch" },
  ],
  heuristic: "if-chain",
};

describe("fail-closed secret gate", () => {
  it("a throwing scanner blocks the request (never bypassed)", async () => {
    const gate: SecretGate = {
      scan: async () => {
        throw new Error("scanner crashed");
      },
    };
    const model = new FakeChatModel([{ kind: "text", text: '{"optionId":"switch"}' }], "fake:1");
    const journal = new AiJournal();
    // The resolver treats a thrown scan as indeterminate → propagates out of the
    // gate implementation only if the gate itself throws; the SecretlintGate maps
    // errors to blocked. A raw throwing gate must not call the model either.
    await expect(
      new AiAmbiguityResolver({ model, gate, journal }).resolve(REQUEST),
    ).rejects.toThrow(/scanner crashed/);
    expect(model.calls.length).toBe(0);
  });
});

describe("budget caps", () => {
  it("denies the wall-clock cap deterministically", () => {
    let now = 0;
    const budget = new AiBudget({ maxRunWallClockMs: 100 }, () => now);
    expect(budget.tryAcquire(1)).toEqual({ ok: true });
    now = 200;
    expect(budget.tryAcquire(1)).toEqual({ ok: false, reason: "wall-clock" });
  });

  it("tracks reported USD and reports cap exceedance", () => {
    const budget = new AiBudget({ maxUsdPerRun: 0.01 });
    budget.tryAcquire(10);
    budget.record({ inputTokens: 5, outputTokens: 5, usd: 0.02 });
    expect(budget.usdExceeded()).toBe(true);
    expect(budget.state().usd).toBeCloseTo(0.02);
  });

  it("counts reported tokens on top of the estimate", () => {
    const budget = new AiBudget({ maxTokensPerRun: 1000 });
    budget.tryAcquire(10);
    budget.record({ inputTokens: 40, outputTokens: 10, usd: null });
    expect(budget.state().tokens).toBe(60);
  });
});

describe("FakeChatModel contract", () => {
  it("exposes scripted works, errors, and delays; records every request", async () => {
    const model = new FakeChatModel(
      [
        { kind: "text", text: "a", inputTokens: 1, outputTokens: 2 },
        { kind: "error", code: "AI-HTTP-ERROR", message: "boom" },
        { kind: "delay", ms: 5, text: "b" },
      ],
      "fake:scripted",
    );
    const first = await model.complete({ messages: [{ role: "user", content: "x" }] });
    expect(first.text).toBe("a");
    await expect(model.complete({ messages: [] })).rejects.toMatchObject({ code: "AI-HTTP-ERROR" });
    const delayed = await model.complete({ messages: [] });
    expect(delayed.text).toBe("b");
    expect(model.calls.length).toBe(3);
  });

  it("honors abort during a scripted delay", async () => {
    const model = new FakeChatModel([{ kind: "delay", ms: 5000, text: "late" }], "fake:1");
    const controller = new AbortController();
    const promise = model.complete({ messages: [] }, controller.signal);
    setTimeout(() => controller.abort(), 10);
    await expect(promise).rejects.toMatchObject({ code: "AI-ABORTED" });
  });

  it("an unscripted model fails loudly instead of returning empty text", async () => {
    const model = new FakeChatModel([], "fake:empty");
    await expect(model.complete({ messages: [] })).rejects.toMatchObject({ code: "AI-NO-SCRIPT" });
  });
});
