"""
accel_asym.py — этап #4: асимметрия персистентности вверх vs вниз.

Гипотеза: падения острее ростов (страх≠жадность) → развороты после ходов вверх и
вниз разной силы/скорости. Прямо релевантно: NW-эдж — ШОРТ-онли, важно знать,
как ведут себя именно нисходящие ходы. Раньше persist считали по |ускорению|, не
разделяя знак.

Метод: сигнал — резкий ход |Δm бар| ≥ move-atr ATR (как accel_breadth). Разрез по
ЗНАКУ хода (вверх/вниз) × полосам МАГНИТУДЫ хода (в ATR). Persist% и знаковый ход
по горизонтам. Сравниваем зеркальные ячейки вверх↔вниз.

Запуск:
    py -3.11 accel_asym.py --interval 5 --liquid-only
"""
import sys
import os
import argparse

import numpy as np

from accel_breadth import _cache_dir, _list_tickers, _load, _atr, _liq_top

# Полосы магнитуды хода в ATR.
MAG = [(0.5, 1.0), (1.0, 1.5), (1.5, 2.5), (2.5, 1e9)]
MAG_LBL = ["0.5-1", "1-1.5", "1.5-2.5", ">2.5"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cache", default=None)
    ap.add_argument("--interval", type=int, default=5, choices=(1, 5))
    ap.add_argument("--horizons", default="5,30,60,240", help="горизонты в минутах")
    ap.add_argument("--m", type=int, default=3)
    ap.add_argument("--move-atr", type=float, default=0.5)
    ap.add_argument("--liquid-only", action="store_true")
    ap.add_argument("--tickers", default=None)
    ap.add_argument("--min-count", type=int, default=200)
    args = ap.parse_args()
    cache = _cache_dir(args.cache)
    hor_min = [int(x) for x in args.horizons.split(",") if x.strip()]
    hor_bar = [(hm, max(1, round(hm / args.interval))) for hm in hor_min]
    m = args.m
    nmag = len(MAG)

    tickers = ([t.strip().upper() for t in args.tickers.split(",")] if args.tickers
               else _list_tickers(cache, args.interval))
    if args.liquid_only and not args.tickers:
        top = _liq_top(cache, tickers, args.interval)
        if top:
            tickers = [t for t in tickers if t in top]
    if not tickers:
        sys.exit("нет тикеров")

    # оси: [dir(0=up,1=down)][mag][horizon]
    cnt = np.zeros((2, nmag, len(hor_bar)))
    s_persist = np.zeros((2, nmag, len(hor_bar)))
    s_signed = np.zeros((2, nmag, len(hor_bar)))
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
        for i in range(m, n):
            a = atr[i]
            if not np.isfinite(a) or a <= 0 or not np.isfinite(v[i]):
                continue
            mag = abs(cl[i] - cl[i - m]) / a
            if mag < args.move_atr:
                continue
            di = 0 if v[i] > 0 else 1
            mi = next((k for k, (lo_, hi_) in enumerate(MAG) if lo_ <= mag < hi_), nmag - 1)
            d = 1.0 if di == 0 else -1.0
            for hj, (_, h) in enumerate(hor_bar):
                if i + h >= n:
                    continue
                mv = cl[i + h] - cl[i]
                cnt[di, mi, hj] += 1.0
                s_persist[di, mi, hj] += 1.0 if np.sign(mv) == d else 0.0
                s_signed[di, mi, hj] += (mv / a) * d

    if n_tk == 0:
        sys.exit("не загрузилось ни одного тикера")

    def _hdr():
        return f"{'магнит.':>8}  {'n':>7}  " + "".join(f"{hm:>7}м" for hm, _ in hor_bar)

    dir_lbl = ["ВВЕРХ", "ВНИЗ"]
    print(f"\nтикеров: {n_tk}, ход ≥ {args.move_atr} ATR")
    for what, arr, fmt in (("% СОХРАНЕНИЯ направления", s_persist, lambda x: f"{100*x:6.1f}"),
                           ("средний ЗНАКОВЫЙ ход в ATR", s_signed, lambda x: f"{x:+6.3f}")):
        print(f"\n=== {what} (вверх vs вниз × магнитуда) ===")
        for di in range(2):
            print(f"-- {dir_lbl[di]} --")
            print(_hdr())
            for mi in range(nmag):
                cells = [fmt(arr[di, mi, hj] / cnt[di, mi, hj]) if cnt[di, mi, hj] >= args.min_count
                         else "    —" for hj in range(len(hor_bar))]
                print(f"{MAG_LBL[mi]:>8}  {int(cnt[di, mi].max()):>7}  " + " ".join(cells))

    print("\nЧитать: сравни зеркальные строки ВВЕРХ↔ВНИЗ одной магнитуды. Если ВНИЗ")
    print("разворачивается сильнее (persist ниже / знак отрицательнее) — падения")
    print("откатывают резче (отскок страха); шорт резкого падения рискованнее.")


if __name__ == "__main__":
    main()
