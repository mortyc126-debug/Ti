"""
zonefade_backtest.py — простая стратегия взамен NW + статистика значимости.

Итог аудита NW (docs/NW_MEMORY_FINDINGS): весь edge NW — это mean-reversion в зоне
lowT-highP + гейты; аналог-память (банк/KDTree) избыточна. Тут — та стратегия НАПРЯМУЮ,
без банка:
  сетап   : зона T_hat<t_max & P_hat>p_min (из tpc; T/P считаются из свечей);
  вход    : ФЕЙД хода 3 баров (против последнего движения);
  гейты   : против+идио рынка (breadth) + боковик (ER-60<0.3);
  выход   : R:R 2:1 (тейк 2.0/стоп 1.0 ATR), тайм-выход 12 баров, no-overlap, cost.
--no-zone торгует на всех барах (зона концентрирует ~+35%, но не обязательна).

Плюс проверки значимости (чек-лист Приоритет 5):
  --boot B : block-bootstrap CI (ресэмпл по ДНЯМ) — стабилен ли exp или на паре дней;
  --perm P : permutation — бьёт ли фейд-направление СЛУЧАЙНОЕ направление на тех же
             сетапах (иначе направление ничего не решает).

Запуск:
    py -3.11 zonefade_backtest.py out/per_ticker --split-date 2026-04-01 --liquid-only \
        --gate-breadth --gate-trend --boot 500 --perm 500
"""
import sys
import os
import argparse
from datetime import datetime

import numpy as np

from nw_backtest import _atr, _epoch_s, _parse_time, _ticker_liq, _load_candles, _load_tpc, _stats


def _sim(cH, cL, cC, i, entry, a0, dirn, take, stop, maxhold, m, cost):
    """P&L одной сделки от бара i: тейк/стоп в ATR интрабар (стоп первым), тайм-выход."""
    tp = entry + dirn * take * a0
    sl = entry - dirn * stop * a0
    exit_j = min(i + maxhold, m - 1)
    px = cC[exit_j]
    for j in range(i + 1, min(i + 1 + maxhold, m)):
        if dirn > 0:
            if cL[j] <= sl:
                px = sl; exit_j = j; break
            if cH[j] >= tp:
                px = tp; exit_j = j; break
        else:
            if cH[j] >= sl:
                px = sl; exit_j = j; break
            if cL[j] <= tp:
                px = tp; exit_j = j; break
    return dirn * (px - entry) / a0 - cost, exit_j


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("path")
    ap.add_argument("--cache", default=None)
    ap.add_argument("--t-max", type=float, default=-0.4)
    ap.add_argument("--p-min", type=float, default=0.6)
    ap.add_argument("--no-zone", action="store_true")
    ap.add_argument("--take", type=float, default=2.0)
    ap.add_argument("--stop", type=float, default=1.0)
    ap.add_argument("--maxhold", type=int, default=12)
    ap.add_argument("--cost", type=float, default=0.05)
    ap.add_argument("--gate-breadth", action="store_true")
    ap.add_argument("--gate-trend", action="store_true")
    ap.add_argument("--split-date", default=None)
    ap.add_argument("--liquid-only", action="store_true")
    ap.add_argument("--boot", type=int, default=0, help="итераций block-bootstrap CI (по дням)")
    ap.add_argument("--perm", type=int, default=0, help="итераций permutation (случайное направление)")
    ap.add_argument("--seed", type=int, default=0)
    args = ap.parse_args()
    cache = args.cache or os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "candle_cache")
    rng = np.random.default_rng(args.seed)

    rows, nfiles = _load_tpc(args.path)
    n = len(rows)
    T = np.empty(n); P = np.empty(n)
    for idx, (_, r) in enumerate(rows):
        try: T[idx] = float(r.get("T_hat", ""))
        except (TypeError, ValueError): T[idx] = np.nan
        try: P[idx] = float(r.get("P_hat", ""))
        except (TypeError, ValueError): P[idx] = np.nan
    feat = {}
    for idx, (tk, r) in enumerate(rows):
        if not (np.isnan(T[idx]) or np.isnan(P[idx])):
            feat.setdefault(tk, {})[r.get("time", "")] = (T[idx], P[idx])

    liq_top = None
    if args.liquid_only:
        liq = _ticker_liq(cache)
        present = sorted(liq.values())
        thr = present[2 * len(present) // 3] if present else 0
        liq_top = {k for k, v in liq.items() if v >= thr}
    traded = [tk for tk in sorted(feat) if liq_top is None or tk in liq_top]

    split_ts = _epoch_s(args.split_date) if args.split_date else None

    # рыночный индекс для breadth-гейта
    market = {}; med_absM = 0.0; cand_cache = {}
    if args.gate_breadth:
        by_ts = {}
        for tk in traded:
            cr = _load_candles(cache, tk)
            if not cr:
                continue
            cand_cache[tk] = cr
            cc = np.array([float(r["close"]) for r in cr]); tms = [r["time"] for r in cr]
            for j in range(3, len(cc)):
                if cc[j - 3] > 0:
                    by_ts.setdefault(tms[j], []).append(cc[j] / cc[j - 3] - 1.0)
        market = {ts: float(np.median(v)) for ts, v in by_ts.items() if v}
        med_absM = float(np.median([abs(x) for x in market.values()])) if market else 0.0

    # сделки: pnl при фактическом направлении + при лонге/шорте (для permutation) + день + сегмент
    P_act, P_long, P_short, days, is_te, dirs = [], [], [], [], [], []
    n_tk = 0
    for tk in traded:
        cr = cand_cache.get(tk) or _load_candles(cache, tk)
        if not cr:
            continue
        ctime = [r["time"] for r in cr]
        cH = np.array([float(r["high"]) for r in cr]); cL = np.array([float(r["low"]) for r in cr])
        cC = np.array([float(r["close"]) for r in cr])
        atr = _atr(cH, cL, cC); cep = np.array([_epoch_s(t) for t in ctime])
        ft = feat[tk]; m = len(cC); n_tk += 1
        i = args.maxhold
        while i < m - 1:
            a0 = atr[i]
            if not np.isfinite(a0) or a0 <= 0:
                i += 1; continue
            f = ft.get(ctime[i])
            if not args.no_zone:
                if f is None:
                    i += 1; continue
                if not (f[0] < args.t_max and f[1] > args.p_min):
                    i += 1; continue
            mv = cC[i] - cC[i - 3]
            if mv == 0:
                i += 1; continue
            dirn = -1.0 if mv > 0 else 1.0          # ФЕЙД хода
            if args.gate_trend and i >= 60:
                den = np.abs(np.diff(cC[i - 60:i + 1])).sum()
                if den > 0 and abs(cC[i] - cC[i - 60]) / den >= 0.3:
                    i += 1; continue
            if args.gate_breadth:
                Mg = market.get(ctime[i])
                if Mg is not None and abs(Mg) >= med_absM and np.sign(Mg) == dirn:
                    i += 1; continue
            entry = cC[i]
            pl, _ = _sim(cH, cL, cC, i, entry, a0, 1.0, args.take, args.stop, args.maxhold, m, args.cost)
            ps, ej = _sim(cH, cL, cC, i, entry, a0, -1.0, args.take, args.stop, args.maxhold, m, args.cost)
            pact = pl if dirn > 0 else ps
            P_act.append(pact); P_long.append(pl); P_short.append(ps); dirs.append(dirn)
            days.append(datetime.utcfromtimestamp(cep[i]).strftime("%Y-%m-%d") if np.isfinite(cep[i]) else "?")
            is_te.append(split_ts is not None and cep[i] >= split_ts)
            # шаг: до выхода фактической сделки (no-overlap)
            _, ej_act = _sim(cH, cL, cC, i, entry, a0, dirn, args.take, args.stop, args.maxhold, m, args.cost)
            i = ej_act + 1

    if not P_act:
        sys.exit("ноль сделок — проверь зону/гейты/кэш")
    P_act = np.array(P_act); P_long = np.array(P_long); P_short = np.array(P_short)
    days = np.array(days); is_te = np.array(is_te); dirs = np.array(dirs)

    tag = ("zone " if not args.no_zone else "NO-zone ") + \
          ("gate:против+идио " if args.gate_breadth else "") + ("gate:боковик " if args.gate_trend else "")
    print(f"\n=== ЗОНА-ФЕЙД  take={args.take}/stop={args.stop} cost={args.cost} maxhold={args.maxhold} "
          f"{'liquid ' if args.liquid_only else ''}{tag}===")
    print(f"тикеров: {n_tk}")
    _stats("ВСЕ (no-overlap)", P_act, dirs)
    if split_ts is not None:
        _stats("TRAIN", P_act[~is_te], dirs[~is_te])
        _stats("TEST", P_act[is_te], dirs[is_te])

    # анализируем TEST (или ВСЕ без сплита)
    seg = is_te if split_ts is not None else np.ones(len(P_act), bool)
    a = P_act[seg]; dd = days[seg]; segname = "TEST" if split_ts is not None else "ВСЕ"
    obs = a.mean()

    if args.boot and len(a) > 20:
        uniq = np.unique(dd); byday = {d: np.where(dd == d)[0] for d in uniq}
        exps = np.empty(args.boot)
        for b in range(args.boot):
            pick = rng.choice(uniq, size=len(uniq), replace=True)   # ресэмпл ДНЕЙ
            idx = np.concatenate([byday[d] for d in pick])
            exps[b] = a[idx].mean()
        lo, md, hi = np.percentile(exps, [5, 50, 95])
        verdict = "ЗНАЧИМ + (CI выше 0)" if lo > 0 else ("ЗНАЧИМ − (CI ниже 0)" if hi < 0 else "НЕ значим (CI включает 0)")
        print(f"\nblock-bootstrap CI ({segname}, {len(uniq)} дней, {args.boot} итер):")
        print(f"  exp={obs:+.4f}  90% CI [{lo:+.4f}, {hi:+.4f}]  {verdict}")

    if args.perm and len(a) > 20:
        pl = P_long[seg]; ps = P_short[seg]
        null = np.empty(args.perm)
        for pi in range(args.perm):
            rd = rng.random(len(pl)) > 0.5                          # случайное направление
            null[pi] = np.where(rd, pl, ps).mean()
        pval = float((null >= obs).mean())
        print(f"\npermutation ({segname}, случайное направление, {args.perm} итер):")
        print(f"  наблюдаемый exp={obs:+.4f}  null среднее={null.mean():+.4f}  "
              f"p-value={pval:.3f}  {'ЗНАЧИМ (p<0.05)' if pval < 0.05 else 'НЕ значим'}")
        print(f"  → фейд-направление {'БЬЁТ' if pval < 0.05 else 'НЕ бьёт'} случайное на тех же сетапах")


if __name__ == "__main__":
    main()
