"""
accel_excursion.py — АНАТОМИЯ хода, а не сальдо отрезка.

Критика к accel_persistence: там только concы окна (close[i+h]-close[i]) —
не видно, КОГДА развернулось, и «разворот» бинарный (мелкий откат = полный
перелом). Здесь для каждого сигнала (бар с ускорением по движению) идём вперёд
и меряем ТРАЕКТОРИЮ в ATR:

  MFE      — максимальный ход ПО направлению (докуда добежал), ATR
  t_peak   — время до пика (когда движение выдохлось), мин
  retrace  — сколько ATR отдал от пика (глубина отката)
  rev_frac — доля MFE, отданная назад (0 = удержал, 1 = вернул весь ход)
  MAE_post — как далеко ушёл ПРОТИВ входа ПОСЛЕ пика (ATR)
  P(перелом) — доля, где после пика цена ушла за вход больше чем на --rev-atr

Гипотеза (пользователь): сильный ход + мелкие откаты → раньше пик и глубже
перелом. Таблица по вёдрам ускорения это и показывает.

--min-run R: считать только эпизоды, добежавшие ≥R ATR по ходу (анатомия
реальных «выносов»; это ОПИСАТЕЛЬНО — MFE наперёд не известен). При 0 — все
сигналы (предиктивно-честно: сколько типично пробегает данное ускорение).

Данные — общий candle_cache (как score_methods).

Запуск:
    py -3.11 accel_excursion.py --interval 5 --maxh 1440
    py -3.11 accel_excursion.py --interval 5 --min-run 1.0     # только реальные выносы
    py -3.11 accel_excursion.py --interval 5 --counter
"""
import os
import sys
import json
import glob
import argparse

import numpy as np

BUCKETS = [(0.0, 0.5), (0.5, 1.0), (1.0, 2.0), (2.0, 3.0), (3.0, 5.0), (5.0, 1e9)]
BUCKET_LBL = ["<0.5", "0.5-1", "1-2", "2-3", "3-5", ">5"]


def _cache_dir(arg):
    return arg or os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "candle_cache")


def _list_tickers(cache_dir, interval):
    out = []
    for fp in glob.glob(os.path.join(cache_dir, "*.json")):
        base = os.path.splitext(os.path.basename(fp))[0]
        if interval == 1 and base.endswith("_1m"):
            out.append(base[:-3])
        elif interval == 5 and not base.endswith("_1m"):
            out.append(base)
    return sorted(out)


def _load(cache_dir, ticker, interval):
    suffix = "" if interval == 5 else f"_{interval}m"
    path = os.path.join(cache_dir, f"{ticker}{suffix}.json")
    if not os.path.exists(path):
        return None
    try:
        with open(path, encoding="utf-8") as f:
            rows = json.load(f)
    except (json.JSONDecodeError, OSError):
        return None
    if not isinstance(rows, list) or len(rows) < 300:
        return None
    rows.sort(key=lambda r: r["time"])
    return rows


def _atr(highs, lows, closes, n=14):
    tr = np.empty(len(closes))
    tr[0] = highs[0] - lows[0]
    tr[1:] = np.maximum.reduce([highs[1:] - lows[1:],
                                np.abs(highs[1:] - closes[:-1]),
                                np.abs(lows[1:] - closes[:-1])])
    atr = np.full(len(closes), np.nan)
    if len(tr) > n:
        atr[n] = tr[1:n + 1].mean()
        for i in range(n + 1, len(tr)):
            atr[i] = (atr[i - 1] * (n - 1) + tr[i]) / n
    return atr


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cache", default=None)
    ap.add_argument("--interval", type=int, default=5, choices=(1, 5))
    ap.add_argument("--maxh", type=int, default=1440, help="окно вперёд, минут")
    ap.add_argument("--m", type=int, default=3, help="окно скорости/ускорения (баров)")
    ap.add_argument("--ewma-hl", type=int, default=50)
    ap.add_argument("--rev-atr", type=float, default=1.0, help="порог 'перелома': уход за вход, ATR")
    ap.add_argument("--giveback", type=float, default=1.0, help="откат от пика (ATR), считающийся концом хода (трейлинг-стоп)")
    ap.add_argument("--atr-period", type=int, default=50, help="период ATR для нормировки (медленный = не раздут спайком)")
    ap.add_argument("--post", type=int, default=120, help="окно ПОСЛЕ пика для замера разворота, мин")
    ap.add_argument("--min-run", type=float, default=0.0, help="считать только эпизоды с MFE≥R ATR (описательно)")
    ap.add_argument("--counter", action="store_true", help="ускорение против движения")
    ap.add_argument("--tickers", default=None)
    ap.add_argument("--sample", type=int, default=200000, help="сигналов в выборку (0=все, медленно)")
    ap.add_argument("--min-count", type=int, default=200)
    args = ap.parse_args()

    cache = _cache_dir(args.cache)
    W = max(1, round(args.maxh / args.interval))
    tickers = ([t.strip().upper() for t in args.tickers.split(",")] if args.tickers
               else _list_tickers(cache, args.interval))
    if not tickers:
        sys.exit(f"нет тикеров в {cache} (interval={args.interval})")
    nb = len(BUCKETS)
    edges = [b for _, b in BUCKETS[:-1]]
    hl_a = 1.0 - 0.5 ** (1.0 / args.ewma_hl)
    m = args.m
    rng = np.random.default_rng(0)
    # на тикер берём долю сигналов, чтобы суммарно ~= sample
    acc = [dict(tpeak=[], mfe=[], rfrac=[], mae=[], rev=[], dip=[]) for _ in range(nb)]
    n_tk = 0

    for tk in tickers:
        rows = _load(cache, tk, args.interval)
        if not rows:
            continue
        cl = np.array([float(r["close"]) for r in rows])
        hi = np.array([float(r["high"]) for r in rows])
        lo = np.array([float(r["low"]) for r in rows])
        n = len(cl)
        if n < 2 * m + W + 5:
            continue
        n_tk += 1
        v = np.full(n, np.nan); v[m:] = (cl[m:] - cl[:-m]) / cl[:-m]
        a = np.full(n, np.nan); a[2 * m:] = v[2 * m:] - v[m:-m]
        base = np.full(n, np.nan); b = None
        for i in range(n):
            if np.isnan(a[i]):
                continue
            x = abs(a[i]); b = x if b is None else hl_a * x + (1 - hl_a) * b; base[i] = b
        prev = np.roll(base, 1)
        an = np.full(n, np.nan)
        good = ~np.isnan(a) & ~np.isnan(prev) & (prev > 0)
        an[good] = np.abs(a[good]) / prev[good]
        atr = _atr(hi, lo, cl, args.atr_period)  # медленный ATR — не раздут спайком
        d = np.sign(v)
        pro = np.sign(a) == d
        want = pro if not args.counter else ~pro
        sig = np.where(good & (d != 0) & (atr > 0) & want & ~np.isnan(an))[0]
        sig = sig[sig + W < n]
        if len(sig) == 0:
            continue
        # подвыборка на тикер
        if args.sample:
            per = max(1, args.sample // max(1, len(tickers)))
            if len(sig) > per:
                sig = rng.choice(sig, per, replace=False)
        bi = np.digitize(an, edges)
        G = args.giveback
        post_bars = max(1, round(args.post / args.interval))
        for i in sig:
            a0 = atr[i]
            fav = (cl[i + 1:i + 1 + W] - cl[i]) * d[i] / a0   # ход ПО направлению, ATR
            L = fav.shape[0]
            # ЛОКАЛЬНЫЙ пик: ход длится, пока не откатит G ATR от максимума (трейлинг-стоп).
            # peak_j — когда движение выдохлось; dip — макс. откат ДО пика (чистота хода).
            peak = 0.0; peak_j = -1; dip = 0.0
            for j in range(L):
                f = fav[j]
                if f > peak:
                    peak = f; peak_j = j
                else:
                    pull = peak - f
                    if pull > dip:
                        dip = pull
                    if pull >= G:
                        break
            if peak < args.min_run:
                continue
            # разворот — в ОГРАНИЧЕННОМ окне post_bars ПОСЛЕ локального пика (не за все сутки)
            post = fav[peak_j + 1: peak_j + 1 + post_bars] if peak_j + 1 < L else fav[peak_j:peak_j + 1]
            trough = float(post.min()) if post.size else peak
            b_ = int(bi[i])
            acc[b_]["tpeak"].append((peak_j + 1) * args.interval if peak_j >= 0 else args.interval)
            acc[b_]["mfe"].append(peak)
            acc[b_]["rfrac"].append((peak - trough) / peak if peak > 1e-9 else np.nan)
            acc[b_]["mae"].append(-trough if trough < 0 else 0.0)
            acc[b_]["rev"].append(1.0 if trough <= -args.rev_atr else 0.0)
            acc[b_]["dip"].append(dip)

    if n_tk == 0:
        sys.exit("не загрузилось ни одного тикера")

    direction = "ПРОТИВ движения" if args.counter else "ПО движению"
    print(f"\nтикеров: {n_tk}, интервал {args.interval}м, окно {args.maxh}м ({W} баров), "
          f"ускорение {direction}, min-run {args.min_run} ATR, перелом >{args.rev_atr} ATR")
    print(f"(конец хода = откат {args.giveback} ATR от пика; ATR({args.atr_period}) для нормировки; "
          f"разворот в окне {args.post}м после пика)")
    print(f"\n{'аномалия':>8} {'n':>8} {'t_peak,мин':>11} {'MFE,ATR':>9} {'откат%MFE':>10} "
          f"{'чистота':>9} {'MAE_post':>9} {'P(перелом)':>11}")

    def med(x):
        x = [v for v in x if v == v]
        return np.median(x) if x else np.nan

    for j in range(nb):
        a = acc[j]; nn = len(a["mfe"])
        if nn < args.min_count:
            print(f"{BUCKET_LBL[j]:>8} {nn:>8}   (мало данных)")
            continue
        print(f"{BUCKET_LBL[j]:>8} {nn:>8} {med(a['tpeak']):>11.0f} {med(a['mfe']):>9.2f} "
              f"{100 * med(a['rfrac']):>9.0f}% {med(a['dip']):>9.2f} {med(a['mae']):>9.2f} "
              f"{100 * np.mean(a['rev']):>10.1f}%")

    print("\nЧитать: t_peak — когда ход ЛОКАЛЬНО выдохся (медиана, мин); MFE — размах хода до пика;")
    print("откат%MFE — сколько % хода отдал после пика; чистота — макс. откат ДО пика (меньше=глаже);")
    print("MAE_post — уход за вход после пика; P(перелом) — доля с уходом за вход > --rev-atr.")
    print("Гипотеза: сильнее ускорение (+ ниже чистота) → короче t_peak и выше P(перелом).")


if __name__ == "__main__":
    main()
