"""
candle_archive.py — кэш исторических свечей в общей базе (Cloudflare D1,
см. cf-collector/worker.js + db_api_client.py), чтобы повторные бэктесты
(например, с другими take/stop) не дёргали Tinkoff API заново за те же
дни, и чтобы со временем накопился архив глубже 90 дней, которые отдаёт
сам API за один проход.

Логика простая: если в архиве уже есть свечи, перекрывающие весь
запрошенный период — отдаём их без похода в Tinkoff. Иначе тянем у
Tinkoff (как раньше) и параллельно дописываем архив (ON CONFLICT DO
NOTHING на стороне воркера — дубли не страшны).
"""
import logging
from datetime import datetime, timedelta, timezone
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
    date_from = (now - timedelta(days=days)).date().isoformat()
    date_to = now.date().isoformat()

    if db.configured:
        archived = db.get_candles(ticker, date_from, date_to)
        earliest = archived[0]["time"][:10] if archived else None
        if earliest and earliest <= date_from:
            logger.info(f"{ticker}: {len(archived)} свечей из архива D1 ({date_from}..{date_to}), без запроса к Tinkoff")
            return [_row_to_candle(r) for r in archived]

    candles = market_data.get_candles_history(figi, days=days)
    if db.configured and candles:
        db.push_candles(ticker, [_candle_to_row(c) for c in candles])
    return candles
