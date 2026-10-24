import pandas as pd

def drawdown(equity):
    equity = pd.Series(equity, dtype="float64")
    if equity.empty or (equity <= 0).any():
        raise ValueError("Капитал должен быть непустым и положительным")
    peak = equity.cummax()
    return equity / peak - 1.0

print(drawdown([100, 110, 105, 120, 90]).round(4).tolist())
