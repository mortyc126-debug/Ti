import math
import statistics

доходности = [0.01, -0.02, 0.015, 0.03, -0.01]
безрисковая_за_период = 0.001
if not math.isfinite(безрисковая_за_период) or any(not math.isfinite(r) for r in доходности):
    raise ValueError("Доходности и безрисковая ставка должны быть конечными")
избыточные = [r - безрисковая_за_период for r in доходности]
if len(избыточные) < 2:
    raise ValueError("Для оценки стандартного отклонения нужны минимум две точки")
волатильность = statistics.stdev(избыточные)
if волатильность == 0:
    raise ZeroDivisionError("Шарп не определён при нулевой волатильности")
шарп = statistics.mean(избыточные) / волатильность
print(round(шарп, 4))
