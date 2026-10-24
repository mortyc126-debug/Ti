import numpy as np

returns = np.array([0.01, -0.02, 0.015, 0.005, -0.01, 0.02, 0.003])
lag1 = np.corrcoef(returns[1:], returns[:-1])[0, 1]
assert np.isfinite(lag1)
print("lag-1 autocorrelation:", float(lag1))
