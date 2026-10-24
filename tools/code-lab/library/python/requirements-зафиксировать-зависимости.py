# Пример содержимого requirements.txt:
# requests==2.32.3
# pytest==8.3.5
#
# Установка в активное виртуальное окружение:
# python -m pip install -r requirements.txt
# Проверка конфликтов зависимостей:
# python -m pip check

requirements = ["requests==2.32.3", "pytest==8.3.5"]
for requirement in requirements:
    name, version = requirement.split("==", maxsplit=1)
    assert name and version
print("Записей зависимостей:", len(requirements))
