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

__all__ = ("classify_regime", "classify_regime_probs", "REGIME_WEIGHT_MODS",
           "change_point_score", "classify_phase", "PHASE_WEIGHT_MODS")

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
        "OB_IMBALANCE": 1.0, "CANCEL_SIGNAL": 0.8, "INST_OI": 1.2, "RETAIL_CONTRA": 1.1,
        # Трендовые методы — главные судьи в трендовом режиме
        "PRICE_TREND": 1.6, "MKT_STRUCTURE": 1.5, "ADAPTIVE_MA": 1.4, "DONCHIAN": 1.4,
        "ALLIGATOR": 1.3, "T3_SIGNAL": 1.3, "ZLEMA_SIGNAL": 1.3, "MAMA_FAMA": 1.3,
        "TWIGGS": 1.3, "IMPULSE_PULLBACK": 1.4,
        # NW хорошо чувствует «справедливую цену» в тренде; FracDiff нейтрален → умеренно
        "NADARAYA_WATSON": 1.3, "FRACTIONAL_DIFF": 1.1,
        "LEVEL_CONTEXT": 1.2, "SPRING": 1.1, "WICK_REJECTION": 1.2, "TRIANGLE": 1.3,
        # MA_ENVELOPE: за=55% WR в trending_up, чёткое разделение → поднимаем
        "MA_ENVELOPE": 1.4,
        "SINEWAVE_SIGNAL": 0.7, "CYBER_PHASE": 0.7, "FISHER_RSI": 0.8, "ZSCORE": 0.8,
    },
    "trending_down": {
        "BS_PRESSURE": 1.3, "BS_PRESSURE_TS": 1.3, "AGGRESSOR_FLOW": 1.3, "LARGE_IMPACT": 1.2,
        "VWAP_SIGNAL": 1.1, "VWAP_SIGNAL_TS": 1.1, "VOL_MOMENTUM": 1.4, "VOL_MOMENTUM_TS": 1.4,
        "OB_IMBALANCE": 1.0, "CANCEL_SIGNAL": 0.8, "INST_OI": 1.2, "RETAIL_CONTRA": 1.1,
        "PRICE_TREND": 1.6, "MKT_STRUCTURE": 1.5, "ADAPTIVE_MA": 1.4, "DONCHIAN": 1.4,
        "ALLIGATOR": 1.3, "T3_SIGNAL": 1.3, "ZLEMA_SIGNAL": 1.3, "MAMA_FAMA": 1.3,
        "TWIGGS": 1.3, "IMPULSE_PULLBACK": 1.4,
        # NW: за=62% WR в trending_down → поднимаем; FracDiff за=42% → приглушаем
        "NADARAYA_WATSON": 1.4, "FRACTIONAL_DIFF": 0.9,
        "LEVEL_CONTEXT": 1.2, "SPRING": 1.1, "WICK_REJECTION": 1.2, "TRIANGLE": 1.3,
        # MA_ENVELOPE: за=55%/против=27% — сильный разрыв → высокий вес
        "MA_ENVELOPE": 1.5,
        "SINEWAVE_SIGNAL": 0.7, "CYBER_PHASE": 0.7, "FISHER_RSI": 0.8, "ZSCORE": 0.8,
    },
    "ranging": {
        "BS_PRESSURE": 0.9, "BS_PRESSURE_TS": 0.9, "AGGRESSOR_FLOW": 0.9, "LARGE_IMPACT": 0.8,
        "VWAP_SIGNAL": 1.4, "VWAP_SIGNAL_TS": 1.4, "VOL_MOMENTUM": 0.7, "VOL_MOMENTUM_TS": 0.7,
        "OB_IMBALANCE": 1.3, "CANCEL_SIGNAL": 1.2, "INST_OI": 1.0, "RETAIL_CONTRA": 0.9,
        # В боковике трендовые методы шумят — приглушаем
        "PRICE_TREND": 0.5, "MKT_STRUCTURE": 0.7, "ADAPTIVE_MA": 0.6, "DONCHIAN": 0.6, "MA_ENVELOPE": 1.4,
        # NW в боковике даёт контрарный сигнал (против=70% WR) — но как directional vote мешает → снижаем
        # FracDiff нейтрален в ranging → умеренно
        "NADARAYA_WATSON": 0.5, "FRACTIONAL_DIFF": 0.7,
        "ALLIGATOR": 0.7, "T3_SIGNAL": 0.7, "ZLEMA_SIGNAL": 0.7, "MAMA_FAMA": 0.7,
        "TWIGGS": 0.7, "IMPULSE_PULLBACK": 0.8,
        "LEVEL_CONTEXT": 1.5, "SPRING": 1.3, "WICK_REJECTION": 1.5, "TRIANGLE": 1.6,
        # Осцилляторы в боковике работают хорошо
        "SINEWAVE_SIGNAL": 1.3, "CYBER_PHASE": 1.3, "FISHER_RSI": 1.2, "ZSCORE": 1.2,
    },
    "high_vol": {
        "BS_PRESSURE": 0.8, "BS_PRESSURE_TS": 0.8, "AGGRESSOR_FLOW": 0.8, "LARGE_IMPACT": 1.2,
        "VWAP_SIGNAL": 0.6, "VWAP_SIGNAL_TS": 0.6, "VOL_MOMENTUM": 0.7, "VOL_MOMENTUM_TS": 0.7,
        "OB_IMBALANCE": 0.7, "CANCEL_SIGNAL": 1.3, "INST_OI": 1.1, "RETAIL_CONTRA": 1.4,
        "PRICE_TREND": 0.5, "MKT_STRUCTURE": 1.2, "ADAPTIVE_MA": 0.6, "DONCHIAN": 0.7,
        "ALLIGATOR": 0.7, "T3_SIGNAL": 0.7, "ZLEMA_SIGNAL": 0.7, "MAMA_FAMA": 0.7,
        "TWIGGS": 0.7, "IMPULSE_PULLBACK": 0.9,
        "LEVEL_CONTEXT": 1.3, "SPRING": 0.7, "WICK_REJECTION": 0.8, "TRIANGLE": 0.7,
        # high_vol: мало данных (11 сделок), NW против=100% — осторожно снижаем как directional
        "MA_ENVELOPE": 0.9, "NADARAYA_WATSON": 0.7, "FRACTIONAL_DIFF": 0.8,
        "SINEWAVE_SIGNAL": 0.8, "CYBER_PHASE": 0.8, "FISHER_RSI": 0.9, "ZSCORE": 0.9,
    },
    "low_vol": {
        "BS_PRESSURE": 0.7, "BS_PRESSURE_TS": 0.7, "AGGRESSOR_FLOW": 0.7, "LARGE_IMPACT": 1.3,
        "VWAP_SIGNAL": 1.2, "VWAP_SIGNAL_TS": 1.2, "VOL_MOMENTUM": 0.6, "VOL_MOMENTUM_TS": 0.6,
        "OB_IMBALANCE": 1.4, "CANCEL_SIGNAL": 1.1, "INST_OI": 1.0, "RETAIL_CONTRA": 0.8,
        # Низкая волатильность — тренд может быть, но слабый; умеренное доверие трендовым
        "PRICE_TREND": 0.8, "MKT_STRUCTURE": 0.8, "ADAPTIVE_MA": 0.8, "DONCHIAN": 0.8,
        "ALLIGATOR": 0.8, "T3_SIGNAL": 0.8, "ZLEMA_SIGNAL": 0.8, "MAMA_FAMA": 0.8,
        "TWIGGS": 0.8, "IMPULSE_PULLBACK": 0.9,
        "LEVEL_CONTEXT": 1.1, "SPRING": 1.4, "WICK_REJECTION": 1.4, "TRIANGLE": 1.5,
        # MA_ENVELOPE в low_vol: за/против ~60% — нейтрально, оставляем умеренно
        # NW в low_vol: контрарный (против=70%), как directional vote — ненадёжен → приглушаем
        # FracDiff в low_vol: за=61% → полезен
        "MA_ENVELOPE": 1.1, "NADARAYA_WATSON": 0.6, "FRACTIONAL_DIFF": 1.2,
        "SINEWAVE_SIGNAL": 1.2, "CYBER_PHASE": 1.2, "FISHER_RSI": 1.1, "ZSCORE": 1.1,
    },
    "stress": {
        "BS_PRESSURE": 0.5, "BS_PRESSURE_TS": 0.5, "AGGRESSOR_FLOW": 0.5, "LARGE_IMPACT": 0.9,
        "VWAP_SIGNAL": 0.4, "VWAP_SIGNAL_TS": 0.4, "VOL_MOMENTUM": 0.5, "VOL_MOMENTUM_TS": 0.5,
        "OB_IMBALANCE": 0.5, "CANCEL_SIGNAL": 0.9, "INST_OI": 1.5, "RETAIL_CONTRA": 1.5, "PRICE_TREND": 0.3,
        "MKT_STRUCTURE": 0.3, "LEVEL_CONTEXT": 0.5, "SPRING": 0.3,
        # Стресс: паника ломает любые паттерны, новые методы тоже приглушаем
        "WICK_REJECTION": 0.4, "TRIANGLE": 0.3,
        "MA_ENVELOPE": 0.5, "NADARAYA_WATSON": 0.5, "FRACTIONAL_DIFF": 0.6,
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


def _smoothstep(x: float, lo: float, hi: float) -> float:
    """0 при x<=lo, 1 при x>=hi, кубическая гладкая интерполяция между — заменяет
    жёсткие cliff-границы (`trend >= 0.45`) на непрерывный переход без скачков."""
    if hi <= lo:
        return 1.0 if x >= hi else 0.0
    t = min(1.0, max(0.0, (x - lo) / (hi - lo)))
    return t * t * (3 - 2 * t)


def classify_regime_probs(closes: list[float], volumes: list[float] | None = None) -> dict[str, float]:
    """
    Layer 0: непрерывное распределение вероятностей по всем REGIMES вместо
    жёсткого if/elif (oldclassify_regime имел разрывные границы вида
    `trend >= 0.45` — на самой границе режим мог скакать туда-обратно от шума
    в один тик). Здесь те же признаки (trend, direction, vol_ratio, vol_spike),
    но переходы между режимами — гладкие (_smoothstep), а результат —
    нормированное распределение (сумма = 1), а не одна точка.
    """
    if len(closes) < 10:
        return {r: (1.0 if r == "ranging" else 0.0) for r in REGIMES}

    n = len(closes)
    trend, direction = _trend_strength(closes)
    rets = _returns(closes)
    if len(rets) >= 5:
        sd = statistics.pstdev(rets)
        median_abs = statistics.median(abs(r) for r in rets) or 1e-9
        vol_ratio = sd / median_abs
    else:
        vol_ratio = 1.0

    vol_spike = 0.0
    if volumes and len(volumes) >= 5:
        med = statistics.median(volumes[:-1]) or 1e-9
        vol_spike = min(1.0, max(0.0, (volumes[-1] / med - 1.0)))

    # Непрерывный стресс-сигнал: плавный рост с vol_ratio вместо жёсткого порога
    p_stress_raw = min(1.0, _smoothstep(vol_ratio, 1.8, 3.0) * 0.5 + vol_spike * 0.5)
    # тот же признак, но непрерывный: доля "режим=high_vol" растёт с vol_ratio гладко
    vol_high_prob = _smoothstep(vol_ratio, 1.5, 3.5)

    s1 = _smoothstep(trend, 0.3, 0.45)   # 0..1: выход из vol-режимов (high/low_vol) в ranging
    s2 = _smoothstep(trend, 0.45, 0.6)   # 0..1: выход из ranging в trending

    # ── Отличаем ТРЕНД от ОТСКОКА и СКВИЗА ───────────────────────────────────
    # Наклон на всём окне ещё не тренд. Классическая ошибка: рост на последних
    # барах ВНУТРИ падающей структуры — это контртрендовый отскок, а не тренд.
    # На реальных сделках именно trending_up-лонги давали -135 net при WR 39%
    # (метка была инвертирована: «за» трендом проигрывало, «против» выигрывало),
    # тогда как trending_down оставался честным. Причина — у классификатора нет
    # структурного контекста: он смотрит одно короткое окно.
    #
    # structural_align: 1 если ранняя (2/3) и поздняя (1/3) часть окна смотрят в
    # одну сторону (настоящий тренд), 0 если противоположны (отскок/разворот) —
    # тогда наклон уводится в ranging (а ranging заблокирован для входа).
    # Симметрично: честный trending_down не страдает (обе части вниз → align=1).
    _STR_MIN = 0.15  # ниже — часть окна считаем безнаправленной (шум у нуля)
    _cut = max(5, n * 2 // 3)
    head, tail = closes[:_cut], closes[-max(5, n // 3):]
    str_head, dir_head = _trend_strength(head)
    str_tail, dir_tail = _trend_strength(tail)
    d_head = dir_head if str_head > _STR_MIN else 0.0
    d_tail = dir_tail if str_tail > _STR_MIN else 0.0
    structural_align = 0.0 if (d_head and d_tail and d_head != d_tail) else 1.0

    # squeeze_factor: настоящий тренд идёт с РАСШИРЕНИЕМ хода; сквиз — компрессия
    # с ложным наклоном. Сравниваем диапазон НА БАР (иначе более короткое tail-окно
    # всегда «уже» — и любой линейный тренд ложно читался бы как сжатие). 0 при
    # сильном сжатии недавнего хода, 1 при равном/расширяющемся.
    rng_recent = (max(tail) - min(tail)) / max(1, len(tail) - 1)
    rng_early = (max(head) - min(head)) / max(1, len(head) - 1) or 1e-9
    squeeze_factor = _smoothstep(rng_recent / (rng_early or 1e-9), 0.4, 0.9)

    trend_quality = structural_align * squeeze_factor  # [0,1]

    p_low_trend = 1 - s1
    # мАсса «псевдотренда» (отскок/сквиз) уходит в боковик, а не в trending_*
    p_trend = s2 * trend_quality
    p_ranging = s1 * (1 - s2) + s2 * (1 - trend_quality)

    direction_up = 1.0 if direction > 0 else 0.0
    direction_down = 1.0 if direction < 0 else 0.0
    trend_leftover = p_trend * (1 - direction_up - direction_down)

    pre_stress = {
        "high_vol": p_low_trend * vol_high_prob,
        "low_vol": p_low_trend * (1 - vol_high_prob),
        "ranging": p_ranging + trend_leftover,
        "trending_up": p_trend * direction_up,
        "trending_down": p_trend * direction_down,
        "stress": 0.0,
    }

    stress_prob = _smoothstep(p_stress_raw, 0.6, 0.9)
    probs = {r: v * (1 - stress_prob) for r, v in pre_stress.items()}
    probs["stress"] = stress_prob

    total = sum(probs.values()) or 1.0
    return {r: probs.get(r, 0.0) / total for r in REGIMES}


def classify_regime(closes: list[float], volumes: list[float] | None = None) -> tuple[str, float]:
    """
    Совместимость со старым контрактом (regime_str, confidence): argmax
    classify_regime_probs(). confidence — вероятность argmax-режима, плюс
    тот же BOCD-дисконт за свежий излом (см. classify_regime_probs для
    непрерывного распределения по всем режимам сразу).
    """
    probs = classify_regime_probs(closes, volumes)
    regime = max(probs, key=probs.get)
    confidence = probs[regime]

    if len(closes) >= 10 and _bocd_change_prob(closes) > 0.5:
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


# ── Фазовый анализ (боговик → spring → markup → distribution → reversal) ──
# Поверх существующего classify_regime — второй слой множителей на веса методов.
# Источник концепции: unified_trading_system.md (VSA+Wyckoff+AMT интеграция).

PHASES = ("accumulation", "spring", "markup", "distribution", "reversal")

# Множители на вес метода по фазе. 1.0 = без изменений (не упомянутые = 1.0).
PHASE_WEIGHT_MODS: dict[str, dict[str, float]] = {
    # Боговик: компрессия, накопление, нет тренда.
    # Важны: детекторы сжатия, объёмные накопители, Fisher в крайности.
    # Не нужны: трендовые, импульсные.
    "accumulation": {
        "ENTROPY": 1.5,          # энтропия низкая = сжатие = это и есть боговик
        "BB_KELTNER_SQUEEZE": 1.5,
        "ATR_EXHAUSTION": 1.4,   # в режиме сжатия голосует ЗА дрейф (направление компрессии)
        "TWIGGS": 1.3,           # тихое накопление в боковике — единственный pro-direction сигнал TWIGGS
        "VWAP_SIGNAL": 1.3,      # в боковике VWAP работает лучше
        "AMT_POC": 1.3,          # POC формируется именно в боговике
        "KLINGER": 1.2,          # накопление денежного потока
        "VZO": 1.2,
        "CUMUL_DELTA": 1.2,
        "PRICE_TREND": 0.5,      # тренда нет — линрег шумит
        "VOL_MOMENTUM": 0.6,
        "IMPULSE_PULLBACK": 0.5, # антисигнал, в боговике нет чёткого импульса/отката — шум
        "CASCADE": 0.5,
        "MA_TENSION": 0.6,
        "ADAPTIVE_MA": 0.7,
        "ICHIMOKU_SIGNAL": 0.7,
        "MAMA_FAMA": 0.6,        # в боговике линии MAMA/FAMA рядом — сигнала нет, шум
        "ZSCORE": 0.6,           # Z нейтрален в боковике — сигнал слабый
    },
    # Spring: резкий пробой + возврат за одну-две свечи, охота за стопами.
    # Важны: паттерны свечей, объёмные всплески, детекторы пробоя.
    # Снижаем: запаздывающие трендовые.
    "spring": {
        "CANDLE_PATTERN": 1.8,   # игла + возврат — суть spring
        "WICK_REJECTION": 1.8,   # хвостовое отвержение = суть spring
        "BB_KELTNER_SQUEEZE": 1.5,  # BB расширяется резко
        "FALSE_BREAKOUT": 1.6,   # spring это и есть ложный пробой
        # IMPULSE_PULLBACK всегда голосует -imp_dir (против направления импульса).
        # На spring пробой вниз = импульс вниз, IMPULSE_PULLBACK голосует вверх = правильно.
        "IMPULSE_PULLBACK": 1.5,
        "TWIGGS": 1.3,           # поворот от экстремума TMF = подтверждение смены фазы
        "ZSCORE": 1.2,           # Z≈0 при движении = энергия исчерпана, разворот близко
        "MAMA_FAMA": 1.2,        # схождение линий = смена цикла
        "ATR_EXHAUSTION": 1.3,   # при перерасходе пути голосует против пробоя = ЗА возврат
        "BS_PRESSURE": 1.4,      # давление разворачивается
        "CUMUL_DELTA": 1.4,      # дельта переключается
        "VOL_MOMENTUM": 1.3,
        "KLINGER": 1.3,          # пересекает ноль
        "CHANGE_POINT": 1.5,     # излом именно здесь
        "PRICE_TREND": 0.4,      # линрег не видит spring
        "ADAPTIVE_MA": 0.5,
        "MA_TENSION": 0.5,
        "SINEWAVE_SIGNAL": 0.6,
        "ALLIGATOR": 0.5,
        "ICHIMOKU_SIGNAL": 0.6,
        "ZLEMA_SIGNAL": 0.5,
        "T3_SIGNAL": 0.5,
    },
    # Markup (каскад): направленное ускоряющееся движение.
    # Важны: трендовые, импульсные, объёмные тренды.
    # Снижаем: осцилляторы перегрева (они всегда в крайности на каскаде — шум).
    "markup": {
        "PRICE_TREND": 1.5,
        "VOL_MOMENTUM": 1.5,
        "ADAPTIVE_MA": 1.4,
        "MA_TENSION": 1.4,
        "KLINGER": 1.3,
        "TREND_QUALITY": 1.4,
        "FRACTAL": 1.3,
        "ICHIMOKU_SIGNAL": 1.3,
        "ALLIGATOR": 1.3,
        "CASCADE": 1.4,
        "WANING_IMPULSES": 1.3,
        "ZLEMA_SIGNAL": 1.2,
        "T3_SIGNAL": 1.2,
        # Антисигналы — на здоровом каскаде мешают (голосуют против тренда):
        "ATR_EXHAUSTION": 0.4,   # в начале каскада ATR растёт — вызывает ложный "перерасход"
        "IMPULSE_PULLBACK": 0.4, # всегда -imp_dir, на каскаде без отката = шум
        "MAMA_FAMA": 0.5,        # на каскаде линии расходятся (нет схождения) — сигнала нет
        "TWIGGS": 0.6,           # в экстремуме TMF = сигнал разворота, на здоровом каскаде вреден
        "ZSCORE": 0.5,           # на каскаде Z высокий, но движение продолжается — ложный разворот
        "VWAP_SIGNAL": 0.7,      # на каскаде цена далеко от VWAP — шум
        "AMT_POC": 0.7,
        "ENTROPY": 0.7,
        "BB_KELTNER_SQUEEZE": 0.6,
        "CHANGE_POINT": 0.7,
    },
    # Distribution (затухание): новые хаи но объём падает, дивергенции.
    # Важны: детекторы дивергенции, затухания, поглощения.
    "distribution": {
        "WANING_IMPULSES": 1.6,  # затухание импульсов — суть фазы
        "VSA_ABSORPTION": 1.5,   # поглощение на хаях
        # ATR_EXHAUSTION в режиме перерасхода голосует -direction = против текущего хая.
        # Это именно то что нужно в distribution — антисигнал продолжения.
        "ATR_EXHAUSTION": 1.5,
        # MAMA_FAMA сходится после расхождения = цикл завершается → разворот.
        # В distribution это главный сигнал конца тренда.
        "MAMA_FAMA": 1.4,
        # TWIGGS поворачивает от экстремума = деньги смегали сторону.
        "TWIGGS": 1.4,
        # ZSCORE ≈ 0 при движущейся цене = энергия исчерпана.
        "ZSCORE": 1.3,
        # IMPULSE_PULLBACK голосует -imp_dir. На distribution откат глубокий
        # и volumetric — он будет сигнализировать против слабеющего тренда.
        "IMPULSE_PULLBACK": 1.3,
        "LEVEL_ABSORPTION": 1.4,
        "KLINGER": 1.3,
        "CUMUL_DELTA": 1.3,
        "FALSE_BREAKOUT": 1.3,   # ложные пробои хаёв
        "WICK_REJECTION": 1.3,
        "PRICE_TREND": 0.7,      # тренд ещё видит движение — но оно умирает
        "VOL_MOMENTUM": 0.7,
        "CASCADE": 0.5,
        "MA_TENSION": 0.7,
        "ALLIGATOR": 0.7,
        "ICHIMOKU_SIGNAL": 0.7,
    },
    # Reversal: переключение через ноль, новое направление.
    # Важны: все антисигналы + детекторы смены режима.
    "reversal": {
        "CANDLE_PATTERN": 1.5,
        "WICK_REJECTION": 1.4,
        "CHANGE_POINT": 1.6,     # излом — суть разворота
        "BS_PRESSURE": 1.4,
        "CUMUL_DELTA": 1.4,
        "FALSE_BREAKOUT": 1.3,
        # IMPULSE_PULLBACK: на развороте откат = старый тренд, он голосует против = новое направление.
        "IMPULSE_PULLBACK": 1.4,
        # MAMA_FAMA: схождение = смена цикла. На развороте это основной сигнал.
        "MAMA_FAMA": 1.5,
        # TWIGGS: поворот от экстремума = главный сигнал разворота TMF.
        "TWIGGS": 1.4,
        # ZSCORE: при низком Z и движении = энергия иссякла, вот-вот разворот.
        "ZSCORE": 1.4,
        # ATR_EXHAUSTION: если перерасход пути → -direction = в новую сторону.
        "ATR_EXHAUSTION": 1.3,
        "KLINGER": 1.3,
        "VZO": 1.2,
        "PRICE_TREND": 0.5,      # старый тренд мешает видеть разворот
        "ADAPTIVE_MA": 0.6,
        "MA_TENSION": 0.6,
        "ALLIGATOR": 0.6,
        "ICHIMOKU_SIGNAL": 0.6,
        "CASCADE": 0.4,
    },
}


def classify_phase(
    closes: list[float],
    volumes: list[float] | None = None,
    highs: list[float] | None = None,
    lows: list[float] | None = None,
) -> tuple[str, float]:
    """
    Определяет текущую фазу рынка по пяти категориям:
      accumulation → spring → markup → distribution → reversal

    Возвращает (phase_name, confidence ∈ [0,1]).
    Использует только closes/volumes/highs/lows — никаких внешних зависимостей.

    Алгоритм: каждый из 5 признаков-блоков голосует за свою фазу с весом.
    Победитель — argmax взвешенной суммы голосов.
    """
    n = len(closes)
    if n < 10:
        return "accumulation", 0.3

    votes: dict[str, float] = {p: 0.0 for p in PHASES}

    # ── Блок 1: компрессия BB / ATR → признак accumulation ──────────────────
    # Узкий диапазон последних свечей относительно исторического = боговик.
    if n >= 20:
        recent_ranges = [(highs[i] - lows[i]) / (closes[i] or 1.0)
                         for i in range(n - 10, n)] if highs and lows else []
        hist_ranges = [(highs[i] - lows[i]) / (closes[i] or 1.0)
                       for i in range(n - 20, n - 10)] if highs and lows else []
        if recent_ranges and hist_ranges:
            med_recent = statistics.median(recent_ranges)
            med_hist = statistics.median(hist_ranges) or 1e-9
            compression_ratio = med_recent / med_hist  # <1 = сжатие
            if compression_ratio < 0.6:
                votes["accumulation"] += 2.0
            elif compression_ratio < 0.85:
                votes["accumulation"] += 1.0
            elif compression_ratio > 1.8:
                # расширение диапазона — spring или markup
                votes["spring"] += 0.5
                votes["markup"] += 0.5

    # ── Блок 2: тренд closes (линрег наклон) ────────────────────────────────
    trend_str, trend_dir = _trend_strength(closes[-20:] if n >= 20 else closes)
    if trend_str > 0.55:
        # сильный тренд — markup или distribution
        votes["markup"] += 1.5
    elif trend_str > 0.3:
        votes["markup"] += 0.7
    else:
        # нет тренда — accumulation или reversal
        votes["accumulation"] += 0.8

    # ── Блок 3: объёмный всплеск на последней свече ──────────────────────────
    # Резкий всплеск объёма при слабом диапазоне = поглощение (distribution/spring).
    # Резкий всплеск при большом диапазоне = markup или spring.
    if volumes and len(volumes) >= 10:
        med_vol = statistics.median(volumes[-10:-1]) or 1e-9
        last_vol_ratio = volumes[-1] / med_vol
        last_range = ((highs[-1] - lows[-1]) / (closes[-1] or 1.0)) if highs and lows else 0.0
        med_range = (statistics.median(
            [(highs[i] - lows[i]) / (closes[i] or 1.0) for i in range(n - 10, n - 1)]
        ) if highs and lows else 0.0) or 1e-9

        if last_vol_ratio > 2.5:
            if last_range / med_range > 1.5:
                # большой объём + большой диапазон = spring или начало markup
                votes["spring"] += 1.5
                votes["markup"] += 0.5
            else:
                # большой объём + узкий диапазон = поглощение (distribution)
                votes["distribution"] += 1.5
                votes["spring"] += 0.5
        elif last_vol_ratio < 0.5:
            # маленький объём = откат в каскаде или боговик
            votes["accumulation"] += 0.5
            votes["markup"] += 0.3

    # ── Блок 4: скорость изменения цены (momentum) ──────────────────────────
    # Считаем ускорение: сравниваем returns последних 5 свечей vs предыдущих 5.
    if n >= 12:
        ret_recent = [(closes[i] - closes[i - 1]) / (closes[i - 1] or 1.0)
                      for i in range(n - 5, n)]
        ret_prev = [(closes[i] - closes[i - 1]) / (closes[i - 1] or 1.0)
                    for i in range(n - 10, n - 5)]
        abs_recent = statistics.mean(abs(r) for r in ret_recent)
        abs_prev = statistics.mean(abs(r) for r in ret_prev) or 1e-9
        momentum_accel = abs_recent / abs_prev

        if momentum_accel > 1.5:
            # ускорение — spring или markup
            votes["spring"] += 1.0
            votes["markup"] += 0.8
        elif momentum_accel < 0.6:
            # торможение при продолжении тренда — distribution или reversal
            if trend_str > 0.3:
                votes["distribution"] += 1.2
            else:
                votes["reversal"] += 0.8

    # ── Блок 5: разворот direction (смена знака тренда) ─────────────────────
    # Если короткий тренд противоположен длинному — разворот или spring.
    if n >= 20:
        trend_short, dir_short = _trend_strength(closes[-7:])
        trend_long, dir_long = _trend_strength(closes[-20:])
        if trend_short > 0.3 and trend_long > 0.3 and dir_short != dir_long:
            # направления противоположны — возможно reversal или spring
            votes["reversal"] += 1.2
            votes["spring"] += 0.8

    # ── Блок 6: признак затухания — новый ценовой экстремум без объёма ───────
    # Если последние 3 свечи делают новый хай/лой, но объём падает = distribution.
    if highs and lows and volumes and n >= 15:
        recent_high = max(highs[n - 3:n])
        hist_high = max(highs[n - 15:n - 3])
        recent_vol = statistics.mean(volumes[n - 3:n])
        hist_vol = statistics.mean(volumes[n - 15:n - 3]) or 1e-9
        if recent_high > hist_high and recent_vol / hist_vol < 0.75:
            votes["distribution"] += 1.5  # новый хай на слабом объёме
        recent_low = min(lows[n - 3:n])
        hist_low = min(lows[n - 15:n - 3])
        if recent_low < hist_low and recent_vol / hist_vol < 0.75:
            votes["distribution"] += 1.5  # новый лой на слабом объёме

    # ── Нормировка и уверенность ─────────────────────────────────────────────
    total = sum(votes.values()) or 1.0
    probs = {p: votes[p] / total for p in PHASES}
    phase = max(probs, key=probs.get)
    confidence = probs[phase]
    return phase, confidence
