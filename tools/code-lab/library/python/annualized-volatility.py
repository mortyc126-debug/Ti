import math
import statistics

доходности = [0.01, -0.02, 0.015, 0.03, -0.01]
периодов_в_году = 252
if len(доходности) < 2 or периодов_в_году <= 0:
    raise ValueError("Нужно минимум две доходности и положительная частота")
if any(not math.isfinite(r) for r in доходности):
    raise ValueError("Доходности должны быть конечными числами")
периодическая = statistics.stdev(доходности)
годовая = периодическая * math.sqrt(периодов_в_году)
print(round(периодическая, 6), round(годовая, 6))
