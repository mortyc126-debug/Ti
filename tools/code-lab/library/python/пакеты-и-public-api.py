"""Показывает пакет, __init__.py и импорт его публичного API.

Демонстрационный пакет создаётся во временном каталоге, поэтому файлы проекта
не меняются. Запуск самого примера не требует сторонних библиотек.
"""
from pathlib import Path
import subprocess
import sys
import tempfile

with tempfile.TemporaryDirectory() as temp_dir:
    project = Path(temp_dir)
    package = project / "market_tools"
    package.mkdir()
    (package / "__init__.py").write_text(
        "from .statistics import mean\n\n__all__ = ['mean']\n",
        encoding="utf-8",
    )
    (package / "statistics.py").write_text(
        "def mean(values):\n"
        "    if not values:\n"
        "        raise ValueError('values не должен быть пустым')\n"
        "    return sum(values) / len(values)\n",
        encoding="utf-8",
    )
    (project / "main.py").write_text(
        "from market_tools import mean\n"
        "print(f'{mean([10, 20, 30]):.1f}')\n",
        encoding="utf-8",
    )
    result = subprocess.run(
        [sys.executable, "main.py"], cwd=project, text=True,
        capture_output=True, check=True,
    )
    print(result.stdout.strip())
    assert result.stdout.strip() == "20.0"
    print("Публичный импорт пакета проверен")
