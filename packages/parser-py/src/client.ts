// TypeScript client for the Python parse bridge (D-018): one short-lived
// `python3 -I -B bridge.py` process per request; source bytes in via stdin, one JSON
// envelope out via stdout. The client owns process lifecycle, timeouts, size caps,
// and maps every failure mode to a typed error.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type {
  CTransError,
  ParseResult,
  ParserDescription,
  PythonParseOptions,
  PythonParser,
  SourceSpan,
} from "@ctrans/core";
import {
  PythonBridgeCrashError,
  PythonBridgeInternalError,
  PythonBridgeProtocolError,
  PythonBridgeResponseError,
  PythonBridgeTimeoutError,
  PythonBridgeUnavailableError,
  PythonEncodingError,
  PythonRuntimeUnsupportedError,
  PythonSourceLimitError,
  PythonSyntaxError,
} from "./errors.js";
import { byteColumn, scanSourceLines } from "./lines.js";
import {
  BRIDGE_PROTOCOL_VERSION,
  validateEnvelope,
  validateHandshakeEnvelope,
  type BridgeErrorEnvelope,
  type BridgeEnvelope,
  type BridgeHeader,
} from "./protocol.js";

const BRIDGE_PATH = fileURLToPath(new URL("../python/bridge.py", import.meta.url));
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_SOURCE_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const STDERR_TAIL_BYTES = 4096;

// Documented supported interpreter range for the bridge contract. Versions outside the
// range are refused with a typed error, never silently accepted (M1 verified on 3.14.x).
const SUPPORTED_PYTHON = { major: 3, minMinor: 12, maxMinor: 14 };

export interface PythonBridgeParserOptions {
  readonly pythonPath?: string;
  readonly timeoutMs?: number;
  readonly maxSourceBytes?: number;
  readonly maxOutputBytes?: number;
}

interface ResolvedOptions {
  readonly pythonPath: string;
  readonly timeoutMs: number;
  readonly maxSourceBytes: number;
  readonly maxOutputBytes: number;
}

function resolveOptions(options: PythonBridgeParserOptions): ResolvedOptions {
  return {
    pythonPath: options.pythonPath ?? "python3",
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxSourceBytes: options.maxSourceBytes ?? DEFAULT_MAX_SOURCE_BYTES,
    maxOutputBytes: options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
  };
}

// CPython's SyntaxError.offset is a 1-based code-point column; the contract wants a
// 0-based UTF-8 byte column and byte offsets.
function syntaxErrorSpan(
  source: string,
  lineno: number | null,
  offset: number | null,
  endLineno: number | null,
  endOffset: number | null,
): SourceSpan | null {
  if (lineno === null || lineno < 1) {
    return null;
  }
  const { lineTexts, lineStarts } = scanSourceLines(source);
  const startLine = lineno - 1;
  const startLineText = lineTexts[startLine];
  const startLineBase = lineStarts[startLine];
  if (startLineText === undefined || startLineBase === undefined) {
    return null;
  }
  const endLine = Math.max(startLine, (endLineno ?? lineno) - 1);
  const endLineText = lineTexts[endLine];
  const endLineBase = lineStarts[endLine];
  if (endLineText === undefined || endLineBase === undefined) {
    return null;
  }
  const startColumn = offset === null ? 0 : byteColumn(startLineText, Math.max(0, offset - 1));
  const endColumn =
    endOffset === null || endOffset < 1
      ? startColumn
      : byteColumn(endLineText, Math.max(0, endOffset - 1));
  const startByteOffset = startLineBase + startColumn;
  const endByteOffset = endLineBase + endColumn;
  if (endByteOffset < startByteOffset) {
    return null;
  }
  return {
    start: { line: startLine, column: startColumn },
    end: { line: endLine, column: endColumn },
    startByteOffset,
    endByteOffset,
  };
}

interface BridgeRun {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderrTail: string;
  readonly timedOut: boolean;
  readonly outputTooLarge: boolean;
  readonly spawnError: NodeJS.ErrnoException | null;
}

function runBridge(
  options: ResolvedOptions,
  args: readonly string[],
  input: Buffer,
): Promise<BridgeRun> {
  return new Promise((resolve) => {
    // -I: isolated mode (ignores PYTHON* env/user site, keeps user paths out);
    // -B: no bytecode files next to the bridge. Minimal whitelisted env per security.md.
    const child = spawn(options.pythonPath, ["-I", "-B", BRIDGE_PATH, ...args], {
      env: { PATH: process.env["PATH"] ?? "" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdoutChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrTail = Buffer.alloc(0);
    let timedOut = false;
    let outputTooLarge = false;
    let spawnError: NodeJS.ErrnoException | null = null;
    let settled = false;
    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        code,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderrTail: stderrTail.toString("utf8"),
        timedOut,
        outputTooLarge,
        spawnError,
      });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, options.timeoutMs);
    // After a SIGKILL the pipes can tear down with EPIPE/ECONNRESET while we are
    // still writing or draining; those are teardown noise, not bridge failures, and
    // must not surface as unhandled stream errors.
    child.stdin?.on("error", () => {});
    child.stdout?.on("error", () => {});
    child.stderr?.on("error", () => {});
    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > options.maxOutputBytes) {
        outputTooLarge = true;
        child.kill("SIGKILL");
        return;
      }
      stdoutChunks.push(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrTail = Buffer.concat([stderrTail, chunk]).subarray(-STDERR_TAIL_BYTES);
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      spawnError = error;
      finish(null);
    });
    child.on("close", (code) => {
      finish(code);
    });
    child.stdin?.end(input);
  });
}

// Translates transport-level failures into typed errors; returns stdout only when the
// bridge exited cleanly with a well-formed exit code.
function requireCleanRun(options: ResolvedOptions, run: BridgeRun): string {
  if (run.spawnError !== null) {
    throw new PythonBridgeUnavailableError(
      `cannot start the Python bridge with "${options.pythonPath}": ${run.spawnError.message}`,
      { cause: run.spawnError },
    );
  }
  if (run.timedOut) {
    throw new PythonBridgeTimeoutError(`bridge did not finish within ${options.timeoutMs} ms`);
  }
  if (run.outputTooLarge) {
    throw new PythonBridgeResponseError(
      `bridge output exceeded the ${options.maxOutputBytes} byte cap`,
    );
  }
  if (run.code !== 0) {
    if (run.code === 2) {
      throw new PythonBridgeProtocolError(
        `bridge usage error (exit 2): ${run.stderrTail.trim() || "no diagnostics"}`,
      );
    }
    throw new PythonBridgeCrashError(
      `bridge exited with code ${String(run.code)}`,
      run.code,
      run.stderrTail,
    );
  }
  return run.stdout;
}

function envelopeFromRun(options: ResolvedOptions, run: BridgeRun): BridgeEnvelope {
  const stdout = requireCleanRun(options, run);
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    throw new PythonBridgeResponseError("bridge emitted malformed JSON", { cause: error });
  }
  try {
    return validateEnvelope(parsed);
  } catch (error) {
    throw new PythonBridgeResponseError(
      `bridge envelope failed validation: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

function parsePythonVersion(
  version: string,
): { major: number; minor: number; patch: number } | null {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (match === null) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

function validateSupportedPython(version: string): void {
  const parsed = parsePythonVersion(version);
  if (parsed === null) {
    throw new PythonBridgeProtocolError(`bridge reported unparseable python version "${version}"`);
  }
  const supported =
    parsed.major === SUPPORTED_PYTHON.major &&
    parsed.minor >= SUPPORTED_PYTHON.minMinor &&
    parsed.minor <= SUPPORTED_PYTHON.maxMinor;
  if (!supported) {
    throw new PythonRuntimeUnsupportedError(
      `python ${version} is outside the supported ${SUPPORTED_PYTHON.major}.${SUPPORTED_PYTHON.minMinor}-${SUPPORTED_PYTHON.maxMinor}.x range`,
    );
  }
}

function validateResponseHeader(header: BridgeHeader): void {
  if (header.protocol !== BRIDGE_PROTOCOL_VERSION) {
    throw new PythonBridgeProtocolError(
      `bridge protocol ${String(header.protocol)} != expected ${String(BRIDGE_PROTOCOL_VERSION)}`,
    );
  }
  validateSupportedPython(header.python.version);
}

function errorFromEnvelope(envelope: BridgeErrorEnvelope, source: string): CTransError {
  const error = envelope.error;
  switch (error.kind) {
    case "syntax": {
      const span = syntaxErrorSpan(
        source,
        error.lineno,
        error.offset,
        error.endLineno,
        error.endOffset,
      );
      return new PythonSyntaxError(error.message, span);
    }
    case "encoding":
      return new PythonEncodingError(error.message);
    case "limit":
      return new PythonSourceLimitError(error.message, error.limit ?? "unknown");
    case "internal":
      return new PythonBridgeInternalError(error.message);
    default:
      return new PythonBridgeInternalError(
        `unknown bridge error kind "${error.kind}": ${error.message}`,
      );
  }
}

export class PythonBridgeParser implements PythonParser {
  private constructor(
    private readonly options: ResolvedOptions,
    private readonly handshakeHeader: BridgeHeader,
  ) {}

  static async create(options: PythonBridgeParserOptions = {}): Promise<PythonBridgeParser> {
    const resolved = resolveOptions(options);
    const run = await runBridge(resolved, ["--mode", "handshake"], Buffer.alloc(0));
    const stdout = requireCleanRun(resolved, run);
    let header: BridgeHeader;
    try {
      header = validateHandshakeEnvelope(JSON.parse(stdout));
    } catch (error) {
      throw new PythonBridgeResponseError(
        `bridge handshake failed validation: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    validateResponseHeader(header);
    return new PythonBridgeParser(resolved, header);
  }

  async describe(): Promise<ParserDescription> {
    return {
      id: "cpython-bridge",
      available: true,
      runtimeVersion: this.handshakeHeader.python.version,
      protocolVersion: this.handshakeHeader.protocol,
      unavailableReason: null,
    };
  }

  async parse(source: string, options?: PythonParseOptions): Promise<ParseResult> {
    const sourceBytes = Buffer.from(source, "utf8");
    if (sourceBytes.length > this.options.maxSourceBytes) {
      throw new PythonSourceLimitError(
        `source exceeds the ${String(this.options.maxSourceBytes)} byte limit`,
        "maxSourceBytes",
      );
    }
    const run = await runBridge(
      this.options,
      ["--mode", "parse", "--max-source-bytes", String(this.options.maxSourceBytes)],
      sourceBytes,
    );
    const envelope = envelopeFromRun(this.options, run);
    validateResponseHeader(envelope.header);
    if (!envelope.ok) {
      throw errorFromEnvelope(envelope, source);
    }
    return {
      language: "python",
      filename: options?.filename ?? "<source>",
      parser: {
        id: "cpython-bridge",
        fidelity: "full",
        parserVersion: String(BRIDGE_PROTOCOL_VERSION),
        runtimeVersion: envelope.header.python.version,
      },
      ast: envelope.result.ast,
      tokens: envelope.result.tokens,
      scopes: envelope.result.scopes,
      diagnostics: envelope.diagnostics,
    };
  }
}

export async function createPythonBridgeParser(
  options: PythonBridgeParserOptions = {},
): Promise<PythonBridgeParser> {
  return PythonBridgeParser.create(options);
}
