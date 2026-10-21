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
  js_add: {
    name: "js_add",
    requires: ["str_js"],
    code: `def __ctrans_js_add(left: Any, right: Any) -> Any:
    """JS + semantics: string if either side is a string, numeric otherwise.

    Object/stringification goes through __ctrans_str (JS toString), never
    Python's repr-based str()."""
    if isinstance(left, str) or isinstance(right, str):
        return __ctrans_str(left) + __ctrans_str(right)
    if isinstance(left, list) and isinstance(right, list):
        return left + right
    if isinstance(left, (int, float)) and isinstance(right, (int, float)):
        return left + right
    raise TypeError("unsupported operand for +")`,
  },
  str_js: {
    name: "str_js",
    code: `def __ctrans_str(value: Any) -> str:
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
        return ",".join(__ctrans_str(item) for item in value)
    return str(value)`,
  },
  js_mod: {
    name: "js_mod",
    code: `def __ctrans_js_mod(left: Any, right: Any) -> Any:
    """JS % is truncated toward zero; Python's is floored."""
    result = abs(left) % abs(right)
    return -result if left < 0 else result`,
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
        "" if item is None else __ctrans_str(item) for item in items
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
        items.sort(key=__ctrans_str)
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
    """Array.reduce over a JS callback (accumulator, item, index)."""
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
        accumulator = callback(accumulator, items[index], index)
    return accumulator`,
  },
  js_find: {
    name: "js_find",
    code: `def __ctrans_js_find(items: Any, predicate: Any) -> Any:
    """Array.find: first item where JS-truthy(predicate(item)), else None."""
    if not isinstance(items, list):
        raise TypeError("items.find is not a function")
    for index, item in enumerate(items):
        if __ctrans_truthy(predicate(item, index)):
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
    return [item for index, item in enumerate(items) if __ctrans_truthy(predicate(item, index))]`,
  },
  js_map: {
    name: "js_map",
    code: `def __ctrans_js_map(items: Any, callback: Any) -> Any:
    """Array.map: callback receives (item, index) like JS."""
    if not isinstance(items, list):
        raise TypeError("items.map is not a function")
    return [callback(item, index) for index, item in enumerate(items)]`,
  },
  js_for_each: {
    name: "js_for_each",
    code: `def __ctrans_js_for_each(items: Any, callback: Any) -> Any:
    """Array.forEach: callback receives (item, index); returns None like JS."""
    if not isinstance(items, list):
        raise TypeError("items.forEach is not a function")
    for index, item in enumerate(items):
        callback(item, index)
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
    code: `def __ctrans_push(items: Any, *values: Any) -> int:
    """Array.push in expression position: appends and returns the NEW LENGTH."""
    if not isinstance(items, list):
        raise TypeError("items.push is not a function")
    items.extend(values)
    return len(items)`,
  },
  unshift_value: {
    name: "unshift_value",
    code: `def __ctrans_unshift(items: Any, *values: Any) -> int:
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
    code: `import math

def __ctrans_math_call(name: str, *args: Any) -> Any:
    """Math.* surface mapped to the math module (floor/ceil/abs/sqrt/pow/min/max/
    round/trunc/log/exp/log2/log10/sin/cos/tan/atan/atan2/hypot/sign/cbrt)."""
    table = {
        "floor": math.floor,
        "ceil": math.ceil,
        "abs": abs,
        "sqrt": math.sqrt,
        "pow": lambda a, b: a ** b,
        "min": min,
        "max": max,
        "round": lambda value: math.floor(value + 0.5) if value >= 0 else math.ceil(value - 0.5),
        "trunc": math.trunc,
        "log": math.log,
        "exp": math.exp,
        "log2": math.log2,
        "log10": math.log10,
        "sin": math.sin,
        "cos": math.cos,
        "tan": math.tan,
        "atan": math.atan,
        "atan2": math.atan2,
        "hypot": math.hypot,
        "sign": lambda value: 0.0 if value == 0 or value != value else (1.0 if value > 0 else -1.0),
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

// The full runtime module source for the referenced helper union.
export function renderPyRuntime(helperNames: readonly string[]): string {
  const closure = helperClosure(helperNames);
  let code = `"""Generated by Code Translator - JavaScript semantics helpers (D-007: zero runtime dependencies)."""

from typing import Any`;
  for (const name of closure.helpers) {
    const helper = RUNTIME_HELPERS[name];
    if (helper === undefined) continue;
    code += `\n\n${helper.code}`;
  }
  return code;
}
