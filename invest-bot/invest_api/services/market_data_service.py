import logging
from datetime import datetime, timedelta, timezone
from typing import Optional

from tinkoff.invest import Client, GetTradingStatusResponse, SecurityTradingStatus, Quotation, \
    CandleInterval, HistoricCandle
from invest_api.invest_target import INVEST_TARGET

from invest_api.invest_error_decorators import invest_error_logging, invest_api_retry

__all__ = ("MarketDataService")

logger = logging.getLogger(__name__)


class MarketDataService:
    """
    The class encapsulate tinkoff market data service api
    """
    def __init__(self, token: str, app_name: str) -> None:
        self.__token = token
        self.__app_name = app_name

    @invest_api_retry()
    @invest_error_logging
    def __get_trading_status(self, figi: str) -> GetTradingStatusResponse:
        with Client(self.__token, app_name=self.__app_name, target=INVEST_TARGET) as client:
            status = client.market_data.get_trading_status(figi=figi)

            logger.debug(f"Trading Status {figi}: {status}")

            return status

    def is_stock_ready_for_trading(self, figi: str) -> bool:
        """
        Calculate and return decision does stock available for trading today:
        Limit orders are allowed
        Market orders are allowed
        Trading by API are allowed
        Status is NORMAL_TRADING (bot is skipping other statuses)
        """
        status = self.__get_trading_status(figi)

        return status.limit_order_available_flag and \
               status.market_order_available_flag and \
               status.api_trade_available_flag and \
               status.trading_status == SecurityTradingStatus.SECURITY_TRADING_STATUS_NORMAL_TRADING

    @invest_api_retry()
    @invest_error_logging
    def get_last_price(self, figi: str) -> Optional[Quotation]:
        """
        Request last price for instrument by figi.
        Main reason is for order purposes (more close to current price).
        """
        with Client(self.__token, app_name=self.__app_name, target=INVEST_TARGET) as client:
            prices = client.market_data.get_last_prices(figi=[figi])

            logger.debug(f"Last prices for {figi}: {prices}")

            for price in prices.last_prices:
                if price.figi == figi:
                    return price.price
            else:
                return None

    @invest_api_retry()
    @invest_error_logging
    def get_candles_history(
            self,
            figi: str,
            days: int = 5,
            interval: CandleInterval = CandleInterval.CANDLE_INTERVAL_5_MIN
    ) -> list[HistoricCandle]:
        """
        Историческая выгрузка свечей за последние `days` дней — для прогрева
        стратегии (warmup/backtest_quality) на тикерах, у которых ещё нет
        накопленной внутри процесса истории (например, найденных через
        MEGA-ALERTS). 5-минутный интервал лимитирован API одним днём за
        запрос — тянем по дням и склеиваем.
        """
        result: list[HistoricCandle] = []
        now = datetime.now(timezone.utc)
        with Client(self.__token, app_name=self.__app_name, target=INVEST_TARGET) as client:
            for day in range(days, 0, -1):
                day_to = now - timedelta(days=day - 1)
                day_from = now - timedelta(days=day)
                response = client.market_data.get_candles(
                    figi=figi,
                    from_=day_from,
                    to=day_to,
                    interval=interval
                )
                result.extend(c for c in response.candles if c.is_complete)

        logger.debug(f"Candles history for {figi}: {len(result)} баров за {days} дней")
        return result

    @invest_api_retry()
    @invest_error_logging
    def get_candles_for_dates(
            self,
            figi: str,
            dates: list,
            interval: CandleInterval = CandleInterval.CANDLE_INTERVAL_5_MIN
    ) -> list[HistoricCandle]:
        """
        Свечи только за конкретные календарные даты (`date` объекты) — для
        докачки недостающих дней архива (candle_archive.py), без повторного
        запроса уже закэшированных дней.
        """
        result: list[HistoricCandle] = []
        with Client(self.__token, app_name=self.__app_name, target=INVEST_TARGET) as client:
            for day in dates:
                day_from = datetime(day.year, day.month, day.day, tzinfo=timezone.utc)
                day_to = day_from + timedelta(days=1)
                response = client.market_data.get_candles(
                    figi=figi,
                    from_=day_from,
                    to=day_to,
                    interval=interval
                )
                result.extend(c for c in response.candles if c.is_complete)

        logger.debug(f"Candles for dates {figi}: {len(result)} баров за {len(dates)} дней")
        return result
