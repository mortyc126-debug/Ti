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

У этой версии tinkoff-investments SDK нет секундных интервалов (только от
CANDLE_INTERVAL_1_MIN) — гипотезу про "доли секунды" этим способом не
проверить напрямую, но overshoot ВНУТРИ первой минуты всё равно виден через
high/low этой свечи: если толпа на открытии прыгнула выше/ниже итоговой
цены минуты, это уйдёт в хвост (high или low), а не в close.

Запуск:
    python morning_overshoot_check.py --days 20 [--base-tickers SBER,GAZP,LKOH]
    [--settle-after-min 5]

Для каждого фьюча по [FUTURES_TRADING] BASE_TICKERS (или --base-tickers):
  1. Тянем 1-минутные свечи фьюча за --days дней (CANDLE_INTERVAL_1_MIN).
  2. "Выброс" = high/low ПЕРВОЙ минутной свечи торгов дня (не close —
     именно хвост свечи ловит внутриминутный скачок, даже если цена к
     закрытию минуты уже откатилась).
  3. "Равновесная" цена — close фьюча через --settle-after-min минут после
     открытия (где цена устоялась после открытия).
  4. overshoot_pct = max(
         (high_первой_свечи - равновесная) / равновесная,
         (равновесная - low_первой_свечи) / равновесная
     ) — берём то направление хвоста, что дальше от итоговой цены; это и
     есть мера "насколько далеко был выброс от уровня, на котором цена
     устоялась" с точностью до 1 минуты (без секундной детализации не
     различить ушёл ли хвост вверх и вниз ОДНОВРЕМЕННО или по очереди).
  5. Печатаем: число дней, среднюю |overshoot_pct|, долю дней, где
     |overshoot_pct| превышает комиссию круга по фьючу (0.08%) — то есть
     теоретически окупила бы fade-сделку (без учёта реального
     проскальзывания/задержки исполнения на открытии, которая в первые
     секунды торгов может быть больше, чем на спокойном рынке, и без
     учёта того, что внутри минуты вход по хвосту физически недостижим
     лимит-ордером без удачи — это верхняя граница потенциала, не гарантия).

Если |overshoot_pct| в среднем меньше комиссии или сопоставим с обычным
размахом любой минутной свечи фьюча (не только первой) — выброса, который
можно было бы выгодно зафейдить, либо нет, либо его съедает комиссия/
проскальзывание, и идею лучше не встраивать в живую торговлю.
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


def _high(c) -> float:
    return float(quotation_to_decimal(c.high))


def _low(c) -> float:
    return float(quotation_to_decimal(c.low))


def _by_day(candles) -> dict:
    days: dict[str, list] = defaultdict(list)
    for c in candles:
        days[c.time.date().isoformat()].append(c)
    for day in days:
        days[day].sort(key=lambda c: c.time)
    return days


def _settle_price(day_candles: list, settle_after_min: int) -> float | None:
    """close первой свечи через >= settle_after_min минут после открытия дня."""
    day_start = day_candles[0].time
    for c in day_candles[1:]:
        if (c.time - day_start).total_seconds() >= settle_after_min * 60:
            return _close(c)
    return None


def analyze_future(ticker: str, figi_future: str, market_data: MarketDataService,
                    days: int, settle_after_min: int) -> None:
    candles = market_data.get_candles_history(figi_future, days=days, interval=CandleInterval.CANDLE_INTERVAL_1_MIN)
    by_day = _by_day(candles)

    overshoots = []
    for day, day_candles in by_day.items():
        if not day_candles:
            continue
        first = day_candles[0]
        settle = _settle_price(day_candles, settle_after_min)
        if settle is None or settle == 0:
            continue
        overshoot_up = (_high(first) - settle) / settle
        overshoot_down = (settle - _low(first)) / settle
        overshoots.append(overshoot_up if overshoot_up >= overshoot_down else -overshoot_down)

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
    parser.add_argument("--settle-after-min", type=int, default=5)
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

        analyze_future(future_settings.ticker, figi_future, market_data, args.days, args.settle_after_min)


if __name__ == "__main__":
    main()
