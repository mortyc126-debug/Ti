from pathlib import Path

def path_inside(root: Path, user_path: str) -> Path:
    root = root.resolve()
    candidate = (root / user_path).resolve()
    if not candidate.is_relative_to(root):
        raise ValueError("Путь выходит за пределы разрешённого каталога")
    return candidate

if __name__ == "__main__":
    base = Path("./data")
    print(path_inside(base, "prices.csv"))
