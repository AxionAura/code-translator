"""String views, templates and slicing behavior (Python code-point slicing via
the helper for arbitrary forms; constant positive slices stay native)."""


def greeting(name: str) -> str:
    return f"Hello, {name}!"


def initials(first: str, last: str) -> str:
    return f"{first[0]}.{last[0]}."


def head(text: str, count: int) -> str:
    return text[:count]


def tail(text: str, count: int) -> str:
    return text[-count:]


def every_second(text: str) -> str:
    return text[::2]


def pad_eq(left: str, right: str) -> bool:
    return left == right


def shout(message: str) -> str:
    return message + "!"
