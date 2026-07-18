"""
accel_level.py — этап #6: персистентность по контексту уровня.

Гипотеза: ход В прошлый экстремум (к сопротивлению/поддержке) отбивается
(реджект → разворот); ход, ПРОБИВШИЙ прошлый экстремум, либо продолжается
(брейкаут), либо разворачивается (ложный пробой); ход в свободном поле —
нейтрален. Инфра уровней в проекте есть, но с персистентностью не скрещивали.

Метод: прошлый диапазон [Lmin, Hmax] по окну N баров ДО хода (i−N−m .. i−m).
Сигнал — резкий ход |Δm| ≥ move-atr ATR. Класс по положению close[i] и знаку:
  ПРОБОЙ    — close за прошлым экстремумом в сторону хода (up: >Hmax, down: <Lmin);
  В УРОВЕНЬ  — близко к экстремору по ходу, но не пробил (в полосе band·ATR);
  СВОБОДНО   — прочее (в глубине диапазона).
Persist% и знаковый ход по горизонтам для каждого класса.

Запуск:
    py -3.11 accel_level.py --interval 5 --liquid-only
"""
import sys
import os
import argparse

import numpy as np

from accel_breadth import _cache_dir, _list_tickers, _load, _atr, _liq_top


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cache", default=None)
    ap.add_argument("--interval", type=int, default=5, choices=(1, 5))
    ap.add_argument("--horizons", default="5,10,30,60,240", help="горизонты в минутах")
    ap.add_argument("--m", type=int, default=3)
    ap.add_argument("--move-atr", type=float, default=0.5)
    ap.add_argument("--lvl-window", type=int, default=100, help="окно прошлого диапазона (баров)")
    ap.add_argument("--band", type=float, default=0.5, help="полоса 'в уровень' у экстремума, ATR")
    ap.add_argument("--liquid-only", action="store_true")
    ap.add_argument("--tickers", default=None)
    ap.add_argument("--min-count", type=int, default=200)
    args = ap.parse_args()
    cache = _cache_dir(args.cache)
    hor_min = [int(x) for x in args.horizons.split(",") if x.strip()]
    hor_bar = [(hm, max(1, round(hm / args.interval))) for hm in hor_min]
    m = args.m; W = args.lvl_window

    tickers = ([t.strip().upper() for t in args.tickers.split(",")] if args.tickers
               else _list_tickers(cache, args.interval))
    if args.liquid_only and not args.tickers:
        top = _liq_top(cache, tickers, args.interval)
        if top:
            tickers = [t for t in tickers if t in top]
    if not tickers:
        sys.exit("нет тикеров")

    LBL = ["ПРОБОЙ", "В УРОВЕНЬ", "СВОБОДНО"]
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
        v = np.full(len(cl), np.nan)
        v[m:] = (cl[m:] - cl[:-m]) / cl[:-m]
        n = len(cl)
        n_tk += 1
        for i in range(m + W, n):
            a = atr[i]
            if not np.isfinite(a) or a <= 0 or not np.isfinite(v[i]):
                continue
            if abs(cl[i] - cl[i - m]) / a < args.move_atr:
                continue
            # прошлый диапазон ДО хода: окно [i−m−W, i−m)
            hmax = hi[i - m - W:i - m].max()
            lmin = lo[i - m - W:i - m].min()
            d = 1.0 if v[i] > 0 else -1.0
            px = cl[i]
            if d > 0:
                if px > hmax:
                    grp = 0                                  # пробой вверх
                elif hmax - px < args.band * a:
                    grp = 1                                  # в сопротивление
                else:
                    grp = 2
            else:
                if px < lmin:
                    grp = 0                                  # пробой вниз
                elif px - lmin < args.band * a:
                    grp = 1                                  # в поддержку
                else:
                    grp = 2
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
        return f"{'класс':>10}  {'n':>8}  " + "".join(f"{hm:>7}м" for hm, _ in hor_bar)

    print(f"\nтикеров: {n_tk}, ход ≥ {args.move_atr} ATR, окно уровня {W}, полоса {args.band} ATR")
    print(f"\n=== % СОХРАНЕНИЯ направления по контексту уровня ===")
    print(_hdr())
    for g in range(nb):
        cells = [f"{100 * s_persist[g, hj] / cnt[g, hj]:6.1f}" if cnt[g, hj] >= args.min_count
                 else "    —" for hj in range(len(hor_bar))]
        print(f"{LBL[g]:>10}  {int(cnt[g].max()):>8}  " + " ".join(cells))

    print(f"\n=== средний ЗНАКОВЫЙ ход в ATR по контексту уровня ===")
    print(_hdr())
    for g in range(nb):
        cells = [f"{s_signed[g, hj] / cnt[g, hj]:+6.3f}" if cnt[g, hj] >= args.min_count
                 else "    —" for hj in range(len(hor_bar))]
        print(f"{LBL[g]:>10}  {int(cnt[g].max()):>8}  " + " ".join(cells))

    print("\nЧитать: 'В УРОВЕНЬ' persist<50 = реджект от экстремума (разворот, фейд-)")
    print("вход у уровня оправдан). 'ПРОБОЙ' >50 = брейкаут держится; <50 = ложные")
    print("пробои чаще (фейд пробоя). 'СВОБОДНО' — базовый фон без структуры.")


if __name__ == "__main__":
    main()
