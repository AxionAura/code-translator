// Translation report schemas (docs/validation.md §1-2): stable JSON shapes for what a
// translation run must report. M3 establishes the schema space and validation only —
// producers arrive with M4+ (pipeline, validation engine, repair loop). The claim
// ladder encodes the honesty invariant: a run may only claim the strongest level its
// executed validation stages actually support.
import type { DecisionKind } from "./ledger.js";
import type { SourceLanguage } from "./parse-result.js";
import type { SourceSpan } from "./source-span.js";

export type ClaimLevel = 0 | 1 | 2 | 3 | 4 | 5;

export type FileTranslationStatus = "translated" | "partially-translated" | "failed" | "skipped";

export type StageStatus = "pass" | "fail" | "warn" | "skipped";

export interface ReportFileEntry {
  readonly source: string;
  readonly target: string | null;
  readonly status: FileTranslationStatus;
  readonly decisionCounts: Readonly<Record<DecisionKind, number>>;
}

export interface ReportValidationStage {
  readonly stage: string;
  readonly status: StageStatus;
  readonly reason: string | null;
}

export interface TranslationReport {
  readonly generator: { readonly name: string; readonly version: string };
  readonly sourceLanguage: SourceLanguage;
  readonly targetLanguage: SourceLanguage;
  readonly files: readonly ReportFileEntry[];
  readonly decisionTotals: Readonly<Record<DecisionKind, number>>;
  readonly warnings: readonly string[];
  readonly unsupported: readonly {
    readonly unit: string;
    readonly span: SourceSpan | null;
    readonly rule: string;
  }[];
  readonly ambiguous: readonly {
    readonly unit: string;
    readonly span: SourceSpan | null;
    readonly rule: string;
    readonly chosen: string;
  }[];
  readonly validationStages: readonly ReportValidationStage[];
  readonly claimLevel: ClaimLevel;
  readonly repairJournal: string | null;
}

export class ReportValidationError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const DECISION_KINDS = ["deterministic", "semantic", "ambiguous", "unsupported"] as const;

function decisionCounts(value: unknown): Record<DecisionKind, number> {
  if (!isRecord(value)) {
    throw new ReportValidationError("decisionCounts must be an object");
  }
  const counts = {} as Record<DecisionKind, number>;
  for (const kind of DECISION_KINDS) {
    const count = value[kind];
    if (typeof count !== "number" || !Number.isInteger(count) || count < 0) {
      throw new ReportValidationError(`decisionCounts.${kind} must be a non-negative integer`);
    }
    counts[kind] = count;
  }
  return counts;
}

export function validateTranslationReport(value: unknown): TranslationReport {
  if (!isRecord(value)) {
    throw new ReportValidationError("report must be an object");
  }
  const generator = value["generator"];
  if (
    !isRecord(generator) ||
    typeof generator["name"] !== "string" ||
    typeof generator["version"] !== "string"
  ) {
    throw new ReportValidationError("generator must carry name and version strings");
  }
  for (const key of ["sourceLanguage", "targetLanguage"] as const) {
    if (typeof value[key] !== "string") {
      throw new ReportValidationError(`${key} must be a string`);
    }
  }
  if (!Array.isArray(value["files"])) {
    throw new ReportValidationError("files must be an array");
  }
  for (const file of value["files"] as unknown[]) {
    if (!isRecord(file) || typeof file["source"] !== "string") {
      throw new ReportValidationError("file entries need a source string");
    }
    const status = file["status"];
    if (
      status !== "translated" &&
      status !== "partially-translated" &&
      status !== "failed" &&
      status !== "skipped"
    ) {
      throw new ReportValidationError(`unknown file status "${String(status)}"`);
    }
    decisionCounts(file["decisionCounts"]);
  }
  decisionCounts(value["decisionTotals"]);
  const claimLevel = value["claimLevel"];
  if (
    typeof claimLevel !== "number" ||
    !Number.isInteger(claimLevel) ||
    claimLevel < 0 ||
    claimLevel > 5
  ) {
    throw new ReportValidationError("claimLevel must be an integer 0..5");
  }
  return value as unknown as TranslationReport;
}
