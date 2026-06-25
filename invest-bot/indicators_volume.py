"""
indicators_volume.py — объёмные индикаторы для composite score.

Реализованы как чистые функции над списками float — без зависимостей,
тестируемы отдельно от стратегии.

Экспортируются score-функции (возвращают ∈ [-1, 1]):
  score_obv_div        — OBV-дивергенция с ценой
  score_chaikin_ad     — Chaikin A/D дивергенция
  score_mfi_div        — MFI-дивергенция
  score_vol_asymmetry  — объём на импульсе vs откате
  volume_profile       — профиль объёма: POC, VAH, VAL, карта пустот

Старые функции (klinger, vzo, twiggs, rmi, rolling_zscore) оставлены
для обратной совместимости, но больше не используются в composite.
"""
import math

__all__ = (
    # Новые / переработанные
    "obv_series", "score_obv_div",
    "chaikin_ad_series", "score_chaikin_ad",
    "money_flow_index", "score_mfi_div",
    "score_vol_asymmetry",
    "volume_profile", "score_vol_profile",
    # Совместимость
    "klinger_oscillator", "vzo", "twiggs_money_flow", "rmi", "rolling_zscore",
    "score_klinger", "score_vzo", "score_twiggs", "score_rmi", "score_zscore",
)


def _ema(values: list[float], period: int) -> list[float]:
    if not values:
        return []
    alpha = 2 / (period + 1)
    out = [values[0]]
    for v in values[1:]:
        out.append(alpha * v + (1 - alpha) * out[-1])
    return out


# ── OBV и дивергенция ─────────────────────────────────────────────────────────

def obv_series(closes: list[float], volumes: list[float]) -> list[float]:
    """On Balance Volume: накапливаем объём по знаку изменения цены."""
    if len(closes) < 2:
        return [0.0] * len(closes)
    out = [0.0]
    for i in range(1, len(closes)):
        delta = volumes[i] if closes[i] > closes[i - 1] else (
            -volumes[i] if closes[i] < closes[i - 1] else 0.0
        )
        out.append(out[-1] + delta)
    return out


def score_obv_div(closes: list[float], volumes: list[float], lookback: int = 20) -> float:
    """
    OBV-дивергенция: расхождение тренда цены и тренда OBV.

    Бычья дивергенция: цена делает новый локальный лоу, OBV нет
      → продавцы выдыхаются, поглощение на падении.
    Медвежья: цена делает новый хай, OBV нет
      → крупные продают в рост.

    Сигнал ∈ [-1, 1]; >0 бычий, <0 медвежий.
    """
    n = min(lookback, len(closes))
    if n < 6:
        return 0.0
    obv = obv_series(closes, volumes)
    price_w = closes[-n:]
    obv_w = obv[-n:]

    p_rng = max(price_w) - min(price_w) or 1e-9
    o_rng = max(obv_w) - min(obv_w) or 1e-9

    # Нормированный тренд за окно
    p_trend = (price_w[-1] - price_w[0]) / p_rng
    o_trend = (obv_w[-1] - obv_w[0]) / o_rng

    # Дивергенция = разность нормированных трендов
    # Если OBV растёт быстрее цены → скрытое накопление (+)
    # Если цена растёт, OBV нет → распределение (-)
    div = o_trend - p_trend
    return round(max(-1.0, min(1.0, math.tanh(div * 2.0))), 4)


# ── Chaikin A/D и дивергенция ─────────────────────────────────────────────────

def chaikin_ad_series(highs: list[float], lows: list[float],
                       closes: list[float], volumes: list[float]) -> list[float]:
    """
    Chaikin Accumulation/Distribution Line.
    CLV = ((close-low) - (high-close)) / (high-low) ∈ [-1,1]
    A/D += CLV × volume — грубая аппроксимация aggressiveness покупок/продаж
    без footprint-данных.
    """
    out = [0.0]
    for h, l, c, v in zip(highs, lows, closes, volumes):
        rng = h - l or 1e-9
        clv = ((c - l) - (h - c)) / rng
        out.append(out[-1] + clv * v)
    return out[1:]


def score_chaikin_ad(highs: list[float], lows: list[float],
                      closes: list[float], volumes: list[float],
                      lookback: int = 20) -> float:
    """
    A/D дивергенция с ценой.

    Накопление при падении (A/D растёт, цена нет) → бычий.
    Распределение при росте (A/D падает, цена растёт) → медвежий.

    Тип: Chaikin — закрытие в нижней части диапазона на большом объёме
    считается признаком распределения даже если цена выросла.
    """
    n = min(lookback, len(closes))
    if n < 6:
        return 0.0
    ad = chaikin_ad_series(highs, lows, closes, volumes)
    p_w = closes[-n:]
    a_w = ad[-n:]

    p_rng = max(p_w) - min(p_w) or 1e-9
    a_rng = max(a_w) - min(a_w) or 1e-9

    p_trend = (p_w[-1] - p_w[0]) / p_rng
    a_trend = (a_w[-1] - a_w[0]) / a_rng

    div = a_trend - p_trend
    return round(max(-1.0, min(1.0, math.tanh(div * 2.0))), 4)


# ── Money Flow Index и дивергенция ────────────────────────────────────────────

def money_flow_index(highs: list[float], lows: list[float],
                      closes: list[float], volumes: list[float],
                      period: int = 14) -> float:
    """
    MFI = RSI взвешенный на объём.
    Типичная цена TP = (H+L+C)/3.
    Raw Money Flow = TP × Volume.
    Разделяем на positive (TP[i] > TP[i-1]) и negative.
    MFI = 100 - 100/(1 + pos/neg).
    """
    n = len(closes)
    if n < period + 1:
        return 50.0
    tp = [(highs[i] + lows[i] + closes[i]) / 3 for i in range(n)]
    rmf = [tp[i] * volumes[i] for i in range(n)]

    pos = neg = 0.0
    for i in range(n - period, n):
        if i == 0:
            continue
        if tp[i] > tp[i - 1]:
            pos += rmf[i]
        elif tp[i] < tp[i - 1]:
            neg += rmf[i]
    if neg == 0:
        return 100.0
    return 100 - 100 / (1 + pos / (neg or 1e-9))


def _mfi_series(highs: list[float], lows: list[float],
                 closes: list[float], volumes: list[float],
                 period: int = 14) -> list[float]:
    """MFI для каждого бара (скользящее окно)."""
    n = len(closes)
    out = [50.0] * n
    for i in range(period, n):
        out[i] = money_flow_index(
            highs[max(0, i - period):i + 1],
            lows[max(0, i - period):i + 1],
            closes[max(0, i - period):i + 1],
            volumes[max(0, i - period):i + 1],
            period=period,
        )
    return out


def score_mfi_div(highs: list[float], lows: list[float],
                   closes: list[float], volumes: list[float],
                   period: int = 14, lookback: int = 20) -> float:
    """
    MFI-дивергенция с ценой.

    Цена делает новый хай, MFI нет → слабость движения (продавцы давят
    на объёме внутри баров). Сигнал ∈ [-1, 1].

    В отличие от чистого overbought/oversold (30/70) — смотрим именно
    на расхождение трендов цены и объёмного RSI за lookback баров.
    """
    n = min(lookback, len(closes))
    if n < period + 4:
        return 0.0
    mfi = _mfi_series(highs, lows, closes, volumes, period=period)
    p_w = closes[-n:]
    m_w = mfi[-n:]

    p_rng = max(p_w) - min(p_w) or 1e-9
    m_rng = max(m_w) - min(m_w) or 1e-9

    p_trend = (p_w[-1] - p_w[0]) / p_rng
    # MFI нормируем от центра (50): выше 50 бычий, ниже медвежий
    m_trend = (m_w[-1] - m_w[0]) / (m_rng or 1e-9)

    div = m_trend - p_trend
    return round(max(-1.0, min(1.0, math.tanh(div * 2.0))), 4)


# ── Объём на импульсе vs откате ───────────────────────────────────────────────

def score_vol_asymmetry(closes: list[float], volumes: list[float],
                         lookback: int = 20) -> float:
    """
    Асимметрия объёма: объём на барах по тренду vs против тренда.

    Логика: определяем направление тренда за окно (знак изменения цены).
    Затем делим бары на импульсные (по тренду) и коррекционные (против тренда).

    Если объём на импульсных >> объёма на коррекционных → тренд агрессивный,
    следуем в его направлении (+).

    Если объём на коррекциях >> импульсных → тренд слабеет, поглощение (−).

    Возвращает (знак тренда) × асимметрию ∈ [-1, 1].
    """
    n = min(lookback, len(closes))
    if n < 6:
        return 0.0
    c = closes[-n:]
    v = volumes[-n:]

    # Направление тренда за весь период
    trend = 1.0 if c[-1] > c[0] else (-1.0 if c[-1] < c[0] else 0.0)
    if trend == 0.0:
        return 0.0

    impulse_vols, corr_vols = [], []
    for i in range(1, n):
        bar_dir = 1.0 if c[i] > c[i - 1] else (-1.0 if c[i] < c[i - 1] else 0.0)
        if bar_dir == 0:
            continue
        if bar_dir == trend:
            impulse_vols.append(v[i])
        else:
            corr_vols.append(v[i])

    if not impulse_vols or not corr_vols:
        return 0.0

    imp_avg = sum(impulse_vols) / len(impulse_vols)
    cor_avg = sum(corr_vols) / len(corr_vols)
    total = imp_avg + cor_avg or 1e-9

    # Асимметрия ∈ (-1, 1): >0 означает импульс мощнее коррекции
    asym = (imp_avg - cor_avg) / total
    return round(max(-1.0, min(1.0, trend * math.tanh(asym * 3.0))), 4)


# ── Volume Profile (настоящий) ────────────────────────────────────────────────

def volume_profile(highs: list[float], lows: list[float],
                    volumes: list[float], n_bins: int = 48
                    ) -> tuple[float, float, float, list[float], float, float]:
    """
    Настоящий профиль объёма: гистограмма volume-at-price.

    Возвращает (poc_price, vah, val, bins, price_lo, bin_size):
      poc_price — Point of Control (уровень с максимальным объёмом)
      vah       — Value Area High (верхняя граница 70%-зоны)
      val       — Value Area Low  (нижняя граница 70%-зоны)
      bins      — список объёмов по ценовым корзинам
      price_lo  — нижняя граница диапазона (для пересчёта бин→цена)
      bin_size  — ширина корзины

    Алгоритм ценовой корзины: каждая свеча добавляет свой объём
    в бин по типичной цене (H+L)/2. Для более точного распределения
    объём свечи распределяется равномерно по всем бинам, которые
    пересекает диапазон [low, high] этой свечи.
    """
    if not highs or not lows or not volumes:
        return 0.0, 0.0, 0.0, [], 0.0, 1.0

    price_lo = min(lows)
    price_hi = max(highs)
    span = price_hi - price_lo
    if span <= 0:
        return (price_lo + price_hi) / 2, price_hi, price_lo, [sum(volumes)], price_lo, 1.0

    bin_size = span / n_bins
    bins = [0.0] * n_bins

    for h, l, v in zip(highs, lows, volumes):
        # Распределяем объём свечи равномерно по бинам, которые она перекрывает
        lo_bin = int((l - price_lo) / bin_size)
        hi_bin = int((h - price_lo) / bin_size)
        lo_bin = max(0, min(n_bins - 1, lo_bin))
        hi_bin = max(0, min(n_bins - 1, hi_bin))
        n_covered = hi_bin - lo_bin + 1
        per_bin = v / n_covered
        for b in range(lo_bin, hi_bin + 1):
            bins[b] += per_bin

    # POC — бин с максимальным объёмом
    poc_bin = max(range(n_bins), key=lambda i: bins[i])
    poc_price = price_lo + (poc_bin + 0.5) * bin_size

    # Value Area: расширяем от POC пока не наберём 70% суммарного объёма
    total_vol = sum(bins) or 1e-9
    target = total_vol * 0.70
    va_lo = va_hi = poc_bin
    va_vol = bins[poc_bin]

    while va_vol < target and (va_lo > 0 or va_hi < n_bins - 1):
        up = bins[va_hi + 1] if va_hi < n_bins - 1 else -1.0
        dn = bins[va_lo - 1] if va_lo > 0 else -1.0
        if up >= dn:
            va_hi = min(n_bins - 1, va_hi + 1)
            va_vol += bins[va_hi]
        else:
            va_lo = max(0, va_lo - 1)
            va_vol += bins[va_lo]

    vah = price_lo + (va_hi + 1) * bin_size
    val = price_lo + va_lo * bin_size

    return poc_price, vah, val, bins, price_lo, bin_size


def score_vol_profile(price: float, poc: float, vah: float, val: float,
                       bins: list[float], price_lo: float, bin_size: float,
                       atr_abs: float) -> float:
    """
    Торговый сигнал из профиля объёма.

    Логика:
    1. У POC (< 0.5 ATR) — нейтраль: двусторонняя торговля, рынок ищет баланс.
    2. Выше VAH — бычий дисбаланс (пробой из Value Area).
       Пустая зона выше VAH (мало объёма) → ускорение.
    3. Ниже VAL — медвежий дисбаланс.
       Пустая зона ниже VAL → ускорение.
    4. Внутри VA (между VAL и VAH) — слабый направленный сигнал
       по тому с какой стороны от POC находится цена.
    """
    if not bins or atr_abs <= 0 or poc <= 0:
        return 0.0

    dist_poc = price - poc  # > 0 выше POC

    # Нейтраль у POC
    if abs(dist_poc) < 0.5 * atr_abs:
        return 0.0

    n_bins = len(bins)

    def _thin_zone_above(start_price: float, look_atr: float = 1.5) -> bool:
        """True если зона над start_price бедна объёмом (< 20% среднего бина)."""
        if bin_size <= 0 or n_bins == 0:
            return False
        avg_bin = sum(bins) / n_bins or 1e-9
        start_bin = int((start_price - price_lo) / bin_size)
        end_bin = min(n_bins - 1, start_bin + int(look_atr * atr_abs / bin_size) + 1)
        if start_bin >= n_bins:
            return True  # за пределами — пусто
        zone = bins[max(0, start_bin):end_bin + 1]
        return (sum(zone) / (len(zone) or 1)) < 0.20 * avg_bin

    def _thin_zone_below(start_price: float, look_atr: float = 1.5) -> bool:
        if bin_size <= 0 or n_bins == 0:
            return False
        avg_bin = sum(bins) / n_bins or 1e-9
        end_bin = int((start_price - price_lo) / bin_size)
        start_bin = max(0, end_bin - int(look_atr * atr_abs / bin_size) - 1)
        if end_bin < 0:
            return True
        zone = bins[start_bin:max(0, end_bin) + 1]
        return (sum(zone) / (len(zone) or 1)) < 0.20 * avg_bin

    if price > vah:
        # Выше Value Area — бычий дисбаланс
        strength = min(1.0, (price - vah) / (atr_abs or 1e-9))
        thin_bonus = 0.3 if _thin_zone_above(vah) else 0.0
        return round(min(1.0, 0.5 + 0.5 * strength + thin_bonus), 4)

    if price < val:
        # Ниже Value Area — медвежий дисбаланс
        strength = min(1.0, (val - price) / (atr_abs or 1e-9))
        thin_bonus = 0.3 if _thin_zone_below(val) else 0.0
        return round(-min(1.0, 0.5 + 0.5 * strength + thin_bonus), 4)

    # Внутри VA: слабый сигнал по стороне от POC
    if price > poc:
        return round(min(0.4, 0.4 * (price - poc) / (vah - poc + 1e-9)), 4)
    return round(-min(0.4, 0.4 * (poc - price) / (poc - val + 1e-9)), 4)


# ── Совместимость — старые функции ────────────────────────────────────────────

def klinger_oscillator(highs, lows, closes, volumes, fast=34, slow=55):
    n = len(closes)
    if n < 3:
        return [0.0] * n
    hlc = [highs[i] + lows[i] + closes[i] for i in range(n)]
    trend = [1] * n
    for i in range(1, n):
        trend[i] = 1 if hlc[i] > hlc[i - 1] else -1
    dm = [highs[i] - lows[i] for i in range(n)]
    cum_dm = dm[0] or 1e-9
    vf = [0.0] * n
    prev_trend = trend[0]
    for i in range(1, n):
        if trend[i] != prev_trend:
            cum_dm = dm[i] or 1e-9
        else:
            cum_dm += dm[i]
        prev_trend = trend[i]
        ratio = dm[i] / cum_dm if cum_dm else 0.0
        vf[i] = volumes[i] * abs(2 * ratio - 1) * trend[i] * 100
    return [a - b for a, b in zip(_ema(vf, fast), _ema(vf, slow))]


def vzo(closes, volumes, period=14):
    n = len(closes)
    if n < 2:
        return [0.0] * n
    vp = [volumes[0]] + [volumes[i] if closes[i] > closes[i - 1] else -volumes[i] for i in range(1, n)]
    ema_vp, ema_vol = _ema(vp, period), _ema(volumes, period)
    return [100 * ema_vp[i] / ema_vol[i] if ema_vol[i] else 0.0 for i in range(n)]


def twiggs_money_flow(highs, lows, closes, volumes, period=21):
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


def rmi(closes, period=14, momentum=5):
    n = len(closes)
    if n <= period + momentum:
        return 50.0
    diffs = [closes[i] - closes[i - momentum] for i in range(momentum, n)]
    window = diffs[-period:]
    up = sum(d for d in window if d > 0)
    down = -sum(d for d in window if d < 0)
    total = up + down
    return 100 * up / total if total else 50.0


def rolling_zscore(closes, period=20):
    window = closes[-period:]
    if len(window) < 5:
        return 0.0
    mean = sum(window) / len(window)
    sd = (sum((x - mean) ** 2 for x in window) / len(window)) ** 0.5
    return (closes[-1] - mean) / sd if sd else 0.0


def score_klinger(highs, lows, closes, volumes):
    if len(closes) < 10:
        return 0.0
    series = klinger_oscillator(highs, lows, closes, volumes,
                                 fast=min(34, len(closes) // 2 or 1),
                                 slow=min(55, len(closes) - 1 or 1))
    if len(series) < 2:
        return 0.0
    v, prev = series[-1], series[-2]
    if v > 0 and prev < 0:
        return 1.0
    if v < 0 and prev > 0:
        return -1.0
    return 0.5 if v > 0 else (-0.5 if v < 0 else 0.0)


def score_vzo(closes, volumes):
    if len(closes) < 10:
        return 0.0
    val = vzo(closes, volumes, period=min(14, len(closes) - 1))[-1]
    if val > 5:
        return 1.0
    if val > 0:
        return 0.5
    if val < -5:
        return -1.0
    return -0.5 if val < 0 else 0.0


def score_twiggs(highs, lows, closes, volumes):
    if len(closes) < 10:
        return 0.0
    v = twiggs_money_flow(highs, lows, closes, volumes, period=min(21, len(closes) - 1))[-1]
    if v > 0.05:
        return 1.0
    if v > 0:
        return 0.5
    if v < -0.05:
        return -1.0
    return -0.5 if v < 0 else 0.0


def score_rmi(closes):
    if len(closes) < 15:
        return 0.0
    v = rmi(closes, period=min(14, len(closes) // 2), momentum=min(5, len(closes) // 4 or 1))
    if v > 70:
        return -1.0
    if v > 55:
        return 0.5
    if v < 30:
        return 1.0
    return -0.5 if v < 45 else 0.0


def score_zscore(closes):
    if len(closes) < 10:
        return 0.0
    v = rolling_zscore(closes, period=min(20, len(closes)))
    if v < -2:
        return 1.0
    if v < -1:
        return 0.5
    if v > 2:
        return -1.0
    return -0.5 if v > 1 else 0.0
