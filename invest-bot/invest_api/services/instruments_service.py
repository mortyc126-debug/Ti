import datetime
import logging

from tinkoff.invest import Client, TradingSchedule, InstrumentIdType, InstrumentStatus
from invest_api.invest_target import INVEST_TARGET

from configuration.settings import ShareSettings, FutureSettings
from invest_api.invest_error_decorators import invest_error_logging, invest_api_retry
from invest_api.utils import moex_exchange_name, moneyvalue_to_decimal

__all__ = ("InstrumentService")

logger = logging.getLogger(__name__)


class InstrumentService:
    """
    The class encapsulate tinkoff instruments api
    """
    def __init__(self, token: str, app_name: str) -> None:
        self.__token = token
        self.__app_name = app_name

    def moex_today_trading_schedule(self) -> (bool, datetime, datetime):
        """
        :return: Information about trading day status, datetime trading day start, datetime trading day end
        (both on today)
        """
        for schedule in self.__trading_schedules(
                exchange=moex_exchange_name(),
                _from=datetime.datetime.utcnow(),
                _to=datetime.datetime.utcnow() + datetime.timedelta(days=1)
        ):
            for day in schedule.days:
                if day.date.date() == datetime.date.today():
                    logger.info(f"MOEX today schedule: {day}")
                    return day.is_trading_day, day.start_time, day.end_time

        return False, datetime.datetime.utcnow(), datetime.datetime.utcnow()

    @invest_api_retry()
    @invest_error_logging
    def __trading_schedules(
            self,
            exchange: str,
            _from: datetime,
            _to: datetime
    ) -> list[TradingSchedule]:
        result = []

        with Client(self.__token, app_name=self.__app_name, target=INVEST_TARGET) as client:
            logger.debug(f"Trading Schedules for exchange: {exchange}, from: {_from}, to: {_to}")

            for schedule in client.instruments.trading_schedules(
                    exchange=exchange,
                    from_=_from,
                    to=_to
            ).exchanges:
                logger.debug(f"{schedule}")
                result.append(schedule)

        return result

    @invest_api_retry()
    @invest_error_logging
    def share_by_figi(self, figi: str) -> ShareSettings:
        """
        :return: Information about share settings by it figi
        """
        with Client(self.__token, app_name=self.__app_name, target=INVEST_TARGET) as client:
            logger.debug(f"ShareBy figi: {figi}:")

            share = client.instruments.share_by(
                id_type=InstrumentIdType.INSTRUMENT_ID_TYPE_FIGI,
                id=figi
            ).instrument
            logger.debug(f"{share}")

            return ShareSettings(
                ticker=share.ticker,
                lot=share.lot,
                short_enabled_flag=share.short_enabled_flag,
                otc_flag=share.otc_flag,
                buy_available_flag=share.buy_available_flag,
                sell_available_flag=share.sell_available_flag,
                api_trade_available_flag=share.api_trade_available_flag
            )

    @invest_api_retry()
    @invest_error_logging
    def share_by_ticker(self, ticker: str, class_code: str = "TQBR") -> tuple[ShareSettings, str] | None:
        """
        :return: Share settings by MOEX ticker (e.g. для тикеров, найденных
        вне settings.ini — через MEGA-ALERTS), None если не нашли/не акция.
        """
        with Client(self.__token, app_name=self.__app_name, target=INVEST_TARGET) as client:
            logger.debug(f"ShareBy ticker: {ticker}:")

            try:
                share = client.instruments.share_by(
                    id_type=InstrumentIdType.INSTRUMENT_ID_TYPE_TICKER,
                    class_code=class_code,
                    id=ticker
                ).instrument
            except Exception as ex:
                logger.warning(f"share_by_ticker {ticker} failed: {repr(ex)}")
                return None
            logger.debug(f"{share}")

            return ShareSettings(
                ticker=share.ticker,
                lot=share.lot,
                short_enabled_flag=share.short_enabled_flag,
                otc_flag=share.otc_flag,
                buy_available_flag=share.buy_available_flag,
                sell_available_flag=share.sell_available_flag,
                api_trade_available_flag=share.api_trade_available_flag
            ), share.figi

    @invest_api_retry()
    @invest_error_logging
    def all_moex_shares(self, class_code: str = "TQBR") -> list[tuple[ShareSettings, str]]:
        """
        :return: Все торгуемые через API акции основного режима MOEX (TQBR) —
        для воркера полного сбора по рынку (collector_worker.py).
        """
        result: list[tuple[ShareSettings, str]] = []
        with Client(self.__token, app_name=self.__app_name, target=INVEST_TARGET) as client:
            for share in client.instruments.shares(
                    instrument_status=InstrumentStatus.INSTRUMENT_STATUS_BASE
            ).instruments:
                if share.class_code != class_code or not share.api_trade_available_flag:
                    continue
                result.append((
                    ShareSettings(
                        ticker=share.ticker,
                        lot=share.lot,
                        short_enabled_flag=share.short_enabled_flag,
                        otc_flag=share.otc_flag,
                        buy_available_flag=share.buy_available_flag,
                        sell_available_flag=share.sell_available_flag,
                        api_trade_available_flag=share.api_trade_available_flag
                    ),
                    share.figi
                ))
        logger.info(f"all_moex_shares: {len(result)} акций {class_code}")
        return result

    @invest_api_retry()
    @invest_error_logging
    def future_by_base_ticker(self, base_ticker: str) -> tuple[FutureSettings, str] | None:
        """
        Находит ближайший по дате экспирации непросроченный фьючерс на
        базовый актив (например base_ticker="SBER" -> фьючерс SBRF с
        ближайшей датой исполнения). ГО берётся из API на момент вызова —
        контракты заменяются раз в квартал, ГО может меняться день в день.
        """
        now = datetime.datetime.now(datetime.timezone.utc)
        best = None
        best_figi = None
        best_expiration = None

        with Client(self.__token, app_name=self.__app_name, target=INVEST_TARGET) as client:
            for future in client.instruments.futures(
                    instrument_status=InstrumentStatus.INSTRUMENT_STATUS_BASE
            ).instruments:
                if future.basic_asset != base_ticker or not future.api_trade_available_flag:
                    continue
                if future.expiration_date <= now:
                    continue
                if best_expiration is None or future.expiration_date < best_expiration:
                    best, best_figi, best_expiration = future, future.figi, future.expiration_date

        if best is None:
            logger.warning(f"future_by_base_ticker: контракт на {base_ticker} не найден")
            return None

        margin_per_lot = max(
            moneyvalue_to_decimal(best.initial_margin_on_buy),
            moneyvalue_to_decimal(best.initial_margin_on_sell)
        )

        # стоимость одного пункта цены: сколько рублей даёт движение цены на 1 шаг
        min_step = moneyvalue_to_decimal(best.min_price_increment)
        min_step_amount = moneyvalue_to_decimal(best.min_price_increment_amount)
        point_value = float(min_step_amount / min_step) if min_step and min_step != 0 else 1.0

        return FutureSettings(
            ticker=best.ticker,
            lot=best.lot,
            short_enabled_flag=best.short_enabled_flag,
            basic_asset=best.basic_asset,
            expiration_date=best.expiration_date,
            margin_per_lot=float(margin_per_lot),
            point_value=point_value
        ), best_figi

    @invest_api_retry()
    @invest_error_logging
    def __currencies(self) -> None:
        with Client(self.__token, app_name=self.__app_name, target=INVEST_TARGET) as client:
            for cur in client.instruments.currencies(
                    instrument_status=InstrumentStatus.INSTRUMENT_STATUS_BASE
            ).instruments:
                logger.debug(f"{cur}")

    @invest_api_retry()
    @invest_error_logging
    def __instrument_by_figi(self, figi: str) -> None:
        with Client(self.__token, app_name=self.__app_name, target=INVEST_TARGET) as client:
            logger.debug(f"InstrumentBy figi: {figi}:")

            instrument = client.instruments.get_instrument_by(id_type=InstrumentIdType.INSTRUMENT_ID_TYPE_FIGI,
                                                              id=figi).instrument

            logger.debug(f"{instrument}")
