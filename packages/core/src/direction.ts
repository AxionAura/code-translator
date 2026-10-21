// Translation directions (roadmap M7 WS A): a typed model for the six supported
// direction pairs instead of scattered string checks. The pipeline stays
// language-agnostic — inputs arrive pre-parsed with `parseResult.language`, the
// wiring layer (CLI/tests) dispatches parser + code generator per direction —
// but validation applicability and report facts derive from the direction.
import type { ParseResult, SourceLanguage } from "./parse-result.js";
import type { TargetLanguage } from "./pipeline.js";

export type TranslationDirection =
  | "python→typescript"
  | "python→javascript"
  | "javascript→typescript"
  | "typescript→javascript"
  | "javascript→python"
  | "typescript→python";

export function directionFor(
  source: SourceLanguage,
  target: TargetLanguage,
): TranslationDirection | null {
  if (source === target) return null;
  const pair = `${source}→${target}`;
  return (DIRECTIONS as readonly string[]).includes(pair) ? (pair as TranslationDirection) : null;
}

export const DIRECTIONS: readonly TranslationDirection[] = [
  "python→typescript",
  "python→javascript",
  "javascript→typescript",
  "typescript→javascript",
  "javascript→python",
  "typescript→python",
];

// The source language of a project: derived from its parse results; mixed-language
// projects are rejected honestly (multi-language sources are out of V1 scope).
export function sourceLanguageOf(inputs: readonly Pick<ParseResult, "language">[]): SourceLanguage {
  const languages = new Set(inputs.map((input) => input.language));
  if (languages.size > 1) {
    throw new Error(
      `mixed-language sources are not supported in V1 (found: ${[...languages].sort().join(", ")})`,
    );
  }
  const first = inputs[0]?.language;
  if (first === undefined) {
    throw new Error("no inputs to derive the source language from");
  }
  return first;
}
