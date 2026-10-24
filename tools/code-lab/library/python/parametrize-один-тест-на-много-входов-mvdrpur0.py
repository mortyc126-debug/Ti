import pytest

@pytest.mark.parametrize("a, b, ожидается", [
    (1, 2, 3),
    (0, 0, 0),
    (-1, 1, 0),
])
def test_сложить(a, b, ожидается):
    assert a + b == ожидается