// Protocol validation negatives (D-018): every malformed-envelope arm of the bridge
// contract must produce a structured ValidationError with the offending field named —
// the client treats bridge output as semi-trusted data.
import { describe, expect, it } from "vitest";

import {
  validateAst,
  validateDiagnostics,
  validateEnvelope,
  validateErrorPayload,
  validateParseResult,
  validateHandshakeEnvelope,
  validateHeader,
  ValidationError,
} from "../src/protocol.js";

describe("protocol envelope validation negatives", () => {
  it("well-formed success envelopes validate losslessly", () => {
    const envelope = {
      ok: true,
      header: { protocol: 1, python: { version: "3.14.7", full: "CPython 3.14.7" } },
      result: {
        sourceEncoding: "utf-8",
        ast: { kind: "Module", span: null, fields: { body: [] } },
        tokens: [],
        scopes: null,
        module: null,
      },
      diagnostics: [],
    };
    expect(validateEnvelope(envelope).ok).toBe(true);
  });

  it("rejects non-object envelopes", () => {
    expect(() => validateEnvelope(null)).toThrow(ValidationError);
    expect(() => validateEnvelope("text")).toThrow(ValidationError);
    expect(() => validateEnvelope([])).toThrow(ValidationError);
  });

  it("rejects envelopes without a boolean ok or a header", () => {
    expect(() => validateEnvelope({})).toThrow(/boolean ok/);
    expect(() => validateEnvelope({ ok: true })).toThrow(ValidationError);
    expect(() => validateEnvelope({ ok: false, header: null })).toThrow(ValidationError);
  });

  it("rejects headers with bad protocol or python shapes", () => {
    expect(() => validateHeader({})).toThrow(/python object/);
    expect(() => validateHeader({ python: {} })).toThrow(/integer field "protocol"/);
    expect(() => validateHeader({ protocol: "x", python: {} })).toThrow(/integer field "protocol"/);
    expect(() => validateHeader({ protocol: 1, python: { version: 3 } })).toThrow(
      /string field "version"/,
    );
    expect(() => validateHeader({ protocol: 1, python: { version: "3.14.7" } })).toThrow(
      /string field "full"/,
    );
  });

  it("handshake envelopes must be ok:true with a header", () => {
    expect(() => validateHandshakeEnvelope({ ok: false, header: {} })).toThrow(/ok: true/);
    expect(() =>
      validateHandshakeEnvelope({
        ok: true,
        header: { protocol: 1, python: { version: "3", full: "CPython 3" } },
      }),
    ).not.toThrow();
  });

  it("error envelopes carry structured diagnostics", () => {
    const envelope = {
      ok: false,
      header: { protocol: 1, python: { version: "3", full: "CPython" } },
      error: { kind: "syntax", message: "invalid syntax" },
    };
    const validated = validateEnvelope(envelope);
    expect(validated.ok).toBe(false);
    if ("error" in validated) {
      expect(validated.error).toMatchObject({ kind: "syntax" });
    } else {
      throw new TypeError("error envelope validated as parse envelope");
    }
  });
});

describe("AST scalar validation (tagged values)", () => {
  const nodeWithTag = (value: unknown): unknown => ({
    kind: "Constant",
    span: {
      start: { line: 0, column: 0 },
      end: { line: 0, column: 1 },
      startByteOffset: 0,
      endByteOffset: 1,
    },
    fields: { value, kind: null },
  });

  it("accepts tagged scalars (int beyond 2^53, inf, bytes, complex, ellipsis)", () => {
    const ast = {
      kind: "Module",
      span: null,
      fields: {
        body: [
          nodeWithTag({ tag: "int", decimal: "123456789012345678901234567890" }),
          nodeWithTag({ tag: "float", value: "inf" }),
          nodeWithTag({ tag: "bytes", base64: "cmF3" }),
          nodeWithTag({ tag: "complex", real: 1, imaginary: 2 }),
          nodeWithTag({ tag: "ellipsis" }),
        ],
      },
    };
    const result = validateAst(ast);
    expect(result.fields["body"]).toHaveLength(5);
  });

  it("rejects malformed tagged scalars with field-named errors", () => {
    const cases: unknown[] = [
      nodeWithTag({ tag: "int", decimal: "12.5" }),
      nodeWithTag({ tag: "float", value: "infinity" }),
      nodeWithTag({ tag: "bytes", base64: "not base64!" }),
      nodeWithTag({ tag: "complex", real: Number.POSITIVE_INFINITY, imaginary: 1 }),
      nodeWithTag({ tag: "unknown-tag" }),
    ];
    for (const ast of cases) {
      expect(() => validateAst(ast)).toThrow(ValidationError);
    }
  });

  it("rejects structurally broken spans and unexpected scalars", () => {
    // A record that is neither AST-shaped nor tagged is an unexpected scalar.
    expect(() => validateAst(nodeWithTag({ not: "a-tagged-value" }))).toThrow(/unexpected scalar/);
    expect(() =>
      validateAst({
        kind: "Module",
        span: {
          start: { line: 1, column: 0 },
          end: { line: 0, column: 0 },
          startByteOffset: 10,
          endByteOffset: 5,
        },
        fields: {},
      }),
    ).toThrow(/end precedes start/);
  });
});

describe("parse-result, token, scope and error-payload validation", () => {
  const span = {
    start: { line: 0, column: 0 },
    end: { line: 0, column: 1 },
    startByteOffset: 0,
    endByteOffset: 1,
  };

  const validResult = (): Record<string, unknown> => ({
    sourceEncoding: "utf-8",
    ast: { kind: "Module", span: null, fields: { body: [] } },
    tokens: [{ kind: "NAME", text: "x", span }],
    scopes: null,
    module: null,
  });

  it("rejects broken parse results (encoding, tokens, ast)", () => {
    expect(() => validateParseResult("nope")).toThrow(/result must be an object/);
    expect(() => validateParseResult({})).toThrow(/sourceEncoding/);
    const noEncoding = validResult();
    delete noEncoding["sourceEncoding"];
    expect(() => validateParseResult(noEncoding)).toThrow(/sourceEncoding/);
    const badAst = validResult();
    badAst["ast"] = { kind: "Module" };
    expect(() => validateParseResult(badAst)).toThrow(/kind\/span\/fields/);
    const badTokens = validResult();
    badTokens["tokens"] = "not-an-array";
    expect(() => validateParseResult(badTokens)).toThrow(/tokens must be an array/);
    const badToken = validResult();
    badToken["tokens"] = [{ kind: "NAME" }];
    expect(() => validateParseResult(badToken)).toThrow(/string field "text"/);
  });

  it("rejects broken token spans and meaningless span ordering", () => {
    const badSpan = validResult();
    badSpan["tokens"] = [{ kind: "NAME", text: "x", span: { start: { line: "0" } } }];
    expect(() => validateParseResult(badSpan)).toThrow(/integer field "line"/);
    const badLine = validResult();
    badLine["tokens"] = [
      {
        kind: "NAME",
        text: "x",
        span: { ...span, start: { line: 0, column: 0 }, end: { line: "1", column: 0 } },
      },
    ];
    expect(() => validateParseResult(badLine)).toThrow(/integer field "line"/);
    const reversed = validResult();
    reversed["tokens"] = [
      { kind: "NAME", text: "x", span: { ...span, startByteOffset: 2, endByteOffset: 1 } },
    ];
    expect(() => validateParseResult(reversed)).toThrow(/end precedes start/);
  });

  it("validates module import entries (kinds, specifier wiring)", () => {
    const ok = validResult();
    ok["module"] = {
      hasModuleSyntax: true,
      imports: [
        {
          kind: "named",
          moduleSpecifier: ".helper",
          importedName: "thing",
          localName: "thing",
          span,
        },
      ],
      exports: [],
    };
    expect(() => validateParseResult(ok)).not.toThrow();
    const badKind = validResult();
    badKind["module"] = {
      hasModuleSyntax: true,
      imports: [{ kind: "wildcard", moduleSpecifier: "x", importedName: null, localName: null }],
      exports: [],
    };
    expect(() => validateParseResult(badKind)).toThrow(/unknown bridge import kind/);
    const missingSpecifier = validResult();
    missingSpecifier["module"] = {
      hasModuleSyntax: true,
      imports: [{ kind: "named" }],
      exports: [],
    };
    expect(() => validateParseResult(missingSpecifier)).toThrow(/moduleSpecifier/);
  });

  it("validates scope trees (symbols, flags)", () => {
    const ok = validResult();
    ok["scopes"] = {
      kind: "module",
      name: "m",
      line: null,
      symbols: [
        {
          name: "x",
          flags: {
            isLocal: false,
            isGlobal: false,
            isParameter: false,
            isFree: false,
            isImported: false,
            isAssigned: false,
            isReferenced: false,
            isDeclaredGlobal: false,
            isNonlocal: false,
          },
        },
      ],
      children: [],
    };
    expect(() => validateParseResult(ok)).not.toThrow();
    const badFlags = validResult();
    badFlags["scopes"] = {
      kind: "module",
      name: "m",
      line: null,
      symbols: [
        {
          name: "x",
          flags: {
            isLocal: false,
            isGlobal: "yes",
            isParameter: false,
            isFree: false,
            isImported: false,
            isAssigned: false,
            isReferenced: false,
            isDeclaredGlobal: false,
            isNonlocal: false,
          },
        },
      ],
      children: [],
    };
    expect(() => validateParseResult(badFlags)).toThrow(/must be boolean/);
    const badLine = validResult();
    badLine["scopes"] = {
      kind: "module",
      name: "m",
      line: "three",
      symbols: [],
      children: [],
    };
    expect(() => validateParseResult(badLine)).toThrow(/scope line/);
  });

  it("validates diagnostics (severity whitelist) and error payloads", () => {
    expect(() => validateDiagnostics([{ severity: "error" }])).toThrow(/severity/);
    expect(() => validateDiagnostics("nope")).toThrow(/must be an array/);
    expect(
      validateDiagnostics([{ severity: "warning", code: "C", message: "m", span: null }]),
    ).toHaveLength(1);
    expect(() =>
      validateDiagnostics([{ severity: "warning", code: 1, message: "m", span: null }]),
    ).toThrow(/string field "code"/);
    expect(() => validateErrorPayload("nope")).toThrow(/error must be an object/);
    expect(() => validateErrorPayload({})).toThrow(/string field "kind"/);
    expect(() => validateErrorPayload({ kind: "syntax", message: "m", lineno: "x" })).toThrow(
      /error field "lineno" must be null or integer/,
    );
    const ok = validateErrorPayload({
      kind: "syntax",
      message: "m",
      lineno: 3,
      offset: 40,
      endLineno: null,
      endOffset: null,
      limit: "byte",
    });
    expect(ok.lineno).toBe(3);
    expect(ok.endLineno).toBeNull();
  });

  it("rejects AST nodes with non-object fields (bridge data is semi-trusted)", () => {
    expect(() =>
      validateAst({
        kind: "Module",
        span: null,
        fields: "not-an-object",
      }),
    ).toThrow(/fields must be an object/);
  });
});
