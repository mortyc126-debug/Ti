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
    python score_methods.py ALL --workers 8 --stride 3 --by-regime --out scores.csv
    python score_methods.py ALL --workers 8 --stride 3 --by-regime --out scores.csv --resume  # догнать прерванный

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
    --resume            догнать прерванный прогон: пропустить тикеры, уже
                        записанные в --out, дописать остальных; итоговая
                        сводка считается по всему пулу (готовые + новые)
"""
from __future__ import annotations

import argparse
import csv
import json
import math
import multiprocessing as mp
import os
import sys

# Windows-консоль по умолчанию cp1251 — падает на типографском минусе (U+2212)
# и кириллице в pipe. Форсируем UTF-8; где reconfigure нет — no-op.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):
        pass
import statistics
import threading
import time
from datetime import datetime, timedelta
from types import SimpleNamespace
from typing import Optional

# Глобальные внутри воркера — заполняются в _init_worker и переиспользуются.
_WORKER_METHODS = None
_WORKER_NP = None
_WORKER_CLASSIFY_REGIME = None

# Режимы бота — совпадают с REGIMES в regime.py; порядок фиксирован для
# стабильности CSV-колонок.
REGIMES = ("trending_up", "trending_down", "ranging",
            "high_vol", "low_vol", "stress")
ALL_LABEL = "ALL"       # синтетический ярлык «без режимной маски»


def _init_worker():
    """Инициализируется один раз на воркер: импорт стратегии + numpy +
    classify_regime. Активирует локальный tinkoff-stub, если реальный
    SDK не установлен (Python 3.14 wheel пока нет)."""
    global _WORKER_METHODS, _WORKER_NP, _WORKER_CLASSIFY_REGIME
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
    from regime import classify_regime as _cr
    _WORKER_METHODS = ocs.METHODS
    _WORKER_NP = _np
    _WORKER_CLASSIFY_REGIME = _cr


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


def _compute_regime_at(closes_list: list[float], volumes_list: list[float],
                        window: int = 60) -> str:
    """classify_regime на окне последних `window` баров. classify_regime
    сам обрабатывает короткие входы, возвращает (regime, confidence).
    Confidence нам не нужен — на границах режимов вклады обеих сторон
    попадут в разные ведра, что и есть цель."""
    cr = _WORKER_CLASSIFY_REGIME
    if cr is None:
        return "ranging"
    win_cl = closes_list[-window:] if len(closes_list) > window else closes_list
    win_vol = volumes_list[-window:] if len(volumes_list) > window else volumes_list
    try:
        regime, _ = cr(win_cl, win_vol)
        return regime
    except Exception:
        return "ranging"


def _bucket(bull_rets, bear_rets, np):
    """Общие расчёты по одному ведру (bull_rets, bear_rets) → метрики."""
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
    return {
        "n_fires": n_fires, "n_bull": n_bull, "n_bear": n_bear,
        "mean_bull": ma, "mean_bear": mb, "d": d, "win_rate": win_rate,
    }


def _run_ticker(job: dict) -> tuple:
    """Один воркер, один тикер, все методы. Возвращает
    (ticker, {method: {regime: {metrics}, "ALL": {...}}}, (liq, vol)).
    results=None если тикер пропущен."""
    global _WORKER_METHODS, _WORKER_NP
    np = _WORKER_NP
    ticker = job["ticker"]

    rows_raw = _load_from_cache(ticker, job["cache_dir"], job["interval"])
    if not rows_raw:
        return ticker, None, (None, None)
    rows_raw = _filter_by_dates(rows_raw, job["date_from"], job["date_to"])
    W = job["window"]; S = job["stride"]; K = job["k"]; AGREE = job["agree_min"]
    if len(rows_raw) < W + K + 5:
        return ticker, None, (None, None)
    liqvol = _liq_vol(rows_raw)

    candles = [_row_to_ns(r) for r in rows_raw]
    closes_arr = np.array([r["close"]  for r in rows_raw], dtype=float)
    highs      = np.array([r["high"]   for r in rows_raw], dtype=float)
    lows       = np.array([r["low"]    for r in rows_raw], dtype=float)
    vols_arr   = np.array([r["volume"] for r in rows_raw], dtype=float)
    atr = _atr_sma(highs, lows, job["n_atr"])
    fwd = _fwd_ret_bar_native(closes_arr, atr, K)

    by_regime = job.get("by_regime", False)
    regime_win = job.get("regime_window", 60)

    # Заранее считаем режим на каждой позиции i, где будем звонить методам.
    # Это дорого (classify_regime не бесплатна на 60 барах), но делается один
    # раз на тикер, не на каждый метод. С 40 методами экономия огромная.
    positions = list(range(W, len(candles) - K, S))
    if by_regime:
        closes_list = closes_arr.tolist()
        vols_list = vols_arr.tolist()
        regime_at = {}
        for i in positions:
            if np.isnan(fwd[i]):
                continue
            regime_at[i] = _compute_regime_at(
                closes_list[:i + 1], vols_list[:i + 1], regime_win)
    else:
        regime_at = None

    method_filter = job["methods_filter"]
    to_run = [(n, fn) for n, fn in _WORKER_METHODS
              if (not method_filter) or n in method_filter]

    results = {}
    for name, fn in to_run:
        # buckets: {regime_or_"ALL": (bull_rets, bear_rets)}
        buckets: dict[str, tuple[list, list]] = {ALL_LABEL: ([], [])}
        if by_regime:
            for r in REGIMES:
                buckets[r] = ([], [])
        for i in positions:
            if np.isnan(fwd[i]):
                continue
            try:
                score = fn(candles[i - W:i + 1])
            except Exception:
                continue
            if score is None:
                continue
            side = None
            if score >= AGREE:
                side = "bull"
            elif score <= -AGREE:
                side = "bear"
            else:
                continue
            fr = float(fwd[i])
            (bull, bear) = buckets[ALL_LABEL]
            (bull if side == "bull" else bear).append(fr)
            if by_regime:
                r_here = regime_at.get(i, "ranging")
                if r_here in buckets:
                    (rb, rB) = buckets[r_here]
                    (rb if side == "bull" else rB).append(fr)

        # Финализируем каждое ведро
        per_regime = {}
        for label, (bull, bear) in buckets.items():
            per_regime[label] = _bucket(bull, bear, np)
        results[name] = per_regime
    return ticker, results, liqvol


def _accumulate_pool(pool_agg: dict, ticker: str, results: dict,
                      liqvol: tuple = (None, None)) -> None:
    """Копит per-ticker × per-regime результаты. pool_agg[(method, regime)] = {agg}."""
    liq, vol = liqvol
    for name, per_regime in results.items():
        for regime, s in per_regime.items():
            key = (name, regime)
            acc = pool_agg.setdefault(key, {
                "n_fires": 0, "n_bull": 0, "n_bear": 0,
                "sum_bull": 0.0, "sum_bear": 0.0, "wins": 0,
                "n_tickers": 0, "d_values": [], "dl_pairs": [],
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
                # Пара (ликвидность тикера, d этого метода на нём) — для
                # корреляции «работает ли метод сильнее на ликвидных/волатильных».
                if liq is not None:
                    acc["dl_pairs"].append((liq, vol, s["d"]))


def _finalize_pool(pool_agg: dict) -> dict:
    """Финализирует. pool[(method, regime)] = {...}."""
    out = {}
    for key, acc in pool_agg.items():
        n_fires = acc["n_fires"]
        mean_bull = acc["sum_bull"] / acc["n_bull"] if acc["n_bull"] else None
        mean_bear = acc["sum_bear"] / acc["n_bear"] if acc["n_bear"] else None
        win_rate = acc["wins"] / n_fires if n_fires else None
        d_med = None
        if acc["d_values"]:
            xs = sorted(acc["d_values"])
            nl = len(xs)
            d_med = xs[nl // 2] if nl % 2 else 0.5 * (xs[nl // 2 - 1] + xs[nl // 2])
        out[key] = {
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


def _liq_vol(rows_raw: list) -> tuple:
    """Грубые прокси ликвидности и волатильности тикера по свечам:
    liq — медианный барный оборот close·volume (в млн; единицы volume как в
    кэше — для РАНЖИРОВАНИЯ тикеров между собой этого хватает); vol —
    медианный относит. диапазон (high-low)/close в %. Медиана — чтобы не
    ловить единичные всплески. Считается один раз на тикер в воркере."""
    turn = []
    rng = []
    for r in rows_raw:
        cl = float(r["close"])
        if cl <= 0:
            continue
        turn.append(cl * float(r["volume"]))
        rng.append((float(r["high"]) - float(r["low"])) / cl)
    if not turn:
        return (None, None)
    return (statistics.median(turn) / 1e6, statistics.median(rng) * 100.0)


def _pearson_spearman(pairs: list) -> tuple:
    """(pearson, spearman, n) для списка (x, y). Спирмен — ранговый, устойчив
    к выбросам и нелинейности. None если точек мало или нет разброса."""
    pairs = [(x, y) for (x, y) in pairs if x is not None and y is not None]
    n = len(pairs)
    if n < 5:
        return (None, None, n)
    xs = [p[0] for p in pairs]
    ys = [p[1] for p in pairs]

    def pear(a, b):
        ma = sum(a) / len(a); mb = sum(b) / len(b)
        va = sum((x - ma) ** 2 for x in a)
        vb = sum((y - mb) ** 2 for y in b)
        if va == 0 or vb == 0:
            return None
        cov = sum((x - ma) * (y - mb) for x, y in zip(a, b))
        return cov / math.sqrt(va * vb)

    def ranks(v):
        order = sorted(range(len(v)), key=lambda i: v[i])
        rk = [0] * len(v)
        for pos, i in enumerate(order):
            rk[i] = pos
        return rk

    p = pear(xs, ys)
    # pear=None только при нулевой дисперсии x или y — тогда и Спирмен не
    # определён (ранги константы дали бы ложную корреляцию), возвращаем None.
    if p is None:
        return (None, None, n)
    return (p, pear(ranks(xs), ranks(ys)), n)


def _print_ticker_progress(ticker: str, results: dict, done: int, total: int,
                            elapsed: float) -> None:
    """results теперь {method: {regime: {metrics}}}. Печатаем по ALL-ярлыку."""
    with_d = [(n, per_reg[ALL_LABEL]) for n, per_reg in results.items()
              if per_reg.get(ALL_LABEL, {}).get("d") is not None
              and per_reg[ALL_LABEL]["n_fires"] >= 30]
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


def _print_final(pool: dict, min_fires: int, by_regime: bool) -> None:
    """pool: {(method, regime): {...}}. Печатаем ALL-разрез (совместимо с
    прошлыми выводами) + матрицу метод × режим + генерацию REGIME_WEIGHT_MODS."""
    all_only = {n: s for (n, r), s in pool.items() if r == ALL_LABEL}
    valid_all = [(n, s) for n, s in all_only.items()
                  if s["d_median"] is not None and s["n_fires"] >= min_fires]

    signal = sorted((x for x in valid_all if x[1]["d_median"] > 0.05),
                     key=lambda x: -x[1]["d_median"])[:15]
    anti = sorted((x for x in valid_all if x[1]["d_median"] < -0.05),
                   key=lambda x: x[1]["d_median"])[:15]
    contrib = sorted(valid_all,
                      key=lambda x: -x[1]["n_fires"] * abs(x[1]["d_median"]))[:15]
    noise = sorted((x for x in valid_all if abs(x[1]["d_median"]) <= 0.05),
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

    print(hdr("топ SIGNAL по ALL (d > +0.05)"))
    for n, s in signal: print(row(n, s))
    print(hdr("топ ANTI по ALL (d < −0.05)"))
    for n, s in anti:   print(row(n, s))
    print(hdr("топ CONTRIBUTION по ALL (n_fires × |d|)"))
    for n, s in contrib: print(row(n, s))
    print(hdr("топ NOISE по ALL (|d| ≤ 0.05)"))
    for n, s in noise:  print(row(n, s))

    if not by_regime:
        # Совместимый вывод рекомендаций для не-режимного прогона
        inv = [n for n, s in valid_all if s["d_median"] < -0.05
                                        and s["n_fires"] >= min_fires * 2]
        dis = [n for n, s in valid_all if abs(s["d_median"]) <= 0.05
                                        and s["n_fires"] >= min_fires * 5]
        print(f"\n→ рекомендация к _inverted_methods = {sorted(inv)}")
        print(f"→ рекомендация к _disabled_methods = {sorted(dis)}")
        return

    # ── Режимный анализ ──
    # Матрица метод × режим (d) на пуле — компактная.
    all_methods = sorted({n for (n, r) in pool.keys()})
    print(f"\n=== матрица d_median по режимам (пул) ===")
    print(f"{'метод':<24}" + "".join(f"{r:>14}" for r in REGIMES))
    print("-" * (24 + 14 * len(REGIMES)))
    for name in all_methods:
        parts = [f"{name:<24}"]
        for r in REGIMES:
            s = pool.get((name, r))
            if not s or s["d_median"] is None or s["n_fires"] < min_fires // 3:
                parts.append(f"{'—':>14}")
                continue
            d = s["d_median"]
            role = _role(d)
            tag = "s" if role == "signal" else "a" if role == "anti" else "n"
            parts.append(f"{d:+.3f}[{tag}] n={s['n_fires']:>5}"[:14].rjust(14))
        print("".join(parts))

    # Классификация метода целиком:
    # - «универсал signal»: d>+0.05 во всех режимах с достаточным n
    # - «универсал anti»: d<-0.05 во всех режимах с достаточным n
    # - «режимный» — знак разный в разных режимах
    # - «шум» — везде в нейтрали
    universals_sig = []
    universals_anti = []
    regimenal = []
    all_noise = []
    for name in all_methods:
        signs = []
        for r in REGIMES:
            s = pool.get((name, r))
            if not s or s["d_median"] is None or s["n_fires"] < min_fires // 3:
                signs.append(None)
                continue
            d = s["d_median"]
            if d > 0.05:   signs.append("+")
            elif d < -0.05: signs.append("-")
            else:           signs.append("0")
        realized = [x for x in signs if x is not None]
        if not realized:
            continue
        if all(x == "+" for x in realized):
            universals_sig.append(name)
        elif all(x == "-" for x in realized):
            universals_anti.append(name)
        elif "+" in realized and "-" in realized:
            regimenal.append((name, signs))
        elif all(x == "0" for x in realized):
            all_noise.append(name)

    print(f"\nуниверсал SIGNAL (везде работают правильно): {sorted(universals_sig)}")
    print(f"универсал ANTI (везде наоборот, глобально инвертировать): {sorted(universals_anti)}")
    print(f"шум во всех режимах (кандидат в disable): {sorted(all_noise)}")
    if regimenal:
        print(f"\n=== режимные методы: разный знак в разных режимах ===")
        print(f"{'метод':<24}" + "".join(f"{r:>14}" for r in REGIMES))
        for name, signs in regimenal:
            marks = "".join(f"{('+++' if x=='+' else '---' if x=='-' else '···' if x=='0' else '   '):>14}"
                             for x in signs)
            print(f"{name:<24}{marks}")

    # Генерация REGIME_WEIGHT_MODS.
    # Формат: {regime: {method: multiplier}}. multiplier: -1 (инвертировать),
    # 0 (выключить), +1 (усилить/оставить как есть). Для нейтрали (|d|≤0.05)
    # НЕ пишем ничего — оставим текущий вес из бота.
    generated = {r: {} for r in REGIMES}
    for (name, r), s in pool.items():
        if r == ALL_LABEL:
            continue
        if s["d_median"] is None or s["n_fires"] < min_fires // 3:
            continue
        d = s["d_median"]
        if d > 0.05:    generated[r][name] = 1.0
        elif d < -0.05: generated[r][name] = -1.0
        # noise — не трогаем (оставляем текущий вес)

    print(f"\n=== сгенерированный REGIME_WEIGHT_MODS ===")
    print("# +1.0 — метод работает правильно в этом режиме, оставить/усилить")
    print("# -1.0 — метод стабильно наоборот, ИНВЕРТИРОВАТЬ через режимный множитель")
    print("REGIME_WEIGHT_MODS_AUTO = {")
    for r in REGIMES:
        items = generated[r]
        if not items:
            print(f'    "{r}": {{}},')
            continue
        pos = {n: v for n, v in items.items() if v > 0}
        neg = {n: v for n, v in items.items() if v < 0}
        print(f'    "{r}": {{')
        if pos:
            print(f'        # signal (оставить, IC подстроит):')
            for n in sorted(pos): print(f'        "{n}": +1.0,')
        if neg:
            print(f'        # anti (инвертировать):')
            for n in sorted(neg): print(f'        "{n}": -1.0,')
        print(f'    }},')
    print("}")


def _print_liquidity_dependency(pool_agg: dict, min_tickers: int = 15) -> None:
    """Для каждого метода: зависит ли его edge (d по тикерам) от ликвидности и
    волатильности тикера. Считается по ALL-разрезу (без режимной маски).
    Spearman(d, log10 liq) и Spearman(d, vol) + медиана d по третям
    ликвидности — трети ловят немонотонность (метод работает на средних, а
    топ-ликвиды инвертированы — «SBER-класс»), которую корреляция маскирует.
    Сырьё — data[--out].csv (столбцы liq_mln/vol_pct); тут печатается сводка."""
    methods = sorted({n for (n, r) in pool_agg.keys() if r == ALL_LABEL})
    rows = []
    for name in methods:
        acc = pool_agg.get((name, ALL_LABEL))
        pairs = acc.get("dl_pairs", []) if acc else []
        pairs = [(liq, vol, d) for (liq, vol, d) in pairs
                 if liq is not None and liq > 0 and d is not None]
        if len(pairs) < min_tickers:
            continue
        liq_d = [(math.log10(liq), d) for (liq, vol, d) in pairs]
        vol_d = [(vol, d) for (liq, vol, d) in pairs if vol is not None]
        _, sp_liq, n = _pearson_spearman(liq_d)
        _, sp_vol, _ = _pearson_spearman(vol_d)
        # трети по ликвидности
        srt = sorted(pairs, key=lambda x: x[0])
        t = len(srt) // 3
        lo = [d for (_, _, d) in srt[:t]]
        hi = [d for (_, _, d) in srt[2 * t:]]
        med_lo = statistics.median(lo) if lo else None
        med_hi = statistics.median(hi) if hi else None
        rows.append((name, n, sp_liq, sp_vol, med_lo, med_hi))
    if not rows:
        return
    # Сортируем по силе связи с ликвидностью
    rows.sort(key=lambda r: -(abs(r[2]) if r[2] is not None else 0))
    print("\n=== зависимость edge (d) метода от ликвидности/волатильности тикера ===")
    print("# по ALL-разрезу. Spearman: +сильнее на ликвидных/волатильных,")
    print("#  −сильнее на неликвидных/спокойных. d_lo/d_hi — медиана d в нижней/")
    print("#  верхней трети по ликвидности (расходятся при знаке = немонотонность).")
    print(f"{'метод':<24}{'n_tk':>5}{'sp_liq':>8}{'sp_vol':>8}"
          f"{'d_lo':>8}{'d_hi':>8}  флаг")
    print("-" * 76)
    for name, n, sl, sv, dlo, dhi in rows:
        f_sl = f"{sl:+.2f}" if sl is not None else "  —"
        f_sv = f"{sv:+.2f}" if sv is not None else "  —"
        f_lo = f"{dlo:+.3f}" if dlo is not None else "  —"
        f_hi = f"{dhi:+.3f}" if dhi is not None else "  —"
        flag = ""
        if sl is not None and abs(sl) >= 0.3:
            flag = "ЛИКВ-зависим"
        if dlo is not None and dhi is not None and dlo * dhi < 0:
            flag = (flag + " " if flag else "") + "знак-флип по ликв"
        print(f"{name:<24}{n:>5}{f_sl:>8}{f_sv:>8}{f_lo:>8}{f_hi:>8}  {flag}")
    print("\n(Полная матрица метод×режим×тикер с liq/vol — в CSV из --out.)")


def _load_done_from_csv(path: str) -> tuple:
    """Читает уже записанный --out CSV для --resume. Возвращает
    ({ticker: results}, {ticker: (liq, vol)}), где results[method][regime] —
    те же метрики, что копит _accumulate_pool. Пустой при отсутствии/ошибке."""
    done: dict = {}
    liq_of: dict = {}
    if not path or not os.path.exists(path) or os.path.getsize(path) == 0:
        return done, liq_of

    def fnum(v):
        return float(v) if v not in ("", None) else None

    def inum(v):
        return int(v) if v not in ("", None) else 0

    try:
        with open(path, "r", encoding="utf-8", newline="") as f:
            for row in csv.DictReader(f):
                tk = row.get("ticker")
                meth = row.get("method")
                reg = row.get("regime")
                if not tk or not meth or not reg:
                    continue
                res = done.setdefault(tk, {})
                res.setdefault(meth, {})[reg] = {
                    "n_fires": inum(row.get("n_fires")),
                    "n_bull": inum(row.get("n_bull")),
                    "n_bear": inum(row.get("n_bear")),
                    "mean_bull": fnum(row.get("mean_bull")),
                    "mean_bear": fnum(row.get("mean_bear")),
                    "win_rate": fnum(row.get("win_rate")),
                    "d": fnum(row.get("d")),
                }
                liq_of[tk] = (fnum(row.get("liq_mln")), fnum(row.get("vol_pct")))
    except (OSError, csv.Error, ValueError):
        return {}, {}
    return done, liq_of


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
                     help="CSV per-ticker × per-regime результатов (append)")
    ap.add_argument("--pool-out", default=None,
                     help="CSV пуловой сводки (метод × режим)")
    ap.add_argument("--by-regime", action="store_true",
                     help="Разбить метрики по режимам (classify_regime бота: "
                          "trending_up/down, ranging, high_vol/low_vol, stress). "
                          "В отчёте появится матрица метод×режим и сгенерируется "
                          "REGIME_WEIGHT_MODS_AUTO для копирования в бот.")
    ap.add_argument("--regime-window", type=int, default=60,
                     help="Окно последних баров для classify_regime (default 60)")
    ap.add_argument("--resume", action="store_true",
                     help="Догнать прерванный прогон: пропустить тикеры, уже "
                          "записанные в --out CSV, и дописать в него (append). "
                          "Готовые тикеры подтягиваются обратно в итоговую сводку.")
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

    # n_universe — размер полного пула ДО отсева готовых (--resume). По нему
    # выбираем min_fires и порог печати ликвид-сводки, чтобы догон не занижал.
    n_universe = len(tickers)
    resume_done: dict = {}
    resume_liq: dict = {}
    if args.resume:
        resume_done, resume_liq = _load_done_from_csv(args.out) if args.out else ({}, {})
        if resume_done:
            tickers = [t for t in tickers if t not in resume_done]
            print(f"resume: {len(resume_done)} тикеров уже в {args.out}, "
                  f"осталось {len(tickers)}", file=sys.stderr)

    print(f"тикеров к прогону: {len(tickers)}, воркеров: {args.workers}, "
          f"window={args.window}, stride={args.stride}, k={args.k}", file=sys.stderr)

    # Формируем задания. Дата-фильтр: если date_from/to заданы — используем как
    # есть; иначе пусть воркер сам обрежет по --days от последнего бара.
    # Для простоты: если --all — всю историю; иначе передаём days и воркер
    # обрежет сам.
    def build_job(tk):
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
            "by_regime": args.by_regime,
            "regime_window": args.regime_window,
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

    # CSV per-ticker × per-regime: инкрементальная запись
    per_ticker_fp = None
    per_ticker_writer = None
    if args.out:
        # При --resume с непустым файлом — дописываем (append), заголовок не
        # трогаем. Иначе перезаписываем с нуля.
        append = bool(resume_done)
        per_ticker_fp = open(args.out, "a" if append else "w",
                             encoding="utf-8", newline="")
        per_ticker_writer = csv.DictWriter(per_ticker_fp, fieldnames=[
            "ticker", "method", "regime", "liq_mln", "vol_pct",
            "n_fires", "n_bull", "n_bear",
            "mean_bull", "mean_bear", "win_rate", "d", "role"])
        if not append:
            per_ticker_writer.writeheader()

    def _write_ticker(ticker, results, liqvol=(None, None)):
        if not per_ticker_writer:
            return
        liq, vol = liqvol
        liq_s = f"{liq:.4f}" if liq is not None else ""
        vol_s = f"{vol:.4f}" if vol is not None else ""
        for name, per_regime in results.items():
            for regime, s in per_regime.items():
                per_ticker_writer.writerow({
                    "ticker": ticker, "method": name, "regime": regime,
                    "liq_mln": liq_s, "vol_pct": vol_s,
                    "n_fires": s["n_fires"], "n_bull": s["n_bull"],
                    "n_bear": s["n_bear"],
                    "mean_bull": s["mean_bull"] if s["mean_bull"] is not None else "",
                    "mean_bear": s["mean_bear"] if s["mean_bear"] is not None else "",
                    "win_rate": s["win_rate"] if s["win_rate"] is not None else "",
                    "d": s["d"] if s["d"] is not None else "",
                    "role": _role(s["d"]),
                })
        per_ticker_fp.flush()

    pool_agg: dict = {}
    # Подтягиваем готовые тикеры (--resume) в агрегат, чтобы финальная сводка
    # и ликвид-зависимость считались по всему пулу, а не только по новым.
    for tk, results in resume_done.items():
        _accumulate_pool(pool_agg, tk, results, resume_liq.get(tk, (None, None)))
    t_start = time.time()
    done = 0

    # Heartbeat в фоновом потоке. Между результатами воркеров может быть
    # 30-60 секунд тишины (classify_regime + 40 методов на 39k баров — не
    # быстро), из-за чего кажется что процесс висит. Раз в 30 сек печатаем
    # elapsed + скорость. Поток закрывается по завершении цикла воркеров.
    hb_stop = threading.Event()
    hb_state = {"done": 0, "total": len(tickers)}

    def _heartbeat():
        while not hb_stop.wait(30.0):
            elapsed = time.time() - t_start
            d = hb_state["done"]; tot = hb_state["total"]
            rate = d / elapsed if elapsed > 0 else 0
            eta = (tot - d) / rate if rate > 0 else 0
            print(f"[heartbeat] прошло {elapsed:>5.0f}с | {d}/{tot} тикеров | "
                  f"{rate:.2f} тик/с | ETA ~{eta:>4.0f}с", file=sys.stderr, flush=True)
    hb_thread = threading.Thread(target=_heartbeat, daemon=True)
    hb_thread.start()

    if args.workers == 1 or len(tickers) == 1:
        _init_worker()
        for job in jobs:
            ticker, results, liqvol = _run_ticker(job)
            done += 1
            if results is None:
                print(f"[{done}/{len(tickers)}] {ticker}: SKIP", file=sys.stderr)
                continue
            _print_ticker_progress(ticker, results, done, len(tickers),
                                    time.time() - t_start)
            _accumulate_pool(pool_agg, ticker, results, liqvol)
            _write_ticker(ticker, results, liqvol)
            hb_state["done"] = done
    else:
        with mp.Pool(processes=args.workers, initializer=_init_worker) as pool:
            for ticker, results, liqvol in pool.imap_unordered(_run_ticker, jobs):
                done += 1
                if results is None:
                    print(f"[{done}/{len(tickers)}] {ticker}: SKIP", file=sys.stderr)
                    continue
                _print_ticker_progress(ticker, results, done, len(tickers),
                                        time.time() - t_start)
                _accumulate_pool(pool_agg, ticker, results, liqvol)
                _write_ticker(ticker, results, liqvol)

    # Останавливаем heartbeat перед финальным выводом
    hb_stop.set()
    hb_thread.join(timeout=1)

    if per_ticker_fp:
        per_ticker_fp.close()

    pool = _finalize_pool(pool_agg)
    if args.pool_out:
        with open(args.pool_out, "w", encoding="utf-8", newline="") as f:
            w = csv.DictWriter(f, fieldnames=[
                "method", "regime", "n_fires", "n_bull", "n_bear",
                "mean_bull", "mean_bear", "win_rate",
                "d_median", "n_tickers", "role"])
            w.writeheader()
            for (name, regime), s in sorted(pool.items(),
                                              key=lambda x: (x[0][0], x[0][1])):
                w.writerow({
                    "method": name, "regime": regime,
                    "n_fires": s["n_fires"],
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
        min_fires = 50 if n_universe == 1 else 500
    _print_final(pool, min_fires, args.by_regime)
    # Зависимость edge от ликвидности/волатильности имеет смысл только на пуле
    # (по одному тикеру корреляции нет). Считаем по всему пулу (n_universe),
    # включая подтянутые --resume тикеры.
    if n_universe >= 15:
        _print_liquidity_dependency(pool_agg)


if __name__ == "__main__":
    # Windows: spawn требует явного main-гарда. Без него воркеры войдут в
    # бесконечную рекурсию импорта.
    mp.freeze_support()
    main()
