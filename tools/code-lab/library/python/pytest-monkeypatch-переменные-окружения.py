import os


def read_mode() -> str:
    return os.environ.get("APP_MODE", "production")


def test_read_mode_uses_environment(monkeypatch) -> None:
    monkeypatch.setenv("APP_MODE", "test")
    assert read_mode() == "test"


def test_read_mode_default(monkeypatch) -> None:
    monkeypatch.delenv("APP_MODE", raising=False)
    assert read_mode() == "production"
