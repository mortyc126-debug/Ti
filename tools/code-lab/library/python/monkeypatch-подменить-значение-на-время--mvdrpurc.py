import os

def имя_пользователя():
    return os.environ.get("USER_NAME", "гость")

def test_подмена_переменной(monkeypatch):
    monkeypatch.setenv("USER_NAME", "Аня")
    assert имя_пользователя() == "Аня"