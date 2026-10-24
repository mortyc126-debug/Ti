from pathlib import Path
корень = Path(".")
for путь in корень.rglob("*.py"):
    if путь.is_file():
        print(путь)
