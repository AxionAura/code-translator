__all__ = ["mean", "scale"]
from ..math import add
from ...__ctrans_runtime import __ctrans_js_add, __ctrans_js_map


def mean(values):
    if len(values) == 0:
        return 0
    total = 0
    for value in values:
        total = __ctrans_js_add(total, value)
    return total / len(values)


def scale(values, factor):
    return __ctrans_js_map(values, lambda value: add(value, factor))
