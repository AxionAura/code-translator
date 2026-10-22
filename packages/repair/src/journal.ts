// Repair journal (roadmap M9 WS E; docs/security.md): persists under
// `.ctrans/repairs/repairs.json` with hash-only provenance — never diffs, raw
// prompts, model responses, or source text. The file path is FIXED (unit ids are
// never used as paths, so traversal is impossible by construction); the loader is
// tolerant of corrupt/partial files and reports recovery instead of crashing.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";

import { CTransError } from "@axion-ct/core";

import type { RepairAttemptRecord, RepairStopReason } from "./types.js";

export interface RepairJournalRun {
  readonly runId: string;
  readonly timestamp: string;
  readonly stopReason: RepairStopReason;
  readonly baselineStateHash: string;
  readonly finalStateHash: string;
  readonly acceptedUnits: readonly string[];
  // Emitted files whose content changed through accepted repairs (sorted).
  readonly filesChanged: readonly string[];
  readonly attempts: readonly RepairAttemptRecord[];
}

export interface LoadedRepairJournal {
  readonly runs: readonly RepairJournalRun[];
  // True when some persisted data was unreadable and was skipped (the caller
  // must not present the run history as complete).
  readonly recovered: boolean;
  // Where the unreadable file was preserved (null when nothing was corrupt).
  readonly corruptBackupPath: string | null;
}

const JOURNAL_DIRECTORY = join(".ctrans", "repairs");
const JOURNAL_FILE = "repairs.json";
const CORRUPT_FILE = "repairs.corrupt.json";
const MAX_REASON_LENGTH = 300;

function truncate(value: string | null): string | null {
  if (value === null) return null;
  return value.length <= MAX_REASON_LENGTH ? value : `${value.slice(0, MAX_REASON_LENGTH)}…`;
}

// Strip anything not part of the documented journal schema (defense in depth: a
// future field accidentally carrying content never reaches disk).
function sanitizeAttempt(attempt: RepairAttemptRecord): RepairAttemptRecord {
  return {
    unit: attempt.unit,
    targetPath: attempt.targetPath,
    attempt: attempt.attempt,
    failureCode: attempt.failureCode,
    failureCategory: attempt.failureCategory,
    baselineStateHash: attempt.baselineStateHash,
    candidateStateHash: attempt.candidateStateHash,
    patchHash: attempt.patchHash,
    proposalOutcome: attempt.proposalOutcome,
    decision: attempt.decision,
    reason: truncate(attempt.reason),
    stages: attempt.stages.map((stage) => ({ stage: stage.stage, status: stage.status })),
    provider: attempt.provider,
    model: attempt.model,
    inputTokens: attempt.inputTokens,
    outputTokens: attempt.outputTokens,
    secretRuleIds: attempt.secretRuleIds,
    timestamp: attempt.timestamp,
  };
}

export class RepairJournal {
  private readonly runs: RepairJournalRun[] = [];
  private recoveredFromCorruption = false;

  append(run: RepairJournalRun): void {
    this.runs.push({
      runId: run.runId,
      timestamp: run.timestamp,
      stopReason: run.stopReason,
      baselineStateHash: run.baselineStateHash,
      finalStateHash: run.finalStateHash,
      acceptedUnits: [...run.acceptedUnits],
      filesChanged: [...run.filesChanged],
      attempts: run.attempts.map(sanitizeAttempt),
    });
  }

  entries(): readonly RepairJournalRun[] {
    return [...this.runs];
  }

  recovered(): boolean {
    return this.recoveredFromCorruption;
  }

  toJson(): string {
    return JSON.stringify({ version: 1, runs: this.runs }, null, 2) + "\n";
  }

  // Tolerant parse: a malformed JSON document yields an empty journal + the
  // recovered flag; malformed INDIVIDUAL runs are dropped (also flagged).
  static parse(text: string): { readonly journal: RepairJournal; readonly recovered: boolean } {
    const journal = new RepairJournal();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      journal.recoveredFromCorruption = true;
      return { journal, recovered: true };
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      journal.recoveredFromCorruption = true;
      return { journal, recovered: true };
    }
    const runs = (parsed as Record<string, unknown>)["runs"];
    if (!Array.isArray(runs)) {
      journal.recoveredFromCorruption = true;
      return { journal, recovered: true };
    }
    let recovered = false;
    for (const run of runs) {
      if (isJournalRun(run)) {
        // Older/partial records without filesChanged are normalized, not dropped.
        journal.runs.push({
          ...run,
          filesChanged: Array.isArray(run.filesChanged)
            ? run.filesChanged.filter((entry): entry is string => typeof entry === "string")
            : [],
        });
      } else recovered = true;
    }
    journal.recoveredFromCorruption = recovered;
    return { journal, recovered };
  }

  // Fixed-path, containment-checked persistence. Throws typed errors; a failed
  // write is never reported as a successful repair.
  static write(outputRoot: string, journal: RepairJournal): string {
    const root = resolve(outputRoot);
    const directory = resolve(root, JOURNAL_DIRECTORY);
    if (!directory.startsWith(`${root}${sep}`)) {
      throw new CTransError(
        "REPAIR-JOURNAL-PATH",
        `repair journal directory escapes the output root: ${directory}`,
      );
    }
    const target = join(directory, JOURNAL_FILE);
    try {
      mkdirSync(directory, { recursive: true });
      writeFileSync(target, journal.toJson(), { encoding: "utf8", mode: 0o600 });
    } catch (error) {
      throw new CTransError(
        "REPAIR-JOURNAL-WRITE",
        `could not write the repair journal: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    return target;
  }

  // Loads an existing journal; a corrupt file is renamed aside (never silently
  // overwritten) and an empty journal is returned with the recovery flag.
  static load(outputRoot: string): LoadedRepairJournal {
    const root = resolve(outputRoot);
    const directory = resolve(root, JOURNAL_DIRECTORY);
    const target = join(directory, JOURNAL_FILE);
    let text: string;
    try {
      text = readFileSync(target, "utf8");
    } catch {
      return { runs: [], recovered: false, corruptBackupPath: null };
    }
    const parsed = RepairJournal.parse(text);
    let corruptBackupPath: string | null = null;
    if (parsed.recovered) {
      corruptBackupPath = join(directory, CORRUPT_FILE);
      try {
        renameSync(target, corruptBackupPath);
      } catch {
        corruptBackupPath = null;
      }
    }
    return {
      runs: parsed.journal.entries(),
      recovered: parsed.recovered,
      corruptBackupPath,
    };
  }
}

function isJournalRun(value: unknown): value is RepairJournalRun {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record["runId"] === "string" &&
    typeof record["timestamp"] === "string" &&
    typeof record["stopReason"] === "string" &&
    typeof record["baselineStateHash"] === "string" &&
    typeof record["finalStateHash"] === "string" &&
    Array.isArray(record["acceptedUnits"]) &&
    Array.isArray(record["attempts"])
  );
}

export { JOURNAL_DIRECTORY, JOURNAL_FILE };
