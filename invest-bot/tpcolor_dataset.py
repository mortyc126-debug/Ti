"""
tpcolor_dataset.py — сборка датасета для концепции T/P/color
(kontseptsiya_temperatura_davlenie_pamyat_2.md).

Читает свечи из локального кэша, который наполняет candle_archive.py при
работе бота: data/candle_cache/<TICKER>.json — 5-мин, <TICKER>_1m.json —
1-мин, отсортированный список {time, open, high, low, close, volume}.
Сеть скрипту не нужна вообще: у SBER на диске легко бывает 20 МБ (годы
истории), запросы через D1-воркер были бы медленнее и без явной пользы.

По каждому бару считаются:

  Layer 1 (микро):
    T     = volume * (high-low) / ATR_N          # интенсивность, direction-agnostic
    P     = |close[i]-close[i-N]| / Σ|Δclose|    # efficiency_ratio на окне N
    color = сглаженное ускорение цены            # EMA(v[i]-v[i-N]), v = ROC(close,N)

  Макро-контекст (для веса кандидатов в памяти, §11.4):
    T_macro, P_macro — те же формулы, но с окном N_macro >> N.

  Каузальная нормализация (§11.1) — rolling z-score по окну W_norm,
  считается только по прошлому: x̂[i] = (x[i]-mean[i-W:i])/std[i-W:i].

  Layer 3 — bar-native таргет (§11.6):
    fwd_ret_k = (close[i+k]-close[i]) / ATR_N[i]     # нормирован на волатильность
    target    = sign(fwd_ret_k)                       # -1/0/+1

  Фильтр лукахеда (§11.3): outcome_known=1 только если i+k < len(candles).

CSV со всеми колонками → --out <path>.  Печатается сводка:
- Пирсон-корреляции T̂↔P̂, T̂↔color̂, P̂↔color̂  (шаги 1-3 из §8 документа)
- баланс target
- покрытие валидных строк

Опционально --plot строит 3D-скаттер (T̂,P̂,color̂), окрашенный target'ом
— matplotlib нужен только при этом флаге.

Только stdlib для основной работы; никаких pandas/numpy.

Запуск (из invest-bot/):
    python tpcolor_dataset.py SBER --days 180 --n 20 --k 12 --out sber_tpc.csv
    python tpcolor_dataset.py SBER --days 180 --plot        # + 3D-скаттер
    python tpcolor_dataset.py SBER --all --interval 1       # все 1-мин свечи из кэша
    python tpcolor_dataset.py ALL  --days 180 --out corr_all.csv
                                                            # прогон по ВСЕМ тикерам кэша:
                                                            # ticker,n_bars,corr_TP,corr_Tc,corr_Pc,pos,neg,zer
    python tpcolor_dataset.py ALL  --all --per-ticker-dir out/per_ticker
                                                            # + каждый датасет отдельным CSV в папку

Аргументы:
    ticker            — тикер (SBER, GAZP, ...) — имя файла кэша без .json;
                        либо ALL — прогон по всем файлам, только сводка корреляций
    --cache DIR       — путь к data/candle_cache (default: рядом со скриптом)
    --interval M      — 5 или 1 (SBER.json vs SBER_1m.json), default 5
    --days D          — глубина периода от --to назад в днях, default 180
    --from YYYY-MM-DD — явная дата начала (перекрывает --days)
    --to   YYYY-MM-DD — явная дата конца (default: последний бар из кэша)
    --all             — взять весь кэш, игнорируя --days/--from/--to
    --n N             — базовое окно Layer 1 (ATR/ER/ROC), default 20
    --n-macro N       — окно макро-контекста, default 200
    --w-norm W        — окно каузальной z-нормализации, default 500
    --k K             — горизонт forward-return, default 12
    --min-volume V    — отсекать бары с volume<V (default 0)
    --out PATH        — CSV: датасет (одиночный тикер) или сводка корреляций (ALL)
    --plot            — 3D scatter T̂/P̂/color̂ (нужен matplotlib, только для одиночного)
    --per-ticker-dir  — только для ALL: сохранять полный датасет каждого тикера
                        в DIR/<ticker>.csv (может быть много ГБ на пуле)
"""
from __future__ import annotations

import argparse
import csv
import json
import math
import os
import sys
from datetime import datetime, timedelta, timezone
from typing import Optional


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
        sys.exit(f"кэш пустой: {path} (в списке эмитентов такое встречается — "
                 f"воркер не собирал этот тикер)")
    rows.sort(key=lambda r: r["time"])
    return rows


def _filter_by_dates(rows: list[dict],
                      date_from: Optional[str],
                      date_to: Optional[str]) -> list[dict]:
    """Отсекает по префиксу времени (ISO YYYY-MM-DD...). date_to включительно."""
    if date_from:
        rows = [r for r in rows if r["time"][:10] >= date_from]
    if date_to:
        rows = [r for r in rows if r["time"][:10] <= date_to]
    return rows


def _list_tickers(cache_dir: str, interval_min: int) -> list[str]:
    """Все тикеры, у которых есть непустой JSON под нужный интервал.
    Пустые (2-байтные "[]") пропускаются заранее — тогда прогон по ALL не
    падает и не забивает сводку строками про мёртвые фьючерсы."""
    if not os.path.isdir(cache_dir):
        sys.exit(f"нет папки кэша: {cache_dir}")
    suffix = "" if interval_min == 5 else f"_{interval_min}m"
    out: list[str] = []
    for name in os.listdir(cache_dir):
        if not name.endswith(".json"):
            continue
        base = name[:-5]
        if interval_min == 5 and base.endswith("_1m"):
            continue
        if interval_min == 1 and not base.endswith("_1m"):
            continue
        ticker = base[:-3] if interval_min == 1 else base
        path = os.path.join(cache_dir, name)
        if os.path.getsize(path) < 100:
            continue
        out.append(ticker)
    out.sort()
    return out


def _sma(xs: list[float], n: int) -> list[Optional[float]]:
    out: list[Optional[float]] = [None] * len(xs)
    if n <= 0 or len(xs) < n:
        return out
    s = sum(xs[:n])
    out[n - 1] = s / n
    for i in range(n, len(xs)):
        s += xs[i] - xs[i - n]
        out[i] = s / n
    return out


def _ema(xs: list[Optional[float]], span: int) -> list[Optional[float]]:
    alpha = 2.0 / (span + 1)
    out: list[Optional[float]] = [None] * len(xs)
    prev: Optional[float] = None
    for i, x in enumerate(xs):
        if x is None:
            out[i] = prev
            continue
        prev = x if prev is None else alpha * x + (1 - alpha) * prev
        out[i] = prev
    return out


def _efficiency_ratio_series(closes: list[float], n: int) -> list[Optional[float]]:
    """P — ER Кауфмана, скользящее окно n на closes."""
    out: list[Optional[float]] = [None] * len(closes)
    if len(closes) <= n:
        return out
    abs_diffs = [abs(closes[i] - closes[i - 1]) for i in range(1, len(closes))]
    # префиксные суммы модулей приращений — чтобы ER считался O(1) на бар
    pref = [0.0]
    for d in abs_diffs:
        pref.append(pref[-1] + d)
    for i in range(n, len(closes)):
        vol = pref[i] - pref[i - n]
        if vol <= 0:
            out[i] = 0.0
            continue
        out[i] = abs(closes[i] - closes[i - n]) / vol
    return out


def _roc(closes: list[float], n: int) -> list[Optional[float]]:
    out: list[Optional[float]] = [None] * len(closes)
    for i in range(n, len(closes)):
        base = closes[i - n]
        if base == 0:
            continue
        out[i] = (closes[i] - base) / base
    return out


def _rolling_zscore(xs: list[Optional[float]], w: int) -> list[Optional[float]]:
    """Каузальная z-нормализация: mean/std по [i-w : i] (окно НЕ включает i)."""
    out: list[Optional[float]] = [None] * len(xs)
    buf: list[float] = []
    for i, x in enumerate(xs):
        if len(buf) >= w:
            mean = sum(buf) / len(buf)
            var = sum((b - mean) ** 2 for b in buf) / len(buf)
            std = math.sqrt(var)
            if x is not None and std > 0:
                out[i] = (x - mean) / std
        if x is not None:
            buf.append(x)
            if len(buf) > w:
                buf.pop(0)
    return out


def _pearson(a: list[Optional[float]], b: list[Optional[float]]) -> Optional[float]:
    pairs = [(x, y) for x, y in zip(a, b) if x is not None and y is not None]
    if len(pairs) < 3:
        return None
    xs = [p[0] for p in pairs]
    ys = [p[1] for p in pairs]
    mx = sum(xs) / len(xs)
    my = sum(ys) / len(ys)
    num = sum((x - mx) * (y - my) for x, y in pairs)
    dx = math.sqrt(sum((x - mx) ** 2 for x in xs))
    dy = math.sqrt(sum((y - my) ** 2 for y in ys))
    if dx == 0 or dy == 0:
        return None
    return num / (dx * dy)


def build_dataset(
    candles: list[dict],
    n: int = 20,
    n_macro: int = 200,
    w_norm: int = 500,
    k: int = 12,
    min_volume: float = 0.0,
) -> list[dict]:
    opens = [c["open"] for c in candles]
    highs = [c["high"] for c in candles]
    lows = [c["low"] for c in candles]
    closes = [c["close"] for c in candles]
    vols = [float(c["volume"]) for c in candles]
    ranges = [h - l for h, l in zip(highs, lows)]
    N = len(candles)

    atr_n = _sma(ranges, n)                                # ATR как SMA(range,n)
    atr_macro = _sma(ranges, n_macro)

    T: list[Optional[float]] = [None] * N
    T_macro: list[Optional[float]] = [None] * N
    for i in range(N):
        a = atr_n[i]
        if a is not None and a > 0:
            T[i] = vols[i] * ranges[i] / a
        am = atr_macro[i]
        if am is not None and am > 0:
            # T_macro — сглажённая интенсивность за длинное окно (усреднение по n_macro)
            T_macro[i] = sum(vols[i - n_macro + 1: i + 1]) * (sum(ranges[i - n_macro + 1: i + 1]) / n_macro) / (am * n_macro) if i >= n_macro - 1 else None
    # Дешевле — переопределим T_macro как SMA(T) по n_macro:
    T_macro = _sma([t if t is not None else 0.0 for t in T], n_macro)

    P = _efficiency_ratio_series(closes, n)
    P_macro = _efficiency_ratio_series(closes, n_macro)

    # color = EMA(v[i]-v[i-n], span=n),  v = ROC(close,n) — сглажённое ускорение
    v = _roc(closes, n)
    accel_raw: list[Optional[float]] = [None] * N
    for i in range(n, N):
        if v[i] is not None and v[i - n] is not None:
            accel_raw[i] = v[i] - v[i - n]
    color = _ema(accel_raw, n)

    # Каузальная z-нормализация всех осей
    T_hat = _rolling_zscore(T, w_norm)
    P_hat = _rolling_zscore(P, w_norm)
    color_hat = _rolling_zscore(color, w_norm)
    T_macro_hat = _rolling_zscore(T_macro, w_norm)
    P_macro_hat = _rolling_zscore(P_macro, w_norm)

    # Layer 3 — bar-native forward-k доходность, нормированная на ATR
    fwd_ret: list[Optional[float]] = [None] * N
    target: list[Optional[int]] = [None] * N
    for i in range(N - k):
        a = atr_n[i]
        if a is None or a <= 0:
            continue
        fr = (closes[i + k] - closes[i]) / a
        fwd_ret[i] = fr
        target[i] = 1 if fr > 0 else (-1 if fr < 0 else 0)

    rows: list[dict] = []
    for i, c in enumerate(candles):
        if vols[i] < min_volume:
            continue
        outcome_known = 1 if (i + k) < N and target[i] is not None else 0
        rows.append({
            "time": c["time"],
            "open": opens[i],
            "high": highs[i],
            "low": lows[i],
            "close": closes[i],
            "volume": vols[i],
            "range": ranges[i],
            "atr_n": atr_n[i],
            "T": T[i],
            "P": P[i],
            "color": color[i],
            "T_macro": T_macro[i],
            "P_macro": P_macro[i],
            "T_hat": T_hat[i],
            "P_hat": P_hat[i],
            "color_hat": color_hat[i],
            "T_macro_hat": T_macro_hat[i],
            "P_macro_hat": P_macro_hat[i],
            "fwd_ret_k": fwd_ret[i],
            "target": target[i],
            "outcome_known": outcome_known,
        })
    return rows


def _summary(rows: list[dict]) -> dict:
    """Сжатая сводка по одному тикеру — используется и для консольного
    отчёта, и для строки сводной таблицы в ALL-режиме."""
    valid_hat = [r for r in rows if r["T_hat"] is not None
                 and r["P_hat"] is not None and r["color_hat"] is not None]
    valid_outcome = [r for r in rows if r["outcome_known"] == 1]

    def col(name):
        return [r[name] for r in valid_hat]

    tgts = [r["target"] for r in valid_outcome if r["target"] is not None]
    return {
        "n_bars": len(rows),
        "n_valid": len(valid_hat),
        "n_outcome": len(valid_outcome),
        "corr_TP": _pearson(col("T_hat"), col("P_hat")),
        "corr_Tc": _pearson(col("T_hat"), col("color_hat")),
        "corr_Pc": _pearson(col("P_hat"), col("color_hat")),
        "target_pos": sum(1 for t in tgts if t > 0),
        "target_neg": sum(1 for t in tgts if t < 0),
        "target_zer": sum(1 for t in tgts if t == 0),
    }


def _fmt_corr(x: Optional[float]) -> str:
    return f"{x:+.3f}" if x is not None else "n/a"


def _mean_std(xs: list[float]) -> tuple[float, float]:
    n = len(xs)
    if n == 0:
        return 0.0, 0.0
    m = sum(xs) / n
    var = sum((x - m) ** 2 for x in xs) / max(n - 1, 1)
    return m, math.sqrt(max(var, 0.0))


def _welch(a: list[float], b: list[float]) -> tuple[Optional[float], Optional[float]]:
    """(t-статистика Welch, Cohen's d по объединённому SD). p-value не считаю —
    при n в десятки тысяч он всегда ~0 и ничего не различает; смысла больше в
    Cohen's d (величина эффекта), которая от n не зависит."""
    na, nb = len(a), len(b)
    if na < 2 or nb < 2:
        return None, None
    ma, sa = _mean_std(a)
    mb, sb = _mean_std(b)
    se = math.sqrt(sa * sa / na + sb * sb / nb)
    if se <= 0:
        return None, None
    t = (ma - mb) / se
    pooled = math.sqrt(((na - 1) * sa * sa + (nb - 1) * sb * sb) / max(na + nb - 2, 1))
    d = (ma - mb) / pooled if pooled > 0 else None
    return t, d


def _split_by_color(rows: list[dict], filt) -> tuple[list[float], list[float]]:
    """Возвращает (fwd_ret для color̂>0, fwd_ret для color̂<0). filt — предикат,
    отсекающий бары дополнительно (например, квадрантный фильтр). Обязательно:
    T_hat/P_hat/color_hat/fwd_ret_k валидны, outcome_known=1."""
    pos: list[float] = []
    neg: list[float] = []
    for r in rows:
        if r["T_hat"] is None or r["P_hat"] is None or r["color_hat"] is None:
            continue
        if r["fwd_ret_k"] is None or r["outcome_known"] != 1:
            continue
        if not filt(r):
            continue
        if r["color_hat"] > 0:
            pos.append(r["fwd_ret_k"])
        elif r["color_hat"] < 0:
            neg.append(r["fwd_ret_k"])
    return pos, neg


def _print_split(label: str, pos: list[float], neg: list[float]) -> None:
    ma, sa = _mean_std(pos)
    mb, sb = _mean_std(neg)
    win_pos = sum(1 for x in pos if x > 0) / max(len(pos), 1)
    win_neg = sum(1 for x in neg if x > 0) / max(len(neg), 1)
    t, d = _welch(pos, neg)
    print(f"  {label}")
    print(f"    color̂>0: n={len(pos):>7}  mean(fwd_ret_k)={ma:+.4f}  "
          f"std={sa:.4f}  win-rate={win_pos:.3f}")
    print(f"    color̂<0: n={len(neg):>7}  mean(fwd_ret_k)={mb:+.4f}  "
          f"std={sb:.4f}  win-rate={win_neg:.3f}")
    if t is not None:
        print(f"    Δmean={ma-mb:+.4f}   Welch-t={t:+.2f}   Cohen's d={d:+.3f}"
              if d is not None else
              f"    Δmean={ma-mb:+.4f}   Welch-t={t:+.2f}")


def _quadrant_report(rows: list[dict], t_lo: float, p_hi: float,
                      title: str) -> dict:
    """§8.3: baseline (все валидные бары) vs квадрант (T̂<t_lo & P̂>p_hi),
    в каждом делит по знаку color̂ и печатает статистику fwd_ret_k."""
    print(f"\n=== §8.3 quadrant-check: {title} ===")
    print(f"пороги: T̂ < {t_lo:+.2f}   P̂ > {p_hi:+.2f}")

    base_pos, base_neg = _split_by_color(rows, lambda r: True)
    quad_pos, quad_neg = _split_by_color(
        rows, lambda r: r["T_hat"] < t_lo and r["P_hat"] > p_hi)

    _print_split("baseline (без T/P-фильтра):", base_pos, base_neg)
    _print_split(f"квадрант (низкая T, высокая P):", quad_pos, quad_neg)

    _, d_base = _welch(base_pos, base_neg)
    _, d_quad = _welch(quad_pos, quad_neg)
    verdict = None
    if d_base is not None and d_quad is not None:
        ratio = (abs(d_quad) / abs(d_base)) if abs(d_base) > 1e-9 else float("inf")
        print(f"\n  |d| квадрант / |d| baseline = {ratio:.2f}")
        if ratio > 1.5 and len(quad_pos) + len(quad_neg) >= 200:
            verdict = ("да", "color̂ в квадранте разделяет заметно сильнее — гипотеза §8.3 подтверждается")
        elif ratio < 1.1:
            verdict = ("нет", "color̂ работает одинаково везде — квадрант не гетерогенен по color̂")
        else:
            verdict = ("частично", "разделение чуть сильнее в квадранте, но не в разы")
        print(f"  вердикт: {verdict[0]} — {verdict[1]}")
    return {
        "n_base": len(base_pos) + len(base_neg),
        "n_quad": len(quad_pos) + len(quad_neg),
        "d_base": d_base, "d_quad": d_quad,
    }


def _report(rows: list[dict], ticker: str, k: int) -> None:
    s = _summary(rows)
    print(f"=== {ticker} ===")
    print(f"баров всего:            {s['n_bars']}")
    print(f"валидных (T̂,P̂,color̂):  {s['n_valid']}")
    print(f"с известным outcome:    {s['n_outcome']}  (k={k})")
    print()
    print("корреляции Пирсона (§8, шаги 1-3):")
    print(f"  T̂ ↔ P̂       = {_fmt_corr(s['corr_TP'])}")
    print(f"  T̂ ↔ color̂   = {_fmt_corr(s['corr_Tc'])}")
    print(f"  P̂ ↔ color̂   = {_fmt_corr(s['corr_Pc'])}")
    print()
    print(f"target (bar-native fwd_ret_k): +1={s['target_pos']}  "
          f"-1={s['target_neg']}  0={s['target_zer']}")
    if s["corr_TP"] is not None and abs(s["corr_TP"]) > 0.7:
        print()
        print("⚠️  |corr(T,P)| > 0.7 — оси, вероятно, вырожденные (см. §8 п.1).")


def _plot(rows: list[dict], ticker: str) -> None:
    try:
        import matplotlib.pyplot as plt  # type: ignore
        from mpl_toolkits.mplot3d import Axes3D  # noqa: F401
    except Exception as e:
        sys.exit(f"matplotlib недоступен: {e}")
    pts = [r for r in rows
           if r["T_hat"] is not None and r["P_hat"] is not None
           and r["color_hat"] is not None and r["target"] is not None]
    if not pts:
        sys.exit("нет валидных точек для скаттера")
    xs = [r["T_hat"] for r in pts]
    ys = [r["P_hat"] for r in pts]
    zs = [r["color_hat"] for r in pts]
    cs = ["#2a9d8f" if r["target"] > 0 else "#e63946" if r["target"] < 0 else "#888"
          for r in pts]
    fig = plt.figure(figsize=(9, 7))
    ax = fig.add_subplot(111, projection="3d")
    ax.scatter(xs, ys, zs, c=cs, s=6, alpha=0.5)
    ax.set_xlabel("T̂ (интенсивность)")
    ax.set_ylabel("P̂ (направленность, ER)")
    ax.set_zlabel("color̂ (ускорение)")
    ax.set_title(f"{ticker}: точки в (T̂,P̂,color̂), окраска = sign(fwd_ret_k)")
    plt.tight_layout()
    plt.show()


def main() -> None:
    ap = argparse.ArgumentParser(description="Датасет T/P/color для концепции.")
    ap.add_argument("ticker")
    ap.add_argument("--cache", default=os.path.join(
        os.path.dirname(os.path.abspath(__file__)), "data", "candle_cache"))
    ap.add_argument("--interval", type=int, default=5, choices=(1, 5))
    ap.add_argument("--days", type=int, default=180)
    ap.add_argument("--from", dest="date_from", default=None)
    ap.add_argument("--to", dest="date_to", default=None)
    ap.add_argument("--all", action="store_true",
                     help="взять весь кэш, игнорируя --days/--from/--to")
    ap.add_argument("--n", type=int, default=20)
    ap.add_argument("--n-macro", type=int, default=200)
    ap.add_argument("--w-norm", type=int, default=500)
    ap.add_argument("--k", type=int, default=12)
    ap.add_argument("--min-volume", type=float, default=0.0)
    ap.add_argument("--out", default=None,
                     help="CSV: датасет (одиночный тикер) или сводка корреляций (ALL)")
    ap.add_argument("--plot", action="store_true")
    ap.add_argument("--per-ticker-dir", default=None,
                     help="только для ALL: сохранять полный датасет каждого тикера "
                          "в DIR/<ticker>.csv")
    ap.add_argument("--quadrant-check", action="store_true",
                     help="§8.3: сравнить fwd_ret в квадранте (низкая T, высокая P), "
                          "разбитом по знаку color̂, с baseline (без T/P-фильтра). "
                          "Работает и в одиночном, и в ALL режимах.")
    ap.add_argument("--t-lo", type=float, default=-0.5,
                     help="верхняя граница T̂ для «низкой T» (default -0.5)")
    ap.add_argument("--p-hi", type=float, default=+0.5,
                     help="нижняя граница P̂ для «высокой P» (default +0.5)")
    args = ap.parse_args()

    if args.ticker.upper() == "ALL":
        _run_all(args)
        return

    _run_single(args, args.ticker)


def _slice_by_args(all_rows: list[dict], args) -> tuple[list[dict], str, str]:
    latest_date = all_rows[-1]["time"][:10]
    if args.all:
        return all_rows, all_rows[0]["time"][:10], latest_date
    # --to по умолчанию — последний бар в кэше, а не сегодня: если кэш
    # холодный (бот давно не работал), «сегодня−N дней» даст пустую вырезку.
    to_str = args.date_to or latest_date
    if args.date_from:
        from_str = args.date_from
    else:
        to_d = datetime.strptime(to_str, "%Y-%m-%d").date()
        from_str = (to_d - timedelta(days=args.days)).isoformat()
    return _filter_by_dates(all_rows, from_str, to_str), from_str, to_str


def _run_single(args, ticker: str) -> None:
    all_rows = _load_from_cache(ticker, args.cache, args.interval)
    latest_date = all_rows[-1]["time"][:10]
    candles, from_str, to_str = _slice_by_args(all_rows, args)

    print(f"кэш: {ticker} ({args.interval}м), всего {len(all_rows)} баров "
          f"({all_rows[0]['time'][:10]}..{latest_date})", file=sys.stderr)
    print(f"взял: {len(candles)} баров за {from_str}..{to_str}", file=sys.stderr)

    if len(candles) < max(args.n_macro, args.w_norm) + args.k + 5:
        sys.exit(
            f"свечей мало: {len(candles)}. Нужно минимум "
            f"~{max(args.n_macro, args.w_norm) + args.k} для стабильных оценок."
        )

    rows = build_dataset(candles, n=args.n, n_macro=args.n_macro,
                         w_norm=args.w_norm, k=args.k,
                         min_volume=args.min_volume)

    if args.out:
        with open(args.out, "w", encoding="utf-8", newline="") as f:
            w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
            w.writeheader()
            w.writerows(rows)
        print(f"CSV: {args.out}  ({len(rows)} строк)")

    _report(rows, ticker, args.k)

    if args.quadrant_check:
        _quadrant_report(rows, args.t_lo, args.p_hi, ticker)

    if args.plot:
        _plot(rows, ticker)


def _run_all(args) -> None:
    """Прогон по всем тикерам кэша. Строит сводную табличку корреляций
    (это шаги 1-3 из §8: проверить, что T̂↔P̂ ортогональны не только на
    SBER, но на пуле — иначе гипотеза «две оси» умирает уже здесь)."""
    tickers = _list_tickers(args.cache, args.interval)
    if not tickers:
        sys.exit(f"в {args.cache} не нашлось непустых JSON под интервал {args.interval}м")
    print(f"тикеров к прогону: {len(tickers)}", file=sys.stderr)

    min_bars = max(args.n_macro, args.w_norm) + args.k + 5
    fieldnames = ["ticker", "n_bars_used", "date_from", "date_to",
                  "n_valid", "n_outcome",
                  "corr_TP", "corr_Tc", "corr_Pc",
                  "target_pos", "target_neg", "target_zer", "status"]

    per_dir = args.per_ticker_dir
    if per_dir:
        os.makedirs(per_dir, exist_ok=True)

    summaries: list[dict] = []
    pooled_rows: list[dict] = []                # для --quadrant-check в ALL
    skipped = 0
    for idx, ticker in enumerate(tickers, 1):
        try:
            all_rows = _load_from_cache(ticker, args.cache, args.interval)
        except SystemExit:
            skipped += 1
            continue
        candles, from_str, to_str = _slice_by_args(all_rows, args)
        if len(candles) < min_bars:
            summaries.append({
                "ticker": ticker, "n_bars_used": len(candles),
                "date_from": from_str, "date_to": to_str,
                "n_valid": 0, "n_outcome": 0,
                "corr_TP": None, "corr_Tc": None, "corr_Pc": None,
                "target_pos": 0, "target_neg": 0, "target_zer": 0,
                "status": f"skip: <{min_bars} bars",
            })
            print(f"[{idx:>4}/{len(tickers)}] {ticker:<12} skip ({len(candles)} bars)",
                  file=sys.stderr)
            continue
        rows = build_dataset(candles, n=args.n, n_macro=args.n_macro,
                             w_norm=args.w_norm, k=args.k,
                             min_volume=args.min_volume)
        s = _summary(rows)
        summaries.append({
            "ticker": ticker, "n_bars_used": len(candles),
            "date_from": from_str, "date_to": to_str,
            **s, "status": "ok",
        })
        if args.quadrant_check:
            # pooled — только нужные поля, чтобы не держать в памяти 30+ колонок
            # на весь пул (иначе на ALL --all это гигабайты).
            for r in rows:
                if r["T_hat"] is None or r["P_hat"] is None:
                    continue
                if r["color_hat"] is None or r["fwd_ret_k"] is None:
                    continue
                if r["outcome_known"] != 1:
                    continue
                pooled_rows.append({
                    "T_hat": r["T_hat"], "P_hat": r["P_hat"],
                    "color_hat": r["color_hat"], "fwd_ret_k": r["fwd_ret_k"],
                    "outcome_known": 1,
                })
        if per_dir:
            with open(os.path.join(per_dir, f"{ticker}.csv"),
                      "w", encoding="utf-8", newline="") as f:
                w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
                w.writeheader()
                w.writerows(rows)
        print(f"[{idx:>4}/{len(tickers)}] {ticker:<12} n={len(candles):>7}  "
              f"TP={_fmt_corr(s['corr_TP'])}  Tc={_fmt_corr(s['corr_Tc'])}  "
              f"Pc={_fmt_corr(s['corr_Pc'])}", file=sys.stderr)

    out_path = args.out or "corr_all.csv"
    with open(out_path, "w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fieldnames)
        w.writeheader()
        for row in summaries:
            w.writerow({k: ("" if row.get(k) is None else row.get(k, ""))
                        for k in fieldnames})

    ok = [r for r in summaries if r["status"] == "ok"]
    print()
    print(f"сводка: {out_path}  ({len(summaries)} строк, из них ok={len(ok)}, "
          f"skip={len(summaries) - len(ok)}, файлов не открылось={skipped})")
    if ok:
        def _median(xs):
            xs = sorted(xs)
            n = len(xs)
            return xs[n // 2] if n % 2 else 0.5 * (xs[n // 2 - 1] + xs[n // 2])
        for name in ("corr_TP", "corr_Tc", "corr_Pc"):
            vals = [r[name] for r in ok if r[name] is not None]
            if not vals:
                continue
            print(f"  {name:<8}  медиана {_fmt_corr(_median(vals))}  "
                  f"|·|>0.7: {sum(1 for v in vals if abs(v) > 0.7)}/{len(vals)}")

    if args.quadrant_check and pooled_rows:
        _quadrant_report(pooled_rows, args.t_lo, args.p_hi,
                          f"пул из {len(ok)} тикеров, {len(pooled_rows)} валидных баров")


if __name__ == "__main__":
    main()
