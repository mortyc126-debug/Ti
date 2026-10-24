from pathlib import Path


def read_text(path: Path) -> str | None:
    try:
        return path.read_text(encoding="utf-8")
    except FileNotFoundError:
        print(f"Файл не найден: {path.name}")
        return None
    except PermissionError:
        print(f"Нет прав на чтение: {path.name}")
        raise

assert read_text(Path("__definitely_missing_file__.txt")) is None
