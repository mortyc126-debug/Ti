"""
accel_breadth.py — этап #2: рыночный ход vs идиосинкразия (breadth).

Гипотеза: движение, синхронное со всем рынком (информация), продолжается;
одиночный ход бумаги при спокойном рынке (ликвидностный шум) — разворачивается.

Метод:
  1. Рыночный индекс-прокси M[t] = кросс-секционное среднее m-барных доходностей
     по ВСЕМ (ликвидным) тикерам на таймстемп t. Робастно: медиана по тикерам.
  2. На каждом сигнальном баре (|v| ≥ порога в ATR) классифицируем ход:
     - С РЫНКОМ  : sign(v)==sign(M) и |M| ≥ медианы |M|;
     - ПРОТИВ    : sign(v)!=sign(M) и |M| ≥ медианы |M|;
     - ИДИО      : |M| < медианы |M| (рынок спокоен, бумага двигалась одна).
  3. Persist% и знаковый ход в ATR по горизонтам для каждой группы.

Данные: data/candle_cache/<TICKER>.json (5-мин). --liquid-only режет верхний
терциль оборота (как nw_backtest).

Запуск:
    py -3.11 accel_breadth.py --interval 5 --liquid-only
    py -3.11 accel_breadth.py --horizons 5,10,30,60,240 --move-atr 0.5
"""
import os
import sys
import json
import glob
import argparse
from datetime import datetime

import numpy as np

_EPOCH = datetime(1970, 1, 1)


def _cache_dir(arg):
    return arg or os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "candle_cache")


def _list_tickers(cache_dir, interval):
    out = []
    for fp in glob.glob(os.path.join(cache_dir, "*.json")):
        base = os.path.splitext(os.path.basename(fp))[0]
        if interval == 1 and base.endswith("_1m"):
            out.append(base[:-3])
        elif interval == 5 and not base.endswith("_1m"):
            out.append(base)
    return sorted(out)


def _load(cache_dir, ticker, interval):
    suffix = "" if interval == 5 else f"_{interval}m"
    path = os.path.join(cache_dir, f"{ticker}{suffix}.json")
    if not os.path.exists(path):
        return None
    try:
        with open(path, encoding="utf-8") as f:
            rows = json.load(f)
    except (json.JSONDecodeError, OSError):
        return None
    if not isinstance(rows, list) or len(rows) < 300:
        return None
    rows.sort(key=lambda r: r["time"])
    return rows


def _atr(highs, lows, closes, n=14):
    tr = np.empty(len(closes))
    tr[0] = highs[0] - lows[0]
    tr[1:] = np.maximum.reduce([highs[1:] - lows[1:],
                                np.abs(highs[1:] - closes[:-1]),
                                np.abs(lows[1:] - closes[:-1])])
    atr = np.full(len(closes), np.nan)
    if len(tr) > n:
        atr[n] = tr[1:n + 1].mean()
        for i in range(n + 1, len(tr)):
            atr[i] = (atr[i - 1] * (n - 1) + tr[i]) / n
    return atr


def _liq_top(cache_dir, tickers, interval):
    liq = {}
    for tk in tickers:
        rows = _load(cache_dir, tk, interval)
        if not rows:
            continue
        tos = [float(r["volume"]) * float(r["close"]) for r in rows
               if isinstance(r.get("volume"), (int, float)) and isinstance(r.get("close"), (int, float))]
        if tos:
            liq[tk] = float(np.median(tos))
    if not liq:
        return None
    present = sorted(liq.values())
    thr = present[2 * len(present) // 3]
    return {k for k, v in liq.items() if v >= thr}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cache", default=None)
    ap.add_argument("--interval", type=int, default=5, choices=(1, 5))
    ap.add_argument("--horizons", default="5,10,30,60,240", help="горизонты в минутах")
    ap.add_argument("--m", type=int, default=3, help="окно доходности (баров) для хода и рынка")
    ap.add_argument("--move-atr", type=float, default=0.5,
                    help="порог сигнального хода: |v| в ATR (иначе бар пропускаем)")
    ap.add_argument("--liquid-only", action="store_true")
    ap.add_argument("--tickers", default=None)
    ap.add_argument("--min-count", type=int, default=200)
    args = ap.parse_args()
    cache = _cache_dir(args.cache)
    hor_min = [int(x) for x in args.horizons.split(",") if x.strip()]
    hor_bar = [(hm, max(1, round(hm / args.interval))) for hm in hor_min]
    m = args.m

    tickers = ([t.strip().upper() for t in args.tickers.split(",")] if args.tickers
               else _list_tickers(cache, args.interval))
    if args.liquid_only and not args.tickers:
        top = _liq_top(cache, tickers, args.interval)
        if top:
            tickers = [t for t in tickers if t in top]
    if not tickers:
        sys.exit("нет тикеров")

    # ---- Проход 1: рыночный индекс-прокси M[ts] = медиана m-барных v по тикерам.
    # Аккумулируем список v на таймстемп; память ок (уникальных 5-мин баров десятки тыс).
    by_ts = {}
    cache_series = {}  # tk -> (closes, highs, lows, times, v)
    for tk in tickers:
        rows = _load(cache, tk, args.interval)
        if not rows:
            continue
        cl = np.array([float(r["close"]) for r in rows])
        hi = np.array([float(r["high"]) for r in rows])
        lo = np.array([float(r["low"]) for r in rows])
        tm = [str(r["time"]) for r in rows]
        v = np.full(len(cl), np.nan)
        v[m:] = (cl[m:] - cl[:-m]) / cl[:-m]
        cache_series[tk] = (cl, hi, lo, tm, v)
        for i in range(m, len(cl)):
            if np.isfinite(v[i]):
                by_ts.setdefault(tm[i], []).append(v[i])
    if not cache_series:
        sys.exit("не загрузилось ни одного тикера")

    market = {ts: float(np.median(vs)) for ts, vs in by_ts.items() if vs}
    med_absM = float(np.median([abs(x) for x in market.values()])) if market else 0.0
    print(f"тикеров: {len(cache_series)}, таймстемпов в индексе: {len(market)}, "
          f"медиана |M|={med_absM:.5f}", file=sys.stderr)

    # ---- Проход 2: классификация сигнальных баров и forward-persist.
    LBL = ["идио (рынок тих)", "С рынком", "против рынка"]
    nb = len(LBL)
    cnt = np.zeros((nb, len(hor_bar)))
    s_persist = np.zeros((nb, len(hor_bar)))
    s_signed = np.zeros((nb, len(hor_bar)))

    for tk, (cl, hi, lo, tm, v) in cache_series.items():
        atr = _atr(hi, lo, cl)
        n = len(cl)
        for i in range(m, n):
            a = atr[i]
            if not np.isfinite(a) or a <= 0 or not np.isfinite(v[i]):
                continue
            move_atr = abs(cl[i] - cl[i - m]) / a
            if move_atr < args.move_atr:      # не сигнальный ход
                continue
            d = 1.0 if v[i] > 0 else -1.0
            M = market.get(tm[i], 0.0)
            if abs(M) < med_absM:
                grp = 0                        # идио
            elif np.sign(M) == d:
                grp = 1                        # с рынком
            else:
                grp = 2                        # против рынка
            for hj, (_, h) in enumerate(hor_bar):
                if i + h >= n:
                    continue
                mv = cl[i + h] - cl[i]
                cnt[grp, hj] += 1.0
                s_persist[grp, hj] += 1.0 if np.sign(mv) == d else 0.0
                s_signed[grp, hj] += (mv / a) * d

    def _hdr():
        return f"{'группа':>16}  {'n':>8}  " + "".join(f"{hm:>7}м" for hm, _ in hor_bar)

    print(f"\nход = |Δ{m}бар| ≥ {args.move_atr} ATR; горизонты в минутах")
    print(f"\n=== % СОХРАНЕНИЯ направления (>50 продолжил, <50 развернулся) ===")
    print(_hdr())
    for g in range(nb):
        ntot = cnt[g].max()
        cells = [f"{100 * s_persist[g, hj] / cnt[g, hj]:6.1f}" if cnt[g, hj] >= args.min_count
                 else "    —" for hj in range(len(hor_bar))]
        print(f"{LBL[g]:>16}  {int(ntot):>8}  " + " ".join(cells))

    print(f"\n=== средний ЗНАКОВЫЙ ход в ATR (>0 продолжил, <0 развернулся) ===")
    print(_hdr())
    for g in range(nb):
        ntot = cnt[g].max()
        cells = [f"{s_signed[g, hj] / cnt[g, hj]:+6.3f}" if cnt[g, hj] >= args.min_count
                 else "    —" for hj in range(len(hor_bar))]
        print(f"{LBL[g]:>16}  {int(ntot):>8}  " + " ".join(cells))

    print("\nЧитать: если 'С рынком' persist > 'идио' — рыночные ходы продолжаются,")
    print("одиночные фейдят (гипотеза #2). 'против рынка' — ход бумаги вопреки рынку:")
    print("обычно самый быстрый разворот (возврат к рынку).")


if __name__ == "__main__":
    main()
