"""
score_methods.py — офлайн-прогон всех методов OICompositeStrategy по кэшу свечей.

Для каждого метода (name, score_fn) из METHODS в
trade_system/strategies/oi_composite_strategy.py:
- Скользящим окном пробегает по истории тикера
- На каждом окне: score = score_fn(candles[:i+1])
- Классифицирует срабатывание: score >= +AGREE → bull, ≤ −AGREE → bear
  (AGREE=0.15 — тот же порог AGREE_SCORE_MIN, что бот использует)
- Считает fwd_ret_k нормированный на ATR
- Метрики: n_fires (bull+bear), win_rate (совпадение направления),
  mean_bull, mean_bear, Cohen's d

Роли по итогу:
- signal   (d > +0.05): работает как задумано, полезный вклад в композит
- anti     (d < −0.05): работает наоборот — кандидат в _inverted_methods,
  не в удаление (переворачивается, а не выкидывается)
- noise    (|d| ≤ 0.05): без edge — кандидат в _disabled_methods

Три топа рядом:
- по d (правильный знак — реальный сигнал)
- по −d (перевёрнутый — anti-сигнал)
- по n_fires × |d| (полезный вклад в композит: частота × сила)

Параллель: multiprocessing.Pool с воркерами на тикер. Каждый воркер один
раз импортит oi_composite_strategy (тяжёлый импорт ~30-60 сек на Windows
из-за numpy/talib/scipy/tinkoff), дальше воркер переиспользуется.
CSV пишется инкрементально после каждого тикера — если процесс упадёт,
уже сделанная работа не теряется.

Запуск:
    python score_methods.py SBER --days 180
    python score_methods.py ALL --workers 8 --stride 5 --out scores.csv
    python score_methods.py ALL --workers 4 --stride 20 --methods PRICE_TREND,ADX_DI_CONVERGENCE
    python score_methods.py ALL --workers 8 --stride 1 --out scores_full.csv  # часами

Аргументы:
    ticker              тикер или ALL
    --cache DIR         путь к data/candle_cache
    --interval M        5 или 1
    --days D            глубина, default 180
    --from/--to         явные границы (перекрывают --days)
    --all               весь кэш
    --workers N         число процессов (default: mp.cpu_count()-1)
    --window W          сколько последних баров подавать в score_fn (default 300)
    --stride S          через сколько баров считать (default 5)
    --k K               горизонт forward-return (default 12)
    --n-atr N           окно ATR для нормировки forward-return (default 20)
    --methods LIST      подмножество методов через запятую (иначе — все)
    --agree-min A       порог |score| для срабатывания (default 0.15 — как в боте)
    --min-fires N       порог фильтрации в итоговых топах (default: single 50, ALL 500)
    --out PATH          CSV со всеми per-ticker результатами (append)
    --pool-out PATH     CSV с пуловой сводкой по каждому методу
"""
from __future__ import annotations

import argparse
import csv
import json
import math
import multiprocessing as mp
import os
import sys
import time
from datetime import datetime, timedelta
from types import SimpleNamespace
from typing import Optional

# Глобальные внутри воркера — заполняются в _init_worker и переиспользуются.
_WORKER_METHODS = None
_WORKER_NP = None


def _init_worker():
    """Инициализируется один раз на воркер: импорт стратегии + numpy.
    Активирует локальный tinkoff-stub, если реальный SDK не установлен
    (например, под Python 3.14 wheel'а ещё нет). Реальный пакет, если
    он есть, найдётся первым — stub не помешает."""
    global _WORKER_METHODS, _WORKER_NP
    # sys.path: и папка invest-bot (для импорта trade_system, indicators…),
    # и _tinkoff_stub (fallback для tinkoff.invest)
    here = os.path.dirname(os.path.abspath(__file__))
    if here not in sys.path:
        sys.path.insert(0, here)
    try:
        import tinkoff.invest  # noqa: F401
    except ImportError:
        stub = os.path.join(here, "_tinkoff_stub")
        if stub not in sys.path:
            sys.path.insert(0, stub)
    import numpy as _np
    from trade_system.strategies import oi_composite_strategy as ocs
    _WORKER_METHODS = ocs.METHODS
    _WORKER_NP = _np


def _load_from_cache(ticker: str, cache_dir: str, interval_min: int) -> list[dict]:
    suffix = "" if interval_min == 5 else f"_{interval_min}m"
    path = os.path.join(cache_dir, f"{ticker}{suffix}.json")
    if not os.path.exists(path):
        return []
    try:
        with open(path, "r", encoding="utf-8") as f:
            rows = json.load(f)
    except json.JSONDecodeError:
        return []
    if not isinstance(rows, list) or not rows:
        return []
    rows.sort(key=lambda r: r["time"])
    return rows


def _filter_by_dates(rows, date_from, date_to):
    if date_from:
        rows = [r for r in rows if r["time"][:10] >= date_from]
    if date_to:
        rows = [r for r in rows if r["time"][:10] <= date_to]
    return rows


def _row_to_ns(row: dict) -> SimpleNamespace:
    """Duck-typed объект для score_* функций. Все методы читают .open/.high/
    .low/.close/.volume через _to_f, который делает float(quotation_to_decimal)
    в try и float(q) в except — т.е. float пройдёт через второй путь."""
    return SimpleNamespace(
        time=datetime.fromisoformat(row["time"]),
        open=row["open"], high=row["high"], low=row["low"],
        close=row["close"], volume=int(row["volume"]),
        is_complete=True,
    )


def _atr_sma(highs, lows, n: int):
    np = _WORKER_NP
    ranges = highs - lows
    atr = np.full_like(ranges, np.nan, dtype=float)
    if len(ranges) < n:
        return atr
    cs = np.cumsum(ranges, dtype=float)
    for i in range(n - 1, len(ranges)):
        atr[i] = (cs[i] - (cs[i - n] if i >= n else 0)) / n
    return atr


def _fwd_ret_bar_native(closes, atr, k: int):
    np = _WORKER_NP
    n = len(closes)
    out = np.full(n, np.nan, dtype=float)
    for i in range(n - k):
        a = atr[i]
        if np.isnan(a) or a <= 0:
            continue
        out[i] = (closes[i + k] - closes[i]) / a
    return out


def _run_ticker(job: dict) -> tuple[str, Optional[dict]]:
    """Один воркер, один тикер, все методы. Возвращает (ticker, results)
    где results = {method_name: {metrics}}. None если тикер пропущен."""
    global _WORKER_METHODS, _WORKER_NP
    np = _WORKER_NP
    ticker = job["ticker"]

    rows_raw = _load_from_cache(ticker, job["cache_dir"], job["interval"])
    if not rows_raw:
        return ticker, None
    rows_raw = _filter_by_dates(rows_raw, job["date_from"], job["date_to"])
    W = job["window"]; S = job["stride"]; K = job["k"]; AGREE = job["agree_min"]
    if len(rows_raw) < W + K + 5:
        return ticker, None

    candles = [_row_to_ns(r) for r in rows_raw]
    closes = np.array([r["close"] for r in rows_raw], dtype=float)
    highs  = np.array([r["high"]  for r in rows_raw], dtype=float)
    lows   = np.array([r["low"]   for r in rows_raw], dtype=float)
    atr = _atr_sma(highs, lows, job["n_atr"])
    fwd = _fwd_ret_bar_native(closes, atr, K)

    method_filter = job["methods_filter"]
    to_run = [(n, fn) for n, fn in _WORKER_METHODS
              if (not method_filter) or n in method_filter]

    results = {}
    for name, fn in to_run:
        bull_rets = []
        bear_rets = []
        for i in range(W, len(candles) - K, S):
            if np.isnan(fwd[i]):
                continue
            try:
                score = fn(candles[i - W:i + 1])
            except Exception:
                continue
            if score is None:
                continue
            if score >= AGREE:
                bull_rets.append(fwd[i])
            elif score <= -AGREE:
                bear_rets.append(fwd[i])
            # score в нейтральной зоне: молчание, не считаем срабатыванием

        n_bull, n_bear = len(bull_rets), len(bear_rets)
        n_fires = n_bull + n_bear
        if n_bull >= 2 and n_bear >= 2:
            ma = float(np.mean(bull_rets)); mb = float(np.mean(bear_rets))
            sa = float(np.std(bull_rets, ddof=1))
            sb = float(np.std(bear_rets, ddof=1))
            pooled = math.sqrt(((n_bull - 1) * sa * sa + (n_bear - 1) * sb * sb)
                                / max(n_bull + n_bear - 2, 1))
            d = (ma - mb) / pooled if pooled > 0 else None
            wins = sum(1 for r in bull_rets if r > 0) + sum(1 for r in bear_rets if r < 0)
            win_rate = wins / n_fires
        else:
            ma = mb = d = win_rate = None
        results[name] = {
            "n_fires": n_fires, "n_bull": n_bull, "n_bear": n_bear,
            "mean_bull": ma, "mean_bear": mb, "d": d, "win_rate": win_rate,
        }
    return ticker, results


def _accumulate_pool(pool_agg: dict, ticker: str, results: dict) -> None:
    """Копит per-ticker результаты в пуловые агрегаты. mean/d в пуле —
    из накопленных sum(bull)/n_bull; d — грубая аппроксимация (та же
    оговорка что в candle_patterns._finalize_pool)."""
    for name, s in results.items():
        acc = pool_agg.setdefault(name, {
            "n_fires": 0, "n_bull": 0, "n_bear": 0,
            "sum_bull": 0.0, "sum_bear": 0.0, "wins": 0,
            "n_tickers": 0, "d_values": [],
        })
        acc["n_fires"] += s["n_fires"]
        acc["n_bull"]  += s["n_bull"]
        acc["n_bear"]  += s["n_bear"]
        if s["mean_bull"] is not None and s["n_bull"]:
            acc["sum_bull"] += s["mean_bull"] * s["n_bull"]
        if s["mean_bear"] is not None and s["n_bear"]:
            acc["sum_bear"] += s["mean_bear"] * s["n_bear"]
        if s["win_rate"] is not None:
            acc["wins"] += int(round(s["win_rate"] * s["n_fires"]))
        if s["d"] is not None:
            acc["d_values"].append(s["d"])
            acc["n_tickers"] += 1


def _finalize_pool(pool_agg: dict) -> dict:
    """Финализирует пул: медиана d по тикерам (робастнее к выбросам),
    win_rate по накопленным, средние из сумм."""
    out = {}
    for name, acc in pool_agg.items():
        n_fires = acc["n_fires"]
        mean_bull = acc["sum_bull"] / acc["n_bull"] if acc["n_bull"] else None
        mean_bear = acc["sum_bear"] / acc["n_bear"] if acc["n_bear"] else None
        win_rate = acc["wins"] / n_fires if n_fires else None
        d_med = None
        if acc["d_values"]:
            xs = sorted(acc["d_values"])
            nl = len(xs)
            d_med = xs[nl // 2] if nl % 2 else 0.5 * (xs[nl // 2 - 1] + xs[nl // 2])
        out[name] = {
            "n_fires": n_fires, "n_bull": acc["n_bull"], "n_bear": acc["n_bear"],
            "mean_bull": mean_bull, "mean_bear": mean_bear,
            "win_rate": win_rate, "d_median": d_med, "n_tickers": acc["n_tickers"],
        }
    return out


def _role(d: Optional[float], neutral: float = 0.05) -> str:
    if d is None:
        return "n/a"
    if d > neutral:
        return "signal"
    if d < -neutral:
        return "anti"
    return "noise"


def _print_ticker_progress(ticker: str, results: dict, done: int, total: int,
                            elapsed: float) -> None:
    """Короткая строка после каждого тикера: сколько сигналов/анти/шума +
    топ-3 signal и топ-3 anti."""
    with_d = [(n, s) for n, s in results.items()
              if s["d"] is not None and s["n_fires"] >= 30]
    n_sig = sum(1 for _, s in with_d if s["d"] > 0.05)
    n_ant = sum(1 for _, s in with_d if s["d"] < -0.05)
    n_noi = len(with_d) - n_sig - n_ant
    top_sig = sorted((x for x in with_d if x[1]["d"] > 0.05),
                      key=lambda x: -x[1]["d"])[:3]
    top_ant = sorted((x for x in with_d if x[1]["d"] < -0.05),
                      key=lambda x: x[1]["d"])[:3]
    def fmt(items):
        return ", ".join(f"{n}({s['d']:+.2f})" for n, s in items) or "—"
    rate = done / elapsed if elapsed > 0 else 0
    print(f"[{done:>4}/{total}] {ticker:<12} sig={n_sig:>2} anti={n_ant:>2} "
          f"noise={n_noi:>2} | top_sig: {fmt(top_sig)} | top_anti: {fmt(top_ant)} "
          f"| {rate:.1f}/s", file=sys.stderr)


def _print_final(pool: dict, min_fires: int) -> None:
    valid = [(n, s) for n, s in pool.items()
             if s["d_median"] is not None and s["n_fires"] >= min_fires]

    signal = sorted((x for x in valid if x[1]["d_median"] > 0.05),
                     key=lambda x: -x[1]["d_median"])[:15]
    anti = sorted((x for x in valid if x[1]["d_median"] < -0.05),
                   key=lambda x: x[1]["d_median"])[:15]
    contrib = sorted(valid, key=lambda x: -x[1]["n_fires"] * abs(x[1]["d_median"]))[:15]
    noise = sorted((x for x in valid if abs(x[1]["d_median"]) <= 0.05),
                    key=lambda x: -x[1]["n_fires"])[:10]

    def hdr(label):
        return (f"\n=== {label} ===\n"
                f"{'метод':<24} {'d_med':>7} {'n_fires':>8} {'n_tk':>5} "
                f"{'win%':>6}  role")

    def row(name, s):
        d = f"{s['d_median']:+.3f}" if s['d_median'] is not None else "  —  "
        wr = f"{s['win_rate']*100:.1f}" if s['win_rate'] is not None else "  — "
        return (f"{name:<24} {d:>7} {s['n_fires']:>8} {s['n_tickers']:>5} "
                f"{wr:>6}  {_role(s['d_median'])}")

    print(hdr("топ SIGNAL (d > +0.05) — работают правильно"))
    for n, s in signal:
        print(row(n, s))
    print(hdr("топ ANTI (d < −0.05) — кандидаты в _inverted_methods"))
    for n, s in anti:
        print(row(n, s))
    print(hdr("топ CONTRIBUTION (n_fires × |d|) — реальный вес в композите"))
    for n, s in contrib:
        print(row(n, s))
    print(hdr("топ NOISE (|d| ≤ 0.05) — кандидаты в _disabled_methods"))
    for n, s in noise:
        print(row(n, s))

    inv = [n for n, s in valid if s["d_median"] is not None
                              and s["d_median"] < -0.05
                              and s["n_fires"] >= min_fires * 2]
    dis = [n for n, s in valid if s["d_median"] is not None
                              and abs(s["d_median"]) <= 0.05
                              and s["n_fires"] >= min_fires * 5]
    print(f"\n→ рекомендация к _inverted_methods = {sorted(inv)}")
    print(f"→ рекомендация к _disabled_methods = {sorted(dis)}")


def _list_tickers(cache_dir, interval_min) -> list[str]:
    if not os.path.isdir(cache_dir):
        sys.exit(f"нет папки кэша: {cache_dir}")
    out = []
    for name in os.listdir(cache_dir):
        if not name.endswith(".json"):
            continue
        base = name[:-5]
        if interval_min == 5 and base.endswith("_1m"):
            continue
        if interval_min == 1 and not base.endswith("_1m"):
            continue
        ticker = base[:-3] if interval_min == 1 else base
        if os.path.getsize(os.path.join(cache_dir, name)) < 100:
            continue
        out.append(ticker)
    out.sort()
    return out


def _slice_by_args(args, all_rows_len_placeholder=None):
    """Возвращает (date_from, date_to) как строки YYYY-MM-DD."""
    # Дефолты вычисляются позже, в воркере, потому что latest_date у каждого
    # тикера свой. Здесь только если явно задано.
    return args.date_from, args.date_to


def main() -> None:
    ap = argparse.ArgumentParser(description="Прогон всех методов OICompositeStrategy по кэшу")
    ap.add_argument("ticker")
    ap.add_argument("--cache", default=os.path.join(
        os.path.dirname(os.path.abspath(__file__)), "data", "candle_cache"))
    ap.add_argument("--interval", type=int, default=5, choices=(1, 5))
    ap.add_argument("--days", type=int, default=180)
    ap.add_argument("--from", dest="date_from", default=None)
    ap.add_argument("--to", dest="date_to", default=None)
    ap.add_argument("--all", action="store_true", help="весь кэш")
    ap.add_argument("--workers", type=int,
                     default=max(1, (mp.cpu_count() or 2) - 1))
    ap.add_argument("--window", type=int, default=300,
                     help="сколько последних баров подавать в score_fn (default 300)")
    ap.add_argument("--stride", type=int, default=5,
                     help="через сколько баров считать (default 5)")
    ap.add_argument("--k", type=int, default=12,
                     help="горизонт forward-return (default 12)")
    ap.add_argument("--n-atr", type=int, default=20,
                     help="окно ATR для нормировки (default 20)")
    ap.add_argument("--methods", default=None,
                     help="подмножество через запятую (иначе все)")
    ap.add_argument("--agree-min", type=float, default=0.15,
                     help="порог |score| для срабатывания (default 0.15)")
    ap.add_argument("--min-fires", type=int, default=None,
                     help="порог в итоговых топах (default: single 50, ALL 500)")
    ap.add_argument("--out", default=None,
                     help="CSV per-ticker результатов (append)")
    ap.add_argument("--pool-out", default=None,
                     help="CSV пуловой сводки")
    args = ap.parse_args()

    # Разбираем --methods
    methods_filter = None
    if args.methods:
        methods_filter = {m.strip().upper() for m in args.methods.split(",") if m.strip()}

    # Вычисляем окно дат
    if args.all:
        date_from, date_to = None, None
    else:
        # single/ALL с --days: обрежем в воркере по last-bar тикера,
        # чтобы холодный кэш не давал пустоту; здесь только фиксируем days.
        date_from, date_to = args.date_from, args.date_to
        if not (date_from or date_to):
            # Раз --days задан, но --to не задан, используем окно относительно
            # last-bar каждого тикера. Передаём None,None и days в job.
            pass

    if args.ticker.upper() == "ALL":
        tickers = _list_tickers(args.cache, args.interval)
    else:
        tickers = [args.ticker]
    if not tickers:
        sys.exit("нет тикеров")

    print(f"тикеров к прогону: {len(tickers)}, воркеров: {args.workers}, "
          f"window={args.window}, stride={args.stride}, k={args.k}", file=sys.stderr)

    # Формируем задания. Дата-фильтр: если date_from/to заданы — используем как
    # есть; иначе пусть воркер сам обрежет по --days от последнего бара.
    # Для простоты: если --all — всю историю; иначе передаём days и воркер
    # обрежет сам.
    def build_job(tk):
        # Для одиночного тикера с --days воркер получит last-bar сам и
        # обрежет. Реализовано ниже: если date_from/to None и не --all,
        # обрезаем по last-bar-days в воркере.
        return {
            "ticker": tk,
            "cache_dir": args.cache,
            "interval": args.interval,
            "date_from": date_from,
            "date_to": date_to,
            "window": args.window,
            "stride": args.stride,
            "k": args.k,
            "n_atr": args.n_atr,
            "methods_filter": methods_filter,
            "agree_min": args.agree_min,
        }
    # --days без явных дат: обрежем здесь по каждому тикеру отдельно
    def build_job_with_days(tk):
        j = build_job(tk)
        if args.all or date_from or date_to:
            return j
        # прочтём кэш для last-bar (быстро — JSON.load уже кэшируется ОС)
        rows = _load_from_cache(tk, args.cache, args.interval)
        if not rows:
            j["date_from"] = "9999-01-01"  # заведомо пусто → skip
            return j
        latest = rows[-1]["time"][:10]
        to_d = datetime.strptime(latest, "%Y-%m-%d").date()
        j["date_from"] = (to_d - timedelta(days=args.days)).isoformat()
        j["date_to"] = latest
        return j

    jobs = [build_job_with_days(tk) for tk in tickers]

    # CSV per-ticker: инкрементальная запись
    per_ticker_fp = None
    per_ticker_writer = None
    if args.out:
        per_ticker_fp = open(args.out, "w", encoding="utf-8", newline="")
        per_ticker_writer = csv.DictWriter(per_ticker_fp, fieldnames=[
            "ticker", "method", "n_fires", "n_bull", "n_bear",
            "mean_bull", "mean_bear", "win_rate", "d", "role"])
        per_ticker_writer.writeheader()

    pool_agg: dict = {}
    t_start = time.time()
    done = 0

    if args.workers == 1 or len(tickers) == 1:
        # Один воркер — синхронно, без Pool, чтобы single-режим не платил
        # 30-секундного старта spawn'а.
        _init_worker()
        for job in jobs:
            ticker, results = _run_ticker(job)
            done += 1
            if results is None:
                print(f"[{done}/{len(tickers)}] {ticker}: SKIP", file=sys.stderr)
                continue
            _print_ticker_progress(ticker, results, done, len(tickers),
                                    time.time() - t_start)
            _accumulate_pool(pool_agg, ticker, results)
            if per_ticker_writer:
                for name, s in results.items():
                    per_ticker_writer.writerow({
                        "ticker": ticker, "method": name,
                        "n_fires": s["n_fires"], "n_bull": s["n_bull"],
                        "n_bear": s["n_bear"],
                        "mean_bull": s["mean_bull"] if s["mean_bull"] is not None else "",
                        "mean_bear": s["mean_bear"] if s["mean_bear"] is not None else "",
                        "win_rate": s["win_rate"] if s["win_rate"] is not None else "",
                        "d": s["d"] if s["d"] is not None else "",
                        "role": _role(s["d"]),
                    })
                per_ticker_fp.flush()
    else:
        # Параллельный запуск. На Windows spawn = каждый воркер импортит
        # oi_composite_strategy заново (30-60 сек). Пул создаётся один раз,
        # воркеры переиспользуются на N тикеров.
        with mp.Pool(processes=args.workers, initializer=_init_worker) as pool:
            for ticker, results in pool.imap_unordered(_run_ticker, jobs):
                done += 1
                if results is None:
                    print(f"[{done}/{len(tickers)}] {ticker}: SKIP", file=sys.stderr)
                    continue
                _print_ticker_progress(ticker, results, done, len(tickers),
                                        time.time() - t_start)
                _accumulate_pool(pool_agg, ticker, results)
                if per_ticker_writer:
                    for name, s in results.items():
                        per_ticker_writer.writerow({
                            "ticker": ticker, "method": name,
                            "n_fires": s["n_fires"], "n_bull": s["n_bull"],
                            "n_bear": s["n_bear"],
                            "mean_bull": s["mean_bull"] if s["mean_bull"] is not None else "",
                            "mean_bear": s["mean_bear"] if s["mean_bear"] is not None else "",
                            "win_rate": s["win_rate"] if s["win_rate"] is not None else "",
                            "d": s["d"] if s["d"] is not None else "",
                            "role": _role(s["d"]),
                        })
                    per_ticker_fp.flush()

    if per_ticker_fp:
        per_ticker_fp.close()

    pool = _finalize_pool(pool_agg)
    if args.pool_out:
        with open(args.pool_out, "w", encoding="utf-8", newline="") as f:
            w = csv.DictWriter(f, fieldnames=[
                "method", "n_fires", "n_bull", "n_bear",
                "mean_bull", "mean_bear", "win_rate",
                "d_median", "n_tickers", "role"])
            w.writeheader()
            for name, s in sorted(pool.items(),
                                    key=lambda x: -abs(x[1]["d_median"])
                                    if x[1]["d_median"] is not None else 0):
                w.writerow({
                    "method": name, "n_fires": s["n_fires"],
                    "n_bull": s["n_bull"], "n_bear": s["n_bear"],
                    "mean_bull": s["mean_bull"] if s["mean_bull"] is not None else "",
                    "mean_bear": s["mean_bear"] if s["mean_bear"] is not None else "",
                    "win_rate": s["win_rate"] if s["win_rate"] is not None else "",
                    "d_median": s["d_median"] if s["d_median"] is not None else "",
                    "n_tickers": s["n_tickers"], "role": _role(s["d_median"]),
                })
        print(f"\nпуловая сводка: {args.pool_out}", file=sys.stderr)

    total_time = time.time() - t_start
    print(f"\nзавершено за {total_time:.1f}с "
          f"({len(tickers)/total_time:.1f} тикеров/с)", file=sys.stderr)

    min_fires = args.min_fires
    if min_fires is None:
        min_fires = 50 if len(tickers) == 1 else 500
    _print_final(pool, min_fires)


if __name__ == "__main__":
    # Windows: spawn требует явного main-гарда. Без него воркеры войдут в
    # бесконечную рекурсию импорта.
    mp.freeze_support()
    main()
