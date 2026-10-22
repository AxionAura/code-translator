// Shared fixture helpers for M3 tests. The parser packages are dev-time fixture
// generators here only — the core package itself has no dependency on them (the
// dependency direction is parsers → core; see ADR D-017).
import type { ParseResult } from "../src/parse-result.js";
import { createPythonBridgeParser, type PythonBridgeParser } from "@axion-ct/parser-py";
import { createOxcJsParser, type OxcJsParser } from "@axion-ct/parser-js";

let pyParser: Promise<PythonBridgeParser> | null = null;
let jsParser: Promise<OxcJsParser> | null = null;

export async function parsePython(source: string, filename = "mod.py"): Promise<ParseResult> {
  pyParser ??= createPythonBridgeParser();
  return (await pyParser).parse(source, { filename });
}

export async function parseJs(
  source: string,
  filename = "mod.js",
  language: "javascript" | "typescript" = "javascript",
): Promise<ParseResult> {
  jsParser ??= createOxcJsParser();
  return (await jsParser).parse(source, { filename, language });
}
