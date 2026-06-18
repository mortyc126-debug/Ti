"""
Eigenvalue Spectrum — Структура коллективного поведения

Анализ корреляционной матрицы активов через спектр собственных значений.
Позволяет отделить рыночный шум от реальных факторов движения цен,
выявить доминирующие компоненты и отследить изменения в структуре рынка.
"""

import numpy as np
from typing import Optional


# ---------------------------------------------------------------------------
# Ядро: построение и очистка корреляционной матрицы
# ---------------------------------------------------------------------------

def compute_log_returns(prices: np.ndarray) -> np.ndarray:
    """
    Преобразует матрицу цен в матрицу логарифмических доходностей.

    Parameters
    ----------
    prices : np.ndarray, shape (T, N)
        Временной ряд цен: T периодов, N активов.

    Returns
    -------
    np.ndarray, shape (T-1, N)
    """
    return np.diff(np.log(prices), axis=0)


def build_correlation_matrix(returns: np.ndarray) -> np.ndarray:
    """
    Строит эмпирическую корреляционную матрицу активов.

    Parameters
    ----------
    returns : np.ndarray, shape (T, N)

    Returns
    -------
    np.ndarray, shape (N, N)
    """
    T, N = returns.shape
    normalized = (returns - returns.mean(axis=0)) / (returns.std(axis=0) + 1e-12)
    return (normalized.T @ normalized) / T


# ---------------------------------------------------------------------------
# Теоретический шум: закон Марченко–Пастура
# ---------------------------------------------------------------------------

def marchenko_pastur_bounds(T: int, N: int, sigma: float = 1.0) -> tuple[float, float]:
    """
    Возвращает границы спектра случайной корреляционной матрицы
    согласно закону Марченко–Пастура.

    Parameters
    ----------
    T : int   — число наблюдений (строк)
    N : int   — число активов (столбцов)
    sigma : float — дисперсия элементов (обычно 1 для нормированных данных)

    Returns
    -------
    (lambda_min, lambda_max)
    """
    q = T / N  # должен быть > 1
    factor = sigma ** 2
    lambda_max = factor * (1 + 1 / np.sqrt(q)) ** 2
    lambda_min = factor * (1 - 1 / np.sqrt(q)) ** 2
    return lambda_min, lambda_max


def marchenko_pastur_pdf(
    lambdas: np.ndarray,
    T: int,
    N: int,
    sigma: float = 1.0,
) -> np.ndarray:
    """
    Плотность распределения Марченко–Пастура в точках `lambdas`.

    Parameters
    ----------
    lambdas : np.ndarray — точки оси собственных значений
    T, N, sigma — те же, что в marchenko_pastur_bounds

    Returns
    -------
    np.ndarray плотности (нулевое значение вне поддержки)
    """
    q = T / N
    lmin, lmax = marchenko_pastur_bounds(T, N, sigma)
    pdf = np.zeros_like(lambdas, dtype=float)
    mask = (lambdas >= lmin) & (lambdas <= lmax)
    l = lambdas[mask]
    pdf[mask] = (q / (2 * np.pi * sigma ** 2 * l)) * np.sqrt((lmax - l) * (l - lmin))
    return pdf


# ---------------------------------------------------------------------------
# Спектральный анализ
# ---------------------------------------------------------------------------

def eigenvalue_spectrum(
    corr: np.ndarray,
) -> tuple[np.ndarray, np.ndarray]:
    """
    Вычисляет собственные значения и векторы корреляционной матрицы,
    отсортированные по убыванию.

    Parameters
    ----------
    corr : np.ndarray, shape (N, N) — симметричная корреляционная матрица

    Returns
    -------
    eigenvalues  : np.ndarray, shape (N,)
    eigenvectors : np.ndarray, shape (N, N) — столбцы = собственные векторы
    """
    vals, vecs = np.linalg.eigh(corr)
    order = np.argsort(vals)[::-1]
    return vals[order], vecs[:, order]


def split_signal_noise(
    eigenvalues: np.ndarray,
    eigenvectors: np.ndarray,
    T: int,
    N: int,
    sigma: float = 1.0,
) -> dict:
    """
    Разделяет собственные значения на информативные (сигнал) и шумовые,
    используя границу Марченко–Пастура.

    Returns
    -------
    dict с ключами:
        'signal_values'   — собственные значения выше порога шума
        'signal_vectors'  — соответствующие собственные векторы
        'noise_values'    — собственные значения в зоне шума
        'noise_vectors'   — соответствующие собственные векторы
        'lambda_max'      — верхняя граница шума МП
        'n_signal'        — число информативных компонент
    """
    _, lambda_max = marchenko_pastur_bounds(T, N, sigma)
    signal_mask = eigenvalues > lambda_max
    noise_mask = ~signal_mask

    return {
        "signal_values": eigenvalues[signal_mask],
        "signal_vectors": eigenvectors[:, signal_mask],
        "noise_values": eigenvalues[noise_mask],
        "noise_vectors": eigenvectors[:, noise_mask],
        "lambda_max": lambda_max,
        "n_signal": int(signal_mask.sum()),
    }


def explained_variance_ratio(eigenvalues: np.ndarray) -> np.ndarray:
    """
    Доля дисперсии, объясняемой каждой компонентой.

    Parameters
    ----------
    eigenvalues : np.ndarray (уже отсортированы по убыванию)

    Returns
    -------
    np.ndarray той же длины, сумма = 1.0
    """
    total = eigenvalues.sum()
    return eigenvalues / (total + 1e-12)


def effective_rank(eigenvalues: np.ndarray, threshold: float = 0.95) -> int:
    """
    Минимальное число компонент, объясняющих `threshold` доли дисперсии.

    Parameters
    ----------
    eigenvalues : np.ndarray
    threshold   : float, 0 < threshold <= 1

    Returns
    -------
    int
    """
    ratios = explained_variance_ratio(eigenvalues)
    cumulative = np.cumsum(ratios)
    result = int(np.searchsorted(cumulative, threshold)) + 1
    return min(result, len(eigenvalues))


# ---------------------------------------------------------------------------
# Реконструкция «очищенной» матрицы
# ---------------------------------------------------------------------------

def denoise_correlation_matrix(
    eigenvalues: np.ndarray,
    eigenvectors: np.ndarray,
    T: int,
    N: int,
    sigma: float = 1.0,
    shrink_noise: bool = True,
) -> np.ndarray:
    """
    Строит «очищенную» корреляционную матрицу, в которой шумовые
    собственные значения заменены их средним (shrink) или нулём.

    Parameters
    ----------
    eigenvalues  : np.ndarray, shape (N,)
    eigenvectors : np.ndarray, shape (N, N)
    T, N, sigma  : параметры для границы МП
    shrink_noise : если True — шумовые значения усредняются (shrinkage),
                   если False — обнуляются

    Returns
    -------
    np.ndarray, shape (N, N) — очищенная корреляционная матрица
    """
    _, lambda_max = marchenko_pastur_bounds(T, N, sigma)
    clean_vals = eigenvalues.copy()
    noise_mask = clean_vals <= lambda_max

    if shrink_noise and noise_mask.any():
        clean_vals[noise_mask] = clean_vals[noise_mask].mean()
    else:
        clean_vals[noise_mask] = 0.0

    # Реконструкция: C = V * diag(λ) * V^T
    corr_clean = eigenvectors @ np.diag(clean_vals) @ eigenvectors.T

    # Нормировка диагонали до 1 (корреляционная матрица)
    d = np.sqrt(np.diag(corr_clean))
    d[d == 0] = 1.0
    corr_clean = corr_clean / np.outer(d, d)
    np.fill_diagonal(corr_clean, 1.0)
    return corr_clean


# ---------------------------------------------------------------------------
# Детектор структурных изменений (rolling)
# ---------------------------------------------------------------------------

def rolling_spectral_entropy(
    returns: np.ndarray,
    window: int,
    step: int = 1,
) -> np.ndarray:
    """
    Спектральная энтропия скользящего окна.

    Высокая энтропия → равномерное распределение собственных значений → рынок в хаосе.
    Низкая энтропия  → доминирует 1–2 компоненты → сильная корреляция (кризис, тренд).

    Parameters
    ----------
    returns : np.ndarray, shape (T, N)
    window  : int — ширина окна в периодах
    step    : int — шаг скользящего окна

    Returns
    -------
    np.ndarray, shape (K,) — значения энтропии для каждого окна
    """
    T, N = returns.shape
    entropies = []

    for start in range(0, T - window + 1, step):
        chunk = returns[start : start + window]
        corr = build_correlation_matrix(chunk)
        vals, _ = eigenvalue_spectrum(corr)
        p = vals / (vals.sum() + 1e-12)
        p = p[p > 1e-12]
        entropy = -float(np.sum(p * np.log(p)))
        entropies.append(entropy)

    return np.array(entropies)


def rolling_n_signal(
    returns: np.ndarray,
    window: int,
    step: int = 1,
    sigma: float = 1.0,
) -> np.ndarray:
    """
    Число информативных факторов (выше шума МП) в скользящем окне.

    Рост числа факторов → усложнение структуры рынка.
    Падение до 1       → рынок движется «одной ногой» (паника/эйфория).

    Parameters
    ----------
    returns : np.ndarray, shape (T, N)
    window  : int
    step    : int
    sigma   : float

    Returns
    -------
    np.ndarray, shape (K,) — количество значимых компонент
    """
    T, N = returns.shape
    n_signals = []

    for start in range(0, T - window + 1, step):
        chunk = returns[start : start + window]
        corr = build_correlation_matrix(chunk)
        vals, vecs = eigenvalue_spectrum(corr)
        info = split_signal_noise(vals, vecs, window, N, sigma)
        n_signals.append(info["n_signal"])

    return np.array(n_signals)


# ---------------------------------------------------------------------------
# Портфельные метрики на основе спектра
# ---------------------------------------------------------------------------

def principal_portfolio_weights(
    eigenvectors: np.ndarray,
    component: int = 0,
) -> np.ndarray:
    """
    Веса портфеля, выровненного по `component`-й главной компоненте.

    Нулевая компонента — «рыночный» фактор (обычно почти равные веса).
    Первая и выше — факторы относительного движения (лонг/шорт внутри).

    Parameters
    ----------
    eigenvectors : np.ndarray, shape (N, K)  — матрица собственных векторов
    component    : int — индекс компоненты (0 = наибольшее собственное значение)

    Returns
    -------
    np.ndarray, shape (N,) — веса (нормированы по L1 среди ненулевых)
    """
    vec = eigenvectors[:, component].copy()
    norm = np.abs(vec).sum()
    return vec / (norm + 1e-12)


def condition_number(eigenvalues: np.ndarray) -> float:
    """
    Число обусловленности матрицы = λ_max / λ_min.

    Высокое значение → матрица плохо обусловлена, портфельная оптимизация нестабильна.

    Parameters
    ----------
    eigenvalues : np.ndarray (отсортированы по убыванию)

    Returns
    -------
    float
    """
    lmax = eigenvalues[0]
    lmin = eigenvalues[-1]
    if lmin <= 0:
        return float("inf")
    return float(lmax / lmin)


# ---------------------------------------------------------------------------
# Высокоуровневый пайплайн
# ---------------------------------------------------------------------------

def analyze(
    prices: np.ndarray,
    window: Optional[int] = None,
    sigma: float = 1.0,
    denoise: bool = True,
    explained_threshold: float = 0.95,
) -> dict:
    """
    Полный анализ спектра собственных значений корреляционной матрицы.

    Parameters
    ----------
    prices              : np.ndarray, shape (T, N) — цены активов
    window              : int или None — если задано, используется последнее окно
    sigma               : float — параметр дисперсии для МП
    denoise             : bool — применять ли очистку матрицы
    explained_threshold : float — порог для effective_rank

    Returns
    -------
    dict с полными результатами анализа:

    Ключи:
        'corr'              — исходная корреляционная матрица
        'corr_clean'        — очищенная матрица (если denoise=True)
        'eigenvalues'       — все собственные значения (убывающий порядок)
        'eigenvectors'      — матрица собственных векторов
        'signal'            — dict из split_signal_noise
        'explained_ratio'   — доля дисперсии каждой компоненты
        'effective_rank'    — число компонент для explained_threshold
        'condition_number'  — число обусловленности
        'market_weights'    — веса «рыночного» портфеля (1-я компонента)
        'lambda_max_mp'     — верхняя граница шума МП
        'T'                 — число наблюдений
        'N'                 — число активов
    """
    returns = compute_log_returns(prices)
    T, N = returns.shape

    if window is not None:
        if window > T:
            raise ValueError(f"window={window} превышает длину ряда доходностей T={T}")
        returns = returns[-window:]
        T = window

    corr = build_correlation_matrix(returns)
    vals, vecs = eigenvalue_spectrum(corr)
    signal = split_signal_noise(vals, vecs, T, N, sigma)

    result = {
        "corr": corr,
        "eigenvalues": vals,
        "eigenvectors": vecs,
        "signal": signal,
        "explained_ratio": explained_variance_ratio(vals),
        "effective_rank": effective_rank(vals, explained_threshold),
        "condition_number": condition_number(vals),
        "market_weights": principal_portfolio_weights(vecs, component=0),
        "lambda_max_mp": signal["lambda_max"],
        "T": T,
        "N": N,
    }

    if denoise:
        result["corr_clean"] = denoise_correlation_matrix(vals, vecs, T, N, sigma)

    return result


# ---------------------------------------------------------------------------
# Пример использования
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    rng = np.random.default_rng(42)
    T, N = 252, 20
    prices = np.cumprod(1 + rng.normal(0, 0.01, size=(T, N)), axis=0) * 100

    result = analyze(prices, window=120, denoise=True)

    print(f"Активов          : {result['N']}")
    print(f"Наблюдений       : {result['T']}")
    print(f"Значимых факторов: {result['signal']['n_signal']}")
    print(f"Граница шума МП  : {result['lambda_max_mp']:.4f}")
    print(f"Effective rank   : {result['effective_rank']}")
    print(f"Число обусловл.  : {result['condition_number']:.2f}")
    print(f"\nТоп-5 собств. значений: {result['eigenvalues'][:5].round(4)}")
    print(f"Объясн. дисперсия (топ-5): {result['explained_ratio'][:5].round(4)}")

    ent = rolling_spectral_entropy(np.diff(np.log(prices), axis=0), window=60, step=5)
    nsig = rolling_n_signal(np.diff(np.log(prices), axis=0), window=60, step=5)
    print(f"\nСредняя спектр. энтропия: {ent.mean():.4f}")
    print(f"Диапазон n_signal: [{nsig.min()}, {nsig.max()}]")
