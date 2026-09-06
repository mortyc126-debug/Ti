"""channel_life.py — фейд к средней канала с СОБЫТИЙНЫМ выходом и «сроком жизни»
канала (номер касания). Проверяет интуицию пользовательницы: реверсию мерили
криво (фикс-горизонт k размазывал отскок), а отскок к жёсткому якорю крупнее
костов; и вероятность отскока меняется с номером касания границы.

Три кубика идеи «фейд отклонения к якорю» разом:
  ЯКОРЬ   — средняя скользящего линрег-канала (fitted на конце окна W).
  ВЫХОД   — СОБЫТИЙНЫЙ: до средней (цель) ИЛИ стоп за противоположным σ, а не
            фиксированные k баров (в этом была ошибка измерения).
  СОСТОЯНИЕ — номер касания живого канала (сброс при пробое >break·σ).

Канал на каждом баре: OLS closes[i-W+1..i], mid=fitted на последней точке,
band=m·σ(остатков). Касание верх: close пробил mid+m·σ снизу → ФЕЙД вниз
(шорт), цель=mid, стоп=mid+stop·σ. Симметрично низ. Пробой >break·σ = слом
канала (счётчик касаний обнуляется, не торгуем — это не фейд).

Честно: вход next_open, выход по close бара, где достигнута цель/стоп (не по
идеальной цене уровня), кост round-trip вычтен. Одна позиция на тикер за раз.

Раскладки: по НОМЕРУ касания (1,2,3,4,5+) — живёт ли отскок дольше/переворот;
по СТОРОНЕ (лонг низ / шорт верх) — если плюс на ОБЕИХ, это не бета рынка;
OOS train/test по месяцам, отдельно ранние касания (≤2).

Запуск:
    python channel_life.py ALL --only-stk --top-liq 40 --days 1500
    python channel_life.py ALL --only-stk --window 80 --m 2 --max-hold 80
"""
from __future__ import annotations

import argparse
import multiprocessing as mp
import os
import re
import sys

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):
        pass

import score_methods as sm

_FUT_RE = re.compile(r"^[A-Z]{1,4}[FGHJKMNQUVXZ]\d$")


def _is_future(t):
    return bool(_FUT_RE.match(t.upper()))


def _tbucket(n):
    return 5 if n >= 5 else n            # касания 1..4, дальше 5+


def _channel(closes, W):
    """mid[i], sd[i] скользящего линрег-канала (fitted на конце окна, σ остатков).
    Для i<W-1 — None. xs локальные 0..W-1, суммы x/xx константны."""
    n = len(closes)
    mid = [None] * n
    sd = [None] * n
    sx = W * (W - 1) / 2.0
    sxx = sum(k * k for k in range(W))
    denom = W * sxx - sx * sx
    for i in range(W - 1, n):
        w = closes[i - W + 1:i + 1]
        sy = 0.0; sxy = 0.0
        for k in range(W):
            sy += w[k]; sxy += k * w[k]
        b = (W * sxy - sx * sy) / denom
        a = (sy - b * sx) / W
        fit_last = a + b * (W - 1)
        # σ остатков
        ss = 0.0
        for k in range(W):
            e = w[k] - (a + b * k)
            ss += e * e
        mid[i] = fit_last
        sd[i] = (ss / W) ** 0.5
    return mid, sd


def _run(job):
    t = job["ticker"]
    rows = sm._load_from_cache(t, job["cache_dir"], job["interval"])
    if not rows:
        return t, None
    rows = sm._filter_by_dates(rows, job["date_from"], None)
    W, m, br, stp, mh, C = (job["window"], job["m"], job["break_mult"],
                            job["stop_mult"], job["max_hold"], job["cost"])
    n = len(rows)
    if n < W + mh + 5:
        return t, None
    closes = [r["close"] for r in rows]
    opens = [r["open"] for r in rows]
    mid, sd = _channel(closes, W)

    by_touch = {}      # tb -> [n, Σnet, wins]
    by_side = {}       # "L"/"S" -> [n, Σnet, wins]
    by_ym = {}         # ym -> [n, Σnet, wins]
    by_ym_early = {}   # ym -> [n, Σnet, wins]  (касания ≤2)

    def _rec(tb, side, ym, net):
        for d, key in ((by_touch, tb), (by_side, side), (by_ym, ym)):
            a = d.setdefault(key, [0, 0.0, 0])
            a[0] += 1; a[1] += net; a[2] += 1 if net > 0 else 0
        if tb <= 2:
            a = by_ym_early.setdefault(ym, [0, 0.0, 0])
            a[0] += 1; a[1] += net; a[2] += 1 if net > 0 else 0

    tc = 0            # счётчик касаний живого канала
    i = W
    while i < n - 1:
        if mid[i] is None or sd[i] is None or sd[i] <= 0 or closes[i] <= 0:
            i += 1; continue
        up = mid[i] + m * sd[i]; lo = mid[i] - m * sd[i]
        up_br = mid[i] + br * sd[i]; lo_br = mid[i] - br * sd[i]
        c, cprev = closes[i], closes[i - 1]
        # пробой канала → слом, счётчик касаний обнуляем, не торгуем
        if c >= up_br or c <= lo_br:
            tc = 0; i += 1; continue
        side = None
        if c >= up and cprev < (mid[i - 1] + m * sd[i - 1] if mid[i - 1] else up):
            side = "S"                       # верхнее касание → фейд вниз
        elif c <= lo and cprev > (mid[i - 1] - m * sd[i - 1] if mid[i - 1] else lo):
            side = "L"                       # нижнее касание → фейд вверх
        if side is None:
            i += 1; continue
        tc += 1
        entry = opens[i + 1]
        if entry <= 0:
            i += 1; continue
        target = mid[i]                      # якорь — средняя на момент касания
        if side == "S":
            stop = mid[i] + stp * sd[i]
        else:
            stop = mid[i] - stp * sd[i]
        # событийный выход
        exit_px = None
        j = i + 1
        end = min(n, i + 1 + mh)
        while j < end:
            cj = closes[j]
            if side == "S":
                if cj <= target or cj >= stop:
                    exit_px = cj; break
            else:
                if cj >= target or cj <= stop:
                    exit_px = cj; break
            j += 1
        if exit_px is None:
            j = end - 1
            exit_px = closes[j]
        ret = (entry - exit_px) / entry if side == "S" else (exit_px - entry) / entry
        net = ret - C
        ym = rows[i + 1]["time"][:7]
        _rec(_tbucket(tc), side, ym, net)
        i = j + 1                            # одна позиция за раз: продолжаем после выхода
    if not by_ym:
        return t, None
    return t, {"touch": by_touch, "side": by_side, "ym": by_ym, "ym_early": by_ym_early}


def _merge(dst, src):
    for k, v in src.items():
        a = dst.setdefault(k, [0, 0.0, 0])
        a[0] += v[0]; a[1] += v[1]; a[2] += v[2]


def _oos(by_ym):
    chrono = sorted(by_ym)
    cut = int(len(chrono) * 0.7)
    out = {}
    for lbl, ms in (("TRAIN", chrono[:cut]), ("TEST", chrono[cut:])):
        nn = 0; s = 0.0; w = 0
        for ym in ms:
            a = by_ym[ym]; nn += a[0]; s += a[1]; w += a[2]
        out[lbl] = (nn, s, w, len(ms))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("tickers")
    ap.add_argument("--cache", default=os.path.join(os.path.dirname(
        os.path.abspath(__file__)), "data", "candle_cache"))
    ap.add_argument("--interval", type=int, default=5, choices=(1, 5))
    ap.add_argument("--days", type=int, default=1500)
    ap.add_argument("--window", type=int, default=60, help="окно канала, баров")
    ap.add_argument("--m", type=float, default=2.0, help="полоса касания в σ")
    ap.add_argument("--break-mult", type=float, default=3.0, help="пробой (слом канала) в σ")
    ap.add_argument("--stop-mult", type=float, default=3.0, help="стоп фейда в σ от средней")
    ap.add_argument("--max-hold", type=int, default=60, help="макс. удержание, баров")
    ap.add_argument("--cost", type=float, default=0.001, help="кост round-trip в долях")
    ap.add_argument("--top-liq", type=int, default=40)
    ap.add_argument("--only-stk", action="store_true")
    ap.add_argument("--only-fut", action="store_true")
    ap.add_argument("--workers", type=int, default=None)
    args = ap.parse_args()

    from datetime import datetime, timedelta
    date_from = (datetime.now() - timedelta(days=args.days)).strftime("%Y-%m-%d")
    if args.tickers.upper() == "ALL":
        tickers = sm._list_tickers(args.cache, args.interval, top_liq=args.top_liq,
                                   workers=args.workers)
    else:
        tickers = [x.strip().upper() for x in args.tickers.split(",") if x.strip()]
    if args.only_stk:
        tickers = [t for t in tickers if not _is_future(t)]
    if args.only_fut:
        tickers = [t for t in tickers if _is_future(t)]
    if not tickers:
        sys.exit("нет тикеров")
    print(f"[chlife] тикеров: {len(tickers)}  W={args.window} m={args.m}σ "
          f"stop={args.stop_mult}σ hold={args.max_hold}  TF={args.interval}м", file=sys.stderr)

    jobs = [{"ticker": t, "cache_dir": args.cache, "interval": args.interval,
             "date_from": date_from, "window": args.window, "m": args.m,
             "break_mult": args.break_mult, "stop_mult": args.stop_mult,
             "max_hold": args.max_hold, "cost": args.cost} for t in tickers]
    nwk = args.workers or max(1, (mp.cpu_count() or 2) - 1)
    T = {}; SD = {}; YM = {}; YME = {}
    with mp.Pool(nwk) as pool:
        for _t, r in pool.imap_unordered(_run, jobs, chunksize=1):
            if r:
                _merge(T, r["touch"]); _merge(SD, r["side"])
                _merge(YM, r["ym"]); _merge(YME, r["ym_early"])
    if not YM:
        sys.exit("нет данных")

    C = args.cost
    tot_n = sum(v[0] for v in YM.values())
    tot_s = sum(v[1] for v in YM.values())
    tot_w = sum(v[2] for v in YM.values())
    print(f"\n=== ФЕЙД К СРЕДНЕЙ КАНАЛА · событийный выход · нетто (кост {C*100:.2f}%) ===")
    print(f"сделок: {tot_n}   ср/сделку: {tot_s/tot_n*100:+.4f}%   hit: {tot_w/tot_n*100:.1f}%")

    print(f"\n— по НОМЕРУ касания (живёт ли отскок / переворот) —")
    print(f"{'касание':<10}{'n':>9}{'ср net%':>11}{'hit%':>8}")
    for tb in sorted(T):
        a = T[tb]
        lbl = f"{tb}+" if tb >= 5 else str(tb)
        print(f"{lbl:<10}{a[0]:>9}{a[1]/a[0]*100:>+11.4f}{a[2]/a[0]*100:>7.1f}%")

    print(f"\n— по СТОРОНЕ (плюс на ОБЕИХ = не бета рынка) —")
    print(f"{'сторона':<12}{'n':>9}{'ср net%':>11}{'hit%':>8}")
    for k, name in (("L", "лонг (низ)"), ("S", "шорт (верх)")):
        a = SD.get(k)
        if a and a[0]:
            print(f"{name:<12}{a[0]:>9}{a[1]/a[0]*100:>+11.4f}{a[2]/a[0]*100:>7.1f}%")

    oa = _oos(YM); oe = _oos(YME)
    print(f"\n— OOS train/test по месяцам —")
    print(f"{'набор':<16}{'сплит':<7}{'n':>8}{'ср net%':>11}{'hit%':>8}")
    for nm, oo in (("все касания", oa), ("ранние (≤2)", oe)):
        for lbl in ("TRAIN", "TEST"):
            nn, s, w, nmth = oo[lbl]
            if not nn:
                print(f"{nm:<16}{lbl:<7}  —  ({nmth}мес)"); continue
            print(f"{nm:<16}{lbl:<7}{nn:>8}{s/nn*100:>+11.4f}{w/nn*100:>7.1f}%")
    print("\nвердикт: TEST ср net%>0 (и на обеих сторонах) = отскок к якорю крупнее "
          "костов при честном событийном выходе — интуиция про «мерили криво» верна. "
          "Если ранние касания в плюсе, а поздние в минус/ноль — у канала есть срок "
          "жизни (номер касания = состояние).")


if __name__ == "__main__":
    main()
