"""Control flow: branches, loops with break/continue, range forms, unpacking.
List accumulation uses concatenation (list method mappings arrive with the M5
registry, so fixtures restrict themselves to the supported surface)."""


def label_for(i: int) -> str:
    if i % 15 == 0:
        return "fizzbuzz"
    if i % 3 == 0:
        return "fizz"
    if i % 5 == 0:
        return "buzz"
    return str(i)


def fizzbuzz_like(n: int) -> list[str]:
    return [label_for(i) for i in range(1, n)]


def first_negative(values: list[int]) -> int:
    for value in values:
        if value < 0:
            return value
    return 0


def countdown(start: int) -> list[int]:
    ticks: list[int] = []
    while start > 0:
        ticks = ticks + [start]
        start -= 1
        if len(ticks) >= 10:
            break
    return ticks


def skip_zeroes(values: list[int]) -> int:
    total = 0
    for value in values:
        if value == 0:
            continue
        total += value
    return total


def stepped(start: int, stop: int) -> list[int]:
    seen: list[int] = []
    for i in range(start, stop, 2):
        seen = seen + [i]
    return seen
