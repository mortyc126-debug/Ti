"""
accel_session.py — этап #1: персистентность/разворот по времени суток.

Гипотеза: на MOEX жёсткая внутридневная структура (утренний импульс, всплеск на
открытии США ~13:30 UTC / 16:30 MSK, предзакрытие, вечёрка), и склонность хода
продолжаться/разворачиваться от неё зависит. Нигде раньше по времени не резали.

Метод: тот же сигнал, что в accel_breadth (резкий ход |Δm бар| ≥ move-atr ATR),
но группируем по ЧАСУ таймстемпа. Свечи Tinkoff — в UTC (см. intraday_dead_zone
'08:30-12:00 UTC'); печатаем и UTC, и MSK (=UTC+3). Persist% и знаковый ход в ATR
по горизонтам для каждого часа.

Запуск:
    py -3.11 accel_session.py --interval 5 --liquid-only
    py -3.11 accel_session.py --half-hour --horizons 5,30,60
"""
import sys
import os
import argparse
from datetime import datetime

import numpy as np

from accel_breadth import _cache_dir, _list_tickers, _load, _atr, _liq_top


def _hour_min(ts):
    """(hour, minute) из строки времени; None если не распарсилось."""
    s = str(ts).strip()
    if s.endswith("Z"):
        s = s[:-1]
    try:
        d = datetime.fromisoformat(s.replace("T", " ").split("+")[0].split(".")[0])
        return d.hour, d.minute
    except ValueError:
        return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cache", default=None)
    ap.add_argument("--interval", type=int, default=5, choices=(1, 5))
    ap.add_argument("--horizons", default="5,10,30,60", help="горизонты в минутах")
    ap.add_argument("--m", type=int, default=3, help="окно доходности хода (баров)")
    ap.add_argument("--move-atr", type=float, default=0.5, help="порог |Δm| в ATR")
    ap.add_argument("--half-hour", action="store_true", help="разрез по получасам, не по часам")
    ap.add_argument("--liquid-only", action="store_true")
    ap.add_argument("--tickers", default=None)
    ap.add_argument("--min-count", type=int, default=200)
    args = ap.parse_args()
    cache = _cache_dir(args.cache)
    hor_min = [int(x) for x in args.horizons.split(",") if x.strip()]
    hor_bar = [(hm, max(1, round(hm / args.interval))) for hm in hor_min]
    m = args.m

    tickers = ([t.strip().upper() for t in args.tickers.split(",")] if args.tickers
               else _list_tickers(cache, args.interval))
    if args.liquid_only and not args.tickers:
        top = _liq_top(cache, tickers, args.interval)
        if top:
            tickers = [t for t in tickers if t in top]
    if not tickers:
        sys.exit("нет тикеров")

    # Ключ ведра: индекс получаса (0..47) или часа (0..23).
    nbuck = 48 if args.half_hour else 24

    def _bkey(hm_pair):
        h, mi = hm_pair
        return h * 2 + (1 if mi >= 30 else 0) if args.half_hour else h

    cnt = np.zeros((nbuck, len(hor_bar)))
    s_persist = np.zeros((nbuck, len(hor_bar)))
    s_signed = np.zeros((nbuck, len(hor_bar)))
    n_tk = 0

    for tk in tickers:
        rows = _load(cache, tk, args.interval)
        if not rows:
            continue
        cl = np.array([float(r["close"]) for r in rows])
        hi = np.array([float(r["high"]) for r in rows])
        lo = np.array([float(r["low"]) for r in rows])
        tm = [r["time"] for r in rows]
        atr = _atr(hi, lo, cl)
        v = np.full(len(cl), np.nan)
        v[m:] = (cl[m:] - cl[:-m]) / cl[:-m]
        n = len(cl)
        n_tk += 1
        for i in range(m, n):
            a = atr[i]
            if not np.isfinite(a) or a <= 0 or not np.isfinite(v[i]):
                continue
            if abs(cl[i] - cl[i - m]) / a < args.move_atr:
                continue
            hmp = _hour_min(tm[i])
            if hmp is None:
                continue
            b = _bkey(hmp)
            d = 1.0 if v[i] > 0 else -1.0
            for hj, (_, h) in enumerate(hor_bar):
                if i + h >= n:
                    continue
                mv = cl[i + h] - cl[i]
                cnt[b, hj] += 1.0
                s_persist[b, hj] += 1.0 if np.sign(mv) == d else 0.0
                s_signed[b, hj] += (mv / a) * d

    if n_tk == 0:
        sys.exit("не загрузилось ни одного тикера")

    def _lbl(b):
        if args.half_hour:
            h, half = b // 2, b % 2
            u = f"{h:02d}:{'30' if half else '00'}"
            hm = (h + 3) % 24
            return f"{u}U/{hm:02d}:{'30' if half else '00'}M"
        return f"{b:02d}U/{(b + 3) % 24:02d}M"

    def _hdr():
        return f"{'час UTC/MSK':>12}  {'n':>7}  " + "".join(f"{hm:>7}м" for hm, _ in hor_bar)

    print(f"\nтикеров: {n_tk}, ход = |Δ{m}бар| ≥ {args.move_atr} ATR; U=UTC, M=MSK(+3)")
    print(f"\n=== % СОХРАНЕНИЯ направления по времени суток ===")
    print(_hdr())
    for b in range(nbuck):
        if cnt[b].max() < args.min_count:
            continue
        cells = [f"{100 * s_persist[b, hj] / cnt[b, hj]:6.1f}" if cnt[b, hj] >= args.min_count
                 else "    —" for hj in range(len(hor_bar))]
        print(f"{_lbl(b):>12}  {int(cnt[b].max()):>7}  " + " ".join(cells))

    print(f"\n=== средний ЗНАКОВЫЙ ход в ATR по времени суток ===")
    print(_hdr())
    for b in range(nbuck):
        if cnt[b].max() < args.min_count:
            continue
        cells = [f"{s_signed[b, hj] / cnt[b, hj]:+6.3f}" if cnt[b, hj] >= args.min_count
                 else "    —" for hj in range(len(hor_bar))]
        print(f"{_lbl(b):>12}  {int(cnt[b].max()):>7}  " + " ".join(cells))

    print("\nЧитать: persist>50 в часе = ходы этого времени продолжаются (моментум-")
    print("окно); <50 = разворачиваются (фейд-окно). Открытие/закрытие/обед и всплеск")
    print("на открытии США (~13:30U/16:30M) обычно ведут себя по-разному.")


if __name__ == "__main__":
    main()
