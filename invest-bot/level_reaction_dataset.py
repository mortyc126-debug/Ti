"""level_reaction_dataset.py — датасет «касания уровней» для будущего блока
индексного контекста: уровни с иерархией силы + кинематика подхода на 5м +
фактический исход (отбой/пробой/ничего).

Ядро проверяемой гипотезы: P(отбой | замедление в уровень) существенно
отличается от P(отбой | ускорение в уровень). Если на этом датасете разницы
нет — детектор реакции мёртв, и строить машину состояний не из чего.

Запуск (из каталога invest-bot, нужен token в settings.ini):
    python level_reaction_dataset.py [--base-ticker IMOEX] [--days 365]
                                     [--offset-days 0] [--out путь.csv]

Результат: data/analysis/level_touches_<TICKER>.csv (одна строка = одно
касание) + сводные таблицы в stdout (отбой% по кинематике × силе уровня).

Без подглядывания: swing-уровень «рождается» только после подтверждающих
STEP баров справа; ATR дня — по дневкам ДО этого дня; кинематика — только
прошлые бары. Будущее используется единственно для разметки исхода (label).

Ограничение склейки контрактов: back-adjustment сдвигает цены старых
контрактов, поэтому круглые уровни (психологические числа) считаются только
на сегменте ТЕКУЩЕГО контракта, где сдвиг нулевой. Swing/prev-day уровням
сдвиг не мешает — структура относительных цен сохраняется.
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
TRIGGER_ATR = 0.30   # ближе — считаем касанием
REARM_ATR = 1.50     # дальше — уровень «взводится» для нового касания
BOUNCE_ATR = 1.00    # уход от уровня на столько = отбой
BREAK_ATR = 0.30     # закрытие за уровнем на столько = пробой
CONFLUENCE_ATR = 0.30  # соседние уровни ближе — конфлюэнция (признак силы)
SCAN_WINDOW_ATR = 2.2  # окно поиска уровней-кандидатов вокруг цены

ATR_PERIOD = 14
SWING_STEP = 3       # подтверждение swing-экстремума: ±STEP баров
KIN_LOOKBACK = 6     # баров 5м для кинематики подхода (v6 = за 6 баров)
MAX_HORIZON_BARS = 96  # потолок разметки исхода (8ч), но не дальше конца дня
MIN_DAILY_BARS = 20

# Вес вида уровня: старший ТФ сильнее. Часть будущего strength-скора.
KIND_WEIGHT = {
    "D1_SWING": 3.0, "H4_SWING": 2.0, "H1_SWING": 1.0,
    "PREV_DAY_H": 2.0, "PREV_DAY_L": 2.0, "PREV_DAY_C": 1.5,
    "ROUND": 1.5,
}


@dataclass
class Level:
    price: float
    kind: str
    born_at: datetime            # с какого момента уровень известен без подглядывания
    valid_to: datetime | None = None  # None = живёт до конца данных
    armed: bool = True
    resolving_until: int = -1    # индекс 5м бара, до которого идёт разметка исхода
    touches: int = 0
    prev_outcome: str = ""


@dataclass
class Touch:
    ts_msk: str
    level_price: float
    kind: str
    age_days: int
    touches_before: int
    prev_outcome: str
    confluence: int
    strength: float
    side: str            # support (подход сверху) / resistance (снизу)
    v6_atr: float        # скорость подхода за 6 баров, ATR, по модулю
    v3_atr: float
    decel_ratio: float   # |v3|/|v3 предыдущих| : <0.7 замедление, >1.3 ускорение
    kin_class: str       # decel / steady / accel
    range_exp: float     # расширение диапазона баров у уровня
    dist_atr: float      # расстояние до уровня в момент триггера
    outcome: str         # bounce / break / none
    resolve_bars: int
    mfe_away_atr: float  # максимальный уход ОТ уровня до разрешения
    mae_beyond_atr: float  # максимальный прокол ЗА уровень до разрешения


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
    """Агрегация 5м баров в старший ТФ. t_end — конец последнего 5м бара
    группы: момент, с которого агрегат известен (для born_at без подглядывания)."""
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


def _atr_by_date(daily: list[dict]) -> dict[date, float]:
    """ATR дня d — по TR дней СТРОГО до d: внутри дня d этот ATR уже известен."""
    out: dict[date, float] = {}
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


def _prev_day_levels(daily: list[dict], day_bounds: dict[date, tuple[datetime, datetime]]) -> list[Level]:
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


def _round_levels(bars: list[dict], atr_map: dict[date, float], valid_from: date) -> list[Level]:
    """Круглые уровни — только на сегменте текущего контракта (цены не сдвинуты
    склейкой). Шаг сетки ~2 дневных ATR: мельче — сетка везде, уровни теряют смысл."""
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


def _kinematics(closes: list[float], highs: list[float], lows: list[float],
                m: int, level: float, atr: float) -> dict:
    """Кинематика подхода на баре m: скорость за 6/3 бара, замедление, диапазон."""
    c0, c3, c6 = closes[m], closes[m - 3], closes[m - 6]
    v6 = abs(c0 - c6) / atr
    v3 = abs(c0 - c3) / atr
    v_prev3 = abs(c3 - c6) / atr
    decel = v3 / (v_prev3 + 1e-9)
    rng_now = sum(highs[m - i] - lows[m - i] for i in range(3)) / 3
    rng_prev = sum(highs[m - i] - lows[m - i] for i in range(3, 9)) / 6 if m >= 8 else rng_now
    kin = "decel" if decel < 0.7 else ("accel" if decel > 1.3 else "steady")
    side = "support" if c6 > level else "resistance"
    return {"v6": v6, "v3": v3, "decel": decel, "kin": kin, "side": side,
            "range_exp": rng_now / (rng_prev + 1e-9)}


def _resolve(closes: list[float], m: int, day_end_idx: int, level: float,
             atr: float, side: str) -> tuple[str, int, float, float]:
    """Исход касания: bounce/break/none + бары до разрешения + MFE/MAE в ATR.
    Пороги асимметричны сознательно: пробой подтверждается закрытием за уровень
    на 0.3 ATR (стоп за уровнем), отбой — уходом на 1.0 ATR (рабочий тейк)."""
    sgn = 1.0 if side == "support" else -1.0  # «от уровня» = вверх для поддержки
    end = min(m + MAX_HORIZON_BARS, day_end_idx)
    mfe, mae = 0.0, 0.0
    for j in range(m + 1, end + 1):
        away = sgn * (closes[j] - level) / atr
        mfe = max(mfe, away)
        mae = max(mae, -away)
        if away <= -BREAK_ATR:
            return "break", j - m, mfe, mae
        if away >= BOUNCE_ATR:
            return "bounce", j - m, mfe, mae
    return "none", end - m, mfe, mae


def collect(bars: list[dict], round_valid_from: date | None) -> list[Touch]:
    daily = _daily_bars(bars)
    if len(daily) < MIN_DAILY_BARS:
        raise SystemExit(f"мало дневных баров ({len(daily)} < {MIN_DAILY_BARS}) — увеличьте --days")
    atr_map = _atr_by_date(daily)

    # Границы торговых дней по МСК: старт кинематики и потолок разметки исхода.
    day_start_idx: dict[date, int] = {}
    day_end_idx: dict[date, int] = {}
    for i, b in enumerate(bars):
        day_start_idx.setdefault(b["d"], i)
        day_end_idx[b["d"]] = i
    day_bounds = {d: (bars[day_start_idx[d]]["t"], bars[day_end_idx[d]]["t"])
                  for d in day_start_idx}

    h1 = _aggregate(bars, lambda b: (b["d"], b["t"].astimezone(MSK).hour))
    h4 = _aggregate(bars, lambda b: (b["d"], b["t"].astimezone(MSK).hour // 4))

    levels: list[Level] = []
    levels += _swing_levels([{**b, "t_end": day_bounds[b["d"]][1] + timedelta(minutes=5)}
                             for b in daily], "D1_SWING")
    levels += _swing_levels(h4, "H4_SWING")
    levels += _swing_levels(h1, "H1_SWING")
    levels += _prev_day_levels(daily, day_bounds)
    if round_valid_from is not None:
        levels += _round_levels(bars, atr_map, round_valid_from)
    logger.info("уровней сгенерировано: %d (%s)", len(levels),
                ", ".join(f"{k}={sum(1 for l in levels if l.kind == k)}"
                          for k in KIND_WEIGHT))

    events = sorted(levels, key=lambda l: l.born_at)
    ev_i = 0
    # Активные уровни в сортированном по цене списке: кандидаты у цены — bisect,
    # иначе 50к баров × тысячи уровней не прожуёшь. seq — тай-брейк кортежа.
    active: list[tuple[float, int, Level]] = []

    closes = [b["c"] for b in bars]
    highs = [b["h"] for b in bars]
    lows = [b["l"] for b in bars]

    touches: list[Touch] = []
    for m, bar in enumerate(bars):
        while ev_i < len(events) and events[ev_i].born_at <= bar["t"]:
            insort(active, (events[ev_i].price, ev_i, events[ev_i]))
            ev_i += 1
        atr = atr_map.get(bar["d"])
        if not atr or atr <= 0:
            continue
        c = bar["c"]
        lo_i = bisect_left(active, (c - SCAN_WINDOW_ATR * atr, -1, None))
        hi_i = bisect_right(active, (c + SCAN_WINDOW_ATR * atr, len(events) + 1, None))
        d_end = day_end_idx[bar["d"]]

        for price, _, lv in active[lo_i:hi_i]:
            if lv.valid_to is not None and bar["t"] > lv.valid_to:
                continue
            dist = abs(c - price) / atr
            if not lv.armed:
                if dist > REARM_ATR and m >= lv.resolving_until:
                    lv.armed = True
                continue
            if dist >= TRIGGER_ATR:
                continue
            # Триггер касания. Кинематике нужен пробег внутри ЭТОГО дня —
            # через ночной гэп скорость подхода бессмысленна.
            if m - KIN_LOOKBACK < day_start_idx[bar["d"]]:
                continue
            kin = _kinematics(closes, highs, lows, m, price, atr)
            outcome, res_bars, mfe, mae = _resolve(closes, m, d_end, price, atr, kin["side"])
            confl = sum(1 for p2, _, lv2 in active[lo_i:hi_i]
                        if lv2 is not lv and abs(p2 - price) <= CONFLUENCE_ATR * atr
                        and (lv2.valid_to is None or bar["t"] <= lv2.valid_to))
            strength = KIND_WEIGHT[lv.kind] + 0.5 * min(lv.touches, 4) + 0.5 * confl
            touches.append(Touch(
                ts_msk=bar["t"].astimezone(MSK).isoformat(),
                level_price=round(price, 6), kind=lv.kind,
                age_days=(bar["d"] - lv.born_at.astimezone(MSK).date()).days,
                touches_before=lv.touches, prev_outcome=lv.prev_outcome,
                confluence=confl, strength=round(strength, 2), side=kin["side"],
                v6_atr=round(kin["v6"], 4), v3_atr=round(kin["v3"], 4),
                decel_ratio=round(kin["decel"], 4), kin_class=kin["kin"],
                range_exp=round(kin["range_exp"], 4), dist_atr=round(dist, 4),
                outcome=outcome, resolve_bars=res_bars,
                mfe_away_atr=round(mfe, 4), mae_beyond_atr=round(mae, 4),
            ))
            lv.armed = False
            lv.resolving_until = m + res_bars
            lv.touches += 1
            lv.prev_outcome = outcome
    return touches


def _strength_tier(s: float) -> str:
    return "strong" if s >= 4.0 else ("mid" if s >= 2.5 else "weak")


def _print_summary(touches: list[Touch]) -> None:
    def line(label: str, rows: list[Touch]) -> None:
        n = len(rows)
        if not n:
            print(f"{label:<28}{'—':>7}")
            return
        b = sum(1 for r in rows if r.outcome == "bounce")
        k = sum(1 for r in rows if r.outcome == "break")
        mfe = sum(r.mfe_away_atr for r in rows) / n
        print(f"{label:<28}{n:>7}{100*b/n:>9.1f}{100*k/n:>9.1f}"
              f"{100*(n-b-k)/n:>9.1f}{mfe:>9.2f}")

    hdr = f"{'':<28}{'N':>7}{'bounce%':>9}{'break%':>9}{'none%':>9}{'MFE':>9}"
    print("\n== Всего ==");  print(hdr);  line("all", touches)

    print("\n== Ключевая гипотеза: кинематика подхода ==");  print(hdr)
    for kin in ("decel", "steady", "accel"):
        line(kin, [t for t in touches if t.kin_class == kin])

    print("\n== Кинематика × сила уровня ==");  print(hdr)
    for tier in ("strong", "mid", "weak"):
        for kin in ("decel", "steady", "accel"):
            line(f"{tier}/{kin}",
                 [t for t in touches if _strength_tier(t.strength) == tier and t.kin_class == kin])

    print("\n== По виду уровня ==");  print(hdr)
    for kind in KIND_WEIGHT:
        line(kind, [t for t in touches if t.kind == kind])

    print("\n== Память уровня: чем кончилось прошлое касание ==");  print(hdr)
    for prev in ("bounce", "break", "none", ""):
        line(prev or "first_touch", [t for t in touches if t.prev_outcome == prev])


def main() -> None:
    parser = argparse.ArgumentParser(description="Сбор датасета касаний уровней (5м, склейка фьючерсов)")
    parser.add_argument("--base-ticker", default="IMOEX")
    parser.add_argument("--days", type=int, default=365)
    parser.add_argument("--offset-days", type=int, default=0)
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

    # Сегмент текущего контракта (без сдвига склейкой) — для круглых уровней.
    # Повторный вызов бесплатный: chain уже положил эти дни в локальный кэш.
    cur_only = get_candles_cached(fut.ticker, figi, args.days, market_data, db,
                                  candle_interval_min=5, offset_days=args.offset_days)
    round_from = min((c.time.astimezone(MSK).date() for c in cur_only), default=None)

    touches = collect(bars, round_from)
    logger.info("касаний собрано: %d за %d дней (5м баров: %d)", len(touches), args.days, len(bars))

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
