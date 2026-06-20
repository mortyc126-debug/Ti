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


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("ticker")
    parser.add_argument("--days", type=int, default=60)
    parser.add_argument("--horizon", type=int, default=3, help="forward return на N баров вперёд")
    parser.add_argument("--max-lag", type=int, default=MAX_LAG)
    args = parser.parse_args()

    by_ticker = _strategy_settings_by_ticker()
    strategy_settings = by_ticker.get(args.ticker)
    if strategy_settings is None:
        print(f"{args.ticker}: нет в settings.ini/oi_tickers.json")
        return

    candles = get_candles_cached(args.ticker, strategy_settings.figi, args.days, _market_data, _db)
    if not candles:
        print(f"{args.ticker}: нет истории свечей")
        return

    strategy = StrategyFactory.new_factory(strategy_settings.name, strategy_settings)
    _wire_history(strategy)
    if strategy is None or not hasattr(strategy, "scan_method_scores"):
        print(f"{args.ticker}: стратегия не поддерживает scan_method_scores")
        return

    print(f"Сканирую {len(candles)} свечей {args.ticker} (может занять минуту-две)...")
    rows = strategy.scan_method_scores(candles)
    if len(rows) < 30:
        print(f"Недостаточно баров для анализа ({len(rows)})")
        return

    closes = [r["close"] for r in rows]
    fwd_ret = _forward_returns(closes, args.horizon)
    method_names = list(rows[0]["scores"].keys())

    results = []
    for method in method_names:
        scores = [r["scores"].get(method, 0.0) for r in rows]
        if all(s == 0.0 for s in scores):
            continue
        profile = _lag_profile(scores, fwd_ret, args.max_lag)
        if not profile:
            continue
        best_lag = max(profile, key=lambda l: abs(profile[l]))
        results.append((method, best_lag, profile[best_lag]))

    results.sort(key=lambda r: r[1], reverse=True)  # самые запаздывающие сверху

    print(f"\n{'метод':<16} {'лаг (бар)':>10} {'corr':>8}   интерпретация")
    print("-" * 60)
    for method, lag, corr in results:
        if lag > 1:
            tag = f"запаздывает на {lag} бар."
        elif lag < -1:
            tag = f"ведущий, опережает на {-lag} бар."
        else:
            tag = "синхронный"
        print(f"{method:<16} {lag:>10} {corr:>8.3f}   {tag}")


if __name__ == "__main__":
    main()
