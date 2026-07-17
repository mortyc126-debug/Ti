"""
accel_persistence.py — карта персистентности направления по силе ускорения.

Идея (пользователь): при разном ускорении движения В ОДНУ СТОРОНУ — насколько
долго держится направление? Строим таблицу [сила ускорения] × [горизонт]:
  % сохранения направления (persist) и средний знаковый ход в ATR.

persist > 50% = моментум (движение продолжается), < 50% = фейд (разворот).

Ускорение (как в extension/PRICE_ACCEL):
  v[i] = (close[i]-close[i-m]) / close[i-m]         скорость за m баров
  a[i] = v[i] - v[i-m]                              ускорение (2-я производная)
  an[i] = |a[i]| / EWMA(|a|)                        аномальность (× типичной)
  dir[i] = sign(v[i])                               направление движения
По умолчанию считаем ускорение ПО движению (a и v в одну сторону); --counter —
против (замедление/разворот ускорения).

Горизонты задаются в минутах, переводятся в бары по --interval (5м-кэш → 1440м
= 288 баров, пересекает ночь: это непрерывный lookahead по серии, так и задумано).

Данные: data/candle_cache/<TICKER>.json (как в score_methods). --interval 1 для
минутных горизонтов.

Запуск:
    py -3.11 accel_persistence.py --interval 5
    py -3.11 accel_persistence.py --interval 1 --horizons 1,5,10,60
    py -3.11 accel_persistence.py --tickers SBER,GAZP,LKOH --counter
"""
import os
import sys
import json
import glob
import argparse
from datetime import datetime

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
    ap.add_argument("--cache", default=None, help="путь к data/candle_cache")
    ap.add_argument("--interval", type=int, default=5, choices=(1, 5))
    ap.add_argument("--horizons", default="5,10,30,60,240,1440", help="горизонты в минутах через запятую")
    ap.add_argument("--m", type=int, default=3, help="окно скорости/ускорения (баров)")
    ap.add_argument("--ewma-hl", type=int, default=50, help="halflife EWMA для нормировки |a|")
    ap.add_argument("--counter", action="store_true", help="ускорение ПРОТИВ движения (замедление)")
    ap.add_argument("--tickers", default=None, help="список через запятую (иначе весь кэш)")
    ap.add_argument("--min-count", type=int, default=200, help="не печатать ячейку с n меньше")
    args = ap.parse_args()

    cache = _cache_dir(args.cache)
    hor_min = [int(x) for x in args.horizons.split(",") if x.strip()]
    hor_bar = [(hm, max(1, round(hm / args.interval))) for hm in hor_min]
    tickers = ([t.strip().upper() for t in args.tickers.split(",")] if args.tickers
               else _list_tickers(cache, args.interval))
    if not tickers:
        sys.exit(f"нет тикеров в {cache} (interval={args.interval})")

    nb = len(BUCKETS)
    # суммы по (bucket, horizon): счётчик, сумма persist(0/1), сумма signed-ATR
    cnt = np.zeros((nb, len(hor_bar)))
    s_persist = np.zeros((nb, len(hor_bar)))
    s_signed = np.zeros((nb, len(hor_bar)))
    hl_a = 1.0 - 0.5 ** (1.0 / args.ewma_hl)
    m = args.m
    n_tk = 0

    for tk in tickers:
        rows = _load(cache, tk, args.interval)
        if not rows:
            continue
        cl = np.array([float(r["close"]) for r in rows])
        hi = np.array([float(r["high"]) for r in rows])
        lo = np.array([float(r["low"]) for r in rows])
        n = len(cl)
        if n < 2 * m + max(h for _, h in hor_bar) + 5:
            continue
        n_tk += 1

        v = np.full(n, np.nan)
        v[m:] = (cl[m:] - cl[:-m]) / cl[:-m]
        a = np.full(n, np.nan)
        a[2 * m:] = v[2 * m:] - v[m:-m]
        # EWMA |a| (последовательно), an = |a[i]| / base[i-1]
        base = np.full(n, np.nan)
        b = None
        for i in range(n):
            if np.isnan(a[i]):
                continue
            x = abs(a[i])
            b = x if b is None else hl_a * x + (1 - hl_a) * b
            base[i] = b
        an = np.full(n, np.nan)
        prev = np.roll(base, 1)
        good = ~np.isnan(a) & ~np.isnan(prev) & (prev > 0)
        an[good] = np.abs(a[good]) / prev[good]

        atr = _atr(hi, lo, cl)
        d = np.sign(v)
        pro = np.sign(a) == d           # ускорение ПО движению
        want = pro if not args.counter else ~pro
        sig = good & (d != 0) & (atr > 0) & want & ~np.isnan(an)
        # индекс ведра по an
        bi = np.digitize(an, [b1 for _, b1 in BUCKETS[:-1]])  # 0..nb-1

        for hj, (_, h) in enumerate(hor_bar):
            idx = np.where(sig)[0]
            idx = idx[idx + h < n]
            if len(idx) == 0:
                continue
            move = cl[idx + h] - cl[idx]
            persist = (np.sign(move) == d[idx]).astype(float)
            signed = move / atr[idx] * d[idx]
            b_idx = bi[idx]
            np.add.at(cnt[:, hj], b_idx, 1.0)
            np.add.at(s_persist[:, hj], b_idx, persist)
            np.add.at(s_signed[:, hj], b_idx, signed)

    if n_tk == 0:
        sys.exit("не загрузилось ни одного тикера — проверь --cache/--interval")

    def _hdr():
        return "аномалия   n        " + "".join(f"{hm:>7}м" for hm, _ in hor_bar)

    direction = "ПРОТИВ движения" if args.counter else "ПО движению"
    print(f"\nтикеров: {n_tk}, интервал {args.interval}м, m={m}, EWMA-hl={args.ewma_hl}, ускорение {direction}")
    print(f"\n=== % СОХРАНЕНИЯ направления (persist; >50 моментум, <50 фейд) ===")
    print(_hdr())
    for bi_ in range(nb):
        ntot = cnt[bi_].max()
        cells = []
        for hj in range(len(hor_bar)):
            c = cnt[bi_, hj]
            cells.append(f"{100 * s_persist[bi_, hj] / c:6.1f}" if c >= args.min_count else "    —")
        print(f"{BUCKET_LBL[bi_]:>8}  {int(ntot):>7}  " + " ".join(cells))

    print(f"\n=== средний ЗНАКОВЫЙ ход в ATR (>0 продолжил, <0 развернулся) ===")
    print(_hdr())
    for bi_ in range(nb):
        ntot = cnt[bi_].max()
        cells = []
        for hj in range(len(hor_bar)):
            c = cnt[bi_, hj]
            cells.append(f"{s_signed[bi_, hj] / c:+6.3f}" if c >= args.min_count else "    —")
        print(f"{BUCKET_LBL[bi_]:>8}  {int(ntot):>7}  " + " ".join(cells))

    print("\nЧитать: строки — сила ускорения (× типичной), столбцы — горизонт.")
    print("persist падает с ростом аномалии на коротком горизонте = климакс-фейд;")
    print("держится >50 на длинном = моментум. Сравни с --counter (замедление).")


if __name__ == "__main__":
    main()
