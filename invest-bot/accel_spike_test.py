"""accel_spike_test.py — тщательная проверка гипотезы про ускорение.

Гипотеза (пользователь): ускорение, которое АНОМАЛЬНО выпрыгивает из своей
недавней нормы, — это климакс → разворот (анти-сигнал направления). А умеренное
ускорение, не выпрыгивающее из диапазона, — устойчивый тренд (продолжение).

Почему нужен отдельный тест, а не tpcolor:
  - там color СГЛАЖЕН (ROC→diff→EMA, тройной лаг) — спайки замылены, а вся
    гипотеза про спайк. Здесь ускорение РЕЗКОЕ (малое окно, без EMA).
  - «выпрыгивает из медианы» — робастная аномалия. z-score (среднее/σ) сам
    раздувается спайками. Здесь аномалия = |accel| / скользящее типичное |accel|
    (причинно, по прошлому) — спайк-устойчивая база.

Что меряется, по полосам аномалии × горизонтам × (по тренду / против):
  - cont.hit% — доля, где знак ускорения совпал со знаком будущего движения
    (>50 = продолжение/тренд, <50 = разворот/fade);
  - mean_dir — среднее движение В сторону ускорения, в ATR (знак = деньги если
    следовать ускорению).
Гипотеза жива, если в нормальных полосах cont.hit≥50, а в аномальных падает <50.

Офлайн из кэша, numpy. Запуск (из invest-bot/):
    python accel_spike_test.py --all
    python accel_spike_test.py --tickers SBER,GAZP --days 180
    python accel_spike_test.py --all --accel-m 3 --horizons 3,6,12
"""
import argparse
import glob
import json
import os

import numpy as np

ANOM_EDGES = [0.0, 1.0, 1.5, 2.0, 3.0, 5.0, np.inf]
ANOM_LABELS = ["<1x", "1–1.5x", "1.5–2x", "2–3x", "3–5x", ">5x"]


def _load_closes(path: str):
    with open(path, encoding="utf-8") as f:
        rows = json.load(f)
    if not rows:
        return None
    rows.sort(key=lambda r: r["time"])
    o = np.array([r["open"] for r in rows], float)
    h = np.array([r["high"] for r in rows], float)
    l = np.array([r["low"] for r in rows], float)
    c = np.array([r["close"] for r in rows], float)
    return o, h, l, c


def _rmean(x, n):
    c = np.cumsum(np.insert(x, 0, 0.0))
    out = np.full(len(x), np.nan)
    out[n - 1:] = (c[n:] - c[:-n]) / n
    return out


def _ewm_causal(x, halflife):
    """Скользящее типичное значение (EWM), причинно, с пропуском ведущих NaN."""
    alpha = 1.0 - 0.5 ** (1.0 / halflife)
    out = np.full(len(x), np.nan)
    acc = None
    for i in range(len(x)):
        xi = x[i]
        if np.isnan(xi):
            continue
        acc = xi if acc is None else alpha * xi + (1 - alpha) * acc
        out[i] = acc
    return out


def _process(ticker_data, m, halflife, n_atr, trend_w, horizons):
    """Возвращает список записей (anom, sign_acc, trend_sign, {k: fwd})."""
    o, h, l, c = ticker_data
    n = len(c)
    if n < max(horizons) + trend_w + n_atr + 4 * m + 10:
        return []

    # Резкое ускорение: v = ROC за m баров; accel = изменение v за m баров.
    v = np.full(n, np.nan)
    v[m:] = (c[m:] - c[:-m]) / c[:-m]
    accel = np.full(n, np.nan)
    accel[m:] = v[m:] - v[:-m]
    absacc = np.abs(accel)

    # Робастная аномалия: |accel| / недавнее типичное |accel| (причинно, сдвиг на 1).
    base = _ewm_causal(absacc, halflife)
    base_prev = np.concatenate([[np.nan], base[:-1]])
    anom = np.where(base_prev > 0, absacc / base_prev, np.nan)
    sign_acc = np.sign(accel)

    # ATR для нормировки будущего хода. prev_c[0]=c[0], иначе NaN в TR[0]
    # разносит NaN по всему cumsum-ATR.
    prev_c = np.concatenate([[c[0]], c[:-1]])
    tr = np.maximum(h - l, np.maximum(np.abs(h - prev_c), np.abs(l - prev_c)))
    atr = _rmean(tr, n_atr)

    # Тренд-контекст: знак хода за trend_w баров.
    trend_sign = np.full(n, np.nan)
    trend_sign[trend_w:] = np.sign(c[trend_w:] - c[:-trend_w])

    fwd = {}
    for k in horizons:
        f = np.full(n, np.nan)
        f[:n - k] = (c[k:] - c[:n - k]) / atr[:n - k]
        fwd[k] = f

    out = []
    for i in range(n):
        a = anom[i]
        s = sign_acc[i]
        if np.isnan(a) or s == 0 or np.isnan(trend_sign[i]):
            continue
        rec = {"anom": a, "s": s, "trend": trend_sign[i], "fwd": {}}
        ok = False
        for k in horizons:
            fv = fwd[k][i]
            if not np.isnan(fv):
                rec["fwd"][k] = fv
                ok = True
        if ok:
            out.append(rec)
    return out


def _bucket(anom):
    for j in range(len(ANOM_EDGES) - 1):
        if ANOM_EDGES[j] <= anom < ANOM_EDGES[j + 1]:
            return j
    return len(ANOM_LABELS) - 1


def _report(records, horizons):
    # acc[(k, band, group)] = [n, n_cont, sum_dir]
    acc = {}
    for r in records:
        band = _bucket(r["anom"])
        with_trend = "with" if r["s"] == r["trend"] else "against"
        for k, fv in r["fwd"].items():
            cont = 1 if r["s"] * fv > 0 else 0
            d = r["s"] * fv
            for grp in ("all", with_trend):
                a = acc.setdefault((k, band, grp), [0, 0, 0.0])
                a[0] += 1
                a[1] += cont
                a[2] += d

    for k in horizons:
        print(f"\n=== горизонт {k} баров ===")
        for grp, title in (("all", "ВСЕ"), ("with", "спайк ПО тренду"), ("against", "спайк ПРОТИВ тренда")):
            print(f"  -- {title} --")
            print(f"    {'аномалия':<10}{'N':>10}{'cont.hit%':>11}{'mean_dir(ATR)':>15}  трактовка")
            for band in range(len(ANOM_LABELS)):
                a = acc.get((k, band, grp))
                if not a or a[0] < 100:
                    continue
                n, nc, sd = a
                hit = 100 * nc / n
                md = sd / n
                tag = "follow (тренд)" if hit >= 51 else ("fade (разворот)" if hit <= 49 else "нейтр.")
                print(f"    {ANOM_LABELS[band]:<10}{n:>10}{hit:>11.1f}{md:>+15.4f}  {tag}")


def main():
    ap = argparse.ArgumentParser(description="Тест гипотезы: аномальное ускорение → разворот, нормальное → тренд")
    ap.add_argument("--cache", default=os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                                     "data", "candle_cache"))
    ap.add_argument("--interval", type=int, default=5, choices=(1, 5))
    ap.add_argument("--tickers", default="")
    ap.add_argument("--all", action="store_true")
    ap.add_argument("--days", type=int, default=0, help="0 = весь файл; иначе последние N дней (по барам)")
    ap.add_argument("--accel-m", type=int, default=3, help="окно ROC и разности для резкого ускорения")
    ap.add_argument("--ewm-halflife", type=float, default=50.0, help="полужизнь скользящей нормы |accel|")
    ap.add_argument("--n-atr", type=int, default=20)
    ap.add_argument("--trend-window", type=int, default=50)
    ap.add_argument("--horizons", default="3,6,12")
    args = ap.parse_args()

    horizons = [int(x) for x in args.horizons.split(",")]
    suffix = "" if args.interval == 5 else "_1m"
    if args.tickers:
        names = [t.strip() for t in args.tickers.split(",") if t.strip()]
        paths = [os.path.join(args.cache, f"{t}{suffix}.json") for t in names]
    elif args.all:
        paths = sorted(p for p in glob.glob(os.path.join(args.cache, "*.json"))
                       if (args.interval == 1) == p.endswith("_1m.json"))
    else:
        raise SystemExit("укажи --tickers СПИСОК или --all")

    records = []
    n_tk = 0
    bars_per_day = 100 if args.interval == 5 else 500
    for p in paths:
        if not os.path.exists(p):
            print(f"нет файла: {p}")
            continue
        data = _load_closes(p)
        if data is None:
            continue
        if args.days:
            cut = args.days * bars_per_day
            data = tuple(arr[-cut:] for arr in data)
        recs = _process(data, args.accel_m, args.ewm_halflife, args.n_atr,
                        args.trend_window, horizons)
        records.extend(recs)
        n_tk += 1
    print(f"тикеров: {n_tk}, записей: {len(records)} "
          f"(accel_m={args.accel_m}, halflife={args.ewm_halflife})")
    if not records:
        raise SystemExit("нет записей — проверь кэш/параметры")
    _report(records, horizons)


if __name__ == "__main__":
    main()
