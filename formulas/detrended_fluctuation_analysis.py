"""
Detrended Fluctuation Analysis (DFA) — Долговременная память
=============================================================
Метод DFA используется для оценки долгосрочной памяти временного ряда.
Показатель Херста (H) / DFA-экспонента (α):
    α < 0.5  — антиперсистентный ряд (возврат к среднему)
    α ≈ 0.5  — случайное блуждание (нет памяти)
    α > 0.5  — персистентный ряд (трендовое поведение)
    α ≈ 1.0  — розовый шум (сильная долгосрочная корреляция)
    α > 1.0  — небелый шум, нестационарность
"""

import numpy as np
from typing import Optional


# ---------------------------------------------------------------------------
# Core DFA
# ---------------------------------------------------------------------------

def compute_dfa(
    series: np.ndarray,
    min_box: int = 4,
    max_box: Optional[int] = None,
    num_scales: int = 20,
    order: int = 1,
) -> tuple[float, np.ndarray, np.ndarray]:
    """
    Вычисляет DFA-экспоненту (α) для временного ряда.

    Parameters
    ----------
    series    : 1-D array-like — временной ряд цен или доходностей
    min_box   : минимальный размер окна (сегмента)
    max_box   : максимальный размер окна; по умолчанию len(series) // 4
    num_scales: количество логарифмически равномерных масштабов
    order     : порядок полиномиального деtrending (1 = линейный)

    Returns
    -------
    alpha     : DFA-экспонента (аналог показателя Херста)
    scales    : массив использованных размеров окон
    fluct     : среднеквадратичные флуктуации для каждого масштаба
    """
    series = np.asarray(series, dtype=float)
    n = len(series)

    if n < 20:
        raise ValueError("Ряд слишком короткий (минимум 20 точек).")

    if max_box is None:
        max_box = n // 4

    max_box = min(max_box, n // 2)

    if min_box < order + 2:
        min_box = order + 2

    # Логарифмически равномерные масштабы (целые)
    scales = np.unique(
        np.round(
            np.logspace(np.log10(min_box), np.log10(max_box), num_scales)
        ).astype(int)
    )
    scales = scales[scales >= min_box]

    # Интегрированный профиль
    profile = np.cumsum(series - np.mean(series))

    fluct = np.zeros(len(scales))

    for i, box in enumerate(scales):
        n_boxes = n // box
        if n_boxes < 2:
            fluct[i] = np.nan
            continue

        rms_list = []
        for j in range(n_boxes):
            segment = profile[j * box: (j + 1) * box]
            x = np.arange(box)
            coeffs = np.polyfit(x, segment, order)
            trend = np.polyval(coeffs, x)
            rms_list.append(np.mean((segment - trend) ** 2))

        fluct[i] = np.sqrt(np.mean(rms_list))

    # Убираем NaN
    valid = ~np.isnan(fluct)
    scales_v = scales[valid].astype(float)
    fluct_v = fluct[valid]

    if len(scales_v) < 2:
        raise ValueError("Недостаточно валидных масштабов для регрессии.")

    # Линейная регрессия в лог-лог пространстве → α
    log_s = np.log10(scales_v)
    log_f = np.log10(fluct_v)
    alpha = float(np.polyfit(log_s, log_f, 1)[0])

    return alpha, scales_v, fluct_v


# ---------------------------------------------------------------------------
# Интерпретация
# ---------------------------------------------------------------------------

def interpret_alpha(alpha: float) -> dict:
    """
    Возвращает торговую интерпретацию DFA-экспоненты.

    Parameters
    ----------
    alpha : DFA-экспонента из compute_dfa()

    Returns
    -------
    dict с полями:
        alpha         : само значение
        regime        : строковый режим рынка
        signal        : рекомендация для бота
        memory        : тип памяти ряда
    """
    if alpha < 0.35:
        regime = "strong_mean_reversion"
        signal = "SELL_STRENGTH_BUY_WEAKNESS"
        memory = "strong_antipersistent"
    elif alpha < 0.45:
        regime = "mean_reversion"
        signal = "MEAN_REVERSION_STRATEGY"
        memory = "antipersistent"
    elif alpha < 0.55:
        regime = "random_walk"
        signal = "NEUTRAL_NO_EDGE"
        memory = "no_memory"
    elif alpha < 0.65:
        regime = "weak_trend"
        signal = "LIGHT_TREND_FOLLOWING"
        memory = "weak_persistent"
    elif alpha < 0.80:
        regime = "trend"
        signal = "TREND_FOLLOWING"
        memory = "persistent"
    else:
        regime = "strong_trend"
        signal = "STRONG_TREND_FOLLOWING"
        memory = "strong_persistent"

    return {
        "alpha": round(alpha, 4),
        "regime": regime,
        "signal": signal,
        "memory": memory,
    }


# ---------------------------------------------------------------------------
# Rolling DFA (для живого потока)
# ---------------------------------------------------------------------------

def rolling_dfa(
    series: np.ndarray,
    window: int = 200,
    step: int = 1,
    min_box: int = 4,
    num_scales: int = 15,
    order: int = 1,
) -> np.ndarray:
    """
    Скользящий DFA: вычисляет α для каждого окна размером `window`.

    Parameters
    ----------
    series     : полный временной ряд
    window     : размер скользящего окна
    step       : шаг сдвига окна
    min_box    : минимальный размер сегмента
    num_scales : количество масштабов
    order      : порядок полинома детрендинга

    Returns
    -------
    alphas : 1-D array длиной len(series),
             заполнен NaN там, где окно ещё не набрано
    """
    series = np.asarray(series, dtype=float)
    n = len(series)
    alphas = np.full(n, np.nan)

    for end in range(window, n + 1, step):
        start = end - window
        try:
            alpha, _, _ = compute_dfa(
                series[start:end],
                min_box=min_box,
                num_scales=num_scales,
                order=order,
            )
            alphas[end - 1] = alpha
        except ValueError:
            pass

    return alphas


# ---------------------------------------------------------------------------
# Быстрый сигнал для бота
# ---------------------------------------------------------------------------

def dfa_signal(
    series: np.ndarray,
    window: Optional[int] = None,
    **dfa_kwargs,
) -> dict:
    """
    Универсальная точка входа: возвращает α + интерпретацию.

    Parameters
    ----------
    series  : временной ряд (цены или log-доходности)
    window  : если задан — берёт последние `window` точек
    **dfa_kwargs : прокидываются в compute_dfa()

    Returns
    -------
    dict: alpha, regime, signal, memory
    """
    s = np.asarray(series, dtype=float)
    if window is not None:
        s = s[-window:]

    alpha, _, _ = compute_dfa(s, **dfa_kwargs)
    return interpret_alpha(alpha)


# ---------------------------------------------------------------------------
# Вспомогательные утилиты
# ---------------------------------------------------------------------------

def log_returns(prices: np.ndarray) -> np.ndarray:
    """Логарифмические доходности из массива цен."""
    prices = np.asarray(prices, dtype=float)
    return np.diff(np.log(prices))


def hurst_from_alpha(alpha: float) -> float:
    """
    Приближённый показатель Херста из DFA-экспоненты.
    Для стационарного ряда H ≈ α.
    """
    return alpha


# ---------------------------------------------------------------------------
# Пример использования
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    np.random.seed(42)

    # --- Случайное блуждание ---
    rw = np.cumsum(np.random.randn(1000))
    result = dfa_signal(rw)
    print("Random Walk →", result)

    # --- Персистентный ряд (трендовый) ---
    trend_series = np.cumsum(np.random.randn(1000)) + np.linspace(0, 50, 1000)
    result2 = dfa_signal(trend_series)
    print("Trend Series →", result2)

    # --- Rolling DFA на доходностях ---
    prices = 100 * np.cumprod(1 + np.random.randn(500) * 0.01)
    returns = log_returns(prices)
    alphas = rolling_dfa(returns, window=120, step=10)
    last_valid = alphas[~np.isnan(alphas)]
    if len(last_valid):
        print("Last rolling α:", round(last_valid[-1], 4))
        print("Interpretation:", interpret_alpha(last_valid[-1]))
