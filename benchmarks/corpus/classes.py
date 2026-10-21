"""Small class hierarchy; benchmark corpus input."""


class Shape:
    def __init__(self, name):
        self.name = name

    def describe(self):
        return self.name


class Rectangle(Shape):
    def __init__(self, width, height):
        super().__init__("rectangle")
        self.width = width
        self.height = height

    def area(self):
        return self.width * self.height
