"""
Hilbert–Huang Transform (HHT) — Локальные циклы
=================================================
HHT (Хуанг, 1998) = EMD + преобразование Гильберта (HT).
Даёт полностью адаптивное время-частотное представление
нестационарного нелинейного сигнала без фиксированных базисов.

Пайплайн:
    1. EMD  → IMF_1, IMF_2, ..., IMF_n, r(t)
    2. HT   → аналитический сигнал для каждой IMF
    3.        мгновенная амплитуда A_k(t) и частота f_k(t)
    4. Спектр Гильберта — H(ω, t) — энергия в пространстве (время, частота)

Применение в трейдинге:
    — Выявление доминирующих рыночных циклов без фиксированного периода
    — Мгновенная частота как мера скорости рыночного цикла
    — Амплитуда как мера силы текущего движения
    — Смена доминирующей частоты → сигнал смены режима
    — Маргинальный спектр → профиль периодичности актива
"""

import numpy as np
from typing import Optional


# ---------------------------------------------------------------------------
# EMD (минимальная встроенная копия для самодостаточности модуля)
# ---------------------------------------------------------------------------

def _find_extrema(s: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    maxima, minima = [], []
    for i in range(1, len(s) - 1):
        if s[i] > s[i - 1] and s[i] > s[i + 1]:
            maxima.append(i)
        elif s[i] < s[i - 1] and s[i] < s[i + 1]:
            minima.append(i)
    return np.array(maxima, dtype=int), np.array(minima, dtype=int)


def _cubic_spline(x: np.ndarray, y: np.ndarray, xi: np.ndarray) -> np.ndarray:
    n = len(x)
    if n < 2:
        return np.full(len(xi), y[0] if len(y) else 0.0)
    if n == 2:
        return np.interp(xi, x, y)
    h = np.diff(x).astype(float)
    alpha = np.zeros(n)
    for i in range(1, n - 1):
        alpha[i] = (3 / h[i] * (y[i + 1] - y[i]) -
                    3 / h[i - 1] * (y[i] - y[i - 1]))
    l, mu, z = np.ones(n), np.zeros(n), np.zeros(n)
    for i in range(1, n - 1):
        l[i]  = 2 * (x[i + 1] - x[i - 1]) - h[i - 1] * mu[i - 1]
        mu[i] = h[i] / l[i]
        z[i]  = (alpha[i] - h[i - 1] * z[i - 1]) / l[i]
    c, b, d = np.zeros(n), np.zeros(n), np.zeros(n)
    for j in range(n - 2, -1, -1):
        c[j] = z[j] - mu[j] * c[j + 1]
        b[j] = (y[j + 1] - y[j]) / h[j] - h[j] * (c[j + 1] + 2 * c[j]) / 3
        d[j] = (c[j + 1] - c[j]) / (3 * h[j])
    yi = np.zeros(len(xi))
    for k, xv in enumerate(xi):
        idx = int(np.clip(np.searchsorted(x, xv, side='right') - 1, 0, n - 2))
        dx  = xv - x[idx]
        yi[k] = y[idx] + b[idx]*dx + c[idx]*dx**2 + d[idx]*dx**3
    return yi


def _envelope(s: np.ndarray, idx: np.ndarray, val: np.ndarray) -> np.ndarray:
    n = len(s)
    if len(idx) < 2:
        return np.full(n, np.mean(val) if len(val) else 0.0)
    ix = np.concatenate([[2*idx[0]-idx[1]],  idx,  [2*idx[-1]-idx[-2]]])
    vx = np.concatenate([[val[1]],            val,  [val[-2]]])
    return _cubic_spline(ix.astype(float), vx.astype(float), np.arange(n, dtype=float))


def _sift(s: np.ndarray, max_iter: int = 20, sd_thr: float = 0.2) -> np.ndarray:
    h = s.copy()
    for _ in range(max_iter):
        mx, mn = _find_extrema(h)
        if len(mx) < 2 or len(mn) < 2:
            break
        mean_env = (_envelope(h, mx, h[mx]) + _envelope(h, mn, h[mn])) / 2.0
        prev, h  = h, h - mean_env
        denom = np.sum(prev**2)
        if denom > 0 and np.sum((prev - h)**2) / denom < sd_thr:
            break
    return h


def compute_emd(
    series: np.ndarray,
    max_imfs: int = 10,
    max_iter: int = 20,
    sd_thr: float = 0.2,
    residual_thr: float = 0.001,
) -> tuple[np.ndarray, np.ndarray]:
    """EMD-разложение → (imfs [n_imfs × N], residual [N])."""
    series = np.asarray(series, dtype=float)
    if len(series) < 6:
        raise ValueError("Ряд слишком короткий (минимум 6 точек).")
    imfs, r, std0 = [], series.copy(), np.std(series)
    for _ in range(max_imfs):
        mx, mn = _find_extrema(r)
        if len(mx) < 2 or len(mn) < 2 or np.std(r) < residual_thr * std0:
            break
        imfs.append(_sift(r, max_iter, sd_thr))
        r = r - imfs[-1]
    return (np.array(imfs) if imfs else np.zeros((1, len(series)))), r


# ---------------------------------------------------------------------------
# Преобразование Гильберта
# ---------------------------------------------------------------------------

def hilbert_transform(signal: np.ndarray) -> np.ndarray:
    """Аналитический сигнал через FFT (возвращает комплексный массив)."""
    n = len(signal)
    F = np.fft.fft(signal)
    h = np.zeros(n)
    if n % 2 == 0:
        h[0] = h[n // 2] = 1
        h[1:n // 2] = 2
    else:
        h[0] = 1
        h[1:(n + 1) // 2] = 2
    return np.fft.ifft(F * h)


def instantaneous_features(
    imf: np.ndarray,
    fs: float = 1.0,
    smooth_window: int = 5,
) -> dict:
    """
    Мгновенная амплитуда, фаза и частота одной IMF.

    Parameters
    ----------
    imf           : 1-D IMF
    fs            : частота дискретизации (1 = 1 бар)
    smooth_window : окно сглаживания мгновенной частоты (медиана)

    Returns
    -------
    dict: amplitude, phase, frequency — все 1-D длиной len(imf)
    """
    analytic  = hilbert_transform(imf)
    amplitude = np.abs(analytic)
    phase     = np.unwrap(np.angle(analytic))

    # Мгновенная частота: производная фазы
    freq = np.diff(phase) / (2.0 * np.pi / fs)
    freq = np.append(freq, freq[-1])

    # Медианное сглаживание для подавления выбросов
    if smooth_window > 1 and len(freq) >= smooth_window:
        half = smooth_window // 2
        freq_smooth = freq.copy()
        for i in range(half, len(freq) - half):
            freq_smooth[i] = np.median(freq[i - half: i + half + 1])
        freq = freq_smooth

    # Физически допустимые частоты: 0 < f < fs/2
    freq = np.clip(freq, 0, fs / 2)

    return {"amplitude": amplitude, "phase": phase, "frequency": freq}


# ---------------------------------------------------------------------------
# Ядро HHT
# ---------------------------------------------------------------------------

def compute_hht(
    series: np.ndarray,
    max_imfs: int = 10,
    max_iter: int = 20,
    sd_thr: float = 0.2,
    fs: float = 1.0,
    smooth_window: int = 5,
) -> dict:
    """
    Полный HHT-анализ временного ряда.

    Parameters
    ----------
    series        : 1-D временной ряд
    max_imfs      : максимальное число IMF
    max_iter      : итерации просеивания
    sd_thr        : порог остановки просеивания
    fs            : частота дискретизации
    smooth_window : сглаживание мгновенной частоты

    Returns
    -------
    dict:
        imfs        — 2-D array (n_imfs × N)
        residual    — 1-D тренд
        amplitudes  — список 1-D массивов амплитуд для каждой IMF
        phases      — список 1-D массивов фаз
        frequencies — список 1-D массивов мгновенных частот
        periods     — список средних периодов (1/f) для каждой IMF
        energies    — суммарная энергия каждой IMF
    """
    series = np.asarray(series, dtype=float)
    imfs, residual = compute_emd(series, max_imfs=max_imfs,
                                 max_iter=max_iter, sd_thr=sd_thr)

    amplitudes, phases, frequencies, periods, energies = [], [], [], [], []

    for imf in imfs:
        feat = instantaneous_features(imf, fs=fs, smooth_window=smooth_window)
        amplitudes.append(feat["amplitude"])
        phases.append(feat["phase"])
        frequencies.append(feat["frequency"])

        mean_freq = float(np.mean(feat["frequency"][feat["frequency"] > 0]))
        periods.append(1.0 / mean_freq if mean_freq > 0 else np.inf)
        energies.append(float(np.sum(imf ** 2)))

    return {
        "imfs":        imfs,
        "residual":    residual,
        "amplitudes":  amplitudes,
        "phases":      phases,
        "frequencies": frequencies,
        "periods":     periods,
        "energies":    energies,
    }


# ---------------------------------------------------------------------------
# Спектр Гильберта и маргинальный спектр
# ---------------------------------------------------------------------------

def hilbert_spectrum(
    amplitudes: list,
    frequencies: list,
    n_freq_bins: int = 64,
    fs: float = 1.0,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """
    Спектр Гильберта H(t, f) — распределение энергии в пространстве
    (время, частота).

    Parameters
    ----------
    amplitudes   : список A_k(t) из compute_hht()
    frequencies  : список f_k(t) из compute_hht()
    n_freq_bins  : число частотных бинов
    fs           : частота дискретизации

    Returns
    -------
    H      : 2-D array (n_freq_bins × N) — спектр Гильберта
    f_bins : центры частотных бинов
    t_axis : временная ось (индексы)
    """
    N = len(amplitudes[0])
    f_max  = fs / 2.0
    f_bins = np.linspace(0, f_max, n_freq_bins)
    df     = f_bins[1] - f_bins[0] if n_freq_bins > 1 else f_max
    H      = np.zeros((n_freq_bins, N))

    for A, F in zip(amplitudes, frequencies):
        for t in range(N):
            fi   = int(np.round(F[t] / df))
            fi   = np.clip(fi, 0, n_freq_bins - 1)
            H[fi, t] += A[t] ** 2

    return H, f_bins, np.arange(N)


def marginal_spectrum(
    H: np.ndarray,
    f_bins: np.ndarray,
) -> tuple[np.ndarray, np.ndarray]:
    """
    Маргинальный спектр: h(f) = ∫ H(t,f) dt
    Показывает суммарную энергию на каждой частоте.

    Returns
    -------
    h      : 1-D массив энергии по частотам
    f_bins : соответствующие частоты
    """
    return H.sum(axis=1), f_bins


# ---------------------------------------------------------------------------
# Доминирующий цикл
# ---------------------------------------------------------------------------

def dominant_cycle(
    periods: list,
    energies: list,
    residual_energy: Optional[float] = None,
) -> dict:
    """
    Определяет доминирующий рыночный цикл по энергии IMF.

    Parameters
    ----------
    periods         : средние периоды IMF из compute_hht()
    energies        : энергии IMF из compute_hht()
    residual_energy : энергия тренда (опционально)

    Returns
    -------
    dict: dominant_period, dominant_imf_idx, energy_share,
          cycle_band (short/medium/long)
    """
    energies = np.array(energies)
    periods  = np.array(periods)

    # Исключаем бесконечные периоды (тренд)
    valid = np.isfinite(periods)
    if not valid.any():
        return {
            "dominant_period":  None,
            "dominant_imf_idx": None,
            "energy_share":     0.0,
            "cycle_band":       "none",
        }

    e_valid = energies[valid]
    p_valid = periods[valid]
    idx_in_valid = int(np.argmax(e_valid))
    dom_period   = float(p_valid[idx_in_valid])

    # Индекс в исходном массиве
    orig_indices = np.where(valid)[0]
    dom_idx      = int(orig_indices[idx_in_valid])

    total_e  = energies.sum() + (residual_energy or 0.0)
    e_share  = float(e_valid[idx_in_valid] / total_e) if total_e > 0 else 0.0

    if dom_period < 5:
        band = "short"
    elif dom_period < 20:
        band = "medium"
    else:
        band = "long"

    return {
        "dominant_period":  round(dom_period, 2),
        "dominant_imf_idx": dom_idx,
        "energy_share":     round(e_share, 4),
        "cycle_band":       band,
    }


# ---------------------------------------------------------------------------
# Детектор смены режима
# ---------------------------------------------------------------------------

def regime_change_score(
    frequencies: list,
    window: int = 20,
) -> np.ndarray:
    """
    Оценка нестабильности режима: стандартное отклонение доминирующей
    мгновенной частоты в скользящем окне.
    Высокое значение → смена рыночного режима.

    Returns
    -------
    score : 1-D array длиной N
    """
    # Берём IMF с наибольшей средней частотой (самая быстрая значимая)
    mean_freqs = [float(np.mean(f)) for f in frequencies]
    dom_idx    = int(np.argmax(mean_freqs))
    f_series   = frequencies[dom_idx]

    N     = len(f_series)
    score = np.full(N, np.nan)

    for i in range(window, N + 1):
        score[i - 1] = float(np.std(f_series[i - window: i]))

    return score


# ---------------------------------------------------------------------------
# Интерпретация
# ---------------------------------------------------------------------------

def interpret_hht(
    hht_result: dict,
    dom_cycle: dict,
    regime_score: Optional[np.ndarray] = None,
) -> dict:
    """
    Торговая интерпретация HHT.

    Parameters
    ----------
    hht_result    : dict из compute_hht()
    dom_cycle     : dict из dominant_cycle()
    regime_score  : array из regime_change_score() (опционально)

    Returns
    -------
    dict: signal, regime, cycle_phase, amplitude_trend,
          regime_stability, notes
    """
    imfs       = hht_result["imfs"]
    amplitudes = hht_result["amplitudes"]
    phases     = hht_result["phases"]
    residual   = hht_result["residual"]

    n_imfs = len(imfs)

    # --- Фаза доминирующего цикла ---
    dom_idx = dom_cycle.get("dominant_imf_idx")
    if dom_idx is not None and dom_idx < len(phases):
        last_phase = float(phases[dom_idx][-1]) % (2 * np.pi)
        if last_phase < np.pi / 2:
            cycle_phase = "rising"
        elif last_phase < np.pi:
            cycle_phase = "topping"
        elif last_phase < 3 * np.pi / 2:
            cycle_phase = "falling"
        else:
            cycle_phase = "bottoming"
    else:
        cycle_phase = "unknown"

    # --- Тренд амплитуды доминирующего цикла ---
    amplitude_trend = "neutral"
    if dom_idx is not None and dom_idx < len(amplitudes):
        amp = amplitudes[dom_idx]
        if len(amp) > 10:
            slope = np.polyfit(np.arange(len(amp)), amp, 1)[0]
            amplitude_trend = "expanding" if slope > 0 else "contracting"

    # --- Тренд (по остатку) ---
    residual_slope = float(np.polyfit(np.arange(len(residual)), residual, 1)[0])
    trend_dir = "up" if residual_slope > 0 else "down"

    # --- Стабильность режима ---
    regime_stability = "stable"
    if regime_score is not None:
        valid_scores = regime_score[~np.isnan(regime_score)]
        if len(valid_scores) > 0:
            last_score = valid_scores[-1]
            p75 = np.percentile(valid_scores, 75)
            p90 = np.percentile(valid_scores, 90)
            if last_score > p90:
                regime_stability = "unstable"
            elif last_score > p75:
                regime_stability = "transitioning"

    # --- Торговый сигнал ---
    band = dom_cycle.get("cycle_band", "none")

    if regime_stability == "unstable":
        signal = "REDUCE_EXPOSURE"
        regime = "regime_change"
    elif cycle_phase == "bottoming" and trend_dir == "up":
        signal = "LONG_ENTRY"
        regime = "cycle_bottom_uptrend"
    elif cycle_phase == "topping" and trend_dir == "down":
        signal = "SHORT_ENTRY"
        regime = "cycle_top_downtrend"
    elif cycle_phase == "rising" and amplitude_trend == "expanding":
        signal = "HOLD_LONG"
        regime = "expanding_upswing"
    elif cycle_phase == "falling" and amplitude_trend == "expanding":
        signal = "HOLD_SHORT"
        regime = "expanding_downswing"
    elif amplitude_trend == "contracting":
        signal = "REDUCE_POSITION"
        regime = "cycle_fading"
    else:
        signal = "NEUTRAL"
        regime = "mixed"

    notes = []
    if dom_cycle.get("energy_share", 0) < 0.20:
        notes.append("low_energy_share: no dominant cycle, fragmented spectrum")
    if band == "short":
        notes.append("short_cycle: noise-driven, low predictability")
    if band == "long":
        notes.append("long_cycle: structural move, suit position traders")
    if n_imfs <= 2:
        notes.append("few_imfs: series may be too short")

    return {
        "signal":            signal,
        "regime":            regime,
        "cycle_phase":       cycle_phase,
        "amplitude_trend":   amplitude_trend,
        "trend_direction":   trend_dir,
        "regime_stability":  regime_stability,
        "dominant_period":   dom_cycle.get("dominant_period"),
        "cycle_band":        band,
        "notes":             notes,
    }


# ---------------------------------------------------------------------------
# Полный пайплайн
# ---------------------------------------------------------------------------

def hht_signal(
    series: np.ndarray,
    window: Optional[int] = None,
    max_imfs: int = 10,
    max_iter: int = 20,
    sd_thr: float = 0.2,
    fs: float = 1.0,
    smooth_window: int = 5,
    regime_window: int = 20,
) -> dict:
    """
    Универсальная точка входа: ряд → HHT + интерпретация.

    Parameters
    ----------
    series         : временной ряд цен или доходностей
    window         : если задан — берёт последние `window` точек
    max_imfs       : максимальное число IMF
    max_iter       : итерации просеивания
    sd_thr         : порог остановки просеивания
    fs             : частота дискретизации
    smooth_window  : сглаживание мгновенной частоты
    regime_window  : окно детектора смены режима

    Returns
    -------
    dict: все метрики HHT + интерпретация
    """
    s = np.asarray(series, dtype=float)
    if window is not None:
        s = s[-window:]

    hht    = compute_hht(s, max_imfs=max_imfs, max_iter=max_iter,
                         sd_thr=sd_thr, fs=fs, smooth_window=smooth_window)
    dom    = dominant_cycle(hht["periods"], hht["energies"])
    r_score = regime_change_score(hht["frequencies"], window=regime_window)
    interp = interpret_hht(hht, dom, r_score)

    return {
        "n_imfs":          len(hht["imfs"]),
        "periods":         [round(p, 3) if np.isfinite(p) else None
                            for p in hht["periods"]],
        "energies":        [round(e, 4) for e in hht["energies"]],
        "dominant_cycle":  dom,
        "regime_score_last": (float(r_score[~np.isnan(r_score)][-1])
                              if np.any(~np.isnan(r_score)) else None),
        **interp,
        # Сырые массивы — для дальнейшего анализа
        "_hht": hht,
    }


# ---------------------------------------------------------------------------
# Rolling HHT
# ---------------------------------------------------------------------------

def rolling_hht(
    series: np.ndarray,
    window: int = 200,
    step: int = 20,
    max_imfs: int = 8,
    max_iter: int = 15,
    fs: float = 1.0,
) -> list[dict]:
    """
    Скользящий HHT для живого потока.

    Returns
    -------
    results : список dict-ов (без сырых массивов) + индекс конца окна
    """
    series = np.asarray(series, dtype=float)
    n = len(series)
    results = []

    for end in range(window, n + 1, step):
        start = end - window
        try:
            res = hht_signal(series[start:end], max_imfs=max_imfs,
                             max_iter=max_iter, fs=fs)
            results.append({
                "index":            end - 1,
                "n_imfs":           res["n_imfs"],
                "dominant_period":  res["dominant_period"],
                "cycle_band":       res["cycle_band"],
                "cycle_phase":      res["cycle_phase"],
                "amplitude_trend":  res["amplitude_trend"],
                "trend_direction":  res["trend_direction"],
                "regime_stability": res["regime_stability"],
                "signal":           res["signal"],
                "regime":           res["regime"],
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


def energy_ratio(energies: list, residual: np.ndarray) -> dict:
    """
    Доля энергии каждой IMF и тренда относительно суммарной энергии.

    Returns
    -------
    dict: imf_ratios (list), trend_ratio (float)
    """
    e_imfs  = np.array(energies)
    e_trend = float(np.sum(residual ** 2))
    total   = e_imfs.sum() + e_trend
    if total == 0:
        return {"imf_ratios": [0.0] * len(energies), "trend_ratio": 0.0}
    return {
        "imf_ratios":  [round(float(e / total), 4) for e in e_imfs],
        "trend_ratio": round(e_trend / total, 4),
    }


def phase_synchrony(phase_a: np.ndarray, phase_b: np.ndarray) -> float:
    """
    Индекс фазовой синхронизации двух IMF (0 = нет синхронии, 1 = полная).
    Полезно для сравнения циклов двух инструментов.
    """
    delta = phase_a - phase_b
    return float(np.abs(np.mean(np.exp(1j * delta))))


# ---------------------------------------------------------------------------
# Пример использования
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    np.random.seed(42)

    # --- Синтетический ряд: тренд + два цикла + шум ---
    t = np.linspace(0, 8 * np.pi, 400)
    series = (np.linspace(0, 15, 400)
              + 4 * np.sin(t)
              + 2 * np.sin(4 * t)
              + 0.5 * np.random.randn(400))

    res = hht_signal(series, max_imfs=8, regime_window=20)

    print(f"Число IMF: {res['n_imfs']}")
    print(f"Доминирующий период: {res['dominant_period']} баров "
          f"({res['cycle_band']} band)")
    print(f"Фаза цикла:     {res['cycle_phase']}")
    print(f"Амплитуда:      {res['amplitude_trend']}")
    print(f"Тренд:          {res['trend_direction']}")
    print(f"Стабильность:   {res['regime_stability']}")
    print(f"Signal: {res['signal']} | Regime: {res['regime']}")

    # --- Маргинальный спектр ---
    hht_raw = res["_hht"]
    H, f_bins, _ = hilbert_spectrum(hht_raw["amplitudes"],
                                    hht_raw["frequencies"],
                                    n_freq_bins=32)
    ms, _ = marginal_spectrum(H, f_bins)
    peak_freq = f_bins[np.argmax(ms)]
    print(f"\nПиковая частота маргинального спектра: {peak_freq:.4f} "
          f"(период ≈ {1/peak_freq:.1f} баров)" if peak_freq > 0 else "")

    # --- Energy ratio ---
    er = energy_ratio(hht_raw["energies"], hht_raw["residual"])
    print(f"Доля тренда в энергии: {er['trend_ratio']:.2%}")

    # --- Rolling HHT ---
    prices  = 100 * np.cumprod(1 + np.random.randn(500) * 0.01)
    rolling = rolling_hht(prices, window=200, step=25, max_imfs=6)
    if rolling:
        last = rolling[-1]
        print(f"\nRolling (idx={last['index']}): "
              f"period={last['dominant_period']}, "
              f"phase={last['cycle_phase']}, "
              f"signal={last['signal']}")
