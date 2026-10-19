import pytest

from geometry import Point, Rect, unit_rect


@pytest.fixture
def origin():
    return Point(0, 0)


@pytest.fixture
def rect():
    return Rect(0, 0, 10, 5)


def test_translated(origin):
    moved = origin.translated(3, -2)
    assert moved.key() == (3, -2)


def test_contains_true(rect):
    assert rect.contains(Point(9, 4)) is True


def test_contains_false(rect):
    assert rect.contains(Point(10, 4)) is False


def test_unit_rect_area():
    assert unit_rect().area() == 1


class TestRect:
    def test_area(self):
        assert Rect(2, 3, 4, 5).area() == 20

    def test_contains_corner_only(self):
        rect = Rect(0, 0, 2, 2)
        assert rect.contains(Point(0, 0)) is True
        assert rect.contains(Point(2, 2)) is False
