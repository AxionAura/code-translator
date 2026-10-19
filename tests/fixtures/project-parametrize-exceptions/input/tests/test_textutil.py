import pytest

from textutil import initials, is_palindrome, parse_int, word_count


@pytest.mark.parametrize("text,expected", [("7", 7), ("-42", -42), ("0", 0)])
def test_parse_int_valid(text, expected):
    assert parse_int(text) == expected


@pytest.mark.parametrize("text", ["12a", "x", "-"])
def test_parse_int_invalid(text):
    with pytest.raises(ValueError):
        parse_int(text)


def test_parse_int_empty_raises():
    with pytest.raises(ValueError):
        parse_int("")


def test_word_count():
    assert word_count("a b  c") == 3
    assert word_count("") == 0


@pytest.mark.parametrize("text", ["racecar", "never odd or even", "step on no pets"])
def test_palindromes(text):
    assert is_palindrome(text) is True


@pytest.mark.parametrize("text", ["hello", "world"])
def test_not_palindromes(text):
    assert is_palindrome(text) is False


def test_initials():
    assert initials("Ada Lovelace Byron") == "A.L.B."


def test_parse_int_digits_membership():
    assert "3" in "123"
    assert "9" not in "123"
