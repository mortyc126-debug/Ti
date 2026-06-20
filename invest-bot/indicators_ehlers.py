"""
indicators_ehlers.py — Фаза 3 (часть 3): Ehlers DSP-индикаторы из
indicators-lib.js. Чистые функции от ценового ряда.

Каждая функция возвращает полный временной ряд (как в js-версии, нужна
рекурсия по предыдущим значениям), score-функции берут последнее значение
и применяют тот же ilScore*-маппинг, что в indlab_v10.html.
"""
import math

__all__ = ("cyber_cycle", "roofing_filter", "decycler_oscillator", "rsi", "fisher_rsi",
           "even_better_sinewave", "score_cyber_cycle", "score_decycler",
           "score_fisher_rsi", "score_ebsw")


def cyber_cycle(closes: list[float], alpha: float = 0.07) -> list[float]:
    n = len(closes)
    if n < 4:
        return [0.0] * n
    smooth = [0.0] * n
    cycle = [0.0] * n
    for i in range(3, n):
        smooth[i] = (closes[i] + 2 * closes[i - 1] + 2 * closes[i - 2] + closes[i - 3]) / 6
    for i in range(3, n):
        if i < 5:
            cycle[i] = (closes[i] - 2 * closes[i - 1] + closes[i - 2]) / 4 if i >= 2 else 0.0
            continue
        cycle[i] = ((1 - 0.5 * alpha) ** 2) * (smooth[i] - 2 * smooth[i - 1] + smooth[i - 2]) \
            + 2 * (1 - alpha) * cycle[i - 1] - ((1 - alpha) ** 2) * cycle[i - 2]
    return cycle


def _score_cross(series: list[float]) -> float:
    """Порт ilScoreCyberCycleInd: пересечение нуля -> +-1, иначе знак -> +-0.5."""
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


def roofing_filter(closes: list[float], hp_period: int = 48, lp_period: int = 10) -> list[float]:
    n = len(closes)
    if n < 3:
        return [0.0] * n
    alpha1 = (math.cos(2 * math.pi / hp_period) + math.sin(2 * math.pi / hp_period) - 1) / math.cos(2 * math.pi / hp_period)
    hp = [0.0] * n
    for i in range(2, n):
        hp[i] = ((1 - alpha1 / 2) ** 2) * (closes[i] - 2 * closes[i - 1] + closes[i - 2]) \
            + 2 * (1 - alpha1) * hp[i - 1] - ((1 - alpha1) ** 2) * hp[i - 2]
    a = math.exp(-1.414 * math.pi / lp_period)
    b = 2 * a * math.cos(1.414 * math.pi / lp_period)
    c2, c3 = b, -a * a
    c1 = 1 - c2 - c3
    out = [0.0] * n
    for i in range(2, n):
        out[i] = c1 * (hp[i] + hp[i - 1]) / 2 + c2 * out[i - 1] + c3 * out[i - 2]
    return out


def decycler_oscillator(closes: list[float], hp_period: int = 125) -> list[float]:
    n = len(closes)
    if n < 2:
        return [0.0] * n
    alpha1 = (math.cos(2 * math.pi / hp_period) + math.sin(2 * math.pi / hp_period) - 1) / math.cos(2 * math.pi / hp_period)
    decycler = [closes[0]] + [0.0] * (n - 1)
    for i in range(1, n):
        decycler[i] = (alpha1 / 2) * (closes[i] + closes[i - 1]) + (1 - alpha1) * decycler[i - 1]
    return [closes[i] - decycler[i] for i in range(n)]


def _score_sign_half(v: float) -> float:
    """Порт ilScoreDecyclerInd."""
    return 0.5 if v > 0 else -0.5


def rsi(closes: list[float], period: int = 14) -> list[float]:
    n = len(closes)
    if n <= period:
        return [50.0] * n
    out = [50.0] * (period + 1)
    gains = [max(0.0, closes[i] - closes[i - 1]) for i in range(1, period + 1)]
    losses = [max(0.0, closes[i - 1] - closes[i]) for i in range(1, period + 1)]
    avg_gain, avg_loss = sum(gains) / period, sum(losses) / period
    rs0 = avg_gain / avg_loss if avg_loss > 0 else 100.0
    out[period] = 100 - 100 / (1 + rs0) if avg_loss > 0 else 100.0
    for i in range(period + 1, n):
        change = closes[i] - closes[i - 1]
        gain, loss = max(0.0, change), max(0.0, -change)
        avg_gain = (avg_gain * (period - 1) + gain) / period
        avg_loss = (avg_loss * (period - 1) + loss) / period
        rs = avg_gain / avg_loss if avg_loss > 0 else 100.0
        out.append(100 - 100 / (1 + rs) if avg_loss > 0 else 100.0)
    return out


def fisher_rsi(closes: list[float], period: int = 10) -> list[float]:
    rsi_vals = rsi(closes, period)
    out = []
    for v in rsi_vals:
        x = max(-0.999, min(0.999, v / 100 * 2 - 1))
        out.append(0.5 * math.log((1 + x) / (1 - x)))
    return out


def _score_fisher(v: float) -> float:
    """Порт ilScoreFisher, нормировано из [-2,2] в [-1,1]."""
    if v > 1.5:
        return 1.0
    if v > 0.5:
        return 0.5
    if v < -1.5:
        return -1.0
    if v < -0.5:
        return -0.5
    return 0.0


def even_better_sinewave(closes: list[float], hp_period: int = 40, period: int = 10) -> list[float]:
    hp = roofing_filter(closes, hp_period, period)
    n = len(hp)
    out = [0.0] * n
    for i in range(period - 1, n):
        window = hp[i - period + 1:i + 1]
        rms = (sum(x * x for x in window) / len(window)) ** 0.5 or 1.0
        out[i] = hp[i] / rms
    return out


def score_cyber_cycle(closes: list[float]) -> float:
    if len(closes) < 10:
        return 0.0
    return _score_cross(cyber_cycle(closes))


def score_decycler(closes: list[float]) -> float:
    if len(closes) < 10:
        return 0.0
    return _score_sign_half(decycler_oscillator(closes, hp_period=min(125, max(10, len(closes))))[-1])


def score_fisher_rsi(closes: list[float]) -> float:
    if len(closes) < 12:
        return 0.0
    return _score_fisher(fisher_rsi(closes, period=min(10, len(closes) - 1))[-1])


def score_ebsw(closes: list[float]) -> float:
    if len(closes) < 15:
        return 0.0
    period = min(10, max(3, len(closes) // 3))
    series = even_better_sinewave(closes, hp_period=min(40, len(closes)), period=period)
    return _score_cross(series)
