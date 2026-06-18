import numpy as np


def random_matrix_theory(
    price_matrix: list | np.ndarray,
    significance_threshold: float = 0.01,
) -> dict:
    """
    Применяет Random Matrix Theory (RMT) для разделения реальных корреляций
    от шума в матрице корреляций активов.

    Метод основан на распределении Марченко-Пастура: собственные значения
    матрицы корреляций чистого шума укладываются в предсказуемый диапазон
    [λ_min, λ_max]. Всё, что выходит за λ_max — реальный сигнал.

    Распределение Марченко-Пастура:
        λ_max = σ² * (1 + √(N/T))²
        λ_min = σ² * (1 - √(N/T))²

        N — число активов, T — число наблюдений, σ² = 1 (нормированные доходности)

    Интерпретация:
        eigenvalues > λ_max  — реальные корреляции (информация)
        eigenvalues ≤ λ_max  — шум (случайные совпадения)
        signal_ratio         — доля дисперсии, объяснённой реальными корреляциями
        largest_eigenvalue   — часто соответствует «рыночному» фактору

    Args:
        price_matrix:           2D массив цен форм (T, N): T наблюдений, N активов.
        significance_threshold: Запас сверх λ_max для строгой фильтрации (по умолчанию 0.01).

    Returns:
        dict с ключами:
            'n_assets'             — число активов (N)
            'n_observations'       — число наблюдений (T)
            'lambda_max'           — верхняя граница шума (Марченко-Пастур)
            'lambda_min'           — нижняя граница шума
            'n_signal_components'  — число собственных значений выше λ_max (сигнал)
            'n_noise_components'   — число собственных значений в зоне шума
            'signal_ratio'         — доля дисперсии от реальных корреляций (0.0–1.0)
            'largest_eigenvalue'   — наибольшее собственное значение (рыночный фактор)
            'signal_eigenvalues'   — список собственных значений выше λ_max
            'classification'       — 'high_signal', 'mixed', 'noise_dominated'
    """
    prices = np.array(price_matrix, dtype=float)

    if prices.ndim != 2:
        raise ValueError("price_matrix должен быть двумерным массивом (T, N).")

    T, N = prices.shape

    if T < N:
        raise ValueError(
            f"Число наблюдений T={T} должно быть больше числа активов N={N}."
        )
    if N < 2:
        raise ValueError("Нужно минимум 2 актива.")

    # Логарифмические доходности и нормализация
    returns = np.diff(np.log(prices), axis=0)          # (T-1, N)
    T_ret = returns.shape[0]

    mean = returns.mean(axis=0)
    std  = returns.std(axis=0, ddof=1)
    std[std == 0] = 1.0
    norm_returns = (returns - mean) / std              # стандартизированные доходности

    # Матрица корреляций
    corr_matrix = np.corrcoef(norm_returns.T)          # (N, N)

    # Собственные значения (симметричная матрица → все вещественные)
    eigenvalues = np.linalg.eigvalsh(corr_matrix)
    eigenvalues = np.sort(eigenvalues)[::-1]           # по убыванию

    # Границы Марченко-Пастура (σ²=1 для нормированных доходностей)
    q = T_ret / N                                      # соотношение наблюдений к активам
    lambda_max = (1.0 + 1.0 / np.sqrt(q)) ** 2
    lambda_min = (1.0 - 1.0 / np.sqrt(q)) ** 2

    threshold = lambda_max + significance_threshold

    # Разделение сигнал / шум
    signal_mask       = eigenvalues > threshold
    signal_eigenvalues = eigenvalues[signal_mask].tolist()
    n_signal          = int(signal_mask.sum())
    n_noise           = N - n_signal

    # Доля дисперсии от сигнальных компонент
    total_variance  = float(np.sum(np.abs(eigenvalues)))
    signal_variance = float(np.sum(np.abs(eigenvalues[signal_mask])))
    signal_ratio    = signal_variance / total_variance if total_variance > 0 else 0.0

    # Классификация
    if signal_ratio >= 0.5:
        classification = "high_signal"
    elif signal_ratio >= 0.2:
        classification = "mixed"
    else:
        classification = "noise_dominated"

    return {
        "n_assets": N,
        "n_observations": T_ret,
        "lambda_max": round(lambda_max, 6),
        "lambda_min": round(lambda_min, 6),
        "n_signal_components": n_signal,
        "n_noise_components": n_noise,
        "signal_ratio": round(signal_ratio, 4),
        "largest_eigenvalue": round(float(eigenvalues[0]), 4),
        "signal_eigenvalues": [round(v, 4) for v in signal_eigenvalues],
        "classification": classification,
    }


# ---------------------------------------------------------------------------
# Пример использования
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    rng = np.random.default_rng(42)
    T, N = 252, 10  # год дневных данных, 10 активов

    # Чистый шум — нет реальных корреляций
    noise_prices = 100 * np.exp(np.cumsum(rng.standard_normal((T, N)) * 0.01, axis=0))
    res = random_matrix_theory(noise_prices)
    print("Шумовой рынок:")
    for k, v in res.items():
        print(f"  {k}: {v}")

    print()

    # Реальные корреляции — активы движутся вместе через общий фактор
    market_factor = np.cumsum(rng.standard_normal(T) * 0.01)
    correlated = np.column_stack([
        100 * np.exp(market_factor * rng.uniform(0.5, 1.5) +
                     np.cumsum(rng.standard_normal(T) * 0.005, axis=0))
        for _ in range(N)
    ])
    res = random_matrix_theory(correlated)
    print("Коррелированный рынок:")
    for k, v in res.items():
        print(f"  {k}: {v}")
