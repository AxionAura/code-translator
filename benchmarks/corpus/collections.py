"""Collection processing helpers; benchmark corpus input."""


def total(values):
    result = 0
    for value in values:
        result += value
    return result


def positives(values):
    selected = []
    for value in values:
        if value > 0:
            selected.append(value)
    return selected


def index_of(values, wanted):
    for index, value in enumerate(values):
        if value == wanted:
            return index
    return -1
