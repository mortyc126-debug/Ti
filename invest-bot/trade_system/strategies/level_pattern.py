"""
level_pattern.py — детекция разворотного паттерна на ключевых уровнях.

Логика:
  1. Вычислить H/L предыдущего торгового дня из имеющихся свечей.
  2. Проверить, подходит ли цена к уровню (±proximity_atr * ATR).
  3. Зафиксировать объёмный всплеск (climax) на уровне.
  4. Убедиться, что за climax идёт компрессия (свечи сжимаются).
  5. Подождать импульсную свечу в обратную сторону.
  6. Вернуть entry, stop (за уровень + буфер на проколы), take (ratio × stop-dist).

Используется в OICompositeStrategy для замены фиксированного take/stop
на уровневые барьеры, когда паттерн распознан.
"""
from __future__ import annotations
from dataclasses import dataclass
from typing import Optional

from tinkoff.invest import HistoricCandle


def _f(q) -> float:
    """Quotation → float."""
    return q.units + q.nano / 1e9


@dataclass
class DayLevels:
    date: object  # datetime.date
    high: float
    low: float


@dataclass
class LevelEntry:
    entry: float
    stop: float
    take: float
    level: float            # уровень от которого отбой
    level_side: str         # "high" или "low"
    stop_dist_pct: float    # |entry - stop| / entry
    take_dist_pct: float    # |take - entry| / entry


def prev_day_levels(candles: list[HistoricCandle]) -> Optional[DayLevels]:
    """Вычисляет H/L предыдущего торгового дня из списка свечей."""
    if not candles:
        return None
    today = candles[-1].time.date()
    by_day: dict = {}
    for c in candles:
        d = c.time.date()
        if d >= today:
            continue
        h, lo = _f(c.high), _f(c.low)
        if d not in by_day:
            by_day[d] = [h, lo]
        else:
            if h > by_day[d][0]:
                by_day[d][0] = h
            if lo < by_day[d][1]:
                by_day[d][1] = lo
    if not by_day:
        return None
    prev = max(by_day.keys())
    return DayLevels(date=prev, high=by_day[prev][0], low=by_day[prev][1])


def _atr(candles: list[HistoricCandle], period: int = 14) -> float:
    """Среднее True Range последних period свечей."""
    trs = []
    for i in range(1, len(candles)):
        h = _f(candles[i].high)
        lo = _f(candles[i].low)
        pc = _f(candles[i - 1].close)
        trs.append(max(h - lo, abs(h - pc), abs(lo - pc)))
    if not trs:
        return 0.0
    tail = trs[-period:]
    return sum(tail) / len(tail)


def _avg_volume(candles: list[HistoricCandle], period: int = 20) -> float:
    vols = [c.volume for c in candles[-period:]]
    return sum(vols) / len(vols) if vols else 0.0


def detect_level_pattern(
    candles: list[HistoricCandle],
    direction: str,                 # "LONG" или "SHORT"
    atr_value: float = 0.0,
    proximity_atr: float = 2.5,    # насколько близко к уровню считается "у уровня"
    climax_vol_mult: float = 1.8,  # объём на climax-свече относительно среднего
    compress_bars: int = 3,        # минимум свечей компрессии после climax
    compress_atr_frac: float = 0.5, # размах компрессионных свечей < frac * ATR
    impulse_atr_frac: float = 0.6, # импульсная свеча > frac * ATR
    stop_buffer_atr: float = 0.4,  # буфер за уровень (защита от проколов)
    take_ratio: float = 1.75,      # тейк = ratio × stop-дистанция
    min_candles: int = 30,
) -> Optional[LevelEntry]:
    """
    Ищет паттерн «подход к уровню → climax → компрессия → импульс».
    Возвращает LevelEntry с уровневыми stop/take или None если паттерна нет.

    direction — ожидаемое направление сделки (LONG = отбой от лоя вверх,
                SHORT = отбой от хая вниз).
    """
    if len(candles) < min_candles:
        return None

    levels = prev_day_levels(candles)
    if levels is None:
        return None

    atr = atr_value if atr_value > 0 else _atr(candles)
    if atr <= 0:
        return None

    avg_vol = _avg_volume(candles, 20)
    if avg_vol <= 0:
        return None

    # Выбираем уровень в зависимости от направления
    if direction == "LONG":
        level = levels.low
        level_side = "low"
    else:
        level = levels.high
        level_side = "high"

    proximity = proximity_atr * atr

    # Ищем в последних candles[-40:] паттерн: climax → compress → impulse
    window = candles[-40:]
    n = len(window)

    # Сканируем назад: ищем climax-свечу у уровня
    climax_i = None
    for i in range(n - 1, max(0, n - 20), -1):
        c = window[i]
        price = _f(c.close)
        # Свеча у уровня?
        if abs(price - level) > proximity and abs(_f(c.low) - level) > proximity and abs(_f(c.high) - level) > proximity:
            continue
        # Объёмный всплеск?
        if c.volume >= climax_vol_mult * avg_vol:
            climax_i = i
            break

    if climax_i is None:
        return None

    # После climax нужна компрессия (следующие compress_bars свечей)
    compress_start = climax_i + 1
    compress_end = compress_start + compress_bars
    if compress_end > n:
        return None  # мало данных после climax

    compress_candles = window[compress_start:compress_end]
    compress_ranges = [_f(c.high) - _f(c.low) for c in compress_candles]
    avg_compress_range = sum(compress_ranges) / len(compress_ranges) if compress_ranges else 0
    if avg_compress_range >= compress_atr_frac * atr:
        return None  # нет компрессии

    # Последняя свеча — импульс в нужную сторону
    last = candles[-1]
    last_range = _f(last.high) - _f(last.low)
    last_close = _f(last.close)
    last_open = _f(last.open)

    if last_range < impulse_atr_frac * atr:
        return None  # нет импульса

    if direction == "LONG":
        # Бычья свеча (закрытие выше открытия)
        if last_close <= last_open:
            return None
        entry = last_close
        # Стоп за лой уровня с буфером на проколы
        stop = level - stop_buffer_atr * atr
        if stop >= entry:
            return None
        stop_dist = entry - stop
    else:
        # Медвежья свеча
        if last_close >= last_open:
            return None
        entry = last_close
        stop = level + stop_buffer_atr * atr
        if stop <= entry:
            return None
        stop_dist = stop - entry

    take_dist = stop_dist * take_ratio
    if direction == "LONG":
        take = entry + take_dist
    else:
        take = entry - take_dist

    stop_dist_pct = stop_dist / entry
    take_dist_pct = take_dist / entry

    # Проверка разумности: стоп не больше 3%, тейк не меньше 0.1%
    if stop_dist_pct > 0.03 or take_dist_pct < 0.001:
        return None

    return LevelEntry(
        entry=round(entry, 6),
        stop=round(stop, 6),
        take=round(take, 6),
        level=round(level, 6),
        level_side=level_side,
        stop_dist_pct=round(stop_dist_pct, 6),
        take_dist_pct=round(take_dist_pct, 6),
    )
