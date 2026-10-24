import numpy as np

sample = np.array([1.2, 0.8, -0.1, 1.5, 0.4, 0.9])
rng = np.random.default_rng(7)
means = np.array([rng.choice(sample, size=len(sample), replace=True).mean() for _ in range(5000)])
low, high = np.quantile(means, [0.025, 0.975])
assert low < sample.mean() < high
print({"mean": sample.mean(), "ci95": (low, high)})
