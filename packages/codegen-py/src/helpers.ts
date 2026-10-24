// Python runtime helper templates (D-007: emitted only when referenced, one module
// per output project, zero dependencies). Each helper reproduces a VERIFIED JS
// semantic that Python's native operator does not (docs/language-support.md §2,
// TS/JS→Py column). Helper bodies are stdlib-only Python; formatting is ruff's job.
export interface PyRuntimeHelper {
  readonly name: string;
  readonly requires?: readonly string[];
  readonly code: string;
}

export const RUNTIME_HELPERS: Readonly<Record<string, PyRuntimeHelper>> = {
  truthy: {
    name: "truthy",
    code: `def __ctrans_truthy(value: Any) -> bool:
    """JS boolean coercion: NaN, +-0, "" are falsy exactly as in JavaScript."""
    if value is None:
        return False
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0 and value == value  # NaN is falsy in JS
    if isinstance(value, str):
        return len(value) > 0
    if isinstance(value, (list, dict, set, tuple)):
        return len(value) > 0
    return True`,
  },
  numeric_constants: {
    name: "numeric_constants",
    code: `import math


def __ctrans_nan() -> float:
    """JavaScript NaN as a Python float."""
    return math.nan


def __ctrans_infinity() -> float:
    """JavaScript positive Infinity as a Python float."""
    return math.inf`,
  },
  js_add: {
    name: "js_add",
    requires: ["str_js"],
    code: `def __ctrans_js_add(left: Any, right: Any) -> Any:
    """JS + semantics: string if either side is a string, numeric otherwise.

    Object/stringification goes through __ctrans_str_js (JS toString), never
    Python's repr-based str()."""
    if isinstance(left, str) or isinstance(right, str):
        return __ctrans_str_js(left) + __ctrans_str_js(right)
    if isinstance(left, list) and isinstance(right, list):
        return left + right
    if isinstance(left, (int, float)) and isinstance(right, (int, float)):
        return left + right
    raise TypeError("unsupported operand for +")`,
  },
  str_js: {
    name: "str_js",
    code: `def __ctrans_str_js(value: Any) -> str:
    """JS String(value): true/false/null spellings; numbers keep JS repr shape."""
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, float) and value == int(value) and abs(value) < 1e21:
        return repr(value)
    if isinstance(value, (int, float)):
        return repr(value)
    if isinstance(value, str):
        return value
    if isinstance(value, dict):
        return "[object Object]"
    if isinstance(value, list):
        return ",".join(__ctrans_str_js(item) for item in value)
    return str(value)`,
  },
  js_div: {
    name: "js_div",
    requires: ["numeric_constants"],
    code: `def __ctrans_js_div(left: Any, right: Any) -> Any:
    """JS /: division by zero yields signed Infinity (or NaN for 0/0 and NaN).
    The divisor's SIGNED ZERO decides the infinity's sign (1 / -0 is -Infinity).
    Restricted to numeric operands — JS string coercion is outside the subset."""
    if not isinstance(left, (int, float)) or not isinstance(right, (int, float)):
        raise TypeError("JS division requires numbers")
    if right == 0:
        if left != left or left == 0:
            return __ctrans_nan()
        divisor_negative = math.copysign(1.0, float(right)) < 0
        negative = (left < 0) != divisor_negative
        return -__ctrans_infinity() if negative else __ctrans_infinity()
    return left / right`,
  },
  js_mod: {
    name: "js_mod",
    requires: ["numeric_constants"],
    code: `def __ctrans_js_mod(left: Any, right: Any) -> Any:
    """JS %: truncated toward zero; a zero divisor yields NaN, not ZeroDivisionError.
    Integer operands keep an INTEGER result (JS % on ints is int-valued and JSON/
    str must not gain a float artifact); float operands use IEEE fmod. The int path
    is exact arbitrary precision (broader than JS doubles — documented)."""
    if not isinstance(left, (int, float)) or not isinstance(right, (int, float)):
        raise TypeError("JS remainder requires numbers")
    if right == 0 or left != left or right != right:
        return __ctrans_nan()
    if isinstance(left, int) and isinstance(right, int):
        magnitude = abs(left) % abs(right)
        return -magnitude if left < 0 else magnitude
    import math

    result = math.fmod(left, right)
    return 0.0 if result == 0 else result`,
  },
  js_number: {
    name: "js_number",
    requires: ["numeric_constants"],
    code: `def __ctrans_js_number(value: Any = None) -> Any:
    """JS Number() for the documented string subset: decimal/exponent forms, hex,
    binary, and octal prefixes (case-insensitive, with signs); whitespace-trimmed.
    Python-only spellings (inf/infinity/underscores) and malformed digits yield
    NaN exactly like JS; the tri-state null/undefined collapse to 0 is semantic."""
    if value is None:
        return 0
    if isinstance(value, bool):
        return 1 if value else 0
    if isinstance(value, (int, float)):
        return value
    if isinstance(value, str):
        text = value.strip()
        if text == "":
            return 0
        if text in ("Infinity", "+Infinity"):
            return __ctrans_infinity()
        if text == "-Infinity":
            return -__ctrans_infinity()
        sign = 1
        if text.startswith(("-", "+")):
            sign = -1 if text.startswith("-") else 1
            text = text[1:]
        lowered = text.lower()
        radix_digits = (
            ("0x", "0123456789abcdef"),
            ("0b", "01"),
            ("0o", "01234567"),
        )
        for prefix, digits_alphabet in radix_digits:
            if lowered.startswith(prefix):
                digits = lowered[len(prefix):]
                if digits == "" or any(c not in digits_alphabet for c in digits):
                    return __ctrans_nan()
                return sign * int(digits, 16 if prefix == "0x" else 8 if prefix == "0o" else 2)
        if any(c not in "0123456789.eE+-" for c in text):
            return __ctrans_nan()
        import math

        try:
            result = float(text)
        except ValueError:
            return __ctrans_nan()
        if math.isnan(result) or math.isinf(result):
            return __ctrans_nan()
        # JS renders integral numbers without a decimal point; keep the parsed
        # value int-valued when exact and within JS's non-exponential range.
        if result == int(result) and abs(result) < 1e21:
            return sign * int(result)
        return sign * result
    return __ctrans_nan()`,
  },
  js_loose_eq: {
    name: "js_loose_eq",
    requires: ["js_number"],
    code: `def __ctrans_js_loose_eq(left: Any, right: Any) -> bool:
    """JS == for the tested scalar subset: null/null, booleans coerced to numbers,
    number/string compared numerically, same-type primitives compared directly.
    Containers use Python identity because JS object equality is reference-based."""
    if left is None or right is None:
        return left is None and right is None
    if isinstance(left, bool):
        left = __ctrans_js_number(left)
    if isinstance(right, bool):
        right = __ctrans_js_number(right)
    if isinstance(left, str) and isinstance(right, (int, float)) and not isinstance(right, bool):
        left = __ctrans_js_number(left)
    if isinstance(right, str) and isinstance(left, (int, float)) and not isinstance(left, bool):
        right = __ctrans_js_number(right)
    if isinstance(left, (int, float)) and isinstance(right, (int, float)):
        return left == right
    if isinstance(left, str) and isinstance(right, str):
        return left == right
    return left is right`,
  },
  console_log: {
    name: "console_log",
    requires: ["str_js"],
    code: `def __ctrans_console_log(*values: Any) -> None:
    """console.log/info: space-separated JS String() values on stdout."""
    print(" ".join(__ctrans_str_js(value) for value in values))`,
  },
  console_error: {
    name: "console_error",
    requires: ["str_js"],
    code: `import sys


def __ctrans_console_error(*values: Any) -> None:
    """console.warn/error: space-separated JS String() values on stderr."""
    print(" ".join(__ctrans_str_js(value) for value in values), file=sys.stderr)`,
  },
  typeof: {
    name: "typeof",
    code: `def __ctrans_typeof(value: Any) -> str:
    """JS typeof. null/undefined collapse to None (documented tri-state loss);
    None reports "undefined"."""
    if value is None:
        return "undefined"
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, (int, float)):
        return "number"
    if isinstance(value, str):
        return "string"
    if isinstance(value, (list, dict)):
        return "object"
    return "function"`,
  },
  js_in: {
    name: "js_in",
    code: `def __ctrans_js_in(key: Any, container: Any) -> bool:
    """JS in: index membership for arrays, key membership for objects,
    substring for strings."""
    if isinstance(container, str):
        return key in container
    if isinstance(container, list):
        return isinstance(key, int) and 0 <= key < len(container)
    if isinstance(container, dict):
        return key in container
    raise TypeError("in requires an object, array, or string")`,
  },
  js_get: {
    name: "js_get",
    code: `def __ctrans_js_get(container: Any, key: Any) -> Any:
    """Property access on a dynamic container: JS yields undefined for a missing
    key, Python raises KeyError. None stands in for undefined (tri-state)."""
    if container is None:
        raise TypeError("cannot read property of undefined")
    if isinstance(container, dict):
        return container.get(key)
    if isinstance(container, (list, str)):
        if isinstance(key, bool) or not isinstance(key, (int, float)):
            return None
        index = int(key)
        if -len(container) <= index < len(container):
            return container[index]
        return None
    raise TypeError(f"cannot read property {key!r} of {type(container).__name__}")`,
  },
  js_delete: {
    name: "js_delete",
    code: `def __ctrans_js_delete(container: Any, key: Any) -> bool:
    """JS delete: no error for a missing key (Python del raises KeyError)."""
    if isinstance(container, dict):
        container.pop(key, None)
        return True
    raise TypeError("delete requires an object")`,
  },
  js_index_of: {
    name: "js_index_of",
    code: `def __ctrans_js_index_of(items: Any, value: Any) -> int:
    """Array.indexOf: first index under JS === (reference/value) or -1."""
    if not isinstance(items, list):
        raise TypeError("items.indexOf is not a function")
    for index, item in enumerate(items):
        if item is value or item == value:
            return index
    return -1`,
  },
  js_includes: {
    name: "js_includes",
    code: `def __ctrans_js_includes(items: Any, value: Any) -> bool:
    """Array.includes: NaN-containing semantics via identity-or-equality."""
    if not isinstance(items, list):
        raise TypeError("items.includes is not a function")
    return any(item is value or item == value for item in items)`,
  },
  js_join: {
    name: "js_join",
    requires: ["str_js"],
    code: `def __ctrans_js_join(items: Any, separator: str) -> str:
    """Array.join: elements stringify with JS String(), null/undefined become ""."""
    if not isinstance(items, list):
        raise TypeError("items.join is not a function")
    return separator.join(
        "" if item is None else __ctrans_str_js(item) for item in items
    )`,
  },
  js_sort: {
    name: "js_sort",
    requires: ["str_js"],
    code: `def __ctrans_js_sort(items: Any, compare: Any = None) -> Any:
    if not isinstance(items, list):
        raise TypeError("items.sort is not a function")
    """Array.sort: in-place; the DEFAULT comparator stringifies (verified JS
    divergence), a callback receives (a, b) and returns a number."""
    if compare is None:
        items.sort(key=__ctrans_str_js)
        return items

    import functools

    def order(left, right):
        result = compare(left, right)
        if result is True:
            return 1
        if result is False:
            return -1
        if result is None:
            return 0
        return -1 if result < 0 else (1 if result > 0 else 0)

    items.sort(key=functools.cmp_to_key(order))
    return items`,
  },
  js_reverse: {
    name: "js_reverse",
    code: `def __ctrans_js_reverse(items: Any) -> Any:
    """Array.reverse: in-place mutation that RETURNS the array."""
    if not isinstance(items, list):
        raise TypeError("items.reverse is not a function")
    items.reverse()
    return items`,
  },
  js_reduce: {
    name: "js_reduce",
    code: `def __ctrans_js_reduce(items: Any, callback: Any, initial: Any, has_initial: bool) -> Any:
    """Array.reduce over a JS callback (accumulator, item, index, array)."""
    if not isinstance(items, list):
        raise TypeError("items.reduce is not a function")
    if has_initial:
        accumulator = initial
        start = 0
    else:
        if len(items) == 0:
            raise TypeError("Reduce of empty array with no initial value")
        accumulator = items[0]
        start = 1
    for index in range(start, len(items)):
        accumulator = callback(accumulator, items[index], index, items)
    return accumulator`,
  },
  js_find: {
    name: "js_find",
    code: `def __ctrans_js_find(items: Any, predicate: Any) -> Any:
    """Array.find: first item where JS-truthy(predicate(item, index, array)), else None."""
    if not isinstance(items, list):
        raise TypeError("items.find is not a function")
    for index, item in enumerate(items):
        if __ctrans_truthy(predicate(item, index, items)):
            return item
    return None`,
  },
  js_filter: {
    name: "js_filter",
    requires: ["truthy"],
    code: `def __ctrans_js_filter(items: Any, predicate: Any) -> Any:
    """Array.filter with JS truthiness on the predicate result."""
    if not isinstance(items, list):
        raise TypeError("items.filter is not a function")
    return [
        item
        for index, item in enumerate(items)
        if __ctrans_truthy(predicate(item, index, items))
    ]`,
  },
  js_map: {
    name: "js_map",
    code: `def __ctrans_js_map(items: Any, callback: Any) -> Any:
    """Array.map: callback receives (item, index) like JS."""
    if not isinstance(items, list):
        raise TypeError("items.map is not a function")
    return [callback(item, index, items) for index, item in enumerate(items)]`,
  },
  js_for_each: {
    name: "js_for_each",
    code: `def __ctrans_js_for_each(items: Any, callback: Any) -> Any:
    """Array.forEach: callback receives (item, index, array); returns None."""
    if not isinstance(items, list):
        raise TypeError("items.forEach is not a function")
    for index, item in enumerate(items):
        callback(item, index, items)
    return None`,
  },
  js_concat: {
    name: "js_concat",
    code: `def __ctrans_js_concat(items: Any, *values: Any) -> Any:
    """Array.concat: array values spread, scalars append."""
    if not isinstance(items, list):
        raise TypeError("items.concat is not a function")
    result = list(items)
    for value in values:
        if isinstance(value, list):
            result.extend(value)
        else:
            result.append(value)
    return result`,
  },
  js_pad_start: {
    name: "js_pad_start",
    code: `def __ctrans_js_pad_start(text: str, target: int, pad: str = " ") -> str:
    """String.padStart with JS's truncating pad cycle."""
    while len(text) < target:
        text = pad[: max(0, target - len(text))] + text
    return text`,
  },
  js_char_code_at: {
    name: "js_char_code_at",
    code: `def __ctrans_js_char_code_at(text: str, index: int) -> Any:
    """String.charCodeAt: UTF-16 code unit (surrogates for astral characters —
    verified divergence from Python ord, which is code-point based)."""
    if index < 0 or index >= len(text):
        return None
    code_point = ord(text[index])
    if code_point > 0xFFFF:
        code_point -= 0x10000
        return 0xD800 + (code_point >> 10), 0xDC00 + (code_point & 0x3FF)
    return code_point`,
  },
  js_substring: {
    name: "js_substring",
    code: `def __ctrans_js_substring(text: str, start: int, end: Any = None) -> str:
    """String.substring: swaps arguments and clamps to [0, len] (JS semantics)."""
    length = len(text)
    start = max(0, min(int(start), length))
    end = max(0, min(int(end if end is not None else length), length))
    if start > end:
        start, end = end, start
    return text[start:end]`,
  },
  js_split: {
    name: "js_split",
    code: `def __ctrans_js_split(text: str, separator: Any) -> Any:
    """String.split: JS's empty separator splits per code point (Python's raises);
    None separator splits on whitespace runs like Python's no-arg split."""
    if separator is None:
        return text.split()
    if separator == "":
        return list(text)
    return text.split(separator)`,
  },
  js_repeat: {
    name: "js_repeat",
    code: `def __ctrans_js_repeat(text: str, count: int) -> str:
    """String.repeat with JS's range error for negative counts."""
    if count < 0:
        raise ValueError("Invalid count value")
    return text * count`,
  },
  opt_attr: {
    name: "opt_attr",
    requires: ["js_get"],
    code: `def __ctrans_opt_attr(container: Any, key: Any) -> Any:
    """Optional chaining a?.k: None when the base is nullish, else the property."""
    if container is None:
        return None
    return __ctrans_js_get(container, key)`,
  },
  js_object_entries: {
    name: "js_object_entries",
    code: `def __ctrans_js_object_entries(value: Any) -> Any:
    """Object.entries: list of [key, value] pairs."""
    return [[key, item] for key, item in value.items()]`,
  },
  js_object_values: {
    name: "js_object_values",
    code: `def __ctrans_js_object_values(value: Any) -> Any:
    """Object.values."""
    return list(value.values())`,
  },
  js_object_keys: {
    name: "js_object_keys",
    code: `def __ctrans_js_object_keys(value: Any) -> Any:
    """Object.keys."""
    return list(value.keys())`,
  },
  js_array_from_keys: {
    name: "js_array_from_keys",
    code: `def __ctrans_js_array_from_keys(value: Any) -> Any:
    """for-in over an object/array: string keys for objects, numeric INDEX keys
    (as JS string keys) for arrays — verified JS semantics."""
    if isinstance(value, list):
        return [str(index) for index in range(len(value))]
    return list(value.keys())`,
  },
  push_value: {
    name: "push_value",
    code: `def __ctrans_push_value(items: Any, *values: Any) -> int:
    """Array.push in expression position: appends and returns the NEW LENGTH."""
    if not isinstance(items, list):
        raise TypeError("items.push is not a function")
    items.extend(values)
    return len(items)`,
  },
  unshift_value: {
    name: "unshift_value",
    code: `def __ctrans_unshift_value(items: Any, *values: Any) -> int:
    """Array.unshift in expression position: prepends, returns new length."""
    if not isinstance(items, list):
        raise TypeError("items.unshift is not a function")
    items[0:0] = list(values)
    return len(items)`,
  },
  js_instanceof: {
    name: "js_instanceof",
    code: `def __ctrans_js_instanceof(value: Any, class_type: Any) -> bool:
    """JS instanceof against translated classes (the runtime helper hierarchy is
    plain Python classes, so isinstance matches)."""
    return isinstance(value, class_type)`,
  },
  math_entry: {
    name: "math_entry",
    requires: ["numeric_constants"],
    code: `import math


def __ctrans_js_math_pow(base: Any, exponent: Any) -> float:
    """Math.pow for the tested JS domain edges (NaN, zero, infinity, overflow)."""
    if exponent == 0 or base == 1:
        return 1.0
    if base == -1 and math.isinf(exponent):
        return 1.0
    if math.isnan(base) or math.isnan(exponent):
        return __ctrans_nan()
    if base == 0 and exponent < 0:
        return math.copysign(__ctrans_infinity(), float(base))
    if base == 0 and math.isinf(exponent):
        return 0.0
    try:
        return math.pow(base, exponent)
    except ValueError:
        return __ctrans_nan()
    except OverflowError:
        return __ctrans_infinity() if base > 0 else -__ctrans_infinity()


def __ctrans_js_math_log(value: Any) -> float:
    """Math.log: zero is -Infinity; negative input is NaN (Python raises)."""
    if value == 0:
        return -__ctrans_infinity()
    if value < 0 or value != value:
        return __ctrans_nan()
    return math.log(value)


def __ctrans_js_math_sqrt(value: Any) -> float:
    """Math.sqrt: negative input is NaN (Python raises)."""
    if value < 0 or value != value:
        return __ctrans_nan()
    return math.sqrt(value)


def __ctrans_js_math_sign(value: Any) -> float:
    """Math.sign, including NaN and signed zero."""
    if value != value:
        return __ctrans_nan()
    if value == 0:
        return math.copysign(0.0, float(value))
    return 1.0 if value > 0 else -1.0


def __ctrans_math_entry(name: str, *args: Any) -> Any:
    """Math.* surface. Finite-domain entries map to math; pow/log/sqrt/sign use
    JS boundary helpers instead of Python's exceptions."""
    table = {
        "floor": math.floor,
        "ceil": math.ceil,
        "abs": abs,
        "sqrt": __ctrans_js_math_sqrt,
        "pow": __ctrans_js_math_pow,
        "min": min,
        "max": max,
        "round": lambda value: math.floor(value + 0.5) if value >= 0 else math.ceil(value - 0.5),
        "trunc": math.trunc,
        "log": __ctrans_js_math_log,
        "exp": math.exp,
        "log2": math.log2,
        "log10": math.log10,
        "sin": math.sin,
        "cos": math.cos,
        "tan": math.tan,
        "atan": math.atan,
        "atan2": math.atan2,
        "hypot": math.hypot,
        "sign": __ctrans_js_math_sign,
        "cbrt": lambda value: math.copysign(abs(value) ** (1 / 3), value),
    }
    call = table.get(name)
    if call is None:
        raise AttributeError(f"Math.{name} is outside the mapped surface")
    return call(*args)`,
  },
};

// Transitive helper closure for a set of requested names.
export function helperClosure(requested: readonly string[]): {
  readonly helpers: readonly string[];
} {
  const helpers = new Set<string>();
  const queue = [...requested];
  while (queue.length > 0) {
    const name = queue.pop()!;
    if (helpers.has(name)) continue;
    const helper = RUNTIME_HELPERS[name];
    if (helper === undefined) continue;
    helpers.add(name);
    for (const required of helper.requires ?? []) queue.push(required);
  }
  return { helpers: [...helpers].sort() };
}

// Python-semantic bridges for codegen-js runtime helper names that survive a
// Python → TypeScript → Python round-trip: leg 1 emits these `__ctrans_*` calls
// (Python's own operator semantics wrapped for JS), and leg 2 must emit a runtime
// that DEFINES them or the output imports symbols that do not exist. Each bridge
// is Python's native operator/result — the semantics leg 1 wrapped. `truthy` is
// deliberately absent: codegen-py's own JS-semantics `truthy` helper emits the
// same `__ctrans_truthy` name with different semantics (documented collision).
export const CODEGEN_JS_RUNTIME_BRIDGE: Readonly<Record<string, string>> = {
  __ctrans_add: `def __ctrans_add(left: Any, right: Any) -> Any:
    """Python + semantics (numeric/list/string; raises on str+number)."""
    return left + right`,
  __ctrans_sub: `def __ctrans_sub(left: Any, right: Any) -> Any:
    """Python - semantics."""
    return left - right`,
  __ctrans_mul: `def __ctrans_mul(left: Any, right: Any) -> Any:
    """Python * semantics (numeric and sequence repetition)."""
    return left * right`,
  __ctrans_div: `def __ctrans_div(left: Any, right: Any) -> Any:
    """Python true division (raises ZeroDivisionError like Python)."""
    return left / right`,
  __ctrans_mod: `def __ctrans_mod(left: Any, right: Any) -> Any:
    """Python floored modulo."""
    return left % right`,
  __ctrans_floorDiv: `def __ctrans_floorDiv(left: Any, right: Any) -> Any:
    """Python floored division."""
    return left // right`,
  __ctrans_neg: `def __ctrans_neg(value: Any) -> Any:
    """Python unary minus."""
    return -value`,
  __ctrans_pos: `def __ctrans_pos(value: Any) -> Any:
    """Python unary plus."""
    return +value`,
  __ctrans_eq: `def __ctrans_eq(left: Any, right: Any) -> Any:
    """Python == (elementwise on sequences)."""
    return left == right`,
  __ctrans_str: `def __ctrans_str(value: Any) -> str:
    """Python str()."""
    return str(value)`,
  __ctrans_len: `def __ctrans_len(value: Any) -> Any:
    """Python len() (code points for str)."""
    return len(value)`,
  __ctrans_index: `def __ctrans_index(container: Any, key: Any) -> Any:
    """Python subscript (IndexError/KeyError preserved)."""
    return container[key]`,
  __ctrans_iter: `def __ctrans_iter(value: Any) -> Any:
    """Python iteration semantics (native iterables iterate natively)."""
    return value`,
  __ctrans_contains: `def __ctrans_contains(container: Any, item: Any) -> Any:
    """Python membership (== semantics)."""
    return item in container`,
  // Method dispatch and container surfaces: leg-1 lowers Python method calls on
  // dynamically typed receivers to the callMethod dispatcher (registry v1) and
  // its closure. The round-tripped values ARE Python values, so the Python-
  // semantic bridge is native dispatch — the same semantics the dispatcher
  // re-implemented for JS.
  __ctrans_callMethod: `def __ctrans_callMethod(receiver: Any, name: str, *args: Any) -> Any:
    """Native Python method dispatch (raises AttributeError like Python)."""
    return getattr(receiver, name)(*args)`,
  __ctrans_getattr: `def __ctrans_getattr(obj: Any, name: str) -> Any:
    """Python getattr."""
    return getattr(obj, name)`,
  __ctrans_gt: `def __ctrans_gt(left: Any, right: Any) -> Any:
    """Python >."""
    return left > right`,
  __ctrans_slice: `def __ctrans_slice(value: Any, start: Any = None, end: Any = None, step: Any = None) -> Any:
    """Python slicing (None bounds and negative indices behave natively)."""
    return value[start:end:step]`,
  __ctrans_floatStr: `def __ctrans_floatStr(value: Any) -> str:
    """Python float str (str == repr for floats since 3.1)."""
    return str(value)`,
  __ctrans_listIndex: `def __ctrans_listIndex(items: Any, value: Any) -> Any:
    """list.index (raises ValueError like Python)."""
    return items.index(value)`,
  __ctrans_listCount: `def __ctrans_listCount(items: Any, value: Any) -> Any:
    """list.count."""
    return items.count(value)`,
  __ctrans_listRemove: `def __ctrans_listRemove(items: Any, value: Any) -> None:
    """list.remove (raises ValueError like Python)."""
    items.remove(value)`,
  __ctrans_dictPop: `def __ctrans_dictPop(mapping: Any, key: Any) -> Any:
    """dict.pop (raises KeyError like Python)."""
    return mapping.pop(key)`,
  __ctrans_setRemove: `def __ctrans_setRemove(set_value: Any, value: Any) -> None:
    """set.remove (raises KeyError like Python)."""
    set_value.remove(value)`,
  __ctrans_strSplit: `def __ctrans_strSplit(text: Any, separator: Any = None) -> Any:
    """Python str.split (None splits on whitespace runs, dropping empties)."""
    return text.split(separator)`,
  __ctrans_strJoin: `def __ctrans_strJoin(separator: str, values: Any) -> str:
    """Python separator.join(values)."""
    return separator.join(values)`,
  __ctrans_strCapitalize: `def __ctrans_strCapitalize(text: str) -> str:
    """Python str.capitalize."""
    return text.capitalize()`,
  __ctrans_lt: `def __ctrans_lt(left: Any, right: Any) -> Any:
    """Python < (native comparison semantics)."""
    return left < right`,
  __ctrans_lte: `def __ctrans_lte(left: Any, right: Any) -> Any:
    """Python <=."""
    return left <= right`,
  __ctrans_ge: `def __ctrans_ge(left: Any, right: Any) -> Any:
    """Python >=."""
    return left >= right`,
  __ctrans_abs: `def __ctrans_abs(value: Any) -> Any:
    """Python abs()."""
    return abs(value)`,
  __ctrans_bitAnd: `def __ctrans_bitAnd(left: Any, right: Any) -> Any:
    """Python & (arbitrary-precision ints)."""
    return left & right`,
  __ctrans_bitOr: `def __ctrans_bitOr(left: Any, right: Any) -> Any:
    """Python |."""
    return left | right`,
  __ctrans_bitXor: `def __ctrans_bitXor(left: Any, right: Any) -> Any:
    """Python ^."""
    return left ^ right`,
  __ctrans_lShift: `def __ctrans_lShift(left: Any, right: Any) -> Any:
    """Python <<."""
    return left << right`,
  __ctrans_rShift: `def __ctrans_rShift(left: Any, right: Any) -> Any:
    """Python >> (arithmetic shift on ints)."""
    return left >> right`,
  __ctrans_pow: `def __ctrans_pow(left: Any, right: Any) -> Any:
    """Python ** (0 ** negative raises ZeroDivisionError like Python)."""
    return left ** right`,
  __ctrans_call: `def __ctrans_call(fn: Any, *args: Any) -> Any:
    """Python call (classes construct natively)."""
    return fn(*args)`,
  __ctrans_dictGet: `def __ctrans_dictGet(mapping: Any, key: Any) -> Any:
    """Python d[key] (KeyError for a missing key)."""
    return mapping[key]`,
  __ctrans_enumerate: `def __ctrans_enumerate(values: Any) -> Any:
    """Python enumerate() as (index, item) pairs."""
    return list(enumerate(values))`,
  __ctrans_list: `def __ctrans_list(values: Any = None) -> Any:
    """Python list() (no argument yields an empty list)."""
    return [] if values is None else list(values)`,
  __ctrans_max: `def __ctrans_max(values: Any) -> Any:
    """Python max(iterable) (ValueError on empty)."""
    return max(values)`,
  __ctrans_min: `def __ctrans_min(values: Any) -> Any:
    """Python min(iterable) (ValueError on empty)."""
    return min(values)`,
  __ctrans_next: `def __ctrans_next(iterator: Any) -> Any:
    """Python next() (StopIteration preserved natively)."""
    return next(iterator)`,
  __ctrans_print: `def __ctrans_print(*values: Any) -> None:
    """Python print (space-joined, like the forward helper's console layout)."""
    print(*values)`,
  __ctrans_raiseForStatus: `def __ctrans_raiseForStatus(response: Any) -> None:
    """response.raise_for_status() (raises the response's own exception type)."""
    response.raise_for_status()`,
  __ctrans_range: `def __ctrans_range(start: Any, end: Any = None, step: Any = None) -> Any:
    """Python range() as a list (one argument means range(stop))."""
    if end is None:
        return list(range(start))
    if step is None:
        return list(range(start, end))
    return list(range(start, end, step))`,
  __ctrans_rangeBig: `def __ctrans_rangeBig(start: Any, end: Any = None, step: Any = None) -> Any:
    """Python range() as a list (Python ints are already arbitrary precision)."""
    if end is None:
        return list(range(start))
    if step is None:
        return list(range(start, end))
    return list(range(start, end, step))`,
  __ctrans_reversed: `def __ctrans_reversed(values: Any) -> Any:
    """Python reversed() as a list."""
    return list(reversed(values))`,
  __ctrans_setattr: `def __ctrans_setattr(obj: Any, name: str, value: Any) -> None:
    """Python setattr()."""
    setattr(obj, name, value)`,
  __ctrans_setIndex: `def __ctrans_setIndex(container: Any, key: Any, item: Any) -> None:
    """Python container[key] = item."""
    container[key] = item`,
  __ctrans_sorted: `def __ctrans_sorted(values: Any) -> Any:
    """Python sorted(iterable)."""
    return sorted(values)`,
  __ctrans_sum: `def __ctrans_sum(values: Any) -> Any:
    """Python sum(iterable) (no start value)."""
    return sum(values)`,
  __ctrans_toFloat: `def __ctrans_toFloat(value: Any) -> Any:
    """Python float()."""
    return float(value)`,
  __ctrans_toInt: `def __ctrans_toInt(value: Any) -> Any:
    """Python int()."""
    return int(value)`,
  __ctrans_toIntBig: `def __ctrans_toIntBig(value: Any) -> Any:
    """Python int() (Python ints are already arbitrary precision)."""
    return int(value)`,
  __ctrans_truthy: `def __ctrans_truthy(value: Any) -> bool:
    """Python truthiness (bool()): NaN is truthy (falsy in JS); empty
    containers are FALSY here but truthy in JS — the wrapped divergence.

    This is the ROUND-TRIP bridge (leg-1 wrapped Python truthiness for JS);
    it deliberately differs from codegen-py's own JS-truthy helper of the
    same name — see renderPyRuntime for the collision resolution."""
    return bool(value)`,
  __ctrans_zip: `def __ctrans_zip(*sources: Any) -> Any:
    """Python zip() as a list of tuples (shortest source wins)."""
    return list(zip(*sources))`,
};

// The full runtime module source for the referenced helper union, plus the
// codegen-js bridge definitions needed by round-tripped imports.
export function renderPyRuntime(
  helperNames: readonly string[],
  bridgeNames: readonly string[] = [],
): string {
  const closure = helperClosure(helperNames);
  let code = `"""Generated by Code Translator - JavaScript semantics helpers (D-007: zero runtime dependencies)."""

from typing import Any`;
  for (const name of closure.helpers) {
    const helper = RUNTIME_HELPERS[name];
    if (helper === undefined) continue;
    code += `\n\n${helper.code}`;
  }
  for (const name of [...bridgeNames].sort()) {
    // Same-name collision (D-029): a module that both imports __ctrans_truthy
    // (round-trip, Python semantics wanted) AND lowers its own JS truthiness
    // sites (JS semantics wanted) cannot have both under one name. The
    // module's OWN lowering wins — the JS-truthy def is emitted and this
    // bridge is skipped — so round-tripped truthiness sites in such a mixed
    // module evaluate with JS truthiness (documented divergence; the pure
    // round-trip case, which has no native truthiness sites, is exact).
    if (name === "__ctrans_truthy" && closure.helpers.includes("truthy")) continue;
    const bridge = CODEGEN_JS_RUNTIME_BRIDGE[name];
    if (bridge === undefined) continue;
    code += `\n\n${bridge}`;
  }
  return code;
}
