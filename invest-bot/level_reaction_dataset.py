"""level_reaction_dataset.py — датасет «касаний уровней» для будущего блока
индексного контекста: уровни с иерархией силы + ПОДТВЕРЖДЁННЫЙ ОТКАТ от
уровня как сигнал входа + фактический исход (follow-through / провал).

Проверяемая гипотеза (уточнённая): сигнал — не «замедление при подходе», а
факт того, что цена коснулась уровня и УЖЕ тикнула обратно (микро-разворот на
PULLBACK_ATR от крайней точки касания). Вопрос к данным: если вход открыт по
подтверждённому откату, какова доля доведения до полноценного отскока
(follow-through, BOUNCE_ATR) против ложного тика и последующего пробоя — и как
это зависит от силы уровня, номера касания и глубины прокола.

Модель «эпизода» касания (машина состояний на уровень):
  вошёл в зону (TRIGGER_ATR) → следим за экстремумом прокола →
    • откатил от экстремума на PULLBACK_ATR, не пробив → signal=pullback,
      дальше следим: дошёл до BOUNCE_ATR (follow=win) / вернулся и пробил
      (fail) / до конца дня никак (none);
    • пробил уровень на BREAK_ATR раньше отката → signal=straight_break;
    • день кончился без отката → signal=drift.
result ∈ {bounce, break, stall} — свёрнутый исход для памяти уровня.

Что относится к уровням (по убыванию «свидетельств отложенного интереса»):
  VOL_NODE (узлы объёма по цене за трейлинг-окно) и многократно тестированные
  уровни — сильнее всего; поведенческие якоря (вчерашние H/L/C, круглые числа);
  голая геометрия (swing D1/H4/H1) — слабее. Сила уровня строится из вида +
  истории касаний + ранга объёма по его цене + конфлюэнции соседей.

Запуск (из invest-bot, нужен token в settings.ini):
    python level_reaction_dataset.py [--base-ticker IMOEX] [--days 365]
                                     [--offset-days 0] [--pullback-atr 0.15] [--out ...]

Без подглядывания: swing рождается после ±STEP баров справа; ATR дня — по
дневкам ДО него; профиль объёма — по трейлинг-дням СТРОГО до дня; откат и
кинематика — только прошлые бары того же дня. Будущее — только для метки исхода.

Склейка контрактов (back-adjustment) сдвигает цены старых контрактов, поэтому
круглые уровни и профиль объёма считаются только на сегменте ТЕКУЩЕГО контракта.
"""
import argparse
import csv
import logging
import os
from bisect import bisect_left, bisect_right, insort
from dataclasses import dataclass, field
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
KIN_LOOKBACK = 6        # баров для скорости подхода (v6, как ковариата)
MIN_DAILY_BARS = 20

# Профиль объёма по цене (volume-at-price).
VP_LOOKBACK_DAYS = 30   # трейлинг-окно для гистограммы объёма
VP_BIN_ATR = 0.25       # ширина корзины цены в дневных ATR
VP_TOP_K = 4            # сколько пиков-узлов брать на день
VP_SEP_ATR = 1.0        # минимальный разнос между узлами
VP_MIN_DAYS = 5         # минимум дней в окне, иначе профиль не строим

# Вес вида уровня в силе. НЕ по таймфрейму, а по «прямоте свидетельства
# интереса»: узел объёма и якоря толпы > голого swing'а.
KIND_WEIGHT = {
    "VOL_NODE": 3.0,
    "PREV_DAY_H": 2.0, "PREV_DAY_L": 2.0, "PREV_DAY_C": 1.2,
    "ROUND": 1.5,
    "D1_SWING": 2.5, "H4_SWING": 1.5, "H1_SWING": 0.8,
}


@dataclass
class Level:
    price: float
    kind: str
    born_at: datetime            # с какого момента уровень известен без подглядывания
    valid_to: datetime | None = None  # None = живёт до конца данных
    armed: bool = True
    touches: int = 0
    prev_outcome: str = ""


@dataclass
class Touch:
    ts_msk: str
    level_price: float
    kind: str
    side: str            # support (подход сверху) / resistance (снизу)
    age_days: int
    touches_before: int
    prev_outcome: str
    confluence: int
    vol_rank: float      # ранг объёма по цене уровня (0..1) в профиле дня
    strength: float
    approach_v6: float   # скорость подхода за 6 баров, ATR (ковариата)
    signal: str          # pullback / straight_break / drift
    penetration_atr: float  # как глубоко экстремум зашёл ЗА уровень (>0 прокол, <0 не дошёл)
    pullback_atr: float  # фактический откат на подтверждении
    bars_to_confirm: int
    follow: str          # win / fail / none (только для signal=pullback)
    result: str          # bounce / break / stall
    resolve_bars: int
    mfe_away_atr: float
    mae_beyond_atr: float


def _f(q) -> float:
    return float(quotation_to_decimal(q))


def _bars_from_candles(candles) -> list[dict]:
    bars = [{"t": c.time, "o": _f(c.open), "h": _f(c.high),
             "l": _f(c.low), "c": _f(c.close), "v": c.volume} for c in candles]
    bars.sort(key=lambda b: b["t"])
    for b in bars:
        b["d"] = b["t"].astimezone(MSK).date()  # торговый день MOEX = дата по МСК
    return bars


def _aggregate(bars: list[dict], key_fn) -> list[dict]:
    """Агрегация 5м баров в старший ТФ. t_end — конец последнего 5м бара группы:
    момент, с которого агрегат известен (для born_at без подглядывания)."""
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
        g = days.setdefault(b["d"], {"d": b["d"], "o": b["o"], "h": b["h"], "l": b["l"]})
        g["h"] = max(g["h"], b["h"])
        g["l"] = min(g["l"], b["l"])
        g["c"] = b["c"]
    return [days[d] for d in sorted(days)]


def _atr_by_date(daily: list[dict]) -> dict:
    """ATR дня d — по TR дней СТРОГО до d: внутри дня d этот ATR уже известен."""
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
    """H/L/C вчерашнего дня — уровни только на СЛЕДУЮЩИЙ торговый день."""
    out = []
    for prev, cur in zip(daily, daily[1:]):
        if cur["d"] not in day_bounds:
            continue
        start, end = day_bounds[cur["d"]]
        for price, kind in ((prev["h"], "PREV_DAY_H"), (prev["l"], "PREV_DAY_L"),
                            (prev["c"], "PREV_DAY_C")):
            out.append(Level(price, kind, start, valid_to=end))
    return out


def _nice_step(target: float) -> float:
    """Ближайший «красивый» шаг сетки круглых чисел: {1, 2, 2.5, 5} × 10^k."""
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
    """Круглые уровни — только на сегменте текущего контракта (цены не сдвинуты
    склейкой). Шаг сетки ~2 дневных ATR."""
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
    """Гистограмма объёма по цене за трейлинг-окно (корзины по bin)."""
    __slots__ = ("bin", "hist", "sorted_vols")

    def __init__(self, bin_size: float, hist: dict):
        self.bin = bin_size
        self.hist = hist
        self.sorted_vols = sorted(hist.values())

    def vol_rank(self, price: float) -> float:
        """Перцентиль объёма в корзине цены (0..1). Вне профиля → 0."""
        if not self.sorted_vols or self.bin <= 0:
            return 0.0
        v = self.hist.get(round(price / self.bin), 0)
        if v <= 0:
            return 0.0
        return bisect_right(self.sorted_vols, v) / len(self.sorted_vols)


def _build_profiles(bars, atr_map, trading_days, day_start, day_end, valid_from):
    """Профиль объёма на каждый день — по VP_LOOKBACK_DAYS дням СТРОГО до него.
    Только сегмент текущего контракта (valid_from): склейка искажает цены."""
    profiles: dict = {}
    days = [d for d in trading_days if d >= valid_from]
    for p, d in enumerate(days):
        atr = atr_map.get(d)
        if not atr or atr <= 0:
            continue
        window = days[max(0, p - VP_LOOKBACK_DAYS):p]  # строго ДО дня d
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
    """Топ-K пиков объёма как уровни на день (разнос ≥ VP_SEP_ATR·ATR·)."""
    out = []
    for d, prof in profiles.items():
        if d not in day_bounds:
            continue
        start, end = day_bounds[d]
        sep = VP_SEP_ATR * (prof.bin / VP_BIN_ATR)  # sep в ATR → в ценах
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


@dataclass
class _Episode:
    """Живая машина состояний одного касания: от входа в зону до исхода."""
    lv: Level
    start_idx: int
    side: str
    atr: float
    day_end_idx: int
    pullback_thr: float
    extreme: float               # крайняя точка прокола (low для support / high для res)
    meta: dict                   # статические признаки касания, зафиксированы на старте
    confirmed: bool = False
    confirm_idx: int = -1
    penetration: float = 0.0
    pullback: float = 0.0
    mfe: float = 0.0
    mae: float = 0.0

    def feed(self, m: int, h: float, l: float, c: float):
        """Один бар. Возвращает Touch, если эпизод разрешился, иначе None."""
        lvl = self.lv.price
        sgn = 1.0 if self.side == "support" else -1.0   # away = уход ОТ уровня
        self.extreme = min(self.extreme, l) if self.side == "support" else max(self.extreme, h)
        away = sgn * (c - lvl) / self.atr
        if not self.confirmed:
            if away <= -BREAK_ATR:                       # пробил раньше отката
                return self._emit("straight_break", "", m)
            retrace = sgn * (c - self.extreme) / self.atr  # откат от экстремума к away
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
        md = self.meta
        return Touch(
            ts_msk=md["ts"], level_price=round(self.lv.price, 6), kind=self.lv.kind,
            side=self.side, age_days=md["age"], touches_before=md["touches_before"],
            prev_outcome=md["prev_outcome"], confluence=md["confl"],
            vol_rank=round(md["vol_rank"], 4), strength=round(md["strength"], 2),
            approach_v6=round(md["v6"], 4), signal=signal,
            penetration_atr=round(self.penetration, 4) if self.confirmed else 0.0,
            pullback_atr=round(self.pullback, 4) if self.confirmed else 0.0,
            bars_to_confirm=(self.confirm_idx - self.start_idx) if self.confirmed else -1,
            follow=follow, result=result, resolve_bars=m - self.start_idx,
            mfe_away_atr=round(self.mfe, 4), mae_beyond_atr=round(self.mae, 4),
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
    levels += _volume_node_levels(profiles, day_bounds)
    if round_valid_from is not None:
        levels += _round_levels(bars, atr_map, round_valid_from)
    logger.info("уровней сгенерировано: %d (%s)", len(levels),
                ", ".join(f"{k}={sum(1 for l in levels if l.kind == k)}" for k in KIND_WEIGHT))

    events = sorted(levels, key=lambda l: l.born_at)
    ev_i = 0
    active: list = []  # (price, ev_id, Level), отсортирован по цене — bisect у цены
    active_ep: dict = {}  # ev_id -> _Episode (живые касания, отвязаны от окна)

    closes = [b["c"] for b in bars]
    touches: list[Touch] = []

    for m, bar in enumerate(bars):
        while ev_i < len(events) and events[ev_i].born_at <= bar["t"]:
            insort(active, (events[ev_i].price, ev_i, events[ev_i]))
            ev_i += 1
        c = bar["c"]

        # 1) прогоняем живые эпизоды (они привязаны к своему дню через day_end_idx)
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

        # 2) взводим/стартуем касания у уровней в окне цены
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
            if m - 1 < ds:            # нужен хотя бы один прошлый бар того же дня
                continue
            ref = max(m - 3, ds)
            side = "support" if closes[ref] >= price else "resistance"
            confl = sum(1 for p2, e2, lv2 in window
                        if e2 != ev_id and abs(p2 - price) <= CONFLUENCE_ATR * atr
                        and (lv2.valid_to is None or bar["t"] <= lv2.valid_to))
            vol_rank = prof.vol_rank(price) if prof is not None else 0.0
            strength = (KIND_WEIGHT[lv.kind] + 0.5 * min(lv.touches, 4)
                        + 2.0 * vol_rank + 0.5 * confl)
            meta = {
                "ts": bar["t"].astimezone(MSK).isoformat(),
                "age": (bar["d"] - lv.born_at.astimezone(MSK).date()).days,
                "touches_before": lv.touches, "prev_outcome": lv.prev_outcome,
                "confl": confl, "vol_rank": vol_rank, "strength": strength,
                "v6": abs(closes[m] - closes[max(m - KIN_LOOKBACK, ds)]) / atr,
            }
            extreme = bar["l"] if side == "support" else bar["h"]
            active_ep[ev_id] = _Episode(lv, m, side, atr, de, pullback_atr, extreme, meta)
    return touches


# ── Сводка ───────────────────────────────────────────────────────────────────
def _strength_tier(s: float) -> str:
    return "strong" if s >= 4.5 else ("mid" if s >= 3.0 else "weak")


def _result_line(label: str, rows: list) -> None:
    n = len(rows)
    if not n:
        print(f"{label:<26}{'—':>7}")
        return
    b = sum(1 for r in rows if r.result == "bounce")
    k = sum(1 for r in rows if r.result == "break")
    mfe = sum(r.mfe_away_atr for r in rows) / n
    print(f"{label:<26}{n:>7}{100*b/n:>9.1f}{100*k/n:>9.1f}{100*(n-b-k)/n:>9.1f}{mfe:>8.2f}")


def _follow_line(label: str, rows: list) -> None:
    n = len(rows)
    if not n:
        print(f"{label:<26}{'—':>7}")
        return
    w = sum(1 for r in rows if r.follow == "win")
    fl = sum(1 for r in rows if r.follow == "fail")
    mfe = sum(r.mfe_away_atr for r in rows) / n
    print(f"{label:<26}{n:>7}{100*w/n:>9.1f}{100*fl/n:>9.1f}{100*(n-w-fl)/n:>9.1f}{mfe:>8.2f}")


def _print_summary(touches: list) -> None:
    rh = f"{'':<26}{'N':>7}{'bounce%':>9}{'break%':>9}{'stall%':>9}{'MFE':>8}"
    fh = f"{'':<26}{'N':>7}{'win%':>9}{'fail%':>9}{'none%':>9}{'MFE':>8}"
    pull = [t for t in touches if t.signal == "pullback"]

    print("\n== Все касания: распределение сигналов ==")
    for sig in ("pullback", "straight_break", "drift"):
        n = sum(1 for t in touches if t.signal == sig)
        print(f"  {sig:<16}{n:>7}{100*n/max(len(touches),1):>8.1f}%")

    print("\n== Все касания: исход ==");  print(rh);  _result_line("all", touches)

    print("\n== ГИПОТЕЗА: follow-through подтверждённого отката ==");  print(fh)
    _follow_line("pullback (все)", pull)
    print("  — по силе уровня:")
    for tier in ("strong", "mid", "weak"):
        _follow_line(f"  {tier}", [t for t in pull if _strength_tier(t.strength) == tier])
    print("  — по глубине прокола (penetration):")
    _follow_line("  не дошёл (<0)", [t for t in pull if t.penetration_atr < 0])
    _follow_line("  фитиль 0..0.3", [t for t in pull if 0 <= t.penetration_atr < 0.3])
    _follow_line("  глубокий >0.3", [t for t in pull if t.penetration_atr >= 0.3])
    print("  — по номеру касания:")
    _follow_line("  первое", [t for t in pull if t.touches_before == 0])
    _follow_line("  повторное", [t for t in pull if t.touches_before >= 1])

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


def main() -> None:
    parser = argparse.ArgumentParser(description="Датасет касаний уровней (откат-сигнал, 5м, склейка фьючерсов)")
    parser.add_argument("--base-ticker", default="IMOEX")
    parser.add_argument("--days", type=int, default=365)
    parser.add_argument("--offset-days", type=int, default=0)
    parser.add_argument("--pullback-atr", type=float, default=PULLBACK_ATR)
    parser.add_argument("--out", default="")
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")

    from configuration.configuration import ProgramConfiguration
    from invest_api.services.instruments_service import InstrumentService
    from invest_api.services.market_data_service import MarketDataService
    from db_api_client import DbApiClient
    from candle_archive import get_candles_cached, get_candles_cached_futures_chain

    config = ProgramConfiguration("settings.ini")
    market_data = MarketDataService(config.tinkoff_token, config.tinkoff_app_name)
    instrument_service = InstrumentService(config.tinkoff_token, config.tinkoff_app_name)
    db = DbApiClient(config.mega_alerts_settings.db_api_url, config.mega_alerts_settings.db_api_key)

    resolved = instrument_service.future_by_base_ticker(args.base_ticker)
    if not resolved:
        raise SystemExit(f"фьючерс по базовому тикеру {args.base_ticker} не найден")
    fut, figi = resolved
    logger.info("контракт: %s (%s)", fut.ticker, figi)

    candles = get_candles_cached_futures_chain(
        fut.ticker, figi, args.days, market_data, db, instrument_service,
        candle_interval_min=5, offset_days=args.offset_days)
    if not candles:
        raise SystemExit("свечи не получены")
    bars = _bars_from_candles(candles)

    cur_only = get_candles_cached(fut.ticker, figi, args.days, market_data, db,
                                  candle_interval_min=5, offset_days=args.offset_days)
    round_from = min((c.time.astimezone(MSK).date() for c in cur_only), default=None)

    touches = collect(bars, round_from, args.pullback_atr)
    logger.info("касаний собрано: %d за %d дней (5м баров: %d, откат=%.2f ATR)",
                len(touches), args.days, len(bars), args.pullback_atr)

    out_path = args.out or os.path.join("data", "analysis", f"level_touches_{args.base_ticker}.csv")
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    fields = list(Touch.__dataclass_fields__)
    with open(out_path, "w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=fields)
        w.writeheader()
        for t in touches:
            w.writerow({k: getattr(t, k) for k in fields})
    print(f"\nCSV: {out_path} ({len(touches)} касаний)")

    _print_summary(touches)


if __name__ == "__main__":
    main()
