"""
tpcolor_dataset.py — сборка датасета для концепции T/P/color
(kontseptsiya_temperatura_davlenie_pamyat_2.md).

Читает свечи из общей базы D1 через HTTP-эндпоинт коллектора
(cf-collector/worker.js: GET /candles/<ticker>?from=&to= — тот же
источник, что дёргает db_api_client.py). URL и API-ключ берутся из
settings.ini секции [DB_API] (или флагами --url/--api-key, или из
переменных окружения DB_API_URL/DB_API_KEY). Ответ воркера — список
{time, open, high, low, close, volume} по возрастанию времени.

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

Запуск (из invest-bot/, settings.ini подхватится автоматически):
    python tpcolor_dataset.py SBER --days 180 --n 20 --k 12 --out sber_tpc.csv
    python tpcolor_dataset.py SBER --days 180 --plot        # + 3D-скаттер

Аргументы:
    ticker            — тикер (SBER, GAZP, ...)
    --days D          — глубина периода в календарных днях, default 180
    --from YYYY-MM-DD — явная дата начала (перекрывает --days)
    --to   YYYY-MM-DD — явная дата конца (default: сегодня, UTC)
    --url URL         — URL коллектора (иначе settings.ini [DB_API] URL или env DB_API_URL)
    --api-key K       — X-API-Key (иначе settings.ini [DB_API] API_KEY или env DB_API_KEY)
    --settings PATH   — путь к settings.ini (default: рядом со скриптом)
    --n N             — базовое окно Layer 1 (ATR/ER/ROC), default 20
    --n-macro N       — окно макро-контекста, default 200
    --w-norm W        — окно каузальной z-нормализации, default 500
    --k K             — горизонт forward-return, default 12
    --min-volume V    — отсекать бары с volume<V (default 0)
    --out PATH        — куда писать CSV (иначе — только сводка на экран)
    --plot            — 3D scatter T̂/P̂/color̂ (нужен matplotlib)
"""
from __future__ import annotations

import argparse
import configparser
import csv
import json
import math
import os
import sys
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from typing import Optional


def _resolve_creds(args_url: Optional[str], args_key: Optional[str],
                    settings_path: str) -> tuple[str, str]:
    """Приоритет: CLI-флаги > env > settings.ini. Возвращает (url, api_key)."""
    url = args_url or os.environ.get("DB_API_URL")
    key = args_key or os.environ.get("DB_API_KEY")
    if (not url or not key) and os.path.exists(settings_path):
        cfg = configparser.ConfigParser()
        cfg.read(settings_path, encoding="utf-8")
        if cfg.has_section("DB_API"):
            url = url or cfg.get("DB_API", "URL", fallback="") or None
            key = key or cfg.get("DB_API", "API_KEY", fallback="") or None
    if not url or not key:
        sys.exit(
            "не найден URL/API_KEY для коллектора. Задай флагами --url/--api-key, "
            "переменными DB_API_URL/DB_API_KEY, либо секцией [DB_API] в settings.ini."
        )
    return url.rstrip("/"), key


def _fetch_candles(base_url: str, api_key: str, ticker: str,
                    date_from: str, date_to: str, timeout: int = 60) -> list[dict]:
    """GET /candles/<ticker>?from=&to= — тот же контракт, что db_api_client.get_candles."""
    url = f"{base_url}/candles/{ticker}?from={date_from}&to={date_to}"
    req = urllib.request.Request(url, method="GET", headers={
        "X-API-Key": api_key,
        "User-Agent": "Mozilla/5.0 (compatible; tpcolor-dataset/1.0)",
    })
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            data = json.load(resp)
    except urllib.error.HTTPError as ex:
        body = ex.read().decode("utf-8", errors="replace")[:300]
        sys.exit(f"HTTP {ex.code} от коллектора: {body}")
    except (urllib.error.URLError, TimeoutError, ConnectionError) as ex:
        sys.exit(f"не смог достучаться до коллектора: {ex}")
    rows = data.get("candles", [])
    if not rows:
        sys.exit(f"{ticker}: коллектор вернул 0 свечей за {date_from}..{date_to}")
    rows.sort(key=lambda r: r["time"])
    return rows


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


def _report(rows: list[dict], ticker: str, k: int) -> None:
    total = len(rows)
    valid_hat = [r for r in rows if r["T_hat"] is not None and r["P_hat"] is not None and r["color_hat"] is not None]
    valid_outcome = [r for r in rows if r["outcome_known"] == 1]

    def col(name):
        return [r[name] for r in valid_hat]

    r_TP = _pearson(col("T_hat"), col("P_hat"))
    r_Tc = _pearson(col("T_hat"), col("color_hat"))
    r_Pc = _pearson(col("P_hat"), col("color_hat"))

    tgts = [r["target"] for r in valid_outcome if r["target"] is not None]
    pos = sum(1 for t in tgts if t > 0)
    neg = sum(1 for t in tgts if t < 0)
    zer = sum(1 for t in tgts if t == 0)

    print(f"=== {ticker} ===")
    print(f"баров всего:            {total}")
    print(f"валидных (T̂,P̂,color̂):  {len(valid_hat)}")
    print(f"с известным outcome:    {len(valid_outcome)}  (k={k})")
    print()
    print("корреляции Пирсона (§8, шаги 1-3):")
    print(f"  T̂ ↔ P̂       = {r_TP:+.3f}" if r_TP is not None else "  T̂ ↔ P̂       = n/a")
    print(f"  T̂ ↔ color̂   = {r_Tc:+.3f}" if r_Tc is not None else "  T̂ ↔ color̂   = n/a")
    print(f"  P̂ ↔ color̂   = {r_Pc:+.3f}" if r_Pc is not None else "  P̂ ↔ color̂   = n/a")
    print()
    print(f"target (bar-native fwd_ret_k): +1={pos}  -1={neg}  0={zer}")
    if r_TP is not None and abs(r_TP) > 0.7:
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
    ap.add_argument("--days", type=int, default=180)
    ap.add_argument("--from", dest="date_from", default=None)
    ap.add_argument("--to", dest="date_to", default=None)
    ap.add_argument("--url", default=None)
    ap.add_argument("--api-key", dest="api_key", default=None)
    ap.add_argument("--settings", default=os.path.join(
        os.path.dirname(os.path.abspath(__file__)), "settings.ini"))
    ap.add_argument("--n", type=int, default=20)
    ap.add_argument("--n-macro", type=int, default=200)
    ap.add_argument("--w-norm", type=int, default=500)
    ap.add_argument("--k", type=int, default=12)
    ap.add_argument("--min-volume", type=float, default=0.0)
    ap.add_argument("--out", default=None, help="путь к CSV (иначе только сводка)")
    ap.add_argument("--plot", action="store_true")
    args = ap.parse_args()

    base_url, api_key = _resolve_creds(args.url, args.api_key, args.settings)

    to_date = (datetime.strptime(args.date_to, "%Y-%m-%d").date()
               if args.date_to else datetime.now(timezone.utc).date())
    from_date = (datetime.strptime(args.date_from, "%Y-%m-%d").date()
                 if args.date_from else to_date - timedelta(days=args.days))

    print(f"→ GET {base_url}/candles/{args.ticker}?from={from_date}&to={to_date}",
          file=sys.stderr)
    candles = _fetch_candles(base_url, api_key, args.ticker,
                              from_date.isoformat(), to_date.isoformat())
    print(f"  получено {len(candles)} свечей", file=sys.stderr)

    if len(candles) < max(args.n_macro, args.w_norm) + args.k + 5:
        sys.exit(
            f"свечей мало: {len(candles)}. Нужно минимум "
            f"~{max(args.n_macro, args.w_norm) + args.k} для стабильных оценок."
        )

    rows = build_dataset(
        candles,
        n=args.n,
        n_macro=args.n_macro,
        w_norm=args.w_norm,
        k=args.k,
        min_volume=args.min_volume,
    )

    if args.out:
        with open(args.out, "w", encoding="utf-8", newline="") as f:
            w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
            w.writeheader()
            w.writerows(rows)
        print(f"CSV: {args.out}  ({len(rows)} строк)")

    _report(rows, args.ticker, args.k)

    if args.plot:
        _plot(rows, args.ticker)


if __name__ == "__main__":
    main()
