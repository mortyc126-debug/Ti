import pytest

def разделить(a, b):
    return a / b

def test_деление_на_ноль():
    with pytest.raises(ZeroDivisionError):
        разделить(1, 0)