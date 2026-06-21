"""
level_pattern.py — детекция трёх разворотных паттернов на ключевых уровнях.

Паттерн 1 — LEVEL_REVERSAL («разворот у уровня»):
  Цена подходит к prev-day H/L → объёмный climax → компрессия → импульс обратно.
  Стоп: за уровень + буфер. Тейк: 1.75× stop-dist.

Паттерн 2 — FALSE_BREAKOUT («ложный пробой / пружина»):
  Цена пробивает уровень на высоком объёме, возвращается обратно,
  затем появляется «ступенька» — новый экстремум лучше предыдущего
  (для LONG: лой выше лоя пробоя). Стоп: за ступеньку. Тейк: 2× stop-dist.

Паттерн 3 — THREAD («нитка / накопление»):
  Цена идёт в узком диапазоне с нарастающим объёмом (крупный участник
  стоит лимитами). Входим ПРОТИВ объёма при появлении разворотной свечи.
  Стоп: за диапазон нитки. Тейк: 1.75× stop-dist.
"""
from __future__ import annotations
from dataclasses import dataclass
from typing import Optional

from tinkoff.invest import HistoricCandle


def _f(q) -> float:
    return q.units + q.nano / 1e9


@dataclass
class DayLevels:
    date: object
    high: float
    low: float


@dataclass
class LevelEntry:
    entry: float
    stop: float
    take: float
    level: float
    level_side: str
    stop_dist_pct: float
    take_dist_pct: float
    pattern: str            # "level_reversal" | "false_breakout" | "thread"


def prev_day_levels(candles: list[HistoricCandle]) -> Optional[DayLevels]:
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


def _make_entry(
    entry: float, stop: float, take_ratio: float, pattern: str,
    level: float, level_side: str,
) -> Optional[LevelEntry]:
    if entry <= 0 or stop <= 0:
        return None
    stop_dist = abs(entry - stop)
    if stop_dist <= 0:
        return None
    take_dist = stop_dist * take_ratio
    take = entry + take_dist if stop < entry else entry - take_dist
    stop_pct = stop_dist / entry
    take_pct = take_dist / entry
    if stop_pct > 0.04 or take_pct < 0.001:
        return None
    return LevelEntry(
        entry=round(entry, 6), stop=round(stop, 6), take=round(take, 6),
        level=round(level, 6), level_side=level_side,
        stop_dist_pct=round(stop_pct, 6), take_dist_pct=round(take_pct, 6),
        pattern=pattern,
    )


# ─────────────────────────────────────────────────────────────────────────────
# Паттерн 1: LEVEL_REVERSAL
# ─────────────────────────────────────────────────────────────────────────────

def detect_level_reversal(
    candles: list[HistoricCandle],
    direction: str,
    atr_value: float = 0.0,
    proximity_atr: float = 2.5,
    climax_vol_mult: float = 1.8,
    compress_bars: int = 3,
    compress_atr_frac: float = 0.5,
    impulse_atr_frac: float = 0.6,
    stop_buffer_atr: float = 0.4,
    take_ratio: float = 1.75,
    min_candles: int = 30,
) -> Optional[LevelEntry]:
    """Подход к уровню → объёмный climax → компрессия → импульс."""
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

    level = levels.low if direction == "LONG" else levels.high
    level_side = "low" if direction == "LONG" else "high"
    proximity = proximity_atr * atr
    window = candles[-40:]
    n = len(window)

    climax_i = None
    for i in range(n - 1, max(0, n - 20), -1):
        c = window[i]
        near = (abs(_f(c.close) - level) <= proximity or
                abs(_f(c.low) - level) <= proximity or
                abs(_f(c.high) - level) <= proximity)
        if near and c.volume >= climax_vol_mult * avg_vol:
            climax_i = i
            break
    if climax_i is None:
        return None

    compress_end = climax_i + 1 + compress_bars
    if compress_end > n:
        return None
    compress_candles = window[climax_i + 1:compress_end]
    avg_range = sum(_f(c.high) - _f(c.low) for c in compress_candles) / len(compress_candles)
    if avg_range >= compress_atr_frac * atr:
        return None

    last = candles[-1]
    if (_f(last.high) - _f(last.low)) < impulse_atr_frac * atr:
        return None

    entry = _f(last.close)
    if direction == "LONG":
        if _f(last.close) <= _f(last.open):
            return None
        stop = level - stop_buffer_atr * atr
    else:
        if _f(last.close) >= _f(last.open):
            return None
        stop = level + stop_buffer_atr * atr

    return _make_entry(entry, stop, take_ratio, "level_reversal", level, level_side)


# ─────────────────────────────────────────────────────────────────────────────
# Паттерн 2: FALSE_BREAKOUT («пружина»)
# ─────────────────────────────────────────────────────────────────────────────

def detect_false_breakout(
    candles: list[HistoricCandle],
    direction: str,
    atr_value: float = 0.0,
    breakout_vol_mult: float = 1.6,
    stop_buffer_atr: float = 0.35,
    take_ratio: float = 2.0,
    min_candles: int = 30,
    lookback: int = 30,
) -> Optional[LevelEntry]:
    """
    Ложный пробой уровня: пробой на объёме → возврат → ступенька (лучший экстремум).
    LONG: пробой prev-day-low вниз → возврат выше → новый лой выше пробойного.
    SHORT: пробой prev-day-high вверх → возврат ниже → новый хай ниже пробойного.
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

    level = levels.low if direction == "LONG" else levels.high
    level_side = "low" if direction == "LONG" else "high"
    window = candles[-lookback:]
    n = len(window)

    # Ищем свечу-пробой
    breakout_i = None
    breakout_extreme = None  # лой пробоя (LONG) или хай пробоя (SHORT)
    for i in range(n - 1, max(0, n - 20), -1):
        c = window[i]
        vol_ok = c.volume >= breakout_vol_mult * avg_vol
        if direction == "LONG":
            if _f(c.low) < level and vol_ok:
                breakout_i = i
                breakout_extreme = _f(c.low)
                break
        else:
            if _f(c.high) > level and vol_ok:
                breakout_i = i
                breakout_extreme = _f(c.high)
                break
    if breakout_i is None:
        return None

    # После пробоя цена должна вернуться за уровень
    returned = False
    for i in range(breakout_i + 1, n):
        c = window[i]
        if direction == "LONG" and _f(c.close) > level:
            returned = True
            break
        if direction == "SHORT" and _f(c.close) < level:
            returned = True
            break
    if not returned:
        return None

    # Ступенька: новый экстремум лучше предыдущего (лой выше / хай ниже)
    last = candles[-1]
    entry = _f(last.close)
    if direction == "LONG":
        step_low = min(_f(c.low) for c in window[breakout_i + 1:])
        if step_low <= breakout_extreme:
            return None  # нет ступеньки — просто ещё один лой
        if _f(last.close) <= _f(last.open):
            return None  # ждём бычью свечу
        stop = step_low - stop_buffer_atr * atr
    else:
        step_high = max(_f(c.high) for c in window[breakout_i + 1:])
        if step_high >= breakout_extreme:
            return None
        if _f(last.close) >= _f(last.open):
            return None
        stop = step_high + stop_buffer_atr * atr

    return _make_entry(entry, stop, take_ratio, "false_breakout", level, level_side)


# ─────────────────────────────────────────────────────────────────────────────
# Паттерн 3: THREAD («нитка» — узкий диапазон + объём)
# ─────────────────────────────────────────────────────────────────────────────

def detect_thread(
    candles: list[HistoricCandle],
    direction: str,
    atr_value: float = 0.0,
    thread_bars: int = 5,
    thread_range_frac: float = 0.35,   # диапазон нитки < frac * ATR
    thread_vol_mult: float = 1.5,      # объём в нитке выше среднего
    stop_buffer_atr: float = 0.4,
    take_ratio: float = 1.75,
    min_candles: int = 30,
) -> Optional[LevelEntry]:
    """
    Нитка: цена в узком диапазоне с повышенным объёмом → крупный участник
    стоит лимитами. Входим против объёма при разворотной свече.
    """
    if len(candles) < min_candles:
        return None
    atr = atr_value if atr_value > 0 else _atr(candles)
    if atr <= 0:
        return None
    avg_vol = _avg_volume(candles, 20)
    if avg_vol <= 0:
        return None

    # Нитка: последние thread_bars свечей (не считая последней — она разворотная)
    if len(candles) < thread_bars + 2:
        return None
    thread = candles[-(thread_bars + 1):-1]

    thread_high = max(_f(c.high) for c in thread)
    thread_low = min(_f(c.low) for c in thread)
    thread_range = thread_high - thread_low
    if thread_range >= thread_range_frac * atr:
        return None  # не нитка — слишком широкий диапазон

    avg_thread_vol = sum(c.volume for c in thread) / len(thread)
    if avg_thread_vol < thread_vol_mult * avg_vol:
        return None  # мало объёма

    # Разворотная свеча (последняя) — выходит из диапазона нитки
    last = candles[-1]
    entry = _f(last.close)
    if direction == "LONG":
        # Цена выходила вниз (продавали), теперь разворот вверх
        if _f(last.close) <= _f(last.open):
            return None
        if _f(last.close) <= thread_low:
            return None
        stop = thread_low - stop_buffer_atr * atr
        # Уровень — низ нитки (там стоял крупный продавец / покупатель)
        level = thread_low
        level_side = "thread_low"
    else:
        if _f(last.close) >= _f(last.open):
            return None
        if _f(last.close) >= thread_high:
            return None
        stop = thread_high + stop_buffer_atr * atr
        level = thread_high
        level_side = "thread_high"

    return _make_entry(entry, stop, take_ratio, "thread", level, level_side)


# ─────────────────────────────────────────────────────────────────────────────
# Публичный API — пробуем все три паттерна по приоритету
# ─────────────────────────────────────────────────────────────────────────────

def detect_level_pattern(
    candles: list[HistoricCandle],
    direction: str,
    atr_value: float = 0.0,
    **kwargs,
) -> Optional[LevelEntry]:
    """
    Пробует FALSE_BREAKOUT → LEVEL_REVERSAL → THREAD (в порядке убывания надёжности).
    Возвращает первый найденный паттерн или None.
    """
    result = detect_false_breakout(candles, direction, atr_value=atr_value)
    if result:
        return result
    result = detect_level_reversal(candles, direction, atr_value=atr_value)
    if result:
        return result
    return detect_thread(candles, direction, atr_value=atr_value)
