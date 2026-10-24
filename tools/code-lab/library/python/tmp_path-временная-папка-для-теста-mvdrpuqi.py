def test_запись_файла(tmp_path):
    файл = tmp_path / "данные.txt"
    файл.write_text("привет", encoding="utf-8")

    assert файл.read_text(encoding="utf-8") == "привет"