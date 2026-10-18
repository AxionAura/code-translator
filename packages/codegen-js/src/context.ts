// Lowering context (docs/architecture.md §9): the per-unit state passed through every
// lowering rule — ledger recording, runtime-helper requirements, warnings, and a
// lightweight name→type scope stack for the few type-directed decisions. No hidden
// global state: one context per unit.
import type { AnnotatedType, DecisionKind, LedgerEntry, TargetLanguage } from "@ctrans/core";

export const CTW_TUPLE_ARRAY = "CTW-TUPLE-ARRAY";
export const CTW_DICT_KEY_COERCION = "CTW-DICT-KEY-COERCION";
export const CTW_CLASS_ATTR_STATIC = "CTW-CLASS-ATTR-STATIC";
export const CTW_MUTABLE_DEFAULT = "CTW-MUTABLE-DEFAULT";
export const CTW_DEFAULT_EVAL = "CTW-DEFAULT-EVAL-DEFERRED";
export const CTW_WITH_EXIT_ARGS = "CTW-WITH-EXIT-ARGS";
export const CTW_NUM_PRECISION = "CTW-NUM-INT-ARBITRARY-PRECISION";
export const CTW_NUM_BITWISE = "CTW-NUM-BITWISE";
export const CTW_GENERATOR_EAGER = "CTW-GENERATOR-EAGER";
export const CTW_EXTERNAL_UNMAPPED = "CTW-EXTERNAL-UNMAPPED";
export const CTW_KWARGS = "CTW-KWARGS";
export const CTW_METHOD_UNMAPPED = "CTW-METHOD-UNMAPPED";

export class LoweringContext {
  readonly ledger: LedgerEntry[] = [];
  readonly helpers = new Set<string>();
  readonly exceptionClasses = new Set<string>();
  readonly warnings = new Set<string>();
  readonly target: TargetLanguage;
  readonly filename: string;
  private ordinal = 0;

  constructor(target: TargetLanguage, filename: string) {
    // Explicit field assignment (not a parameter property): the unbuilt CLI runs
    // sources through Node strip-only mode, which rejects transform-only syntax.
    this.target = target;
    this.filename = filename;
  }

  record(entry: {
    span: { line: number | null; column: number | null } | null;
    sourceKind: string;
    rule: string;
    decision: DecisionKind;
    rationale: string;
    adaptation?: string | null;
    targetSummary?: string | null;
    warnings?: readonly string[];
  }): void {
    this.ordinal += 1;
    this.ledger.push({
      id: `${this.filename}#${String(this.ordinal).padStart(3, "0")}`,
      unit: this.filename,
      span:
        entry.span === null || (entry.span.line === null && entry.span.column === null)
          ? null
          : {
              start: { line: entry.span.line ?? 0, column: entry.span.column ?? 0 },
              end: { line: entry.span.line ?? 0, column: entry.span.column ?? 0 },
              startByteOffset: 0,
              endByteOffset: 0,
            },
      sourceKind: entry.sourceKind,
      rule: entry.rule,
      decision: entry.decision,
      rationale: entry.rationale,
      adaptation: entry.adaptation ?? null,
      targetSummary: entry.targetSummary ?? null,
      warnings: entry.warnings ?? [],
      escalation: null,
    });
    for (const warning of entry.warnings ?? []) this.warnings.add(warning);
  }

  useHelper(name: string): void {
    this.helpers.add(name);
  }

  useException(className: string): void {
    this.exceptionClasses.add(className);
  }
}

// Lightweight name→type scope stack for type-directed lowering decisions (numeric `+`,
// string repetition). Python bindings are rebindable; entries are mutable by default.
export class ScopeStack {
  private readonly scopes: Map<string, AnnotatedType>[] = [new Map()];

  push(): void {
    this.scopes.push(new Map());
  }

  pop(): void {
    this.scopes.pop();
  }

  declare(name: string, type: AnnotatedType): void {
    this.scopes[this.scopes.length - 1]!.set(name, type);
  }

  lookup(name: string): AnnotatedType | null {
    for (let i = this.scopes.length - 1; i >= 0; i -= 1) {
      const hit = this.scopes[i]?.get(name);
      if (hit !== undefined) return hit;
    }
    return null;
  }
}
