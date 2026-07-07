"""
redundancy_analysis.py — для каждого метода: точность сделок (avg_quality,
аналог effWR) и средняя RMT-очищенная корреляция с остальными методами того
же кластера, агрегированные по тикерам. Цель — увидеть, есть ли методы,
которые "мёртвый груз": нет собственного edge (avg_quality ~ 0.5) И сильно
коррелируют с другим методом в кластере (значит дублируют уже учтённый
сигнал, RMT-демпфирование (Layer 4) их только смягчает, никогда не убирает
совсем — см. обсуждение elastic net/group lasso как периодической калибровки
поверх Hedge).

Прогоняет backtest_barriers(record_history=True) в СВОЙ BacktestHistoryStore
(не трогает живую data/history.json) — чтобы получить avg_quality по сделкам
на исторических данных, плюс RMT-корреляцию из тех же scan_method_scores,
что и lag_analysis.py.

    python redundancy_analysis.py SBER --days 60
    python redundancy_analysis.py --all --days 60
    python redundancy_analysis.py AFKS,AFLT,GAZP --days 60
"""
import argparse
import os
import statistics
import sys

# Активируем локальный tinkoff-stub, если реальный SDK не установлен
# (Python 3.14 wheel пока нет). Свечи всё равно берутся из кэша.
_here = os.path.dirname(os.path.abspath(__file__))
if _here not in sys.path:
    sys.path.insert(0, _here)
try:
    import tinkoff.invest  # noqa: F401
except ImportError:
    _stub = os.path.join(_here, "_tinkoff_stub")
    if _stub not in sys.path:
        sys.path.insert(0, _stub)

from tinkoff.invest.exceptions import RequestError

from calibration import PercentileCalibrator
from candle_archive import get_candles_cached
from cluster_models import STRATEGY_CLUSTERS, _rmt_clean_corr
from dashboard import _config, _db, _market_data, _strategy_settings_by_ticker
from history import BacktestHistoryStore
from trade_system.strategies.strategy_factory import StrategyFactory

MIN_BARS = 30
MIN_TRADES_FOR_QUALITY = 10  # ниже этого avg_quality слишком шумный, не показываем как "мёртвый груз"
DEAD_WEIGHT_QUALITY_BAND = 0.05   # |avg_quality - 0.5| <= это — нет собственного edge
DEAD_WEIGHT_CORR = 0.5            # средняя |corr| с кластером выше этого — дублирует кого-то

_METHOD_TO_CLUSTER = {mid: cl["label"] for cl in STRATEGY_CLUSTERS for mid in cl["ids"]}

# {method: {avg_quality, total, avg_abs_corr, cluster}}
TickerResult = dict[str, dict]


def _avg_abs_corr(corr: dict[tuple, float], method_names: list[str], mid: str) -> float | None:
    others = [n for n in method_names if n != mid and (mid, n) in corr]
    if not others:
        return None
    return sum(abs(corr[(mid, n)]) for n in others) / len(others)


def _q_to_f(q) -> float:
    """Quotation(units/nano) или уже число → float."""
    try:
        return float(q.units) + float(q.nano) / 1e9
    except AttributeError:
        return float(q)


def _liq_vol(candles: list) -> tuple:
    """Прокси ликвидности и волатильности тикера по свечам: liq — медианный
    барный оборот close·volume (млн), vol — медианный относит. диапазон в %."""
    turn = []
    rng = []
    for c in candles:
        cl = _q_to_f(c.close)
        if cl <= 0:
            continue
        turn.append(cl * float(c.volume))
        rng.append((_q_to_f(c.high) - _q_to_f(c.low)) / cl)
    if not turn:
        return (None, None)
    return (statistics.median(turn) / 1e6, statistics.median(rng) * 100.0)


def _rank_corr(pairs: list) -> float | None:
    """Спирмен (Пирсон по рангам) для списка (x, y). None если мало/без разброса."""
    pairs = [(x, y) for (x, y) in pairs if x is not None and y is not None]
    if len(pairs) < 5:
        return None
    xs = [p[0] for p in pairs]; ys = [p[1] for p in pairs]
    # Константный ряд → связи нет (ранги константы дали бы ложную корреляцию).
    if len(set(xs)) < 2 or len(set(ys)) < 2:
        return None

    def ranks(v):
        order = sorted(range(len(v)), key=lambda i: v[i])
        rk = [0.0] * len(v)
        for pos, i in enumerate(order):
            rk[i] = float(pos)
        return rk
    rx = ranks(xs); ry = ranks(ys)
    mx = statistics.fmean(rx); my = statistics.fmean(ry)
    cov = sum((a - mx) * (b - my) for a, b in zip(rx, ry))
    vx = sum((a - mx) ** 2 for a in rx); vy = sum((b - my) ** 2 for b in ry)
    denom = (vx * vy) ** 0.5
    return cov / denom if denom else None


def _analyze_one(ticker: str, days: int) -> tuple:
    """Возвращает (TickerResult|None, (liq, vol))."""
    liqvol = (None, None)
    by_ticker = _strategy_settings_by_ticker()
    strategy_settings = by_ticker.get(ticker)
    if strategy_settings is None:
        print(f"{ticker}: нет в settings.ini/oi_tickers.json — пропуск")
        return None, liqvol

    try:
        candles = get_candles_cached(ticker, strategy_settings.figi, days, _market_data, _db)
    except RequestError as e:
        print(f"{ticker}: ошибка Tinkoff API ({e.code if hasattr(e, 'code') else e}) — пропуск")
        return None, liqvol
    if not candles:
        print(f"{ticker}: нет истории свечей — пропуск")
        return None, liqvol
    liqvol = _liq_vol(candles)

    strategy = StrategyFactory.new_factory(strategy_settings.name, strategy_settings)
    if strategy is None:
        print(f"{ticker}: стратегия не создана — пропуск")
        return None, liqvol

    store = BacktestHistoryStore()
    if hasattr(strategy, "set_history"):
        strategy.set_history(store, PercentileCalibrator())

    if not hasattr(strategy, "scan_method_scores"):
        print(f"{ticker}: стратегия не поддерживает scan_method_scores — пропуск")
        return None, liqvol

    print(f"Сканирую {ticker}...")
    rows = strategy.scan_method_scores(candles)
    if len(rows) < MIN_BARS:
        print(f"{ticker}: недостаточно баров ({len(rows)}) — пропуск")
        return None, liqvol

    method_names = list(rows[0]["scores"].keys())
    series = {m: [r["scores"].get(m, 0.0) for r in rows] for m in method_names}
    series = {m: v for m, v in series.items() if any(x != 0.0 for x in v)}
    if len(series) < 2:
        print(f"{ticker}: меньше 2 методов с непустыми скорами — пропуск")
        return None, liqvol
    corr = _rmt_clean_corr(series)

    try:
        bt = strategy.backtest_barriers(candles, record_history=True)
    except Exception as e:
        print(f"{ticker}: backtest_barriers упал ({e}) — avg_quality будет недоступен")
        bt = {"n_trades": 0}

    perf = store.method_performance(ticker, window_days=days)
    if bt.get("n_trades", 0) == 0:
        print(f"{ticker}: backtest_barriers не дал ни одной сделки — avg_quality будет недоступен")
    elif not perf:
        print(f"{ticker}: backtest_barriers дал {bt['n_trades']} сделок, но store.method_performance() пуст "
              f"— проблема в записи/чтении BacktestHistoryStore, не в отсутствии сигналов")
    else:
        any_total = next(iter(perf.values()))["total"]
        if any_total < MIN_TRADES_FOR_QUALITY:
            print(f"{ticker}: всего {any_total} сделок за {days} дн. — ниже порога "
                  f"MIN_TRADES_FOR_QUALITY={MIN_TRADES_FOR_QUALITY}, avg_quality не показывается (не баг, мало данных)")

    out: TickerResult = {}
    for mid in series:
        p = perf.get(mid, {})
        out[mid] = {
            "avg_quality": p.get("avg_quality"),
            "total": p.get("total", 0),
            "avg_abs_corr": _avg_abs_corr(corr, list(series.keys()), mid),
            "cluster": _METHOD_TO_CLUSTER.get(mid, "?"),
        }
    return (out or None), liqvol


def _is_dead_weight(stats: dict) -> bool:
    q = stats["avg_quality"]
    c = stats["avg_abs_corr"]
    if q is None or c is None or stats["total"] < MIN_TRADES_FOR_QUALITY:
        return False
    return abs(q - 0.5) <= DEAD_WEIGHT_QUALITY_BAND and c >= DEAD_WEIGHT_CORR


def _print_one(ticker: str, result: TickerResult) -> None:
    rows = sorted(result.items(), key=lambda kv: (kv[1]["avg_abs_corr"] or 0.0), reverse=True)
    print(f"\n{ticker}")
    print(f"{'метод':<18} {'кластер':<16} {'quality':>8} {'сделок':>7} {'|corr| сред.':>13}   ")
    print("-" * 80)
    for mid, s in rows:
        q = f"{s['avg_quality']:.3f}" if s["avg_quality"] is not None else "—"
        c = f"{s['avg_abs_corr']:.3f}" if s["avg_abs_corr"] is not None else "—"
        tag = "  МЁРТВЫЙ ГРУЗ (нет edge + дублирует)" if _is_dead_weight(s) else ""
        print(f"{mid:<18} {s['cluster']:<16} {q:>8} {s['total']:>7} {c:>13}{tag}")


def _print_aggregate(per_ticker: dict[str, TickerResult]) -> None:
    """Median quality/corr по методу через все тикеры — устойчивее к выбросу
    одного тикера/окна, плюс доля тикеров где метод помечен мёртвым грузом."""
    by_method: dict[str, list[dict]] = {}
    for result in per_ticker.values():
        for mid, s in result.items():
            by_method.setdefault(mid, []).append(s)

    rows = []
    for mid, vals in by_method.items():
        qualities = [v["avg_quality"] for v in vals if v["avg_quality"] is not None and v["total"] >= MIN_TRADES_FOR_QUALITY]
        corrs = [v["avg_abs_corr"] for v in vals if v["avg_abs_corr"] is not None]
        dead_n = sum(1 for v in vals if _is_dead_weight(v))
        cluster = vals[0]["cluster"]
        rows.append({
            "method": mid,
            "cluster": cluster,
            "median_q": statistics.median(qualities) if qualities else None,
            "median_corr": statistics.median(corrs) if corrs else None,
            "n_tickers": len(vals),
            "n_qualified": len(qualities),
            "dead_n": dead_n,
        })
    rows.sort(key=lambda r: (r["dead_n"], r["median_corr"] or 0.0), reverse=True)

    print(f"\n=== АГРЕГАТ ({len(per_ticker)} тикеров всего) ===")
    print(f"{'метод':<18} {'кластер':<16} {'медиана quality':>16} {'медиана |corr|':>15} "
          f"{'n тикеров':>10} {'мёртв. груз, n':>15}")
    print("-" * 100)
    for r in rows:
        q = f"{r['median_q']:.3f}" if r["median_q"] is not None else "—"
        c = f"{r['median_corr']:.3f}" if r["median_corr"] is not None else "—"
        tag = "  ← кандидат на исключение/group lasso" if r["dead_n"] >= max(2, r["n_tickers"] // 2) else ""
        print(f"{r['method']:<18} {r['cluster']:<16} {q:>16} {c:>15} {r['n_tickers']:>10} {r['dead_n']:>15}{tag}")


def _print_quality_liquidity(per_ticker: dict, tk_lv: dict, min_tickers: int = 15) -> None:
    """Зависит ли качество метода (avg_quality) от ликвидности тикера?
    Spearman(quality, log10 liq) + медиана quality в нижней/верхней трети
    ликвидности. quality~0.5 = нет edge; если на ликвидных выше 0.5, а на
    неликвидных ниже (или наоборот) — метод не универсален по ликвидности."""
    import math
    by_method: dict[str, list[tuple]] = {}
    for tk, result in per_ticker.items():
        liq, _ = tk_lv.get(tk, (None, None))
        if liq is None or liq <= 0:
            continue
        for mid, s in result.items():
            q = s.get("avg_quality")
            if q is not None and s.get("total", 0) >= MIN_TRADES_FOR_QUALITY:
                by_method.setdefault(mid, []).append((liq, q))
    rows = []
    for mid, pairs in by_method.items():
        if len(pairs) < min_tickers:
            continue
        sp = _rank_corr([(math.log10(l), q) for (l, q) in pairs])
        srt = sorted(pairs, key=lambda x: x[0])
        t = len(srt) // 3
        lo = [q for (_, q) in srt[:t]]
        hi = [q for (_, q) in srt[2 * t:]]
        rows.append((mid, len(pairs), sp,
                     statistics.median(lo) if lo else None,
                     statistics.median(hi) if hi else None))
    if not rows:
        print("\n(зависимость quality от ликвидности: недостаточно тикеров с "
              f"quality и ≥{MIN_TRADES_FOR_QUALITY} сделок)")
        return
    rows.sort(key=lambda r: -(abs(r[2]) if r[2] is not None else 0))
    print("\n=== зависимость quality метода от ликвидности тикера ===")
    print("# Spearman(quality, log10 ликв): + = лучше на ликвидных, − на неликв.")
    print("#  q_lo/q_hi — медиана quality в нижней/верхней трети ликвидности")
    print("#  (0.5 = нет edge; расхождение вокруг 0.5 = не универсален).")
    print(f"{'метод':<18}{'n_tk':>5}{'sp_liq':>8}{'q_lo':>8}{'q_hi':>8}  флаг")
    print("-" * 62)
    for mid, n, sp, qlo, qhi in rows:
        f_sp = f"{sp:+.2f}" if sp is not None else "  —"
        f_lo = f"{qlo:.3f}" if qlo is not None else "—"
        f_hi = f"{qhi:.3f}" if qhi is not None else "—"
        flag = "ликв-зависимое качество" if sp is not None and abs(sp) >= 0.3 else ""
        print(f"{mid:<18}{n:>5}{f_sp:>8}{f_lo:>8}{f_hi:>8}  {flag}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("ticker", nargs="?", help="один тикер, список через запятую, или используй --all")
    parser.add_argument("--all", action="store_true", help="прогнать по всем тикерам из settings.ini/oi_tickers.json")
    parser.add_argument("--days", type=int, default=60)
    args = parser.parse_args()

    if args.all:
        tickers = list(_strategy_settings_by_ticker().keys())
    elif args.ticker and "," in args.ticker:
        tickers = [t.strip() for t in args.ticker.split(",") if t.strip()]
    elif args.ticker:
        tickers = [args.ticker]
    else:
        parser.error("укажи тикер, список через запятую, или --all")
        return

    if len(tickers) == 1:
        result, _ = _analyze_one(tickers[0], args.days)
        if result:
            _print_one(tickers[0], result)
        return

    per_ticker = {}
    tk_lv = {}
    for i, ticker in enumerate(tickers, 1):
        print(f"[{i}/{len(tickers)}]", end=" ")
        try:
            result, liqvol = _analyze_one(ticker, args.days)
        except Exception as e:
            print(f"{ticker}: непредвиденная ошибка ({e}) — пропуск")
            continue
        if result:
            per_ticker[ticker] = result
            tk_lv[ticker] = liqvol
    if per_ticker:
        _print_aggregate(per_ticker)
        if len(per_ticker) >= 15:
            _print_quality_liquidity(per_ticker, tk_lv)
    else:
        print("Ни один тикер не дал результата.")


if __name__ == "__main__":
    main()
