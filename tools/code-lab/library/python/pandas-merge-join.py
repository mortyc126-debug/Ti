import pandas as pd

prices = pd.DataFrame({"symbol": ["SBER", "GAZP"], "close": [100, 50]})
instruments = pd.DataFrame({"symbol": ["SBER", "GAZP"], "name": ["Sberbank", "Gazprom"]})
joined = prices.merge(instruments, on="symbol", how="left", validate="many_to_one")
assert joined["name"].notna().all()
assert len(joined) == len(prices)
print(joined)
