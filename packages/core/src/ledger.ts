// TransformationLedger schema (docs/translation-pipeline.md §2) and validation.
// M3 establishes the contract only — no translation exists yet, so nothing produces
// entries; M4's lowering will append one entry per emitted construct. Validation is
// hand-written (zero-dependency policy) and the serialization is deterministic.
import type { SourceSpan } from "./source-span.js";

export type DecisionKind = "deterministic" | "semantic" | "ambiguous" | "unsupported";

export const DECISION_KINDS: readonly DecisionKind[] = [
  "deterministic",
  "semantic",
  "ambiguous",
  "unsupported",
];

export interface LedgerEscalation {
  readonly provider: string;
  readonly model: string;
  readonly promptHash: string;
}

export interface LedgerEntry {
  // Stable per-run identity, e.g. "src/api.py#017". Deterministically derived by the
  // producer (unit + ordinal); never random.
  readonly id: string;
  readonly unit: string;
  readonly span: SourceSpan | null;
  // Source construct class, e.g. "py.FunctionDef" / "js.TSAsExpression".
  readonly sourceKind: string;
  // Mapping id applied, keyed to docs/language-support.md ("py.comprehension→js.map").
  readonly rule: string;
  readonly decision: DecisionKind;
  // Why this mapping/classification — required for every entry.
  readonly rationale: string;
  // For `semantic` decisions: the documented deviation. Null otherwise.
  readonly adaptation: string | null;
  // What the target now contains (filled by M4+; null while only the schema exists).
  readonly targetSummary: string | null;
  // Warning codes (CTW-*) attached to the decision.
  readonly warnings: readonly string[];
  // AI escalation provenance when an ambiguous decision was resolved by a model;
  // the prompt itself is journaled by hash only (docs/ai-architecture.md §5).
  readonly escalation: LedgerEscalation | null;
}

export class LedgerValidationError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, name: string): string {
  const value = record[name];
  if (typeof value !== "string") {
    throw new LedgerValidationError(`expected string field "${name}"`);
  }
  return value;
}

function nullableField<T>(
  record: Record<string, unknown>,
  name: string,
  check: (value: unknown) => T,
): T | null {
  const value = record[name];
  if (value === null || value === undefined) return null;
  return check(value);
}

function validateSpan(value: unknown): SourceSpan {
  if (!isRecord(value)) throw new LedgerValidationError("span must be an object");
  for (const key of ["start", "end"] as const) {
    const position = value[key];
    if (!isRecord(position)) throw new LedgerValidationError(`span.${key} must be an object`);
    for (const coordinate of ["line", "column"] as const) {
      if (typeof position[coordinate] !== "number") {
        throw new LedgerValidationError(`span.${key}.${coordinate} must be a number`);
      }
    }
  }
  for (const key of ["startByteOffset", "endByteOffset"] as const) {
    if (typeof value[key] !== "number") {
      throw new LedgerValidationError(`span.${key} must be a number`);
    }
  }
  return value as unknown as SourceSpan;
}

export function validateLedgerEntry(value: unknown): LedgerEntry {
  if (!isRecord(value)) {
    throw new LedgerValidationError("ledger entry must be an object");
  }
  const decision = stringField(value, "decision");
  if (!DECISION_KINDS.includes(decision as DecisionKind)) {
    throw new LedgerValidationError(`unknown decision kind "${decision}"`);
  }
  const warnings = value["warnings"];
  if (!Array.isArray(warnings) || warnings.some((entry) => typeof entry !== "string")) {
    throw new LedgerValidationError("warnings must be an array of strings");
  }
  let escalation: LedgerEscalation | null = null;
  const escalationValue = value["escalation"];
  if (escalationValue !== null && escalationValue !== undefined) {
    if (!isRecord(escalationValue)) {
      throw new LedgerValidationError("escalation must be an object or null");
    }
    escalation = {
      provider: stringField(escalationValue, "provider"),
      model: stringField(escalationValue, "model"),
      promptHash: stringField(escalationValue, "promptHash"),
    };
  }
  return {
    id: stringField(value, "id"),
    unit: stringField(value, "unit"),
    span: nullableField(value, "span", validateSpan),
    sourceKind: stringField(value, "sourceKind"),
    rule: stringField(value, "rule"),
    decision: decision as DecisionKind,
    rationale: stringField(value, "rationale"),
    adaptation: nullableField(value, "adaptation", (adaptation) => {
      if (typeof adaptation !== "string") {
        throw new LedgerValidationError("adaptation must be a string");
      }
      return adaptation;
    }),
    targetSummary: nullableField(value, "targetSummary", (target) => {
      if (typeof target !== "string") {
        throw new LedgerValidationError("targetSummary must be a string");
      }
      return target;
    }),
    warnings: warnings as readonly string[],
    escalation,
  };
}

export function validateLedgerEntries(value: unknown): LedgerEntry[] {
  if (!Array.isArray(value)) {
    throw new LedgerValidationError("ledger must be an array of entries");
  }
  return value.map((entry) => validateLedgerEntry(entry));
}

// Deterministic serialization: entries in the given order, stable JSON.
export function serializeLedger(entries: readonly LedgerEntry[]): string {
  return JSON.stringify(entries, null, 2) + "\n";
}
