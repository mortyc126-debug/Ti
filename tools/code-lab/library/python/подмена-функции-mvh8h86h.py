import sys
from unittest.mock import patch

def get_price():
    return 100

def test_price():
    # patch.object работает и когда имя импортированного модуля содержит дефисы.
    with patch.object(sys.modules[__name__], "get_price", return_value=5):
        assert get_price() == 5
