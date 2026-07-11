"""smoke_accel_fade.py — оффлайн проверка, что AccelFadeStrategy поднимается через
фабрику, принимает свечи и не падает (без сети/песочницы).

Строит синтетику: медленный аптренд + резкое ускорение вверх в конце (спайк ПО
тренду) — должен дать fade-сигнал SHORT. Печатает: инициализация ок, число баров,
был ли сигнал, его тип и тейк/стоп. Любое исключение → печатает и выходит с кодом 1.

Запуск:  py -3.11 smoke_accel_fade.py
"""
import sys
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace


def _q(price: float):
    """float → tinkoff Quotation (units + nano)."""
    from tinkoff.invest import Quotation
    units = int(price)
    nano = int(round((price - units) * 1e9))
    return Quotation(units=units, nano=nano)


def _candle(t, price, hi, lo):
    from tinkoff.invest import HistoricCandle
    return HistoricCandle(
        open=_q(price), high=_q(hi), low=_q(lo), close=_q(price),
        volume=1000, time=t, is_complete=True,
    )


def main():
    try:
        from trade_system.strategies.strategy_factory import StrategyFactory
    except Exception as e:
        print("ОШИБКА импорта фабрики:", repr(e)); return 1

    settings = SimpleNamespace(ticker="TEST", figi="FUT_TEST",
                               short_enabled_flag=True)
    strat = StrategyFactory.new_factory("AccelFadeStrategy", settings)
    if strat is None:
        print("ОШИБКА: фабрика не знает AccelFadeStrategy (не зарегистрирована?)"); return 1
    print("инициализация через фабрику: OK ->", type(strat).__name__)

    # синтетика: 300 баров пологого аптренда + 6 баров резкого ускорения вверх
    t0 = datetime(2026, 1, 1, tzinfo=timezone.utc)
    candles = []
    price = 100.0
    for i in range(300):
        price += 0.05                      # пологий тренд (trend_sign > 0)
        candles.append(_candle(t0 + timedelta(minutes=5 * i), price,
                               price + 0.3, price - 0.3))
    for j in range(6):                     # климакс: ускорение вверх ПО тренду
        price += 1.2 + 0.4 * j
        i = 300 + j
        candles.append(_candle(t0 + timedelta(minutes=5 * i), price,
                               price + 0.5, price - 0.2))

    try:
        signal = strat.analyze_candles(candles)
    except Exception as e:
        import traceback
        print("ОШИБКА в analyze_candles:", repr(e))
        traceback.print_exc(); return 1

    print(f"свечей скормлено: {len(candles)} | буфер стратегии: {len(strat._bars)}")
    if signal is None:
        print("сигнала нет (детектор отработал без ошибок — это тоже валидный старт)")
    else:
        print(f"СИГНАЛ: type={signal.signal_type.name} "
              f"tp={signal.take_profit_level} sl={signal.stop_loss_level} "
              f"entry_price={signal.entry_price}")
        # для fade спайка ВВЕРХ ждём SHORT
        print("ожидали SHORT (fade спайка вверх):",
              "OK" if signal.signal_type.name == "SHORT" else "неожиданно " + signal.signal_type.name)
    print("SMOKE OK — стратегия поднимается и обрабатывает свечи без падения")
    return 0


if __name__ == "__main__":
    sys.exit(main())
