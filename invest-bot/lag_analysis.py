"""
lag_analysis.py — измеряет лаг каждого метода из oi_composite_strategy.METHODS
относительно будущего движения цены: кросс-корреляция score(t) с forward
return(t+lag) при разных lag, см. обсуждение "технические индикаторы
структурно запаздывают, микроструктурные (TRADESTATS) — ведущие".

Идея: если максимум |corr| достигается на lag > 0 (forward_return[t+lag] —
то есть нужно сдвинуть score НАЗАД во времени, чтобы он совпал с движением,
которое уже произошло raньше) — метод запаздывает на lag баров. lag <= 0 —
метод ведущий или синхронный.

Использует strategy.scan_method_scores() (см. oi_composite_strategy.py) —
непрерывный ряд score по каждому бару, а не только в момент сигналов (где
лаг уже скрыт фильтром "score дозрел").

    python lag_analysis.py SBER --days 60
    python lag_analysis.py SBER --days 60 --horizon 5   (forward return на N баров)
    python lag_analysis.py --all --days 60              (по всем тикерам settings.ini, агрегат по методам)
    python lag_analysis.py AFKS,AFLT,GAZP --days 60      (по списку тикеров через запятую, агрегат)
"""
import argparse
import statistics

from candle_archive import get_candles_cached
from dashboard import _config, _db, _market_data, _strategy_settings_by_ticker, _wire_history
from trade_system.strategies.strategy_factory import StrategyFactory

MAX_LAG = 10


def _forward_returns(closes: list[float], horizon: int) -> list[float]:
    n = len(closes)
    return [(closes[i + horizon] - closes[i]) / closes[i] if closes[i] and i + horizon < n else None
            for i in range(n)]


def _corrcoef(a: list[float], b: list[float]) -> float:
    if len(a) < 5:
        return 0.0
    try:
        mean_a, mean_b = statistics.fmean(a), statistics.fmean(b)
        cov = sum((x - mean_a) * (y - mean_b) for x, y in zip(a, b))
        var_a = sum((x - mean_a) ** 2 for x in a)
        var_b = sum((y - mean_b) ** 2 for y in b)
        denom = (var_a * var_b) ** 0.5
        return cov / denom if denom else 0.0
    except (ZeroDivisionError, statistics.StatisticsError):
        return 0.0


def _lag_profile(scores: list[float], fwd_ret: list[float], max_lag: int) -> dict[int, float]:
    """{lag: corr(score[t], fwd_ret[t+lag])} для lag в [-max_lag, max_lag].
    lag > 0 = score нужно сдвинуть назад относительно будущего движения,
    т.е. метод запаздывает на |lag| баров."""
    n = len(scores)
    profile = {}
    for lag in range(-max_lag, max_lag + 1):
        if lag >= 0:
            s = scores[:n - lag] if lag else scores
            r = fwd_ret[lag:]
        else:
            s = scores[-lag:]
            r = fwd_ret[:n + lag]
        pairs = [(x, y) for x, y in zip(s, r) if y is not None]
        if len(pairs) < 10:
            continue
        xs, ys = zip(*pairs)
        profile[lag] = _corrcoef(list(xs), list(ys))
    return profile


def _analyze_one(ticker: str, days: int, horizon: int, max_lag: int) -> list[tuple[str, int, float]] | None:
    """Возвращает [(метод, best_lag, corr)] для тикера, или None если пропущен."""
    by_ticker = _strategy_settings_by_ticker()
    strategy_settings = by_ticker.get(ticker)
    if strategy_settings is None:
        print(f"{ticker}: нет в settings.ini/oi_tickers.json — пропуск")
        return None

    candles = get_candles_cached(ticker, strategy_settings.figi, days, _market_data, _db)
    if not candles:
        print(f"{ticker}: нет истории свечей — пропуск")
        return None

    strategy = StrategyFactory.new_factory(strategy_settings.name, strategy_settings)
    _wire_history(strategy)
    if strategy is None or not hasattr(strategy, "scan_method_scores"):
        print(f"{ticker}: стратегия не поддерживает scan_method_scores — пропуск")
        return None

    print(f"Сканирую {ticker}...")
    rows = strategy.scan_method_scores(candles)
    if len(rows) < 30:
        print(f"{ticker}: недостаточно баров ({len(rows)}) — пропуск")
        return None

    closes = [r["close"] for r in rows]
    fwd_ret = _forward_returns(closes, horizon)
    method_names = list(rows[0]["scores"].keys())

    results = []
    for method in method_names:
        scores = [r["scores"].get(method, 0.0) for r in rows]
        if all(s == 0.0 for s in scores):
            continue
        profile = _lag_profile(scores, fwd_ret, max_lag)
        if not profile:
            continue
        best_lag = max(profile, key=lambda l: abs(profile[l]))
        results.append((method, best_lag, profile[best_lag]))
    return results


def _print_single(ticker: str, results: list[tuple[str, int, float]]) -> None:
    results = sorted(results, key=lambda r: r[1], reverse=True)
    print(f"\n{ticker}: {'метод':<16} {'лаг (бар)':>10} {'corr':>8}   интерпретация")
    print("-" * 60)
    for method, lag, corr in results:
        tag = f"запаздывает на {lag} бар." if lag > 1 else (f"ведущий, опережает на {-lag} бар." if lag < -1 else "синхронный")
        print(f"{method:<16} {lag:>10} {corr:>8.3f}   {tag}")


def _print_aggregate(per_ticker: dict[str, list[tuple[str, int, float]]]) -> None:
    """Median-лаг по методу через все тикеры — устойчивее к выбросам одного тикера,
    чем смотреть тикеры по отдельности."""
    by_method: dict[str, list[tuple[int, float]]] = {}
    for results in per_ticker.values():
        for method, lag, corr in results:
            by_method.setdefault(method, []).append((lag, corr))

    rows = []
    for method, vals in by_method.items():
        lags = [v[0] for v in vals]
        corrs = [abs(v[1]) for v in vals]
        rows.append((method, statistics.median(lags), statistics.fmean(corrs), len(vals)))
    rows.sort(key=lambda r: r[1], reverse=True)

    print(f"\n=== АГРЕГАТ по {len(per_ticker)} тикерам ===")
    print(f"{'метод':<16} {'медиана лага':>13} {'|corr| сред.':>13} {'n тикеров':>10}   интерпретация")
    print("-" * 80)
    for method, med_lag, mean_corr, n in rows:
        tag = f"запаздывает на {med_lag} бар." if med_lag > 1 else (f"ведущий, опережает на {-med_lag} бар." if med_lag < -1 else "синхронный")
        print(f"{method:<16} {med_lag:>13} {mean_corr:>13.3f} {n:>10}   {tag}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("ticker", nargs="?", help="один тикер, список через запятую, или используй --all")
    parser.add_argument("--all", action="store_true", help="прогнать по всем тикерам из settings.ini/oi_tickers.json")
    parser.add_argument("--days", type=int, default=60)
    parser.add_argument("--horizon", type=int, default=3, help="forward return на N баров вперёд")
    parser.add_argument("--max-lag", type=int, default=MAX_LAG)
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
        results = _analyze_one(tickers[0], args.days, args.horizon, args.max_lag)
        if results:
            _print_single(tickers[0], results)
        return

    per_ticker = {}
    for i, ticker in enumerate(tickers, 1):
        print(f"[{i}/{len(tickers)}]", end=" ")
        results = _analyze_one(ticker, args.days, args.horizon, args.max_lag)
        if results:
            per_ticker[ticker] = results
    if per_ticker:
        _print_aggregate(per_ticker)
    else:
        print("Ни один тикер не дал результата.")


if __name__ == "__main__":
    main()
