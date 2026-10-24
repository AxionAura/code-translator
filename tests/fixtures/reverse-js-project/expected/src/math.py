try:
    from ..__ctrans_runtime import (
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
__all__ = ["add", "clamp"]


def add(a, b):
    return _ctrans_js_add(a, b)


def clamp(value, low, high):
    if value < low:
        return low
    if value > high:
        return high
    return value
