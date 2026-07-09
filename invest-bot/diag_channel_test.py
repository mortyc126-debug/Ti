"""diag_channel_test.py — диагональные (параллельные трендовые) каналы: тест
трейдерской идеи из разбора видео через тот же рентген, что уровни/OI/ускорение.

Канал строится ровно как в видео: точка 1 (низ), точка 2 (верх, между ними по
времени), точка 3 (следующий низ ВЫШЕ точки 1) → восходящий канал; зеркально —
верх/низ/верх ниже предыдущего → нисходящий. Канал считается известным (без
подглядывания) начиная с бара, на котором ПОДТВЕРДИЛАСЬ третья точка (её
swing-статус виден только после STEP баров вправо).

Нижняя граница восходящего канала = линия через точки 1 и 3 (обе — низы,
задают наклон). Верхняя = параллельная линия через точку 2. Зеркально для
нисходящего (верхняя граница = линия через два верха, нижняя — параллель через
низ между ними). Обе границы — функции бара (движутся во времени), поэтому
касание/откат/пробой считаются той же машиной состояний, что и для уровней
(TRIGGER/PULLBACK/BREAK/BOUNCE), но относительно значения линии В ЭТОТ бар.

Две гипотезы пользователя, проверяемые explicitly:
  1. «Чем дольше цена идёт в канале, тем выше вероятность пробоя» — бакетируем
     касания по age_bars (сколько баров канал уже живёт на момент касания) и
     смотрим тренд bounce%/break%.
  2. «Реальные сделки трейдера — почти всегда ПРОТИВ обнаруженного канала»:
     каждое касание помечается role:
       extreme  — граница, в которую канал ЭКСТЕНДИРУЕТСЯ (верх восходящего /
                  низ нисходящего) — классический вход №1 из видео, фейд
                  локального хая/лоя;
       pullback — граница ПО тренду (низ восходящего / верх нисходящего) —
                  «покупка отката внутри тренда» / любимая связка тренд+уровень.
     Сравниваем bounce-rate между ролями — если обе фейдятся одинаково, это
     подтверждает: канал работает не как «следуй за наклоном», а как
     сдвоенный уровень (обе границы contrarian), согласуется с находкой, что
     PRICE_TREND/трендовые методы — anti.

Офлайн, из candle_cache, numpy. Запуск (из invest-bot/):
    python diag_channel_test.py --tickers SBER,GAZP,LKOH,YDEX
    python diag_channel_test.py --all --tf-minutes 60
"""
import argparse
import csv
import datetime
import glob
import json
import os

import numpy as np

TRIGGER_ATR = 0.30
PULLBACK_ATR = 0.15
BREAK_ATR = 0.30
BOUNCE_ATR = 1.00
REARM_ATR = 1.50

SWING_STEP_DEFAULT = 2
TF_MINUTES_DEFAULT = 60
CAP_BARS_DEFAULT = 300          # потолок жизни канала (в барах swing-ТФ)
MIN_FORMATION_BARS_DEFAULT = 6  # мин. расстояние между точкой 1 и точкой 3
MIN_HEIGHT_ATR_DEFAULT = 1.0    # мин. ширина канала при подтверждении (в ATR)
RESOLVE_CAP_DEFAULT = 36        # потолок разрешения эпизода (баров ТФ) — иначе
                                # на движущейся линии stall не существует вовсе
ATR_PERIOD = 20


def _load_bars(path: str):
    with open(path, encoding="utf-8") as f:
        rows = json.load(f)
    if not rows:
        return None
    rows.sort(key=lambda r: r["time"])
    epoch = np.array([datetime.datetime.fromisoformat(r["time"]).timestamp() for r in rows])
    o = np.array([r["open"] for r in rows], float)
    h = np.array([r["high"] for r in rows], float)
    l = np.array([r["low"] for r in rows], float)
    c = np.array([r["close"] for r in rows], float)
    return epoch, o, h, l, c


def _aggregate(epoch, o, h, l, c, tf_minutes: int):
    """Агрегация 5м баров в фиксированные интервалы tf_minutes по эпохе."""
    bucket = (epoch // (tf_minutes * 60)).astype(np.int64)
    _, idx_start = np.unique(bucket, return_index=True)
    idx_start = np.sort(idx_start)
    idx_end = np.append(idx_start[1:], len(bucket))
    n = len(idx_start)
    ao = o[idx_start]
    ac = c[idx_end - 1]
    ah = np.array([h[idx_start[i]:idx_end[i]].max() for i in range(n)])
    al = np.array([l[idx_start[i]:idx_end[i]].min() for i in range(n)])
    at = epoch[idx_start]
    return at, ao, ah, al, ac


def _rmean(x, n):
    cs = np.cumsum(np.insert(x, 0, 0.0))
    out = np.full(len(x), np.nan)
    if len(x) >= n:
        out[n - 1:] = (cs[n:] - cs[:-n]) / n
    return out


def _atr(h, l, c, n):
    prev_c = np.concatenate([[c[0]], c[:-1]])
    tr = np.maximum(h - l, np.maximum(np.abs(h - prev_c), np.abs(l - prev_c)))
    return _rmean(tr, n)


def _swings(h, l, step: int):
    """[(bar_idx, kind 'H'/'L', price, confirm_idx)], сорт. по bar_idx.
    confirm_idx = bar_idx+step — момент, с которого swing известен без
    подглядывания (нужно STEP баров справа, чтобы подтвердить экстремум)."""
    out = []
    n = len(h)
    for i in range(step, n - step):
        if l[i] == l[i - step:i + step + 1].min():
            out.append((i, "L", l[i], i + step))
        if h[i] == h[i - step:i + step + 1].max():
            out.append((i, "H", h[i], i + step))
    out.sort(key=lambda s: s[0])
    return out


def _build_channels(swings, atr, min_formation_bars: int, min_height_atr: float):
    """Скользящее окно по 3 последовательным swing-точкам (любых типов, по
    времени): L,H,L с p3>p1 → восходящий; H,L,H с p3<p1 → нисходящий. Канал
    известен с confirm_idx третьей точки (max confirm среди трёх — на всякий
    случай, хотя p3 всегда подтверждается позже p1/p2 по построению)."""
    out = []
    for i in range(2, len(swings)):
        i1, t1, p1, cf1 = swings[i - 2]
        i2, t2, p2, cf2 = swings[i - 1]
        i3, t3, p3, cf3 = swings[i]
        if i3 - i1 < min_formation_bars:
            continue
        direction = None
        if t1 == "L" and t2 == "H" and t3 == "L" and p3 > p1:
            direction = "up"
            anchor = (i1, p1, i3, p3)     # нижняя граница — линия через 2 низа
            off_bar, off_price = i2, p2   # верхняя — параллель через верх
        elif t1 == "H" and t2 == "L" and t3 == "H" and p3 < p1:
            direction = "down"
            anchor = (i1, p1, i3, p3)     # верхняя граница — линия через 2 верха
            off_bar, off_price = i2, p2   # нижняя — параллель через низ
        if direction is None:
            continue
        ai1, ap1, ai2, ap2 = anchor
        if ai2 == ai1:
            continue
        slope = (ap2 - ap1) / (ai2 - ai1)
        intercept = ap1 - slope * ai1
        offset = off_price - (slope * off_bar + intercept)
        confirmed_bar = max(cf1, cf2, cf3)
        if confirmed_bar >= len(atr):
            continue
        a = atr[confirmed_bar]
        if not np.isfinite(a) or a <= 0 or abs(offset) / a < min_height_atr:
            continue
        out.append({
            "direction": direction, "slope": slope, "intercept": intercept,
            "offset": offset, "confirmed_bar": confirmed_bar,
            "p1": (i1, p1), "p2": (i2, p2), "p3": (i3, p3),
        })
    return out


def _boundary_vals(ch, bar):
    a = ch["slope"] * bar + ch["intercept"]
    if ch["direction"] == "up":
        return a, a + ch["offset"]          # lo, hi
    return a + ch["offset"], a              # lo, hi (offset<0 здесь)


def _scan_channel(ch, h, l, c, atr, cap_bars: int, ticker: str, resolve_cap: int):
    """Та же машина состояний, что _Episode в level_reaction_dataset. Движущаяся
    граница используется ТОЛЬКО для детекции касания; исход эпизода меряется
    относительно ЗАМОРОЖЕННОГО значения линии на баре касания. Иначе наклон
    линии сам генерирует исходы: pullback-граница (низ up-канала) растёт и
    догоняет стоящую цену = фиктивный break, extreme-граница уезжает от цены =
    фиктивный bounce — асимметрия ролей надувается чистой геометрией.
    resolve_cap — тайм-аут эпизода (аналог конца дня у уровней), без него на
    бесконечном горизонте stall не существует. Раздельно для lower/upper —
    после ПРОБОЯ (result=break) сторона больше не сканируется (канал на этой
    границе «умер», как у трейдера — пробили, забыли, рисуем новый)."""
    n = len(c)
    start = ch["confirmed_bar"]
    end = min(n - 1, start + cap_bars)
    if start >= end:
        return []
    touches = []
    for side in ("lower", "upper"):
        armed = True
        touches_before = 0
        prev_outcome = ""
        bar = start
        while bar <= end:
            lo, hi = _boundary_vals(ch, bar)
            level = lo if side == "lower" else hi
            a = atr[bar]
            if not np.isfinite(a) or a <= 0:
                bar += 1
                continue
            dist = abs(c[bar] - level) / a
            if not armed:
                if dist > REARM_ATR:
                    armed = True
                bar += 1
                continue
            if dist >= TRIGGER_ATR:
                bar += 1
                continue

            sgn = 1.0 if side == "lower" else -1.0
            extreme = l[bar] if side == "lower" else h[bar]
            # Замораживаем уровень на баре касания: исход = поведение ЦЕНЫ,
            # а не дрейф линии (см. докстринг).
            lo_t, hi_t = _boundary_vals(ch, bar)
            lvl = lo_t if side == "lower" else hi_t
            confirmed, confirm_bar = False, None
            pullback = penetration = mfe = mae = 0.0
            signal = result = follow = ""
            resolve_bars = 0
            m = bar
            while True:
                timeout = m >= end or (m - bar) >= resolve_cap
                extreme = min(extreme, l[m]) if side == "lower" else max(extreme, h[m])
                am = atr[m]
                if not np.isfinite(am) or am <= 0:
                    if timeout:
                        signal, result = "drift", "stall"
                        resolve_bars = m - bar
                        break
                    m += 1
                    continue
                away = sgn * (c[m] - lvl) / am
                if not confirmed:
                    if away <= -BREAK_ATR:
                        signal, result = "straight_break", "break"
                        resolve_bars = m - bar
                        break
                    retrace = sgn * (c[m] - extreme) / am
                    if retrace >= PULLBACK_ATR:
                        confirmed, confirm_bar = True, m
                        pullback = retrace
                        penetration = sgn * (lvl - extreme) / am
                        mfe, mae = away, -away
                    elif timeout:
                        signal, result = "drift", "stall"
                        resolve_bars = m - bar
                        break
                if confirmed:
                    mfe, mae = max(mfe, away), max(mae, -away)
                    if away >= BOUNCE_ATR:
                        signal, follow, result = "pullback", "win", "bounce"
                        resolve_bars = m - bar
                        break
                    if away <= -BREAK_ATR:
                        signal, follow, result = "pullback", "fail", "break"
                        resolve_bars = m - bar
                        break
                    if timeout:
                        signal, follow, result = "pullback", "none", "stall"
                        resolve_bars = m - bar
                        break
                m += 1

            role = "extreme" if (side == "upper" and ch["direction"] == "up") or \
                                 (side == "lower" and ch["direction"] == "down") else "pullback"
            touches.append({
                "ticker": ticker, "bar": bar, "side": side, "direction": ch["direction"],
                "role": role, "age_bars": bar - start, "touches_before": touches_before,
                "prev_outcome": prev_outcome, "signal": signal, "follow": follow,
                "result": result, "penetration": round(penetration, 4),
                "pullback": round(pullback, 4), "resolve_bars": resolve_bars,
                "mfe": round(mfe, 4), "mae": round(mae, 4),
            })
            touches_before += 1
            prev_outcome = result
            armed = False
            if result == "break":
                break  # канал на этой границе инвалидирован — дальше не сканируем
            bar = m + 1
    return touches


def _process_ticker(path: str, ticker: str, tf_minutes: int, swing_step: int,
                    cap_bars: int, min_formation_bars: int, min_height_atr: float,
                    days: int, resolve_cap: int):
    data = _load_bars(path)
    if data is None:
        return []
    epoch, o, h, l, c = data
    if days:
        cut = days * 100  # ~100 пятиминуток/торг.день
        epoch, o, h, l, c = epoch[-cut:], o[-cut:], h[-cut:], l[-cut:], c[-cut:]
    at, ao, ah, al, ac = _aggregate(epoch, o, h, l, c, tf_minutes)
    if len(ac) < 4 * swing_step + min_formation_bars + 20:
        return []
    atr = _atr(ah, al, ac, ATR_PERIOD)
    swings = _swings(ah, al, swing_step)
    channels = _build_channels(swings, atr, min_formation_bars, min_height_atr)
    touches = []
    for ch in channels:
        touches += _scan_channel(ch, ah, al, ac, atr, cap_bars, ticker, resolve_cap)
    return touches


# ── Сводка ───────────────────────────────────────────────────────────────────
def _line(label: str, rows: list) -> None:
    n = len(rows)
    if not n:
        print(f"{label:<26}{'—':>7}")
        return
    b = sum(1 for r in rows if r["result"] == "bounce")
    k = sum(1 for r in rows if r["result"] == "break")
    mfe = sum(r["mfe"] for r in rows) / n
    print(f"{label:<26}{n:>7}{100*b/n:>9.1f}{100*k/n:>9.1f}{100*(n-b-k)/n:>9.1f}{mfe:>8.2f}")


def _ztest_bounce(sub: list, rest: list):
    n1, n2 = len(sub), len(rest)
    if n1 < 15 or n2 < 15:
        return None
    x1 = sum(1 for r in sub if r["result"] == "bounce")
    x2 = sum(1 for r in rest if r["result"] == "bounce")
    p1, p2 = x1 / n1, x2 / n2
    p = (x1 + x2) / (n1 + n2)
    se = (p * (1 - p) * (1 / n1 + 1 / n2)) ** 0.5
    if se == 0:
        return None
    return (p1 - p2) / se, p1, p2


def _summary(touches: list) -> None:
    rh = f"{'':<26}{'N':>7}{'bounce%':>9}{'break%':>9}{'stall%':>9}{'MFE':>8}"
    print(f"\n=== Диагональные каналы: {len(touches)} касаний ===")

    print("\n== Распределение сигналов ==")
    for sig in ("pullback", "straight_break", "drift"):
        n = sum(1 for t in touches if t["signal"] == sig)
        print(f"  {sig:<16}{n:>7}{100*n/max(len(touches),1):>8.1f}%")

    print("\n== Все касания: исход ==");  print(rh);  _line("all", touches)

    print("\n== ГИПОТЕЗА (роль границы): extreme vs pullback ==")
    print("# extreme = граница, в которую канал экстендируется (классический фейд видео)")
    print("# pullback = граница ПО тренду (просадка внутри тренда)")
    print(rh)
    extreme = [t for t in touches if t["role"] == "extreme"]
    pull = [t for t in touches if t["role"] == "pullback"]
    _line("role=extreme", extreme)
    _line("role=pullback", pull)
    res = _ztest_bounce(extreme, pull)
    if res:
        z, p1, p2 = res
        print(f"  z(extreme vs pullback, bounce-rate)={z:+.1f}  "
              f"({'значимо, отличаются' if abs(z) >= 2 else 'неотличимо'})")

    print("\n== По направлению канала ==");  print(rh)
    _line("up-канал", [t for t in touches if t["direction"] == "up"])
    _line("down-канал", [t for t in touches if t["direction"] == "down"])

    print("\n== ГИПОТЕЗА: чем дольше канал жив (age_bars), тем выше вероятность пробоя ==")
    print(rh)
    ages = sorted(t["age_bars"] for t in touches)
    if len(ages) >= 40:
        # dedupe: при массе age=0 квинтильные границы дублируются → пустые бакеты
        edges = sorted(set([ages[len(ages) * i // 5] for i in range(5)] + [ages[-1] + 1]))
        for i in range(len(edges) - 1):
            seg = [t for t in touches if edges[i] <= t["age_bars"] < edges[i + 1]]
            _line(f"age∈[{edges[i]},{edges[i+1]})", seg)
    else:
        print("  мало данных для квинтилей возраста")

    print("\n== Память канала: исход по прошлому исходу этой же границы ==");  print(rh)
    for prev in ("bounce", "break", "stall", ""):
        _line(prev or "first_touch", [t for t in touches if t["prev_outcome"] == prev])

    print("\n== extreme × up/down (кросс-проверка симметрии) ==");  print(rh)
    for role in ("extreme", "pullback"):
        for d in ("up", "down"):
            _line(f"{role}/{d}", [t for t in touches if t["role"] == role and t["direction"] == d])


def _fetch_paths(cache: str, interval: int, tickers_arg: str, all_flag: bool):
    suffix = "" if interval == 5 else "_1m"
    if tickers_arg:
        names = [t.strip() for t in tickers_arg.split(",") if t.strip()]
        return [(t, os.path.join(cache, f"{t}{suffix}.json")) for t in names]
    if all_flag:
        paths = sorted(p for p in glob.glob(os.path.join(cache, "*.json"))
                       if (interval == 1) == p.endswith("_1m.json"))
        return [(os.path.basename(p)[:-5].replace("_1m", ""), p) for p in paths]
    raise SystemExit("укажи --tickers СПИСОК или --all")


def main() -> None:
    ap = argparse.ArgumentParser(description="Тест диагональных трендовых каналов (по видео) через рентген уровней")
    ap.add_argument("--cache", default=os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                                     "data", "candle_cache"))
    ap.add_argument("--interval", type=int, default=5, choices=(1, 5))
    ap.add_argument("--tickers", default="")
    ap.add_argument("--all", action="store_true")
    ap.add_argument("--days", type=int, default=0, help="0 = весь файл")
    ap.add_argument("--tf-minutes", type=int, default=TF_MINUTES_DEFAULT,
                    help="таймфрейм построения каналов (агрегация из 5м)")
    ap.add_argument("--swing-step", type=int, default=SWING_STEP_DEFAULT)
    ap.add_argument("--cap-bars", type=int, default=CAP_BARS_DEFAULT)
    ap.add_argument("--min-formation-bars", type=int, default=MIN_FORMATION_BARS_DEFAULT)
    ap.add_argument("--min-height-atr", type=float, default=MIN_HEIGHT_ATR_DEFAULT)
    ap.add_argument("--resolve-cap-bars", type=int, default=RESOLVE_CAP_DEFAULT,
                    help="тайм-аут эпизода в барах ТФ (аналог конца дня у уровней)")
    ap.add_argument("--out", default="")
    args = ap.parse_args()

    paths = _fetch_paths(args.cache, args.interval, args.tickers, args.all)
    all_touches = []
    for ticker, path in paths:
        if not os.path.exists(path):
            print(f"нет файла: {path}")
            continue
        touches = _process_ticker(path, ticker, args.tf_minutes, args.swing_step,
                                  args.cap_bars, args.min_formation_bars,
                                  args.min_height_atr, args.days, args.resolve_cap_bars)
        all_touches += touches
        print(f"{ticker}: касаний {len(touches)}")

    if not all_touches:
        raise SystemExit("касаний не собрано — проверь кэш/параметры (--min-height-atr, --swing-step)")

    out_path = args.out or os.path.join("data", "analysis", "diag_channel_touches.csv")
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    fields = list(all_touches[0].keys())
    with open(out_path, "w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=fields)
        w.writeheader()
        for t in all_touches:
            w.writerow(t)
    print(f"\nCSV: {out_path} ({len(all_touches)} касаний)")

    _summary(all_touches)


if __name__ == "__main__":
    main()
