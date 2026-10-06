/**
 * Small arithmetic helpers used to pin the fixture format contract.
 *
 * Translated by Code Translator (python -> typescript).
 * Provenance and per-construct decisions: .ctrans/ledger.json
 * Helpers below are generated only when referenced (D-007).
 */

export function clamp(value: number, low: number = 0, high: number = 100): number {
  if (value < low) {
    return low;
  }
  if (value > high) {
    return high;
  }
  return value;
}

export function describe(values: Array<number>): string {
  const total: number = values.reduce((a, b) => a + b, 0);
  const first: number | undefined = values.length > 0 ? values[0] : undefined;
  return `total=${total} first=${first} count=${values.length}`;
}

export function everyOther(text: string): string {
  // semantic: python slice step has no JS equivalent -> helper (D-016)
  return __ctrans.strSlice(text, undefined, undefined, 2);
}

export class Counter {
  private _count: number;

  constructor(start: number = 0) {
    this._count = start;
  }

  bump(by: number = 1): number {
    this._count += by;
    return this._count;
  }
}

export function parsePositive(raw: string): number {
  // semantic: python int() accepts whitespace/signs/bases; Number() does not
  const value: number = __ctrans.intFromString(raw);
  if (value <= 0) {
    throw new __ctrans.ValueError(`not positive: ${raw}`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Generated helper namespace (omitted when unused; single instance per project)
// ---------------------------------------------------------------------------
declare namespace __ctrans {
  class ValueError extends Error {}
  function strSlice(s: string, start?: number, end?: number, step?: number): string;
  function intFromString(s: string): number;
}
