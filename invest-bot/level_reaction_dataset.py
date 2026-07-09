"""level_reaction_dataset.py — датасет «касаний уровней» для будущего блока
индексного контекста: уровни с иерархией силы + ПОДТВЕРЖДЁННЫЙ ОТКАТ от
уровня как сигнал входа + фактический исход, плюс разбор ВЛИЯНИЯ каждого фактора.

Проверяемая гипотеза (уточнённая): сигнал — не «замедление при подходе», а факт
того, что цена коснулась уровня и УЖЕ тикнула обратно (микро-разворот на
PULLBACK_ATR от крайней точки касания). Вопрос к данным: если вход по
подтверждённому откату, какова доля доведения до полноценного отскока
(follow-through) и КАКИЕ факторы её двигают, а какие — шум.

Модель «эпизода» касания (машина состояний на уровень):
  вошёл в зону (TRIGGER_ATR) → следим за экстремумом прокола →
    • откатил от экстремума на PULLBACK_ATR, не пробив → signal=pullback,
      дальше: дошёл до BOUNCE_ATR (follow=win) / вернулся и пробил (fail) /
      до конца дня никак (none);
    • пробил уровень на BREAK_ATR раньше отката → signal=straight_break;
    • день кончился без отката → signal=drift.
result ∈ {bounce, break, stall} — свёрнутый исход для памяти уровня.

Виды уровней (таксономия сведена с боевым level_pattern.py):
  VOL_NODE   — узлы объёма по цене (volume-at-price за трейлинг-окно);
  SIG_HIGH/LOW — H/L дней с аномальным объёмом (там стояли крупные игроки);
  GAP_OPEN/CLOSE — границы утреннего гэпа;
  PREV_DAY_H/L/C — вчерашние экстремумы/закрытие;
  ROUND      — круглые числа;
  D1/H4/H1_SWING — swing-экстремумы (голая геометрия, слабейшее свидетельство).
Плюс флаг flipped (S/R-flip: уровень был пробит и тестируется с другой стороны).

Факторы, влияние которых меряется отдельно (z-тест доли win против остальных):
  сила, ранг объёма, конфлюэнция, номер касания, глубина прокола, вид уровня,
  flip, скорость подхода, РЕЖИМ перед касанием (тренд/боковик, Kaufman ER).
Плюс скорость разрешения (ATR/бар) — как быстро уровень отрабатывает/пробивается.

Без подглядывания: swing рождается после ±STEP баров справа; ATR дня — по
дневкам ДО него; профиль объёма и SIG — по данным СТРОГО до дня; откат, режим,
скорость подхода — только прошлые бары того же дня. Будущее — только для метки.
ROUND и VOL_NODE считаются лишь на сегменте текущего контракта (склейка искажает
абсолютные цены); SIG/GAP/swing работают в back-adjusted пространстве корректно.
"""
import argparse
import csv
import logging
import os
from bisect import bisect_left, bisect_right, insort
from dataclasses import dataclass
from datetime import date, datetime, timedelta

from tinkoff.invest.utils import quotation_to_decimal

from market_time import MSK

logger = logging.getLogger(__name__)

# ── Пороги (в дневных ATR) ───────────────────────────────────────────────────
TRIGGER_ATR = 0.30      # ближе — вход в зону касания (старт эпизода)
PULLBACK_ATR = 0.15     # откат от экстремума прокола = подтверждение разворота
BREAK_ATR = 0.30        # закрытие за уровень на столько = пробой/провал
BOUNCE_ATR = 1.00       # уход от уровня на столько = состоявшийся отбой (win)
REARM_ATR = 1.50        # дальше — уровень «взводится» под новое касание
CONFLUENCE_ATR = 0.30   # соседние уровни ближе — конфлюэнция (признак силы)
SCAN_WINDOW_ATR = 2.2   # окно поиска уровней-кандидатов вокруг цены

ATR_PERIOD = 14
SWING_STEP = 3          # подтверждение swing-экстремума: ±STEP баров
KIN_LOOKBACK = 6        # баров для скорости подхода (v6)
ER_WINDOW = 30          # окно Kaufman ER для внутридневного режима
MIN_DAILY_BARS = 20

# Профиль объёма по цене (volume-at-price).
VP_LOOKBACK_DAYS = 30
VP_BIN_ATR = 0.25
VP_TOP_K = 4
VP_SEP_ATR = 1.0
VP_MIN_DAYS = 5

# Significant H/L: день с объёмом ≥ SIG_VOL_MULT× среднего за трейлинг-окно.
SIG_VOL_MULT = 2.0
SIG_AVG_DAYS = 40
SIG_MIN_DAYS = 10
GAP_MIN = 0.003         # гэп открытия ≥ 0.3% → границы гэпа как уровни

# Пороги режима (Kaufman efficiency ratio, 0..1): выше — тренд, ниже — боковик.
ER_TREND = 0.55
ER_RANGE = 0.35

# Сетка тейк/стоп для экспектанси (в ATR) + издержки на круг по умолчанию.
TS_TAKES = (0.5, 0.7, 1.0)
TS_STOPS = (0.3, 0.5)
DEFAULT_COST_ATR = 0.05

# Вес вида уровня в силе — по «прямоте свидетельства отложенного интереса».
KIND_WEIGHT = {
    "VOL_NODE": 3.0,
    "SIG_HIGH": 3.0, "SIG_LOW": 3.0,
    "GAP_OPEN": 1.8, "GAP_CLOSE": 1.8,
    "PREV_DAY_H": 2.0, "PREV_DAY_L": 2.0, "PREV_DAY_C": 1.2,
    "ROUND": 1.5,
    "D1_SWING": 2.5, "H4_SWING": 1.5, "H1_SWING": 0.8,
}


@dataclass
class Level:
    price: float
    kind: str
    born_at: datetime
    valid_to: datetime | None = None
    armed: bool = True
    touches: int = 0
    prev_outcome: str = ""
    last_break_side: str = ""   # сторона подхода в момент пробоя — для S/R-flip


@dataclass
class Touch:
    ts_msk: str
    level_price: float
    kind: str
    side: str
    age_days: int
    touches_before: int
    prev_outcome: str
    flipped: int             # 1 = ретест уровня с другой стороны после пробоя
    confluence: int
    vol_rank: float
    strength: float
    approach_v6: float
    regime_er: float         # внутридневной Kaufman ER перед касанием
    regime_er_d: float       # многодневный ER (дневные закрытия)
    regime: str              # trend / mixed / range
    signal: str
    penetration_atr: float
    pullback_atr: float
    bars_to_confirm: int
    follow: str
    result: str
    resolve_bars: int
    resolve_speed_atr: float  # доминирующий ход / бары до разрешения (ATR/бар)
    mfe_away_atr: float
    mae_beyond_atr: float
    # Первое достижение тейков/стопов (баров от подтверждения, -1 = не достигнут)
    # и P&L по тайм-стопу на закрытии дня — для сетки экспектанси. Только у pullback.
    tp05: int
    tp07: int
    tp10: int
    sl03: int
    sl05: int
    exit_away: float
    entry_bar: int            # абс. бар входа (подтверждение) и конца дня — для
    day_end_bar: int          # портфельной симуляции без перекрытия позиций
    ticker: str = ""          # проставляется в мульти-прогоне (иначе пусто)


def _f(q) -> float:
    return float(quotation_to_decimal(q))


def _bars_from_candles(candles) -> list[dict]:
    bars = [{"t": c.time, "o": _f(c.open), "h": _f(c.high),
             "l": _f(c.low), "c": _f(c.close), "v": c.volume} for c in candles]
    bars.sort(key=lambda b: b["t"])
    for b in bars:
        b["d"] = b["t"].astimezone(MSK).date()
    return bars


def _aggregate(bars: list[dict], key_fn) -> list[dict]:
    groups: dict = {}
    for b in bars:
        g = groups.setdefault(key_fn(b), {"h": b["h"], "l": b["l"], "t_end": b["t"]})
        g["h"] = max(g["h"], b["h"])
        g["l"] = min(g["l"], b["l"])
        g["t_end"] = max(g["t_end"], b["t"])
        g["c"] = b["c"]
    out = [groups[k] for k in sorted(groups)]
    for g in out:
        g["t_end"] = g["t_end"] + timedelta(minutes=5)
    return out


def _daily_bars(bars: list[dict]) -> list[dict]:
    days: dict = {}
    for b in bars:
        g = days.setdefault(b["d"], {"d": b["d"], "o": b["o"], "h": b["h"], "l": b["l"], "v": 0.0})
        g["h"] = max(g["h"], b["h"])
        g["l"] = min(g["l"], b["l"])
        g["c"] = b["c"]
        g["v"] += b["v"]
    return [days[d] for d in sorted(days)]


def _atr_by_date(daily: list[dict]) -> dict:
    out: dict = {}
    trs: list[float] = []
    for i, bar in enumerate(daily):
        tail = trs[-ATR_PERIOD:]
        if tail:
            out[bar["d"]] = sum(tail) / len(tail)
        if i > 0:
            prev_c = daily[i - 1]["c"]
            trs.append(max(bar["h"] - bar["l"],
                           abs(bar["h"] - prev_c), abs(bar["l"] - prev_c)))
    return out


def _swing_levels(tf_bars: list[dict], kind: str) -> list[Level]:
    out = []
    for i in range(SWING_STEP, len(tf_bars) - SWING_STEP):
        win = tf_bars[i - SWING_STEP:i + SWING_STEP + 1]
        born = tf_bars[i + SWING_STEP]["t_end"]
        if tf_bars[i]["l"] == min(b["l"] for b in win):
            out.append(Level(tf_bars[i]["l"], kind, born))
        if tf_bars[i]["h"] == max(b["h"] for b in win):
            out.append(Level(tf_bars[i]["h"], kind, born))
    return out


def _prev_day_levels(daily: list[dict], day_bounds: dict) -> list[Level]:
    out = []
    for prev, cur in zip(daily, daily[1:]):
        if cur["d"] not in day_bounds:
            continue
        start, end = day_bounds[cur["d"]]
        for price, kind in ((prev["h"], "PREV_DAY_H"), (prev["l"], "PREV_DAY_L"),
                            (prev["c"], "PREV_DAY_C")):
            out.append(Level(price, kind, start, valid_to=end))
    return out


def _sig_levels(daily: list[dict], day_bounds: dict) -> list[Level]:
    """H/L дней с объёмом ≥ SIG_VOL_MULT× среднего за трейлинг-окно. Уровень
    известен после закрытия своего дня (born = конец дня) — без подглядывания."""
    out = []
    for i, d in enumerate(daily):
        prior = daily[max(0, i - SIG_AVG_DAYS):i]
        if len(prior) < SIG_MIN_DAYS:
            continue
        avg = sum(b["v"] for b in prior) / len(prior)
        if avg > 0 and d["v"] >= SIG_VOL_MULT * avg and d["d"] in day_bounds:
            born = day_bounds[d["d"]][1] + timedelta(minutes=5)
            out.append(Level(d["h"], "SIG_HIGH", born))
            out.append(Level(d["l"], "SIG_LOW", born))
    return out


def _gap_levels(daily: list[dict], bars: list[dict], day_start: dict, day_bounds: dict) -> list[Level]:
    out = []
    for prev, cur in zip(daily, daily[1:]):
        if cur["d"] not in day_bounds:
            continue
        topen = bars[day_start[cur["d"]]]["o"]
        pclose = prev["c"]
        if pclose > 0 and abs(topen - pclose) / pclose >= GAP_MIN:
            start, end = day_bounds[cur["d"]]
            out.append(Level(topen, "GAP_OPEN", start, valid_to=end))
            out.append(Level(pclose, "GAP_CLOSE", start, valid_to=end))
    return out


def _nice_step(target: float) -> float:
    if target <= 0:
        return 0.0
    best, best_err = 1.0, float("inf")
    for k in range(-2, 9):
        for m in (1.0, 2.0, 2.5, 5.0):
            step = m * 10 ** k
            err = abs(step - target) / target
            if err < best_err:
                best, best_err = step, err
    return best


def _round_levels(bars: list[dict], atr_map: dict, valid_from: date) -> list[Level]:
    seg = [b for b in bars if b["d"] >= valid_from]
    if not seg:
        return []
    atrs = sorted(a for d, a in atr_map.items() if d >= valid_from)
    if not atrs:
        return []
    step = _nice_step(2.0 * atrs[len(atrs) // 2])
    if step <= 0:
        return []
    lo = min(b["l"] for b in seg)
    hi = max(b["h"] for b in seg)
    born = seg[0]["t"]
    out = []
    p = (int(lo / step) + 1) * step
    while p < hi:
        out.append(Level(round(p, 6), "ROUND", born))
        p += step
    return out


class _Profile:
    __slots__ = ("bin", "hist", "sorted_vols")

    def __init__(self, bin_size: float, hist: dict):
        self.bin = bin_size
        self.hist = hist
        self.sorted_vols = sorted(hist.values())

    def vol_rank(self, price: float) -> float:
        if not self.sorted_vols or self.bin <= 0:
            return 0.0
        v = self.hist.get(round(price / self.bin), 0)
        if v <= 0:
            return 0.0
        return bisect_right(self.sorted_vols, v) / len(self.sorted_vols)


def _build_profiles(bars, atr_map, trading_days, day_start, day_end, valid_from):
    profiles: dict = {}
    days = [d for d in trading_days if d >= valid_from]
    for p, d in enumerate(days):
        atr = atr_map.get(d)
        if not atr or atr <= 0:
            continue
        window = days[max(0, p - VP_LOOKBACK_DAYS):p]
        if len(window) < VP_MIN_DAYS:
            continue
        bin_size = VP_BIN_ATR * atr
        hist: dict = {}
        for wd in window:
            for i in range(day_start[wd], day_end[wd] + 1):
                b = bars[i]
                hist[round(b["c"] / bin_size)] = hist.get(round(b["c"] / bin_size), 0) + b["v"]
        if hist:
            profiles[d] = _Profile(bin_size, hist)
    return profiles


def _volume_node_levels(profiles: dict, day_bounds: dict) -> list[Level]:
    out = []
    for d, prof in profiles.items():
        if d not in day_bounds:
            continue
        start, end = day_bounds[d]
        sep = VP_SEP_ATR * (prof.bin / VP_BIN_ATR)
        chosen: list[float] = []
        for binidx, _v in sorted(prof.hist.items(), key=lambda kv: kv[1], reverse=True):
            price = binidx * prof.bin
            if all(abs(price - c) >= sep for c in chosen):
                chosen.append(price)
            if len(chosen) >= VP_TOP_K:
                break
        for price in chosen:
            out.append(Level(round(price, 6), "VOL_NODE", start, valid_to=end))
    return out


def _efficiency_ratio(seq: list[float]) -> float:
    """Kaufman ER: |нетто-ход| / сумма |шагов|. 1 = чистый тренд, ~0 = боковик."""
    if len(seq) < 3:
        return 0.0
    net = abs(seq[-1] - seq[0])
    path = sum(abs(seq[i] - seq[i - 1]) for i in range(1, len(seq)))
    return net / path if path > 0 else 0.0


@dataclass
class _Episode:
    lv: Level
    start_idx: int
    side: str
    atr: float
    day_end_idx: int
    pullback_thr: float
    extreme: float
    meta: dict
    closes: list           # ссылки на общие ряды — для сетки тейк/стоп в _emit
    highs: list            # тейк/стоп меряются по интрабар high/low (реальное
    lows: list             # исполнение ордера внутри бара), не по close
    confirmed: bool = False
    confirm_idx: int = -1
    penetration: float = 0.0
    pullback: float = 0.0
    mfe: float = 0.0
    mae: float = 0.0

    def feed(self, m: int, h: float, l: float, c: float):
        lvl = self.lv.price
        sgn = 1.0 if self.side == "support" else -1.0
        self.extreme = min(self.extreme, l) if self.side == "support" else max(self.extreme, h)
        away = sgn * (c - lvl) / self.atr
        if not self.confirmed:
            if away <= -BREAK_ATR:
                return self._emit("straight_break", "", m)
            retrace = sgn * (c - self.extreme) / self.atr
            if retrace >= self.pullback_thr:
                self.confirmed = True
                self.confirm_idx = m
                self.pullback = retrace
                self.penetration = sgn * (lvl - self.extreme) / self.atr
                self.mfe, self.mae = away, -away
            elif m >= self.day_end_idx:
                return self._emit("drift", "", m)
        if self.confirmed:
            self.mfe = max(self.mfe, away)
            self.mae = max(self.mae, -away)
            if away >= BOUNCE_ATR:
                return self._emit("pullback", "win", m)
            if away <= -BREAK_ATR:
                return self._emit("pullback", "fail", m)
            if m >= self.day_end_idx:
                return self._emit("pullback", "none", m)
        return None

    def _emit(self, signal: str, follow: str, m: int) -> Touch:
        if signal == "straight_break":
            result = "break"
        elif signal == "drift":
            result = "stall"
        else:
            result = {"win": "bounce", "fail": "break", "none": "stall"}[follow]
        self.lv.armed = False
        self.lv.touches += 1
        self.lv.prev_outcome = result
        if result == "break":                       # запомним сторону пробоя для S/R-flip
            self.lv.last_break_side = self.side
        resolve_bars = m - self.start_idx
        dominant = (self.mfe if result == "bounce"
                    else self.mae if result == "break" else max(self.mfe, self.mae))
        # Сетка тейк/стоп: время первого достижения каждого барьера от подтверждения
        # до конца дня (метка вправо смотреть можно) + P&L тайм-стопа на закрытии.
        tp05 = tp07 = tp10 = sl03 = sl05 = -1
        exit_away = 0.0
        if self.confirmed:
            sgn = 1.0 if self.side == "support" else -1.0
            lvl = self.lv.price
            for j in range(self.confirm_idx + 1, self.day_end_idx + 1):
                # fav — лучший ход В сторону сделки внутри бара, adv — худший
                # против неё: тейк исполняется по экстремуму в свою сторону,
                # стоп — по экстремуму против (реальный ордер, а не по close).
                fav = sgn * ((self.highs[j] if sgn > 0 else self.lows[j]) - lvl) / self.atr
                adv = sgn * ((self.lows[j] if sgn > 0 else self.highs[j]) - lvl) / self.atr
                rel = j - self.confirm_idx
                if tp05 < 0 and fav >= 0.5: tp05 = rel
                if tp07 < 0 and fav >= 0.7: tp07 = rel
                if tp10 < 0 and fav >= 1.0: tp10 = rel
                if sl03 < 0 and adv <= -0.3: sl03 = rel
                if sl05 < 0 and adv <= -0.5: sl05 = rel
            exit_away = sgn * (self.closes[self.day_end_idx] - lvl) / self.atr
        md = self.meta
        return Touch(
            ts_msk=md["ts"], level_price=round(self.lv.price, 6), kind=self.lv.kind,
            side=self.side, age_days=md["age"], touches_before=md["touches_before"],
            prev_outcome=md["prev_outcome"], flipped=md["flipped"], confluence=md["confl"],
            vol_rank=round(md["vol_rank"], 4), strength=round(md["strength"], 2),
            approach_v6=round(md["v6"], 4), regime_er=round(md["er"], 4),
            regime_er_d=round(md["er_d"], 4), regime=md["regime"], signal=signal,
            penetration_atr=round(self.penetration, 4) if self.confirmed else 0.0,
            pullback_atr=round(self.pullback, 4) if self.confirmed else 0.0,
            bars_to_confirm=(self.confirm_idx - self.start_idx) if self.confirmed else -1,
            follow=follow, result=result, resolve_bars=resolve_bars,
            resolve_speed_atr=round(dominant / max(resolve_bars, 1), 4),
            mfe_away_atr=round(self.mfe, 4), mae_beyond_atr=round(self.mae, 4),
            tp05=tp05, tp07=tp07, tp10=tp10, sl03=sl03, sl05=sl05,
            exit_away=round(exit_away, 4),
            entry_bar=self.confirm_idx if self.confirmed else -1,
            day_end_bar=self.day_end_idx,
        )


def collect(bars: list[dict], round_valid_from, pullback_atr: float = PULLBACK_ATR) -> list[Touch]:
    daily = _daily_bars(bars)
    if len(daily) < MIN_DAILY_BARS:
        raise SystemExit(f"мало дневных баров ({len(daily)} < {MIN_DAILY_BARS}) — увеличьте --days")
    atr_map = _atr_by_date(daily)

    day_start: dict = {}
    day_end: dict = {}
    for i, b in enumerate(bars):
        day_start.setdefault(b["d"], i)
        day_end[b["d"]] = i
    day_bounds = {d: (bars[day_start[d]]["t"], bars[day_end[d]]["t"]) for d in day_start}
    trading_days = sorted(day_start)

    # Дневные закрытия для многодневного режима (ER по дням строго до дня касания).
    daily_close = [b["c"] for b in daily]
    day_index = {b["d"]: i for i, b in enumerate(daily)}

    h1 = _aggregate(bars, lambda b: (b["d"], b["t"].astimezone(MSK).hour))
    h4 = _aggregate(bars, lambda b: (b["d"], b["t"].astimezone(MSK).hour // 4))

    vfrom = round_valid_from if round_valid_from is not None else trading_days[0]
    profiles = _build_profiles(bars, atr_map, trading_days, day_start, day_end, vfrom)

    levels: list[Level] = []
    levels += _swing_levels([{**b, "t_end": day_bounds[b["d"]][1] + timedelta(minutes=5)}
                             for b in daily], "D1_SWING")
    levels += _swing_levels(h4, "H4_SWING")
    levels += _swing_levels(h1, "H1_SWING")
    levels += _prev_day_levels(daily, day_bounds)
    levels += _sig_levels(daily, day_bounds)
    levels += _gap_levels(daily, bars, day_start, day_bounds)
    levels += _volume_node_levels(profiles, day_bounds)
    if round_valid_from is not None:
        levels += _round_levels(bars, atr_map, round_valid_from)
    logger.info("уровней сгенерировано: %d (%s)", len(levels),
                ", ".join(f"{k}={sum(1 for l in levels if l.kind == k)}" for k in KIND_WEIGHT))

    events = sorted(levels, key=lambda l: l.born_at)
    ev_i = 0
    active: list = []
    active_ep: dict = {}

    closes = [b["c"] for b in bars]
    highs = [b["h"] for b in bars]
    lows = [b["l"] for b in bars]
    touches: list[Touch] = []

    for m, bar in enumerate(bars):
        while ev_i < len(events) and events[ev_i].born_at <= bar["t"]:
            insort(active, (events[ev_i].price, ev_i, events[ev_i]))
            ev_i += 1
        c = bar["c"]

        done = []
        for ev_id, ep in active_ep.items():
            t = ep.feed(m, bar["h"], bar["l"], c)
            if t is not None:
                touches.append(t)
                done.append(ev_id)
        for ev_id in done:
            del active_ep[ev_id]

        atr = atr_map.get(bar["d"])
        if not atr or atr <= 0:
            continue
        prof = profiles.get(bar["d"])
        ds, de = day_start[bar["d"]], day_end[bar["d"]]

        lo_i = bisect_left(active, (c - SCAN_WINDOW_ATR * atr, -1, None))
        hi_i = bisect_right(active, (c + SCAN_WINDOW_ATR * atr, len(events) + 1, None))
        window = active[lo_i:hi_i]
        for price, ev_id, lv in window:
            if lv.valid_to is not None and bar["t"] > lv.valid_to:
                continue
            if ev_id in active_ep:
                continue
            dist = abs(c - price) / atr
            if not lv.armed:
                if dist > REARM_ATR:
                    lv.armed = True
                continue
            if dist >= TRIGGER_ATR:
                continue
            if m - 1 < ds:
                continue
            ref = max(m - 3, ds)
            side = "support" if closes[ref] >= price else "resistance"
            # Внутридневной режим: ER по closes от начала дня (или ER_WINDOW) до m.
            w0 = max(m - ER_WINDOW, ds)
            er = _efficiency_ratio(closes[w0:m + 1])
            di = day_index.get(bar["d"], 0)
            er_d = _efficiency_ratio(daily_close[max(0, di - 6):di]) if di >= 4 else 0.0
            regime = "trend" if er >= ER_TREND else ("range" if er <= ER_RANGE else "mixed")
            confl = sum(1 for p2, e2, lv2 in window
                        if e2 != ev_id and abs(p2 - price) <= CONFLUENCE_ATR * atr
                        and (lv2.valid_to is None or bar["t"] <= lv2.valid_to))
            vol_rank = prof.vol_rank(price) if prof is not None else 0.0
            strength = (KIND_WEIGHT[lv.kind] + 0.5 * min(lv.touches, 4)
                        + 2.0 * vol_rank + 0.5 * confl)
            flipped = 1 if (lv.last_break_side and lv.last_break_side != side) else 0
            meta = {
                "ts": bar["t"].astimezone(MSK).isoformat(),
                "age": (bar["d"] - lv.born_at.astimezone(MSK).date()).days,
                "touches_before": lv.touches, "prev_outcome": lv.prev_outcome,
                "flipped": flipped, "confl": confl, "vol_rank": vol_rank,
                "strength": strength, "v6": abs(closes[m] - closes[max(m - KIN_LOOKBACK, ds)]) / atr,
                "er": er, "er_d": er_d, "regime": regime,
            }
            extreme = bar["l"] if side == "support" else bar["h"]
            active_ep[ev_id] = _Episode(lv, m, side, atr, de, pullback_atr, extreme, meta,
                                        closes, highs, lows)
    return touches


# ── Сводка ───────────────────────────────────────────────────────────────────
def _strength_tier(s: float) -> str:
    return "strong" if s >= 4.5 else ("mid" if s >= 3.0 else "weak")


def _result_line(label: str, rows: list) -> None:
    n = len(rows)
    if not n:
        print(f"{label:<24}{'—':>7}")
        return
    b = sum(1 for r in rows if r.result == "bounce")
    k = sum(1 for r in rows if r.result == "break")
    mfe = sum(r.mfe_away_atr for r in rows) / n
    print(f"{label:<24}{n:>7}{100*b/n:>9.1f}{100*k/n:>9.1f}{100*(n-b-k)/n:>9.1f}{mfe:>8.2f}")


def _follow_line(label: str, rows: list) -> None:
    n = len(rows)
    if not n:
        print(f"{label:<24}{'—':>7}")
        return
    w = sum(1 for r in rows if r.follow == "win")
    fl = sum(1 for r in rows if r.follow == "fail")
    mfe = sum(r.mfe_away_atr for r in rows) / n
    print(f"{label:<24}{n:>7}{100*w/n:>9.1f}{100*fl/n:>9.1f}{100*(n-w-fl)/n:>9.1f}{mfe:>8.2f}")


def _ztest(sub: list, rest: list, pred):
    """Двухвыборочный z по доле pred. None если выборки малы."""
    n1, n2 = len(sub), len(rest)
    if n1 < 15 or n2 < 15:
        return None
    x1 = sum(1 for r in sub if pred(r))
    x2 = sum(1 for r in rest if pred(r))
    p1, p2 = x1 / n1, x2 / n2
    p = (x1 + x2) / (n1 + n2)
    se = (p * (1 - p) * (1 / n1 + 1 / n2)) ** 0.5
    if se == 0:
        return None
    return (p1 - p2) / se, p1, p2, n1


def _influence(pull: list) -> None:
    """Для каждого фактора: z доли win внутри подмножества против остальных.
    |z|≥2 — фактор, похоже, влияет; иначе на этой выборке неотличимо от шума."""
    win = lambda r: r.follow == "win"
    factors = [
        ("flipped=1", lambda r: r.flipped == 1),
        ("regime=trend", lambda r: r.regime == "trend"),
        ("regime=range", lambda r: r.regime == "range"),
        ("vol_rank≥0.66", lambda r: r.vol_rank >= 0.66),
        ("strength strong", lambda r: _strength_tier(r.strength) == "strong"),
        ("повторное касание", lambda r: r.touches_before >= 1),
        ("prev=break", lambda r: r.prev_outcome == "break"),
        ("confluence≥1", lambda r: r.confluence >= 1),
        ("прокол не дошёл(<0)", lambda r: r.penetration_atr < 0),
        ("фитиль ≥0.3", lambda r: r.penetration_atr >= 0.3),
        ("быстрый подход v6≥0.6", lambda r: r.approach_v6 >= 0.6),
        ("kind=VOL_NODE", lambda r: r.kind == "VOL_NODE"),
        ("kind=SIG_H/L", lambda r: r.kind in ("SIG_HIGH", "SIG_LOW")),
        ("kind=GAP", lambda r: r.kind in ("GAP_OPEN", "GAP_CLOSE")),
        ("kind=PREV_DAY", lambda r: r.kind.startswith("PREV_DAY")),
        ("kind=swing", lambda r: r.kind.endswith("_SWING")),
    ]
    print(f"\n== Влияние факторов на win подтверждённого отката (база win={100*sum(1 for r in pull if win(r))/max(len(pull),1):.1f}%) ==")
    print(f"{'фактор':<24}{'N':>6}{'win%':>8}{'ост.%':>8}{'z':>7}  значимость")
    rows = []
    for label, pred in factors:
        sub = [r for r in pull if pred(r)]
        rest = [r for r in pull if not pred(r)]
        res = _ztest(sub, rest, win)
        if res is None:
            print(f"{label:<24}{len(sub):>6}{'—':>8}{'—':>8}{'—':>7}  мало данных")
            continue
        z, p1, p2, n1 = res
        rows.append((abs(z), label, n1, p1, p2, z))
    for _, label, n1, p1, p2, z in sorted(rows, reverse=True):
        mark = "★ влияет" if abs(z) >= 2 else ("· слабо" if abs(z) >= 1 else "  шум")
        print(f"{label:<24}{n1:>6}{100*p1:>8.1f}{100*p2:>8.1f}{z:>7.1f}  {mark}")


def _wr(rows: list) -> tuple[float, float]:
    """(win%, fail%) по подмножеству откатов."""
    n = len(rows)
    if not n:
        return 0.0, 0.0
    w = sum(1 for r in rows if r.follow == "win")
    fl = sum(1 for r in rows if r.follow == "fail")
    return 100 * w / n, 100 * fl / n


def _combo_analysis(pull: list) -> None:
    """Складываются ли сильные факторы или это одна и та же информация.
    Воронка (последовательное И) + двумерные сетки верхних факторов."""
    fast = lambda r: r.approach_v6 >= 0.6
    notrange = lambda r: r.regime != "range"
    mem = lambda r: r.touches_before >= 1 or r.prev_outcome == "break"
    clean = lambda r: r.penetration_atr < 0
    bw, bf = _wr(pull)
    print(f"\n== Комбо-факторы: win/fail отката (база win={bw:.1f} fail={bf:.1f}, N={len(pull)}) ==")

    print("  воронка (каждое условие добавляется поверх предыдущих):")
    print(f"    {'':<30}{'N':>7}{'win%':>8}{'fail%':>8}")
    acc: list = []
    print(f"    {'база (все откаты)':<30}{len(pull):>7}{bw:>8.1f}{bf:>8.1f}")
    for label, cond in (("+ быстрый подход v6≥0.6", fast), ("+ не боковик", notrange),
                        ("+ память (повтор/pre-break)", mem), ("+ чистое касание (no pierce)", clean)):
        acc.append(cond)
        cur = [r for r in pull if all(c(r) for c in acc)]
        w, f = _wr(cur)
        print(f"    {label:<30}{len(cur):>7}{w:>8.1f}{f:>8.1f}")

    print("  быстрый подход × режим:")
    print(f"    {'':<30}{'N':>7}{'win%':>8}{'fail%':>8}")
    for fl_, fname in ((True, "fast"), (False, "slow")):
        for reg in ("trend", "mixed", "range"):
            rows = [r for r in pull if fast(r) == fl_ and r.regime == reg]
            if rows:
                w, f = _wr(rows)
                print(f"    {fname+' / '+reg:<30}{len(rows):>7}{w:>8.1f}{f:>8.1f}")

    print("  быстрый подход × память уровня:")
    print(f"    {'':<30}{'N':>7}{'win%':>8}{'fail%':>8}")
    for fl_, fname in ((True, "fast"), (False, "slow")):
        for ml, mname in ((True, "с памятью"), (False, "первое/без")):
            rows = [r for r in pull if fast(r) == fl_ and mem(r) == ml]
            if rows:
                w, f = _wr(rows)
                print(f"    {fname+' / '+mname:<30}{len(rows):>7}{w:>8.1f}{f:>8.1f}")


_TAKE_FIELD = {0.5: "tp05", 0.7: "tp07", 1.0: "tp10"}
_STOP_FIELD = {0.3: "sl03", 0.5: "sl05"}


def _ts_pnl(row, take: float, stop: float) -> float:
    """P&L одной сделки (в ATR) при выходе на первом из тейка/стопа, иначе
    тайм-стоп на закрытии дня. При одновременном касании — пессимистично стоп."""
    tt = getattr(row, _TAKE_FIELD[take])
    ss = getattr(row, _STOP_FIELD[stop])
    tt = None if tt < 0 else tt
    ss = None if ss < 0 else ss
    if tt is not None and (ss is None or tt < ss):
        return take
    if ss is not None:
        return -stop
    return row.exit_away


def _exit_of(row, take: float, stop: float) -> tuple[int, float]:
    """Бар выхода (абсолютный) и P&L сделки при правиле (take, stop)."""
    tt = getattr(row, _TAKE_FIELD[take])
    ss = getattr(row, _STOP_FIELD[stop])
    tt = None if tt < 0 else tt
    ss = None if ss < 0 else ss
    if tt is not None and (ss is None or tt < ss):
        return row.entry_bar + tt, take
    if ss is not None:
        return row.entry_bar + ss, -stop
    return row.day_end_bar, row.exit_away  # тайм-стоп на закрытии дня


def _portfolio_grid(rows: list, cost: float, title: str) -> None:
    """Экспектанси БЕЗ перекрытия: одна позиция на инструмент в моменте — новый
    сигнал игнорируется, пока предыдущая сделка не закрылась. Показывает реальную
    частоту независимых сделок (N резко падает против наивной сетки)."""
    by_t: dict = {}
    for r in rows:
        if r.entry_bar >= 0:
            by_t.setdefault(r.ticker, []).append(r)
    print(f"\n== Экспектанси БЕЗ перекрытия позиций (cost={cost}) — {title} ==")
    hdr = "take\\stop"
    print(f"    {hdr:<10}" + "".join(f"{'S='+str(s):>18}" for s in TS_STOPS))
    for take in TS_TAKES:
        cells = []
        for stop in TS_STOPS:
            tot, n = 0.0, 0
            for trs in by_t.values():
                last = -1
                for r in sorted(trs, key=lambda x: x.entry_bar):
                    if r.entry_bar <= last:
                        continue  # позиция ещё открыта — пропускаем сигнал
                    ebar, pnl = _exit_of(r, take, stop)
                    tot += pnl - cost
                    n += 1
                    last = ebar
            exp = tot / n if n else 0.0
            cells.append(f"{exp:+.3f} (N={n})")
        print(f"    T={take:<8}" + "".join(f"{c:>18}" for c in cells))


def _take_stop_grid(rows: list, cost: float, title: str) -> None:
    """Матожидание в ATR за вычетом издержек по сетке тейк×стоп + доля прибыльных."""
    n = len(rows)
    print(f"\n== Экспектанси тейк/стоп (ATR, за вычетом cost={cost}) — {title} (N={n}) ==")
    if not n:
        print("  нет сделок")
        return
    hdr = "take\\stop"
    print(f"    {hdr:<10}" + "".join(f"{'S='+str(s):>16}" for s in TS_STOPS))
    for take in TS_TAKES:
        cells = []
        for stop in TS_STOPS:
            pnls = [_ts_pnl(r, take, stop) for r in rows]
            exp = sum(pnls) / n - cost
            winr = 100 * sum(1 for p in pnls if p > 0) / n
            cells.append(f"{exp:+.3f}({winr:.0f}%)")
        print(f"    T={take:<8}" + "".join(f"{c:>16}" for c in cells))


def _print_summary(touches: list, cost: float = DEFAULT_COST_ATR) -> None:
    rh = f"{'':<24}{'N':>7}{'bounce%':>9}{'break%':>9}{'stall%':>9}{'MFE':>8}"
    fh = f"{'':<24}{'N':>7}{'win%':>9}{'fail%':>9}{'none%':>9}{'MFE':>8}"
    pull = [t for t in touches if t.signal == "pullback"]

    print("\n== Все касания: распределение сигналов ==")
    for sig in ("pullback", "straight_break", "drift"):
        n = sum(1 for t in touches if t.signal == sig)
        print(f"  {sig:<16}{n:>7}{100*n/max(len(touches),1):>8.1f}%")

    print("\n== Все касания: исход ==");  print(rh);  _result_line("all", touches)

    print("\n== ГИПОТЕЗА: follow-through подтверждённого отката ==");  print(fh)
    _follow_line("pullback (все)", pull)
    for tier in ("strong", "mid", "weak"):
        _follow_line(f"  сила={tier}", [t for t in pull if _strength_tier(t.strength) == tier])

    print("\n== Режим перед касанием (Kaufman ER) — исход ==");  print(rh)
    for reg in ("trend", "mixed", "range"):
        _result_line(f"режим={reg}", [t for t in touches if t.regime == reg])

    print("\n== S/R-flip — исход ==");  print(rh)
    _result_line("flipped (ретест)", [t for t in touches if t.flipped == 1])
    _result_line("не flip", [t for t in touches if t.flipped == 0])

    print("\n== Скорость разрешения (ATR/бар) по исходу × режиму ==")
    print(f"{'':<24}{'N':>7}{'скор.':>9}{'бары':>8}")
    for reg in ("trend", "mixed", "range"):
        for res in ("bounce", "break"):
            rows = [t for t in touches if t.regime == reg and t.result == res]
            if rows:
                sp = sum(r.resolve_speed_atr for r in rows) / len(rows)
                bl = sum(r.resolve_bars for r in rows) / len(rows)
                print(f"{reg+'/'+res:<24}{len(rows):>7}{sp:>9.3f}{bl:>8.1f}")

    _influence(pull)
    _combo_analysis(pull)

    # Экспектанси: по всем откатам и по лучшей комбо-ячейке (быстрый+память+чистое).
    _take_stop_grid(pull, cost, "все откаты")
    best = [r for r in pull if r.approach_v6 >= 0.6
            and (r.touches_before >= 1 or r.prev_outcome == "break")
            and r.penetration_atr < 0]
    _take_stop_grid(best, cost, "комбо: быстрый+память+чистое")
    # Реалистичная версия: без перекрытия позиций (частоту в доход не умножить).
    _portfolio_grid(pull, cost, "все откаты")
    _portfolio_grid(best, cost, "комбо: быстрый+память+чистое")

    print("\n== Память уровня: исход по прошлому исходу ==");  print(rh)
    for prev in ("bounce", "break", "stall", ""):
        _result_line(prev or "first_touch", [t for t in touches if t.prev_outcome == prev])

    print("\n== Второй тест после отбоя (age 1-3 дня) ==");  print(rh)
    _result_line("2nd|prev=bounce|1-3d",
                 [t for t in touches if t.touches_before >= 1 and t.prev_outcome == "bounce"
                  and 1 <= t.age_days <= 3])

    print("\n== По виду уровня: исход ==");  print(rh)
    for kind in KIND_WEIGHT:
        _result_line(kind, [t for t in touches if t.kind == kind])


def instrument_metrics(bars: list[dict]) -> tuple[float, float]:
    """Ликвидность и волатильность инструмента: средний дневной объём и
    медианный дневной ATR% — по ним бакетим тикеры в мульти-прогоне."""
    daily = _daily_bars(bars)
    if not daily:
        return 0.0, 0.0
    avg_vol = sum(b["v"] for b in daily) / len(daily)
    atr_map = _atr_by_date(daily)
    pcts = [atr_map[b["d"]] / b["c"] for b in daily
            if b["d"] in atr_map and b["c"] > 0]
    atr_pct = sorted(pcts)[len(pcts) // 2] if pcts else 0.0
    return avg_vol, atr_pct


def _quartile_labels(metrics: dict, idx: int) -> dict:
    """base -> квартиль 0..3 по metrics[base][idx] (0 = нижний)."""
    items = sorted(metrics, key=lambda b: metrics[b][idx])
    n = len(items)
    return {base: (min(3, i * 4 // n) if n >= 4 else 0) for i, base in enumerate(items)}


def _universe_summary(all_touches: list, metrics: dict) -> None:
    by_ticker: dict = {}
    for t in all_touches:
        by_ticker.setdefault(t.ticker, []).append(t)

    print("\n== По инструментам (сорт. по ликвидности) ==")
    print(f"{'тикер':<10}{'N':>7}{'ср.об/дн':>12}{'ATR%':>8}{'pull.win%':>11}{'bounce%':>9}")
    for base in sorted(metrics, key=lambda b: metrics[b][0], reverse=True):
        rows = by_ticker.get(base, [])
        pull = [r for r in rows if r.signal == "pullback"]
        win = 100 * sum(1 for r in pull if r.follow == "win") / max(len(pull), 1)
        bnc = 100 * sum(1 for r in rows if r.result == "bounce") / max(len(rows), 1)
        vol, atrp = metrics[base]
        print(f"{base:<10}{len(rows):>7}{vol:>12.0f}{100*atrp:>7.2f}%{win:>11.1f}{bnc:>9.1f}")

    fh = f"{'':<28}{'N':>7}{'win%':>9}{'fail%':>9}{'none%':>9}{'MFE':>8}"
    for idx, name in ((0, "ликвидности (ср. дневной объём)"), (1, "волатильности (ATR%)")):
        labels = _quartile_labels(metrics, idx)
        print(f"\n== ГИПОТЕЗА: follow-through по квартилям {name} ==");  print(fh)
        for q in range(4):
            bases = [b for b in labels if labels[b] == q]
            if not bases:
                continue
            lo = min(metrics[b][idx] for b in bases)
            hi = max(metrics[b][idx] for b in bases)
            rng = (f"{lo:.0f}..{hi:.0f}" if idx == 0 else f"{100*lo:.2f}..{100*hi:.2f}%")
            rows = [t for t in all_touches if labels.get(t.ticker) == q and t.signal == "pullback"]
            _follow_line(f"Q{q+1} [{rng}]", rows)


def _fetch_bars(base, args, instrument_service, market_data, db):
    from candle_archive import get_candles_cached, get_candles_cached_futures_chain
    resolved = instrument_service.future_by_base_ticker(base)
    if not resolved:
        logger.warning("%s: фьючерс не найден — пропуск", base)
        return None, None
    fut, figi = resolved
    candles = get_candles_cached_futures_chain(
        fut.ticker, figi, args.days, market_data, db, instrument_service,
        candle_interval_min=5, offset_days=args.offset_days)
    if not candles:
        logger.warning("%s (%s): свечей нет — пропуск", base, fut.ticker)
        return None, None
    cur_only = get_candles_cached(fut.ticker, figi, args.days, market_data, db,
                                  candle_interval_min=5, offset_days=args.offset_days)
    round_from = min((c.time.astimezone(MSK).date() for c in cur_only), default=None)
    return _bars_from_candles(candles), round_from


def _resolve_universe(n, instrument_service, market_data, db, mode="top", rank_days=20):
    """N фьючерсов на акции по среднему дневному объёму за последние rank_days.
    mode="top" — топ-N ликвидных; mode="spread" — N штук РАВНОМЕРНО по спектру
    ликвидности (ликвид→неликвид), чтобы квартили ликвидности не выродились в
    один тикер на бакет — только так проверяется гипотеза «уровни на ликвиде».

    Ранжируем сами (не через compute_demand_scores): та зовёт get_candles_cached
    с db=None и падает на любом пропуске кэша, теряя частично закэшированные
    тикеры. Здесь реальный db — пропуски докачиваются из D1/Tinkoff."""
    from ticker_universe import RU_STOCKS
    from candle_archive import get_candles_cached
    bulk = instrument_service.futures_by_base_tickers_bulk(sorted(RU_STOCKS), margin_delay=1.2)
    ranked = []
    for base, resolved in bulk.items():
        if not resolved:
            continue
        fs, figi = resolved
        try:
            candles = get_candles_cached(fs.ticker, figi, rank_days, market_data, db, candle_interval_min=5)
        except Exception as e:
            logger.warning("%s: объём для ранжирования не посчитан — %s", base, e)
            continue
        if not candles:
            continue
        by_day: dict = {}
        for c in candles:
            by_day[c.time.date()] = by_day.get(c.time.date(), 0) + c.volume
        if by_day:
            ranked.append((sum(by_day.values()) / len(by_day), base))
    ranked.sort(reverse=True)
    if mode == "spread" and len(ranked) > n > 1:
        # равномерные индексы от самого ликвидного до самого неликвидного
        idxs = sorted({round(i * (len(ranked) - 1) / (n - 1)) for i in range(n)})
        return [ranked[i][1] for i in idxs]
    return [b for _, b in ranked[:n]]


def _write_csv(touches, out_path):
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    fields = list(Touch.__dataclass_fields__)
    with open(out_path, "w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=fields)
        w.writeheader()
        for t in touches:
            w.writerow({k: getattr(t, k) for k in fields})


def main() -> None:
    parser = argparse.ArgumentParser(description="Датасет касаний уровней (откат-сигнал + влияние факторов)")
    parser.add_argument("--base-ticker", default="IMOEX")
    parser.add_argument("--tickers", default="", help="явный список базовых тикеров через запятую")
    parser.add_argument("--universe", type=int, default=0, help="топ-N ликвидных фьючерсов на акции")
    parser.add_argument("--spread", type=int, default=0,
                        help="N тикеров равномерно по спектру ликвидности (для проверки оси ликвид/неликвид)")
    parser.add_argument("--days", type=int, default=365)
    parser.add_argument("--offset-days", type=int, default=0)
    parser.add_argument("--pullback-atr", type=float, default=PULLBACK_ATR)
    parser.add_argument("--cost-atr", type=float, default=DEFAULT_COST_ATR,
                        help="издержки на круг в ATR (спред+комиссия+проскальзывание)")
    parser.add_argument("--out", default="")
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")

    from configuration.configuration import ProgramConfiguration
    from invest_api.services.instruments_service import InstrumentService
    from invest_api.services.market_data_service import MarketDataService
    from db_api_client import DbApiClient

    config = ProgramConfiguration("settings.ini")
    market_data = MarketDataService(config.tinkoff_token, config.tinkoff_app_name)
    instrument_service = InstrumentService(config.tinkoff_token, config.tinkoff_app_name)
    db = DbApiClient(config.mega_alerts_settings.db_api_url, config.mega_alerts_settings.db_api_key)

    # Список тикеров: явный / топ-N ликвидных / одиночный (совместимость).
    if args.tickers:
        tickers = [t.strip() for t in args.tickers.split(",") if t.strip()]
    elif args.universe or args.spread:
        n = args.spread or args.universe
        mode = "spread" if args.spread else "top"
        tickers = _resolve_universe(n, instrument_service, market_data, db, mode=mode)
        if not tickers:
            raise SystemExit("вселенная пуста: ни один фьючерс на акцию не резолвился/не дал объёма "
                             "(проверь токен и сеть). Как обходной путь — задай --tickers явно.")
        logger.info("вселенная (%s, %d): %s", mode, len(tickers), ", ".join(tickers))
    else:
        tickers = [args.base_ticker]

    multi = len(tickers) > 1
    all_touches: list = []
    metrics: dict = {}
    for base in tickers:
        try:
            bars, round_from = _fetch_bars(base, args, instrument_service, market_data, db)
            if bars is None:
                continue
            touches = collect(bars, round_from, args.pullback_atr)
            for t in touches:
                t.ticker = base
            all_touches += touches
            metrics[base] = instrument_metrics(bars)
            logger.info("%s: касаний %d (5м баров %d)", base, len(touches), len(bars))
        except SystemExit as e:      # мало баров у отдельного тикера — не рушим прогон
            logger.warning("%s: пропуск — %s", base, e)
        except Exception as e:
            logger.warning("%s: ошибка — %s", base, e)

    if not all_touches:
        raise SystemExit("касаний не собрано ни по одному тикеру")

    name = "universe" if multi else tickers[0]
    out_path = args.out or os.path.join("data", "analysis", f"level_touches_{name}.csv")
    _write_csv(all_touches, out_path)
    print(f"\nCSV: {out_path} ({len(all_touches)} касаний по {len(metrics)} тикерам)")

    if multi:
        _universe_summary(all_touches, metrics)
    _print_summary(all_touches, args.cost_atr)


if __name__ == "__main__":
    main()
