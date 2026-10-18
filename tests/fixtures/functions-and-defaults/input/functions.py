"""Functions: defaults (constant/mutable/expression), closures, nested defs."""


def greeting(name: str, punctuation: str = "!") -> str:
    return f"Hi {name}{punctuation}"


def add_offset(value: int, offset: int = 10) -> int:
    return value + offset


def collect(seed: list = None):
    if seed is None:
        seed = []
    return seed


def counter_factory(start: int = 0):
    count = start

    def bump(by: int = 1) -> int:
        nonlocal count
        count += by
        return count

    return bump


def make_validator(limit: int):
    def validate(value: int) -> bool:
        return value <= limit

    return validate
