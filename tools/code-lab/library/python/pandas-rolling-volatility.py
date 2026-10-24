import pandas as pd

доходности = pd.Series([0.01, -0.02, 0.015, 0.03, -0.01])
окно = 3
волатильность = доходности.rolling(window=окно, min_periods=окно).std(ddof=1)
print(волатильность.round(6).tolist())
