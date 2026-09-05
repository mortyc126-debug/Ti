"""ensemble_oos.py — честный OOS-тест ансамбля «универсал-сигналов».

Идея (после пулового regime-прогона score_methods): 5 методов показали
устойчивый ПОЛОЖИТЕЛЬНЫЙ знак d во ВСЕХ 6 режимах, на сотнях тикеров и
десятках тысяч срабатываний — DFA_REGIME, ZSCORE, AMIHUD_SHOCK,
TALIB_ANTISIGNAL, BIPOWER_JUMP. Это не подгонка под один контракт (в отличие
от channel_level_fut). Но пуловый d — same-period cross-section. Здесь гоним
их КОМБО через ту же гильотину, что убила channel_level_fut:
  - равновесный ГОЛОС (без режимных флипов — проще = меньше переобучения):
    net = Σ sign(score_m) по методам с |score_m|≥AGREE; сделка если |net|≥min_votes;
  - ЧЕСТНЫЙ вход: сигнал на close бара i → вход по open[i+1] (рынком),
    выход по close[i+k]; доходность в ATR, минус cost;
  - TRAIN/TEST split по времени внутри тикера — читаем ТОЛЬКО test;
  - разрез test по терцилям ЛИКВИДНОСТИ тикера: бот торгует ликвидные фью,
    а пул показал, что edge сильнее на неликвиде (sp_liq<0) — проверяем,
    держится ли плюс в верхней трети (d_hi), где реально можем стоять.

Look-ahead нет: методы на баре i видят только candles[:i+1], вход — со след.
бара. Формулы методов — те же, что у живого бота (импорт oi_composite_strategy
через воркер score_methods, бит-в-бит).

Запуск (как пуловый, чтобы сопоставимо):
    python ensemble_oos.py ALL --workers 8 --stride 3 --top-liq 60 --only-fut \
        --split-frac 0.7 --cost 0.12 --out data/ens_oos.csv
"""
from __future__ import annotations

import argparse
import csv
import multiprocessing as mp
import os
import re
import sys
import time

for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):
        pass

import score_methods as sm  # переиспользуем воркер-инфраструктуру (методы, кэш, ATR)

_HERE = os.path.dirname(os.path.abspath(__file__))
_FUT_RE = re.compile(r"^[A-Z]{1,4}[FGHJKMNQUVXZ]\d$")

# Универсал-сигналы из пулового regime-прогона (устойчивый + во всех режимах).
DEFAULT_ENSEMBLE = ["DFA_REGIME", "ZSCORE", "AMIHUD_SHOCK",
                    "TALIB_ANTISIGNAL", "BIPOWER_JUMP"]


def _is_future(ticker: str) -> bool:
    return bool(_FUT_RE.match(ticker.upper()))


def _run_ticker(job: dict) -> tuple:
    """Один тикер: ансамблевый голос по барам + честная доходность.
    Возвращает (ticker, rec|None). rec = {liq, vol, is_fut, train/test/all:(n,sum,wins)}."""
    np = sm._WORKER_NP
    ticker = job["ticker"]
    rows = sm._load_from_cache(ticker, job["cache_dir"], job["interval"])
    if not rows:
        return ticker, None
    rows = sm._filter_by_dates(rows, job["date_from"], job["date_to"])
    W = job["window"]; S = job["stride"]; K = job["k"]; AGREE = job["agree_min"]
    MINV = job["min_votes"]; COST = job["cost"]; FRAC = job["split_frac"]
    if len(rows) < W + K + 5:
        return ticker, None

    liq, vol = sm._liq_vol(rows)
    candles = [sm._row_to_ns(r) for r in rows]
    closes = np.array([r["close"] for r in rows], dtype=float)
    opens  = np.array([r["open"]  for r in rows], dtype=float)
    highs  = np.array([r["high"]  for r in rows], dtype=float)
    lows   = np.array([r["low"]   for r in rows], dtype=float)
    atr = sm._atr_sma(highs, lows, job["n_atr"])

    methods = [(n, fn) for n, fn in sm._WORKER_METHODS if n in job["methods"]]
    n = len(candles)
    # позиции: нужен вход по open[i+1] и выход по close[i+k] → i+K ≤ n-1
    positions = range(W, n - K - 1, S)
    split_i = int(n * FRAC)   # бары до split_i — train, после — test

    # аккумуляторы: (n_trades, sum_ret, wins)
    acc = {"train": [0, 0.0, 0], "test": [0, 0.0, 0], "all": [0, 0.0, 0]}
    for i in positions:
        a = atr[i]
        if np.isnan(a) or a <= 0:
            continue
        votes = 0
        for _name, fn in methods:
            try:
                sc = fn(candles[i - W:i + 1])
            except Exception:
                continue
            if sc is None:
                continue
            if sc >= AGREE:
                votes += 1
            elif sc <= -AGREE:
                votes -= 1
        if abs(votes) < MINV:
            continue
        dirn = 1 if votes > 0 else -1
        entry = opens[i + 1]        # честно: вход рынком на след. баре
        exitp = closes[i + K]
        ret = dirn * (exitp - entry) / a - COST
        win = 1 if ret > 0 else 0
        bucket = "train" if i < split_i else "test"
        for b in (bucket, "all"):
            acc[b][0] += 1; acc[b][1] += ret; acc[b][2] += win

    if acc["all"][0] == 0:
        return ticker, None
    rec = {"liq": liq, "vol": vol, "is_fut": _is_future(ticker),
           "train": tuple(acc["train"]), "test": tuple(acc["test"]),
           "all": tuple(acc["all"])}
    return ticker, rec


def _agg(recs, key):
    """Пул по списку rec: суммарные n, exp (sum/n), win%."""
    n = sum(r[key][0] for r in recs)
    s = sum(r[key][1] for r in recs)
    w = sum(r[key][2] for r in recs)
    if n == 0:
        return (0, None, None)
    return (n, s / n, w / n)


def _fmt(t):
    n, exp, win = t
    if not n:
        return f"n={n:<6} —"
    return f"n={n:<6} exp={exp:+.3f} ATR  win={win*100:.1f}%"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("tickers", help="ALL или список через запятую")
    ap.add_argument("--cache", default=os.path.join(_HERE, "data", "candle_cache"))
    ap.add_argument("--interval", type=int, default=5, choices=(1, 5))
    ap.add_argument("--days", type=int, default=180)
    ap.add_argument("--from", dest="date_from", default=None)
    ap.add_argument("--to", dest="date_to", default=None)
    ap.add_argument("--window", type=int, default=300)
    ap.add_argument("--stride", type=int, default=3)
    ap.add_argument("--k", type=int, default=12, help="горизонт (баров) от входа")
    ap.add_argument("--n-atr", type=int, default=20)
    ap.add_argument("--agree-min", type=float, default=0.15)
    ap.add_argument("--min-votes", type=int, default=2,
                     help="мин. |net голос| для сделки (из 5 методов)")
    ap.add_argument("--cost", type=float, default=0.12, help="кост в ATR/сделку")
    ap.add_argument("--split-frac", type=float, default=0.7,
                     help="доля истории в train (читаем test)")
    ap.add_argument("--methods", default=None,
                     help="переопределить ансамбль (через запятую)")
    ap.add_argument("--top-liq", type=int, default=None)
    ap.add_argument("--only-fut", action="store_true")
    ap.add_argument("--workers", type=int, default=None)
    ap.add_argument("--out", default=None, help="CSV per-ticker")
    args = ap.parse_args()

    ens = ([m.strip() for m in args.methods.split(",") if m.strip()]
           if args.methods else DEFAULT_ENSEMBLE)
    ens_set = set(ens)

    if args.date_from or args.date_to:
        date_from, date_to = args.date_from, args.date_to
    else:
        from datetime import datetime, timedelta
        date_to = None
        date_from = (datetime.now() - timedelta(days=args.days)).strftime("%Y-%m-%d")

    if args.tickers.upper() == "ALL":
        tickers = sm._list_tickers(args.cache, args.interval, top_liq=args.top_liq,
                                   workers=args.workers)
    else:
        tickers = [t.strip().upper() for t in args.tickers.split(",") if t.strip()]
    if args.only_fut:
        tickers = [t for t in tickers if _is_future(t)]
    if not tickers:
        sys.exit("нет тикеров после фильтров")

    print(f"[ens] методы: {ens}", file=sys.stderr)
    print(f"[ens] тикеров: {len(tickers)}  min_votes={args.min_votes}  "
          f"cost={args.cost}  split={args.split_frac}  k={args.k}", file=sys.stderr)

    jobs = [{"ticker": t, "cache_dir": args.cache, "interval": args.interval,
             "date_from": date_from, "date_to": date_to, "window": args.window,
             "stride": args.stride, "k": args.k, "n_atr": args.n_atr,
             "agree_min": args.agree_min, "min_votes": args.min_votes,
             "cost": args.cost, "split_frac": args.split_frac,
             "methods": ens_set} for t in tickers]

    n_wk = args.workers or max(1, (mp.cpu_count() or 2) - 1)
    recs = {}
    t0 = time.time()
    done = 0
    if n_wk > 1 and len(jobs) > 1:
        with mp.Pool(processes=n_wk, initializer=sm._init_worker) as pool:
            for ticker, rec in pool.imap_unordered(_run_ticker, jobs, chunksize=1):
                done += 1
                if rec:
                    recs[ticker] = rec
                if done % 10 == 0 or done == len(jobs):
                    print(f"[{done}/{len(jobs)}] {time.time()-t0:.0f}s  "
                          f"с сделками: {len(recs)}", file=sys.stderr)
    else:
        sm._init_worker()
        for j in jobs:
            ticker, rec = _run_ticker(j)
            done += 1
            if rec:
                recs[ticker] = rec

    if not recs:
        sys.exit("нет ни одной сделки на всём наборе")

    rl = list(recs.values())
    print(f"\n=== АНСАМБЛЬ {ens} ===")
    print(f"тикеров со сделками: {len(rl)}  ({sum(r['is_fut'] for r in rl)} фью)")
    print(f"TRAIN : {_fmt(_agg(rl, 'train'))}")
    print(f"TEST  : {_fmt(_agg(rl, 'test'))}   ← судим по нему")
    print(f"ALL   : {_fmt(_agg(rl, 'all'))}")
    n_all = _agg(rl, "all")[0]
    print(f"частота: {n_all/max(len(rl),1):.1f} сделок/тикер за период")

    # Разрез TEST по терцилям ликвидности тикера (бот торгует верхнюю треть).
    liq_recs = [r for r in rl if r["liq"] is not None and r["test"][0] > 0]
    if len(liq_recs) >= 6:
        liq_recs.sort(key=lambda r: r["liq"])
        t = len(liq_recs) // 3
        lo, mid, hi = liq_recs[:t], liq_recs[t:2 * t], liq_recs[2 * t:]
        print("\n=== TEST по ликвидности тикера (терцили) ===")
        print(f"низкая  : {_fmt(_agg(lo, 'test'))}")
        print(f"средняя : {_fmt(_agg(mid, 'test'))}")
        print(f"ВЫСОКАЯ : {_fmt(_agg(hi, 'test'))}   ← где бот реально стоит")

    if args.out:
        os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
        with open(args.out, "w", newline="", encoding="utf-8") as f:
            wr = csv.writer(f)
            wr.writerow(["ticker", "is_fut", "liq_mln", "vol_pct",
                         "test_n", "test_exp", "test_win",
                         "all_n", "all_exp", "all_win"])
            for tk, r in sorted(recs.items()):
                tn, ts, tw = r["test"]; an, as_, aw = r["all"]
                wr.writerow([tk, int(r["is_fut"]),
                             f"{r['liq']:.2f}" if r['liq'] else "",
                             f"{r['vol']:.3f}" if r['vol'] else "",
                             tn, f"{ts/tn:+.4f}" if tn else "",
                             f"{tw/tn:.4f}" if tn else "",
                             an, f"{as_/an:+.4f}" if an else "",
                             f"{aw/an:.4f}" if an else ""])
        print(f"\n[out] {args.out}", file=sys.stderr)


if __name__ == "__main__":
    main()
