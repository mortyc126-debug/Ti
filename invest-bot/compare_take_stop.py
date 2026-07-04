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

from tinkoff.invest.exceptions import RequestError

from configuration.configuration import ProgramConfiguration
from invest_api.services.instruments_service import InstrumentService
from invest_api.services.market_data_service import MarketDataService
from trade_system.strategies.strategy_factory import StrategyFactory

CONFIG_FILE = "settings.ini"

logging.basicConfig(level=logging.WARNING)


def _load_index_context_provider(instrument_service: InstrumentService,
                                  market_data: MarketDataService, days: int):
    """IndexContextBacktestProvider на дневках фьюча IMOEX — тот же провайдер,
    что использует dashboard.py, но без D1-кэша (разовый скрипт, прямые
    запросы к Tinkoff). None, если IMOEX не резолвится — метод просто молчит."""
    try:
        from index_context import IndexContextBacktestProvider, daily_from_intraday
        resolved = instrument_service.future_by_base_ticker("IMOEX")
        if not resolved:
            return None
        future_settings, figi = resolved
        candles = market_data.get_candles_history(figi, days=days + 75)
        if not candles:
            return None
        prov = IndexContextBacktestProvider(daily_from_intraday(candles))
        return prov if prov.has_data() else None
    except Exception as e:
        logging.warning(f"INDEX_CONTEXT: не построен — {e}")
        return None


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
    instrument_service = InstrumentService(config.tinkoff_token, config.tinkoff_app_name)

    # OI-провайдер (data/oi_daily.json, без сети) + INDEX_CONTEXT (IMOEX,
    # один запрос на весь прогон) — раньше этот скрипт вообще не подключал
    # ни один из провайдерных методов композита: fixed vs ATR сравнивалось
    # на неполном композите (без 6 из ~71 метода), не так, как видит бот.
    from oi_layers import OiBacktestProvider
    oi_prov = OiBacktestProvider.load()
    idx_prov = _load_index_context_provider(instrument_service, market_data, args.days)

    print(f"{'TICKER':<8}{'mode':<14}{'trades':>7}{'win%':>7}{'avg_R':>8}{'exp%':>8}")
    for strategy_settings in config.trade_strategy_settings:
        strategy = StrategyFactory.new_factory(strategy_settings.name, strategy_settings)
        if strategy is None or not hasattr(strategy, "backtest_barriers"):
            continue

        try:
            candles = market_data.get_candles_history(strategy_settings.figi, days=args.days)
        except RequestError as ex:
            print(f"{strategy_settings.ticker:<8} — ошибка API ({ex.details}), пропуск")
            continue
        if not candles:
            print(f"{strategy_settings.ticker:<8} — нет истории, пропуск")
            continue

        s = strategy_settings.settings
        long_take = Decimal(s.get("LONG_TAKE", "1.015"))
        long_stop = Decimal(s.get("LONG_STOP", "0.985"))

        oi_hook = None
        if oi_prov.has_data(strategy_settings.ticker):
            strategy.set_inst_oi_provider(oi_prov.inst_oi_score)
            strategy.set_retail_contra_provider(oi_prov.retail_contra_score)
            strategy.set_delta_quadrant_provider(oi_prov.delta_quadrant_score)
            strategy.set_oi_absorption_provider(oi_prov.absorption_score)
            strategy.set_squeeze_provider(oi_prov.squeeze_score)
            strategy.set_oi_regime_provider(oi_prov.oi_instability_score)
            oi_hook = oi_prov.set_date
        if idx_prov is not None and hasattr(strategy, "set_index_context_provider"):
            strategy.set_index_context_provider(idx_prov.score)
            if oi_hook is None:
                oi_hook = idx_prov.set_date
            else:
                _oi_hook0 = oi_hook
                def oi_hook(d, _h0=_oi_hook0, _p=idx_prov):
                    _h0(d)
                    _p.set_date(d)

        # Дорогой проход (Hawkes-MLE и т.п.) делаем один раз на тикер,
        # а не на каждую из 10 комбинаций take/stop.
        signals = strategy.backtest_scan_signals(candles, oi_date_hook=oi_hook)

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
