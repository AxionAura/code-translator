// Shared ESTree → AstNode normalization for the JS/TS front-ends (oxc primary, Babel
// fallback). Both emit ESTree-shaped trees with UTF-16 code-unit start/end indices, so
// one converter serves both: indices become contract byte offsets via a memoized map,
// and line/column are derived from the byte offsets on the shared line grid (parser
// columns are never trusted). The walk is iterative — hostile input depth must not
// exhaust the host stack. Plain-object properties (regex patterns, template values,
// Babel's `extra`) expand into dotted sibling field names so the AstValue contract
// stays scalar-only; no information is dropped.
import {
  lineIndexOf,
  type AstNode,
  type AstValue,
  type SourceLines,
  type SourceSpan,
} from "@ctrans/core";

const SKIPPED_KEYS = new Set([
  "start",
  "end",
  "loc",
  "range",
  // Babel attaches comment arrays to nodes; comments travel in the result's comments
  // field instead (D-019).
  "leadingComments",
  "trailingComments",
  "innerComments",
  "comments",
]);

const POP_MARKER = Symbol("ctrans.pop");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeShaped(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && typeof value["type"] === "string" && typeof value["start"] === "number";
}

// UTF-16 index → UTF-8 byte offset, memoized per source (many nodes share boundaries).
export class ByteOffsetMap {
  readonly #memo = new Map<number, number>();

  constructor(private readonly source: string) {}

  toByte(utf16Index: number): number {
    const hit = this.#memo.get(utf16Index);
    if (hit !== undefined) return hit;
    const byte = Buffer.byteLength(this.source.slice(0, utf16Index), "utf8");
    this.#memo.set(utf16Index, byte);
    return byte;
  }
}

export function toSpan(
  converter: ByteOffsetMap,
  lines: SourceLines,
  startUtf16: number,
  endUtf16: number,
): SourceSpan {
  const startByteOffset = converter.toByte(startUtf16);
  const endByteOffset = converter.toByte(endUtf16);
  const startLine = lineIndexOf(lines.lineStarts, startByteOffset);
  const endLine = lineIndexOf(lines.lineStarts, endByteOffset);
  return {
    start: { line: startLine, column: startByteOffset - (lines.lineStarts[startLine] ?? 0) },
    end: { line: endLine, column: endByteOffset - (lines.lineStarts[endLine] ?? 0) },
    startByteOffset,
    endByteOffset,
  };
}

interface PlanEntry {
  readonly name: string;
  readonly shape: "single" | "list";
  readonly slots: Array<AstValue | symbol>;
}

interface AssembleFrame {
  readonly kind: string;
  readonly span: SourceSpan;
  readonly plan: PlanEntry[];
}

type WorkEntry =
  | { readonly visit: { readonly value: unknown; readonly name: string } }
  | { readonly assemble: AssembleFrame };

function pushValue(stack: WorkEntry[], plan: PlanEntry[], name: string, value: unknown): void {
  if (Array.isArray(value)) {
    const slots: Array<AstValue | symbol> = [];
    for (const item of value) {
      if (isNodeShaped(item)) {
        slots.push(POP_MARKER);
        stack.push({ visit: { value: item, name } });
      } else if (isRecord(item)) {
        // No known ESTree producer puts plain objects in node arrays; fail loudly
        // rather than silently reshaping.
        throw new Error(`array property "${name}" contains a non-node object`);
      } else {
        slots.push(toScalar(item));
      }
    }
    plan.push({ name, shape: "list", slots });
    return;
  }
  if (isNodeShaped(value)) {
    plan.push({ name, shape: "single", slots: [POP_MARKER] });
    stack.push({ visit: { value, name } });
    return;
  }
  if (isRecord(value)) {
    // Plain objects expand into dotted sibling entries: `regex` → `regex.pattern`,
    // `regex.flags`; empty objects carry no information and vanish.
    for (const [key, sub] of Object.entries(value)) {
      pushValue(stack, plan, `${name}.${key}`, sub);
    }
    return;
  }
  plan.push({ name, shape: "single", slots: [toScalar(value)] });
}

function toScalar(value: unknown): AstValue {
  if (value === undefined) return null;
  if (typeof value === "number" && !Number.isFinite(value)) return null;
  return value as AstValue;
}

export function convertProgram(
  program: unknown,
  converter: ByteOffsetMap,
  lines: SourceLines,
): AstNode {
  const finished: AstNode[] = [];
  const stack: WorkEntry[] = [{ visit: { value: program, name: "" } }];
  while (stack.length > 0) {
    const entry = stack.pop()!;
    if ("assemble" in entry) {
      const frame = entry.assemble;
      const popCount = frame.plan.reduce(
        (count, field) => count + field.slots.filter((slot) => slot === POP_MARKER).length,
        0,
      );
      const children = finished.splice(finished.length - popCount).reverse();
      let cursor = 0;
      const nextChild = (): AstNode => {
        const child = children[cursor];
        cursor += 1;
        if (child === undefined) {
          throw new Error("ESTree normalization child count mismatch");
        }
        return child;
      };
      const fields: Record<string, AstValue> = {};
      for (const field of frame.plan) {
        const values = field.slots.map((slot) =>
          slot === POP_MARKER ? nextChild() : (slot as AstValue),
        );
        fields[field.name] = field.shape === "single" ? (values[0] ?? null) : values;
      }
      finished.push({ kind: frame.kind, span: frame.span, fields });
      continue;
    }
    const raw = entry.visit.value;
    if (!isNodeShaped(raw)) {
      throw new Error("ESTree normalization expects a node with type/start/end");
    }
    const span = toSpan(converter, lines, raw["start"] as number, raw["end"] as number);
    const plan: PlanEntry[] = [];
    const frame: AssembleFrame = { kind: raw["type"] as string, span, plan };
    stack.push({ assemble: frame });
    for (const [name, value] of Object.entries(raw)) {
      if (SKIPPED_KEYS.has(name)) continue;
      pushValue(stack, plan, name, value);
    }
  }
  if (finished.length !== 1) {
    throw new Error("ESTree normalization must yield exactly one root");
  }
  return finished[0]!;
}
