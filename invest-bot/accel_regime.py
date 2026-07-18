"""
accel_regime.py — этап #3: персистентность по режиму (тренд/боковик) и
направлению относительно тренда.

Гипотеза: в тренде ход ПО тренду продолжается (моментум), ПРОТИВ — откатывает;
в боковике всё откатывает. Персистентность условна по режиму (Симпсон-риск: без
разреза средний эффект может маскировать противоположные подрежимы).

Режим — лёгкий прокси без импорта тяжёлого oi_composite: Efficiency Ratio
Кауфмана на окне W: ER = |close[i]-close[i-W]| / Σ|Δclose|. Высокий ER = тренд,
низкий = боковик. Направление тренда = sign(close[i]-close[i-W]).

Сигнал — резкий ход |Δm бар| ≥ move-atr ATR (как в accel_breadth). Группы:
  ТРЕНД по      — ER≥порога, знак хода = знаку тренда;
  ТРЕНД против  — ER≥порога, знак хода ≠ знаку тренда;
  БОКОВИК        — ER<порога.

Запуск:
    py -3.11 accel_regime.py --interval 5 --liquid-only
    py -3.11 accel_regime.py --er-window 60 --er-trend 0.5
"""
import sys
import os
import argparse

import numpy as np

from accel_breadth import _cache_dir, _list_tickers, _load, _atr, _liq_top


def _efficiency_ratio(cl, W):
    """ER Кауфмана на скользящем окне W (каузально). NaN на первых W барах."""
    n = len(cl)
    er = np.full(n, np.nan)
    d = np.abs(np.diff(cl))
    csum = np.concatenate([[0.0], np.cumsum(d)])   # csum[k]=Σ|Δ| до k
    for i in range(W, n):
        vol = csum[i] - csum[i - W]                # сумма |Δclose| в окне
        if vol > 0:
            er[i] = abs(cl[i] - cl[i - W]) / vol
    return er


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cache", default=None)
    ap.add_argument("--interval", type=int, default=5, choices=(1, 5))
    ap.add_argument("--horizons", default="5,10,30,60,240", help="горизонты в минутах")
    ap.add_argument("--m", type=int, default=3, help="окно доходности хода (баров)")
    ap.add_argument("--move-atr", type=float, default=0.5)
    ap.add_argument("--er-window", type=int, default=60, help="окно Efficiency Ratio (баров)")
    ap.add_argument("--er-trend", type=float, default=0.5, help="ER≥этого = тренд, иначе боковик")
    ap.add_argument("--liquid-only", action="store_true")
    ap.add_argument("--tickers", default=None)
    ap.add_argument("--min-count", type=int, default=200)
    args = ap.parse_args()
    cache = _cache_dir(args.cache)
    hor_min = [int(x) for x in args.horizons.split(",") if x.strip()]
    hor_bar = [(hm, max(1, round(hm / args.interval))) for hm in hor_min]
    m = args.m; W = args.er_window

    tickers = ([t.strip().upper() for t in args.tickers.split(",")] if args.tickers
               else _list_tickers(cache, args.interval))
    if args.liquid_only and not args.tickers:
        top = _liq_top(cache, tickers, args.interval)
        if top:
            tickers = [t for t in tickers if t in top]
    if not tickers:
        sys.exit("нет тикеров")

    LBL = ["ТРЕНД по", "ТРЕНД против", "БОКОВИК"]
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
        er = _efficiency_ratio(cl, W)
        v = np.full(len(cl), np.nan)
        v[m:] = (cl[m:] - cl[:-m]) / cl[:-m]
        n = len(cl)
        n_tk += 1
        for i in range(max(m, W), n):
            a = atr[i]
            if not np.isfinite(a) or a <= 0 or not np.isfinite(v[i]) or not np.isfinite(er[i]):
                continue
            if abs(cl[i] - cl[i - m]) / a < args.move_atr:
                continue
            d = 1.0 if v[i] > 0 else -1.0
            if er[i] < args.er_trend:
                grp = 2                                  # боковик
            else:
                trend_dir = np.sign(cl[i] - cl[i - W])
                grp = 0 if trend_dir == d else 1         # по / против тренда
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
        return f"{'группа':>14}  {'n':>8}  " + "".join(f"{hm:>7}м" for hm, _ in hor_bar)

    print(f"\nтикеров: {n_tk}, ход ≥ {args.move_atr} ATR, ER-окно {W}, порог тренда {args.er_trend}")
    print(f"\n=== % СОХРАНЕНИЯ направления по режиму ===")
    print(_hdr())
    for g in range(nb):
        cells = [f"{100 * s_persist[g, hj] / cnt[g, hj]:6.1f}" if cnt[g, hj] >= args.min_count
                 else "    —" for hj in range(len(hor_bar))]
        print(f"{LBL[g]:>14}  {int(cnt[g].max()):>8}  " + " ".join(cells))

    print(f"\n=== средний ЗНАКОВЫЙ ход в ATR по режиму ===")
    print(_hdr())
    for g in range(nb):
        cells = [f"{s_signed[g, hj] / cnt[g, hj]:+6.3f}" if cnt[g, hj] >= args.min_count
                 else "    —" for hj in range(len(hor_bar))]
        print(f"{LBL[g]:>14}  {int(cnt[g].max()):>8}  " + " ".join(cells))

    print("\nЧитать: если 'ТРЕНД по' persist>50 а 'ТРЕНД против'/'БОКОВИК' <50 —")
    print("моментум только по тренду, всё прочее фейдит (гипотеза #3). Если везде <50 —")
    print("режим не спасает, доминирует mean-reversion резкого пуша.")


if __name__ == "__main__":
    main()
