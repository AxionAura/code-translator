import { describe, expect, it } from "vitest";

import { BRIDGE_PROTOCOL_VERSION, packageName } from "../src/index.js";

describe("@ctrans/parser-py package", () => {
  it("keeps its identity export", () => {
    expect(packageName).toBe("@ctrans/parser-py");
  });

  it("exposes the public front-end surface", async () => {
    const api = await import("../src/index.js");
    expect(typeof api.createPythonBridgeParser).toBe("function");
    expect(typeof api.createPythonParser).toBe("function");
    expect(typeof api.createTreeSitterPythonParser).toBe("function");
    expect(api.PY_SYNTAX).toBe("PY-SYNTAX");
    expect(BRIDGE_PROTOCOL_VERSION).toBe(1);
  });
});
