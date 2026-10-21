import pytest

from stats import maximum, total


def test_total():
    assert total([1, 2, 3]) == 6
    assert total([]) == 0


def test_maximum():
    assert maximum([4, 9, 2]) == 9


def test_maximum_empty():
    with pytest.raises(ValueError):
        maximum([])
