from pathlib import Path


def save_text(path: Path, text: str) -> None:
    path.write_text(text, encoding="utf-8")


def test_save_text_roundtrip(tmp_path: Path) -> None:
    target = tmp_path / "result.txt"
    save_text(target, "данные")
    assert target.read_text(encoding="utf-8") == "данные"
