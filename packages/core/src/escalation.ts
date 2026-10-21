// AI escalation ports (docs/ai-architecture.md §1, ADR D-010/D-025). The engine
// owns the candidates and the applier; a resolver may ONLY select one of the
// offered options. Absent resolver = deterministic heuristic default (AI disabled
// is the default and must remain fully functional).
import type { LedgerEscalation } from "./ledger.js";
import type { SourceSpan } from "./source-span.js";

export interface ContractSummary {
  readonly module: string;
  readonly exports: readonly string[];
}

export interface AmbiguityOption {
  // Stable option id the resolver must return verbatim (e.g. "if-chain").
  readonly id: string;
  // Human/model-readable one-liner describing the emitted shape.
  readonly description: string;
}

// One engine-classified ambiguous construct, ready for escalation. Everything a
// resolver needs (and nothing more) travels here; the packer adds module
// contracts and diagnostics for the prompt.
export interface AmbiguityRequest {
  readonly unit: string;
  // Ledger rule fragment this decision belongs to (e.g. "py.Match").
  readonly rule: string;
  readonly sourceKind: string;
  readonly span: SourceSpan | null;
  // Bounded structural description of the construct (subject + per-case shapes)
  // — never the whole unit.
  readonly summary: string;
  // Direct-dependency contracts (export signatures only) — context-packing
  // currency per docs/ai-architecture.md §3; the packer may drop these to fit the
  // budget, never the construct itself.
  readonly contracts: readonly ContractSummary[];
  // Relevant unit diagnostics (bounded strings) for the payload.
  readonly diagnostics: readonly string[];
  readonly options: readonly AmbiguityOption[];
  // The deterministic default option id (applied with AI disabled).
  readonly heuristic: string;
}

export interface AmbiguityDecision {
  readonly optionId: string;
  // Provenance when a model resolved it; null for the deterministic heuristic.
  readonly escalation: LedgerEscalation | null;
}

// Escalation port. `null` means "no AI available/authorized" — the engine keeps
// the heuristic default. Implementations must validate the choice against
// `request.options`; the engine re-validates anyway (trust nothing).
export interface AmbiguityResolver {
  resolve(request: AmbiguityRequest, signal?: AbortSignal): Promise<AmbiguityDecision | null>;
}

// Deterministic identity for an ambiguity request (unit + construct position).
export function ambiguityKey(request: Pick<AmbiguityRequest, "unit" | "span" | "rule">): string {
  const offset = request.span?.startByteOffset ?? -1;
  return `${request.unit}#${String(offset)}#${request.rule}`;
}

// The engine-side validation of any resolver answer: the option must be one the
// engine offered. Anything else is rejected (never invented behavior).
export function validateAmbiguityDecision(
  request: AmbiguityRequest,
  decision: AmbiguityDecision | null,
): AmbiguityDecision | null {
  if (decision === null) return null;
  const offered = request.options.some((option) => option.id === decision.optionId);
  return offered ? decision : null;
}
