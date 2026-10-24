import py_compile
from pathlib import Path


def compile_all(directory: Path):
    failures = []
    for source in sorted(directory.glob("*.py")):
        try:
            compile(source.read_text(encoding="utf-8"), str(source), "exec")
        except (SyntaxError, UnicodeDecodeError) as exc:
            failures.append((source.name, str(exc)))
    return failures

with __import__("tempfile").TemporaryDirectory() as tmp:
    d = Path(tmp)
    (d / "good.py").write_text("x = 1\n", encoding="utf-8")
    assert compile_all(d) == []
print("Smoke test синтаксиса пройден")
