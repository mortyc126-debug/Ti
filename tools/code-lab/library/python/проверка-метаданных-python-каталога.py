import json
from pathlib import Path


def audit(directory: Path):
    problems = []
    for code in sorted(directory.glob("*.py")):
        meta_path = Path(str(code) + ".meta.json")
        if not meta_path.exists():
            problems.append(f"Нет метаданных: {code.name}")
            continue
        try:
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            problems.append(f"JSON ошибка: {meta_path.name}: {exc}")
            continue
        if meta.get("file") != code.name:
            problems.append(f"Поле file не совпадает: {meta_path.name}")
        for key in ("title", "desc", "group", "tags", "aliases"):
            if not meta.get(key):
                problems.append(f"Нет {key}: {meta_path.name}")
    return problems

with __import__("tempfile").TemporaryDirectory() as tmp:
    d = Path(tmp)
    code = d / "example.py"
    code.write_text("print('ok')", encoding="utf-8")
    (d / "example.py.meta.json").write_text(json.dumps({"file":"example.py","title":"x","desc":"x","group":"x","tags":["x"],"aliases":["x"]}), encoding="utf-8")
    assert audit(d) == []
print("Аудит тестового каталога пройден")
