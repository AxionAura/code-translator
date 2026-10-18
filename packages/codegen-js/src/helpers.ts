// __ctrans_runtime templates (D-007/D-016): each helper is dependency-free,
// deterministic, and emitted into the output project ONLY when a lowering rule
// referenced it. The runtime module is generated at the output root as
// `__ctrans_runtime.<ext>` and imported by name — generated projects never depend on
// this tool.
//
// Signatures accept `unknown` for values Python treats dynamically: translated Python
// has no static types where the source had none, so helpers — not strict JS operators —
// carry the Python semantics (typeof checks raise the Python TypeError family).
//
// Sources are written in TypeScript. For JavaScript targets the emitter erases the
// annotations with Node's built-in type stripping (ADR D-022) — one source of truth
// per helper, no hand-maintained JS twin. Sources must therefore stay strip-safe:
// type annotations only, no enums/namespaces/overloads/parameter properties.
export interface RuntimeHelper {
  readonly name: string;
  readonly code: string;
  // Other runtime helpers whose code this helper references. The translator pulls
  // the transitive closure so the emitted module never misses a definition.
  readonly requires?: readonly string[];
  // Exception classes (exported by the "exceptions" helper) referenced from this
  // helper's code — included even when translated code never raises.
  readonly exceptions?: readonly string[];
  // Internal support helpers are embedded in the runtime module but never imported
  // by translated units (only public helpers enter import statements).
  readonly internal?: boolean;
}

const EXCEPTION_CLASSES = `
export class PythonException extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Exception";
  }
}
export class ValueError extends PythonException {
  constructor(message: string) {
    super(message);
    this.name = "ValueError";
  }
}
export class TypeError extends PythonException {
  constructor(message: string) {
    super(message);
    this.name = "TypeError";
  }
}
export class KeyError extends PythonException {
  constructor(message: string) {
    super(message);
    this.name = "KeyError";
  }
}
export class IndexError extends PythonException {
  constructor(message: string) {
    super(message);
    this.name = "IndexError";
  }
}
export class AttributeError extends PythonException {
  constructor(message: string) {
    super(message);
    this.name = "AttributeError";
  }
}
export class ZeroDivisionError extends PythonException {
  constructor(message: string) {
    super(message);
    this.name = "ZeroDivisionError";
  }
}
export class RuntimeError extends PythonException {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeError";
  }
}`;

const REQUIRE_NUMBER_CODE = `// Python operators on dynamically typed values: numbers validate, then operate.
// bigint counts as an integer operand (D-006 bigint mode); booleans act as 0/1.
function __ctrans_requireNumber(v: unknown, op: string): number {
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v !== "number") {
    throw new TypeError(\`unsupported operand type(s) for \${op}\`);
  }
  return v;
}

// Integer classification across the D-006 modes: bigint is always integral,
// booleans act as 0/1, Numbers are integral when they are whole values. Mixed
// int/float arithmetic converts through Number (the documented bigint boundary).
function __ctrans_isIntegral(v: unknown): boolean {
  if (typeof v === "bigint") return true;
  if (typeof v === "boolean") return true;
  return typeof v === "number" && Number.isInteger(v);
}

function __ctrans_asBigInt(v: unknown): bigint {
  if (typeof v === "bigint") return v;
  if (typeof v === "boolean") return v ? 1n : 0n;
  return BigInt(Math.trunc(Number(v)));
}

// Python floor division shared shape: q = trunc(a/b) corrected when the remainder
// has the opposite sign of the divisor. Works for bigint and Number paths.
function __ctrans_floorQuotient(a: unknown, b: unknown, op: string): __CTRANS_NUM__ | bigint {
  if (typeof a === "bigint" || typeof b === "bigint") {
    const left = __ctrans_asBigInt(a);
    const right = __ctrans_asBigInt(b);
    if (right === 0n) throw new ZeroDivisionError("division by zero");
    const q = left / right;
    const r = left % right;
    if (r !== 0n && left < 0n !== right < 0n) return q - 1n;
    return q;
  }
  const left = __ctrans_requireNumber(a, op);
  const right = __ctrans_requireNumber(b, op);
  if (right === 0) throw new ZeroDivisionError("division by zero");
  return Math.floor(left / right);
}

// Python modulo: result takes the divisor's sign.
function __ctrans_pythonMod(a: unknown, b: unknown, op: string): __CTRANS_NUM__ | bigint {
  if (typeof a === "bigint" || typeof b === "bigint") {
    const left = __ctrans_asBigInt(a);
    const right = __ctrans_asBigInt(b);
    if (right === 0n) throw new ZeroDivisionError("division by zero");
    return ((left % right) + right) % right;
  }
  const left = __ctrans_requireNumber(a, op);
  const right = __ctrans_requireNumber(b, op);
  if (right === 0) throw new ZeroDivisionError("division by zero");
  return ((left % right) + right) % right;
}

// Numeric arithmetic core shared by + - * and sum(): integral operands keep exact
// bigint semantics when either side is bigint (D-006 exact mode); a float operand
// converts the pair through Number (Python int+float -> float, precision boundary).
function __ctrans_numeric(
  a: unknown,
  b: unknown,
  op: string,
  combineNumber: (left: number, right: number) => number,
): __CTRANS_NUM__ | bigint {
  const left = __ctrans_requireNumber(a, op);
  const right = __ctrans_requireNumber(b, op);
  if (
    (typeof a === "bigint" || typeof b === "bigint") &&
    __ctrans_isIntegral(a) &&
    __ctrans_isIntegral(b)
  ) {
    const bigLeft = __ctrans_asBigInt(a);
    const bigRight = __ctrans_asBigInt(b);
    switch (op) {
      case "+":
        return bigLeft + bigRight;
      case "-":
        return bigLeft - bigRight;
      default:
        return bigLeft * bigRight;
    }
  }
  return combineNumber(left, right);
}

`;

const REQUIRE_STRING_CODE = `function __ctrans_requireString(v: unknown, op: string): string {
  if (typeof v !== "string") {
    throw new TypeError(\`unsupported operand type(s) for \${op}\`);
  }
  return v;
}`;

const COMPARE_CORE = `// Python ordering: numeric pairs compare numerically (bigint/number mixed safe);
// string pairs compare by UNICODE CODE POINTS — JS < compares UTF-16 units, which
// diverges for astral-plane characters (surrogate units sort below U+E000..U+FFFF
// BMP characters that follow them in code-point order).
function __ctrans_compareCodePoints(a: string, b: string): number {
  const left = Array.from(a);
  const right = Array.from(b);
  const shared = Math.min(left.length, right.length);
  for (let i = 0; i < shared; i += 1) {
    const l = left[i]!.codePointAt(0)!;
    const r = right[i]!.codePointAt(0)!;
    if (l !== r) return l < r ? -1 : 1;
  }
  return left.length - right.length;
}
function __ctrans_compare(op: string, a: unknown, b: unknown): boolean {
  const aNumeric = typeof a === "number" || typeof a === "bigint" || typeof a === "boolean";
  const bNumeric = typeof b === "number" || typeof b === "bigint" || typeof b === "boolean";
  if (aNumeric && bNumeric) {
    const left = Number(a);
    const right = Number(b);
    if (Number.isNaN(left) || Number.isNaN(right)) {
      throw new TypeError(\`'\${op}' not supported between NaN\`);
    }
    switch (op) {
      case "<":
        return left < right;
      case "<=":
        return left <= right;
      case ">":
        return left > right;
      default:
        return left >= right;
    }
  }
  if (typeof a === "string" && typeof b === "string") {
    const order = __ctrans_compareCodePoints(a, b);
    switch (op) {
      case "<":
        return order < 0;
      case "<=":
        return order <= 0;
      case ">":
        return order > 0;
      default:
        return order >= 0;
    }
  }
  throw new TypeError(\`'\${op}' not supported between instances of '\${__ctrans_str(a)}' and '\${__ctrans_str(b)}'\`);
}`;

// D-006: the widened numeric helpers return `number` in the default mode (true at
// runtime — bigint paths never fire) and `number | bigint` in bigint mode. One
// helper source, mode-parameterized at render time via this placeholder.
export const INT_RESULT_TYPE: Readonly<Record<"number" | "bigint", string>> = {
  number: "number",
  bigint: "number | bigint",
};

export const RUNTIME_HELPERS: Readonly<Record<string, RuntimeHelper>> = {
  exceptions: {
    name: "exceptions",
    internal: true,
    code: EXCEPTION_CLASSES,
  },
  requireNumber: {
    name: "requireNumber",
    internal: true,
    requires: ["exceptions"],
    exceptions: ["TypeError", "ZeroDivisionError"],
    code: REQUIRE_NUMBER_CODE,
  },
  requireString: {
    name: "requireString",
    internal: true,
    requires: ["exceptions"],
    exceptions: ["TypeError"],
    code: REQUIRE_STRING_CODE,
  },
  truthy: {
    name: "truthy",
    code: `// Python truth-value testing: NaN, [], {} are truthy in Python and falsy in JS.
export function __ctrans_truthy(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0; // NaN is truthy in Python
  if (typeof v === "bigint") return v !== 0n;
  if (typeof v === "string") return v.length > 0;
  if (Array.isArray(v)) return v.length > 0;
  if (v instanceof Set || v instanceof Map) return v.size > 0;
  if (typeof v === "object") return Object.keys(v).length > 0;
  return true;
}`,
  },
  lt: {
    name: "lt",
    requires: ["compare"],
    code: `export function __ctrans_lt(a: unknown, b: unknown): boolean {
  return __ctrans_compare("<", a, b);
}`,
  },
  lte: {
    name: "lte",
    requires: ["compare"],
    code: `export function __ctrans_lte(a: unknown, b: unknown): boolean {
  return __ctrans_compare("<=", a, b);
}`,
  },
  gt: {
    name: "gt",
    requires: ["compare"],
    code: `export function __ctrans_gt(a: unknown, b: unknown): boolean {
  return __ctrans_compare(">", a, b);
}`,
  },
  ge: {
    name: "ge",
    requires: ["compare"],
    code: `export function __ctrans_ge(a: unknown, b: unknown): boolean {
  return __ctrans_compare(">=", a, b);
}`,
  },
  compare: {
    name: "compare",
    internal: true,
    requires: ["str"],
    exceptions: ["TypeError"],
    code: COMPARE_CORE,
  },
  eq: {
    name: "eq",
    code: `// Python == : value comparison with elementwise sequences; 1 == 1.0 and
// bigint/number pairs compare numerically across the D-006 boundary.
export function __ctrans_eq(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  const aNumeric = typeof a === "number" || typeof a === "bigint" || typeof a === "boolean";
  const bNumeric = typeof b === "number" || typeof b === "bigint" || typeof b === "boolean";
  if (aNumeric && bNumeric) return Number(a) === Number(b);
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => __ctrans_eq(item, b[index]));
  }
  return false;
}`,
  },
  contains: {
    name: "contains",
    requires: ["eq"],
    exceptions: ["TypeError"],
    code: `// Python \`in\`: uses == on sequence members, key lookup on mappings/sets.
export function __ctrans_contains(container: unknown, item: unknown): boolean {
  if (typeof container === "string") {
    return typeof item === "string" && container.includes(item);
  }
  if (Array.isArray(container)) return container.some((entry) => __ctrans_eq(entry, item));
  if (container instanceof Set) return container.has(item as never);
  if (container instanceof Map) {
    for (const key of container.keys()) if (__ctrans_eq(key, item)) return true;
    return false;
  }
  if (typeof container === "object" && container !== null) {
    return typeof item === "string" && item in container;
  }
  throw new TypeError("argument of type is not iterable");
}`,
  },
  len: {
    name: "len",
    exceptions: ["TypeError"],
    code: `// Python len(): sequences, mappings, sets; strings measure UNICODE CODE POINTS
// (Python semantics; JS .length counts UTF-16 units and diverges for astral chars).
export function __ctrans_len(v: unknown): number {
  if (typeof v === "string") return Array.from(v).length;
  if (Array.isArray(v)) return v.length;
  if (v instanceof Set || v instanceof Map) return v.size;
  if (typeof v === "object" && v !== null) return Object.keys(v).length;
  throw new TypeError("object has no len()");
}`,
  },
  iter: {
    name: "iter",
    exceptions: ["TypeError"],
    code: `// Python iteration over a value: lists/tuples as arrays, sets, dict KEYS, strings
// as code points (Python iterates Unicode code points; JS for-of iterates UTF-16
// units — the spread fixes astral-plane characters), generators/iterables generally.
export function __ctrans_iter(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  if (typeof v === "string") return Array.from(v);
  if (v instanceof Set) return [...v];
  if (v instanceof Map) return [...v.keys()];
  if (v !== null && typeof v === "object" && Symbol.iterator in v) return [...(v as Iterable<unknown>)];
  if (typeof v === "object" && v !== null) return Object.keys(v);
  throw new TypeError("object is not iterable");
}`,
  },
  add: {
    name: "add",
    requires: ["exceptions", "requireNumber", "requireString"],
    code: `// Python + on dynamically typed values: numbers add, strings concatenate,
// sequences concatenate, anything else raises TypeError (JS would silently coerce).


function __ctrans_requireArray(v: unknown, op: string): unknown[] {
  if (!Array.isArray(v)) {
    throw new TypeError(\`unsupported operand type(s) for \${op}\`);
  }
  return v;
}
export function __ctrans_add(a: unknown, b: unknown): __CTRANS_NUM__ | string | unknown[] {
  if (typeof a === "string" && typeof b === "string") return a + b;
  if (Array.isArray(a) && Array.isArray(b)) return [...a, ...b];
  if (typeof a === "string" || typeof b === "string") {
    throw new TypeError("can only concatenate str (not \\"other\\") to str");
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    return [...__ctrans_requireArray(a, "+"), ...__ctrans_requireArray(b, "+")];
  }
  return __ctrans_numeric(a, b, "+", (left, right) => left + right) as __CTRANS_NUM__;
}`,
  },
  sub: {
    name: "sub",
    requires: ["exceptions", "requireNumber"],
    code: `// Python - on dynamically typed values (numbers only; JS would coerce).

export function __ctrans_sub(a: unknown, b: unknown): __CTRANS_NUM__ {
  // The bigint branch is unreachable in the default mode (no bigint values exist
// there), so the narrowing assertion is runtime-true; bigint mode widens it.
  return __ctrans_numeric(a, b, "-", (left, right) => left - right) as __CTRANS_NUM__;
}`,
  },
  mul: {
    name: "mul",
    requires: ["exceptions", "requireNumber"],
    exceptions: ["TypeError"],
    code: `// Python *: string/array repetition in addition to numeric multiplication.
export function __ctrans_mul(a: unknown, b: unknown): __CTRANS_NUM__ | string | unknown[] {
  if (typeof a === "string" && __ctrans_isIntegral(b)) return a.repeat(Math.max(Number(b), 0));
  if (typeof b === "string" && __ctrans_isIntegral(a)) return b.repeat(Math.max(Number(a), 0));
  if (Array.isArray(a) && __ctrans_isIntegral(b)) {
    const out: unknown[] = [];
    for (let i = 0; i < Math.max(Math.trunc(Number(b)), 0); i += 1) out.push(...a);
    return out;
  }
  if (Array.isArray(b) && __ctrans_isIntegral(a)) {
    const out: unknown[] = [];
    for (let i = 0; i < Math.max(Math.trunc(Number(a)), 0); i += 1) out.push(...b);
    return out;
  }
  if (typeof a === "string" || typeof b === "string" || Array.isArray(a) || Array.isArray(b)) {
    throw new TypeError("can't multiply sequence by non-int of type");
  }
  return __ctrans_numeric(a, b, "*", (left, right) => left * right) as __CTRANS_NUM__;
}`,
  },
  div: {
    name: "div",
    requires: ["exceptions", "requireNumber"],
    exceptions: ["ZeroDivisionError", "TypeError"],
    code: `// Python true division: ZeroDivisionError instead of Infinity; ALWAYS a float,
// even for bigint operands (Python 10 / 2 -> 5.0; bigint / bigint would be integral).

export function __ctrans_div(a: unknown, b: unknown): number {
  const left = __ctrans_requireNumber(a, "/");
  const right = __ctrans_requireNumber(b, "/");
  if (right === 0) throw new ZeroDivisionError("division by zero");
  return left / right;
}`,
  },
  floorDiv: {
    name: "floorDiv",
    requires: ["exceptions", "requireNumber"],
    exceptions: ["ZeroDivisionError", "TypeError"],
    code: `// Python floor division: floors toward negative infinity (JS / truncates);
// bigint operands keep exact bigint semantics (D-006 exact mode).

export function __ctrans_floorDiv(a: unknown, b: unknown): __CTRANS_NUM__ {
  return __ctrans_floorQuotient(a, b, "//") as __CTRANS_NUM__;
}`,
  },
  mod: {
    name: "mod",
    requires: ["exceptions", "requireNumber"],
    exceptions: ["ZeroDivisionError", "TypeError"],
    code: `// Python modulo: result takes the divisor's sign (JS takes the dividend's).

export function __ctrans_mod(a: unknown, b: unknown): __CTRANS_NUM__ {
  return __ctrans_pythonMod(a, b, "%") as __CTRANS_NUM__;
}`,
  },
  pow: {
    name: "pow",
    requires: ["exceptions", "requireNumber"],
    exceptions: ["TypeError", "ZeroDivisionError"],
    code: `// Python **: bigint bases keep exact bigint results for non-negative exponents
// (D-006 exact mode); a negative exponent or float operand produces a float like
// Python (int ** negative-int -> float).

export function __ctrans_pow(a: unknown, b: unknown): __CTRANS_NUM__ {
  if (
    (typeof a === "bigint" || typeof b === "bigint") &&
    __ctrans_isIntegral(a) &&
    __ctrans_isIntegral(b)
  ) {
    const exponent = __ctrans_asBigInt(b);
    if (exponent >= 0n) {
      // Dead in the default mode (no bigint values exist) — the double assertion
      // is runtime-true there; bigint mode's target type admits bigint directly.
      return (__ctrans_asBigInt(a) ** exponent) as unknown as __CTRANS_NUM__;
    }
    const base = Number(__ctrans_asBigInt(a));
    const exp = Number(exponent);
    if (base === 0) throw new ZeroDivisionError("0.0 cannot be raised to a negative power");
    return base ** exp;
  }
  return __ctrans_requireNumber(a, "**") ** __ctrans_requireNumber(b, "**");
}`,
  },
  neg: {
    name: "neg",
    requires: ["exceptions", "requireNumber"],
    exceptions: ["TypeError"],
    code: `// Python unary - on dynamically typed values (bigint stays bigint).

export function __ctrans_neg(v: unknown): __CTRANS_NUM__ {
  if (typeof v === "bigint") return -v as unknown as __CTRANS_NUM__;
  return -__ctrans_requireNumber(v, "-");
}`,
  },
  pos: {
    name: "pos",
    requires: ["exceptions", "requireNumber"],
    exceptions: ["TypeError"],
    code: `// Python unary + on dynamically typed values (raises for non-numbers, unlike JS +).

export function __ctrans_pos(v: unknown): __CTRANS_NUM__ {
  if (typeof v === "bigint") return v as unknown as __CTRANS_NUM__;
  return +__ctrans_requireNumber(v, "+");
}`,
  },
  bitAnd: {
    name: "bitAnd",
    requires: ["exceptions", "requireNumber"],
    exceptions: ["TypeError"],
    code: `// Python bitwise & on integers. bigint operands keep exact arbitrary-precision
// semantics; Numbers go through int32 (D-006 precision warning in number mode).

export function __ctrans_bitAnd(a: unknown, b: unknown): __CTRANS_NUM__ {
  if (typeof a === "bigint" || typeof b === "bigint") {
    if (!__ctrans_isIntegral(a) || !__ctrans_isIntegral(b)) {
      throw new TypeError("unsupported operand type(s) for &");
    }
    return (__ctrans_asBigInt(a) & __ctrans_asBigInt(b)) as unknown as __CTRANS_NUM__;
  }
  return __ctrans_requireNumber(a, "&") & __ctrans_requireNumber(b, "&");
}`,
  },
  bitOr: {
    name: "bitOr",
    requires: ["exceptions", "requireNumber"],
    exceptions: ["TypeError"],
    code: `// Python bitwise | on integers (bigint-exact; Number path is int32, D-006).

export function __ctrans_bitOr(a: unknown, b: unknown): __CTRANS_NUM__ {
  if (typeof a === "bigint" || typeof b === "bigint") {
    if (!__ctrans_isIntegral(a) || !__ctrans_isIntegral(b)) {
      throw new TypeError("unsupported operand type(s) for |");
    }
    return (__ctrans_asBigInt(a) | __ctrans_asBigInt(b)) as unknown as __CTRANS_NUM__;
  }
  return __ctrans_requireNumber(a, "|") | __ctrans_requireNumber(b, "|");
}`,
  },
  bitXor: {
    name: "bitXor",
    requires: ["exceptions", "requireNumber"],
    exceptions: ["TypeError"],
    code: `// Python bitwise ^ on integers (bigint-exact; Number path is int32, D-006).

export function __ctrans_bitXor(a: unknown, b: unknown): __CTRANS_NUM__ {
  if (typeof a === "bigint" || typeof b === "bigint") {
    if (!__ctrans_isIntegral(a) || !__ctrans_isIntegral(b)) {
      throw new TypeError("unsupported operand type(s) for ^");
    }
    return (__ctrans_asBigInt(a) ^ __ctrans_asBigInt(b)) as unknown as __CTRANS_NUM__;
  }
  return __ctrans_requireNumber(a, "^") ^ __ctrans_requireNumber(b, "^");
}`,
  },
  lShift: {
    name: "lShift",
    requires: ["exceptions", "requireNumber"],
    exceptions: ["TypeError"],
    code: `// Python << on integers (bigint-exact; Number path is int32, D-006).

export function __ctrans_lShift(a: unknown, b: unknown): __CTRANS_NUM__ {
  if (typeof a === "bigint" || typeof b === "bigint") {
    if (!__ctrans_isIntegral(a) || !__ctrans_isIntegral(b)) {
      throw new TypeError("unsupported operand type(s) for <<");
    }
    return (__ctrans_asBigInt(a) << __ctrans_asBigInt(b)) as unknown as __CTRANS_NUM__;
  }
  return __ctrans_requireNumber(a, "<<") << __ctrans_requireNumber(b, "<<");
}`,
  },
  rShift: {
    name: "rShift",
    requires: ["exceptions", "requireNumber"],
    exceptions: ["TypeError"],
    code: `// Python >> on integers: arithmetic shift with sign preservation (bigint-exact;
// the Number path matches Python for non-negative int32 values, D-006).

export function __ctrans_rShift(a: unknown, b: unknown): __CTRANS_NUM__ {
  if (typeof a === "bigint" || typeof b === "bigint") {
    if (!__ctrans_isIntegral(a) || !__ctrans_isIntegral(b)) {
      throw new TypeError("unsupported operand type(s) for >>");
    }
    return (__ctrans_asBigInt(a) >> __ctrans_asBigInt(b)) as unknown as __CTRANS_NUM__;
  }
  return __ctrans_requireNumber(a, ">>") >> __ctrans_requireNumber(b, ">>");
}`,
  },
  slice: {
    name: "slice",
    requires: ["exceptions", "requireNumber"],
    exceptions: ["ValueError", "TypeError"],
    code: `// Python slicing with negative indices and steps for strings, arrays, tuples.
// The generic parameter preserves the element kind (string in → string out);
// bounds validate to Python's TypeError on non-integers.
export function __ctrans_slice<T>(value: T, start?: unknown, end?: unknown, step?: unknown): T {
  const asIndex = (v: unknown, which: string): number | undefined => {
    if (v === undefined || v === null) return undefined;
    if (typeof v === "bigint") return Number(v);
    if (typeof v !== "number" || !Number.isInteger(v)) {
      throw new TypeError(\`slice \${which} must be an integer\`);
    }
    return v;
  };
  const s0 = asIndex(start, "start");
  const e0 = asIndex(end, "stop");
  const st = asIndex(step, "step");
  // Strings slice by UNICODE CODE POINTS (Python semantics); UTF-16 units would
  // split astral characters and shift the bounds.
  const isString = typeof value === "string";
  const working: string | unknown[] = isString ? Array.from(value as string) : (value as unknown[]);
  const seq = working as unknown as string | unknown[];
  const len = seq.length;
  const fix = (i: number): number => (i < 0 ? Math.max(len + i, 0) : Math.min(i, len));
  const stepSize = st ?? 1;
  if (stepSize === 0) throw new ValueError("slice step cannot be zero");
  const gather = (out: unknown[]): T => (isString ? (out.join("") as T) : (out as T));
  if (stepSize > 0) {
    const s = fix(s0 ?? 0);
    const e = fix(e0 ?? len);
    if (stepSize === 1) {
      if (isString) return (seq as string[]).slice(s, e).join("") as T;
      return (seq as unknown[]).slice(s, e) as T;
    }
    const out: unknown[] = [];
    for (let i = s; i < e; i += stepSize) out.push(seq[i]);
    return gather(out);
  }
  const s = s0 === undefined ? len - 1 : Math.min(fix(s0), len - 1);
  const e = e0 === undefined ? -1 : fix(e0);
  const out: unknown[] = [];
  for (let i = s; i > e; i += stepSize) if (i >= 0 && i < len) out.push(seq[i]);
  return gather(out);
}`,
  },
  index: {
    name: "index",
    requires: ["exceptions", "requireNumber"],
    exceptions: ["IndexError", "KeyError", "TypeError"],
    code: `// Python indexing: negative indices on sequences (IndexError when out of range),
// string keys on mappings (KeyError when missing). Strings index by UNICODE CODE
// POINT (JS [] indexes UTF-16 units — astral divergence fixed here); bigint keys
// convert through Number (the documented D-006 boundary).
export function __ctrans_index(value: unknown, key: unknown): unknown {
  if (typeof value === "string" || Array.isArray(value)) {
    if (typeof key !== "number" && typeof key !== "bigint") {
      throw new TypeError(\`indices must be integers, not \${typeof key}\`);
    }
    const numericKey = Number(key);
    const length = typeof value === "string" ? Array.from(value).length : value.length;
    const normalized = numericKey < 0 ? length + numericKey : numericKey;
    if (normalized < 0 || normalized >= length) {
      throw new IndexError("index out of range");
    }
    return typeof value === "string" ? Array.from(value)[normalized] : value[normalized];
  }
  if (typeof value === "object" && value !== null) {
    if (typeof key !== "string") {
      throw new TypeError(\`dict keys are string-keyed after translation, not \${typeof key}\`);
    }
    if (!(key in value)) throw new KeyError(JSON.stringify(key));
    return (value as Record<string, unknown>)[key];
  }
  throw new TypeError("object is not subscriptable");
}`,
  },
  toInt: {
    name: "toInt",
    requires: ["exceptions", "requireNumber"],
    exceptions: ["ValueError", "TypeError"],
    code: `// Python int(): strict integer strings (no floats), truncation for numbers.
export function __ctrans_toInt(v: unknown): number {
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "number") return Math.trunc(v);
  if (typeof v === "string") {
    if (!/^\\s*[+-]?\\d+\\s*$/.test(v)) {
      throw new ValueError(\`invalid literal for int(): '\${v}'\`);
    }
    return Number.parseInt(v, 10);
  }
  throw new TypeError("int() argument must be a number or string");
}`,
  },
  toIntBig: {
    name: "toIntBig",
    requires: ["exceptions", "requireNumber"],
    exceptions: ["ValueError", "TypeError"],
    code: `// Python int() in the D-006 bigint mode: the result is a bigint. int(float)
// truncates the float's EXACT numeric value (matching Python's semantics).
export function __ctrans_toIntBig(v: unknown): bigint {
  if (typeof v === "boolean") return v ? 1n : 0n;
  if (typeof v === "bigint") return v;
  if (typeof v === "number") return BigInt(Math.trunc(v));
  if (typeof v === "string") {
    if (!/^\\s*[+-]?\\d+\\s*$/.test(v)) {
      throw new ValueError(\`invalid literal for int(): '\${v}'\`);
    }
    return BigInt(v.trim());
  }
  throw new TypeError("int() argument must be a number or string");
}`,
  },
  toFloat: {
    name: "toFloat",
    requires: ["exceptions", "requireNumber"],
    exceptions: ["ValueError", "TypeError"],
    code: `// Python float(): numeric strings and numbers.
export function __ctrans_toFloat(v: unknown): number {
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const parsed = Number(v.trim());
    if (Number.isNaN(parsed) && v.trim() !== "nan") {
      throw new ValueError(\`could not convert string to float: '\${v}'\`);
    }
    return parsed;
  }
  throw new TypeError("float() argument must be a number or string");
}`,
  },
  floatStr: {
    name: "floatStr",
    code: `// Python float repr (str == repr for floats since 3.1): shortest round-trip
// digits (shared with JS String/toExponential) reformatted to Python's layout —
// ".0" on integral values, "-0.0" for negative zero, "inf"/"nan", scientific
// notation exactly when abs(x) >= 1e16 or 0 < abs(x) < 1e-4, and a signed
// exponent with at least two digits.
export function __ctrans_floatStr(v: number): string {
  if (Number.isNaN(v)) return "nan";
  if (v === Infinity) return "inf";
  if (v === -Infinity) return "-inf";
  if (v === 0) return Object.is(v, -0) ? "-0.0" : "0.0";
  if (Number.isInteger(v) && Math.abs(v) < 1e16) return v.toString() + ".0";
  const exponential = Math.abs(v).toExponential();
  const match = /^(\\d)(?:\\.(\\d+))?e([+-]\\d+)$/.exec(exponential);
  if (match === null) return v.toString();
  const digits = match[1]! + (match[2] ?? "");
  const exponent = Number(match[3]);
  const sign = v < 0 ? "-" : "";
  const formatExponent = (value: number): string =>
    value < 0
      ? \`e-\${String(-value).padStart(2, "0")}\`
      : \`e+\${String(value).padStart(2, "0")}\`;
  if (exponent >= 16 || exponent <= -5) {
    const mantissa = digits.length === 1 ? digits : \`\${digits[0]}.\${digits.slice(1)}\`;
    return \`\${sign}\${mantissa}\${formatExponent(exponent)}\`;
  }
  if (exponent >= 0) {
    const head = digits.slice(0, exponent + 1).padEnd(exponent + 1, "0");
    const tail = digits.slice(exponent + 1);
    return tail.length > 0 ? \`\${sign}\${head}.\${tail}\` : \`\${sign}\${head}.0\`;
  }
  return \`\${sign}0.\${"0".repeat(-exponent - 1)}\${digits}\`;
}`,
  },
  str: {
    name: "str",
    requires: ["floatStr"],
    code: `// Python str(): text conversion with Python spellings for scalars and sequences.
// Non-integral numbers use the Python float layout (exponent thresholds differ
// from JS); INTEGRAL numbers print int-like — a float-typed value such as 100.0
// prints "100" here (the int/float distinction is lost at runtime in number
// mode; statically float-typed sites emit __ctrans_floatStr directly, and in
// bigint mode Python ints are bigint so dynamic sites stay int-exact).
export function __ctrans_str(v: unknown): string {
  if (v === null || v === undefined) return "None";
  if (typeof v === "boolean") return v ? "True" : "False";
  if (typeof v === "string") return v;
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "number") {
    return Number.isInteger(v) ? v.toString() : __ctrans_floatStr(v);
  }
  if (Array.isArray(v)) return "[" + v.map(__ctrans_repr).join(", ") + "]";
  if (v instanceof Set) return v.size === 0 ? "set()" : "{" + [...v].map(__ctrans_repr).join(", ") + "}";
  if (typeof v === "object") {
    return "{" + Object.entries(v).map(([key, entry]) => __ctrans_repr(key) + ": " + __ctrans_repr(entry)).join(", ") + "}";
  }
  return String(v);
}

function __ctrans_repr(v: unknown): string {
  if (typeof v === "string") return "'" + v.replaceAll("\\\\", "\\\\\\\\").replaceAll("'", "\\\\'") + "'";
  return __ctrans_str(v);
}`,
  },
  sum: {
    name: "sum",
    requires: ["exceptions", "requireNumber"],
    exceptions: ["TypeError"],
    code: `// Python sum(): numeric fold with 0 start (start/keyword forms unsupported in M4).
// bigint values fold exactly (D-006 exact mode); a float value switches the fold
// to Number like Python int+float -> float.
export function __ctrans_sum(values: unknown): __CTRANS_NUM__ {
  if (typeof values === "string") throw new TypeError("sum() can't sum strings");
  if (!Array.isArray(values) && !(values instanceof Set)) {
    throw new TypeError("sum() argument must be an iterable of numbers");
  }
  let total: number | bigint = 0;
  for (const value of values) {
    if (typeof value === "bigint") {
      if (total === 0) total = 0n;
      total = __ctrans_numeric(total, value, "+", (left, right) => left + right);
      continue;
    }
    if (typeof value !== "number") throw new TypeError("sum() supports numbers only");
    total = __ctrans_numeric(total, value, "+", (left, right) => left + right);
  }
  return total as __CTRANS_NUM__;
}`,
  },
  print: {
    name: "print",
    requires: ["str"],
    code: `// Python print(): space-separated str() arguments.
export function __ctrans_print(...args: unknown[]): void {
  console.log(args.map((arg) => __ctrans_str(arg)).join(" "));
}`,
  },
  range: {
    name: "range",
    requires: ["exceptions", "str"],
    exceptions: ["ValueError", "TypeError"],
    code: `// Python range(): materialized for non-C-style loops. Integer-validated;
// bigint arguments convert through Number (materialization is memory-bound, the
// documented D-006 boundary; rangeBig is the exact bigint-element variant).
export function __ctrans_range(start: unknown, end?: unknown, step?: unknown): number[] {
  const requireInt = (v: unknown, arg: string): number => {
    if (typeof v === "bigint") return Number(v);
    if (typeof v !== "number" || !Number.isInteger(v)) {
      throw new TypeError(\`range() integer \${arg} argument expected, got \${__ctrans_str(v)}\`);
    }
    return v;
  };
  const from = end === undefined ? 0 : requireInt(start, "start");
  const to = requireInt(end === undefined ? start : end, "stop");
  const by = step === undefined ? 1 : requireInt(step, "step");
  if (by === 0) throw new ValueError("range() arg 3 must not be zero");
  const out: number[] = [];
  if (by > 0) for (let i = from; i < to; i += by) out.push(i);
  else for (let i = from; i > to; i += by) out.push(i);
  return out;
}`,
  },
  rangeBig: {
    name: "rangeBig",
    requires: ["exceptions", "str"],
    exceptions: ["ValueError", "TypeError"],
    code: `// Python range() in the D-006 bigint mode: elements are bigints so downstream
// integer arithmetic stays exact.
export function __ctrans_rangeBig(start: unknown, end?: unknown, step?: unknown): bigint[] {
  const requireInt = (v: unknown, arg: string): bigint => {
    if (typeof v === "bigint") return v;
    if (typeof v === "number" && Number.isInteger(v)) return BigInt(v);
    throw new TypeError(\`range() integer \${arg} argument expected, got \${__ctrans_str(v)}\`);
  };
  const from = end === undefined ? 0n : requireInt(start, "start");
  const to = requireInt(end === undefined ? start : end, "stop");
  const by = step === undefined ? 1n : requireInt(step, "step");
  if (by === 0n) throw new ValueError("range() arg 3 must not be zero");
  const out: bigint[] = [];
  if (by > 0n) for (let i = from; i < to; i += by) out.push(i);
  else for (let i = from; i > to; i += by) out.push(i);
  return out;
}`,
  },
  getattr: {
    name: "getattr",
    requires: ["str"],
    exceptions: ["AttributeError", "TypeError"],
    code: `// Python attribute access on a dynamically typed receiver.
export function __ctrans_getattr(obj: unknown, name: string): unknown {
  if (obj === null || obj === undefined) {
    throw new AttributeError(\`'\${__ctrans_str(obj)}' object has no attribute '\${name}'\`);
  }
  if (typeof obj !== "object" && typeof obj !== "function") {
    throw new AttributeError(\`'\${__ctrans_str(obj)}' object has no attribute '\${name}'\`);
  }
  if (name in obj) return (obj as Record<string, unknown>)[name];
  throw new AttributeError(\`object has no attribute '\${name}'\`);
}`,
  },
  setattr: {
    name: "setattr",
    requires: ["str"],
    exceptions: ["AttributeError", "TypeError"],
    code: `// Python attribute assignment on a dynamically typed receiver.
export function __ctrans_setattr(obj: unknown, name: string, value: unknown): void {
  if (obj === null || obj === undefined) {
    throw new AttributeError(\`'\${__ctrans_str(obj)}' object has no attribute '\${name}'\`);
  }
  if (typeof obj !== "object" && typeof obj !== "function") {
    throw new AttributeError(\`'\${__ctrans_str(obj)}' object has no attribute '\${name}'\`);
  }
  (obj as Record<string, unknown>)[name] = value;
}`,
  },
  setIndex: {
    name: "setIndex",
    requires: ["exceptions", "requireNumber"],
    exceptions: ["IndexError", "TypeError"],
    code: `// Python subscript assignment: sequence index within range, mapping key store.
// bigint keys convert through Number (the documented D-006 boundary).
export function __ctrans_setIndex(value: unknown, key: unknown, item: unknown): void {
  if (Array.isArray(value)) {
    if (typeof key !== "number" && typeof key !== "bigint") {
      throw new TypeError(\`list indices must be integers, not \${typeof key}\`);
    }
    const normalized = Number(key) < 0 ? value.length + Number(key) : Number(key);
    if (normalized < 0 || normalized >= value.length) throw new IndexError("index out of range");
    value[normalized] = item;
    return;
  }
  if (typeof value === "object" && value !== null) {
    if (typeof key !== "string") {
      throw new TypeError(\`dict keys are string-keyed after translation, not \${typeof key}\`);
    }
    (value as Record<string, unknown>)[key] = item;
    return;
  }
  if (typeof value === "string") {
    throw new TypeError("'str' object does not support item assignment");
  }
  throw new TypeError("object does not support item assignment");
}`,
  },
  call: {
    name: "call",
    exceptions: ["TypeError"],
    code: `// Calling a value that is only statically \`unknown\` (transferred Python callee).
// Classes are constructed (Reflect.construct); plain functions are called.
export function __ctrans_call(fn: unknown, ...args: unknown[]): unknown {
  if (typeof fn !== "function") {
    throw new TypeError(\`'\${typeof fn}' object is not callable\`);
  }
  const isClass = /^class[\\s{]/.test(Function.prototype.toString.call(fn));
  if (isClass) return Reflect.construct(fn as never, args);
  return (fn as (...args: unknown[]) => unknown)(...args);
}`,
  },
  raiseForStatus: {
    name: "raiseForStatus",
    requires: ["exceptions"],
    exceptions: ["RuntimeError"],
    code: `// Python response.raise_for_status(): raises for 4xx/5xx statuses.
export function __ctrans_raiseForStatus(response: Response): void {
  if (response.status >= 400) {
    throw new RuntimeError(\`HTTP error \${String(response.status)} for \${response.url}\`);
  }
}`,
  },
  // ---- registry v1 builtin helpers (D-011): Python semantics, never name swaps ----
  sorted: {
    name: "sorted",
    requires: ["iter", "eq", "str", "exceptions"],
    exceptions: ["TypeError"],
    code: `// Python sorted(): stable ascending sort over any iterable with Python's
// comparison semantics (numeric pairs numeric, strings by code point, mixed
// non-comparable types raise TypeError like Python).
export function __ctrans_sorted(values: unknown): unknown[] {
  const items = [...__ctrans_iter(values)];
  const compare = (a: unknown, b: unknown): number => {
    if (typeof a === "string" && typeof b === "string") {
      const left = Array.from(a);
      const right = Array.from(b);
      const shared = Math.min(left.length, right.length);
      for (let i = 0; i < shared; i += 1) {
        const l = left[i]!.codePointAt(0)!;
        const r = right[i]!.codePointAt(0)!;
        if (l !== r) return l < r ? -1 : 1;
      }
      return left.length - right.length;
    }
    if (__ctrans_isNumeric(a) && __ctrans_isNumeric(b)) {
      const left = Number(a);
      const right = Number(b);
      if (Number.isNaN(left) || Number.isNaN(right)) {
        throw new TypeError(\`'<' not supported between NaN\`);
      }
      return left < right ? -1 : left > right ? 1 : 0;
    }
    throw new TypeError(\`'<' not supported between instances of '\${__ctrans_str(a)}' and '\${__ctrans_str(b)}'\`);
  };
  // Array#sort is stable (ES2019), matching Python's guarantee.
  return items.sort(compare);
}

function __ctrans_isNumeric(v: unknown): boolean {
  return typeof v === "number" || typeof v === "bigint" || typeof v === "boolean";
}`,
  },
  list: {
    name: "list",
    requires: ["iter"],
    exceptions: ["TypeError"],
    code: `// Python list(): fresh array from any iterable; list() is a new empty array.
export function __ctrans_list(values?: unknown): unknown[] {
  if (values === undefined) return [];
  return [...__ctrans_iter(values)];
}`,
  },
  min: {
    name: "min",
    requires: ["iter", "compare", "str", "exceptions"],
    exceptions: ["ValueError", "TypeError"],
    code: `// Python min(iterable): minimum element with Python comparison semantics.
export function __ctrans_min(values: unknown): unknown {
  const items = [...__ctrans_iter(values)];
  if (items.length === 0) throw new ValueError("min() arg is an empty sequence");
  let best = items[0]!;
  for (const item of items.slice(1)) {
    if (__ctrans_compare("<", item, best)) best = item;
  }
  return best;
}`,
  },
  max: {
    name: "max",
    requires: ["iter", "compare", "str", "exceptions"],
    exceptions: ["ValueError", "TypeError"],
    code: `// Python max(iterable): maximum element with Python comparison semantics.
export function __ctrans_max(values: unknown): unknown {
  const items = [...__ctrans_iter(values)];
  if (items.length === 0) throw new ValueError("max() arg is an empty sequence");
  let best = items[0]!;
  for (const item of items.slice(1)) {
    if (__ctrans_compare(">", item, best)) best = item;
  }
  return best;
}`,
  },
  reversed: {
    name: "reversed",
    requires: ["iter"],
    exceptions: ["TypeError"],
    code: `// Python reversed(): lazy iterator in Python; materialized array here (the same
// documented divergence as __ctrans_range).
export function __ctrans_reversed(values: unknown): unknown[] {
  return [...__ctrans_iter(values)].reverse();
}`,
  },
  zip: {
    name: "zip",
    requires: ["iter"],
    exceptions: ["TypeError"],
    code: `// Python zip(*iterables): tuples truncate to the shortest input; materialized
// as [a, b] arrays (the tuple->array mapping).
export function __ctrans_zip(...sources: unknown[]): unknown[][] {
  if (sources.length === 0) return [];
  const lists = sources.map((source) => [...__ctrans_iter(source)]);
  const shortest = Math.min(...lists.map((list) => list.length));
  const out: unknown[][] = [];
  for (let i = 0; i < shortest; i += 1) out.push(lists.map((list) => list[i]!));
  return out;
}`,
  },
  next: {
    name: "next",
    requires: ["exceptions"],
    exceptions: ["TypeError", "PythonException"],
    code: `// Python next(it): the iterator protocol's next value; raises the
// StopIteration-equivalent (the translated StopIteration class when present,
// otherwise a PythonException) when exhausted.
export function __ctrans_next(iterator: unknown): unknown {
  if (
    iterator !== null &&
    typeof iterator === "object" &&
    typeof (iterator as Iterator<unknown>).next === "function"
  ) {
    const step = (iterator as Iterator<unknown>).next();
    if (step.done) {
      const stop = (globalThis as Record<string, unknown>)["__ctrans_StopIteration"];
      if (typeof stop === "function") throw new (stop as new () => Error)();
      throw new PythonException("StopIteration");
    }
    return step.value;
  }
  throw new TypeError("object is not an iterator");
}`,
  },
  abs: {
    name: "abs",
    requires: ["exceptions", "requireNumber"],
    exceptions: ["TypeError"],
    code: `// Python abs(): magnitude for numbers, exact for bigint.
export function __ctrans_abs(v: unknown): number | bigint {
  if (typeof v === "bigint") return v < 0n ? -v : v;
  return Math.abs(__ctrans_requireNumber(v, "abs()"));
}`,
  },
  enumerate: {
    name: "enumerate",
    requires: ["iter"],
    exceptions: ["TypeError"],
    code: `// Python enumerate(iterable): [index, value] pairs (start= kwarg unsupported).
export function __ctrans_enumerate(values: unknown): unknown[][] {
  return [...__ctrans_iter(values)].map((item, index) => [index, item]);
}`,
  },
  listIndex: {
    name: "listIndex",
    requires: ["eq", "exceptions", "str"],
    exceptions: ["ValueError"],
    code: `// Python list.index(v): first index where item == v (elementwise); ValueError
// when absent (JS indexOf uses === and returns -1).
export function __ctrans_listIndex(items: unknown[], value: unknown): number {
  const index = items.findIndex((item) => __ctrans_eq(item, value));
  if (index < 0) throw new ValueError(\`\${__ctrans_str(value)} is not in list\`);
  return index;
}`,
  },
  listCount: {
    name: "listCount",
    requires: ["eq"],
    code: `// Python list.count(v): == -based elementwise count.
export function __ctrans_listCount(items: unknown[], value: unknown): number {
  return items.filter((item) => __ctrans_eq(item, value)).length;
}`,
  },
  listRemove: {
    name: "listRemove",
    requires: ["eq", "exceptions", "str"],
    exceptions: ["ValueError"],
    code: `// Python list.remove(v): removes the first == match; ValueError when absent.
export function __ctrans_listRemove(items: unknown[], value: unknown): void {
  const index = items.findIndex((item) => __ctrans_eq(item, value));
  if (index < 0) throw new ValueError(\`\${__ctrans_str(value)} is not in list\`);
  items.splice(index, 1);
}`,
  },
  dictGet: {
    name: "dictGet",
    code: `// Python dict.get(k): the value or None (undefined after the None collapse) for
// a missing key; JS property access returns undefined for both.
export function __ctrans_dictGet(mapping: Record<string, unknown>, key: string): unknown {
  return mapping[key];
}`,
  },
  dictPop: {
    name: "dictPop",
    requires: ["exceptions", "str"],
    exceptions: ["KeyError"],
    code: `// Python dict.pop(k): removes and returns the value; KeyError when absent.
export function __ctrans_dictPop(mapping: Record<string, unknown>, key: string): unknown {
  if (!(key in mapping)) throw new KeyError(JSON.stringify(key));
  const value = mapping[key];
  delete mapping[key];
  return value;
}`,
  },
  strSplit: {
    name: "strSplit",
    code: `// Python str.split(): no-separator form splits on whitespace RUNS and drops
// empties; the separator form maps to JS split.
export function __ctrans_strSplit(text: string, separator?: string): string[] {
  if (separator === undefined) {
    return text.length === 0 ? [] : text.split(/\\s+/).filter((part) => part.length > 0);
  }
  return text.split(separator);
}`,
  },
  strJoin: {
    name: "strJoin",
    requires: ["iter", "exceptions"],
    exceptions: ["TypeError"],
    code: `// Python sep.join(iterable): any iterable of strings; TypeError on non-strings
// (JS would coerce).
export function __ctrans_strJoin(separator: string, values: unknown): string {
  const items = [...__ctrans_iter(values)];
  for (const item of items) {
    if (typeof item !== "string") {
      throw new TypeError("sequence item: expected str instance");
    }
  }
  return items.join(separator);
}`,
  },
  strCapitalize: {
    name: "strCapitalize",
    code: `// Python str.capitalize(): first code point uppercased, the rest lowercased.
export function __ctrans_strCapitalize(text: string): string {
  if (text.length === 0) return text;
  const points = Array.from(text);
  return points[0]!.toUpperCase() + points.slice(1).join("").toLowerCase();
}`,
  },
  setRemove: {
    name: "setRemove",
    requires: ["exceptions", "str"],
    exceptions: ["KeyError"],
    code: `// Python set.remove(v): KeyError when absent (JS delete silently ignores).
export function __ctrans_setRemove(set: Set<unknown>, value: unknown): void {
  if (!set.has(value)) throw new KeyError(JSON.stringify(__ctrans_str(value)));
  set.delete(value);
}`,
  },

  callMethod: {
    name: "callMethod",
    requires: [
      "getattr",
      "eq",
      "exceptions",
      "listIndex",
      "listCount",
      "listRemove",
      "dictPop",
      "strSplit",
      "strJoin",
      "strCapitalize",
      "setRemove",
    ],
    exceptions: ["TypeError", "ValueError", "KeyError"],
    code: `// Method call on a dynamically typed receiver: the registry v1 dispatch surface
// (D-011). Python container/string/set methods on builtin JS receivers dispatch
// through the SAME semantics the statically-typed path emits — one authority, no
// drift. Unlisted (receiver, name) pairs keep Python's AttributeError behavior.
export function __ctrans_callMethod(
  receiver: unknown,
  name: string,
  ...args: unknown[]
): unknown {
  const isString = typeof receiver === "string";
  const isArray = Array.isArray(receiver);
  const isSet = receiver instanceof Set;
  const isObject =
    receiver !== null && typeof receiver === "object" && !isArray && !isSet;
  switch (name) {
    case "append":
      if (isArray) return receiver.push(...args);
      break;
    case "extend":
      if (isArray) return receiver.push(...__ctrans_iter(args[0]));
      break;
    case "insert": {
      if (isArray) {
        receiver.splice(Number(args[0]), 0, args[1]);
        return undefined;
      }
      break;
    }
    case "copy":
      if (isArray) return receiver.slice();
      break;
    case "index":
      if (isArray) return __ctrans_listIndex(receiver, args[0]);
      break;
    case "count":
      if (isArray || isString) return __ctrans_listCount(isArray ? receiver : Array.from(receiver), args[0]);
      break;
    case "remove":
      if (isArray) return __ctrans_listRemove(receiver, args[0]);
      if (isSet) return __ctrans_setRemove(receiver, args[0]);
      break;
    case "clear":
      if (isArray) {
        receiver.length = 0;
        return undefined;
      }
      if (isSet) return receiver.clear();
      break;
    case "reverse":
      if (isArray) return receiver.reverse();
      break;
    case "get":
      if (isObject && typeof args[0] === "string") return receiver[args[0]];
      break;
    case "keys":
      if (isObject) return Object.keys(receiver);
      if (isSet) return receiver.keys();
      break;
    case "values":
      if (isObject) return Object.values(receiver);
      if (isSet) return receiver.values();
      break;
    case "items":
      if (isObject) return Object.entries(receiver);
      break;
    case "pop":
      if (isArray) return receiver.pop();
      if (isObject && typeof args[0] === "string") return __ctrans_dictPop(receiver, args[0]);
      break;
    case "upper":
      if (isString) return receiver.toUpperCase();
      break;
    case "lower":
      if (isString) return receiver.toLowerCase();
      break;
    case "strip":
      if (isString) return receiver.trim();
      break;
    case "lstrip":
      if (isString) return receiver.trimStart();
      break;
    case "rstrip":
      if (isString) return receiver.trimEnd();
      break;
    case "startswith":
      if (isString) return receiver.startsWith(args[0] as string);
      break;
    case "endswith":
      if (isString) return receiver.endsWith(args[0] as string);
      break;
    case "replace":
      if (isString) return receiver.replaceAll(args[0] as string, args[1] as string);
      break;
    case "split":
      if (isString) return __ctrans_strSplit(receiver, args[0] as string | undefined);
      break;
    case "join":
      if (isString) return __ctrans_strJoin(receiver, args[0]);
      break;
    case "find":
      if (isString) return receiver.indexOf(args[0] as string);
      break;
    case "capitalize":
      if (isString) return __ctrans_strCapitalize(receiver);
      break;
    case "add":
      if (isSet) return receiver.add(args[0]);
      break;
    case "discard":
      if (isSet) return receiver.delete(args[0]);
      break;
  }
  const method = __ctrans_getattr(receiver, name);
  if (typeof method !== "function") {
    throw new TypeError(\`'\${name}' is not a function\`);
  }
  return (method as (...args: unknown[]) => unknown).apply(receiver, args);
}`,
  },
};

// ---- registry v1 generated modules (D-011) -------------------------------------
// Emitted into the output project ONLY when a unit imports the mapped module
// (same only-when-referenced policy as the runtime helpers). Python semantics per
// the registry notes; divergences documented in docs/dependency-mapping.md.
export const REGISTRY_MODULE_SOURCES: Readonly<Record<string, string>> = {
  math: `/* Generated by Code Translator - Python math semantics (D-007: zero runtime dependencies). */
const pi = Math.PI;
const e = Math.E;
const tau = Math.PI * 2;
const inf = Infinity;
const nan = NaN;

export function floor(x: number): number {
  return Math.floor(x);
}
export function ceil(x: number): number {
  return Math.ceil(x);
}
export function trunc(x: number): number {
  return Math.trunc(x);
}
export function fabs(x: number): number {
  return Math.abs(x);
}
export function sqrt(x: number): number {
  if (x < 0) throw new ValueError("math domain error");
  return Math.sqrt(x);
}
export function pow(x: number, y: number): number {
  const result = Math.pow(x, y);
  if (Number.isNaN(result) && !(Number.isNaN(x) || Number.isNaN(y))) {
    throw new ValueError("math domain error");
  }
  return result;
}
export function exp(x: number): number {
  return Math.exp(x);
}
export function log(x: number, base?: number): number {
  if (x <= 0) throw new ValueError("math domain error");
  return base === undefined ? Math.log(x) : Math.log(x) / Math.log(base);
}
export function log2(x: number): number {
  if (x <= 0) throw new ValueError("math domain error");
  return Math.log2(x);
}
export function log10(x: number): number {
  if (x <= 0) throw new ValueError("math domain error");
  return Math.log10(x);
}
export function sin(x: number): number {
  return Math.sin(x);
}
export function cos(x: number): number {
  return Math.cos(x);
}
export function tan(x: number): number {
  return Math.tan(x);
}
export function atan2(y: number, x: number): number {
  return Math.atan2(y, x);
}
export function hypot(...coordinates: number[]): number {
  return Math.hypot(...coordinates);
}
export function degrees(x: number): number {
  return (x * 180) / Math.PI;
}
export function radians(x: number): number {
  return (x * Math.PI) / 180;
}
export function copysign(x: number, y: number): number {
  return y < 0 || Object.is(y, -0) ? -Math.abs(x) : Math.abs(x);
}
export function isclose(a: number, b: number, relTol = 1e-9, absTol = 0.0): boolean {
  if (Number.isNaN(a) || Number.isNaN(b)) return false;
  if (a === b) return true;
  if (Number.isFinite(a) !== Number.isFinite(b)) return false;
  return Math.abs(a - b) <= Math.max(relTol * Math.max(Math.abs(a), Math.abs(b)), absTol);
}
export function isfinite(x: number): boolean {
  return Number.isFinite(x);
}
export function isinf(x: number): boolean {
  return Number.isInfinite(x);
}
export function isnan(x: number): boolean {
  return Number.isNaN(x);
}
export { pi, e, tau, inf, nan };
`,
  json: `/* Generated by Code Translator - Python json semantics (D-007: zero runtime dependencies). */
class ValueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValueError";
  }
}
export interface JsonValue {
  [key: string]: unknown;
}

// Python json.dumps: JSON.stringify with Python's default separators (", ", ": ")
// and allow_nan=True. sort_keys/indent supported; ensure_ascii is Python's
// default True — non-ASCII characters are escaped like Python.
export function dumps(obj: unknown, sortKeys = false, indent?: number): string {
  const seen: unknown[] = [];
  const replacer = (key: string, value: unknown): unknown => {
    if (typeof value === "bigint") throw new TypeError("Object of type int is not JSON serializable in number mode");
    if (typeof value === "object" && value !== null) {
      if (seen.includes(value)) throw new ValueError("Circular reference detected");
      seen.push(value);
    }
    if (typeof value === "number" && !Number.isFinite(value)) return null; // allow_nan -> Infinity is invalid JSON; Python emits Infinity literal — documented divergence
    return value;
  };
  const raw = JSON.stringify(obj, replacer, indent === undefined ? 0 : indent);
  if (indent === undefined) {
    // Python default separators: ", " and ": ".
    const withSorted = sortKeys === true ? sortKeysDeep(JSON.parse(raw)) : JSON.parse(raw);
    return escapeNonAscii(JSON.stringify(withSorted).replaceAll(",", ", ").replaceAll(":", ": "));
  }
  const withSorted2 = sortKeys === true ? sortKeysDeep(JSON.parse(raw)) : JSON.parse(raw);
  return escapeNonAscii(JSON.stringify(withSorted2, null, indent));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

function escapeNonAscii(text: string): string {
  return text.replace(/[\u0080-\uFFFF]/g, (ch) =>
    "\\\\u" + ch.codePointAt(0)!.toString(16).padStart(4, "0"),
  );
}

// Python json.loads: JSON.parse (Python accepts strict JSON the same way; the
// NaN/Infinity literal extensions parse like Python's defaults).
export function loads(text: string): unknown {
  return JSON.parse(text);
}
`,
  sys: `/* Generated by Code Translator - Python sys surface (D-007: zero runtime dependencies). */
import process from "node:process";

// Python sys.argv: [script, ...args]. The translated entry's argv[0] is the
// Node binary — Python semantics keep the script path first, so argv is
// [script, ...process.argv.slice(2)]. The script name is the entry module
// (documented: exact path differs from CPython's).
export const argv: string[] = [process.argv[1] ?? "", ...process.argv.slice(2)];
export const platform: string = process.platform;
export const maxsize: number = Number.MAX_SAFE_INTEGER;

export function exit(code = 0): never {
  process.exit(code);
}
`,
  random: `/* Generated by Code Translator - Python random surface (D-007: zero runtime dependencies). */
// Documented divergence: JS has no Mersenne Twister, so seed() does NOT
// reproduce CPython's value-for-value sequence — the distribution contract holds.
class ValueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValueError";
  }
}
class IndexError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IndexError";
  }
}

let state = 0;

export function seed(value = Date.now()): void {
  state = Math.abs(Math.trunc(value)) % 2147483647;
  if (state === 0) state = 1;
  // Warm up.
  for (let i = 0; i < 3; i += 1) __ctrans_randomNext();
}

function __ctrans_randomNext(): number {
  // Lehmer RNG — deterministic, distribution-uniform on (0, 1).
  state = (state * 48271) % 2147483647;
  return (state - 1) / 2147483646;
}

export function random(): number {
  return __ctrans_randomNext();
}

export function randint(low: number, high: number): number {
  return low + Math.floor(__ctrans_randomNext() * (high - low + 1));
}

export function choice<T>(sequence: readonly T[]): T {
  if (sequence.length === 0) throw new IndexError("Cannot choose from an empty sequence");
  return sequence[Math.floor(__ctrans_randomNext() * sequence.length)]!;
}

export function shuffle<T>(sequence: T[]): void {
  for (let i = sequence.length - 1; i > 0; i -= 1) {
    const j = Math.floor(__ctrans_randomNext() * (i + 1));
    const tmp = sequence[i]!;
    sequence[i] = sequence[j]!;
    sequence[j] = tmp;
  }
}

export { IndexError };

`,
};

// Exception classes the runtime module can export (the generated Python-exception
// hierarchy). Raise/handler lowering records other names as module-local user classes.
export const RUNTIME_EXCEPTION_CLASSES: readonly string[] = [
  "PythonException",
  "ValueError",
  "TypeError",
  "KeyError",
  "IndexError",
  "AttributeError",
  "ZeroDivisionError",
  "RuntimeError",
];

// Transitive helper + exception closure for a set of requested helper names. Helper
// names are expanded through `requires`; the referenced exception classes are listed
// specifically (the emitted hierarchy block defines all classes, but only referenced
// names are imported).
export function helperClosure(requested: readonly string[]): {
  readonly helpers: readonly string[];
  readonly exceptions: readonly string[];
} {
  const helpers = new Set<string>();
  const exceptions = new Set<string>();
  const queue = [...requested];
  while (queue.length > 0) {
    const name = queue.pop()!;
    if (helpers.has(name)) continue;
    const helper = RUNTIME_HELPERS[name];
    if (helper === undefined) continue;
    helpers.add(name);
    for (const required of helper.requires ?? []) queue.push(required);
    for (const className of helper.exceptions ?? []) exceptions.add(className);
  }
  return { helpers: [...helpers].sort(), exceptions: [...exceptions].sort() };
}
