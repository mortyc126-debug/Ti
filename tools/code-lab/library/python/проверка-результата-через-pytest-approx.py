import pytest

def среднее(значения):
    return sum(значения) / len(значения)

def test_среднее_с_дробью():
    assert среднее([0.1, 0.2]) == pytest.approx(0.15)
