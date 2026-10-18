"""Deliberately unsupported constructs: each must produce a marker comment, an
`unsupported` ledger decision and a CTW-UNSUPPORTED warning - never invented
behavior (docs/language-support.md §4)."""


def dispatch(value):
    match value:
        case 1:
            return "one"
        case _:
            return "other"


def noted(fn):
    def wrapper():
        return fn()
    return wrapper


@noted
def decorated():
    return 1


class Tracked:
    def __len__(self):
        return 0


async def pull(items):
    async for item in items:
        yield item


class Witnessed(metaclass=type):
    pass


def delete_key(store, key):
    del store[key]
