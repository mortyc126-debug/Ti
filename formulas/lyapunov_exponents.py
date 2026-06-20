"""
Lyapunov Exponents — Хаотичность
==================================
Показатели Ляпунова λ измеряют скорость экспоненциального расхождения
(или сходимения) изначально близких траекторий в фазовом пространстве:
    |δZ(t)| ≈ |δZ(0)| * e^(λt)

    λ_max > 0  — хаотическая динамика (чувствительность к начальным условиям)
    λ_max ≈ 0  — граница хаоса / периодическая орбита
    λ_max < 0  — устойчивая (предсказуемая) динамика, точка притяжения

Время предсказуемости (Lyapunov time) ≈ 1 / λ_max — горизонт, на котором
прогноз ещё имеет смысл.

Применение в трейдинге:
    — λ_max как количественная мера "хаотичности" текущего режима рынка
    — Горизонт предсказуемости → выбор таймфрейма для прогнозных моделей
    — Рост λ_max → приближение нестабильности / возможного срыва тренда
    — Спектр λ (несколько экспонент) → размерность Каплана-Йорка (сложность аттрактора)
"""

import numpy as np
from typing import Optional


# ---------------------------------------------------------------------------
# Takens embedding (минимальная встроенная копия для самодостаточности)
# ---------------------------------------------------------------------------

def embed(series: np.ndarray, dim: int = 3, tau: int = 1) -> np.ndarray:
    """
    Задержечное вложение Такенса.

    Parameters
    ----------
    series : 1-D временной ряд
    dim    : размерность вложения
    tau    : лаг задержки

    Returns
    -------
    X : 2-D array (N - (dim-1)*tau, dim)
    """
    series = np.asarray(series, dtype=float)
    n = len(series)
    n_out = n - (dim - 1) * tau
    if n_out <= 0:
        raise ValueError(
            f"Ряд слишком короткий для dim={dim}, tau={tau}. "
            f"Нужно минимум {(dim - 1) * tau + 2} точек."
        )
    return np.column_stack([series[i * tau: i * tau + n_out] for i in range(dim)])


def mutual_information_tau(series: np.ndarray, max_tau: int = 30, bins: int = 48) -> int:
    """Подбор оптимального лага τ методом Average Mutual Information."""
    series = np.asarray(series, dtype=float)
    n = len(series)
    edges = np.linspace(series.min(), series.max() + 1e-10, bins + 1)
    ami = np.zeros(max_tau)

    for tau in range(1, max_tau + 1):
        x, y = series[:n - tau], series[tau:]
        hist2d, _, _ = np.histogram2d(x, y, bins=[edges, edges])
        hist2d = hist2d / hist2d.sum()
        hx, hy = hist2d.sum(axis=1), hist2d.sum(axis=0)
        outer = np.outer(hx, hy)
        mask = (hist2d > 0) & (outer > 0)
        ami[tau - 1] = np.sum(hist2d[mask] * np.log(hist2d[mask] / outer[mask]))

    for i in range(1, len(ami) - 1):
        if ami[i] < ami[i - 1] and ami[i] < ami[i + 1]:
            return i + 1
    return 1


def false_nearest_neighbors_dim(
    series: np.ndarray, max_dim: int = 10, tau: int = 1, rtol: float = 10.0,
) -> int:
    """Подбор оптимальной размерности вложения методом FNN."""
    series = np.asarray(series, dtype=float)
    for d in range(1, max_dim + 1):
        X_d  = embed(series, dim=d,     tau=tau)
        X_d1 = embed(series, dim=d + 1, tau=tau)
        n = min(len(X_d), len(X_d1))
        X_d, X_d1 = X_d[:n], X_d1[:n]

        fn_count, total = 0, 0
        for i in range(n):
            dists = np.linalg.norm(X_d - X_d[i], axis=1)
            dists[i] = np.inf
            nn = np.argmin(dists)
            r_d = dists[nn]
            if r_d < 1e-10:
                continue
            r_d1 = np.linalg.norm(X_d1[i] - X_d1[nn])
            if (r_d1 / r_d) > rtol:
                fn_count += 1
            total += 1

        ratio = fn_count / total if total > 0 else 0.0
        if ratio < 0.01:
            return d
    return max_dim


# ---------------------------------------------------------------------------
# Largest Lyapunov Exponent — метод Розенштейна
# ---------------------------------------------------------------------------

def rosenstein_lle(
    X: np.ndarray,
    fs: float = 1.0,
    min_tsep: Optional[int] = None,
    max_steps: int = 20,
) -> dict:
    """
    Оценка наибольшего показателя Ляпунова методом Розенштейна (1993).
    Прямой и устойчивый к шуму метод, не требует длинных рядов.

    Parameters
    ----------
    X         : траекторная матрица из embed()
    fs        : частота дискретизации (1 бар = 1.0)
    min_tsep  : минимальное временное разделение для исключения
                псевдо-соседей (по умолчанию ~ период среднего цикла)
    max_steps : горизонт усреднения расхождения (в шагах)

    Returns
    -------
    dict: lambda1, divergence_curve, fit_steps
    """
    X = np.asarray(X, dtype=float)
    N = len(X)

    if min_tsep is None:
        min_tsep = max(1, N // 20)

    divergence = np.zeros(max_steps)
    counts = np.zeros(max_steps)

    for i in range(N - max_steps):
        dists = np.linalg.norm(X - X[i], axis=1)
        lo, hi = max(0, i - min_tsep), min(N, i + min_tsep + 1)
        dists[lo:hi] = np.inf
        nn = np.argmin(dists)
        if dists[nn] == np.inf or dists[nn] < 1e-10:
            continue

        for s in range(max_steps):
            if i + s < N and nn + s < N:
                d = np.linalg.norm(X[i + s] - X[nn + s])
                if d > 0:
                    divergence[s] += np.log(d / dists[nn])
                    counts[s] += 1

    valid = counts > 0
    if not valid.any():
        return {"lambda1": np.nan, "divergence_curve": divergence, "fit_steps": 0}

    avg_div = np.full(max_steps, np.nan)
    avg_div[valid] = divergence[valid] / counts[valid]

    steps = np.arange(max_steps)[valid].astype(float)
    div_v = avg_div[valid]

    # Линейная подгонка по начальному линейному участку (первые ~60%)
    fit_len = max(2, int(0.6 * len(steps)))
    lambda1 = float(np.polyfit(steps[:fit_len], div_v[:fit_len], 1)[0]) * fs

    return {
        "lambda1":          lambda1,
        "divergence_curve": avg_div,
        "fit_steps":        fit_len,
    }


# ---------------------------------------------------------------------------
# Полный спектр Ляпунова — метод Вольфа (Jacobian-based, QR-разложение)
# ---------------------------------------------------------------------------

def wolf_spectrum(
    X: np.ndarray,
    n_neighbors: int = 1,
    fs: float = 1.0,
) -> dict:
    """
    Оценка полного спектра показателей Ляпунова через локальную линеаризацию
    динамики (метод соседних траекторий + QR-разложение Грама-Шмидта).

    Parameters
    ----------
    X           : траекторная матрица из embed(), форма (N, dim)
    n_neighbors : число соседей для оценки локального якобиана
    fs          : частота дискретизации

    Returns
    -------
    dict: spectrum (array длины dim, по убыванию), sum_positive,
          kaplan_yorke_dim
    """
    X = np.asarray(X, dtype=float)
    N, dim = X.shape

    if N < dim + 5:
        raise ValueError("Недостаточно точек для оценки спектра Ляпунова.")

    k = max(dim + 1, n_neighbors + dim)
    Q = np.eye(dim)
    log_sums = np.zeros(dim)
    n_valid = 0

    for i in range(N - dim - 1):
        # Находим k ближайших соседей текущей точки (исключая саму точку)
        dists = np.linalg.norm(X - X[i], axis=1)
        dists[i] = np.inf
        order = np.argsort(dists)[:k]
        order = order[order < N - 1]  # нужна точка t+1
        if len(order) < dim:
            continue

        # Локальная линейная аппроксимация: dY = J * dX
        dX = (X[order] - X[i]).T              # (dim, k_eff)
        dY = (X[order + 1] - X[i + 1]).T       # (dim, k_eff)

        J, *_ = np.linalg.lstsq(dX.T, dY.T, rcond=None)
        J = J.T  # (dim, dim) якобиан

        # Эволюция базиса Q и QR-разложение (алгоритм Грама-Шмидта/Эккмана-Рюэлля)
        M = J @ Q
        Q, R = np.linalg.qr(M)

        diag_R = np.abs(np.diag(R))
        diag_R = np.where(diag_R < 1e-12, 1e-12, diag_R)
        log_sums += np.log(diag_R)
        n_valid += 1

    if n_valid == 0:
        return {
            "spectrum": np.full(dim, np.nan),
            "sum_positive": np.nan,
            "kaplan_yorke_dim": np.nan,
        }

    spectrum = (log_sums / n_valid) * fs
    spectrum = np.sort(spectrum)[::-1]  # по убыванию

    sum_positive = float(np.sum(spectrum[spectrum > 0]))
    ky_dim = kaplan_yorke_dimension(spectrum)

    return {
        "spectrum":          spectrum,
        "sum_positive":      sum_positive,
        "kaplan_yorke_dim":  ky_dim,
    }


def kaplan_yorke_dimension(spectrum: np.ndarray) -> float:
    """
    Размерность Каплана-Йорка (Lyapunov dimension) — оценка фрактальной
    размерности аттрактора по спектру показателей Ляпунова.

    D_KY = j + (sum_{i=1}^{j} λ_i) / |λ_{j+1}|

    где j — наибольшее число такое, что сумма первых j экспонент ≥ 0.

    Parameters
    ----------
    spectrum : 1-D array показателей Ляпунова, отсортированных по убыванию

    Returns
    -------
    D_KY : размерность Каплана-Йорка
    """
    spectrum = np.asarray(spectrum, dtype=float)
    spectrum = spectrum[~np.isnan(spectrum)]
    if len(spectrum) == 0:
        return np.nan

    cum_sum = np.cumsum(spectrum)
    j = 0
    for i in range(len(cum_sum)):
        if cum_sum[i] < 0:
            break
        j = i + 1

    if j == 0:
        return 0.0
    if j >= len(spectrum):
        return float(len(spectrum))

    return float(j + cum_sum[j - 1] / abs(spectrum[j]))


# ---------------------------------------------------------------------------
# Интерпретация
# ---------------------------------------------------------------------------

def interpret_lyapunov(
    lambda1: float,
    spectrum: Optional[np.ndarray] = None,
    ky_dim: Optional[float] = None,
    fs: float = 1.0,
) -> dict:
    """
    Торговая интерпретация показателей Ляпунова.

    Parameters
    ----------
    lambda1  : наибольший показатель Ляпунова
    spectrum : полный спектр (опционально, из wolf_spectrum())
    ky_dim   : размерность Каплана-Йорка (опционально)
    fs       : частота дискретизации (для расчёта горизонта в барах)

    Returns
    -------
    dict: chaos_level, predictability_horizon, complexity, signal, regime, notes
    """
    if np.isnan(lambda1):
        return {
            "chaos_level": "unknown",
            "predictability_horizon": None,
            "complexity": "unknown",
            "signal": "NO_DATA",
            "regime": "insufficient_data",
            "notes": ["lambda1_is_nan: not enough valid neighbor pairs"],
        }

    # --- Уровень хаоса ---
    if lambda1 <= 0:
        chaos_level = "none"
    elif lambda1 < 0.02:
        chaos_level = "weak"
    elif lambda1 < 0.10:
        chaos_level = "moderate"
    else:
        chaos_level = "strong"

    # --- Горизонт предсказуемости (Lyapunov time) ---
    horizon = (1.0 / lambda1) if lambda1 > 0 else None
    horizon_bars = round(horizon * fs, 1) if horizon is not None else None

    # --- Сложность аттрактора ---
    complexity = "unknown"
    if ky_dim is not None and not np.isnan(ky_dim):
        if ky_dim < 1.5:
            complexity = "simple_periodic"
        elif ky_dim < 3.0:
            complexity = "low_dimensional_chaos"
        elif ky_dim < 6.0:
            complexity = "moderate_complexity"
        else:
            complexity = "high_dimensional_stochastic"

    # --- Торговый сигнал ---
    if chaos_level == "none":
        signal = "TREND_FOLLOWING_SAFE"
        regime = "stable_predictable"
    elif chaos_level == "weak":
        signal = "MODERATE_CONFIDENCE_FORECAST"
        regime = "weakly_chaotic"
    elif chaos_level == "moderate":
        signal = "SHORT_HORIZON_ONLY"
        regime = "moderately_chaotic"
    else:
        signal = "REDUCE_EXPOSURE_HIGH_UNCERTAINTY"
        regime = "strongly_chaotic"

    notes = []
    if horizon_bars is not None and horizon_bars < 5:
        notes.append("very_short_horizon: forecasts unreliable beyond a few bars")
    if complexity == "high_dimensional_stochastic":
        notes.append("attractor_dim_high: dynamics close to pure noise")
    if spectrum is not None and len(spectrum) >= 2 and spectrum[1] > 0:
        notes.append("multiple_positive_exponents: hyperchaos, very unstable")

    return {
        "chaos_level":              chaos_level,
        "predictability_horizon":   horizon_bars,
        "complexity":               complexity,
        "signal":                   signal,
        "regime":                   regime,
        "notes":                    notes,
    }


# ---------------------------------------------------------------------------
# Полный пайплайн
# ---------------------------------------------------------------------------

def lyapunov_signal(
    series: np.ndarray,
    window: Optional[int] = None,
    dim: Optional[int] = None,
    tau: Optional[int] = None,
    auto_params: bool = True,
    method: str = "rosenstein",
    max_steps: int = 20,
    fs: float = 1.0,
) -> dict:
    """
    Универсальная точка входа: ряд → показатель(и) Ляпунова + интерпретация.

    Parameters
    ----------
    series      : временной ряд цен или доходностей
    window      : если задан — берёт последние `window` точек
    dim         : размерность вложения (None = автоподбор)
    tau         : лаг задержки (None = автоподбор)
    auto_params : подобрать τ и m автоматически
    method      : 'rosenstein' (только λ_max, быстрый) |
                  'wolf' (полный спектр + размерность Каплана-Йорка)
    max_steps   : горизонт усреднения для метода Розенштейна
    fs          : частота дискретизации

    Returns
    -------
    dict: lambda1, spectrum (если wolf), kaplan_yorke_dim (если wolf),
          интерпретация
    """
    s = np.asarray(series, dtype=float)
    if window is not None:
        s = s[-window:]

    if auto_params and (dim is None or tau is None):
        if tau is None:
            tau = mutual_information_tau(s)
        if dim is None:
            dim = false_nearest_neighbors_dim(s, tau=tau)

    tau = tau or 1
    dim = dim or 3

    X = embed(s, dim=dim, tau=tau)

    if method == "rosenstein":
        res = rosenstein_lle(X, fs=fs, max_steps=max_steps)
        lambda1 = res["lambda1"]
        interp = interpret_lyapunov(lambda1, fs=fs)
        return {
            "method":  "rosenstein",
            "tau":     tau,
            "dim":     dim,
            "lambda1": round(lambda1, 6) if not np.isnan(lambda1) else None,
            **interp,
        }

    elif method == "wolf":
        spec_res = wolf_spectrum(X, fs=fs)
        spectrum = spec_res["spectrum"]
        ky_dim = spec_res["kaplan_yorke_dim"]
        lambda1 = float(spectrum[0]) if len(spectrum) else np.nan
        interp = interpret_lyapunov(lambda1, spectrum=spectrum, ky_dim=ky_dim, fs=fs)
        return {
            "method":           "wolf",
            "tau":              tau,
            "dim":              dim,
            "lambda1":          round(lambda1, 6) if not np.isnan(lambda1) else None,
            "spectrum":         [round(float(x), 6) for x in spectrum] if not np.all(np.isnan(spectrum)) else None,
            "kaplan_yorke_dim": round(ky_dim, 4) if not np.isnan(ky_dim) else None,
            **interp,
        }

    else:
        raise ValueError("method должен быть 'rosenstein' или 'wolf'")


# ---------------------------------------------------------------------------
# Rolling Lyapunov (для живого потока)
# ---------------------------------------------------------------------------

def rolling_lyapunov(
    series: np.ndarray,
    window: int = 150,
    step: int = 20,
    dim: int = 3,
    tau: int = 1,
    method: str = "rosenstein",
    max_steps: int = 15,
) -> list[dict]:
    """
    Скользящая оценка показателя Ляпунова для живого потока.

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
            res = lyapunov_signal(
                series[start:end], dim=dim, tau=tau,
                auto_params=False, method=method, max_steps=max_steps,
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
    return np.diff(np.log(np.asarray(prices, dtype=float)))


def chaos_trend(lambda_series: list, lookback: int = 10) -> str:
    """
    Определяет тренд хаотичности: растёт ли λ1 со временем (приближение
    нестабильности) или падает (стабилизация режима).

    Parameters
    ----------
    lambda_series : список значений λ1 из rolling_lyapunov() (по времени)
    lookback       : сколько последних значений учитывать

    Returns
    -------
    'increasing' | 'decreasing' | 'flat'
    """
    vals = [v for v in lambda_series[-lookback:] if v is not None]
    if len(vals) < 3:
        return "flat"
    slope = np.polyfit(np.arange(len(vals)), vals, 1)[0]
    if slope > 1e-4:
        return "increasing"
    elif slope < -1e-4:
        return "decreasing"
    return "flat"


# ---------------------------------------------------------------------------
# Пример использования
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    np.random.seed(42)

    # --- Логистическое отображение (классический хаос) ---
    def logistic_map(n, r=3.9, x0=0.4):
        x = np.zeros(n)
        x[0] = x0
        for i in range(1, n):
            x[i] = r * x[i - 1] * (1 - x[i - 1])
        return x

    chaotic = logistic_map(500, r=3.9)
    res_chaotic = lyapunov_signal(chaotic, method="rosenstein", auto_params=True)
    print("Логистическое отображение (r=3.9, известный хаос):")
    print(f"  τ={res_chaotic['tau']}, dim={res_chaotic['dim']}, "
          f"λ1={res_chaotic['lambda1']}")
    print(f"  Chaos level: {res_chaotic['chaos_level']} | "
          f"Horizon: {res_chaotic['predictability_horizon']} баров")
    print(f"  Signal: {res_chaotic['signal']}")

    # --- Периодический ряд (синус, λ1 ≈ 0) ---
    t = np.linspace(0, 40 * np.pi, 500)
    periodic = np.sin(t) + 0.01 * np.random.randn(500)
    res_periodic = lyapunov_signal(periodic, dim=3, tau=5, auto_params=False)
    print("\nПериодический ряд (синус):")
    print(f"  λ1={res_periodic['lambda1']}, "
          f"Chaos level: {res_periodic['chaos_level']}")
    print(f"  Signal: {res_periodic['signal']}")

    # --- Случайное блуждание ---
    rw = np.cumsum(np.random.randn(500))
    res_rw = lyapunov_signal(rw, auto_params=True)
    print("\nСлучайное блуждание:")
    print(f"  λ1={res_rw['lambda1']}, Chaos level: {res_rw['chaos_level']}")
    print(f"  Signal: {res_rw['signal']}")

    # --- Полный спектр Ляпунова (метод Вольфа) ---
    res_wolf = lyapunov_signal(chaotic, dim=3, tau=1, auto_params=False, method="wolf")
    print("\nПолный спектр (логистическое отображение, метод Вольфа):")
    print(f"  spectrum={res_wolf['spectrum']}")
    print(f"  Kaplan-Yorke dim={res_wolf['kaplan_yorke_dim']}")
    print(f"  Complexity: {res_wolf['complexity']}")

    # --- Rolling Lyapunov на ценах ---
    prices = 100 * np.cumprod(1 + np.random.randn(400) * 0.01)
    rolling = rolling_lyapunov(prices, window=150, step=25)
    if rolling:
        last = rolling[-1]
        print(f"\nRolling (idx={last['index']}): λ1={last['lambda1']}, "
              f"signal={last['signal']}")
        lambdas = [r["lambda1"] for r in rolling]
        print(f"Тренд хаотичности: {chaos_trend(lambdas)}")
