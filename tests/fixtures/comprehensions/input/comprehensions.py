"""Comprehensions: single-for list/set/dict forms and filtered variants."""


def doubles(values: list[int]) -> list[int]:
    return [value * 2 for value in values]


def names_upper(names: list[str]) -> list[str]:
    return [name[0] for name in names if len(name) > 0]


def unique_tags(tags: list[str]) -> set:
    return {tag for tag in tags}


def index_map(keys: list[str]) -> dict:
    return {key: len(key) for key in keys}


def positive_squares(values: list[int]) -> list[int]:
    return [value * value for value in values if value > 0]
