def divide(a, b):
    if b == 0:
        raise ValueError(f"Деление на ноль: {a} / {b}")
    return a / b

try:
    result = divide(10, 0)
except ValueError as e:
    # Выбрасываем новую ошибку с дополнительной информацией
    raise RuntimeError(f"Ошибка в делении: {e} — проверьте входные данные!") from e

# Пример вызова:
# RuntimeError: Ошибка в делении: Деление на ноль: 10 / 0 — проверьте входные данные!
# Причина: ValueError: Деление на ноль: 10 / 0