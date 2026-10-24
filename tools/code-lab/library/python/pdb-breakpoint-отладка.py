def normalize_price(value: float) -> float:
    result = round(value, 2)
    # Для интерактивной отладки временно добавьте сюда: breakpoint()
    return result

assert normalize_price(10.126) == 10.13
print("Результат:", normalize_price(10.126))
