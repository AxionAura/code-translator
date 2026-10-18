"""Consumer module: relative imports resolved through the ModuleGraph."""

from .shapes import Point


def manhattan(a: Point, b: Point) -> int:
    return (a.x - b.x) + (a.y - b.y)


def route() -> int:
    point = Point(2, 3)
    return point.taxicab()
