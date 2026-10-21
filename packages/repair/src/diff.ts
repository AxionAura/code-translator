// Strict unified-diff application (roadmap M9 WS B; docs/ai-architecture.md §1
// port 2: "unified diff scoped to the failing unit; must apply cleanly"). Patches
// are untrusted model output: every hunk's old lines must match the baseline text
// EXACTLY (content-exact, offset-tolerant like patch(1)); file headers are only
// tolerated when they name the unit's own target path. Anything else is rejected —
// never guessed.
import type { RepairPatchScope } from "./types.js";

export type DiffApplication =
  | { readonly ok: true; readonly text: string; readonly hunks: number }
  | { readonly ok: false; readonly reason: string };

interface Hunk {
  readonly oldStart: number;
  readonly oldCount: number;
  readonly lines: readonly { readonly kind: " " | "-" | "+"; readonly text: string }[];
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

// Parse the patch into hunks, rejecting unsupported constructs (combined diffs,
// binary patches, git rename/delete metadata, bare `\ No newline` markers are
// tolerated per the unified-diff spec).
export function parseUnifiedDiff(
  diff: string,
  scope: RepairPatchScope,
):
  | { readonly ok: true; readonly hunks: readonly Hunk[] }
  | { readonly ok: false; readonly reason: string } {
  const lines = diff.replaceAll("\r\n", "\n").split("\n");
  const hunks: Hunk[] = [];
  let index = 0;
  // Optional file headers: only accepted when they match the unit's own target.
  if (index < lines.length && lines[index]!.startsWith("--- ")) {
    const header = lines[index]!.slice(4).trim();
    if (!headerMatches(header, scope.targetPath)) {
      return { ok: false, reason: `patch header targets another file: ${header.slice(0, 120)}` };
    }
    index += 1;
    if (index >= lines.length || !lines[index]!.startsWith("+++ ")) {
      return { ok: false, reason: "unified diff has a --- header without a +++ header" };
    }
    const target = lines[index]!.slice(4).trim();
    if (!headerMatches(target, scope.targetPath)) {
      return { ok: false, reason: `patch header targets another file: ${target.slice(0, 120)}` };
    }
    index += 1;
  }
  while (index < lines.length) {
    const line = lines[index]!;
    if (line.startsWith("diff --cc") || line.startsWith("diff --combined")) {
      return { ok: false, reason: "combined (merge) diffs are not supported" };
    }
    if (line === "" || line.startsWith("diff ") || line.startsWith("index ")) {
      index += 1;
      continue;
    }
    if (line.startsWith("Binary files")) {
      return { ok: false, reason: "binary patches are not supported" };
    }
    if (
      line.startsWith("rename ") ||
      line.startsWith("deleted file") ||
      line.startsWith("new file")
    ) {
      return { ok: false, reason: "git metadata operations are not supported" };
    }
    const match = HUNK_HEADER.exec(line);
    if (match === null) {
      return { ok: false, reason: `unsupported patch line: ${line.slice(0, 80)}` };
    }
    const oldStart = Number(match[1]);
    const oldCount = match[2] === undefined ? 1 : Number(match[2]);
    index += 1;
    const hunkLines: { kind: " " | "-" | "+"; text: string }[] = [];
    let consumedOld = 0;
    while (index < lines.length && !lines[index]!.startsWith("@@")) {
      const bodyLine = lines[index]!;
      if (bodyLine.startsWith("\\ No newline")) {
        index += 1;
        continue;
      }
      if (bodyLine === "" && index === lines.length - 1) break;
      const kind = bodyLine[0];
      if (kind !== " " && kind !== "-" && kind !== "+") {
        return {
          ok: false,
          reason: `hunk body line lacks a +/-/space prefix: ${bodyLine.slice(0, 80)}`,
        };
      }
      if (kind !== "+") consumedOld += 1;
      hunkLines.push({ kind, text: bodyLine.slice(1) });
      index += 1;
    }
    if (consumedOld !== oldCount) {
      return {
        ok: false,
        reason: `hunk declares ${String(oldCount)} old lines but contains ${String(consumedOld)}`,
      };
    }
    hunks.push({ oldStart, oldCount, lines: hunkLines });
  }
  if (hunks.length === 0) return { ok: false, reason: "patch contains no hunks" };
  return { ok: true, hunks };
}

function headerMatches(header: string, targetPath: string): boolean {
  // Strip timestamps, a leading ./, and a leading a/ or b/ prefix; the remainder
  // must name EXACTLY the scoped target (no other directory may sneak in).
  const cleaned = header
    .split("\t")[0]!
    .trim()
    .replace(/^\.\//, "")
    .replace(/^[ab]\//, "");
  return cleaned === targetPath;
}

// Policy guard for model output (M9): a patch may fix code, never weaken the
// validation that judges it. Rejections are structural (checked on ADDED lines)
// so a polite rationale cannot bypass them. This is defense in depth: the
// acceptance gate independently re-runs the real validators.
const FORBIDDEN_ADDITIONS: readonly { readonly label: string; readonly pattern: RegExp }[] = [
  { label: "TypeScript validation suppression", pattern: /@ts-(?:ignore|nocheck|expect-error)\b/ },
  { label: "ambient module/global declaration", pattern: /\bdeclare\s+(?:module|global)\b/ },
  { label: "linter or coverage suppression", pattern: /\beslint-disable\b|\bistanbul\s+ignore\b/i },
  {
    label: "test suppression or focus",
    pattern:
      /\b(?:it|test|describe|suite|context)\.(?:skip|only|todo)\b|\b(?:it|test)\.concurrent\.(?:skip|only)\b/,
  },
];

export function validatePatchPolicy(
  diff: string,
  scope: RepairPatchScope,
): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
  const parsed = parseUnifiedDiff(diff, scope);
  if (!parsed.ok) return parsed;
  for (const hunk of parsed.hunks) {
    for (const line of hunk.lines) {
      if (line.kind !== "+") continue;
      for (const rule of FORBIDDEN_ADDITIONS) {
        if (rule.pattern.test(line.text)) {
          return {
            ok: false,
            reason: `patch adds a forbidden construct (${rule.label}): ${line.text.trim().slice(0, 80)}`,
          };
        }
      }
    }
  }
  return { ok: true };
}

// Apply parsed hunks. Content-exact: the old lines must appear verbatim; the
// declared line numbers guide the search but drift is tolerated (patch(1)
// semantics) — mismatched CONTENT is always rejected.
export function applyUnifiedDiff(
  baseText: string,
  diff: string,
  scope: RepairPatchScope,
): DiffApplication {
  const parsed = parseUnifiedDiff(diff, scope);
  if (!parsed.ok) return parsed;
  const baseLines = baseText.replaceAll("\r\n", "\n").split("\n");
  const output: string[] = [];
  let cursor = 0;
  for (const hunk of parsed.hunks) {
    const oldLines = hunk.lines.filter((line) => line.kind !== "+").map((line) => line.text);
    const start = findBlock(baseLines, oldLines, Math.max(0, hunk.oldStart - 1), cursor);
    if (start === null) {
      return {
        ok: false,
        reason: `hunk at old line ${String(hunk.oldStart)} does not match the current unit text`,
      };
    }
    output.push(...baseLines.slice(cursor, start));
    for (const line of hunk.lines) {
      if (line.kind !== "-") output.push(line.text);
    }
    cursor = start + oldLines.length;
  }
  output.push(...baseLines.slice(cursor));
  return { ok: true, text: output.join("\n"), hunks: parsed.hunks.length };
}

// Find the first index >= from where the exact old block starts; the declared
// position is tried first. Returns null when the content never matches.
function findBlock(
  lines: readonly string[],
  block: readonly string[],
  declared: number,
  from: number,
): number | null {
  if (block.length === 0) return Math.max(from, Math.min(declared, lines.length));
  const matches = (start: number): boolean => {
    if (start < 0 || start + block.length > lines.length) return false;
    for (let offset = 0; offset < block.length; offset += 1) {
      if (lines[start + offset] !== block[offset]) return false;
    }
    return true;
  };
  const firstCandidate = Math.max(declared, from);
  if (matches(firstCandidate)) return firstCandidate;
  for (let start = from; start + block.length <= lines.length; start += 1) {
    if (matches(start)) return start;
  }
  return null;
}
