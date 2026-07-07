"""
candle_patterns.py — прогон всех свечных паттернов TA-Lib по локальному кэшу.

Читает те же файлы, что и tpcolor_dataset.py (data/candle_cache/<TICKER>.json),
и для каждого паттерна из группы "Pattern Recognition" TA-Lib считает:

  - сколько раз паттерн сработал (n_fires, отдельно бычьих/медвежьих),
  - win-rate (доля срабатываний, где forward-return совпал по знаку с
    направлением паттерна),
  - средний forward-return для бычьих и медвежьих срабатываний (в
    единицах ATR — bar-native, чтобы сравнивать между тикерами),
  - Cohen's d между «бык-fwd_ret» и «медв-fwd_ret»: если паттерн реально
    предсказывает направление, d>>0. d≈0 — паттерн шумит.

Свечные паттерны TA-Lib возвращают +100/-100 (или ±200 для «сильных»
вариантов) и 0 «нет паттерна» — этот скрипт обрабатывает всё как знак,
силу отдельно не учитывает.

Требования: pip install TA-Lib. На Windows чистый pip нужен C-компилятор,
проще взять precompiled wheel:
  https://github.com/cgohlke/talib-build/releases
и поставить: pip install <скачанный>.whl

Запуск (из invest-bot/):
    python candle_patterns.py SBER --days 180 --k 12 --out sber_patterns.csv
    python candle_patterns.py SBER --all
    python candle_patterns.py ALL  --all --min-fires 50 --out pool_patterns.csv

Аргументы:
    ticker            — тикер или ALL
    --cache DIR       — путь к data/candle_cache (default: рядом со скриптом)
    --interval M      — 5 или 1 (SBER.json vs SBER_1m.json)
    --days D          — глубина, default 180
    --from/--to       — явные границы YYYY-MM-DD (перекрывают --days)
    --all             — весь кэш
    --n N             — окно ATR для нормировки forward-return, default 20
    --k K             — горизонт forward-return в барах, default 12
    --min-fires N     — не показывать паттерны с < N срабатываний
                        (single: default 20, ALL pooled: default 200)
    --out PATH        — CSV со всеми метриками (без флага — только сводка)
    --top N           — печатать топ-N по |Cohen's d| (default 15)
"""
from __future__ import annotations

import argparse
import csv
import json
import math
import os
import sys

# Windows-консоль по умолчанию cp1251 — падает на типографском минусе (U+2212)
# и кириллице в pipe. Форсируем UTF-8; где reconfigure нет — no-op.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):
        pass
from datetime import datetime, timedelta
from typing import Optional

try:
    import numpy as np
    import talib
except ImportError as ex:
    sys.exit(
        "нужен пакет TA-Lib. На Windows проще всего:\n"
        "  pip install numpy\n"
        "  pip install <wheel> из https://github.com/cgohlke/talib-build/releases\n"
        f"текущая ошибка: {ex}"
    )


def _load_from_cache(ticker: str, cache_dir: str, interval_min: int) -> list[dict]:
    suffix = "" if interval_min == 5 else f"_{interval_min}m"
    path = os.path.join(cache_dir, f"{ticker}{suffix}.json")
    if not os.path.exists(path):
        sys.exit(f"нет файла кэша: {path}")
    try:
        with open(path, "r", encoding="utf-8") as f:
            rows = json.load(f)
    except json.JSONDecodeError as ex:
        sys.exit(f"кэш повреждён ({path}): {ex}")
    if not isinstance(rows, list) or not rows:
        sys.exit(f"кэш пустой: {path}")
    rows.sort(key=lambda r: r["time"])
    return rows


def _filter_by_dates(rows: list[dict], date_from: Optional[str],
                      date_to: Optional[str]) -> list[dict]:
    if date_from:
        rows = [r for r in rows if r["time"][:10] >= date_from]
    if date_to:
        rows = [r for r in rows if r["time"][:10] <= date_to]
    return rows


def _slice_by_args(all_rows: list[dict], args) -> list[dict]:
    latest = all_rows[-1]["time"][:10]
    if args.all:
        return all_rows
    to_str = args.date_to or latest
    if args.date_from:
        from_str = args.date_from
    else:
        to_d = datetime.strptime(to_str, "%Y-%m-%d").date()
        from_str = (to_d - timedelta(days=args.days)).isoformat()
    return _filter_by_dates(all_rows, from_str, to_str)


def _list_tickers(cache_dir: str, interval_min: int) -> list[str]:
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


def _pattern_names() -> list[str]:
    """Все функции CDL* из TA-Lib. Берём через get_function_groups —
    это официальный источник, не хардкодим список (при обновлении TA-Lib
    новые паттерны появятся сами)."""
    try:
        return talib.get_function_groups()["Pattern Recognition"]
    except Exception:
        return [n for n in dir(talib) if n.startswith("CDL")]


def _atr_sma(highs, lows, n: int):
    ranges = highs - lows
    atr = np.full_like(ranges, np.nan, dtype=float)
    if len(ranges) < n:
        return atr
    cs = np.cumsum(ranges, dtype=float)
    for i in range(n - 1, len(ranges)):
        atr[i] = (cs[i] - (cs[i - n] if i >= n else 0)) / n
    return atr


def _fwd_ret_bar_native(closes, atr, k: int):
    """(close[i+k] - close[i]) / ATR_N[i]. NaN где ATR ещё не готов или
    выходим за конец истории."""
    n = len(closes)
    out = np.full(n, np.nan, dtype=float)
    for i in range(n - k):
        a = atr[i]
        if np.isnan(a) or a <= 0:
            continue
        out[i] = (closes[i + k] - closes[i]) / a
    return out


def _mean_std(xs) -> tuple[float, float]:
    if len(xs) == 0:
        return 0.0, 0.0
    m = float(np.mean(xs))
    s = float(np.std(xs, ddof=1)) if len(xs) > 1 else 0.0
    return m, s


def _cohens_d(bull_ret, bear_ret) -> Optional[float]:
    """d между «fwd_ret после бычьего срабатывания» и «после медвежьего».
    Положительное = паттерны правильно указывают направление (бык→рост,
    медв→падение). Отрицательное = антисигнал (стабильный fade)."""
    na, nb = len(bull_ret), len(bear_ret)
    if na < 2 or nb < 2:
        return None
    ma, sa = _mean_std(bull_ret)
    mb, sb = _mean_std(bear_ret)
    pooled = math.sqrt(((na - 1) * sa * sa + (nb - 1) * sb * sb)
                        / max(na + nb - 2, 1))
    if pooled <= 0:
        return None
    return (ma - mb) / pooled


def _run_patterns_on_candles(candles: list[dict], n_atr: int, k: int
                              ) -> tuple[dict, np.ndarray, int]:
    """Возвращает (results_by_pattern, fwd_ret_array, n_bars). results —
    dict name → {n_fires, n_bull, n_bear, mean_bull, mean_bear, win_rate, d}."""
    o = np.array([c["open"] for c in candles], dtype=float)
    h = np.array([c["high"] for c in candles], dtype=float)
    l = np.array([c["low"] for c in candles], dtype=float)
    c = np.array([c["close"] for c in candles], dtype=float)
    atr = _atr_sma(h, l, n_atr)
    fwd = _fwd_ret_bar_native(c, atr, k)

    results = {}
    for name in _pattern_names():
        try:
            sig = getattr(talib, name)(o, h, l, c)
        except Exception:
            continue
        # Считаем только бары, где сигнал != 0 И fwd известен И ATR готов.
        mask = (sig != 0) & ~np.isnan(fwd)
        if not mask.any():
            continue
        idxs = np.where(mask)[0]
        signs = sig[idxs]
        rets = fwd[idxs]
        bull_mask = signs > 0
        bear_mask = signs < 0
        bull_rets = rets[bull_mask]
        bear_rets = rets[bear_mask]
        # win-rate: бык→rt>0 или медв→rt<0
        wins = int(((bull_mask & (rets > 0)) | (bear_mask & (rets < 0))).sum())
        results[name] = {
            "n_fires": int(mask.sum()),
            "n_bull":  int(bull_mask.sum()),
            "n_bear":  int(bear_mask.sum()),
            "mean_bull": float(np.mean(bull_rets)) if len(bull_rets) else None,
            "mean_bear": float(np.mean(bear_rets)) if len(bear_rets) else None,
            "win_rate": wins / int(mask.sum()) if mask.sum() else None,
            "d": _cohens_d(bull_rets, bear_rets),
        }
    return results, fwd, len(candles)


def _accumulate(pooled: dict, results: dict) -> None:
    """Складывает per-ticker результаты в пуловые агрегаты.
    Пул хранит только суммы, чтобы не таскать миллионы rets."""
    for name, s in results.items():
        acc = pooled.setdefault(name, {
            "n_fires": 0, "n_bull": 0, "n_bear": 0,
            "sum_bull": 0.0, "sum_bear": 0.0,
            "sqsum_bull": 0.0, "sqsum_bear": 0.0,
            "wins": 0,
        })
        acc["n_fires"] += s["n_fires"]
        acc["n_bull"] += s["n_bull"]
        acc["n_bear"] += s["n_bear"]
        if s["mean_bull"] is not None and s["n_bull"]:
            acc["sum_bull"] += s["mean_bull"] * s["n_bull"]
            # без второй моментности пула d не восстановить точно; храним
            # приближение через накопленную сумму квадратов на per-ticker
            # среднем — грубо, но для ранжирования паттернов ок (реальный
            # d считается в single-режиме на живых массивах).
        if s["mean_bear"] is not None and s["n_bear"]:
            acc["sum_bear"] += s["mean_bear"] * s["n_bear"]
        if s["win_rate"] is not None:
            acc["wins"] += int(s["win_rate"] * s["n_fires"])


def _finalize_pool(pooled: dict) -> dict:
    out = {}
    for name, acc in pooled.items():
        n_fires = acc["n_fires"]
        mean_bull = acc["sum_bull"] / acc["n_bull"] if acc["n_bull"] else None
        mean_bear = acc["sum_bear"] / acc["n_bear"] if acc["n_bear"] else None
        win_rate = acc["wins"] / n_fires if n_fires else None
        # d в пуле — грубая аппроксимация из двух средних, без правильной
        # общей дисперсии (её мы не накопили). Всё равно даёт направление.
        d = None
        if mean_bull is not None and mean_bear is not None:
            d = (mean_bull - mean_bear)  # без нормировки на pooled std
        out[name] = {
            "n_fires": n_fires, "n_bull": acc["n_bull"], "n_bear": acc["n_bear"],
            "mean_bull": mean_bull, "mean_bear": mean_bear,
            "win_rate": win_rate, "d": d,
        }
    return out


def _print_table(results: dict, title: str, min_fires: int, top: int) -> None:
    rows = [(name, s) for name, s in results.items()
            if s["n_fires"] >= min_fires and s["d"] is not None]
    rows.sort(key=lambda x: -abs(x[1]["d"]))
    print(f"\n=== {title} ===")
    print(f"паттернов с n_fires>={min_fires}: {len(rows)} (показываю топ {min(top, len(rows))})")
    if not rows:
        return
    print(f"{'паттерн':<24} {'сраб':>6} ({'бык':>4}/{'медв':>4}) "
          f"{'бык→ret':>8} {'медв→ret':>9} {'d':>7} {'win%':>6}")
    print("-" * 74)
    for name, s in rows[:top]:
        mb = f"{s['mean_bull']:+.3f}" if s['mean_bull'] is not None else "   —  "
        mB = f"{s['mean_bear']:+.3f}" if s['mean_bear'] is not None else "   —  "
        d = f"{s['d']:+.3f}" if s['d'] is not None else "  —  "
        wr = f"{s['win_rate']*100:.1f}" if s['win_rate'] is not None else "  — "
        print(f"{name:<24} {s['n_fires']:>6} ({s['n_bull']:>4}/{s['n_bear']:>4}) "
              f"{mb:>8} {mB:>9} {d:>7} {wr:>6}")


def _write_csv(results: dict, out_path: str, extra: dict = None) -> None:
    fields = ["pattern", "n_fires", "n_bull", "n_bear",
              "mean_bull", "mean_bear", "win_rate", "d"]
    if extra:
        fields = list(extra.keys()) + fields
    with open(out_path, "w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fields)
        w.writeheader()
        # сортировка по |d|
        items = sorted(results.items(),
                        key=lambda x: -abs(x[1]["d"]) if x[1]["d"] is not None else 0)
        for name, s in items:
            row = {"pattern": name, **s}
            if extra:
                row = {**extra, **row}
            for k in list(row.keys()):
                if row[k] is None:
                    row[k] = ""
            w.writerow(row)


def _run_single(args, ticker: str) -> None:
    all_rows = _load_from_cache(ticker, args.cache, args.interval)
    candles = _slice_by_args(all_rows, args)
    print(f"кэш: {ticker} ({args.interval}м), взял {len(candles)} баров "
          f"({candles[0]['time'][:10]}..{candles[-1]['time'][:10]})", file=sys.stderr)
    if len(candles) < args.n + args.k + 20:
        sys.exit(f"свечей мало: {len(candles)}")
    results, _, _ = _run_patterns_on_candles(candles, args.n, args.k)
    min_fires = args.min_fires if args.min_fires is not None else 20
    _print_table(results, f"{ticker} — свечные паттерны TA-Lib",
                  min_fires=min_fires, top=args.top)
    if args.out:
        _write_csv(results, args.out, extra={"ticker": ticker})
        print(f"\nCSV: {args.out}")


def _run_all(args) -> None:
    tickers = _list_tickers(args.cache, args.interval)
    if not tickers:
        sys.exit(f"нет тикеров в {args.cache}")
    print(f"тикеров: {len(tickers)}", file=sys.stderr)
    pooled: dict = {}
    per_ticker_rows: list[dict] = []
    ok = skip = 0
    for idx, ticker in enumerate(tickers, 1):
        try:
            all_rows = _load_from_cache(ticker, args.cache, args.interval)
        except SystemExit:
            skip += 1
            continue
        candles = _slice_by_args(all_rows, args)
        if len(candles) < args.n + args.k + 20:
            print(f"[{idx:>4}/{len(tickers)}] {ticker:<12} skip ({len(candles)} bars)",
                  file=sys.stderr)
            skip += 1
            continue
        results, _, _ = _run_patterns_on_candles(candles, args.n, args.k)
        _accumulate(pooled, results)
        ok += 1
        # per-ticker вывод в CSV — если запрошен
        if args.per_ticker_dir:
            os.makedirs(args.per_ticker_dir, exist_ok=True)
            _write_csv(results, os.path.join(args.per_ticker_dir, f"{ticker}.csv"),
                        extra={"ticker": ticker})
        # summary в общий per-ticker CSV: топ-5 паттернов на тикере
        best = sorted(((n, s) for n, s in results.items()
                       if s["d"] is not None and s["n_fires"] >= 10),
                       key=lambda x: -abs(x[1]["d"]))[:5]
        for name, s in best:
            per_ticker_rows.append({
                "ticker": ticker, "pattern": name,
                "n_fires": s["n_fires"], "d": s["d"], "win_rate": s["win_rate"],
            })
        total_pat = sum(1 for s in results.values() if s["n_fires"] >= 10)
        print(f"[{idx:>4}/{len(tickers)}] {ticker:<12} {len(candles):>6} баров, "
              f"{total_pat} паттернов сработало", file=sys.stderr)

    print(f"\nобработано ok={ok}, skip={skip}", file=sys.stderr)
    finalized = _finalize_pool(pooled)
    min_fires = args.min_fires if args.min_fires is not None else 200
    _print_table(finalized, f"пул из {ok} тикеров",
                  min_fires=min_fires, top=args.top)
    if args.out:
        _write_csv(finalized, args.out)
        print(f"\nсводка пула: {args.out}")
    if per_ticker_rows and args.per_ticker_summary:
        with open(args.per_ticker_summary, "w", encoding="utf-8", newline="") as f:
            w = csv.DictWriter(f, fieldnames=["ticker", "pattern", "n_fires",
                                                "d", "win_rate"])
            w.writeheader()
            for r in per_ticker_rows:
                w.writerow({k: (v if v is not None else "") for k, v in r.items()})
        print(f"per-ticker топ-5: {args.per_ticker_summary}  "
              f"({len(per_ticker_rows)} строк)")


def main() -> None:
    ap = argparse.ArgumentParser(description="Свечные паттерны TA-Lib по кэшу.")
    ap.add_argument("ticker")
    ap.add_argument("--cache", default=os.path.join(
        os.path.dirname(os.path.abspath(__file__)), "data", "candle_cache"))
    ap.add_argument("--interval", type=int, default=5, choices=(1, 5))
    ap.add_argument("--days", type=int, default=180)
    ap.add_argument("--from", dest="date_from", default=None)
    ap.add_argument("--to", dest="date_to", default=None)
    ap.add_argument("--all", action="store_true",
                     help="взять весь кэш")
    ap.add_argument("--n", type=int, default=20,
                     help="окно ATR для нормировки forward-return")
    ap.add_argument("--k", type=int, default=12,
                     help="горизонт forward-return в барах")
    ap.add_argument("--min-fires", type=int, default=None,
                     help="не показывать паттерны с < N срабатываний "
                          "(default: single 20, ALL 200)")
    ap.add_argument("--top", type=int, default=15,
                     help="сколько паттернов показать в таблице (default 15)")
    ap.add_argument("--out", default=None, help="CSV со всеми метриками")
    ap.add_argument("--per-ticker-dir", default=None,
                     help="только ALL: сохранять полную сводку каждого тикера "
                          "в DIR/<ticker>.csv")
    ap.add_argument("--per-ticker-summary", default=None,
                     help="только ALL: CSV с топ-5 паттернов на каждом тикере "
                          "(поиск инструменто-специфичных паттернов)")
    args = ap.parse_args()

    if args.ticker.upper() == "ALL":
        _run_all(args)
    else:
        _run_single(args, args.ticker)


if __name__ == "__main__":
    main()
