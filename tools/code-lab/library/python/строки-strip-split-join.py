raw = "  MOEX   futures\n"
clean = raw.strip()
parts = clean.split()
result = ", ".join(parts)
print(parts)
print(result)
assert parts == ["MOEX", "futures"]
assert result == "MOEX, futures"
