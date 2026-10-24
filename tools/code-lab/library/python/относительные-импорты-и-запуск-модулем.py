"""Относительный импорт работает в контексте пакета, а не одиночного файла."""
from pathlib import Path
import subprocess
import sys
import tempfile

with tempfile.TemporaryDirectory() as temp_dir:
    project = Path(temp_dir)
    package = project / "signal_app"
    package.mkdir()
    (package / "__init__.py").write_text("", encoding="utf-8")
    (package / "helpers.py").write_text(
        "def normalize(value):\n"
        "    return value.strip().lower()\n",
        encoding="utf-8",
    )
    (package / "runner.py").write_text(
        "from .helpers import normalize\n"
        "print(normalize('  BUY  '))\n",
        encoding="utf-8",
    )
    # Важно: запускаем как модуль пакета, а не как python signal_app/runner.py.
    result = subprocess.run(
        [sys.executable, "-m", "signal_app.runner"], cwd=project,
        text=True, capture_output=True, check=True,
    )
    print(result.stdout.strip())
    assert result.stdout.strip() == "buy"
    print("Относительный импорт проверен через python -m")
