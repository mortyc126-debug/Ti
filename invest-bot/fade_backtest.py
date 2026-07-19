"""
fade_backtest.py — честный бэктест фейд-стратегий из анатомии хода (журнал
docs/MOVE_ANATOMY_FINDINGS.md, этапы #2 и #6).

Идея: резкий ход ≥ move-atr ATR откатывает, если это шум. Входим ПРОТИВ хода
(фейд) и берём откат. Фильтры отбирают «шумные» ходы, которые откатывают сильнее:
  --filter breadth : фейдим идио-ход (рынок тих) или ход ПРОТИВ рынка (#2);
  --filter level   : фейдим ход, упёршийся в прошлый экстремум (реджект, #6);
  --filter both    : оба условия сразу.

Механика — как nw_backtest (честно): вход по close бара, где ход завершился;
тейк/стоп в ATR интрабар (СТОП проверяется первым); БЕЗ перекрытия; реальный
cost; ATR = Wilder(14) как в nw_backtest. Разрез train/test по --split-date,
--liquid-only. Разбивка long/short: фейд роста = шорт, фейд падения = лонг.

Запуск:
    py -3.11 fade_backtest.py --filter breadth --split-date 2026-04-01 --liquid-only
    py -3.11 fade_backtest.py --filter level   --take 0.5 --stop 0.75 --cost 0.05
    py -3.11 fade_backtest.py --filter both --split-date 2026-04-01 --liquid-only
"""
import sys
import os
import glob
import json
import argparse

import numpy as np

from nw_backtest import _atr, _epoch_s, _parse_time, _ticker_liq, _stats


def _cache_dir(arg):
    return arg or os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "candle_cache")


def _load(cache_dir, tk):
    fp = os.path.join(cache_dir, f"{tk}.json")
    if not os.path.exists(fp):
        return None
    try:
        with open(fp, encoding="utf-8") as f:
            rows = json.load(f)
    except (json.JSONDecodeError, OSError):
        return None
    if not isinstance(rows, list) or len(rows) < 300:
        return None
    rows.sort(key=lambda r: r["time"])
    return rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cache", default=None)
    ap.add_argument("--filter", choices=("breadth", "level", "both"), default="breadth")
    ap.add_argument("--m", type=int, default=3, help="окно хода (баров)")
    ap.add_argument("--move-atr", type=float, default=0.5, help="порог резкого хода в ATR")
    ap.add_argument("--take", type=float, default=0.5, help="тейк отката, ATR")
    ap.add_argument("--stop", type=float, default=0.75, help="стоп, ATR")
    ap.add_argument("--maxhold", type=int, default=12, help="макс. удержание, баров")
    ap.add_argument("--cost", type=float, default=0.05, help="издержки за сделку, ATR")
    ap.add_argument("--lvl-window", type=int, default=100, help="окно прошлого диапазона (#6)")
    ap.add_argument("--band", type=float, default=0.5, help="полоса 'в уровень', ATR (#6)")
    ap.add_argument("--split-date", default=None)
    ap.add_argument("--liquid-only", action="store_true")
    ap.add_argument("--tickers", default=None)
    args = ap.parse_args()
    cache = _cache_dir(args.cache)
    m = args.m; maxhold = args.maxhold

    tickers = ([t.strip().upper() for t in args.tickers.split(",")] if args.tickers
               else sorted(os.path.splitext(os.path.basename(fp))[0]
                           for fp in glob.glob(os.path.join(cache, "*.json"))
                           if not os.path.basename(fp).endswith("_1m.json")))
    liq_top = None
    if args.liquid_only and not args.tickers:
        liq = _ticker_liq(cache)
        present = sorted(liq.values())
        thr = present[2 * len(present) // 3] if present else 0
        liq_top = {k for k, v in liq.items() if v >= thr}
        tickers = [t for t in tickers if t.upper() in liq_top]
    if not tickers:
        sys.exit("нет тикеров")

    split_ts = None
    if args.split_date:
        d = _parse_time(args.split_date)
        if not d:
            sys.exit("плохой --split-date")
        split_ts = _epoch_s(args.split_date)

    # серии в память (нужны и для рыночного индекса, и для сима)
    series = {}
    for tk in tickers:
        rows = _load(cache, tk)
        if not rows:
            continue
        cl = np.array([float(r["close"]) for r in rows])
        hi = np.array([float(r["high"]) for r in rows])
        lo = np.array([float(r["low"]) for r in rows])
        tm = [str(r["time"]) for r in rows]
        v = np.full(len(cl), np.nan)
        v[m:] = (cl[m:] - cl[:-m]) / cl[:-m]
        series[tk] = (cl, hi, lo, tm, v)
    if not series:
        sys.exit("не загрузилось ни одного тикера")

    # рыночный индекс-прокси для breadth-фильтра (как accel_breadth)
    market = None; med_absM = 0.0
    if args.filter in ("breadth", "both"):
        by_ts = {}
        for tk, (cl, hi, lo, tm, v) in series.items():
            for i in range(m, len(cl)):
                if np.isfinite(v[i]):
                    by_ts.setdefault(tm[i], []).append(v[i])
        market = {ts: float(np.median(vs)) for ts, vs in by_ts.items() if vs}
        med_absM = float(np.median([abs(x) for x in market.values()])) if market else 0.0
        print(f"рыночный индекс: {len(market)} таймстемпов, медиана |M|={med_absM:.5f}",
              file=sys.stderr)

    pnls, pnls_tr, pnls_te = [], [], []
    dirs, dirs_tr, dirs_te = [], [], []
    n_tk = 0
    for tk, (cl, hi, lo, tm, v) in series.items():
        atr = _atr(hi, lo, cl)
        cep = np.array([_epoch_s(t) for t in tm])
        n = len(cl)
        n_tk += 1
        i = max(m, args.lvl_window, 15)  # ATR(14)+история уровня
        while i < n - 1:
            a = atr[i]
            if not np.isfinite(a) or a <= 0 or not np.isfinite(v[i]):
                i += 1; continue
            move = cl[i] - cl[i - m]
            if abs(move) / a < args.move_atr:
                i += 1; continue
            mdir = 1.0 if move > 0 else -1.0

            passed = True
            if args.filter in ("breadth", "both"):
                M = market.get(tm[i], 0.0)
                if abs(M) < med_absM:
                    pass                       # идио — фейдим
                elif np.sign(M) != mdir:
                    pass                       # против рынка — фейдим
                else:
                    passed = False             # с рынком — не фейдим (моментум)
            if passed and args.filter in ("level", "both"):
                hmax = hi[i - m - args.lvl_window:i - m].max() if i - m - args.lvl_window >= 0 else np.inf
                lmin = lo[i - m - args.lvl_window:i - m].min() if i - m - args.lvl_window >= 0 else -np.inf
                if mdir > 0:
                    in_level = (cl[i] <= hmax) and (hmax - cl[i] < args.band * a)
                else:
                    in_level = (cl[i] >= lmin) and (cl[i] - lmin < args.band * a)
                if not in_level:
                    passed = False
            if not passed:
                i += 1; continue

            dirn = -mdir                        # ФЕЙД: против хода
            entry = cl[i]
            tp = entry + dirn * args.take * a
            sl = entry - dirn * args.stop * a
            exit_j = min(i + maxhold, n - 1)
            px = cl[exit_j]
            for j in range(i + 1, min(i + 1 + maxhold, n)):
                if dirn > 0:
                    if lo[j] <= sl:
                        exit_j = j; px = sl; break
                    if hi[j] >= tp:
                        exit_j = j; px = tp; break
                else:
                    if hi[j] >= sl:
                        exit_j = j; px = sl; break
                    if lo[j] <= tp:
                        exit_j = j; px = tp; break
            pnl = dirn * (px - entry) / a - args.cost
            pnls.append(pnl); dirs.append(dirn)
            if split_ts is not None:
                if cep[i] >= split_ts:
                    pnls_te.append(pnl); dirs_te.append(dirn)
                else:
                    pnls_tr.append(pnl); dirs_tr.append(dirn)
            i = exit_j + 1                       # БЕЗ перекрытия

    if not pnls:
        sys.exit("ноль сделок — проверь фильтр/порог/кэш")

    print(f"\n=== ФЕЙД-бэктест  filter={args.filter}  move≥{args.move_atr} take={args.take}/"
          f"stop={args.stop} cost={args.cost} maxhold={args.maxhold}"
          f"{' liquid-only' if args.liquid_only else ''} ===")
    print(f"тикеров: {n_tk}   (фейд роста = шорт ↓, фейд падения = лонг ↑)")
    _stats("ВСЕ (no-overlap)", pnls, dirs)
    if split_ts is not None:
        _stats(f"TRAIN <{args.split_date}", pnls_tr, dirs_tr)
        _stats(f"TEST ≥{args.split_date}", pnls_te, dirs_te)
    print("\nexp — средний P&L сделки в ATR после издержек. Плюс на TEST = фейд-эдж")
    print("переживает честный учёт. Сравни filter breadth/level/both и take/stop.")


if __name__ == "__main__":
    main()
