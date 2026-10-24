# Из корня проекта, где находится pyproject.toml:
# python -m pip install -e .
# Проверить, какой пакет импортируется:
import importlib.util
spec = importlib.util.find_spec("json")
assert spec is not None
print("Стандартный модуль найден:", spec.name)
