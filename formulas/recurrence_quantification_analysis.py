"""
Recurrence Quantification Analysis (RQA) — Повторяемость состояний
===================================================================
RQA анализирует повторяемость состояний динамической системы через
построение матрицы рекуррентности (RP — Recurrence Plot).

Ключевые метрики:
    RR   (Recurrence Rate)        — доля рекуррентных точек; плотность RP
    DET  (Determinism)            — доля точек на диагональных линиях;
                                    предсказуемость / детерминированность
    LAM  (Laminarity)             — доля точек на вертикальных линиях;
                                    перемежаемость (laminar states)
    L    (Average Diagonal)       — средняя длина диагонали; время предсказания
    Lmax (Max Diagonal)           — макс. диагональ; ≈ 1 / наибольший экспонент Ляпунова
    TT   (Trapping Time)          — среднее время пребывания в состоянии
    ENT  (Entropy of diagonals)   — энтропия Шеннона диагональных линий;
                                    сложность динамики
    DIV  (Divergence)             — 1 / Lmax; скорость расхождения траекторий
"""

import numpy as np
from typing import Optional


# ---------------------------------------------------------------------------
# Утилиты встраивания (Takens delay embedding)
# ---------------------------------------------------------------------------

def embed(
    series: np.ndarray,
    dim: int = 3,
    tau: int = 1,
) -> np.ndarray:
    """
    Задержечное вложение (time-delay embedding) по теореме Такенса.

    Parameters
    ----------
    series : 1-D временной ряд
    dim    : размерность вложения
    tau    : лаг задержки

    Returns
    -------
    X : 2-D array формы (N - (dim-1)*tau, dim)
    """
    series = np.asarray(series, dtype=float)
    n = len(series)
    n_embed = n - (dim - 1) * tau
    if n_embed <= 0:
        raise ValueError(
            f"Ряд слишком короткий для dim={dim}, tau={tau}. "
            f"Нужно минимум {(dim - 1) * tau + 2} точек."
        )
    X = np.array([series[i: i + n_embed] for i in range(0, dim * tau, tau)]).T
    return X


def false_nearest_neighbors(
    series: np.ndarray,
    max_dim: int = 10,
    tau: int = 1,
    rtol: float = 10.0,
) -> np.ndarray:
    """
    Метод ложных ближайших соседей — подбор оптимальной размерности вложения.

    Returns
    -------
    fnn_ratio : 1-D array длиной max_dim — доля ложных соседей для каждой dim
    """
    series = np.asarray(series, dtype=float)
    fnn = np.zeros(max_dim)

    for d in range(1, max_dim + 1):
        X_d = embed(series, dim=d, tau=tau)
        X_d1 = embed(series, dim=d + 1, tau=tau)
        n = min(len(X_d), len(X_d1))
        X_d = X_d[:n]
        X_d1 = X_d1[:n]

        count_fn = 0
        total = 0
        for i in range(n):
            diffs = np.linalg.norm(X_d - X_d[i], axis=1)
            diffs[i] = np.inf
            nn = np.argmin(diffs)
            r_d = diffs[nn]
            if r_d < 1e-10:
                continue
            r_d1 = np.linalg.norm(X_d1[i] - X_d1[nn])
            if (r_d1 / r_d) > rtol:
                count_fn += 1
            total += 1

        fnn[d - 1] = count_fn / total if total > 0 else 0.0

    return fnn


# ---------------------------------------------------------------------------
# Матрица рекуррентности
# ---------------------------------------------------------------------------

def recurrence_matrix(
    X: np.ndarray,
    epsilon: Optional[float] = None,
    metric: str = "euclidean",
    rr_target: float = 0.10,
) -> np.ndarray:
    """
    Строит булеву матрицу рекуррентности R[i,j] = 1 если ||x_i - x_j|| ≤ ε.

    Parameters
    ----------
    X         : 2-D массив траектории (N, dim) из embed()
    epsilon   : порог расстояния; если None — подбирается автоматически
                по rr_target (целевой Recurrence Rate)
    metric    : 'euclidean' | 'maximum' | 'manhattan'
    rr_target : целевой RR для автоподбора epsilon (0..1)

    Returns
    -------
    R : boolean array (N, N)
    """
    X = np.asarray(X, dtype=float)
    N = len(X)

    # Матрица расстояний
    if metric == "euclidean":
        diff = X[:, np.newaxis, :] - X[np.newaxis, :, :]
        D = np.sqrt(np.sum(diff ** 2, axis=-1))
    elif metric == "maximum":
        diff = np.abs(X[:, np.newaxis, :] - X[np.newaxis, :, :])
        D = np.max(diff, axis=-1)
    elif metric == "manhattan":
        diff = np.abs(X[:, np.newaxis, :] - X[np.newaxis, :, :])
        D = np.sum(diff, axis=-1)
    else:
        raise ValueError(f"Неизвестная метрика: {metric}")

    if epsilon is None:
        flat = D[np.triu_indices(N, k=1)]
        epsilon = np.quantile(flat, rr_target)

    R = D <= epsilon
    return R


# ---------------------------------------------------------------------------
# Метрики RQA
# ---------------------------------------------------------------------------

def _diagonal_lines(R: np.ndarray, lmin: int = 2) -> np.ndarray:
    """Длины диагональных линий (параллельных главной диагонали)."""
    N = len(R)
    lengths = []
    for diag in range(-(N - lmin), N - lmin + 1):
        if diag == 0:
            continue
        d = np.diag(R, diag)
        count = 0
        for val in d:
            if val:
                count += 1
            elif count >= lmin:
                lengths.append(count)
                count = 0
        if count >= lmin:
            lengths.append(count)
    return np.array(lengths, dtype=int)


def _vertical_lines(R: np.ndarray, vmin: int = 2) -> np.ndarray:
    """Длины вертикальных линий."""
    N = len(R)
    lengths = []
    for j in range(N):
        col = R[:, j]
        count = 0
        for val in col:
            if val:
                count += 1
            elif count >= vmin:
                lengths.append(count)
                count = 0
        if count >= vmin:
            lengths.append(count)
    return np.array(lengths, dtype=int)


def compute_rqa(
    R: np.ndarray,
    lmin: int = 2,
    vmin: int = 2,
) -> dict:
    """
    Вычисляет все ключевые метрики RQA из матрицы рекуррентности.

    Parameters
    ----------
    R    : boolean recurrence matrix из recurrence_matrix()
    lmin : минимальная длина диагональной линии
    vmin : минимальная длина вертикальной линии

    Returns
    -------
    dict с метриками: RR, DET, LAM, L, Lmax, TT, ENT, DIV
    """
    R = np.asarray(R, dtype=bool)
    N = len(R)

    # --- RR ---
    rr = float(np.sum(R)) / (N * N)

    # --- Диагональные метрики ---
    diag_lines = _diagonal_lines(R, lmin)
    total_recur = np.sum(R) - N  # без главной диагонали

    if len(diag_lines) > 0 and total_recur > 0:
        det = float(np.sum(diag_lines)) / total_recur
        l_avg = float(np.mean(diag_lines))
        l_max = int(np.max(diag_lines))
        # Энтропия Шеннона длин диагоналей
        _, counts = np.unique(diag_lines, return_counts=True)
        probs = counts / counts.sum()
        ent = float(-np.sum(probs * np.log(probs + 1e-12)))
    else:
        det = 0.0
        l_avg = 0.0
        l_max = 0
        ent = 0.0

    div = 1.0 / l_max if l_max > 0 else np.nan

    # --- Вертикальные метрики ---
    vert_lines = _vertical_lines(R, vmin)

    if len(vert_lines) > 0 and total_recur > 0:
        lam = float(np.sum(vert_lines)) / total_recur
        tt = float(np.mean(vert_lines))
    else:
        lam = 0.0
        tt = 0.0

    return {
        "RR":   round(rr,    4),   # Recurrence Rate
        "DET":  round(det,   4),   # Determinism
        "LAM":  round(lam,   4),   # Laminarity
        "L":    round(l_avg, 4),   # Average diagonal length
        "Lmax": l_max,             # Max diagonal length
        "TT":   round(tt,    4),   # Trapping Time
        "ENT":  round(ent,   4),   # Shannon entropy of diagonals
        "DIV":  round(div,   6) if not np.isnan(div) else None,  # Divergence
    }


# ---------------------------------------------------------------------------
# Интерпретация
# ---------------------------------------------------------------------------

def interpret_rqa(metrics: dict) -> dict:
    """
    Торговая интерпретация метрик RQA.

    Parameters
    ----------
    metrics : dict из compute_rqa()

    Returns
    -------
    dict с полями: regime, signal, determinism_level, laminarity_level, notes
    """
    det = metrics["DET"]
    lam = metrics["LAM"]
    rr  = metrics["RR"]
    ent = metrics["ENT"]

    # --- Детерминированность ---
    if det > 0.80:
        det_level = "high"
    elif det > 0.50:
        det_level = "medium"
    else:
        det_level = "low"

    # --- Перемежаемость ---
    if lam > 0.70:
        lam_level = "high"
    elif lam > 0.40:
        lam_level = "medium"
    else:
        lam_level = "low"

    # --- Режим и сигнал ---
    if det > 0.75 and lam > 0.60:
        regime = "structured_trend"
        signal = "TREND_FOLLOWING"
    elif det > 0.75 and lam <= 0.40:
        regime = "deterministic_oscillation"
        signal = "MEAN_REVERSION"
    elif det < 0.40 and rr < 0.05:
        regime = "chaotic_random"
        signal = "NO_TRADE"
    elif lam > 0.70 and det < 0.50:
        regime = "laminar_consolidation"
        signal = "RANGE_BREAKOUT_WATCH"
    elif ent > 2.5:
        regime = "complex_dynamics"
        signal = "REDUCE_POSITION_SIZE"
    else:
        regime = "mixed"
        signal = "NEUTRAL"

    notes = []
    if rr < 0.02:
        notes.append("very_low_recurrence: non-stationary or structural break")
    if rr > 0.40:
        notes.append("high_recurrence: possible over-embedding or constant series")
    if metrics["Lmax"] and metrics["Lmax"] > 50:
        notes.append("long_diagonal: strong determinism, slow divergence")
    if metrics["TT"] > 10:
        notes.append("high_trapping_time: market stuck in state (consolidation)")

    return {
        "regime":             regime,
        "signal":             signal,
        "determinism_level":  det_level,
        "laminarity_level":   lam_level,
        "notes":              notes,
    }


# ---------------------------------------------------------------------------
# Полный пайплайн
# ---------------------------------------------------------------------------

def rqa_signal(
    series: np.ndarray,
    window: Optional[int] = None,
    dim: int = 3,
    tau: int = 1,
    epsilon: Optional[float] = None,
    rr_target: float = 0.10,
    metric: str = "euclidean",
    lmin: int = 2,
    vmin: int = 2,
) -> dict:
    """
    Универсальная точка входа: ряд → метрики RQA + интерпретация.

    Parameters
    ----------
    series    : временной ряд цен или доходностей
    window    : если задан — берёт последние `window` точек
    dim       : размерность вложения
    tau       : лаг задержки
    epsilon   : порог рекуррентности (None = автоподбор)
    rr_target : целевой RR при автоподборе epsilon
    metric    : метрика расстояния
    lmin      : минимальная длина диагонали
    vmin      : минимальная длина вертикали

    Returns
    -------
    dict: metrics (RR, DET, LAM, L, Lmax, TT, ENT, DIV) + interpretation
    """
    s = np.asarray(series, dtype=float)
    if window is not None:
        s = s[-window:]

    X = embed(s, dim=dim, tau=tau)
    R = recurrence_matrix(X, epsilon=epsilon, metric=metric, rr_target=rr_target)
    metrics = compute_rqa(R, lmin=lmin, vmin=vmin)
    interpretation = interpret_rqa(metrics)

    return {**metrics, **interpretation}


# ---------------------------------------------------------------------------
# Rolling RQA (для живого потока)
# ---------------------------------------------------------------------------

def rolling_rqa(
    series: np.ndarray,
    window: int = 150,
    step: int = 10,
    dim: int = 3,
    tau: int = 1,
    rr_target: float = 0.10,
    lmin: int = 2,
    vmin: int = 2,
) -> list[dict]:
    """
    Скользящий RQA: вычисляет метрики для каждого окна.

    Returns
    -------
    results : список dict-ов с метриками + индексом конца окна
    """
    series = np.asarray(series, dtype=float)
    n = len(series)
    results = []

    for end in range(window, n + 1, step):
        start = end - window
        try:
            res = rqa_signal(
                series[start:end],
                dim=dim,
                tau=tau,
                rr_target=rr_target,
                lmin=lmin,
                vmin=vmin,
            )
            res["index"] = end - 1
            results.append(res)
        except (ValueError, np.linalg.LinAlgError):
            pass

    return results


# ---------------------------------------------------------------------------
# Пример использования
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    np.random.seed(42)

    # --- Случайный ряд ---
    random_series = np.random.randn(300)
    res1 = rqa_signal(random_series, dim=3, tau=1)
    print("Random series:")
    print("  Metrics:", {k: v for k, v in res1.items() if k in ("RR","DET","LAM","L","Lmax","ENT")})
    print("  Signal:", res1["signal"], "|", res1["regime"])

    # --- Синусоида (детерминированный ряд) ---
    t = np.linspace(0, 10 * np.pi, 300)
    sine_series = np.sin(t) + 0.1 * np.random.randn(300)
    res2 = rqa_signal(sine_series, dim=3, tau=1)
    print("\nSine series:")
    print("  Metrics:", {k: v for k, v in res2.items() if k in ("RR","DET","LAM","L","Lmax","ENT")})
    print("  Signal:", res2["signal"], "|", res2["regime"])

    # --- Трендовый ряд ---
    trend_series = np.cumsum(np.random.randn(300)) + np.linspace(0, 30, 300)
    res3 = rqa_signal(trend_series, dim=3, tau=1)
    print("\nTrend series:")
    print("  Metrics:", {k: v for k, v in res3.items() if k in ("RR","DET","LAM","L","Lmax","ENT")})
    print("  Signal:", res3["signal"], "|", res3["regime"])

    # --- Rolling RQA ---
    prices = 100 * np.cumprod(1 + np.random.randn(500) * 0.01)
    rolling = rolling_rqa(prices, window=150, step=20, dim=3, tau=1)
    if rolling:
        last = rolling[-1]
        print(f"\nLast rolling window (idx={last['index']}):")
        print("  DET:", last["DET"], "| LAM:", last["LAM"], "| Signal:", last["signal"])
