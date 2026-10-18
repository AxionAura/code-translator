// Hostile-input containment (ADR D-020): deeply nested sources must produce a typed
// JsSourceLimitError — never a native crash, and never a misreported syntax error
// when the Babel probe exhausts its stack first (regression: the probe's catch used
// to wrap RangeErrors as JsSyntaxError, defeating the oxc limit guard).
import { describe, expect, it } from "vitest";

import { OxcJsParser } from "../src/oxc-parser.js";
import { BabelJsParser } from "../src/babel-parser.js";
import { JsSourceLimitError, JsSyntaxError } from "../src/errors.js";

describe("deep-input containment (D-020)", () => {
  it("oxc path maps over-deep sources to JsSourceLimitError", async () => {
    const parser = await OxcJsParser.create();
    const deep = "(".repeat(2500) + "1" + ")".repeat(2500);
    await expect(
      parser.parse(deep, { filename: "deep.js", language: "javascript" }),
    ).rejects.toBeInstanceOf(JsSourceLimitError);
  });

  it("the Babel probe keeps RangeError identity on stack exhaustion (regression)", async () => {
    const parser = await BabelJsParser.create();
    let outcome: "syntax" | "range" | "limit" | "none" = "none";
    try {
      const probe = "(".repeat(2500) + "1" + ")".repeat(2500);
      await parser.parse(probe, { filename: "deep.js", language: "javascript" });
    } catch (error) {
      if (error instanceof RangeError) outcome = "range";
      else if (error instanceof JsSourceLimitError) outcome = "limit";
      else if (error instanceof JsSyntaxError) outcome = "syntax";
    }
    // Either the parse survives (no crash) or fails as a resource limit — a plain
    // "syntax error" classification would be a lie about the failure mode.
    expect(["range", "limit", "none"]).toContain(outcome);
  });
});
