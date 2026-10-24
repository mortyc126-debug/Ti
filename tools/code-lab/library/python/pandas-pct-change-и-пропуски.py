import pandas as pd

prices = pd.Series([100.0, 102.0, None, 105.0])
returns = prices.pct_change(fill_method=None)
print(returns)
