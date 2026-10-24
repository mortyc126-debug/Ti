import math
import statistics

returns = [0.01, -0.02, 0.015, 0.03, -0.01]
if len(returns) < 2:
    raise ValueError("Для выборочного стандартного отклонения нужны минимум две доходности")
if any(not math.isfinite(r) for r in returns):
    raise ValueError("Доходности должны быть конечными числами")
volatility = statistics.stdev(returns)
print(volatility)
