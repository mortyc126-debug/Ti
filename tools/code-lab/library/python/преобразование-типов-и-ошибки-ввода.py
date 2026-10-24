import math

def parse_price(raw: str) -> float:
    try:
        value = float(raw)
    except ValueError as exc:
        raise ValueError(f"Некорректная цена: {raw!r}") from exc
    if not math.isfinite(value) or value < 0:
        raise ValueError("Цена должна быть конечной и неотрицательной")
    return value

if __name__ == "__main__":
    print(parse_price("12.5"))
