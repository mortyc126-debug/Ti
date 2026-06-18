"""
indicators_volume.py — Фаза 3 (часть 4, финал): объёмные осцилляторы +
относительная сила (RMI) + статистика (rolling z-score) из indicators-lib.js.

Mansfield RS и Beta-adjusted RS не портированы — требуют отдельного ряда
бенчмарка (индекса), которого у стратегии нет (она работает по одному
тикеру). Расширенная волатильность (Parkinson/Garman-Klass/Yang-Zhang/Ulcer)
не имеет направления (не "куда", а "насколько") — не дают сами по себе
score∈[-1,1] и не портированы как отдельные методы композита.
"""
import math

__all__ = ("klinger_oscillator", "vzo", "twiggs_money_flow", "rmi", "rolling_zscore",
           "score_klinger", "score_vzo", "score_twiggs", "score_rmi", "score_zscore")


def _ema(values: list[float], period: int) -> list[float]:
    if not values:
        return []
    alpha = 2 / (period + 1)
    out = [values[0]]
    for v in values[1:]:
        out.append(alpha * v + (1 - alpha) * out[-1])
    return out


def klinger_oscillator(highs: list[float], lows: list[float], closes: list[float],
                        volumes: list[float], fast: int = 34, slow: int = 55) -> list[float]:
    n = len(closes)
    if n < 3:
        return [0.0] * n
    hlc = [(highs[i] + lows[i] + closes[i]) for i in range(n)]
    trend = [1] * n
    for i in range(1, n):
        trend[i] = 1 if hlc[i] > hlc[i - 1] else -1
    dm = [highs[i] - lows[i] for i in range(n)]
    cum_dm = 0.0
    vf = [0.0] * n
    prev_trend = trend[0]
    cum_dm = dm[0] or 1e-9
    for i in range(1, n):
        if trend[i] != prev_trend:
            cum_dm = dm[i] or 1e-9
        else:
            cum_dm += dm[i]
        prev_trend = trend[i]
        ratio = dm[i] / cum_dm if cum_dm else 0.0
        vf[i] = volumes[i] * abs(2 * ratio - 1) * trend[i] * 100
    return [a - b for a, b in zip(_ema(vf, fast), _ema(vf, slow))]


def vzo(closes: list[float], volumes: list[float], period: int = 14) -> list[float]:
    n = len(closes)
    if n < 2:
        return [0.0] * n
    vp = [volumes[0]] + [volumes[i] if closes[i] > closes[i - 1] else -volumes[i] for i in range(1, n)]
    ema_vp, ema_vol = _ema(vp, period), _ema(volumes, period)
    return [100 * ema_vp[i] / ema_vol[i] if ema_vol[i] else 0.0 for i in range(n)]


def _score_vzo(v: float) -> float:
    if v > 5:
        return 1.0
    if v > 0:
        return 0.5
    if v < -5:
        return -1.0
    if v < 0:
        return -0.5
    return 0.0


def twiggs_money_flow(highs: list[float], lows: list[float], closes: list[float],
                       volumes: list[float], period: int = 21) -> list[float]:
    n = len(closes)
    if n < 2:
        return [0.0] * n
    adv = [0.0] * n
    for i in range(1, n):
        trh = max(highs[i], closes[i - 1])
        trl = min(lows[i], closes[i - 1])
        rng = (trh - trl) or 1e-9
        adv[i] = volumes[i] * (2 * closes[i] - trh - trl) / rng
    ema_adv, ema_vol = _ema(adv, period), _ema(volumes, period)
    return [ema_adv[i] / ema_vol[i] if ema_vol[i] else 0.0 for i in range(n)]


def _score_twiggs(v: float) -> float:
    if v > 0.05:
        return 1.0
    if v > 0:
        return 0.5
    if v < -0.05:
        return -1.0
    if v < 0:
        return -0.5
    return 0.0


def rmi(closes: list[float], period: int = 14, momentum: int = 5) -> float:
    """Relative Momentum Index ∈[0,100]: вариант RSI на разности C[i]-C[i-momentum]."""
    n = len(closes)
    if n <= period + momentum:
        return 50.0
    diffs = [closes[i] - closes[i - momentum] for i in range(momentum, n)]
    window = diffs[-period:]
    up = sum(d for d in window if d > 0)
    down = -sum(d for d in window if d < 0)
    total = up + down
    return 100 * up / total if total else 50.0


def _score_rmi(v: float) -> float:
    """RMI как RSI: >70 перекуплен (медвежий контр-сигнал), <30 перепродан (бычий)."""
    if v > 70:
        return -1.0
    if v > 55:
        return 0.5
    if v < 30:
        return 1.0
    if v < 45:
        return -0.5
    return 0.0


def rolling_zscore(closes: list[float], period: int = 20) -> float:
    window = closes[-period:]
    if len(window) < 5:
        return 0.0
    mean = sum(window) / len(window)
    sd = (sum((x - mean) ** 2 for x in window) / len(window)) ** 0.5
    return (closes[-1] - mean) / sd if sd else 0.0


def _score_zscore(v: float) -> float:
    """Порт ilScoreZScoreRoll: сильное отклонение -> контр-сигнал на возврат к среднему."""
    if v < -2:
        return 1.0
    if v < -1:
        return 0.5
    if v > 2:
        return -1.0
    if v > 1:
        return -0.5
    return 0.0


def score_klinger(highs: list[float], lows: list[float], closes: list[float], volumes: list[float]) -> float:
    if len(closes) < 10:
        return 0.0
    series = klinger_oscillator(highs, lows, closes, volumes, fast=min(34, len(closes) // 2 or 1), slow=min(55, len(closes) - 1 or 1))
    if len(series) < 2:
        return 0.0
    v, prev = series[-1], series[-2]
    if v > 0 and prev < 0:
        return 1.0
    if v < 0 and prev > 0:
        return -1.0
    if v > 0:
        return 0.5
    if v < 0:
        return -0.5
    return 0.0


def score_vzo(closes: list[float], volumes: list[float]) -> float:
    if len(closes) < 10:
        return 0.0
    return _score_vzo(vzo(closes, volumes, period=min(14, len(closes) - 1))[-1])


def score_twiggs(highs: list[float], lows: list[float], closes: list[float], volumes: list[float]) -> float:
    if len(closes) < 10:
        return 0.0
    return _score_twiggs(twiggs_money_flow(highs, lows, closes, volumes, period=min(21, len(closes) - 1))[-1])


def score_rmi(closes: list[float]) -> float:
    if len(closes) < 15:
        return 0.0
    return _score_rmi(rmi(closes, period=min(14, len(closes) // 2), momentum=min(5, len(closes) // 4 or 1)))


def score_zscore(closes: list[float]) -> float:
    if len(closes) < 10:
        return 0.0
    return _score_zscore(rolling_zscore(closes, period=min(20, len(closes))))
