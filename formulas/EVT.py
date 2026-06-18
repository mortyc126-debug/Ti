"""
EVT (Extreme Value Theory) — анализ риска экстремальных событий.

Реализует два подхода:
  - Block Maxima (GEV) — моделирование максимальных потерь по блокам
  - Peaks Over Threshold (POT / GPD) — моделирование хвоста сверх порога

Основные метрики:
  - VaR (Value at Risk) на экстремальных уровнях (99.9%+)
  - CVaR / ES (Expected Shortfall) по хвосту
  - Вероятность разорения (ruin probability) для заданного дродауна
"""

import numpy as np
from scipy.stats import genextreme, genpareto
from scipy.optimize import minimize_scalar
from dataclasses import dataclass
from typing import Optional


# ---------------------------------------------------------------------------
# Структуры данных
# ---------------------------------------------------------------------------

@dataclass
class EVTResult:
    """Результат EVT-анализа."""
    method: str                  # 'GEV' или 'GPD'
    params: dict                 # подобранные параметры распределения
    var_99: float                # VaR 99%
    var_999: float               # VaR 99.9%
    cvar_99: float               # CVaR (ES) 99%
    cvar_999: float              # CVaR (ES) 99.9%
    tail_index: float            # индекс хвоста (xi / shape)
    heavy_tail: bool             # True если хвост тяжёлый (xi > 0)
    fit_quality: float           # отрицательный log-likelihood (меньше = лучше)

    def summary(self) -> str:
        lines = [
            f"=== EVT ({self.method}) ===",
            f"Параметры:        {self.params}",
            f"Индекс хвоста ξ:  {self.tail_index:.4f}  ({'тяжёлый' if self.heavy_tail else 'лёгкий'})",
            f"VaR  99%:         {self.var_99:.4f}",
            f"VaR  99.9%:       {self.var_999:.4f}",
            f"CVaR 99%:         {self.cvar_99:.4f}",
            f"CVaR 99.9%:       {self.cvar_999:.4f}",
            f"Fit quality (-LL):{self.fit_quality:.2f}",
        ]
        return "\n".join(lines)


# ---------------------------------------------------------------------------
# Вспомогательные функции
# ---------------------------------------------------------------------------

def _losses_from_returns(returns: np.ndarray) -> np.ndarray:
    """Преобразует доходности в убытки (отрицательные доходности → положительные потери)."""
    return -returns[returns < 0]


def _block_maxima(losses: np.ndarray, block_size: int) -> np.ndarray:
    """Разбивает потери на блоки и берёт максимум каждого блока."""
    n_blocks = len(losses) // block_size
    trimmed = losses[: n_blocks * block_size].reshape(n_blocks, block_size)
    return trimmed.max(axis=1)


def _select_threshold_mean_excess(
    losses: np.ndarray,
    min_exceedances: int = 30,
) -> float:
    """
    Выбор порога u методом Mean Excess Plot:
    ищет точку перегиба средней сверхпороговой функции.
    Возвращает значение порога.
    """
    sorted_losses = np.sort(losses)
    candidates = sorted_losses[: int(len(sorted_losses) * 0.9)]  # до 90-го перцентиля

    me_values = []
    thresholds = []
    for u in candidates:
        exceedances = losses[losses > u] - u
        if len(exceedances) < min_exceedances:
            break
        me_values.append(exceedances.mean())
        thresholds.append(u)

    if len(me_values) < 2:
        # Фолбэк: 90-й перцентиль
        return float(np.percentile(losses, 90))

    # Линейная регрессия: ищем область наибольшей линейности (для GPD нужна линейность)
    # Упрощение: берём 90-й перцентиль как разумный порог
    return float(np.percentile(losses, 90))


# ---------------------------------------------------------------------------
# Block Maxima / GEV
# ---------------------------------------------------------------------------

def fit_gev(
    returns: np.ndarray,
    block_size: int = 21,          # ~торговый месяц
    confidence_levels: tuple = (0.99, 0.999),
) -> EVTResult:
    """
    Подгонка GEV (Generalized Extreme Value) по методу Block Maxima.

    Parameters
    ----------
    returns : np.ndarray
        Временной ряд доходностей (логарифмические или процентные).
    block_size : int
        Размер блока в барах. По умолчанию 21 (месяц).
    confidence_levels : tuple
        Уровни доверия для VaR/CVaR.

    Returns
    -------
    EVTResult
    """
    losses = _losses_from_returns(np.asarray(returns, dtype=float))
    if len(losses) < block_size * 2:
        raise ValueError(f"Недостаточно данных: нужно минимум {block_size * 2} убыточных баров.")

    block_max = _block_maxima(losses, block_size)

    # MLE-подгонка GEV
    xi, loc, scale = genextreme.fit(block_max)

    fit_quality = -np.sum(genextreme.logpdf(block_max, xi, loc, scale))

    # VaR и CVaR для каждого уровня
    cl1, cl2 = sorted(confidence_levels)

    def gev_var(p: float) -> float:
        return float(genextreme.ppf(p, xi, loc, scale))

    def gev_cvar(p: float, n_samples: int = 100_000) -> float:
        """Monte Carlo CVaR."""
        samples = genextreme.rvs(xi, loc, scale, size=n_samples)
        threshold = genextreme.ppf(p, xi, loc, scale)
        tail = samples[samples > threshold]
        return float(tail.mean()) if len(tail) > 0 else threshold

    return EVTResult(
        method="GEV (Block Maxima)",
        params={"xi": round(xi, 5), "loc": round(loc, 5), "scale": round(scale, 5)},
        var_99=gev_var(cl1),
        var_999=gev_var(cl2),
        cvar_99=gev_cvar(cl1),
        cvar_999=gev_cvar(cl2),
        tail_index=float(xi),
        heavy_tail=xi > 0,
        fit_quality=fit_quality,
    )


# ---------------------------------------------------------------------------
# Peaks Over Threshold / GPD
# ---------------------------------------------------------------------------

def fit_gpd(
    returns: np.ndarray,
    threshold: Optional[float] = None,
    confidence_levels: tuple = (0.99, 0.999),
) -> EVTResult:
    """
    Подгонка GPD (Generalized Pareto Distribution) методом POT.

    Parameters
    ----------
    returns : np.ndarray
        Временной ряд доходностей.
    threshold : float or None
        Порог u. Если None — определяется автоматически (Mean Excess).
    confidence_levels : tuple
        Уровни доверия для VaR/CVaR.

    Returns
    -------
    EVTResult
    """
    returns = np.asarray(returns, dtype=float)
    losses = _losses_from_returns(returns)

    if len(losses) < 20:
        raise ValueError("Недостаточно убыточных наблюдений для GPD-подгонки.")

    u = threshold if threshold is not None else _select_threshold_mean_excess(losses)

    exceedances = losses[losses > u] - u
    if len(exceedances) < 10:
        raise ValueError(f"Слишком мало превышений порога u={u:.4f}: {len(exceedances)} шт.")

    n_total = len(losses)
    n_exceed = len(exceedances)
    prob_exceed = n_exceed / n_total      # P(loss > u)

    # MLE-подгонка GPD
    xi, _, beta = genpareto.fit(exceedances, floc=0)

    fit_quality = -np.sum(genpareto.logpdf(exceedances, xi, 0, beta))

    cl1, cl2 = sorted(confidence_levels)

    def gpd_var(p: float) -> float:
        """
        VaR через формулу POT:
        VaR_p = u + (beta / xi) * [((1 - p) / prob_exceed)^(-xi) - 1]
        (для xi != 0)
        """
        if abs(xi) < 1e-8:
            # xi ≈ 0: экспоненциальный хвост
            return float(u + beta * np.log(prob_exceed / (1 - p)))
        return float(u + (beta / xi) * (((1 - p) / prob_exceed) ** (-xi) - 1))

    def gpd_cvar(p: float) -> float:
        """
        CVaR через аналитическую формулу для GPD:
        CVaR_p = VaR_p / (1 - xi) + (beta - xi * u) / (1 - xi)
        (для xi < 1)
        """
        var_p = gpd_var(p)
        if xi >= 1:
            return float("inf")
        return float((var_p + beta - xi * u) / (1 - xi))

    return EVTResult(
        method="GPD (Peaks Over Threshold)",
        params={
            "xi": round(xi, 5),
            "beta": round(beta, 5),
            "threshold_u": round(u, 5),
            "n_exceedances": n_exceed,
            "prob_exceed": round(prob_exceed, 5),
        },
        var_99=gpd_var(cl1),
        var_999=gpd_var(cl2),
        cvar_99=gpd_cvar(cl1),
        cvar_999=gpd_cvar(cl2),
        tail_index=float(xi),
        heavy_tail=xi > 0,
        fit_quality=fit_quality,
    )


# ---------------------------------------------------------------------------
# Вероятность разорения (ruin probability)
# ---------------------------------------------------------------------------

def ruin_probability(
    returns: np.ndarray,
    ruin_threshold: float,
    method: str = "gpd",
    threshold: Optional[float] = None,
) -> float:
    """
    Оценивает вероятность того, что потеря превысит ruin_threshold
    (например, максимально допустимый дродаун).

    Parameters
    ----------
    returns : np.ndarray
        Временной ряд доходностей.
    ruin_threshold : float
        Уровень потери, выше которого считаем "разорением" (положительное число).
    method : str
        'gpd' (рекомендуется) или 'gev'.
    threshold : float or None
        Порог для GPD (если None — авто).

    Returns
    -------
    float
        Вероятность P(loss > ruin_threshold).
    """
    returns = np.asarray(returns, dtype=float)
    losses = _losses_from_returns(returns)

    if method == "gpd":
        u = threshold if threshold is not None else _select_threshold_mean_excess(losses)
        exceedances = losses[losses > u] - u
        n_total = len(losses)
        n_exceed = len(exceedances)
        if n_exceed < 5:
            raise ValueError("Слишком мало превышений для оценки.")
        prob_exceed = n_exceed / n_total
        xi, _, beta = genpareto.fit(exceedances, floc=0)

        if ruin_threshold <= u:
            return float(np.mean(losses > ruin_threshold))

        # P(X > x) = prob_exceed * (1 + xi*(x-u)/beta)^(-1/xi)
        if abs(xi) < 1e-8:
            return float(prob_exceed * np.exp(-(ruin_threshold - u) / beta))
        base = 1 + xi * (ruin_threshold - u) / beta
        if base <= 0:
            return 0.0
        return float(prob_exceed * base ** (-1 / xi))

    elif method == "gev":
        result = fit_gev(returns)
        xi = result.params["xi"]
        loc = result.params["loc"]
        scale = result.params["scale"]
        return float(1 - genextreme.cdf(ruin_threshold, xi, loc, scale))

    else:
        raise ValueError(f"Неизвестный метод: {method}. Используйте 'gpd' или 'gev'.")


# ---------------------------------------------------------------------------
# Комбинированный анализ
# ---------------------------------------------------------------------------

def evt_full_analysis(
    returns: np.ndarray,
    block_size: int = 21,
    threshold: Optional[float] = None,
    ruin_levels: Optional[list] = None,
    confidence_levels: tuple = (0.99, 0.999),
) -> dict:
    """
    Полный EVT-анализ: GEV + GPD + вероятности разорения.

    Parameters
    ----------
    returns : np.ndarray
        Временной ряд доходностей.
    block_size : int
        Размер блока для GEV.
    threshold : float or None
        Порог для GPD.
    ruin_levels : list or None
        Список уровней дродауна для оценки вероятности разорения.
        Например: [0.05, 0.10, 0.20] — 5%, 10%, 20%.
    confidence_levels : tuple
        Уровни доверия для VaR/CVaR.

    Returns
    -------
    dict с ключами 'gev', 'gpd', 'ruin_probabilities'
    """
    returns = np.asarray(returns, dtype=float)

    results = {}

    try:
        results["gev"] = fit_gev(returns, block_size=block_size, confidence_levels=confidence_levels)
    except Exception as e:
        results["gev"] = {"error": str(e)}

    try:
        results["gpd"] = fit_gpd(returns, threshold=threshold, confidence_levels=confidence_levels)
    except Exception as e:
        results["gpd"] = {"error": str(e)}

    if ruin_levels is not None:
        ruin_probs = {}
        for level in ruin_levels:
            try:
                p = ruin_probability(returns, ruin_threshold=level, method="gpd", threshold=threshold)
                ruin_probs[f"{level:.2%}"] = round(p, 6)
            except Exception as e:
                ruin_probs[f"{level:.2%}"] = f"error: {e}"
        results["ruin_probabilities"] = ruin_probs

    return results


# ---------------------------------------------------------------------------
# Пример использования
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    rng = np.random.default_rng(42)

    # Синтетические доходности с тяжёлым хвостом (смесь нормального + редкие шоки)
    normal_returns = rng.normal(0.0005, 0.01, 2000)
    shock_idx = rng.choice(2000, size=30, replace=False)
    normal_returns[shock_idx] -= rng.exponential(0.05, size=30)  # экстремальные убытки
    returns = normal_returns

    print("--- GPD ---")
    gpd = fit_gpd(returns)
    print(gpd.summary())

    print("\n--- GEV ---")
    gev = fit_gev(returns)
    print(gev.summary())

    print("\n--- Вероятности разорения ---")
    for level in [0.05, 0.10, 0.15, 0.20]:
        p = ruin_probability(returns, ruin_threshold=level)
        print(f"  P(loss > {level:.0%}) = {p:.6f}  ({p*100:.4f}%)")

    print("\n--- Полный анализ ---")
    full = evt_full_analysis(
        returns,
        ruin_levels=[0.05, 0.10, 0.20],
        confidence_levels=(0.99, 0.999),
    )
    print("Ruin probabilities:", full.get("ruin_probabilities"))
