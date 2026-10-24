import numpy as np

def _усреднить_диагонали(матрица):
    """Восстановить временной ряд усреднением антидиагоналей матрицы."""
    длина = матрица.shape[0] + матрица.shape[1] - 1
    суммы = np.zeros(длина, dtype=float)
    количества = np.zeros(длина, dtype=int)
    for i in range(матрица.shape[0]):
        for j in range(матрица.shape[1]):
            суммы[i + j] += матрица[i, j]
            количества[i + j] += 1
    return суммы / количества

def ssa_первая_компонента(ряд, L):
    """Восстановить ряд из первой ранговой компоненты SSA.

    Первая компонента не обязательно является трендом: для выделения тренда
    нужно обоснованно выбрать несколько компонент и суммировать их.
    """
    ряд = np.asarray(ряд, dtype=float)
    if ряд.ndim != 1:
        raise ValueError("Ряд должен быть одномерным")
    if not np.all(np.isfinite(ряд)):
        raise ValueError("Ряд должен содержать только конечные числа")
    if not isinstance(L, (int, np.integer)) or isinstance(L, (bool, np.bool_)):
        raise ValueError("Длина окна L должна быть целым числом")
    if not 2 <= L < len(ряд):
        raise ValueError("Длина окна L должна быть от 2 до длины ряда - 1")
    K = len(ряд) - L + 1
    X = np.column_stack([ряд[i:i + L] for i in range(K)])
    U, S, Vt = np.linalg.svd(X, full_matrices=False)
    X0 = S[0] * np.outer(U[:, 0], Vt[0])
    return _усреднить_диагонали(X0)

ряд = [10, 12, 11, 14, 15, 17, 16, 19]
print(ssa_первая_компонента(ряд, L=4).round(2).tolist())
