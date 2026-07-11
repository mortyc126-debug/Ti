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

# Fade-скамья: сетка тейк/стоп (ATR), тайм-кап сделки, издержки по умолчанию.
TS_TAKES = (0.5, 0.7, 1.0)
TS_STOPS = (0.3, 0.5)
FADE_CAP_BARS = 12          # тайм-стоп сделки (баров рабочего ТФ)
DEFAULT_COST = 0.07


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
    vol = np.array([r.get("volume", 0) for r in rows], float)
    dates = [str(r.get("time", "")) for r in rows]   # полный ISO-таймстемп (для held-out хватает лексики, для блоттера нужно время)
    return o, h, l, c, vol, dates


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


def _process(ticker_data, m, halflife, n_atr, trend_w, horizons,
             ticker="", anom_min=0.0, cost_unused=0.0):
    """Возвращает (записи для cont-hit таблиц, fade-сделки для скамьи).
    fade-сделка = вход ПРОТИВ ускорения (fade) на аномальном спайке ПО тренду —
    самая сильная ячейка из cont-hit анализа. Барьеры интрабар high/low."""
    o, h, l, c, vol, dates = ticker_data
    n = len(c)
    if n < max(horizons) + trend_w + n_atr + 4 * m + 10:
        return [], []

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
    atr[atr <= 0] = np.nan   # плоские/неликвидные бары: ATR=0 → деление даёт inf

    # Прокси новости: аномалия ОБЪЁМА (объём / недавняя типичная норма, причинно).
    # Новостной спайк = экстремальный объём; такие бары теханализ игнорирует.
    vbase = _ewm_causal(vol, halflife)
    vbase_prev = np.concatenate([[np.nan], vbase[:-1]])
    vol_anom = np.where((vbase_prev > 0), vol / vbase_prev, np.nan)

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

    # ── fade-сделки: аномалия ≥ anom_min И ускорение ПО тренду → вход ПРОТИВ ──
    fades = []
    if anom_min > 0:
        for i in range(n - FADE_CAP_BARS - 1):
            a = anom[i]
            s = sign_acc[i]
            if np.isnan(a) or s == 0 or np.isnan(trend_sign[i]):
                continue
            if a < anom_min or s != trend_sign[i]:
                continue
            ai = atr[i]
            if not np.isfinite(ai) or ai <= 0:
                continue
            fdir = -s                      # fade = против ускорения
            entry = c[i]
            tp = {t: -1 for t in TS_TAKES}
            sl = {st: -1 for st in TS_STOPS}
            end = min(i + FADE_CAP_BARS, n - 1)
            for j in range(i + 1, end + 1):
                fav = fdir * ((h[j] if fdir > 0 else l[j]) - entry) / ai
                adv = fdir * ((l[j] if fdir > 0 else h[j]) - entry) / ai
                rel = j - i
                for t in TS_TAKES:
                    if tp[t] < 0 and fav >= t:
                        tp[t] = rel
                for st in TS_STOPS:
                    if sl[st] < 0 and adv <= -st:
                        sl[st] = rel
            exit_away = fdir * (c[end] - entry) / ai
            va = vol_anom[i]
            fades.append({
                "ticker": ticker, "entry_bar": i, "date": dates[i],
                "dir": int(fdir),   # +1 лонг / -1 шорт (fade = против ускорения)
                "tp05": tp[0.5], "tp07": tp[0.7], "tp10": tp[1.0],
                "sl03": sl[0.3], "sl05": sl[0.5], "exit_away": exit_away,
                "vanom": float(va) if np.isfinite(va) else 0.0,  # прокси новости
            })
    return out, fades


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


_TAKE_F = {0.5: "tp05", 0.7: "tp07", 1.0: "tp10"}
_STOP_F = {0.3: "sl03", 0.5: "sl05"}


def _fade_pnl(tr, take, stop):
    tt = tr[_TAKE_F[take]]
    ss = tr[_STOP_F[stop]]
    tt = None if tt < 0 else tt
    ss = None if ss < 0 else ss
    if tt is not None and (ss is None or tt < ss):
        return take, (tr["entry_bar"] + tt)
    if ss is not None:
        return -stop, (tr["entry_bar"] + ss)
    return tr["exit_away"], (tr["entry_bar"] + FADE_CAP_BARS)


def _fade_grid(trades, cost, title, overlap=True):
    n = len(trades)
    tag = "с перекрытием" if overlap else "БЕЗ перекрытия"
    print(f"\n== Fade-экспектанси ({tag}, cost={cost}) — {title} ==")
    if not n:
        print("  нет сделок")
        return
    by_t = {}
    for tr in trades:
        by_t.setdefault(tr["ticker"], []).append(tr)
    hdr = "take\\stop"
    print(f"    {hdr:<10}" + "".join(f"{'S='+str(s):>16}" for s in TS_STOPS))
    for take in TS_TAKES:
        cells = []
        for stop in TS_STOPS:
            tot, cnt = 0.0, 0
            if overlap:
                for tr in trades:
                    pnl, _ = _fade_pnl(tr, take, stop)
                    tot += pnl - cost
                    cnt += 1
            else:
                for trs in by_t.values():
                    last = -1
                    for tr in sorted(trs, key=lambda x: x["entry_bar"]):
                        if tr["entry_bar"] <= last:
                            continue
                        pnl, ex = _fade_pnl(tr, take, stop)
                        tot += pnl - cost
                        cnt += 1
                        last = ex
            exp = tot / cnt if cnt else 0.0
            cells.append(f"{exp:+.3f}(N={cnt})")
        print(f"    T={take:<8}" + "".join(f"{c:>16}" for c in cells))


def _fade_report(trades, cost, split_date, vol_thr=0.0):
    print(f"\n{'='*70}\nFADE-СКАМЬЯ: аномальный спайк ПО тренду → вход ПРОТИВ "
          f"({len(trades)} сделок)\n{'='*70}")
    _fade_grid(trades, cost, "все", overlap=True)
    _fade_grid(trades, cost, "все", overlap=False)
    if split_date:
        tr = [t for t in trades if t["date"] < split_date]
        te = [t for t in trades if t["date"] >= split_date]
        print(f"\n-- HELD-OUT: train<{split_date} ({len(tr)}) | test≥{split_date} ({len(te)}) --")
        _fade_grid(tr, cost, "TRAIN", overlap=False)
        _fade_grid(te, cost, "TEST (held-out)", overlap=False)

    # ── ПРОКСИ НОВОСТЕЙ: сплит по аномалии объёма ──
    if vol_thr > 0:
        news = [t for t in trades if t.get("vanom", 0.0) >= vol_thr]
        clean = [t for t in trades if t.get("vanom", 0.0) < vol_thr]
        print(f"\n{'='*70}\nПРОКСИ НОВОСТЕЙ: объём ≥ {vol_thr}× нормы = «новостной» спайк\n"
              f"новостных: {len(news)} | чистых: {len(clean)} (из {len(trades)})\n{'='*70}")
        print("Гипотеза жива, если ЧИСТЫЕ лучше ВСЕХ, а НОВОСТНЫЕ — хуже (теханализу «плевать»).")
        _fade_grid(clean, cost, "ЧИСТЫЕ (без новостей)", overlap=False)
        _fade_grid(news, cost, "НОВОСТНЫЕ (объём-спайк)", overlap=False)
        if split_date:
            trc = [t for t in clean if t["date"] < split_date]
            tec = [t for t in clean if t["date"] >= split_date]
            print(f"\n-- ЧИСТЫЕ held-out: train ({len(trc)}) | test ({len(tec)}) --")
            _fade_grid(trc, cost, "ЧИСТЫЕ TRAIN", overlap=False)
            _fade_grid(tec, cost, "ЧИСТЫЕ TEST (held-out)", overlap=False)


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
    ap.add_argument("--anom-min", type=float, default=2.0, help="порог аномалии для fade-сделки")
    ap.add_argument("--cost", type=float, default=DEFAULT_COST, help="издержки на круг в ATR")
    ap.add_argument("--split-date", default="", help="held-out: YYYY-MM-DD (train<дата, test≥)")
    ap.add_argument("--vol-thr", type=float, default=0.0,
                    help="прокси новостей: объём ≥ X× нормы = «новостной» спайк (сплит отчёта). 0=выкл")
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

    records, fades = [], []
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
            o, h, l, c, vol, dts = data
            data = (o[-cut:], h[-cut:], l[-cut:], c[-cut:], vol[-cut:], dts[-cut:])
        ticker = os.path.basename(p).replace("_1m", "")[:-5]
        recs, fds = _process(data, args.accel_m, args.ewm_halflife, args.n_atr,
                             args.trend_window, horizons, ticker=ticker, anom_min=args.anom_min)
        records.extend(recs)
        fades.extend(fds)
        n_tk += 1
    print(f"тикеров: {n_tk}, записей: {len(records)} "
          f"(accel_m={args.accel_m}, halflife={args.ewm_halflife})")
    if not records:
        raise SystemExit("нет записей — проверь кэш/параметры")
    _report(records, horizons)
    _fade_report(fades, args.cost, args.split_date, vol_thr=args.vol_thr)


if __name__ == "__main__":
    main()
