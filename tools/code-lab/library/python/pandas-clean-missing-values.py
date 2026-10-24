import pandas as pd

raw = pd.DataFrame({"symbol": ["SBER", "SBER", "GAZP"], "price": ["100", "100", "bad"]})
clean = raw.copy()
clean["price"] = pd.to_numeric(clean["price"], errors="coerce")
clean = clean.drop_duplicates(subset=["symbol", "price"])
assert len(clean) == 2
assert clean.loc[clean["symbol"] == "GAZP", "price"].isna().all()
print(clean)
