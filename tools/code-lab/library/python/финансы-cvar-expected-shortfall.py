import numpy as np

pnl = np.array([2.0, 1.0, 0.5, -0.2, -1.0, -3.0, -4.0, 0.1, 0.8, -0.5])
losses = -pnl
alpha = 0.95
var = np.quantile(losses, alpha, method="higher")
tail = losses[losses >= var]
es = tail.mean()
assert es >= var
print({"VaR_loss": float(var), "ES_loss": float(es), "tail_n": int(len(tail))})
