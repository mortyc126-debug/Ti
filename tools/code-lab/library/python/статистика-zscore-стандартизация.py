import numpy as np

train = np.array([1.0, 2.0, 3.0, 4.0])
mean = train.mean()
std = train.std(ddof=1)
z = (train - mean) / std
assert abs(z.mean()) < 1e-12
assert abs(z.std(ddof=1) - 1.0) < 1e-12
print(z)
