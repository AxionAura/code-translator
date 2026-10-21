// Repair journal (M9 WS E): fixed `.ctrans/repairs/repairs.json` path, hash-only
// provenance, tolerant corruption recovery, and containment-checked writes.
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  JOURNAL_DIRECTORY,
  JOURNAL_FILE,
  RepairJournal,
  type RepairJournalRun,
} from "../src/index.js";
import { twoStage } from "./helpers.js";

const created: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "ctrans-repair-journal-"));
  created.push(root);
  return root;
}

afterEach(() => {
  for (const root of created.splice(0)) rmSync(root, { recursive: true, force: true });
});

function run(overrides: Partial<RepairJournalRun> = {}): RepairJournalRun {
  return {
    runId: "run-1",
    timestamp: "2026-10-21T00:00:00.000Z",
    stopReason: "success",
    baselineStateHash: "a".repeat(64),
    finalStateHash: "b".repeat(64),
    acceptedUnits: ["calc.py"],
    filesChanged: ["calc.ts"],
    attempts: [
      {
        unit: "calc.py",
        targetPath: "calc.ts",
        attempt: 1,
        failureCode: "V-S1-PARSE",
        failureCategory: "syntax",
        baselineStateHash: "a".repeat(64),
        candidateStateHash: "b".repeat(64),
        patchHash: "c".repeat(64),
        proposalOutcome: "patch",
        decision: "accepted",
        reason: "claim level improved 0 → 2 with no passing stage regressed",
        stages: twoStage("pass", "pass").map((stage) => ({
          stage: stage.stage,
          status: stage.status,
        })),
        provider: "fake",
        model: "scripted",
        inputTokens: 10,
        outputTokens: 5,
        secretRuleIds: [],
        timestamp: "2026-10-21T00:00:00.000Z",
      },
    ],
    ...overrides,
  };
}

describe("RepairJournal", () => {
  it("writes a hash-only journal under the fixed .ctrans/repairs path with owner-only mode", () => {
    const root = tempRoot();
    const journal = new RepairJournal();
    journal.append(run());
    const path = RepairJournal.write(root, journal);
    expect(path).toBe(join(root, JOURNAL_DIRECTORY, JOURNAL_FILE));
    expect(existsSync(path)).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const text = readFileSync(path, "utf8");
    expect(text).toContain('"version": 1');
    expect(text).toContain("V-S1-PARSE");
  });

  it("round-trips through load()", () => {
    const root = tempRoot();
    const journal = new RepairJournal();
    journal.append(run());
    RepairJournal.write(root, journal);
    const loaded = RepairJournal.load(root);
    expect(loaded.recovered).toBe(false);
    expect(loaded.corruptBackupPath).toBeNull();
    expect(loaded.runs.length).toBe(1);
    expect(loaded.runs[0]!.acceptedUnits).toEqual(["calc.py"]);
    expect(loaded.runs[0]!.attempts[0]!.decision).toBe("accepted");
  });

  it("never persists diff text, source content, or arbitrary smuggled fields", () => {
    const journal = new RepairJournal();
    const smuggled = {
      ...run(),
      attempts: [
        {
          ...run().attempts[0]!,
          diff: "@@ -1,1 +1,1 @@\n-secret source",
          sourceText: "def secret(): pass",
        },
      ],
    } as unknown as RepairJournalRun;
    journal.append(smuggled);
    const text = journal.toJson();
    expect(text).not.toContain("@@ -1,1");
    expect(text).not.toContain("secret source");
    expect(text).not.toContain("def secret");
  });

  it("truncates oversized reason fields (no unbounded content on disk)", () => {
    const journal = new RepairJournal();
    journal.append(
      run({
        attempts: [{ ...run().attempts[0]!, reason: "x".repeat(5000) }],
      }),
    );
    const stored = journal.entries()[0]!.attempts[0]!.reason!;
    expect(stored.length).toBeLessThanOrEqual(301);
    expect(stored.endsWith("…")).toBe(true);
  });

  it("recovers from a corrupt journal, preserving the unreadable file aside", () => {
    const root = tempRoot();
    const path = join(root, JOURNAL_DIRECTORY, JOURNAL_FILE);
    mkdirSync(join(root, JOURNAL_DIRECTORY), { recursive: true });
    writeFileSync(path, '{"version":1,"runs":[{"runId":', "utf8");
    const loaded = RepairJournal.load(root);
    expect(loaded.recovered).toBe(true);
    expect(loaded.runs).toEqual([]);
    expect(loaded.corruptBackupPath).not.toBeNull();
    expect(existsSync(loaded.corruptBackupPath!)).toBe(true);
    expect(existsSync(path)).toBe(false);
    // A subsequent write starts a clean journal next to the preserved backup.
    RepairJournal.write(root, new RepairJournal());
    expect(RepairJournal.load(root).recovered).toBe(false);
  });

  it("drops malformed individual runs but keeps the valid ones (flagged)", () => {
    const root = tempRoot();
    const path = join(root, JOURNAL_DIRECTORY, JOURNAL_FILE);
    mkdirSync(join(root, JOURNAL_DIRECTORY), { recursive: true });
    const parsed = RepairJournal.parse(
      JSON.stringify({ version: 1, runs: [run(), { broken: true }] }),
    );
    expect(parsed.recovered).toBe(true);
    expect(parsed.journal.entries().length).toBe(1);
    writeFileSync(path, JSON.stringify({ version: 1, runs: [run(), { broken: true }] }), "utf8");
    const loaded = RepairJournal.load(root);
    expect(loaded.recovered).toBe(true);
    expect(loaded.runs.length).toBe(1);
  });

  it("returns an empty journal when none exists (no fabricated history)", () => {
    const loaded = RepairJournal.load(tempRoot());
    expect(loaded).toEqual({ runs: [], recovered: false, corruptBackupPath: null });
  });

  it("keeps every write inside the output root regardless of unit ids", () => {
    const root = tempRoot();
    const journal = new RepairJournal();
    journal.append(
      run({
        acceptedUnits: ["../escape.py"],
        attempts: [
          {
            ...run().attempts[0]!,
            unit: "../../etc/passwd",
            targetPath: "../../../tmp/evil.ts",
          },
        ],
      }),
    );
    const path = RepairJournal.write(root, journal);
    expect(path.startsWith(join(root, JOURNAL_DIRECTORY))).toBe(true);
    expect(existsSync(join(root, "..", "escape.ts"))).toBe(false);
    expect(existsSync(join(tmpdir(), "evil.ts"))).toBe(false);
    expect(existsSync(join(root, "..", "..", "tmp", "evil.ts"))).toBe(false);
    const text = readFileSync(path, "utf8");
    // Unit ids are DATA (serialized), never path segments.
    expect(text).toContain("../../etc/passwd");
  });

  it("fails with a typed error when the journal cannot be written", () => {
    const root = tempRoot();
    const journal = new RepairJournal();
    // A file where the .ctrans directory must go makes mkdir/write fail.
    writeFileSync(join(root, ".ctrans"), "not a directory", "utf8");
    try {
      RepairJournal.write(root, journal);
      expect.unreachable("journal write should have failed");
    } catch (error) {
      expect((error as { code?: string }).code).toBe("REPAIR-JOURNAL-WRITE");
    }
  });
});
