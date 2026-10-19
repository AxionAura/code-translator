"""Inventory package barrel: the public surface of the submodules."""

from .book import Book
from .shelf import Shelf

__all__ = ["Book", "Shelf"]
