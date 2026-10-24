# Из корня проекта после установки Ruff в окружение:
# python -m ruff check .
# python -m ruff check . --fix  # проверьте diff после исправлений
# python -m ruff format .
# Проверка форматирования без изменения файлов:
# python -m ruff format --check .

checks = ["ruff check", "ruff format --check"]
assert len(checks) == 2
print("Команды контроля качества описаны")
