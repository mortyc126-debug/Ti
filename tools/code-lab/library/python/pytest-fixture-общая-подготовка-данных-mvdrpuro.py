import pytest

@pytest.fixture
def цены():
    return [100, 250, 400]

def test_среднее(цены):
    assert sum(цены) / len(цены) == 250

def test_длина(цены):
    assert len(цены) == 3