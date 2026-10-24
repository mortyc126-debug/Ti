"""Небольшой пример соглашений PEP 8 без сторонних зависимостей."""

MAX_RETRIES = 3
DEFAULT_TIMEOUT_SECONDS = 5


def calculate_average(values: list[float]) -> float:
    """Вернуть среднее; пустой список считать ошибкой вызывающего кода."""
    if not values:
        raise ValueError("values не должен быть пустым")
    return sum(values) / len(values)


prices = [101.5, 102.0, 100.5]
average_price = calculate_average(prices)
print(f"Средняя цена: {average_price:.2f}")

assert calculate_average([2, 4, 6]) == 4
try:
    calculate_average([])
except ValueError:
    print("Пустой список обработан корректно")
else:
    raise AssertionError("Ожидался ValueError")
