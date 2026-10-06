"""Small arithmetic helpers used to pin the fixture format contract."""


def clamp(value: int, low: int = 0, high: int = 100) -> int:
    if value < low:
        return low
    if value > high:
        return high
    return value


def describe(values: list[int]) -> str:
    total = sum(values)
    first = values[0] if values else None
    return f"total={total} first={first} count={len(values)}"


def every_other(text: str) -> str:
    """Every second code point - exercises the slice-with-step helper."""
    return text[::2]


class Counter:
    def __init__(self, start: int = 0) -> None:
        self._count = start

    def bump(self, by: int = 1) -> int:
        self._count += by
        return self._count


def parse_positive(raw: str) -> int:
    value = int(raw)
    if value <= 0:
        raise ValueError(f"not positive: {raw}")
    return value
