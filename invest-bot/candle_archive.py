"""
candle_archive.py — кэш исторических свечей в общей базе (Cloudflare D1,
см. cf-collector/worker.js + db_api_client.py), чтобы повторные бэктесты
(например, с другими take/stop, или бэктест → потом портфельная
симуляция по тем же тикерам) не дёргали Tinkoff API заново за уже
закэшированные дни, и чтобы со временем накопился архив глубже 90 дней,
которые отдаёт сам API за один проход.

Логика инкрементальная: смотрим, какие календарные дни из запрошенного
периода уже есть в архиве, докачиваем у Tinkoff только недостающие дни
(MarketDataService.get_candles_for_dates), дописываем их в архив и
отдаём объединённый набор. Выходные/праздники без торгов будут
запрашиваться у Tinkoff повторно при каждом холодном дне (в архиве для
них просто нет свечей) — это дешёвый пустой запрос, не страшно.
"""
import logging
from datetime import datetime, timedelta, timezone, date
from decimal import Decimal

from tinkoff.invest import HistoricCandle, Quotation
from tinkoff.invest.utils import quotation_to_decimal, decimal_to_quotation

from db_api_client import DbApiClient
from invest_api.services.market_data_service import MarketDataService

__all__ = ("get_candles_cached",)

logger = logging.getLogger(__name__)


def _candle_to_row(c: HistoricCandle) -> dict:
    return {
        "time": c.time.isoformat(),
        "open": float(quotation_to_decimal(c.open)),
        "high": float(quotation_to_decimal(c.high)),
        "low": float(quotation_to_decimal(c.low)),
        "close": float(quotation_to_decimal(c.close)),
        "volume": c.volume,
    }


def _row_to_candle(row: dict) -> HistoricCandle:
    def q(v: float) -> Quotation:
        return decimal_to_quotation(Decimal(str(v)))

    return HistoricCandle(
        time=datetime.fromisoformat(row["time"]),
        open=q(row["open"]), high=q(row["high"]),
        low=q(row["low"]), close=q(row["close"]),
        volume=int(row["volume"]),
        is_complete=True,
    )


def get_candles_cached(
        ticker: str, figi: str, days: int,
        market_data: MarketDataService, db: DbApiClient
) -> list[HistoricCandle]:
    now = datetime.now(timezone.utc)
    date_from = (now - timedelta(days=days)).date()
    date_to = now.date()

    if not db.configured:
        return market_data.get_candles_history(figi, days=days)

    archived = db.get_candles(ticker, date_from.isoformat(), date_to.isoformat())
    have_days = {row["time"][:10] for row in archived}

    all_days = [date_from + timedelta(days=i) for i in range((date_to - date_from).days + 1)]
    missing_days = [d for d in all_days if d.isoformat() not in have_days]

    if not missing_days:
        logger.info(f"{ticker}: {len(archived)} свечей из архива D1 ({date_from}..{date_to}), без запроса к Tinkoff")
        return [_row_to_candle(r) for r in archived]

    logger.info(f"{ticker}: {len(archived)} свечей из архива, докачиваю {len(missing_days)} недостающих дней у Tinkoff")
    fresh = market_data.get_candles_for_dates(figi, missing_days)
    if fresh:
        db.push_candles(ticker, [_candle_to_row(c) for c in fresh])

    merged = [_row_to_candle(r) for r in archived] + list(fresh)
    merged.sort(key=lambda c: c.time)
    return merged

