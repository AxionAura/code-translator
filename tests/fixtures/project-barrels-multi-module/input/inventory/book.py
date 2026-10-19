"""A book record with a small amount of derived behavior."""


class Book:
    def __init__(self, title: str, pages: int):
        self.title = title
        self.pages = pages

    def blurb(self) -> str:
        return f"{self.title} ({self.pages} pages)"

def book_pair() -> list:
    return [Book("Dune", 412), Book("Circe", 393)]
