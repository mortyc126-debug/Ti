"""
regime.py — классификация режима рынка + детекция точек излома (порт из
oi-signal-v10.html classifyRegime/REGIME_WEIGHT_MODS и
change_point_detection_trading.html: CUSUM/PELT-variant/Z-Score).

Чистые функции от ценового ряда (closes/volumes уже есть в стратегии —
никаких новых сетевых запросов не нужно).

Режим — это не отдельный сигнал, а множитель веса каждого метода: один и
тот же VOL_MOMENTUM надёжнее в тренде, чем в стрессе/боковике (см.
REGIME_WEIGHT_MODS). change_point_score — отдельный лёгкий метод композита:
голосует за направление, только если на коротком окне найден свежий излом
тренда (а не просто "цена куда-то едет").
"""
import os
import sys
import statistics

__all__ = ("classify_regime", "REGIME_WEIGHT_MODS", "change_point_score")

# formulas/ лежит рядом с invest-bot/ (на уровень выше cwd). Добавляем в путь
# один раз, чтобы тяжёлые научные модули (BOCD, Hawkes, RQA, Kalman ...) были
# импортируемы как из regime.py, так и из oi_composite_strategy.py.
_FORMULAS_DIR = os.path.normpath(os.path.join(os.path.dirname(__file__), "..", "formulas"))
if os.path.isdir(_FORMULAS_DIR) and _FORMULAS_DIR not in sys.path:
    sys.path.insert(0, _FORMULAS_DIR)

# BOCD опционален: если numpy/модуль недоступны — деградируем без падения.
try:
    from BOCD import BOCD, NIGParams  # noqa: E402
    _HAS_BOCD = True
except Exception:  # ImportError, отсутствие numpy и т.п.
    _HAS_BOCD = False

REGIMES = ("trending_up", "trending_down", "ranging", "high_vol", "low_vol", "stress")

# regime -> method_name -> множитель веса. Имена — как в oi_composite_strategy.ALL_METHOD_NAMES.
# Не упомянутые в конкретном режиме методы получают множитель 1.0 (см. get(..., 1.0)).
REGIME_WEIGHT_MODS = {
    "trending_up": {
        "BS_PRESSURE": 1.3, "BS_PRESSURE_TS": 1.3, "AGGRESSOR_FLOW": 1.3, "LARGE_IMPACT": 1.2,
        "VWAP_SIGNAL": 1.1, "VWAP_SIGNAL_TS": 1.1, "VOL_MOMENTUM": 1.4, "VOL_MOMENTUM_TS": 1.4,
        "OB_IMBALANCE": 1.0, "CANCEL_SIGNAL": 0.8, "INST_OI": 1.2, "RETAIL_CONTRA": 1.1, "PRICE_TREND": 1.4,
    },
    "trending_down": {
        "BS_PRESSURE": 1.3, "BS_PRESSURE_TS": 1.3, "AGGRESSOR_FLOW": 1.3, "LARGE_IMPACT": 1.2,
        "VWAP_SIGNAL": 1.1, "VWAP_SIGNAL_TS": 1.1, "VOL_MOMENTUM": 1.4, "VOL_MOMENTUM_TS": 1.4,
        "OB_IMBALANCE": 1.0, "CANCEL_SIGNAL": 0.8, "INST_OI": 1.2, "RETAIL_CONTRA": 1.1, "PRICE_TREND": 1.4,
    },
    "ranging": {
        "BS_PRESSURE": 0.9, "BS_PRESSURE_TS": 0.9, "AGGRESSOR_FLOW": 0.9, "LARGE_IMPACT": 0.8,
        "VWAP_SIGNAL": 1.4, "VWAP_SIGNAL_TS": 1.4, "VOL_MOMENTUM": 0.7, "VOL_MOMENTUM_TS": 0.7,
        "OB_IMBALANCE": 1.3, "CANCEL_SIGNAL": 1.2, "INST_OI": 1.0, "RETAIL_CONTRA": 0.9, "PRICE_TREND": 0.5,
    },
    "high_vol": {
        "BS_PRESSURE": 0.8, "BS_PRESSURE_TS": 0.8, "AGGRESSOR_FLOW": 0.8, "LARGE_IMPACT": 1.2,
        "VWAP_SIGNAL": 0.6, "VWAP_SIGNAL_TS": 0.6, "VOL_MOMENTUM": 0.7, "VOL_MOMENTUM_TS": 0.7,
        "OB_IMBALANCE": 0.7, "CANCEL_SIGNAL": 1.3, "INST_OI": 1.1, "RETAIL_CONTRA": 1.4, "PRICE_TREND": 0.5,
    },
    "low_vol": {
        "BS_PRESSURE": 0.7, "BS_PRESSURE_TS": 0.7, "AGGRESSOR_FLOW": 0.7, "LARGE_IMPACT": 1.3,
        "VWAP_SIGNAL": 1.2, "VWAP_SIGNAL_TS": 1.2, "VOL_MOMENTUM": 0.6, "VOL_MOMENTUM_TS": 0.6,
        "OB_IMBALANCE": 1.4, "CANCEL_SIGNAL": 1.1, "INST_OI": 1.0, "RETAIL_CONTRA": 0.8, "PRICE_TREND": 0.7,
    },
    "stress": {
        "BS_PRESSURE": 0.5, "BS_PRESSURE_TS": 0.5, "AGGRESSOR_FLOW": 0.5, "LARGE_IMPACT": 0.9,
        "VWAP_SIGNAL": 0.4, "VWAP_SIGNAL_TS": 0.4, "VOL_MOMENTUM": 0.5, "VOL_MOMENTUM_TS": 0.5,
        "OB_IMBALANCE": 0.5, "CANCEL_SIGNAL": 0.9, "INST_OI": 1.5, "RETAIL_CONTRA": 1.5, "PRICE_TREND": 0.3,
    },
}


def _returns(closes: list[float]) -> list[float]:
    return [(closes[i] - closes[i - 1]) / closes[i - 1] for i in range(1, len(closes)) if closes[i - 1]]


def _trend_strength(closes: list[float]) -> tuple[float, float]:
    """(strength [0,1], direction sign). Линрег наклон, нормированный на диапазон цен."""
    n = len(closes)
    if n < 5:
        return 0.0, 0.0
    xs = list(range(n))
    mx, my = (n - 1) / 2, sum(closes) / n
    num = sum((xs[i] - mx) * (closes[i] - my) for i in range(n))
    den = sum((xs[i] - mx) ** 2 for i in range(n)) or 1e-9
    slope = num / den
    rng = (max(closes) - min(closes)) or (abs(my) or 1.0)
    norm = slope * n / rng
    return min(1.0, abs(norm)), (1.0 if norm > 0 else (-1.0 if norm < 0 else 0.0))


def _vol_regime(closes: list[float]) -> str:
    """high_vol / low_vol по перцентилю стандартного отклонения возвратов в собственной истории."""
    rets = _returns(closes)
    if len(rets) < 5:
        return "low_vol"
    sd = statistics.pstdev(rets)
    median_abs = statistics.median(abs(r) for r in rets) or 1e-9
    return "high_vol" if sd > median_abs * 2.5 else "low_vol"


def _bocd_change_prob(closes: list[float]) -> float:
    """
    Вероятность того, что режим только что сменился, по последним 50 closes
    через Bayesian Online Change Point Detection. Возвращает hazard-массу
    P(r=0) последнего шага ∈ [0,1]; если BOCD недоступен — 0.0 (нейтрально).
    Чем выше — тем меньше доверия к классифицированному режиму (рынок ломается).
    """
    if not _HAS_BOCD or len(closes) < 12:
        return 0.0
    try:
        window = closes[-50:]
        # beta задаёт ожидаемую дисперсию лог-доходностей режима (внутридневной масштаб).
        det = BOCD(hazard_rate=1.0 / 100.0,
                   prior=NIGParams(mu=0.0, kappa=1.0, alpha=2.0, beta=1e-4),
                   change_threshold=0.15)
        last = None
        for i in range(1, len(window)):
            prev, cur = window[i - 1], window[i]
            if prev <= 0 or cur <= 0:
                continue
            import math as _m
            last = det.update(_m.log(cur / prev))
        if last is None:
            return 0.0
        # hazard_mass = P(r=0); при свежей смене режима стремится вверх.
        return float(max(0.0, min(1.0, last.hazard_mass)))
    except Exception:
        return 0.0


def classify_regime(closes: list[float], volumes: list[float] | None = None) -> tuple[str, float]:
    """
    Порт classifyRegime: упрощённая версия без orderbook/OI-стресс-истории
    (которой нет в самой стратегии) — здесь регим определяется по силе тренда,
    направлению и волатильности самого ценового ряда.

    Возвращает (regime, regime_confidence): confidence ∈ [0,1] — насколько
    можно доверять классификации. BOCD понижает её на 30%, если на последнем
    шаге обнаружена свежая смена режима (change_prob > 0.5) — режим, который
    только что сломался, ещё не устаканился.
    """
    if len(closes) < 10:
        return "ranging", 1.0
    trend, direction = _trend_strength(closes)
    vol_level = _vol_regime(closes)

    vol_spike = 0.0
    if volumes and len(volumes) >= 5:
        med = statistics.median(volumes[:-1]) or 1e-9
        vol_spike = min(1.0, max(0.0, (volumes[-1] / med - 1.0)))

    p_stress = min(1.0, (1.0 if vol_level == "high_vol" else 0.0) * 0.5 + vol_spike * 0.5)
    if p_stress >= 0.75:
        regime = "stress"
    elif vol_level == "high_vol" and trend < 0.3:
        regime = "high_vol"
    elif vol_level == "low_vol" and trend < 0.3:
        regime = "low_vol"
    elif trend >= 0.45 and direction > 0:
        regime = "trending_up"
    elif trend >= 0.45 and direction < 0:
        regime = "trending_down"
    else:
        regime = "ranging"

    confidence = 1.0
    if _bocd_change_prob(closes) > 0.5:
        confidence *= 0.7  # свежий излом — на 30% меньше доверия к режиму
    return regime, confidence


# ── Детекция точек излома ────────────────────────────────────────────────

def _cusum_last_dir(closes: list[float], threshold: float = 5.0) -> str | None:
    if len(closes) < 5:
        return None
    mu, sd = statistics.fmean(closes), (statistics.pstdev(closes) or 1e-9)
    k, h = threshold * 0.15, threshold * 0.8
    sp = sm = 0.0
    last_dir = None
    for c in closes:
        z = (c - mu) / sd
        sp = max(0.0, sp + z - k)
        sm = max(0.0, sm - z - k)
        if sp > h:
            last_dir, sp = "up", 0.0
        elif sm > h:
            last_dir, sm = "down", 0.0
    return last_dir


def _pelt_last_dir(closes: list[float], threshold: float = 5.0, window: int = 5) -> str | None:
    n = len(closes)
    if n < window * 2:
        return None
    last_dir = None
    for i in range(window, n - window):
        before, after = closes[i - window:i], closes[i:i + window]
        bm, am = statistics.fmean(before), statistics.fmean(after)
        bv = statistics.pvariance(before) if len(before) > 1 else 0.0
        av = statistics.pvariance(after) if len(after) > 1 else 0.0
        denom = (((bv + av) / 2) ** 0.5) or 1e-9
        score = abs(am - bm) / denom
        if score > threshold * 0.35:
            last_dir = "up" if am > bm else "down"
    return last_dir


def _zscore_last_dir(closes: list[float], threshold: float = 5.0, window: int = 5) -> str | None:
    n = len(closes)
    if n <= window:
        return None
    last_dir = None
    for i in range(window, n):
        win = closes[i - window:i]
        wm, wsd = statistics.fmean(win), (statistics.pstdev(win) or 1e-9)
        z = (closes[i] - wm) / wsd
        if abs(z) > threshold * 0.4:
            last_dir = "up" if z > 0 else "down"
    return last_dir


def change_point_score(closes: list[float]) -> float:
    """
    Голос за направление только если >=2 из 3 алгоритмов (CUSUM/PELT/Z-Score)
    нашли свежий излом в одну сторону на этом окне — иначе 0 (нет сигнала).
    """
    dirs = [_cusum_last_dir(closes), _pelt_last_dir(closes), _zscore_last_dir(closes)]
    up = sum(1 for d in dirs if d == "up")
    down = sum(1 for d in dirs if d == "down")
    if up >= 2:
        return 1.0 if up == 3 else 0.6
    if down >= 2:
        return -1.0 if down == 3 else -0.6
    return 0.0
