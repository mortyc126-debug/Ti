"""
Koopman Spectral Analysis — Скрытые частоты
=============================================
Оператор Купмана K — линейный (но бесконечномерный) оператор, который
описывает эволюцию наблюдаемых функций g(x) нелинейной динамической
системы:
    g(x_{t+1}) = K g(x_t)

Вместо изучения нелинейной системы в исходных координатах, Купман-анализ
ищет конечномерное линейное приближение K через измерения. Спектр K
(собственные значения λ и моды φ) раскрывает:
    — Скрытые частоты (через arg(λ))
    — Скорости роста/затухания мод (через |λ|)
    — Пространственные (структурные) паттерны (через собственные векторы)

Практическая реализация — Dynamic Mode Decomposition (DMD),
которая аппроксимирует K на основе данных (data-driven).

Применение в трейдинге:
    — Извлечение скрытых периодических компонент рынка без EMD/Фурье
    — Растущие/затухающие моды → зарождение/затухание тренда
    — Чисто мнимые λ (|λ| ≈ 1) → устойчивые циклы (mean-reversion)
    — |λ| > 1 → нестабильность, потенциальный пробой/импульс
    — Прогноз через линейную экстраполяцию мод
"""

import numpy as np
from typing import Optional


# ---------------------------------------------------------------------------
# Построение матрицы Ганкеля (delay embedding для DMD)
# ---------------------------------------------------------------------------

def hankel_embed(
    series: np.ndarray,
    n_delays: int = 10,
) -> np.ndarray:
    """
    Строит матрицу Ганкеля (delay-coordinate embedding) для применения DMD
    к скалярному временному ряду (Hankel-DMD / HAVOK-подход).

    Parameters
    ----------
    series   : 1-D временной ряд
    n_delays : число задержек (строк в матрице Ганкеля)

    Returns
    -------
    H : 2-D array формы (n_delays, N - n_delays + 1)
    """
    series = np.asarray(series, dtype=float)
    n = len(series)
    n_cols = n - n_delays + 1

    if n_cols < 2:
        raise ValueError(
            f"Ряд слишком короткий для n_delays={n_delays}. "
            f"Нужно минимум {n_delays + 1} точек."
        )

    H = np.array([series[i: i + n_cols] for i in range(n_delays)])
    return H


# ---------------------------------------------------------------------------
# Dynamic Mode Decomposition (ядро Купман-анализа)
# ---------------------------------------------------------------------------

def compute_dmd(
    X: np.ndarray,
    rank: Optional[int] = None,
    dt: float = 1.0,
) -> dict:
    """
    Exact DMD (Tu et al., 2014) — аппроксимация оператора Купмана.

    Parameters
    ----------
    X    : 2-D array (n_features, n_snapshots) — данные состояния по времени
           (например, матрица Ганкеля из hankel_embed())
    rank : ранг усечения SVD (truncation); None = полный ранг
    dt   : шаг времени между снимками (1 бар = 1.0)

    Returns
    -------
    dict:
        eigvals     — собственные значения λ оператора Купмана (комплексные)
        modes       — моды Купмана Φ (n_features, rank), комплексные
        amplitudes  — начальные амплитуды мод b
        omega       — непрерывные частоты ln(λ)/dt (комплексные)
        frequencies — мнимая часть omega / (2π) — частота в циклах/бар
        growth_rates— вещественная часть omega — скорость роста/затухания
    """
    X = np.asarray(X, dtype=float)
    X1 = X[:, :-1]
    X2 = X[:, 1:]

    # SVD усечённое
    U, S, Vh = np.linalg.svd(X1, full_matrices=False)
    V = Vh.conj().T

    if rank is None:
        rank = len(S)
    rank = min(rank, len(S))

    U_r = U[:, :rank]
    S_r = S[:rank]
    V_r = V[:, :rank]

    # Низкоранговое приближение оператора Купмана
    S_inv = np.diag(1.0 / S_r)
    A_tilde = U_r.conj().T @ X2 @ V_r @ S_inv

    eigvals, W = np.linalg.eig(A_tilde)

    # DMD-моды (exact DMD)
    Phi = X2 @ V_r @ S_inv @ W

    # Непрерывные частоты
    eigvals_safe = np.where(np.abs(eigvals) < 1e-12, 1e-12 + 0j, eigvals)
    omega = np.log(eigvals_safe) / dt
    frequencies = omega.imag / (2.0 * np.pi)
    growth_rates = omega.real

    # Начальные амплитуды: x1 = Phi @ b
    b, *_ = np.linalg.lstsq(Phi, X1[:, 0], rcond=None)

    return {
        "eigvals":      eigvals,
        "modes":        Phi,
        "amplitudes":   b,
        "omega":        omega,
        "frequencies":  frequencies,
        "growth_rates": growth_rates,
        "rank":         rank,
    }


def dmd_reconstruct(
    dmd: dict,
    n_steps: int,
    dt: float = 1.0,
) -> np.ndarray:
    """
    Реконструкция/прогноз временного ряда через DMD-моды.

    x(t) = sum_k  b_k * phi_k * exp(omega_k * t)

    Parameters
    ----------
    dmd     : dict из compute_dmd()
    n_steps : число временных шагов для реконструкции (включая t=0)
    dt      : шаг времени

    Returns
    -------
    X_recon : 2-D array (n_features, n_steps), комплексный
    """
    Phi   = dmd["modes"]
    b     = dmd["amplitudes"]
    omega = dmd["omega"]

    t = np.arange(n_steps) * dt
    time_dynamics = np.exp(np.outer(omega, t))  # (rank, n_steps)
    X_recon = Phi @ (b[:, None] * time_dynamics)
    return X_recon


# ---------------------------------------------------------------------------
# Анализ спектра мод
# ---------------------------------------------------------------------------

def mode_energy(dmd: dict) -> np.ndarray:
    """
    Энергия (значимость) каждой моды: |b_k| * ||phi_k||.
    Используется для ранжирования мод по важности.
    """
    Phi = dmd["modes"]
    b   = dmd["amplitudes"]
    norms = np.linalg.norm(Phi, axis=0)
    return np.abs(b) * norms


def classify_modes(
    dmd: dict,
    stability_tol: float = 0.02,
) -> dict:
    """
    Классифицирует моды по поведению |λ|:
        growing   — |λ| > 1 + tol  (нарастающая динамика, потенциальный импульс)
        decaying  — |λ| < 1 - tol  (затухающая динамика, шум/переходный процесс)
        stable    — |λ| ≈ 1        (устойчивый цикл, периодичность)

    Parameters
    ----------
    dmd           : dict из compute_dmd()
    stability_tol : допуск вокруг |λ|=1 для отнесения к "stable"

    Returns
    -------
    dict: growing_idx, decaying_idx, stable_idx (списки индексов мод)
    """
    mags = np.abs(dmd["eigvals"])

    growing_idx  = list(np.where(mags > 1 + stability_tol)[0])
    decaying_idx = list(np.where(mags < 1 - stability_tol)[0])
    stable_idx   = list(np.where(np.abs(mags - 1) <= stability_tol)[0])

    return {
        "growing_idx":  growing_idx,
        "decaying_idx": decaying_idx,
        "stable_idx":   stable_idx,
    }


def dominant_frequencies(
    dmd: dict,
    top_k: int = 5,
    min_freq: float = 1e-6,
) -> list[dict]:
    """
    Возвращает топ-K доминирующих скрытых частот, отсортированных по энергии.
    Исключает почти нулевую частоту (тренд/смещение).

    Parameters
    ----------
    dmd      : dict из compute_dmd()
    top_k    : сколько частот вернуть
    min_freq : минимальная |частота|, ниже которой мода считается трендом

    Returns
    -------
    список dict: frequency (циклы/бар), period (бары), growth_rate,
                 magnitude (|λ|), energy
    """
    energies = mode_energy(dmd)
    freqs    = dmd["frequencies"]
    growth   = dmd["growth_rates"]
    mags     = np.abs(dmd["eigvals"])

    # Только положительные частоты (комплексно-сопряжённые пары избыточны)
    candidates = [
        (i, abs(freqs[i]), growth[i], mags[i], energies[i])
        for i in range(len(freqs))
        if abs(freqs[i]) > min_freq
    ]

    candidates.sort(key=lambda c: c[4], reverse=True)

    seen_freqs = set()
    results = []
    for i, f, g, m, e in candidates:
        key = round(f, 4)
        if key in seen_freqs:
            continue
        seen_freqs.add(key)
        results.append({
            "mode_idx":     i,
            "frequency":    round(float(f), 6),
            "period":       round(float(1.0 / f), 3) if f > 0 else None,
            "growth_rate":  round(float(g), 6),
            "magnitude":    round(float(m), 6),
            "energy":       round(float(e), 6),
        })
        if len(results) >= top_k:
            break

    return results


# ---------------------------------------------------------------------------
# Интерпретация
# ---------------------------------------------------------------------------

def interpret_koopman(
    dmd: dict,
    mode_classes: dict,
    top_freqs: list[dict],
) -> dict:
    """
    Торговая интерпретация Koopman/DMD-спектра.

    Parameters
    ----------
    dmd          : dict из compute_dmd()
    mode_classes : dict из classify_modes()
    top_freqs    : список из dominant_frequencies()

    Returns
    -------
    dict: regime, signal, stability, dominant_period, notes
    """
    n_modes    = len(dmd["eigvals"])
    n_growing  = len(mode_classes["growing_idx"])
    n_decaying = len(mode_classes["decaying_idx"])
    n_stable   = len(mode_classes["stable_idx"])

    growing_share = n_growing / n_modes if n_modes else 0.0
    stable_share  = n_stable / n_modes if n_modes else 0.0

    # --- Стабильность системы ---
    if growing_share > 0.30:
        stability = "unstable_growing"
    elif stable_share > 0.50:
        stability = "stable_periodic"
    elif n_decaying / n_modes > 0.60 if n_modes else False:
        stability = "decaying_transient"
    else:
        stability = "mixed"

    # --- Доминирующий период ---
    dom_period = top_freqs[0]["period"] if top_freqs else None
    dom_growth = top_freqs[0]["growth_rate"] if top_freqs else 0.0

    # --- Торговый сигнал ---
    if stability == "unstable_growing" and dom_growth > 0:
        signal = "MOMENTUM_BREAKOUT_WATCH"
        regime = "growing_instability"
    elif stability == "stable_periodic" and dom_period is not None:
        signal = "CYCLE_MEAN_REVERSION"
        regime = "stable_cycle"
    elif stability == "decaying_transient":
        signal = "REGIME_SETTLING"
        regime = "transient_decay"
    else:
        signal = "NEUTRAL"
        regime = "mixed_dynamics"

    notes = []
    if growing_share > 0.50:
        notes.append("majority_growing_modes: high instability, reduce size")
    if dom_period is not None and dom_period < 3:
        notes.append("very_short_period: likely noise, not tradable cycle")
    if dom_period is not None and dom_period > 50:
        notes.append("very_long_period: structural/macro cycle, low-frequency signal")
    if not top_freqs:
        notes.append("no_dominant_frequency: spectrum dominated by trend/noise")

    return {
        "stability":        stability,
        "dominant_period":  dom_period,
        "dominant_growth":  dom_growth,
        "growing_modes":    n_growing,
        "decaying_modes":   n_decaying,
        "stable_modes":     n_stable,
        "signal":           signal,
        "regime":           regime,
        "notes":            notes,
    }


# ---------------------------------------------------------------------------
# Полный пайплайн
# ---------------------------------------------------------------------------

def koopman_signal(
    series: np.ndarray,
    window: Optional[int] = None,
    n_delays: int = 10,
    rank: Optional[int] = None,
    dt: float = 1.0,
    top_k: int = 5,
    stability_tol: float = 0.02,
) -> dict:
    """
    Универсальная точка входа: ряд → Koopman/DMD спектр + интерпретация.

    Parameters
    ----------
    series        : временной ряд цен или доходностей
    window        : если задан — берёт последние `window` точек
    n_delays      : число задержек для матрицы Ганкеля
    rank          : ранг усечения SVD (None = авто, n_delays - 1)
    dt            : шаг времени между снимками
    top_k         : число доминирующих частот для отчёта
    stability_tol : допуск классификации мод по |λ|

    Returns
    -------
    dict: eigvals, dominant_frequencies, mode_classes, интерпретация
    """
    s = np.asarray(series, dtype=float)
    if window is not None:
        s = s[-window:]

    H = hankel_embed(s, n_delays=n_delays)

    if rank is None:
        rank = min(n_delays - 1, H.shape[1] - 1)

    dmd = compute_dmd(H, rank=rank, dt=dt)
    mode_classes = classify_modes(dmd, stability_tol=stability_tol)
    top_freqs = dominant_frequencies(dmd, top_k=top_k)
    interp = interpret_koopman(dmd, mode_classes, top_freqs)

    return {
        "n_modes":              len(dmd["eigvals"]),
        "dominant_frequencies": top_freqs,
        "mode_classes":         mode_classes,
        **interp,
        "_dmd": dmd,  # сырые данные для дальнейшего анализа/прогноза
    }


# ---------------------------------------------------------------------------
# Прогноз через Koopman-моды
# ---------------------------------------------------------------------------

def koopman_forecast(
    series: np.ndarray,
    n_delays: int = 10,
    rank: Optional[int] = None,
    horizon: int = 10,
    dt: float = 1.0,
) -> np.ndarray:
    """
    Линейный прогноз ряда через экстраполяцию Koopman-мод вперёд.

    Parameters
    ----------
    series   : 1-D временной ряд
    n_delays : число задержек для матрицы Ганкеля
    rank     : ранг усечения SVD
    horizon  : горизонт прогноза (число будущих точек)
    dt       : шаг времени

    Returns
    -------
    forecast : 1-D array длиной horizon — прогноз первой координаты
    """
    s = np.asarray(series, dtype=float)
    H = hankel_embed(s, n_delays=n_delays)

    if rank is None:
        rank = min(n_delays - 1, H.shape[1] - 1)

    dmd = compute_dmd(H, rank=rank, dt=dt)

    n_cols = H.shape[1]
    total_steps = n_cols + horizon

    X_recon = dmd_reconstruct(dmd, n_steps=total_steps, dt=dt)

    # Первая строка матрицы Ганкеля соответствует исходному ряду
    forecast = X_recon[0, n_cols:].real
    return forecast


# ---------------------------------------------------------------------------
# Rolling Koopman (для живого потока)
# ---------------------------------------------------------------------------

def rolling_koopman(
    series: np.ndarray,
    window: int = 150,
    step: int = 20,
    n_delays: int = 10,
    rank: Optional[int] = None,
    top_k: int = 3,
) -> list[dict]:
    """
    Скользящий Koopman-анализ для живого потока.

    Returns
    -------
    results : список dict-ов (без сырых данных) + индекс конца окна
    """
    series = np.asarray(series, dtype=float)
    n = len(series)
    results = []

    for end in range(window, n + 1, step):
        start = end - window
        try:
            res = koopman_signal(series[start:end], n_delays=n_delays,
                                 rank=rank, top_k=top_k)
            results.append({
                "index":              end - 1,
                "n_modes":            res["n_modes"],
                "dominant_period":    res["dominant_period"],
                "dominant_growth":    res["dominant_growth"],
                "stability":          res["stability"],
                "growing_modes":      res["growing_modes"],
                "stable_modes":       res["stable_modes"],
                "signal":             res["signal"],
                "regime":             res["regime"],
            })
        except (ValueError, np.linalg.LinAlgError):
            pass

    return results


# ---------------------------------------------------------------------------
# Вспомогательные утилиты
# ---------------------------------------------------------------------------

def log_returns(prices: np.ndarray) -> np.ndarray:
    """Логарифмические доходности из массива цен."""
    return np.diff(np.log(np.asarray(prices, dtype=float)))


def reconstruction_error(
    series: np.ndarray,
    n_delays: int = 10,
    rank: Optional[int] = None,
    dt: float = 1.0,
) -> float:
    """
    Ошибка реконструкции исходного ряда через DMD — мера качества
    линейного приближения оператора Купмана (чем ниже, тем лучше модель).

    Returns
    -------
    rmse : относительная RMSE реконструкции (0 = идеально)
    """
    s = np.asarray(series, dtype=float)
    H = hankel_embed(s, n_delays=n_delays)

    if rank is None:
        rank = min(n_delays - 1, H.shape[1] - 1)

    dmd = compute_dmd(H, rank=rank, dt=dt)
    X_recon = dmd_reconstruct(dmd, n_steps=H.shape[1], dt=dt).real

    err = np.linalg.norm(H - X_recon) / (np.linalg.norm(H) + 1e-12)
    return float(err)


# ---------------------------------------------------------------------------
# Пример использования
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    np.random.seed(42)

    # --- Синтетический ряд: два скрытых цикла + лёгкий тренд + шум ---
    t = np.linspace(0, 20, 400)
    series = (0.3 * t
              + 2.0 * np.sin(2 * np.pi * t / 15)   # период ≈ 15
              + 1.0 * np.sin(2 * np.pi * t / 4)    # период ≈ 4
              + 0.3 * np.random.randn(400))

    res = koopman_signal(series, n_delays=20, top_k=5)

    print(f"Число мод: {res['n_modes']}")
    print(f"Стабильность: {res['stability']}")
    print(f"Доминирующий период: {res['dominant_period']}")
    print("\nТоп частоты:")
    for f in res["dominant_frequencies"]:
        print(f"  период≈{f['period']}, growth={f['growth_rate']:.4f}, "
              f"|λ|={f['magnitude']:.4f}, energy={f['energy']:.3f}")

    print(f"\nSignal: {res['signal']} | Regime: {res['regime']}")

    # --- Качество модели ---
    rmse = reconstruction_error(series, n_delays=20)
    print(f"\nReconstruction RMSE: {rmse:.4f}")

    # --- Прогноз ---
    fc = koopman_forecast(series, n_delays=20, horizon=10)
    print(f"\nForecast next 10: {fc.round(3)}")

    # --- Rolling Koopman ---
    prices  = 100 * np.cumprod(1 + np.random.randn(500) * 0.01)
    rolling = rolling_koopman(prices, window=150, step=25, n_delays=15)
    if rolling:
        last = rolling[-1]
        print(f"\nRolling (idx={last['index']}): "
              f"period={last['dominant_period']}, "
              f"stability={last['stability']}, "
              f"signal={last['signal']}")
