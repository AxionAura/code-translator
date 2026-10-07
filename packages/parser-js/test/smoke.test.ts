import { describe, expect, it } from "vitest";

import { packageName } from "../src/index.js";

describe("@ctrans/parser-js package", () => {
  it("keeps its identity export", () => {
    expect(packageName).toBe("@ctrans/parser-js");
  });

  it("exposes the public front-end surface", async () => {
    const api = await import("../src/index.js");
    expect(typeof api.createOxcJsParser).toBe("function");
    expect(typeof api.createBabelJsParser).toBe("function");
    expect(typeof api.createJsParser).toBe("function");
    expect(typeof api.TypeScriptSemanticOracle).toBe("function");
    expect(api.JS_SYNTAX).toBe("JS-SYNTAX");
  });
});
