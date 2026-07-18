"""
nw_backtest.py — честный бэктест глобально-жёсткой NW-памяти (зона) как стратегии.

Берёт сигнал (p_hold из кросс-тикерного банка в зоне) и торгует его на РЕАЛЬНЫХ
свечах: вход по close, тейк/стоп в ATR интрабар (СТОП проверяется первым —
консервативно), БЕЗ перекрытия (одна позиция на инструмент, пропускаем сигналы
пока в позиции), издержки cost за сделку. Каузальность строгая: аналог годится,
только если его исход реализовался до времени бара (time(analog)+k*bar ≤ time(i)) —
это walk-forward без утечки. Разрез train/test по --split-date и по ликвидности.

Даёт то, чего не давал nw_memory_xtkr: экспектанси НА СДЕЛКУ после запрета
перекрытия и реального тейк/стоп-учёта.

Вход:
  path  — каталог *_tpc.csv (T_hat,P_hat,color_hat,time,target,outcome_known)
  --cache — data/candle_cache (OHLC для симуляции), тикеры по имени файла.

Запуск:
  py -3.11 nw_backtest.py out/per_ticker --zone --radius 0.12 --split-date 2026-04-01
  py -3.11 nw_backtest.py out/per_ticker --zone --radius 0.12 --liquid-only --cost 0.05
"""
import sys
import os
import csv
import json
import glob
import argparse
from datetime import datetime

import numpy as np
from scipy.spatial import cKDTree

_EPOCH = datetime(1970, 1, 1)


def _parse_time(s):
    s = (s or "").strip()
    if not s:
        return None
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    try:
        return datetime.fromisoformat(s).replace(tzinfo=None)
    except ValueError:
        pass
    s = s.replace("T", " ").split("+")[0].split(".")[0].strip()
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%d"):
        try:
            return datetime.strptime(s, fmt)
        except ValueError:
            continue
    return None


def _epoch_s(s):
    d = _parse_time(s)
    return (d - _EPOCH).total_seconds() if d else float("nan")


def _load_tpc(path):
    if os.path.isdir(path):
        files = sorted(glob.glob(os.path.join(path, "*_tpc.csv"))) or sorted(glob.glob(os.path.join(path, "*.csv")))
    else:
        files = [path]
    if not files:
        sys.exit(f"нет CSV в {path}")
    rows = []
    for fp in files:
        tk = os.path.splitext(os.path.basename(fp))[0].replace("_tpc", "").upper()
        with open(fp, newline="", encoding="utf-8") as f:
            for r in csv.DictReader(f):
                rows.append((tk, r))
    return rows, len(files)


def _load_candles(cache_dir, tk):
    for name in (f"{tk}.json", f"{tk.upper()}.json", f"{tk.lower()}.json"):
        fp = os.path.join(cache_dir, name)
        if os.path.exists(fp):
            try:
                with open(fp, encoding="utf-8") as f:
                    rows = json.load(f)
            except (json.JSONDecodeError, OSError):
                return None
            if isinstance(rows, list) and len(rows) > 50:
                rows.sort(key=lambda r: r["time"])
                return rows
    return None


def _atr(h, l, c, n=14):
    tr = np.empty(len(c))
    tr[0] = h[0] - l[0]
    tr[1:] = np.maximum.reduce([h[1:] - l[1:], np.abs(h[1:] - c[:-1]), np.abs(l[1:] - c[:-1])])
    atr = np.full(len(c), np.nan)
    if len(tr) > n:
        atr[n] = tr[1:n + 1].mean()
        for i in range(n + 1, len(tr)):
            atr[i] = (atr[i - 1] * (n - 1) + tr[i]) / n
    return atr


def _ticker_liq(cache_dir):
    liq = {}
    for fp in glob.glob(os.path.join(cache_dir, "*.json")):
        base = os.path.splitext(os.path.basename(fp))[0]
        if base.endswith("_1m"):
            continue
        try:
            with open(fp, encoding="utf-8") as f:
                rows = json.load(f)
        except (json.JSONDecodeError, OSError):
            continue
        if not isinstance(rows, list) or len(rows) < 50:
            continue
        tos = [float(r["volume"]) * float(r["close"]) for r in rows
               if isinstance(r.get("volume"), (int, float)) and isinstance(r.get("close"), (int, float))]
        if tos:
            liq[base.upper()] = float(np.median(tos))
    return liq


def _stats(label, pnls, dirs=None):
    if len(pnls) < 5:
        print(f"{label:>16}: сделок {len(pnls)} (мало)")
        return
    a = np.asarray(pnls)
    print(f"{label:>16}: N={len(a):>6}  exp={a.mean():+.4f} ATR  win={100 * (a > 0).mean():5.1f}%  "
          f"сумма={a.sum():+.1f} ATR")
    # разбивка long/short — проверка, что плюс не только от шортов (бета рынка)
    if dirs is not None:
        d = np.asarray(dirs)
        for sub, lbl in ((d > 0, "  ↑long"), (d < 0, "  ↓short")):
            if sub.sum() >= 5:
                s = a[sub]
                print(f"{lbl:>16}: N={len(s):>6}  exp={s.mean():+.4f} ATR  win={100 * (s > 0).mean():5.1f}%")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("path")
    ap.add_argument("--cache", default=None)
    ap.add_argument("--radius", type=float, default=0.12)
    ap.add_argument("--k", type=int, default=12, help="макс. удержание, баров (горизонт сигнала)")
    ap.add_argument("--min-neighbors", type=int, default=20)
    ap.add_argument("--bar-min", type=int, default=5)
    ap.add_argument("--zone", action="store_true")
    ap.add_argument("--t-max", type=float, default=-0.4)
    ap.add_argument("--p-min", type=float, default=0.6)
    ap.add_argument("--take", type=float, default=1.0, help="тейк, ATR")
    ap.add_argument("--stop", type=float, default=0.5, help="стоп, ATR")
    ap.add_argument("--cost", type=float, default=0.08, help="издержки за сделку, ATR")
    ap.add_argument("--split-date", default=None)
    ap.add_argument("--liquid-only", action="store_true", help="торговать только верхний терциль ликвидности")
    ap.add_argument("--null", choices=("none", "short", "long", "rand"), default="none",
                    help="бенчмарк беты: игнорировать сигнал, входить на КАЖДОМ баре "
                         "в заданном направлении (short/long/rand). Сравни exp с сигналом.")
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--bank", default=None,
                    help="взять сигнал из готового банка .npz через NWMemoryGlobal "
                         "(live-путь). С train-only банком (--split-date в сборщике) и "
                         "--split-date тут = честная OOS-проверка замороженной памяти.")
    args = ap.parse_args()
    bar_s = args.bar_min * 60
    cache = args.cache or os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "candle_cache")

    rows, nfiles = _load_tpc(args.path)
    n = len(rows)
    print(f"tpc: {n} строк из {nfiles} тикеров", file=sys.stderr)

    def col(key):
        out = np.empty(n)
        for idx, (_, r) in enumerate(rows):
            try:
                out[idx] = float(r.get(key, ""))
            except (TypeError, ValueError):
                out[idx] = np.nan
        return out

    T, P, C = col("T_hat"), col("P_hat"), col("color_hat")
    tgt = col("target")
    ok = col("outcome_known")
    ts = np.array([_epoch_s(r.get("time", "")) for _, r in rows])

    # live-путь: сигнал из готового банка .npz (NWMemoryGlobal). Банк заморожен,
    # каузальность обеспечивается тем, что он построен на train (--split-date в сборщике).
    memg = None
    if args.bank:
        from nw_memory_global import NWMemoryGlobal
        memg = NWMemoryGlobal.load(args.bank)
        if memg is None:
            sys.exit(f"не загрузился банк {args.bank} (нет файла/scipy/numpy)")
        print(f"банк (live .npz): {len(memg.y)} точек", file=sys.stderr)
    else:
        # банк аналогов (весь пул, исход известен, валидные координаты, валидное время)
        bank = (ok == 1.0) & ~np.isnan(T) & ~np.isnan(P) & ~np.isnan(C) & ~np.isnan(tgt) & ~np.isnan(ts)
        bi = np.where(bank)[0]
        if len(bi) < args.min_neighbors:
            sys.exit("маленький банк")
        tree = cKDTree(np.column_stack([T[bi], P[bi], C[bi]]))
        b_ts = ts[bi]; b_y = (tgt[bi] > 0).astype(float)
        print(f"банк: {len(bi)} точек", file=sys.stderr)

    split_ts = None
    if args.split_date:
        d = _parse_time(args.split_date)
        if not d:
            sys.exit("плохой --split-date")
        split_ts = (d - _EPOCH).total_seconds()

    # ликвидность
    liq_top = None
    if args.liquid_only:
        liq = _ticker_liq(cache)
        present = sorted(v for k, v in liq.items())
        thr = present[2 * len(present) // 3] if present else 0
        liq_top = {k for k, v in liq.items() if v >= thr}
        print(f"ликвид-терциль: {len(liq_top) if liq_top else 0} тикеров", file=sys.stderr)

    # признаки по тикеру: time -> (T,P,C)
    feat_by_tk = {}
    for idx, (tk, r) in enumerate(rows):
        if np.isnan(T[idx]) or np.isnan(P[idx]) or np.isnan(C[idx]):
            continue
        feat_by_tk.setdefault(tk, {})[r.get("time", "")] = (T[idx], P[idx], C[idx])

    maxhold = args.k
    rng = np.random.default_rng(args.seed)
    pnls, pnls_tr, pnls_te = [], [], []
    dirs, dirs_tr, dirs_te = [], [], []
    n_tk = 0
    for tk in sorted(feat_by_tk):
        if liq_top is not None and tk not in liq_top:
            continue
        cr = _load_candles(cache, tk)
        if not cr:
            continue
        ctime = [r["time"] for r in cr]
        cO = np.array([float(r["open"]) for r in cr])
        cH = np.array([float(r["high"]) for r in cr])
        cL = np.array([float(r["low"]) for r in cr])
        cC = np.array([float(r["close"]) for r in cr])
        atr = _atr(cH, cL, cC)
        cep = np.array([_epoch_s(t) for t in ctime])
        feat = feat_by_tk[tk]
        m = len(cC)
        n_tk += 1
        i = maxhold  # чтобы был ATR и история
        while i < m - 1:
            t = ctime[i]
            if np.isnan(atr[i]) or atr[i] <= 0:
                i += 1; continue
            f = feat.get(t)
            # null без --zone входит на любом баре; с --zone или в сигнале нужен признак
            if f is None and (args.null == "none" or args.zone):
                i += 1; continue
            Tq, Pq, Cq = f if f is not None else (np.nan, np.nan, np.nan)
            if args.null != "none":
                # бенчмарк беты: направление фиксировано. С --zone входит только на
                # зонных барах (matched null — изолирует вклад направления p_hold
                # при том же тайминге зоны), без --zone — на каждом баре (чистая бета).
                if args.zone and not (Tq < args.t_max and Pq > args.p_min):
                    i += 1; continue
                if args.null == "short":
                    dirn = -1.0
                elif args.null == "long":
                    dirn = 1.0
                else:
                    dirn = 1.0 if rng.random() > 0.5 else -1.0
            elif memg is not None:
                # live-путь: голос из замороженного банка (зона/радиус/соседи внутри)
                sc = memg.score_axes(Tq, Pq, Cq)
                if sc == 0.0:
                    i += 1; continue
                dirn = 1.0 if sc > 0 else -1.0
            else:
                if args.zone and not (Tq < args.t_max and Pq > args.p_min):
                    i += 1; continue
                # запрос к банку (каузально)
                cand = tree.query_ball_point([Tq, Pq, Cq], r=args.radius)
                if not cand:
                    i += 1; continue
                cand = np.asarray(cand)
                cand = cand[b_ts[cand] + args.k * bar_s <= cep[i]]
                if len(cand) < args.min_neighbors:
                    i += 1; continue
                p_hold = b_y[cand].mean()
                if p_hold == 0.5:
                    i += 1; continue
                dirn = 1.0 if p_hold > 0.5 else -1.0
            entry = cC[i]; a0 = atr[i]
            tp = entry + dirn * args.take * a0
            sl = entry - dirn * args.stop * a0
            exit_j = min(i + maxhold, m - 1)
            px = cC[exit_j]
            for j in range(i + 1, min(i + 1 + maxhold, m)):
                if dirn > 0:
                    if cL[j] <= sl:
                        exit_j = j; px = sl; break
                    if cH[j] >= tp:
                        exit_j = j; px = tp; break
                else:
                    if cH[j] >= sl:
                        exit_j = j; px = sl; break
                    if cL[j] <= tp:
                        exit_j = j; px = tp; break
            pnl = dirn * (px - entry) / a0 - args.cost
            pnls.append(pnl); dirs.append(dirn)
            if split_ts is not None:
                if cep[i] >= split_ts:
                    pnls_te.append(pnl); dirs_te.append(dirn)
                else:
                    pnls_tr.append(pnl); dirs_tr.append(dirn)
            i = exit_j + 1  # БЕЗ перекрытия

    if not pnls:
        sys.exit("ноль сделок — проверь --cache/зону/радиус")

    tag = []
    if args.zone:
        tag.append(f"zone(T<{args.t_max},P>{args.p_min})")
    if args.liquid_only:
        tag.append("liquid-only")
    if args.null != "none":
        tag.append(f"NULL={args.null}(бета-бенчмарк)")
    if args.bank:
        tag.append("bank=live(.npz)")
    print(f"\n=== NW-бэктест  radius={args.radius} take={args.take}/stop={args.stop} "
          f"cost={args.cost} k={args.k}  {', '.join(tag)} ===")
    print(f"тикеров торговали: {n_tk}")
    _stats("ВСЕ (no-overlap)", pnls, dirs)
    if split_ts is not None:
        _stats(f"TRAIN <{args.split_date}", pnls_tr, dirs_tr)
        _stats(f"TEST ≥{args.split_date}", pnls_te, dirs_te)
    print("\nexp — средний P&L сделки в ATR после издержек. Плюс на TEST при разумном")
    print("cost = сигнал переживает честный учёт входа и no-overlap. Проверь cost 0.05/0.08/0.12.")


if __name__ == "__main__":
    main()
