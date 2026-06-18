"""
Singular Spectrum Analysis — Скрытые циклы

Декомпозиция временного ряда через траекторную матрицу и SVD.
Позволяет извлечь тренд, периодические компоненты и шум без
предположений о форме цикла или стационарности ряда.
"""

import numpy as np
from typing import Optional, Union


# ---------------------------------------------------------------------------
# Шаг 1: Вложение — построение траекторной матрицы
# ---------------------------------------------------------------------------

def embed(series: np.ndarray, L: int) -> np.ndarray:
    """
    Строит траекторную (ганкелеву) матрицу размера (L, K),
    где K = N - L + 1.

    Parameters
    ----------
    series : np.ndarray, shape (N,) — одномерный временной ряд
    L      : int — длина окна вложения (1 < L < N)

    Returns
    -------
    np.ndarray, shape (L, K)
    """
    N = len(series)
    if not (1 < L < N):
        raise ValueError(f"L должно быть от 2 до N-1={N - 1}, получено L={L}")
    K = N - L + 1
    X = np.empty((L, K), dtype=float)
    for i in range(K):
        X[:, i] = series[i : i + L]
    return X


# ---------------------------------------------------------------------------
# Шаг 2: SVD
# ---------------------------------------------------------------------------

def decompose(X: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """
    Выполняет SVD траекторной матрицы.

    Parameters
    ----------
    X : np.ndarray, shape (L, K)

    Returns
    -------
    U  : np.ndarray, shape (L, r)  — левые сингулярные векторы
    s  : np.ndarray, shape (r,)    — сингулярные числа (убывающий порядок)
    Vt : np.ndarray, shape (r, K)  — правые сингулярные векторы (транспонированные)
    """
    U, s, Vt = np.linalg.svd(X, full_matrices=False)
    return U, s, Vt


def singular_values(series: np.ndarray, L: int) -> np.ndarray:
    """
    Удобная обёртка: возвращает только сингулярные числа.

    Parameters
    ----------
    series : np.ndarray, shape (N,)
    L      : int

    Returns
    -------
    np.ndarray, shape (r,) — сингулярные числа по убыванию
    """
    X = embed(series, L)
    _, s, _ = decompose(X)
    return s


def explained_variance(s: np.ndarray) -> np.ndarray:
    """
    Доля дисперсии, объясняемой каждой компонентой SVD.

    Parameters
    ----------
    s : np.ndarray — сингулярные числа

    Returns
    -------
    np.ndarray — доли (сумма = 1.0)
    """
    s2 = s ** 2
    return s2 / (s2.sum() + 1e-12)


# ---------------------------------------------------------------------------
# Шаг 3: Группировка компонент
# ---------------------------------------------------------------------------

def reconstruct_component(
    U: np.ndarray,
    s: np.ndarray,
    Vt: np.ndarray,
    indices: Union[int, list[int]],
    N: int,
) -> np.ndarray:
    """
    Восстанавливает временной ряд для группы компонент через диагональное усреднение
    (ганкелизацию).

    Parameters
    ----------
    U       : np.ndarray, shape (L, r)
    s       : np.ndarray, shape (r,)
    Vt      : np.ndarray, shape (r, K)
    indices : int или list[int] — индексы компонент для группировки
    N       : int — длина исходного ряда

    Returns
    -------
    np.ndarray, shape (N,)
    """
    if isinstance(indices, int):
        indices = [indices]

    L = U.shape[0]
    K = Vt.shape[1]

    Xi = np.zeros((L, K))
    for i in indices:
        Xi += s[i] * np.outer(U[:, i], Vt[i, :])

    return hankel_average(Xi, N)


def hankel_average(Xi: np.ndarray, N: int) -> np.ndarray:
    """
    Диагональное усреднение матрицы Xi для получения временного ряда.

    Parameters
    ----------
    Xi : np.ndarray, shape (L, K)
    N  : int — N = L + K - 1

    Returns
    -------
    np.ndarray, shape (N,)
    """
    L, K = Xi.shape
    result = np.zeros(N)
    counts = np.zeros(N)

    for i in range(L):
        for j in range(K):
            result[i + j] += Xi[i, j]
            counts[i + j] += 1

    return result / np.maximum(counts, 1)


# ---------------------------------------------------------------------------
# Шаг 4: Автоматическая группировка по w-корреляции
# ---------------------------------------------------------------------------

def w_correlation_matrix(
    U: np.ndarray,
    s: np.ndarray,
    Vt: np.ndarray,
    N: int,
    max_components: Optional[int] = None,
) -> np.ndarray:
    """
    Матрица w-корреляций между компонентами SSA.

    Близкие к 1 (по модулю) значения указывают на компоненты одного цикла —
    их следует группировать вместе.

    Parameters
    ----------
    U, s, Vt       : результаты SVD
    N              : длина исходного ряда
    max_components : ограничить число компонент

    Returns
    -------
    np.ndarray, shape (r, r) — матрица w-корреляций
    """
    r = len(s)
    if max_components is not None:
        r = min(r, max_components)

    L = U.shape[0]
    K = Vt.shape[1]

    # Веса для скалярного произведения
    w = np.array([
        min(i + 1, L, K, N - i)
        for i in range(N)
    ], dtype=float)

    # Восстанавливаем все нужные компоненты
    components = np.array([
        reconstruct_component(U, s, Vt, i, N) for i in range(r)
    ])  # (r, N)

    # W-норма каждой компоненты
    norms = np.sqrt(np.array([
        np.dot(w, c ** 2) for c in components
    ]))  # (r,)

    wcorr = np.zeros((r, r))
    for i in range(r):
        for j in range(i, r):
            num = np.dot(w, components[i] * components[j])
            denom = norms[i] * norms[j]
            val = num / (denom + 1e-12)
            wcorr[i, j] = val
            wcorr[j, i] = val

    return wcorr


def auto_group(
    wcorr: np.ndarray,
    threshold: float = 0.8,
) -> list[list[int]]:
    """
    Жадная группировка компонент по матрице w-корреляций.

    Parameters
    ----------
    wcorr     : np.ndarray, shape (r, r)
    threshold : float — минимальный |w-корреляция| для объединения

    Returns
    -------
    list[list[int]] — список групп (каждая группа = список индексов)
    """
    r = wcorr.shape[0]
    used = [False] * r
    groups = []

    for i in range(r):
        if used[i]:
            continue
        group = [i]
        used[i] = True
        for j in range(i + 1, r):
            if not used[j] and abs(wcorr[i, j]) >= threshold:
                group.append(j)
                used[j] = True
        groups.append(group)

    return groups


# ---------------------------------------------------------------------------
# Оценка периодичности компонент
# ---------------------------------------------------------------------------

def estimate_period(component: np.ndarray) -> float:
    """
    Оценивает период доминирующей частоты в компоненте через FFT.

    Parameters
    ----------
    component : np.ndarray, shape (N,)

    Returns
    -------
    float — период в единицах ряда (0 = апериодично / тренд)
    """
    N = len(component)
    fft_vals = np.abs(np.fft.rfft(component - component.mean()))
    freqs = np.fft.rfftfreq(N)

    if freqs[1:].size == 0:
        return 0.0

    peak_idx = np.argmax(fft_vals[1:]) + 1
    freq = freqs[peak_idx]
    return float(1.0 / freq) if freq > 0 else 0.0


def component_periodicity_score(component: np.ndarray) -> float:
    """
    Оценка «периодичности» компоненты от 0 (шум/тренд) до 1 (чистый синус).

    Вычисляется как доля энергии в пике FFT относительно всей спектральной энергии.

    Parameters
    ----------
    component : np.ndarray

    Returns
    -------
    float in [0, 1]
    """
    c = component - component.mean()
    fft_vals = np.abs(np.fft.rfft(c)) ** 2
    total = fft_vals.sum()
    if total < 1e-12:
        return 0.0
    peak = fft_vals[1:].max()  # исключаем DC
    return float(peak / total)


# ---------------------------------------------------------------------------
# Прогнозирование (Linear Recurrence Formula)
# ---------------------------------------------------------------------------

def lrf_forecast(
    series: np.ndarray,
    L: int,
    U: np.ndarray,
    r: Optional[int] = None,
    steps: int = 10,
) -> np.ndarray:
    """
    Прогноз по формуле линейной рекуррентности (LRF) SSA.

    Уравнение: x_{n} = sum_{k=1}^{L-1} a_k * x_{n-k}
    Коэффициенты a_k вычисляются из ведущих собственных векторов.

    Parameters
    ----------
    series : np.ndarray, shape (N,) — исходный ряд
    L      : int — то же окно, что при разложении
    U      : np.ndarray, shape (L, r_full) — все левые сингулярные векторы
    r      : int или None — использовать первые r компонент; None = все
    steps  : int — горизонт прогноза

    Returns
    -------
    np.ndarray, shape (steps,) — прогнозные значения
    """
    r_use = U.shape[1] if r is None else min(r, U.shape[1])
    U_r = U[:, :r_use]  # (L, r)

    # Вертикальность (verticality): вес последней строки U
    nu2 = np.sum(U_r[-1, :] ** 2)
    if nu2 >= 1.0:
        raise ValueError("Вертикальность = 1: прогноз невозможен (измените L или r)")

    # Коэффициенты LRF
    R = U_r[:-1, :]   # (L-1, r)
    pi = U_r[-1, :]   # (r,)
    a = R @ pi / (1 - nu2)  # (L-1,)

    # Рекуррентное вычисление
    history = list(series.copy())
    for _ in range(steps):
        x_new = float(np.dot(a, history[-(L - 1):][::-1]))
        history.append(x_new)

    return np.array(history[len(series):])


# ---------------------------------------------------------------------------
# Детектор изменения структуры цикла (rolling SSA)
# ---------------------------------------------------------------------------

def rolling_cycle_strength(
    series: np.ndarray,
    L: int,
    window: int,
    step: int = 1,
    n_components: int = 6,
    periodicity_threshold: float = 0.3,
) -> np.ndarray:
    """
    Суммарная «мощность» периодических компонент в скользящем окне.

    Резкое изменение → смена доминирующих циклов (разворот режима).

    Parameters
    ----------
    series                : np.ndarray, shape (N,)
    L                     : int — окно вложения SSA
    window                : int — ширина скользящего окна ряда
    step                  : int
    n_components          : int — анализировать первые n компонент
    periodicity_threshold : float — минимальный periodicity_score для учёта

    Returns
    -------
    np.ndarray, shape (K,) — мощность циклических компонент (доля дисперсии)
    """
    N = len(series)
    strengths = []

    for start in range(0, N - window + 1, step):
        chunk = series[start : start + window]
        X = embed(chunk, L)
        U, s, Vt = decompose(X)
        ev = explained_variance(s)

        total_cyclic = 0.0
        for i in range(min(n_components, len(s))):
            comp = reconstruct_component(U, s, Vt, i, window)
            score = component_periodicity_score(comp)
            if score >= periodicity_threshold:
                total_cyclic += float(ev[i])

        strengths.append(total_cyclic)

    return np.array(strengths)


def rolling_dominant_period(
    series: np.ndarray,
    L: int,
    window: int,
    step: int = 1,
    component: int = 1,
) -> np.ndarray:
    """
    Доминирующий период первой периодической компоненты в скользящем окне.

    Parameters
    ----------
    series    : np.ndarray, shape (N,)
    L         : int — окно вложения
    window    : int — ширина окна ряда
    step      : int
    component : int — индекс компоненты (0 = тренд, 1+ = циклы)

    Returns
    -------
    np.ndarray, shape (K,) — периоды
    """
    N = len(series)
    periods = []

    for start in range(0, N - window + 1, step):
        chunk = series[start : start + window]
        X = embed(chunk, L)
        U, s, Vt = decompose(X)
        comp = reconstruct_component(U, s, Vt, component, window)
        periods.append(estimate_period(comp))

    return np.array(periods)


# ---------------------------------------------------------------------------
# Высокоуровневый пайплайн
# ---------------------------------------------------------------------------

def analyze(
    series: np.ndarray,
    L: Optional[int] = None,
    n_components: int = 10,
    group_threshold: float = 0.8,
    forecast_steps: int = 0,
    forecast_r: Optional[int] = None,
) -> dict:
    """
    Полный SSA-анализ временного ряда.

    Parameters
    ----------
    series          : np.ndarray, shape (N,) — одномерный ряд (цены или доходности)
    L               : int или None — окно вложения; по умолчанию N // 2
    n_components    : int — анализировать первых n компонент
    group_threshold : float — порог w-корреляции для группировки
    forecast_steps  : int — горизонт прогноза (0 = не прогнозировать)
    forecast_r      : int или None — число компонент для LRF

    Returns
    -------
    dict:
        'L'               — использованное окно вложения
        'N'               — длина ряда
        'singular_values' — все сингулярные числа
        'explained'       — доля дисперсии каждой компоненты
        'components'      — np.ndarray (n_components, N): восстановленные ряды
        'periods'         — оценки периода каждой компоненты (в единицах ряда)
        'periodicity'     — оценка периодичности [0, 1] каждой компоненты
        'wcorr'           — матрица w-корреляций (n_components × n_components)
        'groups'          — автоматические группы компонент
        'group_series'    — восстановленные ряды для каждой группы
        'trend'           — ряд тренда (группа с наименее периодичной компонентой)
        'residual'        — остаток = series - sum(group_series)
        'forecast'        — прогноз (если forecast_steps > 0, иначе None)
        'U', 's', 'Vt'   — результаты SVD для дальнейшего использования
    """
    N = len(series)
    if L is None:
        L = N // 2

    X = embed(series, L)
    U, s, Vt = decompose(X)

    r = min(n_components, len(s))
    ev = explained_variance(s)

    # Восстановление компонент
    components = np.array([
        reconstruct_component(U, s, Vt, i, N) for i in range(r)
    ])

    # Характеристики компонент
    periods = np.array([estimate_period(components[i]) for i in range(r)])
    periodicity = np.array([component_periodicity_score(components[i]) for i in range(r)])

    # W-корреляция и группировка
    wcorr = w_correlation_matrix(U, s, Vt, N, max_components=r)
    groups = auto_group(wcorr, threshold=group_threshold)

    # Ряды по группам
    group_series = []
    for g in groups:
        gs = reconstruct_component(U, s, Vt, g, N)
        group_series.append(gs)

    # Тренд = группа, чья первая компонента наименее периодична
    trend_group_idx = int(np.argmin([periodicity[g[0]] for g in groups]))
    trend = group_series[trend_group_idx]

    # Остаток
    residual = series - np.sum(group_series, axis=0)

    # Прогноз
    forecast = None
    if forecast_steps > 0:
        r_lrf = forecast_r or r
        forecast = lrf_forecast(series, L, U, r=r_lrf, steps=forecast_steps)

    return {
        "L": L,
        "N": N,
        "singular_values": s,
        "explained": ev,
        "components": components,
        "periods": periods,
        "periodicity": periodicity,
        "wcorr": wcorr,
        "groups": groups,
        "group_series": group_series,
        "trend": trend,
        "residual": residual,
        "forecast": forecast,
        "U": U,
        "s": s,
        "Vt": Vt,
    }


# ---------------------------------------------------------------------------
# Пример использования
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    rng = np.random.default_rng(42)
    N = 300

    # Синтетический ряд: тренд + цикл 20 периодов + цикл 7 периодов + шум
    t = np.arange(N)
    series = (
        0.05 * t
        + 3.0 * np.sin(2 * np.pi * t / 20)
        + 1.5 * np.sin(2 * np.pi * t / 7)
        + rng.normal(0, 0.5, N)
    )

    result = analyze(series, L=60, n_components=12, forecast_steps=20)

    print(f"Длина ряда      : {result['N']}")
    print(f"Окно вложения L : {result['L']}")
    print(f"Число групп     : {len(result['groups'])}")
    print(f"\nТоп-10 компонент:")
    print(f"  {'#':>3}  {'σ':>8}  {'дисп%':>7}  {'период':>8}  {'периодичн':>10}")
    for i in range(min(10, len(result['singular_values']))):
        print(
            f"  {i:>3}  "
            f"{result['singular_values'][i]:>8.3f}  "
            f"{result['explained'][i] * 100:>6.2f}%  "
            f"{result['periods'][i]:>8.1f}  "
            f"{result['periodicity'][i]:>10.3f}"
        )

    print(f"\nГруппы (w-корр порог=0.8): {result['groups']}")

    if result["forecast"] is not None:
        print(f"\nПрогноз ({len(result['forecast'])} шагов): "
              f"{result['forecast'].round(3)}")

    # Rolling-анализ
    strength = rolling_cycle_strength(series, L=30, window=100, step=10)
    dom_period = rolling_dominant_period(series, L=30, window=100, step=10, component=1)
    print(f"\nМощность циклов (rolling): min={strength.min():.3f}  max={strength.max():.3f}")
    print(f"Доминирующий период (rolling): {dom_period.round(1)}")
