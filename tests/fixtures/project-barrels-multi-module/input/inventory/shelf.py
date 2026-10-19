"""A shelf aggregates books; exercises cross-module imports and collections."""

from .book import Book


class Shelf:
    def __init__(self):
        self.books = []

    def add(self, book: Book) -> int:
        self.books.append(book)
        return len(self.books)

    def total_pages(self) -> int:
        return sum(book.pages for book in self.books)

    def find(self, title: str):
        for book in self.books:
            if book.title == title:
                return book
        return None

    def titles(self) -> list:
        return [book.title for book in self.books]
