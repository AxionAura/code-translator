"""Classes: single inheritance, constructors, super, instance attributes."""


class Shape:
    sides = 0

    def __init__(self, name: str) -> None:
        self.name = name
        self.perimeter = 0.0

    def describe(self) -> str:
        return f"{self.name} with {Shape.sides} sides"


class Square(Shape):
    def __init__(self, size: float) -> None:
        super().__init__("square")
        self.size = size
        self.perimeter = size * 4

    def scale(self, factor: float) -> float:
        self.perimeter = self.perimeter * factor
        return self.perimeter


def widest(squares: list[Square]) -> float:
    best = 0.0
    for square in squares:
        if square.perimeter > best:
            best = square.perimeter
    return best
