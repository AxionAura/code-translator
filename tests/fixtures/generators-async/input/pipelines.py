"""Generators and async syntax within the supported M4 subset."""


def countdown_gen(limit: int):
    current = limit
    while current > 0:
        yield current
        current -= 1
    yield 0


def squares_gen(values: list[int]):
    for value in values:
        yield value * value


async def fetch_answer() -> int:
    return 42


async def compose_answer() -> int:
    answer = await fetch_answer()
    return answer + 1
