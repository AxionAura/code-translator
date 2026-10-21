// ConstructMatrix data (docs/testing.md §3): every M4-supported construct from
// language-support.md §2 as minimal source → expected-target pairs with the expected
// decision class. The test runner asserts BOTH the emitted code (normalized) and the
// ledger's decision classification — coverage without honest classification fails.
export interface MatrixEntry {
  readonly id: string;
  readonly source: string;
  readonly expectedContains: readonly string[];
  readonly decision: "deterministic" | "semantic" | "ambiguous" | "unsupported";
  // TS-only entries assert target type text; the JS direction skips them.
  readonly tsOnly?: boolean;
  readonly rule?: string;
}

export const MATRIX: readonly MatrixEntry[] = [
  // ---- literals / names ----
  {
    id: "int-literal",
    source: "x = 42\n",
    expectedContains: ["let x = 42"],
    decision: "deterministic",
  },
  {
    id: "float-literal",
    source: "x = 1.5\n",
    expectedContains: ["let x = 1.5"],
    decision: "deterministic",
  },
  {
    id: "str-literal",
    source: "s = 'hi'\n",
    expectedContains: ['let s = "hi"'],
    decision: "deterministic",
  },
  {
    id: "bool-literal",
    source: "b = True\n",
    expectedContains: ["let b = true"],
    decision: "deterministic",
  },
  {
    id: "none-literal",
    source: "x = None\n",
    expectedContains: ["let x = undefined"],
    decision: "semantic",
    rule: "py.None→js.undefined",
  },
  {
    id: "negative-int",
    source: "x = -5\n",
    expectedContains: ["let x = -5"],
    decision: "deterministic",
  },

  // ---- operators ----
  {
    id: "add-numbers",
    source: "def f(a: int, b: int):\n    return a + b\n",
    expectedContains: ["a + b"],
    decision: "deterministic",
  },
  {
    id: "sub",
    source: "def f(a: int, b: int):\n    return a - b\n",
    expectedContains: ["a - b"],
    decision: "deterministic",
  },
  {
    id: "pow",
    source: "def f(a: int, b: int):\n    return a ** b\n",
    expectedContains: ["a ** b"],
    decision: "deterministic",
  },
  {
    id: "true-division",
    source: "def f(a: int, b: int):\n    return a / b\n",
    expectedContains: ["__ctrans_div(a, b)"],
    decision: "semantic",
    rule: "py.div→__ctrans.div",
  },
  {
    id: "floor-division",
    source: "def f(a: int, b: int):\n    return a // b\n",
    expectedContains: ["__ctrans_floorDiv(a, b)"],
    decision: "semantic",
    rule: "py.floordiv→__ctrans.floorDiv",
  },
  {
    id: "modulo",
    source: "def f(a: int, b: int):\n    return a % b\n",
    expectedContains: ["__ctrans_mod(a, b)"],
    decision: "semantic",
    rule: "py.mod→__ctrans.mod",
  },
  {
    id: "string-multiply",
    source: "def f(s: str, n: int):\n    return s * n\n",
    expectedContains: ["return __ctrans_mul(s, n)"],
    decision: "semantic",
    rule: "py.mul→__ctrans.mul",
  },

  // ---- comparisons / boolops ----
  {
    id: "equality",
    source: "def f(a, b):\n    return a == b\n",
    expectedContains: ["__ctrans_eq(a, b)"],
    decision: "semantic",
    rule: "py.eq→__ctrans.eq",
  },
  {
    id: "is-none",
    source: "def f(x):\n    return x is None\n",
    expectedContains: ["x === undefined"],
    decision: "deterministic",
    rule: "py.is→js.===",
  },
  {
    id: "in-operator",
    source: "def f(x, xs):\n    return x in xs\n",
    expectedContains: ["__ctrans_contains(xs, x)"],
    decision: "semantic",
    rule: "py.in→__ctrans.contains",
  },

  // ---- truthiness ----
  {
    id: "if-truthy",
    source: "def f(v):\n    if v:\n        return 1\n    return 0\n",
    expectedContains: ["__ctrans_truthy(v)"],
    decision: "semantic",
    rule: "py.test→js.truthy",
  },
  {
    id: "not",
    source: "def f(v):\n    return not v\n",
    expectedContains: ["!__ctrans_truthy(v)"],
    decision: "semantic",
  },
  {
    id: "boolop-and",
    source: "def f(a, b):\n    return a and b\n",
    expectedContains: ["__ctrans_truthy(a) ? b : a"],
    decision: "semantic",
    rule: "py.boolop→js.ternary-truthy",
  },
  {
    id: "conditional-expr",
    source: "def f(c, a, b):\n    return a if c else b\n",
    expectedContains: ["__ctrans_truthy(c) ? a : b"],
    decision: "semantic",
    rule: "py.conditional→js.ternary+truthy",
  },
  {
    id: "conditional-expr-list-test",
    source: "def f(xs):\n    return 1 if xs else 0\n",
    expectedContains: ["__ctrans_truthy(xs) ? 1 : 0"],
    decision: "semantic",
    rule: "py.conditional→js.ternary+truthy",
  },

  // ---- collections ----
  {
    id: "list-literal",
    source: "xs = [1, 2, 3]\n",
    expectedContains: ["let xs = [1, 2, 3]"],
    decision: "deterministic",
  },
  {
    id: "tuple-literal",
    source: "t = (1, 2)\n",
    expectedContains: ["let t = [1, 2]"],
    decision: "semantic",
    rule: "py.tuple→js.array",
  },
  {
    id: "set-literal",
    source: "s = {1, 2}\n",
    expectedContains: ["new Set([1, 2])"],
    decision: "deterministic",
  },
  {
    id: "dict-literal",
    source: "d = {'a': 1}\n",
    expectedContains: [`["a"]: 1`],
    decision: "semantic",
    rule: "py.dict→js.object",
  },

  // ---- comprehensions ----
  {
    id: "listcomp",
    source: "def f(xs):\n    return [x * 2 for x in xs]\n",
    expectedContains: ["__ctrans_iter(xs).map((x) => __ctrans_mul(x, 2))"],
    decision: "semantic",
    rule: "py.listcomp→js.map/filter",
  },
  {
    id: "listcomp-typed",
    source: "def f(xs: list[int]):\n    return [x * 2 for x in xs]\n",
    expectedContains: [".map((x) => x * 2)"],
    decision: "deterministic",
    rule: "py.listcomp→js.map/filter",
  },
  {
    id: "listcomp-filter",
    source: "def f(xs):\n    return [x for x in xs if x > 1]\n",
    expectedContains: ["__ctrans_iter(xs)", ".filter((x) =>"],
    decision: "semantic",
  },
  {
    id: "setcomp",
    source: "def f(xs):\n    return {x for x in xs}\n",
    expectedContains: ["new Set("],
    decision: "semantic",
    rule: "py.setcomp→js.Set(map)",
  },
  {
    id: "dictcomp",
    source: "def f(xs):\n    return {x: x for x in xs}\n",
    expectedContains: ["Object.fromEntries("],
    decision: "semantic",
    rule: "py.dictcomp→js.fromEntries",
  },

  // ---- functions ----
  {
    id: "function",
    source: "def f():\n    return 1\n",
    expectedContains: ["function f()"],
    decision: "deterministic",
  },
  {
    id: "default-arg",
    source: "def f(x=5):\n    return x\n",
    expectedContains: ["= 5)"],
    decision: "deterministic",
  },
  {
    id: "lambda",
    source: "f = lambda x: x + 1\n",
    expectedContains: ["=> __ctrans_add(x, 1)"],
    decision: "deterministic",
  },
  {
    id: "async-def",
    source: "async def f():\n    return 1\n",
    expectedContains: ["async function f()"],
    decision: "deterministic",
  },

  // ---- strings / f-strings / slicing ----
  {
    id: "fstring",
    source: "def f(name):\n    return f'hello {name}'\n",
    // Python f"{x}" interpolates str(x) — bools print True/False, None prints None.
    expectedContains: ["`hello ${__ctrans_str(name)}`"],
    decision: "deterministic",
    rule: "py.fstring→js.template",
  },
  {
    id: "slice-simple",
    source: "def f(s: str):\n    return s[0:3]\n",
    expectedContains: [".slice(0, 3)"],
    decision: "deterministic",
    rule: "py.slice→js.slice",
  },
  {
    id: "slice-step",
    source: "def f(s: str):\n    return s[::2]\n",
    expectedContains: ["__ctrans_slice(s, undefined, undefined, 2)"],
    decision: "semantic",
    rule: "py.slice→__ctrans.slice",
  },
  {
    id: "negative-index",
    source: "def f(xs):\n    return xs[-1]\n",
    expectedContains: ["__ctrans_index(xs, -1)"],
    decision: "semantic",
    rule: "py.index→__ctrans.index",
  },

  // ---- statements ----
  {
    id: "for-range",
    source: "def f(n):\n    for i in range(n):\n        pass\n",
    expectedContains: ["for (const i of __ctrans_range(n))"],
    decision: "semantic",
    rule: "py.for-range→__ctrans.range",
  },
  {
    id: "for-range-numeric",
    source: "def f(n: int):\n    for i in range(n):\n        pass\n",
    expectedContains: ["for (let i = 0; i < n; i++)"],
    decision: "deterministic",
    rule: "py.for-range→js.c-style-for",
  },
  {
    id: "for-of",
    source: "def f(xs):\n    for x in xs:\n        pass\n",
    expectedContains: ["for (const x of __ctrans_iter(xs))"],
    decision: "semantic",
    rule: "py.for→__ctrans.iter",
  },
  {
    id: "for-of-typed",
    source: "def f(xs: list[int]):\n    for x in xs:\n        pass\n",
    expectedContains: ["for (const x of xs)"],
    decision: "deterministic",
    rule: "py.for→js.for-of",
  },
  {
    id: "while",
    source: "def f(n):\n    while n > 0:\n        n -= 1\n",
    // A comparison RESULT is boolean — its truthiness is provably equivalent, so
    // the condition is native even for unknown operands (no double truthy wrap).
    expectedContains: ["while (__ctrans_gt(n, 0))"],
    decision: "semantic",
  },
  {
    // D-016 provability: a comparison result is boolean in both languages — the
    // helper is provably unnecessary.
    id: "truthiness-provable-compare",
    source:
      "def f(flag: bool, n: int) -> bool:\n    while n > 0:\n        n -= 1\n    return flag\n",
    expectedContains: ["while (n > 0)"],
    decision: "deterministic",
    rule: "py.test→js.native",
    tsOnly: true,
  },
  {
    // A number-typed value may be NaN (Python-truthy, JS-falsy): helper retained.
    id: "truthiness-unprovable-number",
    source: "def f(x: float) -> bool:\n    if x:\n        return True\n    return False\n",
    expectedContains: ["if (__ctrans_truthy(x))"],
    decision: "semantic",
    rule: "py.test→js.truthy",
    tsOnly: true,
  },

  // ---- exceptions ----
  {
    id: "raise-value-error",
    source: "def f():\n    raise ValueError('bad')\n",
    expectedContains: ['throw new ValueError("bad")'],
    decision: "deterministic",
    rule: "py.raise→js.throw",
  },
  {
    id: "try-except",
    source: "def f():\n    try:\n        risky()\n    except ValueError as e:\n        return e\n",
    expectedContains: ["instanceof ValueError"],
    decision: "semantic",
    rule: "py.try→js.try/catch",
  },
  {
    id: "try-finally",
    source: "def f():\n    try:\n        a()\n    finally:\n        b()\n",
    expectedContains: ["finally"],
    decision: "semantic",
  },

  // ---- builtins ----
  {
    id: "len",
    source: "def f(xs):\n    return len(xs)\n",
    expectedContains: ["__ctrans_len(xs)"],
    decision: "semantic",
    rule: "py.len→__ctrans.len",
  },
  {
    id: "str-call",
    source: "def f(x):\n    return str(x)\n",
    expectedContains: ["__ctrans_str(x)"],
    decision: "semantic",
  },
  {
    id: "int-call",
    source: "def f(s):\n    return int(s)\n",
    expectedContains: ["__ctrans_toInt(s)"],
    decision: "semantic",
  },
  {
    id: "print",
    source: "def f():\n    print('hi')\n",
    expectedContains: ['__ctrans_print("hi")'],
    decision: "semantic",
    rule: "py.print→__ctrans.print",
  },

  // ---- M4 audit regressions (honest lowering) ----
  {
    id: "builtin-unmapped",
    source: "def f(xs):\n    return bin(xs)\n",
    expectedContains: ["/* ctrans: unsupported py.Call(builtin)"],
    decision: "unsupported",
    rule: "py.Call(builtin)→unsupported",
  },
  {
    // Python binds at function scope: the branch-assigned variable must be visible
    // after the if/else, so its declaration is hoisted to the scope top.
    id: "branch-binding-hoist",
    source:
      'def pick(v):\n    if v:\n        msg = "big"\n    else:\n        msg = "small"\n    return msg\n',
    expectedContains: ["let msg: unknown;", 'msg = "big";'],
    decision: "deterministic",
    rule: "py.assign→js.let/assign",
    tsOnly: true,
  },
  {
    // A Python dict is an open string-keyed mapping: the fresh binding carries a
    // Record annotation so later key writes type-check.
    id: "dict-open-record",
    source: 'd = {"a": 1}\nd["b"] = 2\n',
    expectedContains: ["let d: Record<string, number> = ", 'd["b"] = 2;'],
    decision: "deterministic",
    rule: "py.assign→js.let/assign",
    tsOnly: true,
  },
  {
    // An empty list literal has no element type to infer: explicit unknown[] instead
    // of implicit any (strict S2).
    id: "empty-list-unknown",
    source: "def f():\n    xs = []\n    return len(xs)\n",
    expectedContains: ["let xs: unknown[] = [];"],
    decision: "deterministic",
    rule: "py.assign→js.let/assign",
    tsOnly: true,
  },
  {
    // Parallel-assignment bindings are declared unknown: their values are dynamically
    // rebound by construction (a, b = b, a + b must stay legal).
    id: "unpack-rebind",
    source:
      "def spin(n):\n    a, b = 0, 1\n    while n > 0:\n        a, b = b, a + b\n        n -= 1\n    return a\n",
    expectedContains: ["let [a, b]: unknown[] = [0, 1];"],
    decision: "deterministic",
    rule: "py.parallel-assign→js.destructure",
    tsOnly: true,
  },
  {
    // Registry v1 (D-011): list.append maps to push with the documented return
    // divergence (Python None vs JS length) — semantic adaptation, no unmapped warning.
    id: "container-method-registry",
    source: "def f(xs: list[int]):\n    xs.append(1)\n    return xs\n",
    expectedContains: ["xs.push(1);"],
    decision: "deterministic",
    rule: "py.array-method→js.list.append",
  },
  {
    // Methods OUTSIDE the registry stay verbatim with CTW-METHOD-UNMAPPED (the M4
    // honesty surface — asserted behaviorally in lowering-regressions.test.ts).
    id: "container-method-unmapped",
    source: "def f(xs: list[int]):\n    xs.reshape(2)\n    return xs\n",
    expectedContains: ["xs.reshape(2);"],
    decision: "deterministic",
    rule: "py.call→js.call",
  },

  // ---- M4 audit coverage: previously untested lowering arms ----
  {
    // Class attributes become static fields; instance access diverges (warning).
    id: "class-attr-static",
    source: "class C:\n    version = 1\n",
    expectedContains: ["static version = 1;"],
    decision: "semantic",
    rule: "py.class-attr→js.static",
  },
  {
    id: "class-body-pass",
    source: "class Empty:\n    pass\n",
    expectedContains: ["class Empty {"],
    decision: "deterministic",
  },
  {
    // Augmented assignment through a statically unknown subscript target writes via
    // the index helper; the arithmetic preserves Python semantics via __ctrans_add.
    id: "augassign-subscript",
    source: "def bump(store, key):\n    store[key] += 1\n",
    expectedContains: ["__ctrans_setIndex(", "__ctrans_add("],
    decision: "semantic",
  },
  {
    // Unpacking into a member target binds through setattr (never a read helper).
    id: "unpack-attr-target",
    source: "def split(pair, obj):\n    obj.name, tail = pair\n    return tail\n",
    expectedContains: ["__ctrans_setattr("],
    decision: "semantic",
  },
  {
    // Exception types outside the generated hierarchy are unsupported, never dropped.
    id: "except-custom-type",
    source: "def f():\n    try:\n        risky()\n    except CustomError:\n        return 1\n",
    expectedContains: ["/* ctrans: unsupported py.ExceptHandler(type)"],
    decision: "unsupported",
    rule: "py.ExceptHandler(type)→unsupported",
  },
  {
    id: "kwargs-param",
    source: "def f(**opts):\n    return opts\n",
    expectedContains: ["...opts: Record<string, unknown>"],
    decision: "semantic",
    rule: "py.kwargs→js.rest-object",
    tsOnly: true,
  },

  {
    // Registry v1 (D-011): sorted lowers through the Python-semantics helper.
    id: "builtin-registry-sorted",
    source: "def f(xs):\n    return sorted(xs)\n",
    expectedContains: ["__ctrans_sorted(xs)"],
    decision: "semantic",
    rule: "py.sorted→__ctrans.sorted",
  },

  // ---- unsupported (negative) ----
  {
    id: "metaclass",
    source: "class C(metaclass=Meta):\n    pass\n",
    expectedContains: ["ctrans: unsupported"],
    decision: "unsupported",
  },
  {
    id: "metaclass-type-base",
    source: "class Meta(type):\n    pass\n",
    expectedContains: ["ctrans: unsupported"],
    decision: "unsupported",
    rule: "py.ClassDef(metaclass-base)→unsupported",
  },
  {
    id: "with-statement",
    source: "def f(m):\n    with m as handle:\n        use(handle)\n",
    expectedContains: ["__enter__()", "try {", "__exit__(", "finally"],
    decision: "semantic",
    rule: "py.with→js.enter/try-finally",
  },
  {
    id: "with-multi-item",
    source: "def f(h1, h2):\n    with h1 as a, h2 as b:\n        use(a, b)\n",
    expectedContains: ["ctrans: unsupported"],
    decision: "unsupported",
    rule: "py.With→unsupported",
  },
  {
    id: "async-with",
    source: "async def f(m):\n    async with m as handle:\n        use(handle)\n",
    expectedContains: ["ctrans: unsupported"],
    decision: "unsupported",
    rule: "py.AsyncWith→unsupported",
  },
  {
    id: "try-except-star",
    source: "def f():\n    try:\n        risky()\n    except* ValueError:\n        return 1\n",
    expectedContains: ["ctrans: unsupported"],
    decision: "unsupported",
    rule: "py.TryStar→unsupported",
  },
  {
    id: "global-statement",
    source: "counter = 0\n\ndef bump():\n    global counter\n    counter = counter + 1\n",
    expectedContains: ["counter = counter + 1"],
    decision: "deterministic",
    rule: "py.global→resolved-binding",
  },
  {
    id: "delete-statement",
    source: "def drop(store, key):\n    del store[key]\n",
    expectedContains: ["ctrans: unsupported"],
    decision: "unsupported",
    rule: "py.Delete→unsupported",
  },
  {
    id: "yield-from",
    source: "def inner():\n    yield 1\n\ndef outer():\n    yield from inner()\n",
    expectedContains: ["yield*"],
    decision: "deterministic",
    rule: "py.yieldfrom→js.yield*",
  },
  {
    id: "augassign-member-typed",
    source:
      "class C:\n    def __init__(self, start: int) -> None:\n        self.count = start\n\n    def bump(self, by: int) -> None:\n        self.count += by\n",
    expectedContains: ["this.count += by"],
    decision: "deterministic",
    rule: "py.augassign→js.augassign",
  },
  {
    id: "swap-declared",
    source:
      "def swap(xs: list):\n    first, second = xs[0], xs[1]\n    first, second = second, first\n    return first\n",
    expectedContains: ["[first, second] = [second, first]"],
    decision: "deterministic",
    rule: "py.parallel-assign→js.destructure",
  },
  {
    id: "unpack-mixed",
    source: "def unpack(pair, known):\n    fresh, known = pair\n    return fresh, known\n",
    expectedContains: ["__ctrans_unpack"],
    decision: "semantic",
    rule: "py.unpack→js.destructure",
  },
  {
    id: "kwonly-default",
    source: "def f(*, limit: int = 10) -> int:\n    return limit\n",
    expectedContains: ["= 10)"],
    decision: "deterministic",
  },
  {
    id: "isinstance-user-class",
    source: "def check(value, Kind):\n    return isinstance(value, Kind)\n",
    expectedContains: ["instanceof"],
    decision: "semantic",
    rule: "py.isinstance→js.instanceof",
  },
  {
    id: "fstring-format-spec",
    source: "def f(x):\n    return f'{x:>10}'\n",
    expectedContains: ["ctrans: unsupported"],
    decision: "unsupported",
  },
  {
    // M8: literal/capture match cases are AMBIGUOUS (if-chain heuristic default;
    // switch is the alternative). Pattern kinds outside the subset stay unsupported.
    id: "match-statement",
    source:
      "def f(x):\n    match x:\n        case 1:\n            return 'one'\n        case _:\n            return 'other'\n",
    expectedContains: ["__ctrans_eq(__ctrans_match1, 1)"],
    decision: "ambiguous",
    rule: "py.Match→js.if-chain",
  },
  {
    id: "match-statement-patterns",
    source:
      "def f(x):\n    match x:\n        case [a, b]:\n            return a\n        case _:\n            return None\n",
    expectedContains: ["ctrans: unsupported py.Match"],
    decision: "unsupported",
  },
  {
    id: "async-for",
    source: "async def f(xs):\n    async for x in xs:\n        pass\n",
    expectedContains: ["ctrans: unsupported"],
    decision: "unsupported",
  },

  // ---- batch III: call-site stars, tuple targets, more unsupported forms ----
  {
    id: "starred-call-arg",
    source: "def f(*rest):\n    return rest\n\ndef g(head, *tail):\n    return f(head, *tail)\n",
    expectedContains: ["...tail"],
    decision: "deterministic",
    rule: "py.call→js.call",
  },
  {
    id: "big-int-literal",
    source: "x = 9007199254740993\n",
    expectedContains: ["9007199254740993"],
    decision: "semantic",
    rule: "py.int→js.number",
  },
  {
    id: "bytes-literal",
    source: "data = b'raw'\n",
    expectedContains: ["ctrans: unsupported"],
    decision: "unsupported",
  },
  {
    id: "complex-literal",
    source: "z = 1 + 2j\n",
    expectedContains: ["ctrans: unsupported"],
    decision: "unsupported",
  },
  {
    id: "bare-slice-expr",
    source: "def f(seq, cursor):\n    return seq[cursor:]\n",
    expectedContains: ["__ctrans_slice"],
    decision: "semantic",
    rule: "py.slice→__ctrans.slice",
  },
  {
    id: "lambda-vararg",
    source: "f = lambda *args: len(args)\n",
    expectedContains: ["...args"],
    decision: "deterministic",
  },
  {
    id: "while-else",
    source:
      "def f(n):\n    while n > 0:\n        n = n - 1\n    else:\n        return -1\n    return 0\n",
    expectedContains: ["ctrans: unsupported"],
    decision: "unsupported",
    rule: "py.While(else)→unsupported",
  },
  {
    id: "for-else",
    source:
      "def f(xs):\n    for x in xs:\n        pass\n    else:\n        return -1\n    return 0\n",
    expectedContains: ["ctrans: unsupported"],
    decision: "unsupported",
    rule: "py.For(else)→unsupported",
  },
  {
    id: "raise-from",
    source: "def f():\n    raise ValueError('x') from None\n",
    expectedContains: ["ctrans: unsupported"],
    decision: "unsupported",
    rule: "py.Raise(cause)→unsupported",
  },
  {
    id: "assert-statement",
    source: "def f(v):\n    assert v > 0, 'positive'\n    return v\n",
    expectedContains: ["ctrans: unsupported"],
    decision: "unsupported",
    rule: "py.Assert→unsupported",
  },
  {
    id: "unary-invert",
    source: "def f(a: int):\n    return ~a\n",
    expectedContains: ["~a"],
    decision: "deterministic",
  },
  {
    id: "chained-comparison",
    source: "def f(a, b, c):\n    return a < b < c\n",
    expectedContains: ["ctrans: unsupported"],
    decision: "unsupported",
    rule: "py.Compare(chained)→unsupported",
  },
  {
    id: "nested-function-closure",
    source:
      "def make(start: int):\n    count = start\n\n    def bump(by: int) -> int:\n        count += by\n        return count\n\n    return bump\n",
    expectedContains: ["function bump"],
    decision: "deterministic",
    rule: "py.function→js.function",
  },
  {
    id: "nonlocal-statement",
    source:
      "def outer():\n    count = 0\n\n    def inner():\n        nonlocal count\n        count = count + 1\n\n    inner()\n    return count\n",
    expectedContains: ["count = count + 1"],
    decision: "deterministic",
    rule: "py.nonlocal→resolved-binding",
  },
  {
    id: "except-tuple",
    source:
      "def f():\n    try:\n        risky()\n    except (ValueError, TypeError) as e:\n        return e\n",
    expectedContains: ["instanceof ValueError", "instanceof TypeError"],
    decision: "semantic",
    rule: "py.try→js.try/catch",
  },
  {
    id: "bare-except-binding",
    source: "def f():\n    try:\n        risky()\n    except Exception as e:\n        return e\n",
    expectedContains: ["const e = __ctrans_err;"],
    decision: "semantic",
    rule: "py.try→js.try/catch",
  },
  {
    id: "nested-tuple-unpack",
    source: "def f(pair):\n    (a, (b, c)) = pair\n    return a, b, c\n",
    expectedContains: ["[a, b, c]"],
    decision: "deterministic",
    rule: "py.unpack→js.destructure",
  },
  {
    id: "member-on-call-result",
    source: "def f(make):\n    obj = make()\n    return obj.value\n",
    expectedContains: ['__ctrans_getattr(obj, "value")'],
    decision: "semantic",
    rule: "py.attribute→__ctrans.getattr",
  },
  {
    id: "ellipsis-unsupported",
    source: "def f():\n    return ...\n",
    expectedContains: ["ctrans: unsupported"],
    decision: "unsupported",
  },
  {
    id: "dict-merge",
    source: "def merge(base, extra):\n    return {**base, **extra}\n",
    expectedContains: ["...base"],
    decision: "semantic",
    rule: "py.dict→js.object",
  },
  {
    id: "subscript-store-typed",
    source: "def f(xs: list[int], v: int) -> None:\n    xs[0] = v\n",
    expectedContains: ["xs[0] = v"],
    decision: "deterministic",
    rule: "py.subscript-assign→js.index-assign",
  },
  {
    id: "subscript-store-dynamic",
    source: "def f(store, key, v):\n    store[key] = v\n",
    expectedContains: ["__ctrans_setIndex"],
    decision: "semantic",
    rule: "py.subscript-assign→__ctrans.setIndex",
  },
  {
    id: "setattr-dynamic",
    source: "def f(obj, v):\n    obj.field = v\n",
    expectedContains: ["__ctrans_setattr"],
    decision: "semantic",
    rule: "py.member-assign→__ctrans.setattr",
  },

  {
    id: "raise-bare-class",
    source: "def f():\n    raise ValueError\n",
    expectedContains: ["throw new ValueError()"],
    decision: "deterministic",
    rule: "py.raise→js.throw",
  },
  {
    id: "bitwise-typed",
    source: "def f(a: int, b: int) -> int:\n    return (a | b) & (a ^ b) % 255\n",
    expectedContains: ["a | b"],
    decision: "semantic",
    rule: "py.bitwise→js.bitwise",
  },
  {
    id: "pow-typed",
    source: "def f(a: int) -> int:\n    return a ** 3\n",
    expectedContains: ["a ** 3"],
    decision: "deterministic",
  },
  {
    id: "not-in-operator",
    source: "def f(x, xs):\n    return x not in xs\n",
    expectedContains: ["!__ctrans_contains"],
    decision: "semantic",
  },
  {
    id: "await-helper",
    source: "async def g() -> int:\n    return 1\n\nasync def f():\n    return await g()\n",
    expectedContains: ["await g()"],
    decision: "deterministic",
    rule: "py.await→js.await",
  },
  {
    id: "nested-tuple-element",
    source: "def f(a, b):\n    t = (a, (b, a))\n    return t\n",
    expectedContains: ["[a, [b, a]]"],
    decision: "deterministic",
  },
  {
    id: "member-access-unresolved",
    source: "def f(external):\n    return external.thing\n",
    expectedContains: ['__ctrans_getattr(external, "thing")'],
    decision: "semantic",
    rule: "py.attribute→__ctrans.getattr",
  },
  {
    id: "pow-dynamic",
    source: "def f(a, b):\n    return a ** b\n",
    expectedContains: ["__ctrans_pow(a, b)"],
    decision: "semantic",
    rule: "py.pow→__ctrans.pow",
  },
  {
    id: "matmul-unsupported",
    source: "def f(a, b):\n    return a @ b\n",
    expectedContains: ["ctrans: unsupported"],
    decision: "unsupported",
  },
  {
    id: "neg-dynamic",
    source: "def f(a):\n    return -a\n",
    expectedContains: ["__ctrans_neg(a)"],
    decision: "semantic",
  },
  {
    id: "pos-dynamic",
    source: "def f(a):\n    return +a\n",
    expectedContains: ["__ctrans_pos(a)"],
    decision: "semantic",
  },
  {
    id: "kitchen-sink-supported",
    source:
      '"""Kitchen sink: sweeps many supported arms in one module."""\nimport math\n\n\ndef numeric_mix(a: int, b: float, x):\n    total: int = 0\n    total += a + int(b)\n    total += len("abc")\n    return -total, +a, ~a\n\n\ndef membership(x, xs: list) -> bool:\n    return x in xs and x not in xs or x is None\n\n\ndef boxes():\n    d = {"a": 1}\n    s = {1, 2}\n    t = (1, 2)\n    first, second = t\n    return d, s, first, second\n\n\ndef floathy(v) -> float:\n    return float(v)\n\n\ndef gen():\n    yield 1\n\n\ndef take():\n    for v in gen():\n        return v\n\n\ndef combine(a, b) -> str:\n    return str(a) + str(b)\n\n\nasync def later():\n    return 7\n\n\nasync def runner():\n    return await later()\n\n\ndef mathy(x: float) -> float:\n    return x + 1.5\n',
    expectedContains: [
      "total += a + __ctrans_toInt(b)",
      "-total",
      "~a",
      "yield 1",
      "await later()",
    ],
    decision: "deterministic",
  },
  {
    id: "kitchen-unsupported-sweep",
    source: "def f(v, handler):\n    assert v > 0, 'positive'\n    del v\n    return handler\n",
    expectedContains: ["ctrans: unsupported"],
    decision: "unsupported",
    rule: "py.Assert→unsupported",
  },
  {
    id: "import-external-math",
    source: "import math\n\ndef f(x: float) -> float:\n    return x + 1.5\n",
    // Registry v1 (D-011): math maps to the generated __ctrans_math module.
    expectedContains: ['import * as math from "./__ctrans_math'],
    decision: "deterministic",
    rule: "py.import→module-prologue",
  },
  {
    id: "attribute-chain-typed",
    source:
      "class P:\n    def __init__(self) -> None:\n        self.name = 'x'\n\nclass H:\n    def __init__(self) -> None:\n        self.p = P()\n\ndef name(h: H) -> str:\n    return h.p.name\n",
    expectedContains: ["h.p.name"],
    decision: "deterministic",
    rule: "py.attribute→js.member",
  },
  {
    id: "optional-annotation",
    tsOnly: true,
    source: "def f(x: Optional[int] = None) -> int:\n    return x or 0\n",
    expectedContains: ["number | undefined"],
    decision: "deterministic",
  },
  {
    id: "tuple-annotation",
    tsOnly: true,
    source: "def f(pair: tuple[int, int]) -> int:\n    return pair[0]\n",
    expectedContains: [
      "[",
      "n",
      "u",
      "m",
      "b",
      "e",
      "r",
      ",",
      " ",
      "n",
      "u",
      "m",
      "b",
      "e",
      "r",
      "]",
    ],
    decision: "deterministic",
  },
  {
    id: "unpack-nested-declared",
    source: "def f(pair, a, b, c):\n    (a, (b, c)) = pair\n    return a, b, c\n",
    expectedContains: ["[", "a", ",", " ", "[", "b", ",", " ", "c", "]", "]"],
    decision: "deterministic",
    rule: "py.unpack→js.destructure",
  },
  {
    id: "unpack-member-target",
    source: "def f(xs, pair, y):\n    xs[0], y = pair\n    return y\n",
    expectedContains: ["__ctrans_unpack"],
    decision: "semantic",
    rule: "py.unpack→js.destructure",
  },
  {
    id: "bare-except-rethrow",
    source: "def f(action):\n    try:\n        return action()\n    except:\n        raise\n",
    expectedContains: ["throw __ctrans_err;"],
    decision: "semantic",
    rule: "py.try→js.try/catch",
  },
  {
    id: "field-container-inference",
    tsOnly: true,
    source:
      "class Bag:\n    def __init__(self) -> None:\n        self.items = []\n        self.index = {}\n\n    def add(self, v) -> None:\n        self.items = self.items + [v]\n",
    expectedContains: ["items: Array<unknown>"],
    decision: "semantic",
    rule: "py.self-attr→js.field",
  },
  {
    id: "star-import",
    source: "from helper import *\n\ndef use():\n    return thing\n",
    expectedContains: ['import * as module from "helper";'],
    decision: "deterministic",
  },
  {
    id: "bare-return",
    source: "def f(flag: bool):\n    if flag:\n        return\n    return 1\n",
    expectedContains: ["return;"],
    decision: "deterministic",
  },
];
