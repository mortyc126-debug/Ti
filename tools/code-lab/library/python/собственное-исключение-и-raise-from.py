def прочитать_цену(значение):
    try:
        return float(значение)
    except (TypeError, ValueError) as ошибка:
        raise ValueError(f"Некорректная цена: {значение!r}") from ошибка

print(прочитать_цену("275.4"))
