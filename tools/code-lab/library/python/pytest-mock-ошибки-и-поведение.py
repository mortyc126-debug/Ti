import pytest


def positive_ratio(numerator: float, denominator: float) -> float:
    if denominator <= 0:
        raise ValueError("denominator должен быть положительным")
    return numerator / denominator


def test_positive_ratio_value() -> None:
    assert positive_ratio(6, 2) == 3


def test_positive_ratio_rejects_zero() -> None:
    with pytest.raises(ValueError, match="положительным"):
        positive_ratio(6, 0)
