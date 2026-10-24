def test_write(tmp_path):
    path = tmp_path / 'data.txt'
    path.write_text('привет', encoding='utf-8')
    assert path.read_text(encoding='utf-8') == 'привет'