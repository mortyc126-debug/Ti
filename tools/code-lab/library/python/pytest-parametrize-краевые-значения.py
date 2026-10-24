import pytest

def positive_sum(values):
    if not values:
        return 0
    return sum(values)

@pytest.mark.parametrize("values, expected", [
    ([1, 2], 3),
    ([], 0),
    ([-2, 2], 0),
])
def test_positive_sum(values, expected):
    assert positive_sum(values) == expected
