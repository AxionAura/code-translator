"""Shapes exported by the package."""


class Point:
    def __init__(self, x: int, y: int) -> None:
        self.x = x
        self.y = y

    def taxicab(self) -> int:
        return self.x + self.y


def origin() -> Point:
    return Point(0, 0)
