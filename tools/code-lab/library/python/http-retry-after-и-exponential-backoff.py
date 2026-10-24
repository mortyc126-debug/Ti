def retry_delay(attempt: int, *, base: float = 0.5, cap: float = 8.0) -> float:
    if attempt < 1:
        raise ValueError("attempt начинается с 1")
    if base <= 0 or cap <= 0:
        raise ValueError("base и cap должны быть положительными")
    return min(cap, base * (2 ** (attempt - 1)))

assert retry_delay(1) == 0.5
assert retry_delay(4) == 4.0
assert retry_delay(10) == 8.0
print("Задержки рассчитаны")
