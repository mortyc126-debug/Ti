"""
accel_squeeze.py — этап #5: персистентность по состоянию волатильности ДО хода.

Гипотеза: ход из низковолатильной базы (сжатие) — это прорыв, он продолжается;
ход в уже-высокой волатильности — поздняя стадия/выхлоп, разворачивается. Раньше
на ATR только нормировали, но по состоянию воли ПЕРЕД ходом не резали.

Метод: состояние воли на баре ПЕРЕД ходом (i−m) = ATR(i−m) / медиана ATR за
последние W баров. <срез_low = сжатие; >срез_high = расширение; между — норма.
Сигнал — резкий ход |Δm| ≥ move-atr ATR (как accel_breadth). Persist% и знаковый
ход по горизонтам для каждого состояния.

Запуск:
    py -3.11 accel_squeeze.py --interval 5 --liquid-only
"""
import sys
import os
import argparse

import numpy as np

from accel_breadth import _cache_dir, _list_tickers, _load, _atr, _liq_top


def _rolling_median(x, W):
    """Скользящая медиана каузально (NaN на первых W). Приближение через
    сортировку окна — для W~200 и десятков тыс баров ок по времени."""
    n = len(x)
    out = np.full(n, np.nan)
    for i in range(W, n):
        w = x[i - W:i]
        w = w[np.isfinite(w)]
        if len(w) > W // 2:
            out[i] = np.median(w)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cache", default=None)
    ap.add_argument("--interval", type=int, default=5, choices=(1, 5))
    ap.add_argument("--horizons", default="5,10,30,60,240", help="горизонты в минутах")
    ap.add_argument("--m", type=int, default=3)
    ap.add_argument("--move-atr", type=float, default=0.5)
    ap.add_argument("--vol-window", type=int, default=200, help="окно для базовой медианы ATR")
    ap.add_argument("--low", type=float, default=0.8, help="ATR/медиана < low = сжатие")
    ap.add_argument("--high", type=float, default=1.3, help="ATR/медиана > high = расширение")
    ap.add_argument("--liquid-only", action="store_true")
    ap.add_argument("--tickers", default=None)
    ap.add_argument("--min-count", type=int, default=200)
    args = ap.parse_args()
    cache = _cache_dir(args.cache)
    hor_min = [int(x) for x in args.horizons.split(",") if x.strip()]
    hor_bar = [(hm, max(1, round(hm / args.interval))) for hm in hor_min]
    m = args.m; W = args.vol_window

    tickers = ([t.strip().upper() for t in args.tickers.split(",")] if args.tickers
               else _list_tickers(cache, args.interval))
    if args.liquid_only and not args.tickers:
        top = _liq_top(cache, tickers, args.interval)
        if top:
            tickers = [t for t in tickers if t in top]
    if not tickers:
        sys.exit("нет тикеров")

    LBL = ["СЖАТИЕ (тихо до)", "норма", "РАСШИР. (шумно до)"]
    nb = len(LBL)
    cnt = np.zeros((nb, len(hor_bar)))
    s_persist = np.zeros((nb, len(hor_bar)))
    s_signed = np.zeros((nb, len(hor_bar)))
    n_tk = 0

    for tk in tickers:
        rows = _load(cache, tk, args.interval)
        if not rows:
            continue
        cl = np.array([float(r["close"]) for r in rows])
        hi = np.array([float(r["high"]) for r in rows])
        lo = np.array([float(r["low"]) for r in rows])
        atr = _atr(hi, lo, cl)
        base = _rolling_median(atr, W)
        v = np.full(len(cl), np.nan)
        v[m:] = (cl[m:] - cl[:-m]) / cl[:-m]
        n = len(cl)
        n_tk += 1
        for i in range(max(m, W), n):
            a = atr[i]
            if not np.isfinite(a) or a <= 0 or not np.isfinite(v[i]):
                continue
            if abs(cl[i] - cl[i - m]) / a < args.move_atr:
                continue
            # состояние воли ДО хода: бар i−m (чтобы сам ход не раздул оценку)
            j = i - m
            if j < 0 or not np.isfinite(atr[j]) or not np.isfinite(base[j]) or base[j] <= 0:
                continue
            ratio = atr[j] / base[j]
            grp = 0 if ratio < args.low else (2 if ratio > args.high else 1)
            d = 1.0 if v[i] > 0 else -1.0
            for hj, (_, h) in enumerate(hor_bar):
                if i + h >= n:
                    continue
                mv = cl[i + h] - cl[i]
                cnt[grp, hj] += 1.0
                s_persist[grp, hj] += 1.0 if np.sign(mv) == d else 0.0
                s_signed[grp, hj] += (mv / a) * d

    if n_tk == 0:
        sys.exit("не загрузилось ни одного тикера")

    def _hdr():
        return f"{'состояние':>18}  {'n':>8}  " + "".join(f"{hm:>7}м" for hm, _ in hor_bar)

    print(f"\nтикеров: {n_tk}, ход ≥ {args.move_atr} ATR, база-окно {W}, срезы {args.low}/{args.high}")
    print(f"\n=== % СОХРАНЕНИЯ направления по состоянию воли ДО хода ===")
    print(_hdr())
    for g in range(nb):
        cells = [f"{100 * s_persist[g, hj] / cnt[g, hj]:6.1f}" if cnt[g, hj] >= args.min_count
                 else "    —" for hj in range(len(hor_bar))]
        print(f"{LBL[g]:>18}  {int(cnt[g].max()):>8}  " + " ".join(cells))

    print(f"\n=== средний ЗНАКОВЫЙ ход в ATR по состоянию воли ДО хода ===")
    print(_hdr())
    for g in range(nb):
        cells = [f"{s_signed[g, hj] / cnt[g, hj]:+6.3f}" if cnt[g, hj] >= args.min_count
                 else "    —" for hj in range(len(hor_bar))]
        print(f"{LBL[g]:>18}  {int(cnt[g].max()):>8}  " + " ".join(cells))

    print("\nЧитать: если 'СЖАТИЕ' persist > 'РАСШИР.' — ход из тишины (прорыв)")
    print("продолжается, ход в уже-высокой воле (выхлоп) разворачивается (гипотеза #5).")


if __name__ == "__main__":
    main()
