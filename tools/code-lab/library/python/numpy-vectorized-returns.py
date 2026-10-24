import numpy as np

цены = np.array([100.0, 105.0, 102.0])
if цены.ndim != 1 or len(цены) < 2:
    raise ValueError("Нужен одномерный ряд минимум из двух цен")
if not np.all(np.isfinite(цены)) or np.any(цены <= 0):
    raise ValueError("Цены должны быть конечными и положительными")
доходности = цены[1:] / цены[:-1] - 1
print(доходности.tolist())
