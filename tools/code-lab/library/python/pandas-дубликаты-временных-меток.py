import pandas as pd

df = pd.DataFrame({
    "time": pd.to_datetime(["2025-01-01 10:00", "2025-01-01 10:00", "2025-01-01 10:01"]),
    "price": [100, 101, 102],
})
duplicates = df[df.duplicated("time", keep=False)]
print(duplicates)
