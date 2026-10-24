def validate_age(age):
    if age < 0:
        raise ValueError(f"Возраст {age} не может быть отрицательным")
    print(f"Возраст {age} допустим.")

try:
    validate_age(-3)
except ValueError as ошибка:
    print(f"Ошибка валидации: {ошибка}")

# assert подходит для внутренних предположений, но не для проверки пользовательского
# ввода: при запуске Python с флагом -O assert отключается.
assert 2 + 2 == 4
