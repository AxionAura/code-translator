// Hostile-input containment for the native oxc boundary (ADR D-020).
//
// Verified on oxc-parser 0.153.0: sources nested ~4000 levels parse cleanly, but
// ~8000 levels SIGSEGV the whole process (the native parser/serializer recurses on
// the native stack; oxc exposes no depth option). A native crash cannot be caught,
// so oxc must never run on input it cannot survive:
//
// 1. A linear bracket scan (cheap, runs on every input) flags suspicious sources.
//    This is a resource-limit prefilter, not parsing — it makes no syntax claims.
// 2. Flagged inputs are measured EXACTLY: the pure-JS Babel parser (whose stack
//    overflow is a catchable RangeError, never a crash) parses first; either its
//    normalized AST yields the true depth, or its failure becomes a structured
//    error. Bypassing the scan with bracket characters inside strings cannot hide
//    depth, because the probe measures the real tree.
import type { AstNode } from "@axion-ct/core";

export const MAX_SAFE_NESTING_DEPTH = 2000;

export function maxBracketDepth(source: string): number {
  let depth = 0;
  let max = 0;
  for (const ch of source) {
    if (ch === "(" || ch === "[" || ch === "{") {
      depth += 1;
      if (depth > max) max = depth;
    } else if (ch === ")" || ch === "]" || ch === "}") {
      if (depth > 0) depth -= 1;
    }
  }
  return max;
}

// Exact depth of a normalized AstNode tree (iterative: the input is by definition
// deep when this runs).
export function maxAstDepth(root: AstNode): number {
  let max = 0;
  const stack: Array<{ node: AstNode; depth: number }> = [{ node: root, depth: 1 }];
  while (stack.length > 0) {
    const { node, depth } = stack.pop()!;
    if (depth > max) max = depth;
    for (const value of Object.values(node.fields)) {
      const values = Array.isArray(value) ? value : [value];
      for (const item of values) {
        if (typeof item === "object" && item !== null && "kind" in item) {
          stack.push({ node: item as AstNode, depth: depth + 1 });
        }
      }
    }
  }
  return max;
}
