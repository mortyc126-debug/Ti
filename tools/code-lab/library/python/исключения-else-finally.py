def parse_positive_int(raw):
    try:
        value = int(raw)
    except ValueError as exc:
        raise ValueError("Ожидалось целое число") from exc
    else:
        if value <= 0:
            raise ValueError("Число должно быть положительным")
        return value
    finally:
        # Здесь обычно освобождают ресурс; для примера вывод не нужен.
        pass

assert parse_positive_int("12") == 12
try:
    parse_positive_int("abc")
except ValueError as exc:
    print(exc)
