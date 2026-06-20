"""
morning_lead_check.py — разовая проверка гипотезы: движение акции в первые
минуты после открытия основной торговой сессии предсказывает последующее
движение/гэп её фьючерса на FORTS (тонкий стакан single-stock фьючерса
подстраивается под цену акции с лагом).

Не запускался в этой среде — нет сетевого доступа к invest-public-api.tinkoff.ru
(egress allowlist). Логика и расчёты не проверены реальным прогоном, только
синтаксически (ast.parse). Запусти руками там, где есть доступ к API.

Запуск:
    python morning_lead_check.py --days 20 [--base-tickers SBER,GAZP,LKOH]
    [--window-min 15] [--horizon-min 60]

Для каждой пары (акция, её ближайший фьюч по [FUTURES_TRADING] BASE_TICKERS
или --base-tickers):
  1. Тянем 1-минутные свечи акции и фьюча за --days дней.
  2. Для каждого торгового дня берём первые --window-min минут после первой
     свечи акции в этот день — это "утреннее движение акции" (return).
  3. Берём движение фьюча за следующие --horizon-min минут после того же
     момента (его "догон") — фьюч мог за этот час ещё не успеть отразить
     то, что уже видно в акции.
  4. Печатаем: число дней, корреляцию (акция_ret, фьюч_ret_horizon),
     hit_rate (совпадение знака), и среднее движение фьюча по знаку акции
     (если акция вверх — что в среднем делает фьюч дальше, и наоборот).

Цифры дадут грубую оценку, есть ли эффект и какого размера — раньше делать
выводы и встраивать в живой провайдер (set_multi_ticker_provider) не стоит.
"""
import argparse
import datetime
import statistics
from collections import defaultdict

from configuration.configuration import ProgramConfiguration
from invest_api.services.instruments_service import InstrumentService
from invest_api.services.market_data_service import MarketDataService
from tinkoff.invest import CandleInterval
from tinkoff.invest.utils import quotation_to_decimal

CONFIG_FILE = "settings.ini"


def _ret(p_from: float, p_to: float) -> float:
    return (p_to - p_from) / p_from if p_from else 0.0


def _by_day(candles) -> dict:
    days: dict[str, list] = defaultdict(list)
    for c in candles:
        days[c.time.date().isoformat()].append(c)
    for day in days:
        days[day].sort(key=lambda c: c.time)
    return days


def _window_return(day_candles: list, start_idx: int, minutes: int) -> float | None:
    """Возврат цены close за `minutes` 1-минутных баров начиная с start_idx."""
    end_idx = start_idx + minutes
    if end_idx >= len(day_candles):
        return None
    p_from = float(quotation_to_decimal(day_candles[start_idx].close))
    p_to = float(quotation_to_decimal(day_candles[end_idx].close))
    return _ret(p_from, p_to)


def analyze_pair(ticker: str, figi_stock: str, future_ticker: str, figi_future: str,
                  market_data: MarketDataService, days: int, window_min: int, horizon_min: int) -> None:
    candles_stock = market_data.get_candles_history(figi_stock, days=days, interval=CandleInterval.CANDLE_INTERVAL_1_MIN)
    candles_future = market_data.get_candles_history(figi_future, days=days, interval=CandleInterval.CANDLE_INTERVAL_1_MIN)

    stock_by_day = _by_day(candles_stock)
    future_by_day = _by_day(candles_future)

    stock_rets, future_rets = [], []
    for day, stock_day_candles in stock_by_day.items():
        future_day_candles = future_by_day.get(day)
        if not future_day_candles:
            continue
        # "утро акции" — от первой свечи акции в этот день (момент открытия
        # основной сессии, бот в любом случае не торгует до неё).
        stock_open_time = stock_day_candles[0].time
        stock_ret = _window_return(stock_day_candles, 0, window_min)
        if stock_ret is None:
            continue

        # ищем в фьюче свечу на тот же момент (после окна акции) как старт
        # горизонта — фьюч мог быть открыт и до этого, нас интересует именно
        # догон ПОСЛЕ того, как акция уже отыграла movement.
        anchor_time = stock_day_candles[window_min].time if window_min < len(stock_day_candles) else None
        if anchor_time is None:
            continue
        future_start_idx = next(
            (i for i, c in enumerate(future_day_candles) if c.time >= anchor_time), None
        )
        if future_start_idx is None:
            continue
        future_ret = _window_return(future_day_candles, future_start_idx, horizon_min)
        if future_ret is None:
            continue

        stock_rets.append(stock_ret)
        future_rets.append(future_ret)

    n = len(stock_rets)
    if n < 5:
        print(f"{ticker:<8} -> {future_ticker:<10} недостаточно дней с данными ({n}), пропуск")
        return

    corr = statistics.correlation(stock_rets, future_rets) if n >= 2 else 0.0
    hit_rate = sum(1 for s, f in zip(stock_rets, future_rets) if (s >= 0) == (f >= 0)) / n
    up_days = [f for s, f in zip(stock_rets, future_rets) if s > 0]
    down_days = [f for s, f in zip(stock_rets, future_rets) if s < 0]
    avg_future_after_up = sum(up_days) / len(up_days) if up_days else float("nan")
    avg_future_after_down = sum(down_days) / len(down_days) if down_days else float("nan")

    print(
        f"{ticker:<8} -> {future_ticker:<10} n_days={n:>3} corr={corr:>+.3f} "
        f"hit_rate={hit_rate * 100:>5.1f}% "
        f"future_ret|stock_up={avg_future_after_up * 100:>+.3f}% "
        f"future_ret|stock_down={avg_future_after_down * 100:>+.3f}%"
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--days", type=int, default=20)
    parser.add_argument("--base-tickers", type=str, default="")
    parser.add_argument("--window-min", type=int, default=15)
    parser.add_argument("--horizon-min", type=int, default=60)
    args = parser.parse_args()

    config = ProgramConfiguration(CONFIG_FILE)
    market_data = MarketDataService(config.tinkoff_token, config.tinkoff_app_name)
    instruments = InstrumentService(config.tinkoff_token, config.tinkoff_app_name)

    base_tickers = (
        [t.strip() for t in args.base_tickers.split(",") if t.strip()]
        or config.futures_trading_settings.base_tickers
    )
    if not base_tickers:
        print("Нет тикеров: укажи --base-tickers или [FUTURES_TRADING] BASE_TICKERS в settings.ini")
        return

    print(f"{'TICKER':<8}{'-> FUTURE':<13}{'n_days':>9}{'corr':>9}{'hit_rate':>10}  доп. метрики")
    for ticker in base_tickers:
        stock = instruments.share_by_ticker(ticker)
        if not stock:
            print(f"{ticker:<8} — акция не найдена, пропуск")
            continue
        _, figi_stock = stock

        future = instruments.future_by_base_ticker(ticker)
        if not future:
            print(f"{ticker:<8} — фьюч не найден, пропуск")
            continue
        future_settings, figi_future = future

        analyze_pair(
            ticker, figi_stock, future_settings.ticker, figi_future,
            market_data, args.days, args.window_min, args.horizon_min
        )


if __name__ == "__main__":
    main()
