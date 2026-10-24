from pathlib import Path
папка = Path("данные")
путь = папка / "цены.csv"
print(путь.name)
print(путь.suffix)
print(путь.exists())
# Создать каталог при необходимости:
# папка.mkdir(parents=True, exist_ok=True)
