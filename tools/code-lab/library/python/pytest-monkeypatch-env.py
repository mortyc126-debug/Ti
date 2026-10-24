import os


def get_mode():
    return os.getenv("APP_MODE", "production")


def test_mode_from_environment(monkeypatch):
    monkeypatch.setenv("APP_MODE", "test")
    assert get_mode() == "test"
