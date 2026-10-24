filename = "report.final.csv"
normalized = filename.replace(".final", "")
assert filename.endswith(".csv")
assert filename.startswith("report")
assert normalized == "report.csv"
print(normalized)
