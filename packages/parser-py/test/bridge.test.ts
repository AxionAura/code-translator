import { beforeAll, describe, expect, it } from "vitest";

import { createPythonBridgeParser, type PythonBridgeParser } from "../src/client.js";

let parser: PythonBridgeParser;

beforeAll(async () => {
  parser = await createPythonBridgeParser();
});

describe("CPython bridge client", () => {
  it("handshakes and reports the real interpreter", async () => {
    const description = await parser.describe();
    expect(description.id).toBe("cpython-bridge");
    expect(description.available).toBe(true);
    expect(description.protocolVersion).toBe(1);
    // The dev environment runs Python 3.14; assert the shape, not the exact patch.
    expect(description.runtimeVersion).toMatch(/^3\.\d+\.\d+$/);
  });

  it("parses a module into the shared contract shapes", async () => {
    const result = await parser.parse("x = 1\n");
    expect(result.language).toBe("python");
    expect(result.filename).toBe("<source>");
    expect(result.parser.id).toBe("cpython-bridge");
    expect(result.parser.fidelity).toBe("full");
    expect(result.ast.kind).toBe("Module");
    // CPython's ast.Module carries no position attributes - the contract keeps it null.
    expect(result.ast.span).toBeNull();
    expect(result.tokens.length).toBeGreaterThan(0);
    expect(result.scopes?.kind).toBe("module");
    expect(result.diagnostics).toEqual([]);
  });

  it("uses the caller-provided filename label", async () => {
    const result = await parser.parse("x = 1\n", { filename: "sample.py" });
    expect(result.filename).toBe("sample.py");
  });

  it("reports the interpreter version in every result", async () => {
    const result = await parser.parse("pass\n");
    expect(result.parser.runtimeVersion).toMatch(/^3\.\d+\.\d+$/);
  });

  it("accepts an empty module", async () => {
    const result = await parser.parse("");
    expect(result.ast.kind).toBe("Module");
    expect(result.ast.fields["body"]).toEqual([]);
    expect(result.scopes?.name).toBe("top");
  });
});
