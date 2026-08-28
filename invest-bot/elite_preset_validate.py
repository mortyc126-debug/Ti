"""elite_preset_validate.py — OOS-валидация пресетов уведомлений
tv-signals-extension (all/often/mid/strict/elite, см. NOTIFY_PRESETS в
tv-signals-extension/content.js) на реальной истории из data/candle_cache.

Зачем. Расширение считает exp/acc метода НА ВСЕЙ доступной истории тикера и
тут же использует эту же цифру, чтобы решить, достоин ли сигнал уведомления
(notifyCheckMethods: st.exp > minExp, st.acc*100 >= minWin, st.n >= 10 —
пороги пресета exp/win, см. NOTIFY_PRESETS). Это оценка "в себя" (in-sample):
неизвестно, держится ли ярлык "элитно" на будущих барах или это переобучение
на короткой истории конкретного тикера. Здесь — честная OOS-проверка:

  - train = первые --split (default 0.6) баров тикера, test = остаток;
  - на train по каждому (тикер, метод) считаем bt_stats — порт btStats из
    tv-signals-extension/signals-core.js (тейк 1.5 / стоп 0.75 ATR, cost
    0.12, без перекрытия — те же цифры, что в system_backtest.py) →
    exp_train/acc_train/n_train;
  - по этим цифрам и порогам NOTIFY_PRESETS решаем, до какого пресета
    "дорос" ярлык пары (самый строгий, которому она удовлетворяет);
  - на test прогоняем ТОТ ЖЕ bt_stats и складываем сделки в корзину своего
    пресета — кумулятивно (elite ⊆ strict ⊆ mid ⊆ often ⊆ all, пороги
    NOTIFY_PRESETS монотонно растут по exp и win);
  - печатаем: пресет → пар (тикер×метод) → сделок OOS → win% → exp ATR.
    Если "элитно" даёт на test не выше win/exp, чем "строго" (или сильно
    просаженный n), это и есть ответ — ярлык не держится вне выборки.

Важная оговорка: методы здесь — из живого композита бота (oi_composite_
strategy.METHODS), НЕ побайтово те же 32 JS-метода из tv-signals-extension
(часть 1:1 портирована, часть названа/устроена иначе — см. IDS в
signals-core.js). Это ближайший доступный офлайн-прокси для тех же цифр
(та же формула exp/win, тот же take/stop/cost), а не точная копия.

Нужен непустой data/candle_cache (заполняется prefetch_candles.py /
prefetch_top_liq.py на боевой машине с сетью — здесь его в чистом клоне
нет). Запуск:
  python elite_preset_validate.py ALL --top-liq 50 --days 180
  python elite_preset_validate.py GAZP,SBER,LKOH --split 0.6 --out out.csv
"""
from __future__ import annotations

import argparse
import csv
import math
import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)
try:
    import tinkoff.invest  # noqa: F401
except ImportError:
    _stub = os.path.join(_HERE, "_tinkoff_stub")
    if _stub not in sys.path:
        sys.path.insert(0, _stub)

from trade_system.strategies import oi_composite_strategy as ocs  # noqa: E402
import score_methods as _sm  # noqa: E402
from score_methods import _load_from_cache, _row_to_ns, _atr_sma, _filter_by_dates, _list_tickers  # noqa: E402

# _atr_sma читает numpy из module-global _WORKER_NP, который score_methods
# заполняет только внутри _init_worker() (обычно на каждый mp.Pool-воркер).
# Мы однопроцессные — вызываем его руками один раз, иначе _WORKER_NP=None
# и _atr_sma падает на np.full_like(None, ...).
_sm._init_worker()

# Та же таблица, что NOTIFY_PRESETS в tv-signals-extension/content.js — держать
# в синхроне при правке одного из файлов. (key, min_exp ATR, min_win %)
PRESETS = [
    ("all", 0.0, 0),
    ("often", 0.03, 0),
    ("mid", 0.05, 55),
    ("strict", 0.10, 60),
    ("elite", 0.15, 65),
]
MIN_N = 10  # как в notifyCheckMethods: st.n < 10 → сигнал не считается


def bt_stats(scores, closes, highs, lows, atr, horizon=12, take=1.5, stop=0.75, cost=0.12):
    """Порт btStats() из tv-signals-extension/signals-core.js. scores[i] — сырой
    скор метода на баре i (0/None = сигнала нет). Возвращает {acc, exp, win, n}
    ровно как в JS-версии: acc — доля совпадений знака с ходом через horizon
    баров; exp/win/n — бар-за-баром сделки тейк/стоп, одна позиция, без
    перекрытия, тайм-выход через horizon баров."""
    n = len(closes)
    hit = hn = 0
    for i in range(n - horizon):
        sc = scores[i]
        if not sc:
            continue
        fut = closes[i + horizon] - closes[i]
        if fut == 0:
            continue
        hn += 1
        if (sc > 0 and fut > 0) or (sc < 0 and fut < 0):
            hit += 1
    pnl_sum = 0.0
    wins = 0
    tn = 0
    pos = None
    for i in range(n):
        hi, lo, cl = highs[i], lows[i], closes[i]
        if pos is not None:
            ex = None
            if pos["dir"] > 0:
                if lo <= pos["sl"]:
                    ex = pos["sl"]
                elif hi >= pos["tp"]:
                    ex = pos["tp"]
            else:
                if hi >= pos["sl"]:
                    ex = pos["sl"]
                elif lo <= pos["tp"]:
                    ex = pos["tp"]
            if ex is None and i - pos["i"] >= horizon:
                ex = cl
            if ex is not None:
                p = pos["dir"] * (ex - pos["entry"]) / pos["eatr"] - cost
                pnl_sum += p
                if p > 0:
                    wins += 1
                tn += 1
                pos = None
        if pos is None:
            sc = scores[i]
            e = atr[i]
            if sc and e and e > 0 and not math.isnan(e):
                d = 1 if sc > 0 else -1
                pos = {"dir": d, "entry": cl, "tp": cl + d * take * e, "sl": cl - d * stop * e, "eatr": e, "i": i}
    return {
        "acc": (hit / hn) if hn else None,
        "exp": (pnl_sum / tn) if tn else None,
        "win": (wins / tn) if tn else None,
        "n": tn,
    }


def clears(stats, min_exp, min_win):
    """Точная копия условия notifyCheckMethods: exp строго > порога (не >=),
    win — только если порог > 0 (в 'all'/'often' win=0 = проверка не идёт)."""
    if stats["n"] < MIN_N or stats["exp"] is None:
        return False
    if not (stats["exp"] > min_exp):
        return False
    if min_win > 0:
        if stats["acc"] is None or stats["acc"] * 100 < min_win:
            return False
    return True


def tier_of(stats):
    """Индекс самого строгого пресета из PRESETS, которому пара удовлетворяет
    (-1 = не проходит даже 'all'). Пороги монотонно растут по exp и win, так
    что "самый строгий пройденный" эквивалентно "проходит все более мягкие"."""
    idx = -1
    for i, (_key, min_exp, min_win) in enumerate(PRESETS):
        if clears(stats, min_exp, min_win):
            idx = i
    return idx


def _dense_scores(fn, candles, window, stride, lo, hi):
    """scores[i] для i в [lo, hi) с шагом stride, иначе 0 (сигнала «нет» —
    как если бы индикатор не пересчитывался между барами страйда)."""
    out = [0.0] * len(candles)
    for i in range(max(lo, window), hi, stride):
        try:
            sc = fn(candles[i - window:i + 1])
        except Exception:
            continue
        if sc is not None:
            out[i] = sc
    return out


def process_ticker(ticker, cache_dir, interval, days, window, stride, split_frac,
                    horizon, methods_filter, n_atr):
    rows_raw = _load_from_cache(ticker, cache_dir, interval)
    if not rows_raw:
        return None
    if days:
        rows_raw = rows_raw[-max(days * (390 // max(interval, 1)), window + horizon + 50):]
    if len(rows_raw) < window + horizon + 50:
        return None
    candles = [_row_to_ns(r) for r in rows_raw]
    closes = [r["close"] for r in rows_raw]
    highs = [r["high"] for r in rows_raw]
    lows = [r["low"] for r in rows_raw]
    import numpy as np
    atr = _atr_sma(np.array(highs, dtype=float), np.array(lows, dtype=float), n_atr).tolist()
    n = len(candles)
    split_idx = int(n * split_frac)
    if split_idx < window + horizon or n - split_idx < horizon + 10:
        return None

    methods = [(name, fn) for name, fn in ocs.METHODS if (not methods_filter) or name in methods_filter]
    out = {}
    for name, fn in methods:
        scores = _dense_scores(fn, candles, window, stride, 0, n)
        train = bt_stats(scores[:split_idx], closes[:split_idx], highs[:split_idx], lows[:split_idx],
                          atr[:split_idx], horizon=horizon)
        test = bt_stats(scores[split_idx:], closes[split_idx:], highs[split_idx:], lows[split_idx:],
                         atr[split_idx:], horizon=horizon)
        out[name] = (train, test)
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("tickers", help="тикер, список через запятую, или ALL")
    ap.add_argument("--cache", default=os.path.join(_HERE, "data", "candle_cache"))
    ap.add_argument("--interval", type=int, default=5, choices=(1, 5))
    ap.add_argument("--days", type=int, default=180)
    ap.add_argument("--window", type=int, default=300, help="окно для score_fn (как в score_methods.py)")
    ap.add_argument("--stride", type=int, default=3, help="через сколько баров пересчитывать метод (перф)")
    ap.add_argument("--split", type=float, default=0.6, help="доля train (grading), остальное — OOS test")
    ap.add_argument("--horizon", type=int, default=12)
    ap.add_argument("--n-atr", type=int, default=20)
    ap.add_argument("--top-liq", type=int, default=None, help="топ-N по ликвидности (только tickers=ALL)")
    ap.add_argument("--methods", default=None, help="подмножество методов через запятую")
    ap.add_argument("--out", default=None, help="CSV по парам (тикер,метод,tier,train/test stats)")
    args = ap.parse_args()

    methods_filter = {m.strip().upper() for m in args.methods.split(",")} if args.methods else None

    if args.tickers.upper() == "ALL":
        tickers = _list_tickers(args.cache, args.interval, top_liq=args.top_liq, liq_days=60,
                                 min_vol_pctl=0.0, max_vol_pctl=100.0, workers=1)
    else:
        tickers = [t.strip().upper() for t in args.tickers.split(",") if t.strip()]
    if not tickers:
        sys.exit("нет тикеров (пуст data/candle_cache? см. prefetch_candles.py)")

    # bucket[tier_idx] = [pnl_sum, wins, n] на OOS
    buckets = {i: [0.0, 0, 0] for i in range(len(PRESETS))}
    pairs_rows = []
    done = 0
    for t in tickers:
        res = process_ticker(t, args.cache, args.interval, args.days, args.window, args.stride,
                              args.split, args.horizon, methods_filter, args.n_atr)
        done += 1
        print(f"\r{done}/{len(tickers)} {t:<12}", end="", file=sys.stderr, flush=True)
        if not res:
            continue
        for name, (train, test) in res.items():
            tier = tier_of(train)
            if tier < 0:
                continue
            b = buckets[tier]
            if test["n"]:
                b[0] += test["exp"] * test["n"]
                b[1] += test["win"] * test["n"]
                b[2] += test["n"]
            pairs_rows.append((t, name, PRESETS[tier][0],
                                train["exp"], train["acc"], train["n"],
                                test["exp"], test["win"], test["n"]))
    print(file=sys.stderr)

    if args.out:
        with open(args.out, "w", newline="", encoding="utf-8") as f:
            w = csv.writer(f)
            w.writerow(["ticker", "method", "train_tier", "train_exp", "train_acc", "train_n",
                        "test_exp", "test_win", "test_n"])
            w.writerows(pairs_rows)
        print(f"пары записаны в {args.out}", file=sys.stderr)

    print(f"\n{'пресет':<8} {'пар (train)':>12} {'сделок OOS':>11} {'win% OOS':>9} {'exp ATR OOS':>12}")
    n_pairs_at_or_above = [0] * len(PRESETS)
    for _, _, tier_key, *_ in pairs_rows:
        idx = next(i for i, p in enumerate(PRESETS) if p[0] == tier_key)
        for j in range(idx + 1):
            n_pairs_at_or_above[j] += 1
    for i, (key, min_exp, min_win) in enumerate(PRESETS):
        pnl = wins = cnt = 0.0
        for j in range(i, len(PRESETS)):
            pnl += buckets[j][0]
            wins += buckets[j][1]
            cnt += buckets[j][2]
        win_pct = (wins / cnt * 100) if cnt else float("nan")
        exp = (pnl / cnt) if cnt else float("nan")
        print(f"{key:<8} {n_pairs_at_or_above[i]:>12} {int(cnt):>11} {win_pct:>8.1f}% {exp:>+11.3f}")


if __name__ == "__main__":
    main()
