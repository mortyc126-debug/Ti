"""pairs_intraday.py — внутридневной stat-arb на паре обычка/преф (жёсткий якорь).

Дневной pairs_lab дал мало событий (спред расходится на 2σ редко) → статистики
нет. Тут спред считаем на 5-мин барах: событий сотни, можно честно мерить
walk-forward фолдами. Фокус — быстрые пары (SBER/SBERP: half-life 2.7д).

Честно по конструкции (без look-ahead):
  - β хеджа считаем ТОЛЬКО на train-части (первые --split-frac баров);
  - z-score причинный: скользящее окно --z-window берёт лишь ПРОШЛЫЕ бары;
  - торгуем только на TEST; вход на СЛЕДУЮЩЕМ баре после сигнала;
  - кост на КАЖДУЮ ногу в одну сторону (круг = 4 ноги), у префов шире — default
    0.05%/нога, крути --cost;
  - результат бьём на --folds равных кусков TEST — виден разброс во времени.

spread = logP_a − (α + β·logP_b). z=(spread−rollmean)/rollstd. Вход |z|≥z-enter
(ставка на возврат), выход |z|≤z-exit, стоп |z|≥z-stop, либо --max-hold баров.
Тайминги пар выравниваем по пересечению меток времени (у префов бывают пропуски).

Запуск:
    python pairs_intraday.py --pairs "SBER/SBERP" --days 1500
    python pairs_intraday.py --pairs "SBER/SBERP,TATN/TATNP" --z-enter 2 --folds 6
"""
from __future__ import annotations

import argparse
import math
import os
import sys

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):
        pass

import score_methods as sm


def _ols(y, x):
    n = len(x)
    mx = sum(x) / n; my = sum(y) / n
    sxx = sum((xi - mx) ** 2 for xi in x) or 1e-12
    sxy = sum((x[i] - mx) * (y[i] - my) for i in range(n))
    b = sxy / sxx
    return b, my - b * mx


def _half_life(spread):
    s_prev = spread[:-1]
    ds = [spread[i + 1] - spread[i] for i in range(len(spread) - 1)]
    if len(s_prev) < 20:
        return None
    phi, _ = _ols(ds, s_prev)
    if phi >= 0:
        return None
    return -math.log(2) / phi


def _aligned(rows_a, rows_b):
    """пересечение по меткам времени → (times, logP_a, logP_b)."""
    ma = {r["time"]: r["close"] for r in rows_a if r["close"] > 0}
    mb = {r["time"]: r["close"] for r in rows_b if r["close"] > 0}
    times = sorted(set(ma) & set(mb))
    la = [math.log(ma[t]) for t in times]
    lb = [math.log(mb[t]) for t in times]
    return times, la, lb


def _run_pair(A, B, cache, interval, date_from, args):
    ra = sm._load_from_cache(A, cache, interval)
    rb = sm._load_from_cache(B, cache, interval)
    if not ra or not rb:
        return None, f"нет кэша {A}/{B}"
    ra = sm._filter_by_dates(ra, date_from, None)
    rb = sm._filter_by_dates(rb, date_from, None)
    times, la, lb = _aligned(ra, rb)
    n = len(times)
    if n < args.z_window + 2000:
        return None, f"{A}/{B}: мало общих баров ({n})"

    cut = int(n * args.split_frac)
    # β/α хеджа — только train
    beta, alpha = _ols(la[:cut], lb[:cut])
    if beta <= 0:
        return None, f"{A}/{B}: β≤0 (не со-движутся)"
    spread = [la[i] - (alpha + beta * lb[i]) for i in range(n)]
    hl = _half_life(spread[:cut]) or 0.0    # в барах

    Wz = args.z_window
    ze, zx, zs = args.z_enter, args.z_exit, args.z_stop
    mh = args.max_hold
    RT = 4 * args.cost

    # причинный скользящий z: running sum/sumsq по трейлинг-окну Wz
    trades = []          # (fold_idx, pnl_net, win, entry_i)
    test_start = cut
    fold_len = max(1, (n - test_start) // args.folds)
    ssum = 0.0; ssq = 0.0
    from collections import deque
    dq = deque()
    pos = 0; entry_spr = 0.0; entry_i = -1

    def zscore(i):
        if len(dq) < Wz:
            return None
        m = ssum / Wz
        var = ssq / Wz - m * m
        if var <= 1e-12:
            return None
        return (spread[i] - m) / math.sqrt(var)

    for i in range(n):
        # обновляем окно ДО решения (окно = прошлые бары, включая i)
        dq.append(spread[i]); ssum += spread[i]; ssq += spread[i] * spread[i]
        if len(dq) > Wz:
            old = dq.popleft(); ssum -= old; ssq -= old * old
        if i < test_start:
            continue
        z = zscore(i)
        if z is None:
            continue
        if pos == 0:
            if i + 1 >= n:
                break
            if z >= ze:
                pos = -1; entry_spr = spread[i + 1]; entry_i = i + 1
            elif z <= -ze:
                pos = 1; entry_spr = spread[i + 1]; entry_i = i + 1
        else:
            held = i - entry_i
            hit_exit = abs(z) <= zx
            hit_stop = abs(z) >= zs
            if hit_exit or hit_stop or (mh and held >= mh) or i == n - 1:
                pnl = pos * (spread[i] - entry_spr) - RT
                fold = min(args.folds - 1, (entry_i - test_start) // fold_len)
                trades.append((fold, pnl, 1 if pnl > 0 else 0))
                pos = 0
    return {"pair": f"{A}/{B}", "n": len(trades), "hl": hl, "beta": beta,
            "bars": n, "trades": trades}, None


def _agg(trades, folds):
    n = len(trades)
    s = sum(t[1] for t in trades)
    w = sum(t[2] for t in trades)
    per_fold = [[0, 0.0, 0] for _ in range(folds)]
    for f, pnl, win in trades:
        per_fold[f][0] += 1; per_fold[f][1] += pnl; per_fold[f][2] += win
    return n, s, w, per_fold


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pairs", required=True, help="A/B через запятую, напр. SBER/SBERP")
    ap.add_argument("--cache", default=os.path.join(os.path.dirname(
        os.path.abspath(__file__)), "data", "candle_cache"))
    ap.add_argument("--interval", type=int, default=5, choices=(1, 5))
    ap.add_argument("--days", type=int, default=1500)
    ap.add_argument("--split-frac", type=float, default=0.5, help="доля баров на β-хедж (train)")
    ap.add_argument("--z-window", type=int, default=500, help="окно причинного z, баров")
    ap.add_argument("--z-enter", type=float, default=2.0)
    ap.add_argument("--z-exit", type=float, default=0.5)
    ap.add_argument("--z-stop", type=float, default=4.0)
    ap.add_argument("--max-hold", type=int, default=288, help="макс. удержание, баров (0=без)")
    ap.add_argument("--cost", type=float, default=0.0005, help="кост ОДНОЙ ноги в одну сторону")
    ap.add_argument("--folds", type=int, default=5)
    args = ap.parse_args()

    from datetime import datetime, timedelta
    date_from = (datetime.now() - timedelta(days=args.days)).strftime("%Y-%m-%d")

    pairs = []
    for p in args.pairs.split(","):
        p = p.strip().upper()
        if "/" in p:
            a, b = p.split("/"); pairs.append((a.strip(), b.strip()))
    if not pairs:
        sys.exit("нет пар")

    RT = 4 * args.cost
    print(f"[intraday] пар: {len(pairs)}  TF={args.interval}м  z-окно={args.z_window}б  "
          f"вход|z|≥{args.z_enter}  кост/нога {args.cost*100:.3f}% (круг {RT*100:.2f}%)",
          file=sys.stderr)

    results = []
    for A, B in pairs:
        res, err = _run_pair(A, B, args.cache, args.interval, date_from, args)
        if err:
            print(f"[skip] {err}", file=sys.stderr)
        if res:
            results.append(res)
    if not results:
        sys.exit("нет торгуемых пар")

    print(f"\n=== ВНУТРИДНЕВНОЙ ПАРНЫЙ · OOS(TEST) · нетто (круг {RT*100:.2f}%) ===")
    print(f"{'пара':<14}{'сделок':>8}{'ср/сд%':>10}{'hit%':>8}{'сумма%':>10}"
          f"{'hl_бар':>9}{'hl_дн~':>8}")
    all_tr = []
    for r in results:
        n, s, w, _ = _agg(r["trades"], args.folds)
        all_tr += r["trades"]
        if not n:
            print(f"{r['pair']:<14}{'0':>8}  — нет входов"); continue
        # ~78 пятиминуток в торговом дне РФ (10:00–18:40)
        hl_days = r["hl"] / 78.0 if r["hl"] else 0.0
        print(f"{r['pair']:<14}{n:>8}{s/n*100:>+10.3f}{w/n*100:>7.1f}%{s*100:>+10.1f}"
              f"{r['hl']:>9.0f}{hl_days:>8.1f}")

    # общий walk-forward по фолдам
    if all_tr:
        n, s, w, pf = _agg(all_tr, args.folds)
        print(f"\n— walk-forward по TEST ({args.folds} фолдов, все пары) —")
        print(f"{'фолд':<8}{'сделок':>8}{'ср/сд%':>10}{'hit%':>8}{'сумма%':>10}")
        pos_folds = 0
        for fi, (fn, fs, fw) in enumerate(pf):
            if not fn:
                print(f"{fi+1:<8}{'0':>8}  —"); continue
            if fs > 0:
                pos_folds += 1
            print(f"{fi+1:<8}{fn:>8}{fs/fn*100:>+10.3f}{fw/fn*100:>7.1f}%{fs*100:>+10.1f}")
        print(f"\nИТОГО: сделок {n}  ср/сд {s/n*100:+.3f}%  hit {w/n*100:.1f}%  "
              f"сумма {s*100:+.1f}%  положительных фолдов {pos_folds}/{args.folds}")
    print("\nвердикт: ср/сд>0, hit>55% И большинство фолдов в плюсе = реверсия спреда "
          "переживает косты OOS во времени, а не один везучий период. Короткий half-life "
          "= настоящая быстрая реверсия (жёсткий якорь работает).")


if __name__ == "__main__":
    main()
