"""Operator behavior pinned to Python semantics, expressed on statically typed
values where possible; dynamic operands route through runtime helpers."""


def clamp(value: int, low: int, high: int) -> int:
    if value < low:
        return low
    if value > high:
        return high
    return value


def average(values: list[int]) -> float:
    total = 0
    for value in values:
        total += value
    return total / len(values)


def is_leap(year: int) -> bool:
    return (year % 4 == 0 and year % 100 != 0) or year % 400 == 0


def spread(a: float, b: float) -> float:
    if a > b:
        return a - b
    return b - a


def classify(score: int, low: int, high: int) -> str:
    if score < low:
        return "low"
    if score > high:
        return "high"
    return "middle"


def label(price: float, discount: float) -> str:
    net = price - price * discount
    return f"price={net}" if discount > 0 else f"price={price}"


def power_sum(x: int, y: int) -> int:
    return x ** 2 + y ** 2


def first_char(text: str) -> str:
    if len(text) == 0:
        return ""
    return text[0]
