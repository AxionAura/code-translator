// CLI repair path (M9): translate, run the bounded repair loop over the emitted
// project with the SAME validators, write only the accepted state, then persist
// the hash-only journal. AI remains opt-in: without a provider the run reports
// `repair-unavailable` and leaves the deterministic output untouched.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  computeClaimLevel,
  validateTranslationReport,
  type AmbiguityResolver,
  type TargetLanguage,
  type TranslationReport,
} from "@ctrans/core";
import {
  JOURNAL_DIRECTORY,
  JOURNAL_FILE,
  RepairJournal,
  runRepairLoop,
  type RepairProposer,
  type RepairRunResult,
} from "@ctrans/repair";

import { runTranslation, writeTranslationArtifacts } from "./translate.js";

export interface TranslateWithRepairOptions {
  readonly sourcePath: string;
  readonly target: TargetLanguage;
  readonly outputDir: string;
  readonly intMode: "number" | "bigint";
  readonly proposer: RepairProposer;
  readonly resolver?: AmbiguityResolver;
  readonly now?: () => Date;
}

export interface RepairTranslationOutcome {
  readonly report: TranslationReport;
  readonly repair: RepairRunResult;
  readonly journalPath: string; // relative to the output directory
  readonly summary: string;
}

export async function translateWithRepair(
  options: TranslateWithRepairOptions,
): Promise<RepairTranslationOutcome> {
  const now = options.now ?? (() => new Date());
  const run = await runTranslation(
    options.sourcePath,
    options.target,
    options.intMode,
    options.resolver,
  );
  const files = new Map(run.result.emittedFiles.map((file) => [file.targetPath, file.content]));
  const units = run.result.emittedFiles.map((file) => ({
    unit: file.sourcePath,
    targetPath: file.targetPath,
    sourceText: run.sources.get(file.sourcePath) ?? "",
  }));
  const repair = await runRepairLoop(
    {
      files,
      units,
      stages: run.result.validationStages,
      ledger: run.result.ledger,
    },
    {
      proposer: options.proposer,
      validate: run.validateEmitted,
      now,
    },
  );

  // Persist only the accepted state. Rejected candidates were never committed.
  writeTranslationArtifacts(run.result, options.outputDir, repair.files);

  const timestamp = now().toISOString();
  const filesChanged = [
    ...new Set(
      repair.acceptedUnits.map((unitId) => units.find((unit) => unit.unit === unitId)?.targetPath),
    ),
  ]
    .filter((path): path is string => path !== undefined)
    .sort();
  const loaded = RepairJournal.load(options.outputDir);
  const journal = new RepairJournal();
  for (const previous of loaded.runs) journal.append(previous);
  journal.append({
    runId: `repair-${timestamp.replaceAll(/[:.]/g, "-")}-${repair.baselineStateHash.slice(0, 8)}`,
    timestamp,
    stopReason: repair.stopReason,
    baselineStateHash: repair.baselineStateHash,
    finalStateHash: repair.finalStateHash,
    acceptedUnits: repair.acceptedUnits,
    filesChanged,
    attempts: repair.attempts,
  });
  RepairJournal.write(options.outputDir, journal);
  const journalPath = `${JOURNAL_DIRECTORY}/${JOURNAL_FILE}`;

  // Final-state report: validation stages and claim level reflect the accepted
  // state, and the journal path is recorded. The baseline report is not reused,
  // because it would understate (or misstate) what was actually written.
  const finalReport = validateTranslationReport({
    ...run.result.report,
    validationStages: repair.stages.map((stage) => ({
      stage: stage.stage,
      status: stage.status,
      reason: stage.reason,
    })),
    claimLevel: computeClaimLevel(repair.stages),
    repairJournal: journalPath,
  });
  mkdirSync(join(options.outputDir, ".ctrans"), { recursive: true });
  writeFileSync(
    join(options.outputDir, ".ctrans", "report.json"),
    JSON.stringify(finalReport, null, 2) + "\n",
  );

  return {
    report: finalReport,
    repair,
    journalPath,
    summary: summarizeRepair(repair, journalPath, loaded.recovered, finalReport.claimLevel),
  };
}

// Deterministic, human-readable repair history (never includes file contents or
// raw model output — attempt reasons are validator/diff messages).
export function summarizeRepair(
  repair: RepairRunResult,
  journalPath: string,
  recovered: boolean,
  finalClaimLevel: number,
): string {
  const baselineNote = `baseline state ${repair.baselineStateHash.slice(0, 12)}`;
  const lines = [
    `repair: ${repair.stopReason}; accepted: ${String(repair.acceptedUnits.length)} unit(s); attempts: ${String(
      repair.attempts.length,
    )}; claim level ${String(finalClaimLevel)} (${baselineNote})`,
  ];
  for (const attempt of repair.attempts) {
    const reason = attempt.reason === null ? "" : ` — ${attempt.reason.slice(0, 160)}`;
    lines.push(
      `  ${attempt.unit} -> ${attempt.targetPath} #${String(attempt.attempt)} ` +
        `${attempt.decision} (${attempt.failureCode}/${attempt.proposalOutcome})${reason}`,
    );
  }
  if (repair.acceptedUnits.length > 0) {
    lines.push(`  accepted units: ${repair.acceptedUnits.join(", ")}`);
  }
  if (recovered) {
    lines.push("  journal: recovered from a corrupt file (previous history preserved aside)");
  }
  lines.push(`  history: ${journalPath}`);
  return lines.join("\n");
}
