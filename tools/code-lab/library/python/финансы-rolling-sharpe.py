import numpy as np
import pandas as pd

returns = pd.Series([0.001, -0.002, 0.003, 0.002, 0.001, -0.001] * 5)
risk_free_per_period = 0.0
excess = returns - risk_free_per_period
window = 20
rolling_std = excess.rolling(window, min_periods=window).std(ddof=1)
rolling_sharpe = (excess.rolling(window, min_periods=window).mean() / rolling_std) * np.sqrt(252)
assert rolling_sharpe.iloc[:window-1].isna().all()
assert np.isfinite(rolling_sharpe.iloc[-1])
print(rolling_sharpe.tail())
