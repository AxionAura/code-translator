import pytest

from inventory import Book, Shelf
from inventory.book import book_pair


@pytest.fixture
def shelf():
    return Shelf()


def test_add_tracks_count(shelf):
    assert shelf.add(Book("Dune", 412)) == 1
    assert shelf.add(Book("Circe", 393)) == 2


def test_total_pages(shelf):
    for book in book_pair():
        shelf.add(book)
    assert shelf.total_pages() == 805


def test_find_present_and_missing(shelf):
    shelf.add(Book("Dune", 412))
    assert shelf.find("Dune") is not None
    assert shelf.find("Nope") is None


class TestBook:
    def test_blurb(self):
        book = Book("Circe", 393)
        assert book.blurb() == "Circe (393 pages)"

def test_titles_order(shelf):
    for book in book_pair():
        shelf.add(book)
    assert shelf.titles() == ["Dune", "Circe"]
