"""Collection literals, tuple tradeoffs, dict coercion rules and unpacking."""


def warehouse() -> str:
    aisles = ["a1", "a2", "a3"]
    point = (3, 4)
    stock = {"a1": 12, "a2": 7}
    labels = {1, 2, 3}
    return f"aisles={len(aisles)} point={point} stock={stock} labels={labels}"


def swap(pair: list[int]) -> list[int]:
    first, second = pair
    first, second = second, first
    return [first, second]


def merge(base: dict[str, int], extra: dict[str, int]) -> dict[str, int]:
    return {**base, **extra}


def lookup(stock: dict[str, int], key: str) -> int:
    if key in stock:
        return stock[key]
    return 0


def total_count(catalogue: dict[str, int]) -> int:
    total = 0
    for key in catalogue:
        total += catalogue[key]
    return total
