import tempfile

with tempfile.NamedTemporaryFile('w+', encoding='utf-8', suffix='.txt') as f:
    f.write('временные данные')
    f.seek(0)
    print(f.read())