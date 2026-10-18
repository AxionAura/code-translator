"""Iteration and builtin migration paths exercised against the JavaScript target.
The JS direction claims level 1 only (S2 is TypeScript-only, reported skipped)."""


def walk(values):
    total = 0
    for value in values:
        total += value
    return total


def text_loop(text: str) -> int:
    count = 0
    for ch in text:
        if ch == "a":
            count += 1
    return count


def summarize(items) -> str:
    return str(len(items)) + ":" + str(sum([1, 2, 3]))


def hold(temperature: float) -> bool:
    if temperature > 100:
        raise ValueError("boiling")
    return temperature < 0
