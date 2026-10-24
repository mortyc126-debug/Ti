# файл test_math.py — запуск: pytest
def сложить(a, b):
    return a + b

def test_сложить():
    assert сложить(2, 3) == 5