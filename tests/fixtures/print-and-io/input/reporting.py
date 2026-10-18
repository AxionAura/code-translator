"""Print and text conversion (JS direction; Python str() spellings)."""


def report(temperature: float, label: str) -> str:
    print(f"{label}: {temperature}")
    print("done", temperature)
    return str(temperature)


def describe(items: list) -> str:
    return f"items={items} count={len(items)}"
