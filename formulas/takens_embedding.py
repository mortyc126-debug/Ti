"""
Takens Embedding — Восстановление скрытой динамики
===================================================
Теорема Такенса (1981): скалярный временной ряд x(t) можно вложить
в псевдофазовое пространство размерности m через вектора задержек:
    X(t) = [x(t), x(t-τ), x(t-2τ), ..., x(t-(m-1)τ)]

Если m ≥ 2d+1 (d — размерность аттрактора), реконструированное
пространство топологически эквивалентно исходной динамической системе.

Применение в трейдинге:
    — Выявление скрытой детерминированной структуры в ценовом ряде
    — Оценка «сложности» и предсказуемости рыночной динамики
    — Фундамент для RQA, SVM-классификаторов фазы, nearest-neighbor прогнозов
    — Корреляционная размерность как мера рыночной неопределённости
"""

import numpy as np
from typing import Optional


# ---------------------------------------------------------------------------
# Подбор параметров вложения
# ---------------------------------------------------------------------------

def mutual_information_tau(
    series: np.ndarray,
    max_tau: int = 50,
    bins: int = 64,
) -> tuple[np.ndarray, int]:
    """
    Подбор оптимального лага τ методом Average Mutual Information (AMI).
    Оптимальный τ — первый локальный минимум AMI.

    Parameters
    ----------
    series  : 1-D временной ряд
    max_tau : максимальный рассматриваемый лаг
    bins    : число бинов для оценки плотности

    Returns
    -------
    ami     : массив значений AMI для τ = 1..max_tau
    opt_tau : оптимальный лаг (первый локальный минимум)
    """
    series = np.asarray(series, dtype=float)
    n = len(series)
    ami = np.zeros(max_tau)

    # Общая гистограмма для маргинального распределения
    edges = np.linspace(series.min(), series.max() + 1e-10, bins + 1)

    for tau in range(1, max_tau + 1):
        x = series[:n - tau]
        y = series[tau:]

        # Совместная гистограмма
        hist2d, _, _ = np.histogram2d(x, y, bins=[edges, edges])
        hist2d = hist2d / hist2d.sum()

        hx = hist2d.sum(axis=1)
        hy = hist2d.sum(axis=0)

        outer = np.outer(hx, hy)
        mask = (hist2d > 0) & (outer > 0)
        ami[tau - 1] = np.sum(hist2d[mask] * np.log(hist2d[mask] / outer[mask]))

    # Первый локальный минимум
    opt_tau = 1
    for i in range(1, len(ami) - 1):
        if ami[i] < ami[i - 1] and ami[i] < ami[i + 1]:
            opt_tau = i + 1
            break

    return ami, opt_tau


def false_nearest_neighbors(
    series: np.ndarray,
    max_dim: int = 10,
    tau: int = 1,
    rtol: float = 10.0,
    atol: float = 2.0,
) -> tuple[np.ndarray, int]:
    """
    Подбор оптимальной размерности m методом False Nearest Neighbors (FNN).
    Оптимальная m — где доля ложных соседей падает ниже порога (≈ 0.01).

    Parameters
    ----------
    series  : 1-D временной ряд
    max_dim : максимальная рассматриваемая размерность
    tau     : лаг задержки (из mutual_information_tau)
    rtol    : порог относительного расстояния
    atol    : порог абсолютного расстояния (в ед. std)

    Returns
    -------
    fnn_ratio : доля FNN для каждой размерности 1..max_dim
    opt_dim   : оптимальная размерность
    """
    series = np.asarray(series, dtype=float)
    Ra = np.std(series)
    fnn_ratio = np.zeros(max_dim)
    opt_dim = max_dim

    for d in range(1, max_dim + 1):
        X_d  = embed(series, dim=d,     tau=tau)
        X_d1 = embed(series, dim=d + 1, tau=tau)
        n = min(len(X_d), len(X_d1))
        X_d  = X_d[:n]
        X_d1 = X_d1[:n]

        fn_count = 0
        total    = 0

        for i in range(n):
            dists = np.linalg.norm(X_d - X_d[i], axis=1)
            dists[i] = np.inf
            nn = np.argmin(dists)
            r_d = dists[nn]
            if r_d < 1e-10:
                continue
            r_d1 = np.linalg.norm(X_d1[i] - X_d1[nn])
            crit1 = (r_d1 / r_d) > rtol
            crit2 = (r_d1 / Ra)  > atol
            if crit1 or crit2:
                fn_count += 1
            total += 1

        ratio = fn_count / total if total > 0 else 0.0
        fnn_ratio[d - 1] = ratio

        if ratio < 0.01 and opt_dim == max_dim:
            opt_dim = d

    return fnn_ratio, opt_dim


def suggest_parameters(
    series: np.ndarray,
    max_tau: int = 50,
    max_dim: int = 10,
    bins: int = 64,
) -> dict:
    """
    Автоматический подбор (τ, m) для заданного ряда.

    Returns
    -------
    dict: opt_tau, opt_dim, ami (array), fnn_ratio (array)
    """
    series = np.asarray(series, dtype=float)
    ami, opt_tau = mutual_information_tau(series, max_tau=max_tau, bins=bins)
    fnn_ratio, opt_dim = false_nearest_neighbors(series, max_dim=max_dim, tau=opt_tau)

    return {
        "opt_tau":   opt_tau,
        "opt_dim":   opt_dim,
        "ami":       ami,
        "fnn_ratio": fnn_ratio,
    }


# ---------------------------------------------------------------------------
# Вложение
# ---------------------------------------------------------------------------

def embed(
    series: np.ndarray,
    dim: int = 3,
    tau: int = 1,
) -> np.ndarray:
    """
    Задержечное вложение Такенса.

    Parameters
    ----------
    series : 1-D временной ряд
    dim    : размерность вложения (embedding dimension)
    tau    : лаг задержки (embedding lag)

    Returns
    -------
    X : 2-D array формы (N - (dim-1)*tau, dim)
        Каждая строка — вектор состояния в фазовом пространстве
    """
    series = np.asarray(series, dtype=float)
    n = len(series)
    n_out = n - (dim - 1) * tau

    if n_out <= 0:
        raise ValueError(
            f"Ряд слишком короткий для dim={dim}, tau={tau}. "
            f"Нужно минимум {(dim - 1) * tau + 2} точек."
        )

    X = np.column_stack([
        series[i * tau: i * tau + n_out]
        for i in range(dim)
    ])
    return X


def windowed_embed(
    series: np.ndarray,
    dim: int = 3,
    tau: int = 1,
    window: int = 100,
    step: int = 1,
) -> list[np.ndarray]:
    """
    Скользящее вложение: возвращает список траекторных матриц
    для каждого окна размером `window`.
    """
    series = np.asarray(series, dtype=float)
    n = len(series)
    results = []
    for end in range(window, n + 1, step):
        start = end - window
        try:
            X = embed(series[start:end], dim=dim, tau=tau)
            results.append(X)
        except ValueError:
            pass
    return results


# ---------------------------------------------------------------------------
# Анализ реконструированного фазового пространства
# ---------------------------------------------------------------------------

def correlation_dimension(
    X: np.ndarray,
    r_min: Optional[float] = None,
    r_max: Optional[float] = None,
    num_r: int = 20,
) -> tuple[float, np.ndarray, np.ndarray]:
    """
    Корреляционная размерность D2 (алгоритм Грассбергера–Прокаччи).
    Характеризует «сложность» аттрактора.
        D2 ≈ 1   — квазипериодическая динамика
        D2 ≈ 2-3 — детерминированный хаос
        D2 → ∞   — случайный (стохастический) процесс

    Parameters
    ----------
    X     : траекторная матрица из embed()
    r_min : минимальный радиус (None = автоподбор)
    r_max : максимальный радиус (None = автоподбор)
    num_r : число логарифмически равномерных радиусов

    Returns
    -------
    d2    : корреляционная размерность
    rs    : массив радиусов
    C_r   : корреляционный интеграл для каждого r
    """
    X = np.asarray(X, dtype=float)
    N = len(X)

    # Попарные расстояния (верхний треугольник)
    diff = X[:, np.newaxis, :] - X[np.newaxis, :, :]
    D = np.sqrt(np.sum(diff ** 2, axis=-1))
    upper = D[np.triu_indices(N, k=1)]

    if r_min is None:
        r_min = np.percentile(upper, 1)
    if r_max is None:
        r_max = np.percentile(upper, 50)

    r_min = max(r_min, 1e-10)
    rs = np.logspace(np.log10(r_min), np.log10(r_max), num_r)

    total_pairs = len(upper)
    C_r = np.array([np.sum(upper <= r) / total_pairs for r in rs])

    # Линейная регрессия log C(r) ~ D2 * log r
    valid = C_r > 0
    if valid.sum() < 3:
        return 0.0, rs, C_r

    log_r = np.log10(rs[valid])
    log_C = np.log10(C_r[valid])
    d2 = float(np.polyfit(log_r, log_C, 1)[0])

    return d2, rs, C_r


def lyapunov_exponent(
    X: np.ndarray,
    steps: int = 10,
) -> float:
    """
    Оценка наибольшего показателя Ляпунова (метод Розенштейна).
    λ > 0 — хаотическая / непредсказуемая динамика
    λ ≤ 0 — стабильная / периодическая динамика

    Parameters
    ----------
    X     : траекторная матрица из embed()
    steps : число шагов для отслеживания расхождения соседей

    Returns
    -------
    lambda1 : наибольший показатель Ляпунова
    """
    X = np.asarray(X, dtype=float)
    N = len(X)

    divergence = np.zeros(steps)
    counts = np.zeros(steps)

    for i in range(N - steps):
        dists = np.linalg.norm(X - X[i], axis=1)
        dists[max(0, i - 1): i + 2] = np.inf  # исключить временных соседей
        nn = np.argmin(dists)
        if dists[nn] < 1e-10:
            continue

        for s in range(steps):
            if i + s < N and nn + s < N:
                d = np.linalg.norm(X[i + s] - X[nn + s])
                if d > 0:
                    divergence[s] += np.log(d / dists[nn])
                    counts[s] += 1

    valid = counts > 0
    if not valid.any():
        return np.nan

    avg_div = np.where(valid, divergence / np.where(counts > 0, counts, 1), np.nan)
    valid_steps = np.arange(steps)[valid].astype(float)
    avg_div_v = avg_div[valid]

    if len(valid_steps) < 2:
        return float(avg_div_v[0])

    lambda1 = float(np.polyfit(valid_steps, avg_div_v, 1)[0])
    return lambda1


def nearest_neighbor_forecast(
    X: np.ndarray,
    horizon: int = 1,
    k: int = 5,
) -> np.ndarray:
    """
    Прогноз методом ближайших соседей в фазовом пространстве.

    Parameters
    ----------
    X       : траекторная матрица из embed()
    horizon : горизонт прогноза (шаги)
    k       : число ближайших соседей

    Returns
    -------
    forecast : прогнозируемые значения первой координаты (цены)
               для каждой точки траектории
    """
    X = np.asarray(X, dtype=float)
    N = len(X)
    forecast = np.full(N, np.nan)

    for i in range(N - horizon):
        dists = np.linalg.norm(X - X[i], axis=1)
        dists[i] = np.inf
        neighbors = np.argsort(dists)[:k]

        future = []
        for nb in neighbors:
            if nb + horizon < N:
                future.append(X[nb + horizon, 0])

        if future:
            forecast[i] = np.mean(future)

    return forecast


# ---------------------------------------------------------------------------
# Интерпретация
# ---------------------------------------------------------------------------

def interpret_embedding(
    d2: float,
    lambda1: float,
    fnn_last: Optional[float] = None,
) -> dict:
    """
    Торговая интерпретация параметров фазового пространства.

    Parameters
    ----------
    d2        : корреляционная размерность из correlation_dimension()
    lambda1   : наибольший показатель Ляпунова из lyapunov_exponent()
    fnn_last  : последнее значение FNN (опционально)

    Returns
    -------
    dict: regime, signal, predictability, complexity, notes
    """
    # Предсказуемость
    if lambda1 <= 0:
        predictability = "high"
    elif lambda1 < 0.05:
        predictability = "moderate"
    elif lambda1 < 0.20:
        predictability = "low"
    else:
        predictability = "very_low"

    # Сложность динамики
    if d2 < 1.5:
        complexity = "periodic"
    elif d2 < 3.0:
        complexity = "low_dimensional_chaos"
    elif d2 < 6.0:
        complexity = "moderate_chaos"
    else:
        complexity = "high_dimensional_stochastic"

    # Режим и сигнал
    if lambda1 <= 0 and d2 < 2.5:
        regime = "deterministic_predictable"
        signal = "USE_NN_FORECAST"
    elif lambda1 < 0.10 and d2 < 4.0:
        regime = "weakly_chaotic"
        signal = "SHORT_HORIZON_FORECAST"
    elif lambda1 >= 0.10 and d2 >= 4.0:
        regime = "stochastic_chaotic"
        signal = "NO_DETERMINISTIC_EDGE"
    elif d2 < 1.5:
        regime = "quasi_periodic"
        signal = "MEAN_REVERSION"
    else:
        regime = "mixed"
        signal = "NEUTRAL"

    notes = []
    if not np.isnan(lambda1) and lambda1 > 0.30:
        notes.append("high_lyapunov: short prediction horizon only")
    if d2 > 7.0:
        notes.append("very_high_d2: dynamics indistinguishable from noise")
    if fnn_last is not None and fnn_last > 0.20:
        notes.append("high_fnn: consider increasing embedding dimension")

    return {
        "regime":          regime,
        "signal":          signal,
        "predictability":  predictability,
        "complexity":      complexity,
        "notes":           notes,
    }


# ---------------------------------------------------------------------------
# Полный пайплайн
# ---------------------------------------------------------------------------

def takens_signal(
    series: np.ndarray,
    window: Optional[int] = None,
    dim: Optional[int] = None,
    tau: Optional[int] = None,
    auto_params: bool = True,
    lyapunov_steps: int = 10,
    num_r: int = 20,
) -> dict:
    """
    Универсальная точка входа: ряд → параметры вложения + метрики + интерпретация.

    Parameters
    ----------
    series          : временной ряд цен или доходностей
    window          : если задан — берёт последние `window` точек
    dim             : размерность вложения (None = автоподбор)
    tau             : лаг задержки (None = автоподбор)
    auto_params     : подобрать τ и m автоматически, если dim/tau не заданы
    lyapunov_steps  : шаги для оценки λ1
    num_r           : число радиусов для D2

    Returns
    -------
    dict: tau, dim, d2, lambda1, regime, signal, predictability, complexity, notes
    """
    s = np.asarray(series, dtype=float)
    if window is not None:
        s = s[-window:]

    fnn_last = None

    if auto_params and (dim is None or tau is None):
        params = suggest_parameters(s)
        if tau is None:
            tau = params["opt_tau"]
        if dim is None:
            dim = params["opt_dim"]
            fnn_last = float(params["fnn_ratio"][dim - 1])

    tau = tau or 1
    dim = dim or 3

    X = embed(s, dim=dim, tau=tau)
    d2, _, _   = correlation_dimension(X, num_r=num_r)
    lambda1    = lyapunov_exponent(X, steps=lyapunov_steps)
    interp     = interpret_embedding(d2, lambda1, fnn_last)

    return {
        "tau":     tau,
        "dim":     dim,
        "d2":      round(d2, 4),
        "lambda1": round(lambda1, 6) if not np.isnan(lambda1) else None,
        **interp,
    }


# ---------------------------------------------------------------------------
# Rolling Takens (для живого потока)
# ---------------------------------------------------------------------------

def rolling_takens(
    series: np.ndarray,
    window: int = 200,
    step: int = 20,
    dim: int = 3,
    tau: int = 1,
    lyapunov_steps: int = 10,
) -> list[dict]:
    """
    Скользящий анализ вложения Такенса.

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
            res = takens_signal(
                series[start:end],
                dim=dim,
                tau=tau,
                auto_params=False,
                lyapunov_steps=lyapunov_steps,
            )
            res["index"] = end - 1
            results.append(res)
        except (ValueError, np.linalg.LinAlgError):
            pass

    return results


# ---------------------------------------------------------------------------
# Вспомогательные утилиты
# ---------------------------------------------------------------------------

def log_returns(prices: np.ndarray) -> np.ndarray:
    """Логарифмические доходности из массива цен."""
    prices = np.asarray(prices, dtype=float)
    return np.diff(np.log(prices))


def reconstruct_attractor_stats(X: np.ndarray) -> dict:
    """
    Базовая статистика реконструированного аттрактора.

    Returns
    -------
    dict: center, radius, volume_estimate, n_points
    """
    X = np.asarray(X, dtype=float)
    center = X.mean(axis=0)
    dists  = np.linalg.norm(X - center, axis=1)
    return {
        "center":          center.tolist(),
        "radius_mean":     round(float(dists.mean()), 6),
        "radius_std":      round(float(dists.std()),  6),
        "radius_max":      round(float(dists.max()),  6),
        "n_points":        len(X),
        "dim":             X.shape[1],
    }


# ---------------------------------------------------------------------------
# Пример использования
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    np.random.seed(42)

    # --- Случайное блуждание ---
    rw = np.cumsum(np.random.randn(400))
    res1 = takens_signal(rw, auto_params=True)
    print("Random Walk:")
    print(f"  τ={res1['tau']}, m={res1['dim']}, D2={res1['d2']}, λ1={res1['lambda1']}")
    print(f"  Signal: {res1['signal']} | {res1['regime']}")

    # --- Синусоида (детерминированный) ---
    t = np.linspace(0, 20 * np.pi, 400)
    sine = np.sin(t) + 0.05 * np.random.randn(400)
    res2 = takens_signal(sine, dim=3, tau=5, auto_params=False)
    print("\nSine series:")
    print(f"  τ={res2['tau']}, m={res2['dim']}, D2={res2['d2']}, λ1={res2['lambda1']}")
    print(f"  Signal: {res2['signal']} | {res2['regime']}")

    # --- Nearest-neighbor прогноз ---
    prices = 100 * np.cumprod(1 + np.random.randn(300) * 0.01)
    rets   = log_returns(prices)
    X_ret  = embed(rets, dim=3, tau=2)
    fc     = nearest_neighbor_forecast(X_ret, horizon=1, k=5)
    print(f"\nNN Forecast (last 3): {fc[-4:-1].round(5)}")

    # --- Rolling ---
    rolling = rolling_takens(prices, window=150, step=25, dim=3, tau=2)
    if rolling:
        last = rolling[-1]
        print(f"\nLast rolling (idx={last['index']}): "
              f"D2={last['d2']}, λ1={last['lambda1']}, signal={last['signal']}")
