// AI escalation journal (docs/ai-architecture.md §5): every interaction records
// its outcome and provenance. The default journal stores the prompt HASH only —
// never prompt contents, never secrets. The journal is deterministic (ordinal
// order, no timestamps by default) so artifacts stay reviewable.
import type { ChatUsage } from "./types.js";

export type JournalOutcome =
  | "resolved"
  | "resolved-after-reask"
  | "cache-hit"
  | "heuristic-fallback"
  | "blocked-secret"
  | "cap-exhausted"
  | "invalid-output"
  | "provider-error"
  | "packet-too-large"
  | "aborted";

export interface JournalEntry {
  readonly ordinal: number;
  readonly unit: string;
  readonly rule: string;
  readonly provider: string | null;
  readonly model: string | null;
  readonly promptHash: string | null;
  readonly outcome: JournalOutcome;
  readonly optionId: string | null;
  readonly reason: string | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly usd: number | null;
  readonly durationMs: number | null;
  // Secret-gate rule ids only (never the matching text).
  readonly secretRuleIds: readonly string[];
}

export class AiJournal {
  private readonly entries: JournalEntry[] = [];
  private readonly clock: (() => number) | null;
  private readonly includeDuration: boolean;

  constructor(options: { clock?: () => number } = {}) {
    this.clock = options.clock ?? null;
    this.includeDuration = options.clock !== undefined;
  }

  record(
    entry: Omit<JournalEntry, "ordinal" | "durationMs"> & { readonly durationMs?: number | null },
  ): JournalEntry {
    const journalEntry: JournalEntry = {
      ordinal: this.entries.length + 1,
      ...entry,
      durationMs: entry.durationMs ?? null,
    };
    this.entries.push(journalEntry);
    return journalEntry;
  }

  // Deterministic measurement helper: callers bracket model work with these.
  now(): number | null {
    return this.clock === null ? null : this.clock();
  }

  elapsed(startedAt: number | null): number | null {
    if (!this.includeDuration || this.clock === null || startedAt === null) return null;
    return Math.max(0, Math.round(this.clock() - startedAt));
  }

  entriesView(): readonly JournalEntry[] {
    return [...this.entries];
  }

  toJson(): string {
    return JSON.stringify({ version: 1, entries: this.entries }, null, 2) + "\n";
  }

  static usageFields(
    usage: ChatUsage | null,
  ): Pick<JournalEntry, "inputTokens" | "outputTokens" | "usd"> {
    return {
      inputTokens: usage === null ? null : usage.inputTokens,
      outputTokens: usage === null ? null : usage.outputTokens,
      usd: usage === null ? null : usage.usd,
    };
  }
}
