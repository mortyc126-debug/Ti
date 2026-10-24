from pathlib import Path
path = Path("example-temp.txt")
with path.open("w", encoding="utf-8") as file:
    file.write("цена: 125")
with path.open("a", encoding="utf-8") as file:
    file.write("\nобъём: 10")
with path.open("r", encoding="utf-8") as file:
    print(file.read())
path.unlink()
