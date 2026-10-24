import pandas as pd

trades = pd.DataFrame({"symbol": ["SBER", "SBER", "GAZP"], "qty": [2, 3, 4], "price": [100, 102, 50]})
summary = trades.groupby("symbol", as_index=False).agg(
    trade_count=("qty", "size"), total_qty=("qty", "sum"), mean_price=("price", "mean")
)
sber = summary.loc[summary["symbol"] == "SBER"].iloc[0]
assert sber["trade_count"] == 2
assert sber["total_qty"] == 5
assert sber["mean_price"] == 101
print(summary)
