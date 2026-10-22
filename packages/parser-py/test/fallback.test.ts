import { beforeAll, describe, expect, it } from "vitest";

import type { AstNode } from "@axion-ct/core";

import { createPythonBridgeParser, type PythonBridgeParser } from "../src/client.js";
import { createTreeSitterPythonParser, type TreeSitterPythonParser } from "../src/fallback.js";
import { createPythonParser } from "../src/select.js";

let bridge: PythonBridgeParser;
let fallback: TreeSitterPythonParser;

beforeAll(async () => {
  bridge = await createPythonBridgeParser();
  fallback = await createTreeSitterPythonParser();
});

const PARITY_SOURCE = 'def greet(name):\n    return f"héllo {name}"\n';

describe("tree-sitter fallback", () => {
  it("parses into the shared contract with degraded fidelity", async () => {
    const result = await fallback.parse(PARITY_SOURCE);
    expect(result.language).toBe("python");
    expect(result.parser.id).toBe("tree-sitter");
    expect(result.parser.fidelity).toBe("degraded");
    expect(result.parser.runtimeVersion).toBeNull();
    expect(result.parser.parserVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(result.ast.kind).toBe("module");
    expect(result.scopes).toBeNull();
    expect(result.diagnostics.some((d) => d.code === "CTP-TS-DEGRADED")).toBe(true);
  });

  it("converts tree-sitter code-point columns to contract byte columns", async () => {
    const source = "日本 = x\n";
    const result = await fallback.parse(source);
    const statement = (result.ast.fields["children"] as AstNode[])[0];
    // The statement node spans the full first line: 7 chars but 10 bytes.
    expect(statement?.span?.endByteOffset).toBe(Buffer.byteLength(source, "utf8") - 1);
    expect(statement?.span?.end).toEqual({ line: 0, column: 10 });
  });

  it("produces a leaf token stream including comments", async () => {
    const result = await fallback.parse("# note\nx = 1\n");
    const comment = result.tokens.find((token) => token.kind === "comment");
    expect(comment?.text).toBe("# note");
    expect(result.tokens.some((token) => token.kind === "identifier")).toBe(true);
  });

  it("reports syntax recovery as a warning diagnostic", async () => {
    const result = await fallback.parse("def broken(:\n");
    expect(result.parser.fidelity).toBe("degraded");
    expect(result.diagnostics.some((d) => d.code === "CTP-TS-SYNTAX-RECOVERY")).toBe(true);
  });

  it("describes itself honestly when available", async () => {
    const description = await fallback.describe();
    expect(description.available).toBe(true);
    expect(description.id).toBe("tree-sitter");
  });
});

describe("interface parity", () => {
  it("both front-ends accept the same source and agree on byte spans", async () => {
    const bridgeResult = await bridge.parse(PARITY_SOURCE);
    const fallbackResult = await fallback.parse(PARITY_SOURCE);
    expect(bridgeResult.language).toBe(fallbackResult.language);
    // The bridge root (ast.Module) has no span; compare the function definition,
    // which both front-ends must cover with identical byte spans.
    const bridgeFn = (bridgeResult.ast.fields["body"] as AstNode[]).find(
      (node) => node.kind === "FunctionDef",
    );
    const fallbackFn = (fallbackResult.ast.fields["children"] as AstNode[]).find(
      (node) => node.kind === "function_definition",
    );
    expect(bridgeFn?.span).not.toBeNull();
    expect(fallbackFn?.span).toEqual(bridgeFn?.span);
    // Both produce token streams spanning the source (different vocabularies).
    expect(bridgeResult.tokens.length).toBeGreaterThan(0);
    expect(fallbackResult.tokens.length).toBeGreaterThan(0);
  });
});

describe("fallback selection", () => {
  it("defaults to failing hard when the bridge is unavailable", async () => {
    await expect(createPythonParser({ pythonPath: "/nonexistent/python3" })).rejects.toMatchObject({
      code: "PY-BRIDGE-UNAVAILABLE",
    });
  });

  it("activates the fallback only when explicitly allowed - and records the downgrade", async () => {
    const parser = await createPythonParser({
      pythonPath: "/nonexistent/python3",
      allowFallback: true,
    });
    const result = await parser.parse(PARITY_SOURCE);
    expect(result.parser.id).toBe("tree-sitter");
    expect(result.parser.fidelity).toBe("degraded");
  });
});
