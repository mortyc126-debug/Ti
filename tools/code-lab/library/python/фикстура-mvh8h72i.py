import pytest

@pytest.fixture
def user():
    return {'name': 'Анна', 'age': 31}

def test_name(user):
    assert user['name'] == 'Анна'