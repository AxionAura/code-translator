__all__ = ["mean", "scale"]
from ..math import add

try:
    from ...__ctrans_runtime import (
        __ctrans_js_add as _ctrans_js_add,
        __ctrans_js_div as _ctrans_js_div,
        __ctrans_js_map as _ctrans_js_map,
    )
except ImportError:
    from __ctrans_runtime import (
        __ctrans_js_add as _ctrans_js_add,
        __ctrans_js_div as _ctrans_js_div,
        __ctrans_js_map as _ctrans_js_map,
    )


def mean(values):
    if len(values) == 0:
        return 0
    total = 0
    for value in values:
        total = _ctrans_js_add(total, value)
    return _ctrans_js_div(total, len(values))


def scale(values, factor):
    return _ctrans_js_map(values, lambda value, *_ctrans_extra: add(value, factor))
