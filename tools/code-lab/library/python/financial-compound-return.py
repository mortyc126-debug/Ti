import math

доходности = [0.10, -0.10]
if any(not math.isfinite(r) or r <= -1 for r in доходности):
    raise ValueError("Доходности должны быть конечными и строго больше -100%")
совокупная = 1.0
for r in доходности:
    совокупная *= 1 + r
совокупная -= 1
print(round(совокупная, 6))
