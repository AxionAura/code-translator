from calc import add, floor_div


def test_add():
    assert add(2, 3) == 5


def test_floor_div():
    assert floor_div(7, 2) == 3
