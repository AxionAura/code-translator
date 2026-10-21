"""Collection benchmark project (authored for this repository, MIT)."""


def total(values: list[int]) -> int:
    result = 0
    for value in values:
        result += value
    return result


def maximum(values: list[int]) -> int:
    best = 0
    seen = False
    for value in values:
        if not seen:
            best = value
            seen = True
        elif value > best:
            best = value
    if not seen:
        raise ValueError("empty")
    return best
