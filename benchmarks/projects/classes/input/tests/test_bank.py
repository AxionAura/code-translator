import pytest

from bank import Account


def test_deposit_and_withdraw():
    account = Account("alice", 10)
    assert account.deposit(5) == 15
    assert account.withdraw(7) == 8


def test_overdraft():
    account = Account("bob")
    with pytest.raises(ValueError):
        account.withdraw(1)
