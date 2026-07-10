"""ema_reaction_test.py — тест гипотезы «EMA100/200 (15м) как зоны притяжения».

Спека пользователя: EMA не уровень в чистом виде, но её линии работают как зоны,
где «что-то будет»; чем ДОЛЬШЕ EMA не трогали, тем вероятнее она притянет цену.
Проверяем причинно, тем же гонтлетом, что и уровни/каналы:

  - EMA100/200 считаются на 15-минутках (×3 к рабочим 5м), причинно;
  - на 5м-баре берём EMA последнего ЗАКРЫТОГО 15м-бара (без подглядывания вперёд);
  - касание = цена подошла к EMA на TRIGGER ATR; значение EMA на баре касания
    ЗАМОРАЖИВАЕТСЯ (иначе наклон самой EMA рисует фиктивные исходы — как было
    с каналами v1);
  - эпизод: подтверждённый откат → отскок (BOUNCE) / пробой (BREAK) / столл;
  - фактор «давность»: сколько баров цена не касалась этой EMA до касания —
    прямая проверка тезиса «дольше не трогали → сильнее притянет/держит».

Барьеры тейк/стоп интрабар от цены входа, no-overlap (одна позиция/инструмент),
held-out по времени. Офлайн из candle_cache, numpy.

Запуск (из invest-bot/):
    python ema_reaction_test.py --tickers SBER,GAZP,LKOH,YDEX --split-date 2026-04-01
    python ema_reaction_test.py --all --cost-atr 0.12
"""
import argparse
import glob
import os
import re

import numpy as np

TF = 3                    # 15м = ×3 к 5м
EMAS = (100, 200)         # периоды EMA на 15м
TRIGGER_ATR = 0.30        # ближе — касание
PULLBACK_ATR = 0.15       # откат от экстремума прокола = подтверждение
BREAK_ATR = 0.30          # закрытие за EMA = пробой
BOUNCE_ATR = 1.00         # уход от EMA = состоявшийся отбой
REARM_ATR = 1.50          # дальше — взводим под новое касание
ATR_PERIOD = 20
RESOLVE_CAP = 48          # тайм-аут эпизода (5м баров)
GT_TAKES = (0.5, 0.7, 1.0)
GT_STOPS = (0.3, 0.5)
GT_PORT = (1.0, 0.5)
# Бакеты давности (в 15м-барах) — сколько EMA «не трогали» до касания.
AGE_EDGES = [0, 8, 20, 50, np.inf]           # <2ч, <5ч, <12.5ч, дольше
AGE_LABELS = ["свежая<8", "8-20", "20-50", "давняя>50"]


def _load(path):
    import json
    rows = json.load(open(path, encoding="utf-8"))
    if not rows:
        return None
    rows.sort(key=lambda r: r["time"])
    return (np.array([r["open"] for r in rows], float),
            np.array([r["high"] for r in rows], float),
            np.array([r["low"] for r in rows], float),
            np.array([r["close"] for r in rows], float),
            [str(r["time"]) for r in rows])


def _atr(h, l, c, period):
    prev = np.concatenate([[c[0]], c[:-1]])
    tr = np.maximum(h - l, np.maximum(np.abs(h - prev), np.abs(l - prev)))
    out = np.full(len(c), np.nan)
    cs = np.cumsum(np.insert(tr, 0, 0.0))
    out[period - 1:] = (cs[period:] - cs[:-period]) / period
    atr = out
    atr[atr <= 0] = np.nan
    return atr


def _ema(x, period):
    a = 2.0 / (period + 1.0)
    out = np.full(len(x), np.nan)
    acc = x[0]
    for i in range(len(x)):
        acc = a * x[i] + (1 - a) * acc
        out[i] = acc
    return out


def _ema_on_5m(c5, period):
    """EMA(period) на 15м-закрытиях, разложенная на 5м-бары ПРИЧИННО: на 5м-баре i
    берём EMA последнего 15м-бара, закрывшегося на баре ≤ i (закрытие k-го 15м —
    на 5м-индексе 3k+2). До первого закрытого 15м-бара — NaN."""
    n5 = len(c5)
    n15 = n5 // TF
    if n15 < period + 2:
        return None
    c15 = c5[:n15 * TF].reshape(-1, TF)[:, -1]     # закрытие каждого 15м-бара
    e15 = _ema(c15, period)
    out = np.full(n5, np.nan)
    for i in range(n5):
        j = (i - (TF - 1)) // TF                   # последний ЗАКРЫТЫЙ 15м-бар
        if 0 <= j < n15:
            out[i] = e15[j]
    return out


def _barriers(entry, sgn, a, h5, l5, c5, i, end, cap):
    """Тейк/стоп-сетка от ЦЕНЫ ВХОДА, интрабар first-passage. Тай в баре → стоп."""
    last = min(end, i + cap)
    grid = {}
    for take in GT_TAKES:
        for stop in GT_STOPS:
            pnl, exb = None, last
            for j in range(i + 1, last + 1):
                fav = sgn * ((h5[j] if sgn > 0 else l5[j]) - entry) / a
                adv = sgn * ((l5[j] if sgn > 0 else h5[j]) - entry) / a
                if adv <= -stop:
                    pnl, exb = -stop, j
                    break
                if fav >= take:
                    pnl, exb = take, j
                    break
            if pnl is None:
                pnl = sgn * (c5[last] - entry) / a
            grid[(take, stop)] = (pnl, exb)
    return grid


def _scan_ema(ema, period, h5, l5, c5, atr5, times, ticker):
    """Касания EMA: армирование/касание/эпизод по ЗАМОРОЖЕННОМУ значению EMA.
    Давность = 15м-баров с последнего касания этой EMA."""
    n = len(c5)
    touches = []
    armed = True
    last_touch_15 = None          # индекс 15м-бара последнего касания
    i = 0
    while i < n:
        e = ema[i]; a = atr5[i]
        if not (np.isfinite(e) and np.isfinite(a) and a > 0):
            i += 1
            continue
        dist = abs(c5[i] - e) / a
        if not armed:
            if dist > REARM_ATR:
                armed = True
            i += 1
            continue
        if dist >= TRIGGER_ATR:
            i += 1
            continue
        # касание. side: EMA снизу → support (лонг вверх), сверху → resistance
        side = "support" if c5[i] >= e else "resistance"
        sgn = 1.0 if side == "support" else -1.0
        lvl = e                                   # ЗАМОРОЗКА EMA на баре касания
        cur15 = i // TF
        age15 = (cur15 - last_touch_15) if last_touch_15 is not None else 9999
        last_touch_15 = cur15
        # эпизод (та же машина, что у каналов)
        extreme = l5[i] if side == "support" else h5[i]
        confirmed = False
        entry_bar = -1
        res = ""
        end = min(n - 1, i + RESOLVE_CAP)
        j = i
        while j <= end:
            aj = atr5[j]
            if not (np.isfinite(aj) and aj > 0):
                j += 1
                continue
            extreme = min(extreme, l5[j]) if side == "support" else max(extreme, h5[j])
            away = sgn * (c5[j] - lvl) / aj
            if not confirmed:
                if away <= -BREAK_ATR:
                    res = "break"
                    break
                rt = sgn * (c5[j] - extreme) / aj
                if rt >= PULLBACK_ATR:
                    confirmed = True
                    entry_bar = j
                elif j >= end:
                    res = "stall"
                    break
            if confirmed:
                if away >= BOUNCE_ATR:
                    res = "bounce"
                    break
                if away <= -BREAK_ATR:
                    res = "break"
                    break
                if j >= end:
                    res = "stall"
                    break
            j += 1
        rec = {"ticker": ticker, "ema": period, "side": side, "result": res or "stall",
               "age15": age15, "date": times[i][:10], "confirmed": confirmed}
        if confirmed and entry_bar > 0:
            rec["grid"] = _barriers(c5[entry_bar], sgn, atr5[entry_bar], h5, l5, c5,
                                    entry_bar, end, RESOLVE_CAP)
            rec["entry_bar"] = entry_bar
        touches.append(rec)
        armed = False
        i = j + 1
    return touches


def _age_bucket(age):
    for k in range(len(AGE_EDGES) - 1):
        if AGE_EDGES[k] <= age < AGE_EDGES[k + 1]:
            return AGE_LABELS[k]
    return AGE_LABELS[-1]


def _row(label, rows):
    n = len(rows)
    if not n:
        print(f"{label:<20}{'—':>7}")
        return
    b = sum(1 for r in rows if r["result"] == "bounce")
    k = sum(1 for r in rows if r["result"] == "break")
    print(f"{label:<20}{n:>7}{100*b/n:>9.1f}{100*k/n:>9.1f}{100*(n-b-k)/n:>9.1f}")


def _gt_grid(rows, cost, title):
    conf = [r for r in rows if "grid" in r]
    print(f"\n-- {title}: сетка тейк/стоп (N={len(conf)}, cost={cost}) --")
    print(f"{'take/stop':<12}" + "".join(f"{s:>10}" for s in GT_STOPS))
    if not conf:
        print("  пусто"); return
    for take in GT_TAKES:
        cells = []
        for stop in GT_STOPS:
            pnls = [r["grid"][(take, stop)][0] - cost for r in conf]
            exp = sum(pnls) / len(pnls)
            wr = 100 * sum(1 for p in pnls if p > 0) / len(pnls)
            cells.append(f"{exp:+.3f}/{wr:.0f}%")
        print(f"take{take:<8}" + "".join(f"{c:>10}" for c in cells))


def _gt_portfolio(rows, cost, title):
    take, stop = GT_PORT
    by_tk = {}
    for r in rows:
        if "grid" in r:
            by_tk.setdefault(r["ticker"], []).append(r)
    trades, pnl = 0, 0.0
    for rs in by_tk.values():
        rs.sort(key=lambda r: r["entry_bar"])
        free = -1
        for r in rs:
            if r["entry_bar"] <= free:
                continue
            p, exb = r["grid"][(take, stop)]
            pnl += p - cost
            free = exb
            trades += 1
    if not trades:
        print(f"{title:<28} нет сделок"); return
    print(f"{title:<28} N={trades:<5} exp={pnl/trades:+.3f}  Σ={pnl:+.1f} ATR (тейк{take}/стоп{stop})")


def main():
    ap = argparse.ArgumentParser(description="Тест EMA100/200 (15м) как зон притяжения/уровней")
    ap.add_argument("--cache", default=os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                                    "data", "candle_cache"))
    ap.add_argument("--tickers", default="")
    ap.add_argument("--all", action="store_true")
    ap.add_argument("--cost-atr", type=float, default=0.12)
    ap.add_argument("--split-date", default="2026-04-01")
    args = ap.parse_args()

    if args.tickers:
        paths = [os.path.join(args.cache, f"{t.strip()}.json") for t in args.tickers.split(",") if t.strip()]
    elif args.all:
        paths = sorted(p for p in glob.glob(os.path.join(args.cache, "*.json"))
                       if not re.search(r"_\d+m\.json$", p))
    else:
        raise SystemExit("--tickers СПИСОК или --all")

    allt = []
    for p in paths:
        if not os.path.exists(p):
            print(f"нет файла: {p}"); continue
        data = _load(p)
        if data is None:
            continue
        o, h, l, c, times = data
        atr5 = _atr(h, l, c, ATR_PERIOD)
        tk = os.path.basename(p)[:-5]
        cnt = 0
        for period in EMAS:
            ema = _ema_on_5m(c, period)
            if ema is None:
                continue
            ts = _scan_ema(ema, period, h, l, c, atr5, times, tk)
            allt += ts
            cnt += len(ts)
        if args.tickers:
            print(f"{tk}: касаний EMA {cnt}")

    if not allt:
        raise SystemExit("касаний не собрано — мало баров? нужен кэш с историей")

    hdr = f"{'':<20}{'N':>7}{'bounce%':>9}{'break%':>9}{'stall%':>9}"
    print(f"\n{'='*66}\nEMA100/200 (15м) как зоны — {len(allt)} касаний\n{'='*66}")
    print("\n== Все ==");  print(hdr);  _row("all", allt)
    print("\n== По периоду ==");  print(hdr)
    for period in EMAS:
        _row(f"EMA{period}", [r for r in allt if r["ema"] == period])
    print("\n== Давность касания (тезис «дольше не трогали → держит») ==");  print(hdr)
    for lb in AGE_LABELS:
        _row(lb, [r for r in allt if _age_bucket(r["age15"]) == lb])
    print("\n== Роль (EMA снизу=support / сверху=resistance) ==");  print(hdr)
    for sd in ("support", "resistance"):
        _row(sd, [r for r in allt if r["side"] == sd])

    print(f"\n{'='*66}\nГОНТЛЕТ (интрабар тейк/стоп + no-overlap + held-out)\n{'='*66}")
    _gt_grid(allt, args.cost_atr, "все касания EMA")
    print("\n-- No-overlap портфель --")
    _gt_portfolio(allt, args.cost_atr, "EMA все")
    tr = [r for r in allt if r["date"] and r["date"] < args.split_date]
    te = [r for r in allt if r["date"] and r["date"] >= args.split_date]
    print(f"\n-- HELD-OUT: train<{args.split_date} ({len(tr)}) | test≥ ({len(te)}) --")
    if tr and te:
        _gt_portfolio(tr, args.cost_atr, "TRAIN")
        _gt_portfolio(te, args.cost_atr, "TEST (held-out)")
    else:
        print("одна из половин пуста — сдвинь --split-date")


if __name__ == "__main__":
    main()
