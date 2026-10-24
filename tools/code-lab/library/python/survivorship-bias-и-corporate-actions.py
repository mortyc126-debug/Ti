def validate_point_in_time_rows(rows):
    required = {"symbol", "date", "was_listed", "price_basis"}
    for index, row in enumerate(rows):
        missing = required - row.keys()
        if missing:
            raise ValueError(f"Строка {index}: нет полей {sorted(missing)}")
        if row["price_basis"] not in {"raw", "adjusted"}:
            raise ValueError(f"Строка {index}: неизвестная база цен")
    return True

sample = [{"symbol": "XYZ", "date": "2020-01-02", "was_listed": True, "price_basis": "adjusted"}]
assert validate_point_in_time_rows(sample)
print("Контракт рыночных данных проверен")
