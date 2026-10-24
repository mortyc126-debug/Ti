rows = [
    {"symbol": "SBER", "timestamp": 2},
    {"symbol": "GAZP", "timestamp": 3},
    {"symbol": "SBER", "timestamp": 1},
]
result = sorted(rows, key=lambda row: (row["symbol"], row["timestamp"]))
assert [(r["symbol"], r["timestamp"]) for r in result] == [("GAZP", 3), ("SBER", 1), ("SBER", 2)]
print(result)
