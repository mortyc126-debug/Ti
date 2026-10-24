import pandas as pd

close = pd.Series([100.0, 101.0, 99.0, 102.0])
signal_at_close = pd.Series([1, -1, 1, 1])
next_period_return = close.pct_change().shift(-1)
position_for_period = signal_at_close
strategy_return = position_for_period * next_period_return
# Последняя доходность неизвестна, поэтому последняя строка пропущена.
assert pd.isna(strategy_return.iloc[-1])
assert abs(strategy_return.iloc[0] - 0.01) < 1e-12
print(strategy_return)
