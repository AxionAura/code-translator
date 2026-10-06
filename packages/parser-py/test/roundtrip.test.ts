import { beforeAll, describe, expect, it } from "vitest";

import type { AstNode } from "@ctrans/core";

import { createPythonBridgeParser, type PythonBridgeParser } from "../src/client.js";

let parser: PythonBridgeParser;

beforeAll(async () => {
  parser = await createPythonBridgeParser();
});

// A source exercising every piece of the parser contract: nested constructs, comments,
// strings with escapes and non-ASCII, tagged constants, annotations.
const RICH_SOURCE = [
  "import os",
  "",
  "MAX = 123456789012345678901234567890  # beyond 2**53",
  "",
  "",
  "@decorator",
  "class Inventory:",
  '    """Inventory of widgets."""',
  "",
  "    def __init__(self, items: list[str] | None = None) -> None:",
  "        self._items = items or []",
  "",
  "    def find(self, needle: str) -> dict[str, int]:",
  "        counts = {name: len(name) for name in self._items if needle in name}",
  "        raw = b'\\x00\\xff'",
  "        threshold = 2.5e3",
  "        weird = 1e999",
  "        return counts if counts else {needle: -1}",
  "",
].join("\n");

function countAstNodes(node: AstNode): number {
  let count = 1;
  for (const value of Object.values(node.fields)) {
    const values = Array.isArray(value) ? value : [value];
    for (const item of values) {
      if (typeof item === "object" && item !== null && "kind" in item) {
        count += countAstNodes(item as AstNode);
      }
    }
  }
  return count;
}

describe("lossless JSON round-trip", () => {
  it("survives JSON.stringify -> JSON.parse unchanged", async () => {
    const result = await parser.parse(RICH_SOURCE, { filename: "inventory.py" });
    const serialized = JSON.stringify(result);
    const restored = JSON.parse(serialized) as typeof result;
    expect(restored).toEqual(result);
  });

  it("preserves every required piece of the parser contract", async () => {
    const result = await parser.parse(RICH_SOURCE);
    // AST: a large tree, all nodes present after serialization.
    expect(countAstNodes(result.ast)).toBeGreaterThan(60);
    // Tokens: comments and structural tokens survived.
    const kinds = result.tokens.map((token) => token.kind);
    expect(kinds).toContain("COMMENT");
    expect(kinds).toContain("INDENT");
    expect(kinds).toContain("DEDENT");
    // Scopes: class and method scopes present.
    const scopeNames = JSON.stringify(result.scopes);
    expect(scopeNames).toContain("Inventory");
    expect(scopeNames).toContain("find");
    // Tagged constants: precision and type survive.
    expect(JSON.stringify(result)).toContain("123456789012345678901234567890");
    expect(JSON.stringify(result)).toContain('"tag":"bytes"');
    expect(JSON.stringify(result)).toContain('"tag":"float","value":"inf"');
    // Diagnostics from the bridge round-trip as data.
    expect(Array.isArray(result.diagnostics)).toBe(true);
  });

  it("does not lose surrogate characters in string constants", async () => {
    // Lone surrogates are valid inside Python string literals; JSON escapes carry
    // them through ASCII-safe serialization and JS strings hold them exactly.
    const result = await parser.parse("s = '\\ud800\\udfff'\n");
    const body = result.ast.fields["body"] as AstNode[];
    const constant = (body[0] as AstNode).fields["value"] as AstNode;
    expect(constant.fields["value"]).toBe("\ud800\udfff");
    const restored = JSON.parse(JSON.stringify(constant.fields["value"])) as string;
    expect(restored).toBe("\ud800\udfff");
  });
});
