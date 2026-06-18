import numpy as np


def calculate_hurst_exponent(price_series: list | np.ndarray, min_lag: int = 2, max_lag: int = 100) -> dict:
    """
    Вычисляет показатель Хёрста (Hurst Exponent) методом R/S-анализа.

    Интерпретация результата:
        H < 0.5  — рынок возвратный (mean-reverting), цена стремится к среднему
        H ≈ 0.5  — случайное блуждание, нет выраженной структуры
        H > 0.5  — рынок трендовый, движение имеет память

    Args:
        price_series: Временной ряд цен (close prices).
        min_lag:      Минимальный лаг для R/S-анализа (>=2).
        max_lag:      Максимальный лаг (не более len(series)//2).

    Returns:
        dict с ключами:
            'hurst'         — значение показателя Хёрста (float)
            'interpretation'— строка: 'trending', 'random', 'mean_reverting'
            'confidence'    — уверенность на основе отклонения от 0.5
    """
    ts = np.array(price_series, dtype=float)
    n = len(ts)

    if n < 20:
        raise ValueError("Слишком короткий ряд. Минимум 20 точек.")

    max_lag = min(max_lag, n // 2)
    if max_lag < min_lag:
        raise ValueError(f"max_lag ({max_lag}) меньше min_lag ({min_lag}).")

    lags = range(min_lag, max_lag + 1)
    rs_values = []

    for lag in lags:
        # Разбиваем ряд на непересекающиеся окна размером lag
        num_windows = n // lag
        if num_windows < 1:
            continue

        rs_per_window = []
        for i in range(num_windows):
            window = ts[i * lag: (i + 1) * lag]

            # Логарифмические доходности
            returns = np.diff(np.log(window))
            if len(returns) == 0:
                continue

            mean_ret = np.mean(returns)
            deviations = np.cumsum(returns - mean_ret)

            r = np.max(deviations) - np.min(deviations)  # Размах
            s = np.std(returns, ddof=1)                  # Стандартное отклонение

            if s > 0:
                rs_per_window.append(r / s)

        if rs_per_window:
            rs_values.append((lag, np.mean(rs_per_window)))

    if len(rs_values) < 2:
        raise ValueError("Недостаточно данных для вычисления показателя Хёрста.")

    log_lags = np.log([v[0] for v in rs_values])
    log_rs   = np.log([v[1] for v in rs_values])

    # Линейная регрессия: log(R/S) = H * log(lag) + const
    hurst, _ = np.polyfit(log_lags, log_rs, 1)

    # Интерпретация
    if hurst > 0.55:
        interpretation = "trending"
    elif hurst < 0.45:
        interpretation = "mean_reverting"
    else:
        interpretation = "random"

    confidence = abs(hurst - 0.5) / 0.5  # 0.0 — нет уверенности, 1.0 — максимум

    return {
        "hurst": round(hurst, 4),
        "interpretation": interpretation,
        "confidence": round(confidence, 4),
    }


# ---------------------------------------------------------------------------
# Пример использования
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    np.random.seed(42)

    # Синтетический трендовый ряд
    trend = np.cumsum(np.random.randn(500)) + 100
    result = calculate_hurst_exponent(trend)
    print("Трендовый ряд:", result)

    # Синтетический возвратный ряд (mean-reverting)
    mean_rev = 100 + np.sin(np.linspace(0, 10 * np.pi, 500)) * 5 + np.random.randn(500) * 0.5
    result = calculate_hurst_exponent(mean_rev)
    print("Возвратный ряд:", result)
