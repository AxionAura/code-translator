"""Text utilities: parsing, normalization, membership behavior."""

DIGITS = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"]


def parse_int(text: str) -> int:
    negative = text.startswith("-")
    body = text[1:] if negative else text
    if body == "":
        raise ValueError("empty number")
    total = 0
    for character in body:
        if character not in DIGITS:
            raise ValueError("bad digit")
        total = total * 10 + DIGITS.index(character)
    return -total if negative else total


def word_count(text: str) -> int:
    return len([word for word in text.split(" ") if word != ""])


def is_palindrome(text: str) -> bool:
    lowered = text.lower()
    stripped = lowered.replace(" ", "")
    return stripped == stripped[::-1]


def initials(names: str) -> str:
    parts = names.split(" ")
    kept = [part[0] for part in parts if part != ""]
    separator = "."
    return separator.join(kept) + "."
