"""
Multifractal Spectrum — Настройка стопов под разные масштабы турбулентности

Мультифрактальный анализ ценового ряда через метод MFDFA
(Multifractal Detrended Fluctuation Analysis).
Позволяет измерить, как степень «турбулентности» зависит от масштаба —
и адаптировать ширину стопа к текущему режиму рынка.
"""

import numpy as np
from typing import Optional


# ---------------------------------------------------------------------------
# Утилиты
# ---------------------------------------------------------------------------

def log_returns(prices: np.ndarray) -> np.ndarray:
    """
    Логарифмические доходности.

    Parameters
    ----------
    prices : np.ndarray, shape (T,)

    Returns
    -------
    np.ndarray, shape (T-1,)
    """
    return np.diff(np.log(prices + 1e-12))


def profile(series: np.ndarray) -> np.ndarray:
    """
    Профиль (кумулятивная сумма центрированного ряда).
    Основной объект анализа в DFA/MFDFA.

    Parameters
    ----------
    series : np.ndarray, shape (N,)

    Returns
    -------
    np.ndarray, shape (N,)
    """
    return np.cumsum(series - series.mean())


# ---------------------------------------------------------------------------
# Ядро MFDFA
# ---------------------------------------------------------------------------

def _detrend_segment(y: np.ndarray, order: int) -> np.ndarray:
    """
    Вычитает полиномиальный тренд из сегмента y.

    Parameters
    ----------
    y     : np.ndarray, shape (s,)
    order : int — степень полинома (1 = линейный, 2 = квадратичный)

    Returns
    -------
    np.ndarray, shape (s,) — остаток после вычитания тренда
    """
    x = np.arange(len(y))
    coeffs = np.polyfit(x, y, order)
    trend = np.polyval(coeffs, x)
    return y - trend


def fluctuation_function(
    profile: np.ndarray,
    scales: np.ndarray,
    q_values: np.ndarray,
    order: int = 1,
) -> np.ndarray:
    """
    Функция флуктуаций F_q(s) для каждого масштаба s и момента q.

    Parameters
    ----------
    profile  : np.ndarray, shape (N,) — профиль ряда
    scales   : np.ndarray, int — масштабы (длины сегментов)
    q_values : np.ndarray — моменты (q=2 соответствует обычному DFA)
    order    : int — степень полиномиального детрендирования

    Returns
    -------
    np.ndarray, shape (len(scales), len(q_values))
        F_q(s) для каждой комбинации масштаб × момент
    """
    N = len(profile)
    Fq = np.zeros((len(scales), len(q_values)))

    for si, s in enumerate(scales):
        s = int(s)
        n_segs = N // s
        if n_segs < 2:
            Fq[si, :] = np.nan
            continue

        # Флуктуации по прямому и обратному прогонам
        f2 = []
        for direction in [profile, profile[::-1]]:
            for v in range(n_segs):
                seg = direction[v * s : (v + 1) * s]
                resid = _detrend_segment(seg, order)
                f2.append(np.mean(resid ** 2))

        f2 = np.array(f2)

        for qi, q in enumerate(q_values):
            if abs(q) < 1e-6:
                Fq[si, qi] = np.exp(0.5 * np.mean(np.log(f2 + 1e-30)))
            else:
                Fq[si, qi] = (np.mean(f2 ** (q / 2))) ** (1.0 / q)

    return Fq


def hurst_exponents(
    Fq: np.ndarray,
    scales: np.ndarray,
    q_values: np.ndarray,
) -> np.ndarray:
    """
    Обобщённые показатели Хёрста H(q) — наклон log F_q(s) ~ H(q) * log s.

    H(q=2) — классический показатель Хёрста:
        H < 0.5 — антиперсистентность (возврат к среднему)
        H = 0.5 — случайное блуждание
        H > 0.5 — персистентность (трендовость)

    Parameters
    ----------
    Fq      : np.ndarray, shape (n_scales, n_q)
    scales  : np.ndarray, shape (n_scales,)
    q_values: np.ndarray, shape (n_q,)

    Returns
    -------
    np.ndarray, shape (n_q,) — H(q) для каждого момента
    """
    log_s = np.log(scales)
    H = np.zeros(len(q_values))

    for qi in range(len(q_values)):
        log_Fq = np.log(Fq[:, qi] + 1e-30)
        valid = np.isfinite(log_Fq)
        if valid.sum() < 2:
            H[qi] = np.nan
            continue
        slope, _ = np.polyfit(log_s[valid], log_Fq[valid], 1)
        H[qi] = slope

    return H


# ---------------------------------------------------------------------------
# Мультифрактальный спектр
# ---------------------------------------------------------------------------

def mass_exponent(H: np.ndarray, q_values: np.ndarray) -> np.ndarray:
    """
    Показатель массы τ(q) = q * H(q) - 1.

    Parameters
    ----------
    H        : np.ndarray, shape (n_q,)
    q_values : np.ndarray, shape (n_q,)

    Returns
    -------
    np.ndarray, shape (n_q,)
    """
    return q_values * H - 1.0


def multifractal_spectrum(
    tau: np.ndarray,
    q_values: np.ndarray,
) -> tuple[np.ndarray, np.ndarray]:
    """
    Спектр сингулярности (f, α) через преобразование Лежандра.

        α(q) = dτ/dq  — показатель Гёльдера (локальная регулярность)
        f(α) = q*α - τ(q) — фрактальная размерность множества с показателем α

    Parameters
    ----------
    tau      : np.ndarray, shape (n_q,)
    q_values : np.ndarray, shape (n_q,)

    Returns
    -------
    alpha : np.ndarray, shape (n_q - 1,)
    f_alpha : np.ndarray, shape (n_q - 1,)
    """
    alpha = np.gradient(tau, q_values)
    f_alpha = q_values * alpha - tau
    return alpha, f_alpha


def spectrum_width(alpha: np.ndarray, f_alpha: np.ndarray) -> dict:
    """
    Ключевые характеристики спектра сингулярности.

    Parameters
    ----------
    alpha   : np.ndarray — показатели Гёльдера
    f_alpha : np.ndarray — фрактальные размерности

    Returns
    -------
    dict:
        'width'       — ширина спектра Δα = α_max - α_min (мультифрактальность)
        'alpha_min'   — левый конец (поведение в экстремальных движениях)
        'alpha_max'   — правый конец (поведение в спокойных периодах)
        'alpha_0'     — вершина спектра ≈ H(q=2)
        'asymmetry'   — (α_0 - α_min) / (α_max - α_0): >1 → риск левого хвоста
        'f_at_alpha0' — f(α_0): должна быть близка к 1 для корректного спектра
    """
    valid = np.isfinite(alpha) & np.isfinite(f_alpha)
    a = alpha[valid]
    f = f_alpha[valid]

    if len(a) < 3:
        return {k: np.nan for k in
                ["width", "alpha_min", "alpha_max", "alpha_0", "asymmetry", "f_at_alpha0"]}

    alpha_min = float(a.min())
    alpha_max = float(a.max())
    width = alpha_max - alpha_min
    peak_idx = int(np.argmax(f))
    alpha_0 = float(a[peak_idx])
    f_at_alpha0 = float(f[peak_idx])

    left = alpha_0 - alpha_min
    right = alpha_max - alpha_0
    asymmetry = left / (right + 1e-12)

    return {
        "width": width,
        "alpha_min": alpha_min,
        "alpha_max": alpha_max,
        "alpha_0": alpha_0,
        "asymmetry": asymmetry,
        "f_at_alpha0": f_at_alpha0,
    }


# ---------------------------------------------------------------------------
# Стопы, калиброванные под мультифрактальный режим
# ---------------------------------------------------------------------------

def turbulence_regime(
    width: float,
    alpha_min: float,
    asymmetry: float,
) -> str:
    """
    Классификация рыночного режима по параметрам спектра.

    Parameters
    ----------
    width     : float — ширина спектра (мультифрактальность)
    alpha_min : float — экспонента экстремальных движений
    asymmetry : float — асимметрия спектра

    Returns
    -------
    str: 'calm' | 'trending' | 'turbulent' | 'crisis'
    """
    if width < 0.2:
        return "calm"
    if alpha_min > 0.5 and asymmetry < 1.0:
        return "trending"
    if width < 0.5 and asymmetry < 1.5:
        return "turbulent"
    return "crisis"


def stop_multiplier(regime: str) -> float:
    """
    Множитель ширины стопа в зависимости от режима.

    Базовый стоп умножается на этот коэффициент.
    Чем выше турбулентность — тем шире стоп, чтобы не выбивало шумом.

    Parameters
    ----------
    regime : str — из turbulence_regime()

    Returns
    -------
    float
    """
    return {
        "calm": 1.0,
        "trending": 1.4,
        "turbulent": 2.0,
        "crisis": 3.5,
    }.get(regime, 1.0)


def scale_dependent_stops(
    prices: np.ndarray,
    base_stop_pct: float,
    scales: np.ndarray,
    q_values: Optional[np.ndarray] = None,
    order: int = 1,
) -> dict:
    """
    Рассчитывает адаптивные стопы для каждого масштаба наблюдения.

    Идея: на коротком масштабе (дни) турбулентность одна,
    на длинном (недели) — другая. Стопы должны соответствовать масштабу
    удержания позиции.

    Parameters
    ----------
    prices        : np.ndarray, shape (T,) — цены
    base_stop_pct : float — базовый стоп в % (например 1.0 = 1%)
    scales        : np.ndarray, int — масштабы в барах
    q_values      : np.ndarray или None — моменты; по умолчанию [-4..4]
    order         : int — порядок детрендирования

    Returns
    -------
    dict:
        'scales'          — масштабы
        'local_hurst'     — H(q=2) в окне каждого масштаба (грубая оценка)
        'stop_pct'        — рекомендованная ширина стопа для каждого масштаба
        'regime'          — режим рынка (глобальный)
        'spectrum'        — dict из spectrum_width
        'multiplier'      — итоговый стоп-множитель
    """
    if q_values is None:
        q_values = np.linspace(-4, 4, 41)
        q_values = q_values[np.abs(q_values) > 0.1]

    returns = log_returns(prices)
    prof = profile(returns)

    Fq = fluctuation_function(prof, scales, q_values, order=order)
    H = hurst_exponents(Fq, scales, q_values)
    tau = mass_exponent(H, q_values)
    alpha, f_alpha = multifractal_spectrum(tau, q_values)
    sw = spectrum_width(alpha, f_alpha)

    regime = turbulence_regime(
        sw["width"], sw["alpha_min"], sw["asymmetry"]
    )
    mult = stop_multiplier(regime)

    # Локальный H(q=2) для каждого масштаба через DFA одного момента
    q2_idx = int(np.argmin(np.abs(q_values - 2.0)))
    local_hurst = np.zeros(len(scales))
    for si, s in enumerate(scales):
        if np.isfinite(Fq[si, q2_idx]) and Fq[si, q2_idx] > 0:
            # Наклон относительно глобальной регрессии уже в H[q2_idx],
            # здесь сохраняем масштабно-зависимое значение F_q(s) нормированным
            local_hurst[si] = H[q2_idx]
        else:
            local_hurst[si] = np.nan

    # Стоп для каждого масштаба: шире там, где H выше (трендовость → больший ход)
    h2 = H[q2_idx] if np.isfinite(H[q2_idx]) else 0.5
    scale_factor = (scales / scales.min()) ** (h2 - 0.5)
    scale_factor = np.clip(scale_factor, 0.5, 5.0)
    stop_pct = base_stop_pct * mult * scale_factor

    return {
        "scales": scales,
        "local_hurst": local_hurst,
        "stop_pct": stop_pct,
        "regime": regime,
        "spectrum": sw,
        "multiplier": mult,
        "H": H,
        "q_values": q_values,
        "alpha": alpha,
        "f_alpha": f_alpha,
        "Fq": Fq,
    }


# ---------------------------------------------------------------------------
# Rolling-мониторинг режима
# ---------------------------------------------------------------------------

def rolling_multifractal(
    prices: np.ndarray,
    window: int,
    step: int = 1,
    scales: Optional[np.ndarray] = None,
    q_values: Optional[np.ndarray] = None,
    order: int = 1,
) -> dict:
    """
    Скользящий расчёт мультифрактальных характеристик.

    Parameters
    ----------
    prices   : np.ndarray, shape (T,)
    window   : int — ширина окна в барах
    step     : int
    scales   : np.ndarray или None; по умолчанию логарифмическая сетка
    q_values : np.ndarray или None

    Returns
    -------
    dict:
        'width'      — ширина спектра в каждом окне
        'alpha_min'  — левый хвост спектра (экстремальные движения)
        'asymmetry'  — асимметрия спектра
        'hurst'      — H(q=2) в каждом окне
        'regime'     — строковый режим в каждом окне
        'multiplier' — рекомендованный стоп-множитель в каждом окне
    """
    T = len(prices)

    if scales is None:
        s_min = max(8, window // 20)
        s_max = window // 4
        scales = np.unique(np.round(
            np.geomspace(s_min, s_max, 12)
        ).astype(int))

    if q_values is None:
        q_values = np.linspace(-4, 4, 21)
        q_values = q_values[np.abs(q_values) > 0.1]

    q2_idx = int(np.argmin(np.abs(q_values - 2.0)))

    widths, alpha_mins, asymmetries, hursts, regimes, multipliers = [], [], [], [], [], []

    for start in range(0, T - window + 1, step):
        chunk = prices[start : start + window]
        returns = log_returns(chunk)
        prof = profile(returns)

        Fq = fluctuation_function(prof, scales, q_values, order=order)
        H = hurst_exponents(Fq, scales, q_values)
        tau = mass_exponent(H, q_values)
        alpha, f_alpha = multifractal_spectrum(tau, q_values)
        sw = spectrum_width(alpha, f_alpha)

        regime = turbulence_regime(sw["width"], sw["alpha_min"], sw["asymmetry"])
        mult = stop_multiplier(regime)

        h2 = float(H[q2_idx]) if np.isfinite(H[q2_idx]) else np.nan

        widths.append(sw["width"])
        alpha_mins.append(sw["alpha_min"])
        asymmetries.append(sw["asymmetry"])
        hursts.append(h2)
        regimes.append(regime)
        multipliers.append(mult)

    return {
        "width": np.array(widths),
        "alpha_min": np.array(alpha_mins),
        "asymmetry": np.array(asymmetries),
        "hurst": np.array(hursts),
        "regime": regimes,
        "multiplier": np.array(multipliers),
    }


# ---------------------------------------------------------------------------
# Высокоуровневый пайплайн
# ---------------------------------------------------------------------------

def analyze(
    prices: np.ndarray,
    base_stop_pct: float = 1.0,
    scales: Optional[np.ndarray] = None,
    q_values: Optional[np.ndarray] = None,
    order: int = 1,
) -> dict:
    """
    Полный мультифрактальный анализ с калибровкой стопов.

    Parameters
    ----------
    prices        : np.ndarray, shape (T,) — цены одного актива
    base_stop_pct : float — базовый стоп в % от цены
    scales        : np.ndarray или None — масштабы; по умолчанию геометрическая сетка
    q_values      : np.ndarray или None — моменты q
    order         : int — порядок полиномиального детрендирования

    Returns
    -------
    dict:
        'regime'          — текущий режим: 'calm'|'trending'|'turbulent'|'crisis'
        'multiplier'      — множитель стопа для текущего режима
        'spectrum'        — параметры спектра (width, alpha_min, alpha_max, ...)
        'hurst_q2'        — классический показатель Хёрста H(q=2)
        'H'               — H(q) для всех моментов
        'q_values'        — использованные моменты
        'alpha'           — показатели Гёльдера
        'f_alpha'         — фрактальные размерности
        'scale_stops'     — dict из scale_dependent_stops
        'scales'          — масштабы
        'Fq'              — функция флуктуаций (n_scales × n_q)
    """
    T = len(prices)

    if scales is None:
        s_min = max(8, T // 50)
        s_max = T // 5
        scales = np.unique(np.round(
            np.geomspace(s_min, s_max, 16)
        ).astype(int))

    if q_values is None:
        q_values = np.linspace(-4, 4, 41)
        q_values = q_values[np.abs(q_values) > 0.1]

    scale_stops = scale_dependent_stops(
        prices, base_stop_pct, scales, q_values, order
    )

    q2_idx = int(np.argmin(np.abs(q_values - 2.0)))
    hurst_q2 = float(scale_stops["H"][q2_idx])

    return {
        "regime": scale_stops["regime"],
        "multiplier": scale_stops["multiplier"],
        "spectrum": scale_stops["spectrum"],
        "hurst_q2": hurst_q2,
        "H": scale_stops["H"],
        "q_values": q_values,
        "alpha": scale_stops["alpha"],
        "f_alpha": scale_stops["f_alpha"],
        "scale_stops": scale_stops,
        "scales": scales,
        "Fq": scale_stops["Fq"],
    }


# ---------------------------------------------------------------------------
# Пример использования
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    rng = np.random.default_rng(42)
    T = 1000

    # Синтетический ряд с мультифрактальными свойствами
    returns = rng.standard_t(df=3, size=T) * 0.01
    prices = 100 * np.cumprod(1 + returns)

    result = analyze(prices, base_stop_pct=1.0)

    print("=== Мультифрактальный анализ ===")
    print(f"Режим рынка      : {result['regime']}")
    print(f"Стоп-множитель   : {result['multiplier']:.1f}x")
    print(f"Хёрст H(q=2)     : {result['hurst_q2']:.4f}")
    sw = result["spectrum"]
    print(f"\nСпектр сингулярности:")
    print(f"  Ширина Δα      : {sw['width']:.4f}")
    print(f"  α_min          : {sw['alpha_min']:.4f}")
    print(f"  α_max          : {sw['alpha_max']:.4f}")
    print(f"  Асимметрия     : {sw['asymmetry']:.4f}")

    print(f"\nСтопы по масштабам (базовый 1.0%):")
    ss = result["scale_stops"]
    for s, stop in zip(ss["scales"], ss["stop_pct"]):
        print(f"  масштаб {s:>4} баров → стоп {stop:.3f}%")

    # Rolling-мониторинг
    rolling = rolling_multifractal(prices, window=200, step=50)
    print(f"\nRolling режимы: {rolling['regime']}")
    print(f"Rolling Hurst : {np.round(rolling['hurst'], 3)}")
    print(f"Rolling множитель стопа: {rolling['multiplier']}")
