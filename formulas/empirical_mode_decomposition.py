"""
Empirical Mode Decomposition (EMD) — Разложение на компоненты
=============================================================
EMD (Хуанг, 1998) адаптивно разлагает нестационарный нелинейный сигнал
на конечное число Intrinsic Mode Functions (IMF) + остаток (тренд):
    x(t) = IMF_1(t) + IMF_2(t) + ... + IMF_n(t) + r(t)

Свойства IMF:
    1. Число экстремумов и нулевых пересечений отличаются не более чем на 1
    2. Среднее огибающих (верхней и нижней) равно нулю

Применение в трейдинге:
    — Разделение краткосрочного шума, среднесрочных колебаний и долгосрочного тренда
    — Фильтрация сигнала без фиксированного окна (в отличие от MA/EMA)
    — Мгновенная частота и амплитуда каждой компоненты (через преобразование Гильберта)
    — Генерация торговых сигналов из IMF разных масштабов
"""

import numpy as np
from typing import Optional


# ---------------------------------------------------------------------------
# Вспомогательные функции
# ---------------------------------------------------------------------------

def _find_extrema(series: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Возвращает индексы локальных максимумов и минимумов."""
    maxima = []
    minima = []
    n = len(series)
    for i in range(1, n - 1):
        if series[i] > series[i - 1] and series[i] > series[i + 1]:
            maxima.append(i)
        elif series[i] < series[i - 1] and series[i] < series[i + 1]:
            minima.append(i)
    return np.array(maxima, dtype=int), np.array(minima, dtype=int)


def _cubic_spline(x: np.ndarray, y: np.ndarray, xi: np.ndarray) -> np.ndarray:
    """Кубическая сплайн-интерполяция (натуральные граничные условия)."""
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

    l = np.ones(n)
    mu = np.zeros(n)
    z = np.zeros(n)

    for i in range(1, n - 1):
        l[i] = 2 * (x[i + 1] - x[i - 1]) - h[i - 1] * mu[i - 1]
        mu[i] = h[i] / l[i]
        z[i] = (alpha[i] - h[i - 1] * z[i - 1]) / l[i]

    c = np.zeros(n)
    b = np.zeros(n)
    d = np.zeros(n)

    for j in range(n - 2, -1, -1):
        c[j] = z[j] - mu[j] * c[j + 1]
        b[j] = (y[j + 1] - y[j]) / h[j] - h[j] * (c[j + 1] + 2 * c[j]) / 3
        d[j] = (c[j + 1] - c[j]) / (3 * h[j])

    yi = np.zeros(len(xi))
    for k, xv in enumerate(xi):
        idx = np.searchsorted(x, xv, side='right') - 1
        idx = np.clip(idx, 0, n - 2)
        dx = xv - x[idx]
        yi[k] = y[idx] + b[idx] * dx + c[idx] * dx**2 + d[idx] * dx**3

    return yi


def _envelope(
    series: np.ndarray,
    indices: np.ndarray,
    values: np.ndarray,
) -> np.ndarray:
    """Строит огибающую через экстремумы с зеркальным продлением краёв."""
    n = len(series)
    t = np.arange(n)

    if len(indices) < 2:
        return np.full(n, np.mean(values) if len(values) else 0.0)

    # Зеркальное продление для краёв
    idx_ext = np.concatenate([[2 * indices[0] - indices[1]],
                               indices,
                               [2 * indices[-1] - indices[-2]]])
    val_ext = np.concatenate([[values[1]], values, [values[-2]]])

    return _cubic_spline(idx_ext.astype(float), val_ext.astype(float), t.astype(float))


# ---------------------------------------------------------------------------
# Ядро EMD — просеивание (sifting)
# ---------------------------------------------------------------------------

def _sift(
    series: np.ndarray,
    max_iter: int = 20,
    sd_thr: float = 0.2,
) -> np.ndarray:
    """
    Процедура просеивания для извлечения одной IMF.

    Parameters
    ----------
    series   : входной сигнал или остаток
    max_iter : максимальное число итераций
    sd_thr   : порог стандартного отклонения для остановки

    Returns
    -------
    imf : одна IMF
    """
    h = series.copy()

    for _ in range(max_iter):
        maxima_idx, minima_idx = _find_extrema(h)

        if len(maxima_idx) < 2 or len(minima_idx) < 2:
            break

        upper = _envelope(h, maxima_idx, h[maxima_idx])
        lower = _envelope(h, minima_idx, h[minima_idx])
        mean_env = (upper + lower) / 2.0

        h_prev = h.copy()
        h = h - mean_env

        # Критерий Коэна (SD)
        denom = np.sum(h_prev ** 2)
        if denom > 0:
            sd = np.sum((h_prev - h) ** 2) / denom
            if sd < sd_thr:
                break

    return h


def _is_imf(series: np.ndarray, tol: int = 1) -> bool:
    """Проверяет, удовлетворяет ли сигнал условиям IMF."""
    maxima, minima = _find_extrema(series)
    n_extrema = len(maxima) + len(minima)
    crossings = np.sum(np.diff(np.sign(series)) != 0)
    return abs(n_extrema - crossings) <= tol


# ---------------------------------------------------------------------------
# EMD
# ---------------------------------------------------------------------------

def compute_emd(
    series: np.ndarray,
    max_imfs: int = 10,
    max_iter: int = 20,
    sd_thr: float = 0.2,
    residual_thr: float = 0.001,
) -> tuple[np.ndarray, np.ndarray]:
    """
    Полное EMD-разложение сигнала.

    Parameters
    ----------
    series       : 1-D временной ряд
    max_imfs     : максимальное число IMF
    max_iter     : итерации просеивания на каждую IMF
    sd_thr       : порог остановки просеивания
    residual_thr : остановка если std(остатка) < residual_thr * std(исходного)

    Returns
    -------
    imfs     : 2-D array (n_imfs, n) — IMF по строкам (высокочастотные → низкочастотные)
    residual : 1-D array — финальный остаток (тренд)
    """
    series = np.asarray(series, dtype=float)
    n = len(series)

    if n < 6:
        raise ValueError("Ряд слишком короткий (минимум 6 точек).")

    imfs = []
    residual = series.copy()
    std0 = np.std(series)

    for _ in range(max_imfs):
        maxima_idx, minima_idx = _find_extrema(residual)
        if len(maxima_idx) < 2 or len(minima_idx) < 2:
            break
        if np.std(residual) < residual_thr * std0:
            break

        imf = _sift(residual, max_iter=max_iter, sd_thr=sd_thr)
        imfs.append(imf)
        residual = residual - imf

    if len(imfs) == 0:
        return np.zeros((1, n)), residual

    return np.array(imfs), residual


# ---------------------------------------------------------------------------
# Преобразование Гильберта — мгновенная частота и амплитуда
# ---------------------------------------------------------------------------

def hilbert_transform(signal: np.ndarray) -> np.ndarray:
    """Преобразование Гильберта через FFT."""
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


def instantaneous_features(imf: np.ndarray, fs: float = 1.0) -> dict:
    """
    Мгновенная амплитуда, фаза и частота IMF через аналитический сигнал.

    Parameters
    ----------
    imf : одна IMF (1-D)
    fs  : частота дискретизации (баров/сек; для дневных данных = 1)

    Returns
    -------
    dict: amplitude, phase, frequency (все 1-D массивы длиной len(imf))
    """
    analytic = hilbert_transform(imf)
    amplitude = np.abs(analytic)
    phase = np.unwrap(np.angle(analytic))
    frequency = np.diff(phase) / (2.0 * np.pi * (1.0 / fs))
    frequency = np.append(frequency, frequency[-1])  # выравниваем длину
    return {
        "amplitude": amplitude,
        "phase":     phase,
        "frequency": frequency,
    }


# ---------------------------------------------------------------------------
# Классификация IMF
# ---------------------------------------------------------------------------

def classify_imfs(
    imfs: np.ndarray,
    residual: np.ndarray,
    noise_thr: float = 0.30,
    trend_thr: float = 0.70,
) -> dict:
    """
    Делит IMF на три группы: шум, сигнал, тренд.

    Parameters
    ----------
    imfs      : 2-D array из compute_emd()
    residual  : тренд из compute_emd()
    noise_thr : IMF с номером ≤ noise_thr * n_imfs — шум
    trend_thr : IMF с номером ≥ trend_thr * n_imfs — тренд

    Returns
    -------
    dict: noise_imfs, signal_imfs, trend_imfs, residual,
          noise_component, signal_component, trend_component
    """
    n = len(imfs)
    noise_cut  = max(1, int(np.ceil(noise_thr * n)))
    trend_cut  = max(noise_cut + 1, int(np.floor(trend_thr * n)))

    noise_idx  = list(range(0, noise_cut))
    trend_idx  = list(range(trend_cut, n))
    signal_idx = list(range(noise_cut, trend_cut))

    noise_component  = imfs[noise_idx].sum(axis=0)  if noise_idx  else np.zeros(imfs.shape[1])
    signal_component = imfs[signal_idx].sum(axis=0) if signal_idx else np.zeros(imfs.shape[1])
    trend_component  = imfs[trend_idx].sum(axis=0)  if trend_idx  else np.zeros(imfs.shape[1])
    trend_component  += residual

    return {
        "noise_idx":        noise_idx,
        "signal_idx":       signal_idx,
        "trend_idx":        trend_idx,
        "noise_component":  noise_component,
        "signal_component": signal_component,
        "trend_component":  trend_component,
        "residual":         residual,
    }


# ---------------------------------------------------------------------------
# Интерпретация
# ---------------------------------------------------------------------------

def interpret_emd(
    imfs: np.ndarray,
    residual: np.ndarray,
    series: np.ndarray,
) -> dict:
    """
    Торговая интерпретация EMD-разложения.

    Parameters
    ----------
    imfs     : 2-D array из compute_emd()
    residual : 1-D тренд из compute_emd()
    series   : исходный ряд

    Returns
    -------
    dict: trend_direction, trend_strength, signal_regime,
          dominant_imf, signal, regime, notes
    """
    series = np.asarray(series, dtype=float)
    n_imfs = len(imfs)

    # --- Направление тренда (по остатку) ---
    slope = np.polyfit(np.arange(len(residual)), residual, 1)[0]
    trend_direction = "up" if slope > 0 else "down" if slope < 0 else "flat"

    # --- Сила тренда (доля дисперсии, объяснённой трендом) ---
    var_total   = np.var(series)
    var_trend   = np.var(residual) if var_total > 0 else 0.0
    trend_strength = float(np.clip(var_trend / (var_total + 1e-10), 0, 1))

    # --- Доминирующая IMF (наибольшая дисперсия) ---
    variances   = np.var(imfs, axis=1)
    dominant_imf = int(np.argmax(variances))

    # --- Режим среднесрочного сигнала ---
    if n_imfs > 1:
        mid_imf = imfs[n_imfs // 2]
        last_cross = np.sign(mid_imf[-1])
        signal_regime = "overbought" if last_cross > 0 else "oversold"
    else:
        signal_regime = "neutral"

    # --- Торговый сигнал ---
    if trend_strength > 0.50 and trend_direction == "up":
        signal = "TREND_LONG"
        regime = "strong_uptrend"
    elif trend_strength > 0.50 and trend_direction == "down":
        signal = "TREND_SHORT"
        regime = "strong_downtrend"
    elif trend_strength < 0.15 and signal_regime == "oversold":
        signal = "MEAN_REVERSION_LONG"
        regime = "oscillation_oversold"
    elif trend_strength < 0.15 and signal_regime == "overbought":
        signal = "MEAN_REVERSION_SHORT"
        regime = "oscillation_overbought"
    else:
        signal = "NEUTRAL"
        regime = "mixed"

    notes = []
    if n_imfs <= 2:
        notes.append("few_imfs: series may be too short or too smooth")
    if trend_strength > 0.80:
        notes.append("dominant_trend: reduce mean-reversion strategies")
    if dominant_imf == 0:
        notes.append("noise_dominant: series largely stochastic")

    return {
        "trend_direction": trend_direction,
        "trend_strength":  round(trend_strength, 4),
        "signal_regime":   signal_regime,
        "dominant_imf":    dominant_imf,
        "n_imfs":          n_imfs,
        "signal":          signal,
        "regime":          regime,
        "notes":           notes,
    }


# ---------------------------------------------------------------------------
# Полный пайплайн
# ---------------------------------------------------------------------------

def emd_signal(
    series: np.ndarray,
    window: Optional[int] = None,
    max_imfs: int = 10,
    max_iter: int = 20,
    sd_thr: float = 0.2,
) -> dict:
    """
    Универсальная точка входа: ряд → IMF + интерпретация.

    Parameters
    ----------
    series   : временной ряд цен или доходностей
    window   : если задан — берёт последние `window` точек
    max_imfs : максимальное число IMF
    max_iter : итерации просеивания
    sd_thr   : порог остановки просеивания

    Returns
    -------
    dict: imfs, residual, classification, interpretation
    """
    s = np.asarray(series, dtype=float)
    if window is not None:
        s = s[-window:]

    imfs, residual  = compute_emd(s, max_imfs=max_imfs, max_iter=max_iter, sd_thr=sd_thr)
    classification  = classify_imfs(imfs, residual)
    interpretation  = interpret_emd(imfs, residual, s)

    return {
        "imfs":           imfs,
        "residual":       residual,
        "classification": classification,
        **interpretation,
    }


# ---------------------------------------------------------------------------
# Rolling EMD (для живого потока)
# ---------------------------------------------------------------------------

def rolling_emd(
    series: np.ndarray,
    window: int = 200,
    step: int = 20,
    max_imfs: int = 8,
    max_iter: int = 15,
) -> list[dict]:
    """
    Скользящий EMD для живого потока.

    Returns
    -------
    results : список dict-ов с интерпретацией + индексом конца окна
    """
    series = np.asarray(series, dtype=float)
    n = len(series)
    results = []

    for end in range(window, n + 1, step):
        start = end - window
        try:
            res = emd_signal(series[start:end], max_imfs=max_imfs, max_iter=max_iter)
            # Не сохраняем массивы — только скалярные метрики
            results.append({
                "index":           end - 1,
                "n_imfs":          res["n_imfs"],
                "trend_direction": res["trend_direction"],
                "trend_strength":  res["trend_strength"],
                "signal_regime":   res["signal_regime"],
                "dominant_imf":    res["dominant_imf"],
                "signal":          res["signal"],
                "regime":          res["regime"],
            })
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


def reconstruct(imfs: np.ndarray, residual: np.ndarray) -> np.ndarray:
    """Восстанавливает исходный ряд из IMF и остатка."""
    return imfs.sum(axis=0) + residual


def filtered_series(
    imfs: np.ndarray,
    residual: np.ndarray,
    keep_idx: list[int],
    include_residual: bool = True,
) -> np.ndarray:
    """
    Реконструкция ряда только из выбранных IMF (фильтрация).

    Parameters
    ----------
    imfs             : 2-D array из compute_emd()
    residual         : 1-D тренд
    keep_idx         : индексы IMF для включения
    include_residual : добавить ли остаток (тренд)
    """
    out = imfs[keep_idx].sum(axis=0)
    if include_residual:
        out += residual
    return out


# ---------------------------------------------------------------------------
# Пример использования
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    np.random.seed(42)

    # --- Синтетический ряд: тренд + осцилляция + шум ---
    t = np.linspace(0, 4 * np.pi, 300)
    series = (np.linspace(0, 10, 300)           # тренд
              + 3 * np.sin(t)                   # медленная волна
              + 1.5 * np.sin(4 * t)             # быстрая волна
              + 0.5 * np.random.randn(300))     # шум

    res = emd_signal(series)
    print(f"Число IMF: {res['n_imfs']}")
    print(f"Тренд: {res['trend_direction']} | Сила: {res['trend_strength']}")
    print(f"Signal: {res['signal']} | Regime: {res['regime']}")

    # --- Мгновенные характеристики первой IMF ---
    feat = instantaneous_features(res["imfs"][0])
    print(f"\nIMF[0] средняя амплитуда: {feat['amplitude'].mean():.4f}")
    print(f"IMF[0] средняя частота:   {feat['frequency'].mean():.4f}")

    # --- Фильтрованный ряд (только сигнал без шума) ---
    clf = res["classification"]
    clean = filtered_series(res["imfs"], res["residual"], clf["signal_idx"])
    print(f"\nФильтрованный ряд (первые 5): {clean[:5].round(4)}")

    # --- Rolling EMD ---
    prices = 100 * np.cumprod(1 + np.random.randn(500) * 0.01)
    rolling = rolling_emd(prices, window=200, step=25)
    if rolling:
        last = rolling[-1]
        print(f"\nLast rolling (idx={last['index']}): "
              f"trend={last['trend_direction']}, signal={last['signal']}")
