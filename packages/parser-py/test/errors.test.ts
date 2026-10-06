import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { PythonBridgeParser, type PythonBridgeParserOptions } from "../src/client.js";
import {
  PythonBridgeCrashError,
  PythonBridgeProtocolError,
  PythonBridgeResponseError,
  PythonBridgeTimeoutError,
  PythonBridgeUnavailableError,
  PythonEncodingError,
  PythonRuntimeUnsupportedError,
  PythonSourceLimitError,
  PythonSyntaxError,
} from "../src/errors.js";

const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

// The failure-injection stubs are POSIX shell scripts executed directly (no shell: true
// in the client); skipped on Windows where the shebang mechanism does not apply.
const describePosix = process.platform === "win32" ? describe.skip : describe;

function writeStub(lines: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "ctrans-bridge-stub-"));
  tempDirs.push(dir);
  const path = join(dir, "stubpython");
  writeFileSync(path, `#!/bin/sh\n${lines.join("\n")}\n`, { mode: 0o700 });
  return path;
}

const FAST = { timeoutMs: 2000 };

function makeStubParser(
  script: string[],
  options: PythonBridgeParserOptions = {},
): Promise<PythonBridgeParser> {
  return PythonBridgeParser.create({ pythonPath: writeStub(script), ...FAST, ...options });
}

describe("malformed input", () => {
  it("maps syntax errors to PythonSyntaxError with contract spans", async () => {
    const parser = await PythonBridgeParser.create(FAST);
    const source = "def f(:\n  pass\n";
    const error = await parser.parse(source).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PythonSyntaxError);
    const syntaxError = error as PythonSyntaxError;
    expect(syntaxError.code).toBe("PY-SYNTAX");
    expect(syntaxError.message).toBe("invalid syntax");
    // CPython points at the ':' on line 1 (1-based offset 7) -> byte column 6.
    expect(syntaxError.span).toEqual({
      start: { line: 0, column: 6 },
      end: { line: 0, column: 7 },
      startByteOffset: 6,
      endByteOffset: 7,
    });
  });

  it("maps unknown coding declarations to PythonEncodingError", async () => {
    // The client API transports decoded text (always valid UTF-8), so the only
    // encoding failure reachable through it is a broken PEP 263 declaration.
    const parser = await PythonBridgeParser.create(FAST);
    const error = await parser
      .parse("# -*- coding: bogus-codec -*-\nx = 1\n")
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PythonEncodingError);
    expect((error as PythonEncodingError).code).toBe("PY-ENCODING");
  });

  it("rejects oversized sources before spawning", async () => {
    const parser = await PythonBridgeParser.create({ ...FAST, maxSourceBytes: 8 });
    const error = await parser.parse("x = 123456\n").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PythonSourceLimitError);
    expect((error as PythonSourceLimitError).limit).toBe("maxSourceBytes");
  });

  it("classifies CPython's parser-depth guard as a resource limit", async () => {
    const parser = await PythonBridgeParser.create(FAST);
    const deep = `x = ${"f(".repeat(2000)}1${")".repeat(2000)}\n`;
    const error = await parser.parse(deep).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PythonSourceLimitError);
    expect((error as PythonSourceLimitError).limit).toBe("parserDepth");
  });
});

describePosix("bridge failure modes (POSIX stubs)", () => {
  it("reports an unavailable interpreter as PythonBridgeUnavailableError", async () => {
    const creation = PythonBridgeParser.create({ pythonPath: "/nonexistent/python3" });
    await expect(creation).rejects.toBeInstanceOf(PythonBridgeUnavailableError);
  });

  it("maps a hung bridge to PythonBridgeTimeoutError and kills it", async () => {
    const hangOnParse = writeStub([
      'case "$*" in',
      '  *handshake*) echo \'{"ok":true,"header":{"protocol":1,"python":{"version":"3.14.7","full":"stub"}}}\' ;;',
      "  *parse*) exec sleep 30 ;;",
      "esac",
    ]);
    const parser = await PythonBridgeParser.create({ pythonPath: hangOnParse, timeoutMs: 300 });
    const error = await parser.parse("x = 1\n").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PythonBridgeTimeoutError);
    expect((error as PythonBridgeTimeoutError).code).toBe("PY-BRIDGE-TIMEOUT");
  }, 10_000);

  it("maps a bridge crash after handshake to PythonBridgeCrashError", async () => {
    const crashOnParse = writeStub([
      'case "$*" in',
      '  *handshake*) echo \'{"ok":true,"header":{"protocol":1,"python":{"version":"3.14.7","full":"stub"}}}\' ;;',
      "  *parse*) echo boom >&2; exit 3 ;;",
      "esac",
    ]);
    const parser = await PythonBridgeParser.create({ pythonPath: crashOnParse });
    const error = await parser.parse("x = 1\n").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PythonBridgeCrashError);
    expect((error as PythonBridgeCrashError).exitCode).toBe(3);
    expect((error as PythonBridgeCrashError).stderrTail).toContain("boom");
  });

  it("maps non-JSON output to PythonBridgeResponseError", async () => {
    const parser = makeStubParser(["echo 'not json'"]);
    await expect(parser).rejects.toBeInstanceOf(PythonBridgeResponseError);
  });

  it("maps protocol version mismatch to PythonBridgeProtocolError", async () => {
    const parser = makeStubParser([
      'echo \'{"ok":true,"header":{"protocol":99,"python":{"version":"3.14.7","full":"stub"}}}\'',
    ]);
    await expect(parser).rejects.toBeInstanceOf(PythonBridgeProtocolError);
  });

  it("maps an unsupported interpreter to PythonRuntimeUnsupportedError", async () => {
    const parser = makeStubParser([
      'echo \'{"ok":true,"header":{"protocol":1,"python":{"version":"3.11.9","full":"stub"}}}\'',
    ]);
    await expect(parser).rejects.toBeInstanceOf(PythonRuntimeUnsupportedError);
  });

  it("maps usage errors (exit 2) to PythonBridgeProtocolError", async () => {
    const parser = makeStubParser(["echo 'bad usage' >&2", "exit 2"]);
    await expect(parser).rejects.toBeInstanceOf(PythonBridgeProtocolError);
  });
});
