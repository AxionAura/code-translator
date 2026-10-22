// CLI repair wiring (M9): --repair writes only the accepted state, reports the
// history, and degrades to `repair-unavailable` when AI is disabled. The journal
// is always written under the fixed `.ctrans/repairs/` path.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { DisabledRepairProposer, RepairJournal } from "@axion-ct/repair";

import { summarizeRepair, translateWithRepair } from "../src/repair-run.ts";
import { runCliCommand } from "../src/main.js";

const tempRoot = mkdtempSync(join(tmpdir(), "ctrans-repair-cli-"));

afterAll(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

function writeSource(name: string, content: string): string {
  const path = join(tempRoot, name);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content, "utf8");
  return path;
}

const OS_SOURCE = "import os\n\ndef where():\n    return os.getcwd()\n";
const CLEAN_SOURCE = "def add(a: int, b: int) -> int:\n    return a + b\n";

describe("translate --repair", () => {
  it("without AI: reports repair-unavailable, writes the journal, and keeps output deterministic", async () => {
    const source = writeSource("noai/app.py", OS_SOURCE);
    const out = join(tempRoot, "noai-out");
    const result = await runCliCommand(["translate", source, "--to", "ts", "-o", out, "--repair"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("repair: repair-unavailable");
    expect(result.stdout).toContain("history: .ctrans/repairs/repairs.json");
    const journal = JSON.parse(
      readFileSync(join(out, ".ctrans", "repairs", "repairs.json"), "utf8"),
    ) as { runs: { stopReason: string; attempts: { proposalOutcome: string }[] }[] };
    expect(journal.runs.length).toBe(1);
    expect(journal.runs[0]!.stopReason).toBe("repair-unavailable");
    expect(journal.runs[0]!.attempts[0]!.proposalOutcome).toBe("ai-disabled");
    // The emitted file is the deterministic baseline, unchanged.
    expect(readFileSync(join(out, "app.ts"), "utf8")).toContain("os");
    // Final report records the journal path.
    const report = JSON.parse(readFileSync(join(out, ".ctrans", "report.json"), "utf8")) as {
      repairJournal: string | null;
      claimLevel: number;
    };
    expect(report.repairJournal).toBe(".ctrans/repairs/repairs.json");
    expect(report.claimLevel).toBe(1);
    // AI disabled: no AI journal is written (no outbound activity at all).
    expect(() => readFileSync(join(out, ".ctrans", "ai-journal.json"), "utf8")).toThrow();
  }, 60000);

  it("with a clean translation reports no-failures and appends to existing history", async () => {
    const source = writeSource("clean/app.py", CLEAN_SOURCE);
    const out = join(tempRoot, "clean-out");
    const first = await runCliCommand(["translate", source, "--to", "ts", "-o", out, "--repair"]);
    const second = await runCliCommand(["translate", source, "--to", "ts", "-o", out, "--repair"]);
    expect(first.code).toBe(0);
    expect(second.code).toBe(0);
    expect(second.stdout).toContain("repair: no-failures");
    const loaded = RepairJournal.load(out);
    expect(loaded.recovered).toBe(false);
    expect(loaded.runs.length).toBe(2);
    expect(loaded.runs[0]!.stopReason).toBe("no-failures");
  }, 60000);

  it("rejects --repair on check (translate/project own the repair flow)", async () => {
    const source = writeSource("usage/app.py", CLEAN_SOURCE);
    const check = await runCliCommand(["check", source, "--to", "ts", "--repair"]);
    expect(check.code).toBe(2);
    expect(check.stderr).toContain("--repair is only available for `translate`");
  });

  it("reports a rejected out-of-scope patch and leaves the baseline output in place", async () => {
    const source = writeSource("rejected/app.py", OS_SOURCE);
    const out = join(tempRoot, "rejected-out");
    // A proposer that tries to edit a DIFFERENT file: the diff cannot apply to
    // app.ts, so the attempt is rejected before any validation or write.
    const outcome = await translateWithRepair({
      sourcePath: source,
      target: "typescript",
      outputDir: out,
      intMode: "number",
      proposer: {
        async propose(request) {
          return {
            outcome: "patch",
            patch: {
              unit: request.unit,
              targetPath: "other.ts",
              diff: "@@ -1,1 +1,1 @@\n-import * as os from 'os';\n+const os = {};\n",
              rationale: "out of scope",
              promptHash: "hash",
              escalation: { provider: "fake", model: "scripted", promptHash: "hash" },
              diffHash: `diff-${String(request.attempt)}`,
            },
            reason: null,
            inputTokens: 1,
            outputTokens: 1,
            secretRuleIds: [],
          };
        },
      },
    });
    expect(outcome.repair.acceptedUnits).toEqual([]);
    expect(outcome.repair.stopReason).toBe("attempts-exhausted");
    expect(outcome.repair.files.get("app.ts")!).not.toContain("const os = {}");
    expect(readFileSync(join(out, "app.ts"), "utf8")).not.toContain("const os = {}");
    const journal = RepairJournal.load(out);
    expect(journal.runs[0]!.attempts.every((attempt) => attempt.decision === "rejected")).toBe(
      true,
    );
    expect(outcome.summary).toContain("rejected");
  }, 60000);

  it("degrades cleanly with the explicit disabled proposer (no model, no request)", async () => {
    const source = writeSource("disabled/app.py", OS_SOURCE);
    const out = join(tempRoot, "disabled-out");
    const outcome = await translateWithRepair({
      sourcePath: source,
      target: "typescript",
      outputDir: out,
      intMode: "number",
      proposer: new DisabledRepairProposer(),
    });
    expect(outcome.repair.stopReason).toBe("repair-unavailable");
    expect(outcome.repair.attempts.length).toBe(1);
    expect(outcome.summary).toContain("ai-disabled");
  }, 60000);
});

describe("summarizeRepair", () => {
  it("renders accepted/rejected history without source content", () => {
    const summary = summarizeRepair(
      {
        files: new Map([["calc.ts", "SECRET CONTENT"]]),
        stages: [],
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
            reason: "claim level improved 0 → 2",
            stages: [],
            provider: "fake",
            model: "scripted",
            inputTokens: 1,
            outputTokens: 1,
            secretRuleIds: [],
            timestamp: "2026-10-21T00:00:00.000Z",
          },
        ],
        stopReason: "success",
        acceptedUnits: ["calc.py"],
        baselineStateHash: "a".repeat(64),
        finalStateHash: "b".repeat(64),
      },
      ".ctrans/repairs/repairs.json",
      false,
      2,
    );
    expect(summary).toContain("repair: success");
    expect(summary).toContain("calc.py -> calc.ts #1 accepted");
    expect(summary).toContain("accepted units: calc.py");
    expect(summary).toContain("history: .ctrans/repairs/repairs.json");
    expect(summary).not.toContain("SECRET CONTENT");
  });
});
