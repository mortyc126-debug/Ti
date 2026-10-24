import pandas as pd

index = pd.to_datetime(["2026-01-05 10:00", "2026-01-05 18:00", "2026-01-06 12:00"])
series = pd.Series([100.0, 102.0, 101.0], index=index)
daily_last = series.resample("D").last().dropna()
assert daily_last.tolist() == [102.0, 101.0]
print(daily_last)
