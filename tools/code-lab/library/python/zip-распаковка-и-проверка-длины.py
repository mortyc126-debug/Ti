names = ["A", "B", "C"]
prices = [10, 20]
print(list(zip(names, prices)))  # третья запись потеряна
try:
    print(list(zip(names, prices, strict=True)))
except ValueError as exc:
    print(type(exc).__name__, exc)
