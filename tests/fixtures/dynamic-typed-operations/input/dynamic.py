"""Dynamically typed operations: helpers carry Python semantics (never silent
coercion). All of this output must stay type-valid TypeScript (`unknown`)."""


def combine(a, b):
    return a + b


def ordered(a, b):
    if a < b:
        return -1
    if a > b:
        return 1
    return 0


def scaled(value, factor):
    return value * factor


def element_at(seq, i):
    return seq[i]


def sliced(seq, start, stop):
    return seq[start:stop]


def contains_item(items, wanted):
    return wanted in items


def measure(items):
    return len(items)
