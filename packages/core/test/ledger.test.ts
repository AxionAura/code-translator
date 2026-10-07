import { describe, expect, it } from "vitest";

import {
  DECISION_KINDS,
  LedgerValidationError,
  serializeLedger,
  validateLedgerEntries,
} from "../src/ledger.js";

const goodEntry = {
  id: "src/api.py#017",
  unit: "src/api.py",
  span: {
    start: { line: 4, column: 0 },
    end: { line: 4, column: 20 },
    startByteOffset: 88,
    endByteOffset: 108,
  },
  sourceKind: "py.FunctionDef",
  rule: "py.function→ts.function",
  decision: "deterministic",
  rationale: "statement-preserving translation exists",
  adaptation: null,
  targetSummary: "function declaration emitted",
  warnings: [],
  escalation: null,
};

describe("transformation ledger schema", () => {
  it("accepts entries for all four decision kinds", () => {
    for (const decision of DECISION_KINDS) {
      const entries = validateLedgerEntries([{ ...goodEntry, id: `u#${decision}`, decision }]);
      expect(entries).toHaveLength(1);
      expect(entries[0]!.decision).toBe(decision);
    }
  });

  it("accepts AI escalation provenance (hash only) and warning codes", () => {
    const entries = validateLedgerEntries([
      {
        ...goodEntry,
        decision: "ambiguous",
        rationale: "two viable target mappings",
        warnings: ["CTW-ASYNC-SIGNATURE-CHANGE"],
        escalation: { provider: "openai", model: "gpt-x", promptHash: "abc123" },
      },
    ]);
    expect(entries[0]!.escalation).toEqual({
      provider: "openai",
      model: "gpt-x",
      promptHash: "abc123",
    });
  });

  it("rejects unknown decision kinds, missing rationale, and bad warnings", () => {
    expect(() => validateLedgerEntries([{ ...goodEntry, decision: "magical" }])).toThrow(
      LedgerValidationError,
    );
    expect(() => {
      const { rationale: _rationale, ...rest } = goodEntry;
      void _rationale;
      return validateLedgerEntries([rest]);
    }).toThrow(LedgerValidationError);
    expect(() => validateLedgerEntries([{ ...goodEntry, warnings: [42] }])).toThrow(
      LedgerValidationError,
    );
    expect(() => validateLedgerEntries([{ ...goodEntry, span: { start: {} } }])).toThrow(
      LedgerValidationError,
    );
  });

  it("round-trips through JSON and serializes deterministically", () => {
    const entries = validateLedgerEntries([goodEntry]);
    const serialized = serializeLedger(entries);
    expect(JSON.parse(serialized)).toEqual(entries);
    expect(serializeLedger(validateLedgerEntries(JSON.parse(serialized)))).toBe(serialized);
  });
});
