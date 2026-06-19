"""
compare_take_stop.py — разовый скрипт: сравнить фиксированные тейк/стоп
(LONG_TAKE/LONG_STOP из settings.ini) с ATR-based уровнями на исторических
свечах, через OICompositeStrategy.backtest_barriers() — честную симуляцию
исполнения (бар-за-баром ищем, какой барьер пробивается первым), а не
MFE/MAE на фиксированном окне, как в backtest_quality().

Запуск:
    python compare_take_stop.py [--days N] [--atr-take K1,K2,...] [--atr-stop K1,K2,...]

По умолчанию: --days 5 (как HISTORY_DAYS в [MEGA_ALERTS]), сетка
ATR_TAKE_K x ATR_STOP_K = {2,3,4} x {1,1.5,2} (9 комбинаций на тикер).

Печатает таблицу по каждому STRATEGY_<TICKER> из settings.ini: fixed vs
лучшая по expectancy_pct ATR-комбинация. Ничего не пишет в settings.ini —
смотрите на цифры и правьте ATR_TAKE_K/ATR_STOP_K руками, если ATR победил
с запасом (на маленькой выборке разница в доли % может быть шумом).
"""
import argparse
import logging
from decimal import Decimal

from configuration.configuration import ProgramConfiguration
from invest_api.services.market_data_service import MarketDataService
from trade_system.strategies.strategy_factory import StrategyFactory

CONFIG_FILE = "settings.ini"

logging.basicConfig(level=logging.WARNING)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--days", type=int, default=5)
    parser.add_argument("--atr-take", type=str, default="2,3,4")
    parser.add_argument("--atr-stop", type=str, default="1,1.5,2")
    args = parser.parse_args()

    take_ks = [float(x) for x in args.atr_take.split(",")]
    stop_ks = [float(x) for x in args.atr_stop.split(",")]

    config = ProgramConfiguration(CONFIG_FILE)
    market_data = MarketDataService(config.tinkoff_token, config.tinkoff_app_name)

    print(f"{'TICKER':<8}{'mode':<14}{'trades':>7}{'win%':>7}{'avg_R':>8}{'exp%':>8}")
    for strategy_settings in config.trade_strategy_settings:
        strategy = StrategyFactory.new_factory(strategy_settings.name, strategy_settings)
        if strategy is None or not hasattr(strategy, "backtest_barriers"):
            continue

        candles = market_data.get_candles_history(strategy_settings.figi, days=args.days)
        if not candles:
            print(f"{strategy_settings.ticker:<8} — нет истории, пропуск")
            continue

        s = strategy_settings.settings
        long_take = Decimal(s.get("LONG_TAKE", "1.015"))
        long_stop = Decimal(s.get("LONG_STOP", "0.985"))

        # Дорогой проход (Hawkes-MLE и т.п.) делаем один раз на тикер,
        # а не на каждую из 10 комбинаций take/stop.
        signals = strategy.backtest_scan_signals(candles)

        fixed = strategy.backtest_barriers(signals=signals, take_mult=long_take, stop_mult=long_stop)
        _print_row(strategy_settings.ticker, "fixed", fixed)

        best = None
        for tk in take_ks:
            for sk in stop_ks:
                res = strategy.backtest_barriers(signals=signals, atr_take_k=tk, atr_stop_k=sk)
                if res["n_trades"] == 0:
                    continue
                if best is None or res["expectancy_pct"] > best[1]["expectancy_pct"]:
                    best = ((tk, sk), res)

        if best:
            (tk, sk), res = best
            _print_row(strategy_settings.ticker, f"ATR k={tk}/{sk}", res)
        print()


def _print_row(ticker: str, mode: str, res: dict) -> None:
    print(
        f"{ticker:<8}{mode:<14}{res['n_trades']:>7}"
        f"{res['win_rate'] * 100:>6.1f}%{res['avg_r']:>8.2f}"
        f"{res['expectancy_pct'] * 100:>7.2f}%"
    )


if __name__ == "__main__":
    main()
