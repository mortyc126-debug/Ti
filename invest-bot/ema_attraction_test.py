"""ema_attraction_test.py — тест ПРИТЯЖЕНИЯ к EMA100/200 (15м).

Тезис пользователя (правильно прочитанный): чем ДОЛЬШЕ EMA не трогали, тем
вероятнее она ПРИТЯНЕТ цену — т.е. когда цена далеко от давно-нетронутой EMA,
она стремится вернуться К средней. Это НЕ отскок ОТ EMA (это мерил
ema_reaction_test и получил минус), а движение К ней издалека.

Схема:
  - EMA100/200 на 15м, причинно (как в ema_reaction_test);
  - «касание» = цена в пределах TOUCH_BAND ATR от EMA; давность = 15м-баров с
    последнего касания;
  - ВХОД: |dist| ≥ FAR ATR от EMA (цена ушла далеко) — сделка В СТОРОНУ EMA
    (цена выше → шорт к EMA / ниже → лонг к EMA), одна на инструмент+EMA за
    экскурсию (перевзвод, когда цена вернулась ближе TOUCH_BAND);
  - барьеры интрабар от цены входа В СТОРОНУ EMA (тейк) / против (стоп);
  - «дошла до EMA» = отдельный факт (first-passage к TOUCH_BAND) в пределах CAP;
  - фактор давности на входе — прямая проверка «дольше не трогали → сильнее тянет».

Гонтлет: сетка тейк/стоп + no-overlap + held-out. Офлайн из candle_cache.

Запуск:
    python ema_attraction_test.py --tickers SBER,GAZP,LKOH,YDEX --split-date 2026-04-01
    python ema_attraction_test.py --all --far 1.0 --cap 96
"""
import argparse
import glob
import os
import re

import numpy as np

from ema_reaction_test import (_load, _atr, _ema_on_5m, _barriers,
                               TF, ATR_PERIOD, GT_TAKES, GT_STOPS, GT_PORT)

EMAS = (100, 200)
TOUCH_BAND = 0.30     # ближе — считаем EMA «тронутой»
FAR_DEFAULT = 1.0     # дальше — цена «ушла», кандидат на возврат
CAP_DEFAULT = 96      # горизонт возврата (5м баров ≈ 1.5 дня)
AGE_EDGES = [0, 8, 20, 50, np.inf]           # 15м-баров с последнего касания
AGE_LABELS = ["свежая<8", "8-20", "20-50", "давняя>50"]


def _scan_attraction(ema, period, h5, l5, c5, atr5, times, ticker, far, cap):
    """Входы 'цена далеко от давно-нетронутой EMA → к EMA'. one-per-excursion."""
    n = len(c5)
    out = []
    last_touch_15 = None
    armed = True                    # готов открыть новую сделку, когда уйдёт далеко
    i = 0
    while i < n:
        e = ema[i]; a = atr5[i]
        if not (np.isfinite(e) and np.isfinite(a) and a > 0):
            i += 1
            continue
        dist = (c5[i] - e) / a                    # знак: + выше EMA, − ниже
        if abs(dist) <= TOUCH_BAND:               # коснулись EMA — обновляем давность и взводим
            last_touch_15 = i // TF
            armed = True
            i += 1
            continue
        if not armed or abs(dist) < far:
            i += 1
            continue
        # ВХОД: далеко от EMA, к EMA. sgn = в сторону EMA (профит при движении к средней)
        sgn = -1.0 if dist > 0 else 1.0
        age15 = (i // TF - last_touch_15) if last_touch_15 is not None else 9999
        end = min(n - 1, i + cap)
        grid = _barriers(c5[i], sgn, a, h5, l5, c5, i, end, cap)
        # дошла ли цена до EMA (в пределах TOUCH_BAND) в окне — чистая «притянулась»
        reached = False
        for j in range(i + 1, end + 1):
            aj = atr5[j]
            if np.isfinite(aj) and aj > 0 and abs(c5[j] - ema[j]) <= TOUCH_BAND * aj:
                reached = True
                break
        out.append({"ticker": ticker, "ema": period, "age15": age15,
                    "dist0": round(abs(dist), 2), "reached": reached,
                    "date": times[i][:10], "entry_bar": i, "grid": grid})
        armed = False                              # до возврата к EMA — не открываем повторно
        i += 1
    return out


def _age_bucket(age):
    for k in range(len(AGE_EDGES) - 1):
        if AGE_EDGES[k] <= age < AGE_EDGES[k + 1]:
            return AGE_LABELS[k]
    return AGE_LABELS[-1]


def _row(label, rows):
    n = len(rows)
    if not n:
        print(f"{label:<20}{'—':>7}"); return
    reach = 100 * sum(1 for r in rows if r["reached"]) / n
    print(f"{label:<20}{n:>8}{reach:>12.1f}")


def _gt_grid(rows, cost, title):
    print(f"\n-- {title}: сетка тейк/стоп (N={len(rows)}, cost={cost}) --")
    print(f"{'take/stop':<12}" + "".join(f"{s:>10}" for s in GT_STOPS))
    if not rows:
        print("  пусто"); return
    for take in GT_TAKES:
        cells = []
        for stop in GT_STOPS:
            pnls = [r["grid"][(take, stop)][0] - cost for r in rows]
            exp = sum(pnls) / len(pnls)
            wr = 100 * sum(1 for p in pnls if p > 0) / len(pnls)
            cells.append(f"{exp:+.3f}/{wr:.0f}%")
        print(f"take{take:<8}" + "".join(f"{c:>10}" for c in cells))


def _gt_portfolio(rows, cost, title):
    take, stop = GT_PORT
    by_tk = {}
    for r in rows:
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
    ap = argparse.ArgumentParser(description="Тест ПРИТЯЖЕНИЯ к EMA100/200 (15м)")
    ap.add_argument("--cache", default=os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                                    "data", "candle_cache"))
    ap.add_argument("--tickers", default="")
    ap.add_argument("--all", action="store_true")
    ap.add_argument("--far", type=float, default=FAR_DEFAULT, help="порог удаления от EMA (ATR)")
    ap.add_argument("--cap", type=int, default=CAP_DEFAULT, help="горизонт возврата (5м баров)")
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
            ts = _scan_attraction(ema, period, h, l, c, atr5, times, tk, args.far, args.cap)
            allt += ts
            cnt += len(ts)
        if args.tickers:
            print(f"{tk}: входов-притяжения {cnt}")

    if not allt:
        raise SystemExit("входов не собрано — мало баров или подними --far пониже")

    base_reach = 100 * sum(1 for r in allt if r["reached"]) / len(allt)
    print(f"\n{'='*60}\nПРИТЯЖЕНИЕ к EMA (15м, far≥{args.far} ATR, cap={args.cap}) — {len(allt)} входов\n{'='*60}")
    print(f"\nБАЗА: дошло до EMA в окне — {base_reach:.1f}%")
    print("\n== Давность EMA на входе (тезис «дольше не трогали → сильнее тянет») ==")
    print(f"{'':<20}{'N':>8}{'дошло_до_EMA%':>16}")
    for lb in AGE_LABELS:
        _row(lb, [r for r in allt if _age_bucket(r["age15"]) == lb])
    print("\n== По периоду ==")
    for period in EMAS:
        _row(f"EMA{period}", [r for r in allt if r["ema"] == period])

    print(f"\n{'='*60}\nГОНТЛЕТ сделки 'к EMA' (интрабар + no-overlap + held-out)\n{'='*60}")
    _gt_grid(allt, args.cost_atr, "все входы")
    # и отдельно на давних EMA — где тезис сильнее всего
    old = [r for r in allt if r["age15"] >= 50]
    _gt_grid(old, args.cost_atr, "только давняя>50")
    print("\n-- No-overlap портфель --")
    _gt_portfolio(allt, args.cost_atr, "все входы")
    _gt_portfolio(old, args.cost_atr, "давняя>50")
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
