"""
morning_overshoot_check.py — разовая проверка гипотезы про "выброс на
открытии" фьюча: цена фьюча была заморожена с вечера (контанго/бэквордация
устарели), и в первые секунды торгов толпа переоценивает движение базовой
акции с запасом — заявки летят на эмоциях, цена фьюча проскакивает дальше
справедливого уровня (иногда мечется в обе стороны), и только потом
выравнивается обратно. Этот экстремум может быть только в первые секунды и
не повториться за весь день.

В отличие от morning_lead_check.py (плавный лаг "акция шевельнулась — фьюч
потом догоняет тем же темпом за час"), здесь интересует не направление, а
ФЕЙД выброса: если в первые секунды цена прыгнула сильно дальше уровня, к
которому она потом сама вернулась — заработать можно было встав ПРОТИВ
этого выброса на возврат.

Не запускался в этой среде — нет сетевого доступа к invest-public-api
(см. egress allowlist). Логика проверена только синтаксически (ast.parse).

Запуск:
    python morning_overshoot_check.py --days 20 [--base-tickers SBER,GAZP,LKOH]
    [--settle-after-sec 300]

Для каждого фьюча по [FUTURES_TRADING] BASE_TICKERS (или --base-tickers):
  1. Тянем 5-секундные свечи фьюча за --days дней (CANDLE_INTERVAL_5_SEC,
     лимит API на сек-интервалы — данные за сутки на запрос, поэтому только
     по дням, не больше --days).
  2. "Выброс" = ПЕРВАЯ свеча торгов дня. Намеренно не ищем "самую экстремальную
     свечу за первую минуту" — это было бы forward-looking: в реальной
     торговле момент пика неизвестен заранее, пока он не позади.
  3. "Равновесная" цена — close фьюча через --settle-after-sec секунд после
     выброса (где цена устоялась после открытия).
  4. overshoot_pct = (цена выброса - равновесная цена) / равновесная цена —
     насколько далеко был выброс от уровня, на котором цена устоялась.
  5. Печатаем: число дней, среднюю |overshoot_pct|, долю дней, где
     |overshoot_pct| превышает комиссию круга по фьючу (0.08%) — то есть
     теоретически окупила бы fade-сделку (без учёта реального
     проскальзывания/задержки исполнения на открытии, которая в первые
     секунды торгов может быть больше, чем на спокойном рынке).

Если |overshoot_pct| в среднем меньше комиссии или сопоставим с обычным
шумом 5-сек бара — выброса, который можно было бы выгодно зафейдить, либо
нет, либо его съедает комиссия/проскальзывание, и идею лучше не встраивать
в живую торговлю.
"""
import argparse
import statistics
from collections import defaultdict

from configuration.configuration import ProgramConfiguration
from invest_api.services.instruments_service import InstrumentService
from invest_api.services.market_data_service import MarketDataService
from tinkoff.invest import CandleInterval
from tinkoff.invest.utils import quotation_to_decimal

CONFIG_FILE = "settings.ini"
FUTURE_ROUNDTRIP_COMMISSION = 0.0008


def _close(c) -> float:
    return float(quotation_to_decimal(c.close))


def _by_day(candles) -> dict:
    days: dict[str, list] = defaultdict(list)
    for c in candles:
        days[c.time.date().isoformat()].append(c)
    for day in days:
        days[day].sort(key=lambda c: c.time)
    return days


def _settle_price(day_candles: list, settle_after_sec: int) -> float | None:
    """close первой свечи через >= settle_after_sec секунд после открытия дня."""
    day_start = day_candles[0].time
    for c in day_candles[1:]:
        if (c.time - day_start).total_seconds() >= settle_after_sec:
            return _close(c)
    return None


def analyze_future(ticker: str, figi_future: str, market_data: MarketDataService,
                    days: int, settle_after_sec: int) -> None:
    candles = market_data.get_candles_history(figi_future, days=days, interval=CandleInterval.CANDLE_INTERVAL_5_SEC)
    by_day = _by_day(candles)

    overshoots = []
    for day, day_candles in by_day.items():
        if not day_candles:
            continue
        spike_price = _close(day_candles[0])
        settle = _settle_price(day_candles, settle_after_sec)
        if settle is None or settle == 0:
            continue
        overshoots.append((spike_price - settle) / settle)

    n = len(overshoots)
    if n < 5:
        print(f"{ticker:<8} недостаточно дней с данными ({n}), пропуск")
        return

    avg_abs_overshoot = sum(abs(o) for o in overshoots) / n
    median_abs_overshoot = statistics.median(abs(o) for o in overshoots)
    profitable_share = sum(1 for o in overshoots if abs(o) > FUTURE_ROUNDTRIP_COMMISSION) / n

    print(
        f"{ticker:<8} n_days={n:>3} avg|overshoot|={avg_abs_overshoot * 100:>6.3f}% "
        f"median|overshoot|={median_abs_overshoot * 100:>6.3f}% "
        f"доля_дней_>комиссии={profitable_share * 100:>5.1f}%"
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--days", type=int, default=20)
    parser.add_argument("--base-tickers", type=str, default="")
    parser.add_argument("--settle-after-sec", type=int, default=300)
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

    print(f"{'TICKER':<8}{'n_days':>9}  доп. метрики (overshoot vs комиссия)")
    for ticker in base_tickers:
        future = instruments.future_by_base_ticker(ticker)
        if not future:
            print(f"{ticker:<8} — фьюч не найден, пропуск")
            continue
        future_settings, figi_future = future

        analyze_future(future_settings.ticker, figi_future, market_data, args.days, args.settle_after_sec)


if __name__ == "__main__":
    main()
