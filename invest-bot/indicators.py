"""
indicators.py — Фаза 3 (часть 1): адаптивные скользящие средние + режимные
индикаторы из indicators-lib.js. Чистые функции от ценового ряда (closes),
без сетевых запросов — порт продолжается батчами (следующие: фракталы/
энтропия, Ehlers DSP, волатильность, объём, относительная сила, статистика).

В indicators-lib.js эти функции возвращают либо уровень цены (адаптивные MA),
либо необинированный осциллятор (MMI/TII/ER/VHF/TPI) — никакой score-обёртки
там нет (см. инвентаризацию). Здесь каждую группу сводим к одному score∈[-1,1]
для композитной стратегии: ADAPTIVE_MA (отклонение цены от KAMA, по аналогии с
VWAP_SIGNAL) и TREND_QUALITY (TQI уже ∈[-1,1] — sign(наклон)×ER×сила).
"""
import math
import statistics

__all__ = ("kama", "frama", "vidya", "zlema", "t3", "mmi", "tii", "efficiency_ratio",
           "vhf", "tpi", "tqi", "score_adaptive_ma", "score_trend_quality")


def _ema(values: list[float], period: int) -> list[float]:
    if not values:
        return []
    alpha = 2 / (period + 1)
    out = [values[0]]
    for v in values[1:]:
        out.append(alpha * v + (1 - alpha) * out[-1])
    return out


def kama(closes: list[float], period: int = 10, fast: int = 2, slow: int = 30) -> list[float]:
    n = len(closes)
    if n <= period:
        return list(closes)
    out = [None] * period + [closes[period]]
    fast_sc, slow_sc = 2 / (fast + 1), 2 / (slow + 1)
    for i in range(period + 1, n):
        change = abs(closes[i] - closes[i - period])
        volatility = sum(abs(closes[j] - closes[j - 1]) for j in range(i - period + 1, i + 1)) or 1e-9
        er = change / volatility
        sc = (er * (fast_sc - slow_sc) + slow_sc) ** 2
        out.append(out[-1] + sc * (closes[i] - out[-1]))
    return out


def frama(closes: list[float], highs: list[float], lows: list[float], period: int = 16) -> list[float]:
    n = len(closes)
    if n <= period:
        return list(closes)
    half = period // 2
    out = [None] * (period - 1) + [closes[period - 1]]
    for i in range(period, n):
        h1, l1 = max(highs[i - period + 1:i - half + 1]), min(lows[i - period + 1:i - half + 1])
        h2, l2 = max(highs[i - half + 1:i + 1]), min(lows[i - half + 1:i + 1])
        h3, l3 = max(highs[i - period + 1:i + 1]), min(lows[i - period + 1:i + 1])
        n1, n2, n3 = (h1 - l1) / half, (h2 - l2) / half, (h3 - l3) / period
        d = math.log2((n1 + n2) / n3) if n1 > 0 and n2 > 0 and n3 > 0 else 1.0
        alpha = max(0.01, min(1.0, math.exp(-4.6 * (d - 1))))
        out.append(alpha * closes[i] + (1 - alpha) * out[-1])
    return out


def vidya(closes: list[float], period: int = 9, cmo_period: int = 9) -> list[float]:
    n = len(closes)
    if n <= cmo_period:
        return list(closes)
    out = [None] * cmo_period + [closes[cmo_period]]
    alpha_base = 2 / (period + 1)
    for i in range(cmo_period + 1, n):
        window = closes[i - cmo_period + 1:i + 1]
        diffs = [window[j] - window[j - 1] for j in range(1, len(window))]
        up = sum(d for d in diffs if d > 0)
        down = -sum(d for d in diffs if d < 0)
        cmo = abs(up - down) / (up + down) if (up + down) else 0.0
        alpha = alpha_base * cmo
        out.append(alpha * closes[i] + (1 - alpha) * out[-1])
    return out


def zlema(closes: list[float], period: int = 14) -> list[float]:
    n = len(closes)
    lag = max(0, (period - 1) // 2)
    adjusted = [closes[i] + (closes[i] - closes[i - lag]) if i >= lag else closes[i] for i in range(n)]
    return _ema(adjusted, period)


def t3(closes: list[float], period: int = 5, v_factor: float = 0.7) -> list[float]:
    e1 = _ema(closes, period)
    e2 = _ema(e1, period)
    e3 = _ema(e2, period)
    e4 = _ema(e3, period)
    e5 = _ema(e4, period)
    e6 = _ema(e5, period)
    c1 = -(v_factor ** 3)
    c2 = 3 * v_factor ** 2 + 3 * v_factor ** 3
    c3 = -6 * v_factor ** 2 - 3 * v_factor - 3 * v_factor ** 3
    c4 = 1 + 3 * v_factor + v_factor ** 3 + 3 * v_factor ** 2
    return [c1 * e6[i] + c2 * e5[i] + c3 * e4[i] + c4 * e3[i] for i in range(len(closes))]


def mmi(closes: list[float], period: int = 200) -> float:
    """[0,100]: выше — режим mean-reversion, ниже — трендовый."""
    window = closes[-period:]
    if len(window) < 3:
        return 50.0
    mean = sum(window) / len(window)
    crosses = sum(1 for j in range(1, len(window)) if (window[j] > mean) != (window[j - 1] > mean))
    return 100.0 * (1 - crosses / len(window))


def tii(closes: list[float], period: int = 30) -> float:
    """[0,100]: доля баров выше своей SMA."""
    window = closes[-period:]
    if len(window) < 3:
        return 50.0
    sma = sum(window) / len(window)
    pos = sum(max(0.0, c - sma) for c in window)
    neg = sum(max(0.0, sma - c) for c in window)
    total = pos + neg or 1e-9
    return 100.0 * pos / total


def efficiency_ratio(closes: list[float], period: int = 10) -> float:
    """[0,1]: 1 — чисто направленное движение, 0 — шум."""
    window = closes[-(period + 1):]
    if len(window) < 3:
        return 0.0
    change = abs(window[-1] - window[0])
    volatility = sum(abs(window[j] - window[j - 1]) for j in range(1, len(window))) or 1e-9
    return change / volatility


def vhf(closes: list[float], period: int = 28) -> float:
    window = closes[-period:]
    if len(window) < 3:
        return 0.0
    hi, lo = max(window), min(window)
    total = sum(abs(window[j] - window[j - 1]) for j in range(1, len(window))) or 1e-9
    return (hi - lo) / total


def tpi(closes: list[float], period: int = 20) -> float:
    """[0,1]: доля последовательных баров с одинаковым направлением."""
    window = closes[-(period + 2):]
    if len(window) < 4:
        return 0.5
    dirs = [1 if window[j] > window[j - 1] else (-1 if window[j] < window[j - 1] else 0) for j in range(1, len(window))]
    same = total = 0
    for j in range(1, len(dirs)):
        if dirs[j] != 0 and dirs[j - 1] != 0:
            total += 1
            if dirs[j] == dirs[j - 1]:
                same += 1
    return same / total if total else 0.5


def tqi(closes: list[float], period: int = 20) -> float:
    """[-1,1]: знак тренда × сила (ER) × нормированный наклон. Уже готовый score."""
    window = closes[-period:]
    if len(window) < 5:
        return 0.0
    er = efficiency_ratio(closes, period)
    n = len(window)
    xs = list(range(n))
    mx, my = (n - 1) / 2, sum(window) / n
    num = sum((xs[i] - mx) * (window[i] - my) for i in range(n))
    den = sum((xs[i] - mx) ** 2 for i in range(n)) or 1e-9
    slope = num / den
    mean = my or 1e-9
    strength = min(1.0, abs(slope) / abs(mean) * n)
    return max(-1.0, min(1.0, er * (1.0 if slope > 0 else (-1.0 if slope < 0 else 0.0)) * strength))


def score_adaptive_ma(closes: list[float]) -> float:
    """Отклонение цены от KAMA, нормированное на собственную волатильность (как VWAP_SIGNAL)."""
    if len(closes) < 12:
        return 0.0
    series = kama(closes, period=10)
    last_kama = series[-1]
    if last_kama is None or last_kama <= 0:
        return 0.0
    sd = statistics.pstdev(closes) or (last_kama * 0.005)
    z = (closes[-1] - last_kama) / (sd or 1e-9)
    return max(-1.0, min(1.0, math.tanh(z * 0.5)))


def score_trend_quality(closes: list[float]) -> float:
    """TQI напрямую — уже ∈[-1,1]."""
    if len(closes) < 10:
        return 0.0
    return tqi(closes, period=min(20, len(closes)))
