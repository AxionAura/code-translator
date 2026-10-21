// `match` statement support (M8 doc reconciliation): language-support §2.4
// classifies match with literal/capture cases as `ambiguous` (if/else-chain
// heuristic; sequence/mapping/class/or patterns stay unsupported). Eight
// implementations share one analysis here — the pipeline's ambiguity pre-pass
// (collectMatchAmbiguities) and the lowering (lowerMatch) MUST agree on the
// offered options, so both consume the same analysis.
import type { AmbiguityRequest, AstNode, SourceSpan } from "@ctrans/core";

export interface LiteralCase {
  readonly kind: "literal";
  // Emitted comparison literal text (JSON for strings, plain for numbers).
  readonly literalText: string;
  readonly isBoolean: boolean;
  readonly guard: AstNode | null;
  readonly body: readonly AstNode[];
}

export interface CaptureCase {
  readonly kind: "capture";
  readonly name: string;
  readonly guard: AstNode | null;
  readonly body: readonly AstNode[];
}

export interface WildcardCase {
  readonly kind: "wildcard";
  readonly body: readonly AstNode[];
}

export type AnalyzedCase = LiteralCase | CaptureCase | WildcardCase;

export interface MatchPlan {
  readonly cases: readonly AnalyzedCase[];
  // `switch` is semantics-equivalent only for non-boolean literal patterns (JS
  // `===` vs Python `==`: Python matches `1` against `True`; JS switch would not)
  // with no captures and no guards. Only then is it offered.
  readonly switchable: boolean;
  readonly options: readonly { readonly id: string; readonly description: string }[];
}

function kid(node: AstNode, name: string): AstNode | null {
  const value = node.fields[name];
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as AstNode)
    : null;
}

function kids(node: AstNode, name: string): readonly AstNode[] {
  const value = node.fields[name];
  return Array.isArray(value) ? (value as readonly AstNode[]) : [];
}

function scalar(node: AstNode, name: string): string | number | boolean | null {
  const value = node.fields[name];
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? value
    : null;
}

// Analyze one match statement. Returns null when the construct is outside the
// supported (ambiguous) subset — the caller then reports it unsupported-loud.
export function analyzeMatchStatement(node: AstNode): MatchPlan | null {
  const cases: AnalyzedCase[] = [];
  for (const caseNode of kids(node, "cases")) {
    const pattern = kid(caseNode, "pattern");
    if (pattern === null) return null;
    const guard = kid(caseNode, "guard");
    const body = kids(caseNode, "body");
    if (pattern.kind === "MatchValue") {
      const value = kid(pattern, "value");
      if (value === null || value.kind !== "Constant") return null;
      const constant = value.fields["value"];
      if (typeof constant === "string") {
        cases.push({
          kind: "literal",
          literalText: JSON.stringify(constant),
          isBoolean: false,
          guard,
          body,
        });
      } else if (typeof constant === "number") {
        cases.push({
          kind: "literal",
          literalText: String(constant),
          isBoolean: false,
          guard,
          body,
        });
      } else if (typeof constant === "boolean") {
        cases.push({
          kind: "literal",
          literalText: constant ? "true" : "false",
          isBoolean: true,
          guard,
          body,
        });
      } else {
        return null;
      }
      continue;
    }
    if (pattern.kind === "MatchAs") {
      const inner = kid(pattern, "pattern");
      if (inner !== null) return null; // `case sub as name` is outside the subset
      const name = scalar(pattern, "name");
      if (name === null) {
        // Wildcard `case _:` — must be the last refutable case (parser enforces).
        cases.push({ kind: "wildcard", body });
      } else {
        cases.push({ kind: "capture", name: String(name), guard, body });
      }
      continue;
    }
    // MatchSingleton / MatchSequence / MatchMapping / MatchClass / MatchOr / MatchStar
    return null;
  }
  if (cases.length === 0) return null;
  // A wildcard or unguarded capture makes everything after it unreachable; CPython
  // rejects unreachable patterns, so only trailing irrefutable cases can appear —
  // no extra validation needed here.
  const switchable =
    cases.every((entry) =>
      entry.kind === "literal"
        ? !entry.isBoolean && entry.guard === null
        : entry.kind === "wildcard",
    ) && cases.filter((entry) => entry.kind === "wildcard").length <= 1;
  const ifChain = {
    id: "if-chain",
    description:
      "if/else-if chain comparing the subject once (Python == via __ctrans_eq; guards and captures supported)",
  };
  const switchCase = {
    id: "switch",
    description:
      "JS switch on a single subject binding (strict === on literal candidates; no guards/captures/booleans)",
  };
  return {
    cases,
    switchable,
    options: switchable ? [ifChain, switchCase] : [ifChain],
  };
}

// Human/model-readable bounded summary: subject shape + per-case descriptors.
function describeSubject(node: AstNode | null): string {
  if (node === null) return "expression";
  if (node.kind === "Name") return String(scalar(node, "id") ?? "name");
  if (node.kind === "Attribute") {
    return `${describeSubject(kid(node, "value"))}.${String(scalar(node, "attr") ?? "attr")}`;
  }
  if (node.kind === "Call") {
    return `call to ${describeSubject(kid(node, "func"))}(…)`;
  }
  return "expression";
}

function describeCase(entry: AnalyzedCase): string {
  const guard = entry.kind !== "wildcard" && entry.guard !== null ? " if guard" : "";
  if (entry.kind === "literal")
    return `case ${entry.literalText}${guard} → ${String(entry.body.length)} stmt(s)`;
  if (entry.kind === "capture")
    return `case capture ${entry.name}${guard} → ${String(entry.body.length)} stmt(s)`;
  return `case _ (wildcard) → ${String(entry.body.length)} stmt(s)`;
}

// The engine-side request for one match statement. Both the pipeline pre-pass and
// the lowering derive the same key from `node.span`, so the decision binds.
export function matchAmbiguityRequest(unit: string, node: AstNode): AmbiguityRequest | null {
  const plan = analyzeMatchStatement(node);
  if (plan === null || plan.options.length < 2) return null; // not ambiguous: one strategy
  return {
    unit,
    rule: "py.Match",
    sourceKind: "py.Match",
    span: (node.span ?? null) as SourceSpan | null,
    summary: `match on ${describeSubject(kid(node, "subject"))}: ${plan.cases.map(describeCase).join("; ")}`,
    // The pipeline enriches these with direct-dep contracts + diagnostics before
    // escalation (core's resolveAmbiguities); defaults keep the request valid for
    // direct library use.
    contracts: [],
    diagnostics: [],
    options: plan.options,
    heuristic: "if-chain",
  };
}

// Iterative walk collecting every match statement in the unit AST (module body,
// function/method bodies, nested blocks all reachable through fields).
export function collectMatchStatements(root: AstNode): AstNode[] {
  const matches: AstNode[] = [];
  const stack: AstNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.kind === "Match") matches.push(node);
    for (const value of Object.values(node.fields)) {
      if (Array.isArray(value)) {
        for (const item of value) {
          if (typeof item === "object" && item !== null && "kind" in (item as object)) {
            stack.push(item as AstNode);
          }
        }
      } else if (typeof value === "object" && value !== null && "kind" in (value as object)) {
        stack.push(value as AstNode);
      }
    }
  }
  // Deterministic order: source position (byte offset), regardless of walk order.
  return matches.sort(
    (left, right) => (left.span?.startByteOffset ?? 0) - (right.span?.startByteOffset ?? 0),
  );
}
