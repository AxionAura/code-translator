"""Deterministic arithmetic helpers; benchmark corpus input."""


def add(left: int, right: int) -> int:
    return left + right


def floor_div(left: int, right: int) -> int:
    return left // right


def clamp(value: int, low: int, high: int) -> int:
    if value < low:
        return low
    if value > high:
        return high
    return value
