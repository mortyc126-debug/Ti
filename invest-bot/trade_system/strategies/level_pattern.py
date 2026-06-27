"""
level_pattern.py — детекция разворотных паттернов на иерархических уровнях.

Уровни (tier = приоритет, 1 = сильнейший):
  tier 1 — недельные H/L, месячные H/L
  tier 2 — дневные H/L/Open/Close (предыдущий день, сегодня до текущего бара)
  tier 3 — Fibonacci (0.236 / 0.382 / 0.5 / 0.618 / 0.786) по свингу последних N баров
  tier 4 — круглые числа (психологические уровни)
  tier 5 — фракталы Уильямса (локальные экстремумы ≥ 2 бара в каждую сторону)

Паттерн 1 — LEVEL_REVERSAL: подход к уровню → climax → компрессия → импульс.
Паттерн 2 — FALSE_BREAKOUT: пробой уровня на объёме → возврат → ступенька.
Паттерн 3 — THREAD: узкий диапазон с объёмом → разворотная свеча.

При нахождении паттерна стоп/тейк ставятся ОТНОСИТЕЛЬНО ближайшего уровня,
а не фиксированных %, т.е. размер стопа определяется структурой рынка.
"""
from __future__ import annotations
import math
import statistics
from dataclasses import dataclass, field
from typing import Optional

from tinkoff.invest import HistoricCandle


def _f(q) -> float:
    return q.units + q.nano / 1e9


# ─────────────────────────────────────────────────────────────────────────────
# Структуры данных
# ─────────────────────────────────────────────────────────────────────────────

@dataclass
class PriceLevel:
    price: float
    kind: str    # week_high, week_low, day_high, day_low, day_open, day_close,
                 # today_high, today_low, fib_236/382/500/618/786,
                 # round, fractal_high, fractal_low
    tier: int    # 1..5, меньше = сильнее
    polarity: str = "neutral"   # "support" | "resistance" | "neutral"
    touch_count: int = 0        # сколько свечей касались зоны уровня
    flipped: bool = False       # True = S/R flip: бывшая поддержка→сопротивление или наоборот


@dataclass
class LevelSet:
    levels: list[PriceLevel] = field(default_factory=list)

    def nearest(self, price: float, max_dist: float) -> Optional[PriceLevel]:
        """Ближайший уровень в пределах max_dist, с приоритетом по tier."""
        candidates = [lv for lv in self.levels if abs(lv.price - price) <= max_dist]
        if not candidates:
            return None
        return min(candidates, key=lambda lv: (lv.tier, abs(lv.price - price)))

    def within(self, price: float, max_dist: float) -> list[PriceLevel]:
        return sorted(
            [lv for lv in self.levels if abs(lv.price - price) <= max_dist],
            key=lambda lv: (lv.tier, abs(lv.price - price))
        )


@dataclass
class LevelEntry:
    entry: float
    stop: float
    take: float
    level: float
    level_kind: str
    level_tier: int
    stop_dist_pct: float
    take_dist_pct: float
    pattern: str   # "level_reversal" | "false_breakout" | "thread"


# ─────────────────────────────────────────────────────────────────────────────
# Построение иерархических уровней
# ─────────────────────────────────────────────────────────────────────────────

def _atr(candles: list, period: int = 14) -> float:
    trs = []
    for i in range(1, len(candles)):
        h, lo, pc = _f(candles[i].high), _f(candles[i].low), _f(candles[i - 1].close)
        trs.append(max(h - lo, abs(h - pc), abs(lo - pc)))
    if not trs:
        return 0.0
    return sum(trs[-period:]) / min(len(trs), period)


def _avg_volume(candles: list, period: int = 20) -> float:
    vols = [c.volume for c in candles[-period:]]
    return sum(vols) / len(vols) if vols else 0.0


def _round_step(price: float) -> float:
    """Шаг круглых чисел: 0.01% от цены, округлённый до красивого числа."""
    mag = 10 ** math.floor(math.log10(price))
    raw = price * 0.005  # примерно 0.5% — типичный диапазон психологического уровня
    # округляем шаг до ближайшего из [1, 2, 5, 10, 20, 50, 100, 200, 500] × mag
    for mult in [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100]:
        step = mult * mag
        if step >= raw:
            return step
    return mag


def _fibonacci_levels(swing_high: float, swing_low: float) -> list[tuple[float, str]]:
    """Fib retracements от swing_low до swing_high и наоборот."""
    diff = swing_high - swing_low
    ratios = [("fib_236", 0.236), ("fib_382", 0.382), ("fib_500", 0.500),
              ("fib_618", 0.618), ("fib_786", 0.786)]
    result = []
    for name, r in ratios:
        result.append((swing_high - diff * r, name))   # pullback от high
        result.append((swing_low  + diff * r, name))   # rally от low
    return result


def _williams_fractals(candles: list, n: int = 2) -> tuple[list[float], list[float]]:
    """Фракталы Уильямса: локальный max/min с n барами в каждую сторону."""
    highs_f, lows_f = [], []
    for i in range(n, len(candles) - n):
        h = _f(candles[i].high)
        lo = _f(candles[i].low)
        if all(_f(candles[i - j].high) < h and _f(candles[i + j].high) < h for j in range(1, n + 1)):
            highs_f.append(h)
        if all(_f(candles[i - j].low) > lo and _f(candles[i + j].low) > lo for j in range(1, n + 1)):
            lows_f.append(lo)
    return highs_f, lows_f


def build_levels(candles: list) -> LevelSet:
    """
    Строит иерархический набор уровней из свечей.
    Ожидает минутные свечи (но работает с любым TF).
    Для расчёта недельных/дневных уровней группирует по дате.
    """
    if not candles:
        return LevelSet()

    levels: list[PriceLevel] = []
    today = candles[-1].time.date()

    # Группируем свечи по торговым дням
    by_day: dict = {}
    for c in candles:
        d = c.time.date()
        h, lo, cl, op = _f(c.high), _f(c.low), _f(c.close), _f(c.open)
        if d not in by_day:
            by_day[d] = {"h": h, "l": lo, "o": op, "c": cl}
        else:
            if h > by_day[d]["h"]: by_day[d]["h"] = h
            if lo < by_day[d]["l"]: by_day[d]["l"] = lo
            by_day[d]["c"] = cl  # close = последнее закрытие дня

    sorted_days = sorted(by_day.keys())
    past_days = [d for d in sorted_days if d < today]

    # ── tier 1: недельные и месячные H/L ──
    week_days  = past_days[-5:]  if len(past_days) >= 5  else past_days
    month_days = past_days[-22:] if len(past_days) >= 22 else past_days
    year_days  = past_days[-252:] if len(past_days) >= 252 else past_days

    if week_days:
        wh = max(by_day[d]["h"] for d in week_days)
        wl = min(by_day[d]["l"] for d in week_days)
        levels.append(PriceLevel(wh, "week_high", 1))
        levels.append(PriceLevel(wl, "week_low",  1))

    if month_days and len(month_days) > len(week_days):
        mh = max(by_day[d]["h"] for d in month_days)
        ml = min(by_day[d]["l"] for d in month_days)
        levels.append(PriceLevel(mh, "month_high", 1))
        levels.append(PriceLevel(ml, "month_low",  1))

    # 52W high/low — sweep таких уровней один из самых надёжных сигналов
    if len(year_days) > len(month_days):
        yh = max(by_day[d]["h"] for d in year_days)
        yl = min(by_day[d]["l"] for d in year_days)
        levels.append(PriceLevel(yh, "year_high", 1))
        levels.append(PriceLevel(yl, "year_low",  1))

    # Weekly Open: открытие текущей торговой недели (ICT — институционалы
    # измеряют PnL от Weekly Open → их хеджирование создаёт реакцию)
    import datetime as _dt
    current_weekday = today.weekday()  # 0=пн, 4=пт
    week_start = today - _dt.timedelta(days=current_weekday)
    week_open_day = next((d for d in sorted_days if d >= week_start), None)
    if week_open_day and week_open_day in by_day:
        levels.append(PriceLevel(by_day[week_open_day]["o"], "weekly_open", 1))

    # Significant High/Low: экстремум при объёме ≥ 2× среднего = там были
    # крупные продавцы/покупатели, они стоят снова. Tier 1.
    avg_vol_all = _avg_volume(candles, 40)
    if avg_vol_all > 0:
        # Ищем в последних 60 торговых днях дни с аномальным объёмом
        sig_window_days = past_days[-60:] if len(past_days) >= 60 else past_days
        for d in sig_window_days:
            day_candles = [c for c in candles if c.time.date() == d]
            if not day_candles:
                continue
            day_vol = sum(float(c.volume) for c in day_candles)
            if day_vol >= 2.0 * avg_vol_all * len(day_candles):
                # Значимый день — его H/L это Significant High/Low
                dh = max(_f(c.high) for c in day_candles)
                dl = min(_f(c.low)  for c in day_candles)
                levels.append(PriceLevel(dh, "sig_high", 1))
                levels.append(PriceLevel(dl, "sig_low",  1))

    # ── tier 2: вчерашние H/L/O/C + сегодняшние H/L до текущего бара ──
    if past_days:
        prev = past_days[-1]
        pd = by_day[prev]
        levels.append(PriceLevel(pd["h"], "day_high",  2))
        levels.append(PriceLevel(pd["l"], "day_low",   2))
        levels.append(PriceLevel(pd["o"], "day_open",  2))
        levels.append(PriceLevel(pd["c"], "day_close", 2))

        # Overnight Gap: открытие сегодня vs закрытие вчера — граница гэпа
        # это FVG на дневном уровне, там обрывается объём.
        today_candles = [c for c in candles if c.time.date() == today]
        if today_candles:
            today_open = _f(today_candles[0].open)
            prev_close = pd["c"]
            gap_pct = abs(today_open - prev_close) / prev_close if prev_close > 0 else 0.0
            if gap_pct >= 0.003:  # гэп ≥ 0.3%
                levels.append(PriceLevel(today_open,  "gap_open",  2))
                levels.append(PriceLevel(prev_close,  "gap_close", 2))

    # Сегодняшние экстремумы (до текущего бара) — важны внутри дня
    today_candles = [c for c in candles if c.time.date() == today]  # может быть определён выше, не критично
    if len(today_candles) > 1:
        th = max(_f(c.high) for c in today_candles[:-1])
        tl = min(_f(c.low)  for c in today_candles[:-1])
        levels.append(PriceLevel(th, "today_high", 2))
        levels.append(PriceLevel(tl, "today_low",  2))

    # ── tier 3: Fibonacci по свингу последних ~60 баров ──
    swing_window = candles[-60:] if len(candles) >= 60 else candles
    if len(swing_window) >= 10:
        sh = max(_f(c.high) for c in swing_window)
        sl = min(_f(c.low)  for c in swing_window)
        if sh > sl:
            for price, name in _fibonacci_levels(sh, sl):
                if sl <= price <= sh:
                    levels.append(PriceLevel(round(price, 6), name, 3))

    # ── tier 4: круглые числа ──
    if candles:
        mid = _f(candles[-1].close)
        step = _round_step(mid)
        # ±10 ступеней вокруг текущей цены
        base = round(mid / step) * step
        for i in range(-10, 11):
            levels.append(PriceLevel(round(base + i * step, 8), "round", 4))

    # ── tier 5: фракталы Уильямса (последние 80 баров) ──
    frac_window = candles[-80:] if len(candles) >= 80 else candles
    frac_highs, frac_lows = _williams_fractals(frac_window, n=2)
    for h in frac_highs[-5:]:  # только 5 последних фракталов
        levels.append(PriceLevel(h, "fractal_high", 5))
    for l in frac_lows[-5:]:
        levels.append(PriceLevel(l, "fractal_low", 5))

    # Убираем дубли: уровни ближе 0.2 ATR — оставляем с меньшим tier.
    # ATR-based вместо фиксированного %: корректно работает на любой цене инструмента.
    atr_val = _atr(candles)
    atr_tol = atr_val * 0.2 if candles else 0.0
    min_tol = (_f(candles[-1].close) if candles else 1.0) * 0.0001
    tol = max(atr_tol, min_tol)
    deduped: list[PriceLevel] = []
    for lv in sorted(levels, key=lambda x: (x.tier, x.price)):
        if not any(abs(lv.price - ex.price) < tol for ex in deduped):
            deduped.append(lv)

    _enrich_levels_sr(deduped, candles, atr_val)
    return LevelSet(deduped)


# Параметры S/R enrichment
_SR_TOUCH_ZONE_ATR   = 0.4   # свеча касается уровня если диапазон перекрывает p ± zone
_SR_BREAK_CONFIRM_ATR = 0.5  # закрытие дальше этого = подтверждённый пробой
_SR_BREAK_MIN_BARS   = 2     # минимум подтверждающих закрытий за уровнем


def _enrich_levels_sr(levels: list[PriceLevel], candles: list, atr: float) -> None:
    """
    Проставляет каждому уровню polarity / touch_count / flipped.

    Полярность — не свойство уровня самого по себе, а отношение уровня
    к текущей позиции цены:
      • price выше уровня → уровень поддержка
      • price ниже уровня → уровень сопротивление
      • S/R flip: цена подтверждённо пробила уровень и держится по другую
        сторону — уровень меняет роль, flipped=True (такие уровни особенно
        сильны как зоны реакции при ретесте).

    Уровни не удаляем — tier-1/2 структурные точки актуальны пока не пробиты,
    независимо от давности. Caller (build_levels) уже выполнил дедупликацию.
    """
    if not candles or atr <= 0:
        for lv in levels:
            lv.polarity = "neutral"
        return

    highs  = [_f(c.high)  for c in candles]
    lows   = [_f(c.low)   for c in candles]
    closes = [_f(c.close) for c in candles]
    cur    = closes[-1]

    touch_zone    = atr * _SR_TOUCH_ZONE_ATR
    break_confirm = atr * _SR_BREAK_CONFIRM_ATR

    for lv in levels:
        p = lv.price

        # ── касания: диапазон свечи перекрывает [p-zone, p+zone] ─────────────
        lv.touch_count = sum(
            1 for i in range(len(candles))
            if lows[i] <= p + touch_zone and highs[i] >= p - touch_zone
        )

        # ── проверяем последние бары на подтверждённый пробой ────────────────
        # Идём с конца, считаем последовательные закрытия с одной стороны.
        consec_above = 0
        for cl in reversed(closes[-10:]):
            if cl > p + break_confirm:
                consec_above += 1
            else:
                break

        consec_below = 0
        for cl in reversed(closes[-10:]):
            if cl < p - break_confirm:
                consec_below += 1
            else:
                break

        broken_up   = consec_above >= _SR_BREAK_MIN_BARS
        broken_down = consec_below >= _SR_BREAK_MIN_BARS

        # ── полярность ────────────────────────────────────────────────────────
        if broken_up:
            # Цена пробила вверх и держится — уровень теперь поддержка.
            # flipped=True если до этого цена была ниже (классический S/R flip).
            lv.polarity = "support"
            lv.flipped = cur > p  # True = цена сейчас выше (пробой вверх подтверждён)
        elif broken_down:
            # Цена пробила вниз — уровень теперь сопротивление.
            lv.polarity = "resistance"
            lv.flipped = cur < p
        elif cur > p:
            lv.polarity = "support"
            lv.flipped = False
        elif cur < p:
            lv.polarity = "resistance"
            lv.flipped = False
        else:
            lv.polarity = "neutral"
            lv.flipped = False


# ─────────────────────────────────────────────────────────────────────────────
# Вспомогательные функции
# ─────────────────────────────────────────────────────────────────────────────

def _make_entry(
    entry: float, stop: float, take_ratio: float, pattern: str,
    level: PriceLevel,
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
    if stop_pct > 0.02 or take_pct < 0.001:
        return None
    return LevelEntry(
        entry=round(entry, 6), stop=round(stop, 6), take=round(take, 6),
        level=round(level.price, 6), level_kind=level.kind, level_tier=level.tier,
        stop_dist_pct=round(stop_pct, 6), take_dist_pct=round(take_pct, 6),
        pattern=pattern,
    )


# ─────────────────────────────────────────────────────────────────────────────
# Паттерн 1: LEVEL_REVERSAL
# ─────────────────────────────────────────────────────────────────────────────

def detect_level_reversal(
    candles: list,
    direction: str,
    atr_value: float = 0.0,
    level_set: Optional[LevelSet] = None,
    proximity_atr: float = 2.0,
    climax_vol_mult: float = 1.8,
    compress_bars: int = 3,
    compress_atr_frac: float = 0.5,
    impulse_atr_frac: float = 0.6,
    stop_buffer_atr: float = 0.4,
    take_ratio: float = 1.75,
    min_candles: int = 30,
) -> Optional[LevelEntry]:
    """Подход к уровню → объёмный climax → компрессия → импульс обратно."""
    if len(candles) < min_candles:
        return None
    atr = atr_value if atr_value > 0 else _atr(candles)
    if atr <= 0:
        return None
    avg_vol = _avg_volume(candles, 20)
    if avg_vol <= 0:
        return None

    ls = level_set or build_levels(candles)
    proximity = proximity_atr * atr

    last = candles[-1]
    entry = _f(last.close)

    # Ищем ближайший уровень с правильной стороны
    # LONG: ищем уровень поддержки (ниже или у текущей цены)
    # SHORT: ищем уровень сопротивления (выше или у текущей цены)
    candidates = ls.within(entry, proximity)
    if direction == "LONG":
        candidates = [lv for lv in candidates if lv.price <= entry + atr]
    else:
        candidates = [lv for lv in candidates if lv.price >= entry - atr]

    if not candidates:
        return None
    level = candidates[0]

    window = candles[-40:]
    n = len(window)

    climax_i = None
    for i in range(n - 1, max(0, n - 20), -1):
        c = window[i]
        near = abs(_f(c.close) - level.price) <= proximity
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

    if (_f(last.high) - _f(last.low)) < impulse_atr_frac * atr:
        return None

    if direction == "LONG":
        if _f(last.close) <= _f(last.open):
            return None
        stop = level.price - stop_buffer_atr * atr
    else:
        if _f(last.close) >= _f(last.open):
            return None
        stop = level.price + stop_buffer_atr * atr

    return _make_entry(entry, stop, take_ratio, "level_reversal", level)


# ─────────────────────────────────────────────────────────────────────────────
# Паттерн 2: FALSE_BREAKOUT
# ─────────────────────────────────────────────────────────────────────────────

def detect_false_breakout(
    candles: list,
    direction: str,
    atr_value: float = 0.0,
    level_set: Optional[LevelSet] = None,
    breakout_vol_mult: float = 1.6,
    stop_buffer_atr: float = 0.35,
    take_ratio: float = 2.0,
    min_candles: int = 30,
    lookback: int = 30,
) -> Optional[LevelEntry]:
    """Ложный пробой: пробой уровня на объёме → возврат → ступенька."""
    if len(candles) < min_candles:
        return None
    atr = atr_value if atr_value > 0 else _atr(candles)
    if atr <= 0:
        return None
    avg_vol = _avg_volume(candles, 20)
    if avg_vol <= 0:
        return None

    ls = level_set or build_levels(candles)
    window = candles[-lookback:]
    n = len(window)

    # Ищем пробой любого уровня на высоком объёме
    breakout_i = None
    breakout_extreme = None
    hit_level: Optional[PriceLevel] = None

    for i in range(n - 1, max(0, n - 20), -1):
        c = window[i]
        if c.volume < breakout_vol_mult * avg_vol:
            continue
        if direction == "LONG":
            # Пробой вниз: low пробил какой-то уровень
            lv = ls.nearest(_f(c.low), atr * 1.5)
            if lv and _f(c.low) < lv.price:
                breakout_i = i
                breakout_extreme = _f(c.low)
                hit_level = lv
                break
        else:
            lv = ls.nearest(_f(c.high), atr * 1.5)
            if lv and _f(c.high) > lv.price:
                breakout_i = i
                breakout_extreme = _f(c.high)
                hit_level = lv
                break

    if breakout_i is None or hit_level is None:
        return None

    # Цена вернулась за уровень
    returned = False
    for i in range(breakout_i + 1, n):
        c = window[i]
        if direction == "LONG" and _f(c.close) > hit_level.price:
            returned = True
            break
        if direction == "SHORT" and _f(c.close) < hit_level.price:
            returned = True
            break
    if not returned:
        return None

    last = candles[-1]
    entry = _f(last.close)

    if direction == "LONG":
        step_low = min(_f(c.low) for c in window[breakout_i + 1:])
        if step_low <= breakout_extreme:
            return None
        if _f(last.close) <= _f(last.open):
            return None
        stop = step_low - stop_buffer_atr * atr
    else:
        step_high = max(_f(c.high) for c in window[breakout_i + 1:])
        if step_high >= breakout_extreme:
            return None
        if _f(last.close) >= _f(last.open):
            return None
        stop = step_high + stop_buffer_atr * atr

    return _make_entry(entry, stop, take_ratio, "false_breakout", hit_level)


# ─────────────────────────────────────────────────────────────────────────────
# Паттерн 3: THREAD
# ─────────────────────────────────────────────────────────────────────────────

def detect_thread(
    candles: list,
    direction: str,
    atr_value: float = 0.0,
    level_set: Optional[LevelSet] = None,
    thread_bars: int = 5,
    thread_range_frac: float = 0.35,
    thread_vol_mult: float = 1.5,
    stop_buffer_atr: float = 0.4,
    take_ratio: float = 1.75,
    min_candles: int = 30,
) -> Optional[LevelEntry]:
    """Нитка: узкий диапазон с объёмом → разворотная свеча."""
    if len(candles) < min_candles:
        return None
    atr = atr_value if atr_value > 0 else _atr(candles)
    if atr <= 0:
        return None
    avg_vol = _avg_volume(candles, 20)
    if avg_vol <= 0:
        return None
    if len(candles) < thread_bars + 2:
        return None

    thread = candles[-(thread_bars + 1):-1]
    thread_high = max(_f(c.high) for c in thread)
    thread_low  = min(_f(c.low)  for c in thread)
    thread_range = thread_high - thread_low
    if thread_range >= thread_range_frac * atr:
        return None

    avg_thread_vol = sum(c.volume for c in thread) / len(thread)
    if avg_thread_vol < thread_vol_mult * avg_vol:
        return None

    last = candles[-1]
    entry = _f(last.close)

    ls = level_set or build_levels(candles)
    # Стоп за диапазон нитки; если рядом есть более сильный уровень — берём его
    if direction == "LONG":
        if _f(last.close) <= _f(last.open) or _f(last.close) <= thread_low:
            return None
        natural_stop = thread_low - stop_buffer_atr * atr
        lv_near = ls.nearest(thread_low, atr)
        level = lv_near if (lv_near and lv_near.tier <= 3) else PriceLevel(thread_low, "thread_low", 5)
        stop = min(natural_stop, level.price - stop_buffer_atr * atr)
    else:
        if _f(last.close) >= _f(last.open) or _f(last.close) >= thread_high:
            return None
        natural_stop = thread_high + stop_buffer_atr * atr
        lv_near = ls.nearest(thread_high, atr)
        level = lv_near if (lv_near and lv_near.tier <= 3) else PriceLevel(thread_high, "thread_high", 5)
        stop = max(natural_stop, level.price + stop_buffer_atr * atr)

    return _make_entry(entry, stop, take_ratio, "thread", level)


# ─────────────────────────────────────────────────────────────────────────────
# Публичный API
# ─────────────────────────────────────────────────────────────────────────────

def detect_level_pattern(
    candles: list,
    direction: str,
    atr_value: float = 0.0,
    tier_max: int = 2,
    **kwargs,
) -> Optional[LevelEntry]:
    """
    Строит иерархические уровни один раз, пробует три паттерна:
    FALSE_BREAKOUT → LEVEL_REVERSAL → THREAD.
    tier_max=2 — используем только дневные и ниже (без недельных/месячных),
    чтобы стопы оставались в разумном диапазоне для внутридневки.
    Возвращает первый найденный или None.
    """
    ls = build_levels(candles)
    # Исключаем tier < min_tier (недельные/месячные tier=1 дают стопы 3-4% — слишком широко)
    ls_filtered = LevelSet(levels=[lv for lv in ls.levels if lv.tier >= tier_max])
    result = detect_false_breakout(candles, direction, atr_value=atr_value, level_set=ls_filtered)
    if result:
        return result
    result = detect_level_reversal(candles, direction, atr_value=atr_value, level_set=ls_filtered)
    if result:
        return result
    return detect_thread(candles, direction, atr_value=atr_value, level_set=ls_filtered)


# ─────────────────────────────────────────────────────────────────────────────
# Многогоризонтный кеш уровней (per-ticker)
# ─────────────────────────────────────────────────────────────────────────────

from datetime import datetime, timedelta, timezone


# Горизонты: (название, целевой охват в торговых днях, ttl обновления в часах)
_MTF_HORIZONS: list[tuple[str, int, float]] = [
    ("week",    5,   4.0),   # 1 неделя, обновляем каждые 4 ч
    ("month",  22,  24.0),   # 1 месяц,  обновляем раз в сутки
    ("half",  126, 168.0),   # ~полгода, обновляем раз в неделю
]


@dataclass
class _HorizonLevels:
    level_set: LevelSet
    built_at: datetime
    ttl_hours: float

    def is_stale(self, now: datetime) -> bool:
        age = (now - self.built_at).total_seconds() / 3600.0
        return age >= self.ttl_hours


class MultiTFLevelCache:
    """
    Хранит LevelSet для трёх горизонтов (неделя / месяц / полгода) per-ticker.
    Вызывается с полным буфером свечей; пересчитывает каждый горизонт только
    когда истёк TTL — не на каждом баре.

    Уровни горизонта строятся по последним target_days торговым дням буфера.
    Если буфера не хватает — берём что есть.
    """

    def __init__(self) -> None:
        self._horizons: dict[str, _HorizonLevels] = {}

    def update(self, candles: list, now: Optional[datetime] = None) -> None:
        """Перестроить горизонты у которых истёк TTL."""
        if not candles:
            return
        if now is None:
            raw = candles[-1].time
            now = raw if raw.tzinfo else raw.replace(tzinfo=timezone.utc)

        # группируем свечи по торговым дням
        by_day: dict = {}
        for c in candles:
            d = c.time.date()
            if d not in by_day:
                by_day[d] = []
            by_day[d].append(c)
        sorted_days = sorted(by_day.keys())

        for name, target_days, ttl_h in _MTF_HORIZONS:
            hl = self._horizons.get(name)
            if hl is not None and not hl.is_stale(now):
                continue  # ещё свежий

            # берём последние target_days дней (или меньше если нет истории)
            use_days = sorted_days[-target_days:] if len(sorted_days) >= target_days else sorted_days
            horizon_candles = [c for d in use_days for c in by_day[d]]
            if not horizon_candles:
                continue

            ls = build_levels(horizon_candles)
            self._horizons[name] = _HorizonLevels(
                level_set=ls, built_at=now, ttl_hours=ttl_h
            )

    def all_levels(self) -> list[tuple[str, LevelSet]]:
        """Список (horizon_name, LevelSet) для всех построенных горизонтов."""
        return [(name, hl.level_set) for name, hl in self._horizons.items()]

    def nearest_across_horizons(
        self, price: float, max_dist: float
    ) -> list[tuple[str, PriceLevel]]:
        """
        Уровни из всех горизонтов в пределах max_dist.
        Возвращает [(horizon_name, PriceLevel)] отсортированные по (tier, dist).
        """
        result: list[tuple[str, PriceLevel]] = []
        seen_prices: list[float] = []
        for name, ls in self.all_levels():
            for lv in ls.within(price, max_dist):
                # дедупликация: уровни из разных горизонтов ближе 0.05% — оставляем tier-лучший
                dup = any(abs(lv.price - p) / (p or 1) < 0.0005 for p in seen_prices)
                if not dup:
                    result.append((name, lv))
                    seen_prices.append(lv.price)
        result.sort(key=lambda x: (x[1].tier, abs(x[1].price - price)))
        return result


# ─────────────────────────────────────────────────────────────────────────────
# Гейт входа: уровень + объём
# ─────────────────────────────────────────────────────────────────────────────

# Параметры близости к уровню
_LVG_PROXIMITY_ATR   = 1.0   # цена должна быть в пределах N×ATR от уровня
_LVG_TOUCH_ZONE_ATR  = 0.35  # зона касания при поиске исторических реакций

# Параметры силы уровня
_LVG_REACTION_BARS   = 25    # смотрим на N баров после касания
_LVG_MIN_REACTION    = 0.004 # минимальный отскок ≥ 0.4% чтобы считать реакцией
_LVG_MIN_STRENGTH    = 0.30  # минимальный strength_score для прохождения гейта

# Параметры объёма
_LVG_VOL_SPIKE_X     = 1.5   # текущий бар: объём ≥ 1.5× медианы — спайк
_LVG_VOL_ACCUM_BARS  = 6     # окно накопления (баров у уровня)
_LVG_VOL_ACCUM_X     = 1.3   # среднее по окну ≥ 1.3× медианы — накопление
_LVG_VOL_MEDIAN_WIN  = 40    # окно для медианы объёма


@dataclass
class LevelGateResult:
    passed: bool
    level: Optional[PriceLevel] = None
    strength: float = 0.0          # [0, 1]: сила уровня по истории реакций
    vol_ok: bool = False            # объём прошёл (спайк или накопление)
    vol_spike: bool = False         # именно спайк на текущем баре
    vol_accum: bool = False         # именно накопление за последние N баров
    dist_atr: float = 0.0          # расстояние до уровня в ATR
    reason: str = ""


def _level_strength(
    level: PriceLevel,
    candles: list,
    atr: float,
) -> float:
    """Сила уровня по истории реакций: ищет касания зоны в candles и меряет
    max ход противоположного направления за _LVG_REACTION_BARS баров.

    strength = (доля касаний с реакцией) × tanh(avg_bounce / MIN_REACTION × 0.8)
    Возвращает [0, 1].
    """
    if atr <= 0 or not candles:
        return 0.0

    touch_zone = atr * _LVG_TOUCH_ZONE_ATR
    p = level.price
    is_support = level.polarity in ("support", "neutral")

    bounces: list[float] = []
    n = len(candles)

    i = 0
    while i < n - 2:
        hi, lo = _f(candles[i].high), _f(candles[i].low)
        if lo <= p + touch_zone and hi >= p - touch_zone:
            # касание — ищем отскок в следующих REACTION_BARS барах
            end = min(i + _LVG_REACTION_BARS, n)
            if is_support:
                # поддержка — ищем ход вверх
                touch_low = _f(candles[i].low)
                peak = max(_f(c.high) for c in candles[i + 1:end]) if i + 1 < end else touch_low
                bounce = (peak - touch_low) / touch_low if touch_low > 0 else 0.0
            else:
                # сопротивление — ищем ход вниз
                touch_high = _f(candles[i].high)
                trough = min(_f(c.low) for c in candles[i + 1:end]) if i + 1 < end else touch_high
                bounce = (touch_high - trough) / touch_high if touch_high > 0 else 0.0
            bounces.append(bounce)
            i += max(1, _LVG_REACTION_BARS // 2)  # не накладываем окна друг на друга
        else:
            i += 1

    if not bounces:
        # нет истории касаний — даём минимальное ненулевое доверие tier 1
        return 0.20 if level.tier == 1 else 0.10

    good = [b for b in bounces if b >= _LVG_MIN_REACTION]
    consistency = len(good) / len(bounces)
    avg_bounce = statistics.mean(good) if good else 0.0
    # tanh нормирует avg_bounce: при avg=MIN_REACTION → ~0.62, при 2× → ~0.96
    magnitude = math.tanh(avg_bounce / _LVG_MIN_REACTION * 0.8) if avg_bounce > 0 else 0.0
    return round(consistency * magnitude, 3)


def level_volume_gate(
    candles: list,
    l1_buffer: list,
    atr: float,
    tier_max: int = 2,
) -> LevelGateResult:
    """Главный гейт входа: цена у tier 1-2 уровня с исторической силой реакций
    + подтверждение объёмом (спайк или накопление).

    candles  — короткое окно (~30 баров) для текущей цены и объёма
    l1_buffer — длинная история (200-500 баров) для подсчёта реакций уровня
    atr      — текущий ATR в абсолютных единицах цены
    tier_max — максимальный tier (1 = только неделя/месяц, 2 = + дневные)

    Возвращает LevelGateResult. passed=True если:
      1. Ближайший tier ≤ tier_max уровень в пределах _LVG_PROXIMITY_ATR × ATR
      2. strength_score ≥ _LVG_MIN_STRENGTH
      3. Объём: текущий бар ≥ _LVG_VOL_SPIKE_X × медианы
               ИЛИ среднее за _LVG_VOL_ACCUM_BARS баров у уровня ≥ _LVG_VOL_ACCUM_X × медианы
    """
    if not candles or atr <= 0:
        return LevelGateResult(passed=False, reason="no_data")

    history = l1_buffer if len(l1_buffer) >= 50 else candles
    cur_price = _f(candles[-1].close)
    proximity = atr * _LVG_PROXIMITY_ATR

    # Объём: медиана и текущий
    vols = [float(c.volume) for c in (l1_buffer or candles)[-_LVG_VOL_MEDIAN_WIN:]]
    vol_med = statistics.median(vols) if vols else 0.0
    cur_vol  = float(candles[-1].volume)
    vol_spike = vol_med > 0 and cur_vol >= _LVG_VOL_SPIKE_X * vol_med

    # Строим уровни из длинной истории
    ls = build_levels(history)

    # Ищем ближайший tier 1-2 уровень в пределах proximity
    candidates = [
        lv for lv in ls.levels
        if lv.tier <= tier_max and abs(lv.price - cur_price) <= proximity
    ]
    if not candidates:
        return LevelGateResult(
            passed=False, reason="no_tier12_nearby",
            dist_atr=min(
                (abs(lv.price - cur_price) / atr for lv in ls.levels if lv.tier <= tier_max),
                default=999.0,
            ),
        )

    # Выбираем лучший (tier → расстояние)
    best = min(candidates, key=lambda lv: (lv.tier, abs(lv.price - cur_price)))
    dist_atr = abs(best.price - cur_price) / atr

    # Сила уровня по истории реакций
    strength = _level_strength(best, history, atr)
    if strength < _LVG_MIN_STRENGTH:
        return LevelGateResult(
            passed=False, reason="level_weak",
            level=best, strength=strength, dist_atr=dist_atr,
        )

    # Накопление: средний объём за последние ACCUM_BARS баров вблизи уровня
    touch_zone = atr * _LVG_TOUCH_ZONE_ATR
    near_candles = [
        c for c in candles[-_LVG_VOL_ACCUM_BARS:]
        if abs(_f(c.close) - best.price) <= touch_zone * 2
    ]
    vol_accum = False
    if near_candles and vol_med > 0:
        avg_near_vol = statistics.mean(float(c.volume) for c in near_candles)
        vol_accum = avg_near_vol >= _LVG_VOL_ACCUM_X * vol_med

    vol_ok = vol_spike or vol_accum
    if not vol_ok:
        return LevelGateResult(
            passed=False, reason="vol_weak",
            level=best, strength=strength, dist_atr=dist_atr,
            vol_ok=False, vol_spike=vol_spike, vol_accum=vol_accum,
        )

    return LevelGateResult(
        passed=True, level=best, strength=strength, dist_atr=dist_atr,
        vol_ok=True, vol_spike=vol_spike, vol_accum=vol_accum,
        reason="ok",
    )
