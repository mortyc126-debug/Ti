"""signal_blotter.py — единый бланк сделок (blotter) двух валидированных сигналов
для paper-trade: откат-у-уровня (комбо) и accel-fade.

Не боевой бот и не бэктест-агрегат — выдаёт СПИСОК конкретных сигналов с датой,
тикером, направлением и (для исторических) исходом. Режим --recent-days N
показывает только свежие сигналы: гоняешь раз в день, видишь что сработало,
исполняешь руками/в симуляторе и сверяешь реальные филлы с ожиданием.

Переиспользует проверенный код: level_reaction_dataset.collect + _combo_filter
(откат-комбо) и accel_spike_test._process (fade). Офлайн из candle_cache, токены
не нужны. Кэш keyed по фьючерсному тикеру (файл как есть, фронт-контракт).

Запуск (из invest-bot/):
    python signal_blotter.py --tickers SBER,GAZP --recent-days 5
    python signal_blotter.py --all --out blotter.csv
"""
import argparse
import csv
import glob
import json
import os
import re
from datetime import datetime, timezone

import numpy as np

import level_reaction_dataset as lr
import accel_spike_test as af


def _bars_from_cache(path):
    rows = json.load(open(path, encoding="utf-8"))
    if not rows:
        return None
    rows.sort(key=lambda r: r["time"])
    bars = []
    for r in rows:
        t = datetime.fromisoformat(r["time"])
        if t.tzinfo is None:
            t = t.replace(tzinfo=timezone.utc)
        bars.append({"t": t, "o": float(r["open"]), "h": float(r["high"]),
                     "l": float(r["low"]), "c": float(r["close"]), "v": float(r.get("volume", 0))})
    for b in bars:
        b["d"] = b["t"].astimezone(lr.MSK).date()
    return bars


def _level_signals(bars, ticker):
    """Откат-комбо (быстрый подход + память + чистое касание) как строки blotter."""
    try:
        touches = lr.collect(bars, round_valid_from=bars[0]["d"])
    except SystemExit:
        return []
    pull = [t for t in touches if t.signal == "pullback"]
    out = []
    for t in lr._combo_filter(pull):
        out.append({
            "datetime": t.ts_msk, "ticker": ticker, "type": "LEVEL",
            "direction": "LONG" if t.side == "support" else "SHORT",
            "ref_price": t.level_price, "kind": t.kind,
            # исход (историч.): win = дошёл до 1.0 ATR, fail = пробой, none = тайм-стоп
            "outcome": t.follow or t.result,
        })
    return out


def _fade_signals(path, ticker, anom_min):
    """accel-fade: аномальный спайк по тренду → вход против. Строки blotter из
    fade-сделок accel_spike_test (даёт дату, направление в exit_away-знаке)."""
    data = af._load_closes(path)
    if data is None:
        return []
    res = af._process(data, m=3, halflife=50.0, n_atr=20, trend_w=50,
                      horizons=[6], ticker=ticker, anom_min=anom_min)
    # короткий ряд → _process отдаёт пустой [] (не кортеж); нечего распаковывать
    if not res or not isinstance(res, tuple):
        return []
    _recs, fades = res
    o, h, l, c, dates = data
    out = []
    for f in fades:
        i = f["entry_bar"]
        # исход по тейк/стоп-сетке (интрабар): tp10/sl05 = номер бара срабатывания
        # или -1, если не сработало в окне FADE_CAP_BARS.
        win = "win" if (f["tp10"] >= 0 and (f["sl05"] < 0 or f["tp10"] < f["sl05"])) else \
              ("fail" if f["sl05"] >= 0 else "none")
        out.append({
            "datetime": f["date"], "ticker": ticker, "type": "FADE",
            "direction": "LONG" if f["dir"] > 0 else "SHORT",
            "ref_price": round(c[i], 4), "kind": "accel_spike",
            "outcome": win,
        })
    return out


def _collapse(rows, gap_min):
    """Схлопывание перекрытий: подряд идущие сигналы одного (тикер,тип,направление)
    в пределах gap_min минут — это ОДНО движение, а не N сделок. Оставляем первый,
    остальные душим. Так блоттер = список сделок к исполнению, а не поток эпизодов."""
    if gap_min <= 0:
        return rows
    last = {}
    out = []
    for r in sorted(rows, key=lambda r: r["datetime"]):
        try:
            t = datetime.fromisoformat(r["datetime"])
        except ValueError:
            out.append(r)
            continue
        key = (r["ticker"], r["type"], r["direction"])
        prev = last.get(key)
        if prev is None or (t - prev).total_seconds() / 60.0 >= gap_min:
            out.append(r)
            last[key] = t
    return out


def main():
    ap = argparse.ArgumentParser(description="Blotter двух сигналов (level-комбо + accel-fade) для paper-trade")
    ap.add_argument("--cache", default=os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                                    "data", "candle_cache"))
    ap.add_argument("--tickers", default="")
    ap.add_argument("--all", action="store_true")
    ap.add_argument("--recent-days", type=int, default=0, help="показать сигналы за последние N дней")
    ap.add_argument("--anom-min", type=float, default=2.0)
    ap.add_argument("--collapse-min", type=int, default=60,
                    help="душить повторы одного (тикер,тип,напр) в пределах N минут (0=не душить)")
    ap.add_argument("--out", default="")
    args = ap.parse_args()

    if args.tickers:
        paths = [os.path.join(args.cache, f"{t.strip()}.json") for t in args.tickers.split(",") if t.strip()]
    elif args.all:
        # только 5-минутки: файлы вида <ticker>.json, без суффикса _Nm
        paths = sorted(p for p in glob.glob(os.path.join(args.cache, "*.json"))
                       if not re.search(r"_\d+m\.json$", p))
    else:
        raise SystemExit("--tickers СПИСОК или --all")

    rows = []
    for p in paths:
        if not os.path.exists(p):
            print(f"нет файла: {p}")
            continue
        ticker = os.path.basename(p)[:-5]
        bars = _bars_from_cache(p)
        if bars:
            rows += _level_signals(bars, ticker)
        rows += _fade_signals(p, ticker, args.anom_min)

    raw_n = len(rows)
    rows = _collapse(rows, args.collapse_min)
    if args.collapse_min:
        print(f"схлопнуто перекрытий: {raw_n} → {len(rows)} (окно {args.collapse_min} мин)")
    rows.sort(key=lambda r: r["datetime"])
    if args.recent_days:
        # последние N дней от максимальной даты в blotter
        if rows:
            last = rows[-1]["datetime"][:10]
            from datetime import date, timedelta
            cutoff = (date.fromisoformat(last) - timedelta(days=args.recent_days)).isoformat()
            rows = [r for r in rows if r["datetime"][:10] >= cutoff]

    print(f"\nсигналов: {len(rows)} (LEVEL: {sum(1 for r in rows if r['type']=='LEVEL')}, "
          f"FADE: {sum(1 for r in rows if r['type']=='FADE')})")
    print(f"\n{'дата/время':<26}{'тикер':<10}{'тип':<7}{'напр':<6}{'цена':>10}  {'вид':<12}{'исход':>7}")
    for r in rows[-60:]:
        print(f"{r['datetime']:<26}{r['ticker']:<10}{r['type']:<7}{r['direction']:<6}"
              f"{r['ref_price']:>10}  {r['kind']:<12}{r['outcome']:>7}")

    if args.out:
        cols = ["datetime", "ticker", "type", "direction", "ref_price", "kind", "outcome"]
        with open(args.out, "w", newline="", encoding="utf-8") as fh:
            w = csv.DictWriter(fh, fieldnames=cols)
            w.writeheader()
            w.writerows(rows)
        print(f"\nCSV: {args.out}")


if __name__ == "__main__":
    main()
