import numpy as np

values = np.array([10, 11, 12, 12, 13, 14, 100], dtype=float)
q1, q3 = np.quantile(values, [0.25, 0.75])
iqr = q3 - q1
lower, upper = q1 - 1.5 * iqr, q3 + 1.5 * iqr
outliers = values[(values < lower) | (values > upper)]
assert outliers.tolist() == [100.0]
print({"q1": q1, "q3": q3, "iqr": iqr, "outliers": outliers.tolist()})
