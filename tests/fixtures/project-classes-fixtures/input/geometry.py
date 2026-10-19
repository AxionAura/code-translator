"""Point/rectangle geometry used by the fixture-based tests."""

class Point:
    def __init__(self, x: int, y: int):
        self.x = x
        self.y = y

    def translated(self, dx: int, dy: int):
        return Point(self.x + dx, self.y + dy)

    def key(self) -> tuple:
        return (self.x, self.y)


class Rect:
    def __init__(self, x: int, y: int, w: int, h: int):
        self.x = x
        self.y = y
        self.w = w
        self.h = h

    def contains(self, point: Point) -> bool:
        in_x = self.x <= point.x and point.x < self.x + self.w
        in_y = self.y <= point.y and point.y < self.y + self.h
        return in_x and in_y

    def area(self) -> int:
        return self.w * self.h


def unit_rect() -> Rect:
    return Rect(0, 0, 1, 1)
