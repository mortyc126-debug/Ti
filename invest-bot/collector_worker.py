"""
collector_worker.py — отдельный суточный воркер полного сбора по рынку.

Не часть торгового бота (main.py) — запускается отдельным процессом
(cron/systemd timer, раз в день вне торговых часов). Задача: пройти по
ВСЕМ торгуемым через API акциям TQBR, для каждой запросить историю свечей,
прогнать через тот же композит (OICompositeStrategy), что использует
торговый бот, и записать результат в общую базу — Cloudflare D1 через
HTTP API воркера (cf-collector/worker.js).

Торговый бот (trading/trader.py) при появлении нового тикера из
MEGA-ALERTS сначала спрашивает эту базу (DbApiClient.latest) — если там
уже есть свежий расчёт, использует его и достраивает только недостающее
(например, сегодняшние свечи), а не считает всю историю заново сам.

Запуск: python collector_worker.py [--settings settings.ini]
"""
import argparse
import logging
import sys
import time
from configparser import ConfigParser
from datetime import datetime, timezone

from configuration.settings import StrategySettings
from db_api_client import DbApiClient
from invest_api.services.instruments_service import InstrumentService
from invest_api.services.market_data_service import MarketDataService
from trade_system.strategies.strategy_factory import StrategyFactory

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("collector_worker")

REQUEST_DELAY_SECONDS = 0.3  # пауза между тикерами, чтобы не выбить рейт-лимит Tinkoff API


def collect_one(
        ticker: str,
        figi: str,
        lot: int,
        short_enabled: bool,
        market_data: MarketDataService,
        history_days: int,
        db: DbApiClient
) -> None:
    settings = StrategySettings(
        name="OICompositeStrategy",
        figi=figi,
        ticker=ticker,
        max_lots_per_order=1,
        settings={
            "SIGNAL_THRESHOLD": "0.25",
            "LONG_TAKE": "1.015",
            "LONG_STOP": "0.985",
            "SHORT_TAKE": "0.985",
            "SHORT_STOP": "1.015",
            "SIGNAL_ONLY": "1",
        },
        lot_size=lot,
        short_enabled_flag=short_enabled
    )
    strategy = StrategyFactory.new_factory("OICompositeStrategy", settings)
    if not strategy:
        return

    try:
        candles = market_data.get_candles_history(figi, days=history_days)
    except Exception as ex:
        logger.warning(f"{ticker}: история свечей не получена: {repr(ex)}")
        return
    if not candles:
        logger.info(f"{ticker}: нет свечей за {history_days} дней, пропуск")
        return

    strategy.warmup(candles)
    strategy.analyze_candles([])  # досчитать composite/scores на прогретом окне без новых баров
    quality, n_trades = strategy.backtest_quality(candles)
    snapshot = strategy.last_snapshot()

    db.push_snapshot(
        ticker,
        date=datetime.now(timezone.utc).date().isoformat(),
        composite=snapshot["composite"],
        scores=snapshot["scores"],
        regime=snapshot["regime"],
        regime_confidence=snapshot.get("regime_confidence", 1.0),
        rolling_quality=snapshot["rolling_quality"],
        backtest_quality=quality,
        backtest_trades=n_trades,
        live=False
    )
    logger.info(f"{ticker}: composite={snapshot['composite']:.3f} backtest_quality={quality:.2f} ({n_trades} сделок)")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--settings", default="settings.ini")
    args = parser.parse_args()

    config = ConfigParser()
    config.read(args.settings)

    token = config["INVEST_API"]["TOKEN"]
    app_name = config["INVEST_API"]["APP_NAME"]

    db_section = config["DB_API"] if "DB_API" in config else {}
    db = DbApiClient(
        base_url=db_section.get("URL", ""),
        api_key=db_section.get("API_KEY", "")
    )
    history_days = int(db_section.get("HISTORY_DAYS", "5"))

    if not db_section.get("URL"):
        logger.error("Секция [DB_API] с URL не настроена в settings.ini — нечего слать")
        sys.exit(1)

    instruments = InstrumentService(token, app_name)
    market_data = MarketDataService(token, app_name)

    shares = instruments.all_moex_shares()
    logger.info(f"Найдено {len(shares)} торгуемых акций TQBR, начинаю сбор")

    for share_settings, figi in shares:
        collect_one(
            share_settings.ticker, figi, share_settings.lot,
            share_settings.short_enabled_flag, market_data, history_days, db
        )
        time.sleep(REQUEST_DELAY_SECONDS)

    logger.info("Сбор по всему рынку завершён")


if __name__ == "__main__":
    main()
