"""ema_fan.py — веер EMA(20/50/100/200): экстремальное расхождение → схождение.

Идея (её высказала пользовательница): на минутках веер EMA20/50/100/200.
Когда веер МАКСИМАЛЬНО разъехался — ждём схождения (mean-reversion), возврат
к линиям. Фейдим тренд веера: EMA20≫EMA200 (веер вверх) → шорт; ≪ → лонг.
Ложится в единственное, что давало правильный знак в сессии — реверсию/
истощение.

Фича: dispersion = (max−min из EMA20/50/100/200) / close — «раскрытие веера».
dir = −sign(EMA20 − EMA200) — фейд (ставка на схождение).
fwd = (close[i+K] − open[i+1]) / open[i+1] — честный форвард (вход next_open).
signed = dir·fwd (+ = схождение принесло).

Печатает кривую по бинам dispersion (RAW и market-neutral) — растёт ли фейд-
плюс на экстремальном расхождении. + нетто/OOS при dispersion≥порог (--fade-disp),
косты вычтены, train/test по месяцам.

TF: --interval 5 (по умолчанию, что в кэше) или 1 (минутки, если докачаны).
Локальный кэш, без новых зависимостей.

Запуск:
    python ema_fan.py ALL --only-stk --top-liq 40 --days 1500 --k 60
    python ema_fan.py ALL --only-stk --top-liq 40 --k 60 --fade-disp 0.03
"""
from __future__ import annotations

import argparse
import multiprocessing as mp
import os
import re
import sys

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):
        pass

import score_methods as sm

_FUT_RE = re.compile(r"^[A-Z]{1,4}[FGHJKMNQUVXZ]\d$")
# границы бинов dispersion (доля цены): captures хвост
_EDGES = [0.0, 0.0025, 0.005, 0.01, 0.02, 0.03, 0.05, 0.08, 0.12, 1.0]
NB = len(_EDGES) - 1
PERIODS = (20, 50, 100, 200)


def _is_future(t):
    return bool(_FUT_RE.match(t.upper()))


def _ema_series(closes, N):
    a = 2.0 / (N + 1)
    out = [closes[0]]
    for c in closes[1:]:
        out.append(a * c + (1 - a) * out[-1])
    return out


def _bin(disp):
    for b in range(NB):
        if _EDGES[b] <= disp < _EDGES[b + 1]:
            return b
    return NB - 1


def _run(job):
    t = job["ticker"]
    rows = sm._load_from_cache(t, job["cache_dir"], job["interval"])
    if not rows:
        return t, None
    rows = sm._filter_by_dates(rows, job["date_from"], None)
    K, S, warm = job["k"], job["stride"], max(PERIODS) + 5
    n = len(rows)
    if n < warm + K + 5:
        return t, None
    closes = [r["close"] for r in rows]
    opens = [r["open"] for r in rows]
    emas = {N: _ema_series(closes, N) for N in PERIODS}
    perbin = {}                # b -> [n, Σdir·fwd, wins]
    mn = {}                    # "ym|b" -> [n, Σdir·fwd, Σdir]
    mtot = {}                  # ym -> [n_all, Σfwd]
    for i in range(warm, n - K - 1, S):
        c = closes[i]
        if c <= 0 or opens[i + 1] <= 0 or closes[i + K] <= 0:
            continue
        vals = [emas[N][i] for N in PERIODS]
        disp = (max(vals) - min(vals)) / c
        fan = emas[20][i] - emas[200][i]
        if fan == 0:
            continue
        d = -1 if fan > 0 else 1          # фейд веера (ставка на схождение)
        b = _bin(disp)
        fwd = (closes[i + K] - opens[i + 1]) / opens[i + 1]
        df = d * fwd
        ym = rows[i + 1]["time"][:7]
        pb = perbin.setdefault(b, [0, 0.0, 0])
        pb[0] += 1; pb[1] += df; pb[2] += 1 if df > 0 else 0
        m = mn.setdefault(f"{ym}|{b}", [0, 0.0, 0])
        m[0] += 1; m[1] += df; m[2] += d
        mt = mtot.setdefault(ym, [0, 0.0])
        mt[0] += 1; mt[1] += fwd
    if not perbin:
        return t, None
    return t, {"perbin": perbin, "mn": mn, "mtot": mtot}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("tickers")
    ap.add_argument("--cache", default=os.path.join(os.path.dirname(
        os.path.abspath(__file__)), "data", "candle_cache"))
    ap.add_argument("--interval", type=int, default=5, choices=(1, 5))
    ap.add_argument("--days", type=int, default=1500)
    ap.add_argument("--k", type=int, default=60, help="горизонт форварда, баров")
    ap.add_argument("--stride", type=int, default=3)
    ap.add_argument("--top-liq", type=int, default=40)
    ap.add_argument("--only-stk", action="store_true")
    ap.add_argument("--only-fut", action="store_true")
    ap.add_argument("--fade-disp", type=float, default=None,
                     help="порог dispersion (доля цены): нетто+OOS фейда при веере≥порог")
    ap.add_argument("--cost", type=float, default=0.001, help="кост round-trip в долях")
    ap.add_argument("--workers", type=int, default=None)
    args = ap.parse_args()

    from datetime import datetime, timedelta
    date_from = (datetime.now() - timedelta(days=args.days)).strftime("%Y-%m-%d")
    if args.tickers.upper() == "ALL":
        tickers = sm._list_tickers(args.cache, args.interval, top_liq=args.top_liq,
                                   workers=args.workers)
    else:
        tickers = [x.strip().upper() for x in args.tickers.split(",") if x.strip()]
    if args.only_stk:
        tickers = [t for t in tickers if not _is_future(t)]
    if args.only_fut:
        tickers = [t for t in tickers if _is_future(t)]
    if not tickers:
        sys.exit("нет тикеров")
    print(f"[emafan] тикеров: {len(tickers)}  TF={args.interval}м  k={args.k}", file=sys.stderr)

    jobs = [{"ticker": t, "cache_dir": args.cache, "interval": args.interval,
             "date_from": date_from, "k": args.k, "stride": args.stride} for t in tickers]
    nwk = args.workers or max(1, (mp.cpu_count() or 2) - 1)
    recs = []
    with mp.Pool(nwk) as pool:
        for _t, r in pool.imap_unordered(_run, jobs, chunksize=1):
            if r:
                recs.append(r)
    if not recs:
        sys.exit("нет данных")

    PB = {}
    for r in recs:
        for b, v in r["perbin"].items():
            a = PB.setdefault(b, [0, 0.0, 0])
            a[0] += v[0]; a[1] += v[1]; a[2] += v[2]
    MT = {}
    for r in recs:
        for ym, v in r["mtot"].items():
            a = MT.setdefault(ym, [0, 0.0])
            a[0] += v[0]; a[1] += v[1]
    mkt = {ym: (v[1] / v[0] if v[0] else 0.0) for ym, v in MT.items()}
    NEU = {}
    for r in recs:
        for mk, v in r["mn"].items():
            ym, b = mk.split("|"); b = int(b)
            a = NEU.setdefault(b, [0, 0.0])
            a[0] += v[0]; a[1] += v[1] - mkt.get(ym, 0.0) * v[2]

    print(f"\n=== ВЕЕР EMA{PERIODS}: разброс → фейд·форвард, k={args.k}, TF={args.interval}м ===")
    print(f"{'disp бин':<14}{'n':>10}{'RAW ср%':>10}{'RAW hit':>9}{'NEU ср%':>10}")
    for b in range(NB):
        p = PB.get(b)
        if not p or not p[0]:
            continue
        nb = NEU.get(b, [0, 0.0])
        raw = p[1] / p[0] * 100; hit = p[2] / p[0] * 100
        neu = (nb[1] / nb[0] * 100) if nb[0] else 0.0
        print(f"{_EDGES[b]*100:.2f}-{_EDGES[b+1]*100:.2f}% {p[0]:>10}{raw:>+10.4f}"
              f"{hit:>8.1f}%{neu:>+10.4f}")
    print("\nчитать: если фейд·форвард растёт с разбросом веера (плюс на широком "
          "веере) — экстремальное расхождение действительно сходится (гипотеза). "
          "Плоско/минус — веер не предсказывает схождение.")

    if args.fade_disp is not None:
        thr = _bin(args.fade_disp)
        C = args.cost
        by_ym = {}
        for r in recs:
            for mk, v in r["mn"].items():
                ym, b = mk.split("|")
                if int(b) < thr:
                    continue
                a = by_ym.setdefault(ym, [0, 0.0, 0])
                a[0] += v[0]; a[1] += v[1]; a[2] += v[2]
        chrono = sorted(by_ym)
        cut = int(len(chrono) * 0.7)
        splits = {"TRAIN": chrono[:cut], "TEST": chrono[cut:]}
        print(f"\n=== ФЕЙД при разбросе≥{args.fade_disp*100:.1f}% (нетто cost {C*100:.2f}%, "
              f"train {cut}м / test {len(chrono)-cut}м) ===")
        print(f"{'сплит':<8}{'n':>9}{'gross%':>11}{'RAW net%':>11}{'NEU net%':>11}")
        for lbl, ms in splits.items():
            nn = 0; sdf = 0.0; sneu = 0.0
            for ym in ms:
                a = by_ym[ym]
                nn += a[0]; sdf += a[1]; sneu += a[1] - mkt.get(ym, 0.0) * a[2]
            if not nn:
                print(f"{lbl:<8} —"); continue
            print(f"{lbl:<8}{nn:>9}{sdf/nn*100:>+11.4f}{(sdf/nn-C)*100:>+11.4f}"
                  f"{(sneu/nn-C)*100:>+11.4f}")
        print("\nвердикт: TEST net% > 0 → схождение веера переживает косты OOS.")


if __name__ == "__main__":
    main()
