import math

значения = [1.2, float("nan"), float("inf"), -3.0]
корректные = [x for x in значения if math.isfinite(x)]
print(корректные)
print(math.isnan(float("nan")))
