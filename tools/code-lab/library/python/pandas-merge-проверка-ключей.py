import pandas as pd

trades = pd.DataFrame({"symbol": ["A", "A", "B"], "qty": [1, 2, 1]})
prices = pd.DataFrame({"symbol": ["A", "B"], "price": [10.0, 20.0]})
result = trades.merge(prices, on="symbol", how="left", validate="many_to_one")
print(result)
