"""purity_curve.py — кривая «чистота хода (ER) → форвард-доходность».

Гипотеза (её высказала пользовательница): связь чистоты пути с будущим
движением НЕМОНОТОННА. Ниже случайной чистоты — шум; умеренная (выше
случайной) — сигнал (тренд продолжается, momentum); очень высокая —
анти (движение истощилось → разворот, mean-reversion). Смена знака.

Следствие: метод, срабатывающий на всех уровнях чистоты, усредняет + и −
→ нетто ноль (что мы и видели везде). Условие на ER может их разделить.

Тест: на каждом баре
  ER   = efficiency_ratio(closes[i-P:i+1], P)   ∈[0,1], чистота пути
  dir  = sign(close[i] − close[i-P])            направление недавнего тренда
  fwd  = (close[i+K] − open[i+1]) / open[i+1]    честный форвард (вход next_open)
Бьём по бинам ER (0.0-0.1, …, 0.9-1.0), в каждом — средняя dir·fwd и hit.
Форма «+ в середине, − на высоких ER» = гипотеза верна.

RAW = сырая dir·fwd. NEU = рыночно-нейтральная (dir·(fwd − market[месяц])),
market[ym] = средняя fwd по всем барам месяца (снимаем макро-прилив).

Локальный кэш свечей, без новых зависимостей.

Запуск:
    python purity_curve.py ALL --only-stk --top-liq 40 --days 1500 --er-period 20 --k 48
"""
from __future__ import annotations

import argparse
import multiprocessing as mp
import os
import sys

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):
        pass

import score_methods as sm
import re

_FUT_RE = re.compile(r"^[A-Z]{1,4}[FGHJKMNQUVXZ]\d$")
NB = 10   # число бинов ER (0..1)


def _is_future(t):
    return bool(_FUT_RE.match(t.upper()))


def _er(closes, i, P):
    w = closes[i - P:i + 1]
    chg = abs(w[-1] - w[0])
    vol = sum(abs(w[j] - w[j - 1]) for j in range(1, len(w))) or 1e-9
    return chg / vol


def _run(job):
    t = job["ticker"]
    rows = sm._load_from_cache(t, job["cache_dir"], job["interval"])
    if not rows:
        return t, None
    rows = sm._filter_by_dates(rows, job["date_from"], None)
    P, K, S = job["er_period"], job["k"], job["stride"]
    n = len(rows)
    if n < P + K + 5:
        return t, None
    closes = [r["close"] for r in rows]
    opens = [r["open"] for r in rows]
    # perbin[b] = [n, sum_dirfwd, wins];  mn[(ym,b)] = [n, sum_dirfwd, sum_dir];
    # mtot[ym] = [n_all, sum_fwd_all]
    perbin = {}
    mn = {}
    mtot = {}
    for i in range(P, n - K - 1, S):
        c0, cP = closes[i], closes[i - P]
        if cP <= 0 or closes[i + K] <= 0 or opens[i + 1] <= 0:
            continue
        d = 1 if c0 > cP else (-1 if c0 < cP else 0)
        if d == 0:
            continue
        er = _er(closes, i, P)
        b = min(NB - 1, int(er * NB))
        fwd = (closes[i + K] - opens[i + 1]) / opens[i + 1]
        df = d * fwd
        ym = rows[i + 1]["time"][:7]
        pb = perbin.setdefault(b, [0, 0.0, 0])
        pb[0] += 1; pb[1] += df; pb[2] += 1 if df > 0 else 0
        mk = f"{ym}|{b}"
        m = mn.setdefault(mk, [0, 0.0, 0])
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
    ap.add_argument("--er-period", type=int, default=20)
    ap.add_argument("--k", type=int, default=48, help="горизонт форварда, баров")
    ap.add_argument("--stride", type=int, default=3)
    ap.add_argument("--top-liq", type=int, default=40)
    ap.add_argument("--only-stk", action="store_true")
    ap.add_argument("--only-fut", action="store_true")
    ap.add_argument("--workers", type=int, default=None)
    ap.add_argument("--fade-er", type=float, default=None,
                     help="порог ER: тест ФЕЙДА (против тренда) на барах с ER≥порог, "
                          "нетто+OOS (train/test по месяцам)")
    ap.add_argument("--cost", type=float, default=0.001,
                     help="кост round-trip в долях для fade-нетто (0.001=0.1%)")
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
    print(f"[purity] тикеров: {len(tickers)}  ER-period={args.er_period}  k={args.k}",
          file=sys.stderr)

    jobs = [{"ticker": t, "cache_dir": args.cache, "interval": args.interval,
             "date_from": date_from, "er_period": args.er_period, "k": args.k,
             "stride": args.stride} for t in tickers]
    nwk = args.workers or max(1, (mp.cpu_count() or 2) - 1)
    recs = []
    with mp.Pool(nwk) as pool:
        for _t, r in pool.imap_unordered(_run, jobs, chunksize=1):
            if r:
                recs.append(r)
    if not recs:
        sys.exit("нет данных")

    # RAW по бинам
    PB = {}
    for r in recs:
        for b, v in r["perbin"].items():
            a = PB.setdefault(b, [0, 0.0, 0])
            a[0] += v[0]; a[1] += v[1]; a[2] += v[2]
    # market[ym]
    MT = {}
    for r in recs:
        for ym, v in r["mtot"].items():
            a = MT.setdefault(ym, [0, 0.0])
            a[0] += v[0]; a[1] += v[1]
    mkt = {ym: (v[1] / v[0] if v[0] else 0.0) for ym, v in MT.items()}
    # NEU по бинам: Σ dir·fwd − market[ym]·Σ dir
    NEU = {}
    for r in recs:
        for mk, v in r["mn"].items():
            ym, b = mk.split("|"); b = int(b)
            a = NEU.setdefault(b, [0, 0.0])
            a[0] += v[0]
            a[1] += v[1] - mkt.get(ym, 0.0) * v[2]

    print(f"\n=== КРИВАЯ ЧИСТОТЫ (ER) → dir·форвард, k={args.k} ===")
    print(f"{'ER бин':<12}{'n':>9}{'RAW ср%':>10}{'RAW hit':>9}{'NEU ср%':>10}")
    for b in range(NB):
        p = PB.get(b)
        if not p or not p[0]:
            continue
        nb = NEU.get(b, [0, 0.0])
        raw = p[1] / p[0] * 100
        hit = p[2] / p[0] * 100
        neu = (nb[1] / nb[0] * 100) if nb[0] else 0.0
        lo = b / NB; hi = (b + 1) / NB
        print(f"{lo:.1f}-{hi:.1f}      {p[0]:>9}{raw:>+10.4f}{hit:>8.1f}%{neu:>+10.4f}")
    print("\nчитать: если RAW/NEU растёт от нуля к середине ER, а на высоких ER "
          "уходит в МИНУС — гипотеза верна: умеренная чистота = momentum, "
          "экстремальная = разворот (fade). Тогда сигнал = знак, зависящий от ER.")

    if args.fade_er is not None:
        # ФЕЙД (против тренда) на барах ER≥порог: нетто + OOS. fade = −dir·fwd.
        # Данные из mn[(ym,b)]=[n, Σdir·fwd, Σdir]; берём бины b≥thr_bin.
        thr = int(args.fade_er * NB)
        C = args.cost
        by_ym = {}   # ym -> [n, Σdir·fwd, Σdir]
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
        print(f"\n=== ФЕЙД при ER≥{args.fade_er} (нетто cost {C*100:.2f}%, "
              f"train {cut}мес / test {len(chrono)-cut}мес) ===")
        print(f"{'сплит':<8}{'n':>9}{'RAW ф.gross%':>14}{'RAW net%':>11}"
              f"{'NEU net%':>11}")
        for lbl, ms in splits.items():
            n = 0; sdf = 0.0; sneu = 0.0
            for ym in ms:
                a = by_ym[ym]
                n += a[0]
                sdf += a[1]                       # Σ dir·fwd
                sneu += a[1] - mkt.get(ym, 0.0) * a[2]
            if not n:
                print(f"{lbl:<8} —"); continue
            fade_raw = -sdf / n                   # фейд = минус follow
            fade_neu = -sneu / n
            print(f"{lbl:<8}{n:>9}{fade_raw*100:>+14.4f}{(fade_raw-C)*100:>+11.4f}"
                  f"{(fade_neu-C)*100:>+11.4f}")
        print("\nвердикт: TEST RAW/NEU net% > 0 → фейд-истощение переживает косты "
              "OOS (рабочий mean-reversion edge). ≤0 → съедается костами.")


if __name__ == "__main__":
    main()
