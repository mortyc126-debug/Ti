import datetime
import logging

from tinkoff.invest import Client, Quotation, StopOrderDirection, StopOrderExpirationType, StopOrderType, StopOrder
from invest_api.invest_target import INVEST_TARGET

from invest_api.invest_error_decorators import invest_error_logging, invest_api_retry

__all__ = ("StopOrderService")

logger = logging.getLogger(__name__)


class StopOrderService:
    """
    The class encapsulate tinkoff stop order service api
    """
    def __init__(self, token: str, app_name: str) -> None:
        self.__token = token
        self.__app_name = app_name

    @invest_api_retry()
    @invest_error_logging
    def __post_stop_order(
            self,
            account_id: str,
            figi: str,
            count_lots: int,
            price: Quotation,
            stop_price: Quotation,
            direction: StopOrderDirection,
            expiration_type: StopOrderExpirationType,
            stop_order_type: StopOrderType,
            expire_date: datetime
    ) -> str:
        with Client(self.__token, app_name=self.__app_name, target=INVEST_TARGET) as client:
            logger.debug(f"Post stop order for: {account_id}")

            return client.stop_orders.post_stop_order(
                figi=figi,
                quantity=count_lots,
                price=price,
                stop_price=stop_price,
                direction=direction,
                account_id=account_id,
                expiration_type=expiration_type,
                stop_order_type=stop_order_type,
                expire_date=expire_date
            ).stop_order_id

    def post_stop_limit(
            self,
            account_id: str,
            figi: str,
            lots: int,
            is_buy: bool,
            stop_price: float,
            limit_price: float,
    ) -> str:
        """
        Стоп-лимит: когда цена достигает stop_price — выставляет лимит по limit_price.
        Живёт на бирже независимо от бота (GTC). Возвращает stop_order_id.
        is_buy=True → покупка (закрытие шорта), False → продажа (закрытие лонга).
        limit_price должен быть чуть хуже stop_price, чтобы заявка исполнилась:
          для стопа лонга: limit_price = stop_price - N*min_step (разрешаем небольшое
          проскальзывание, но всё равно лучше рынка).
        """
        direction = (StopOrderDirection.STOP_ORDER_DIRECTION_BUY if is_buy
                     else StopOrderDirection.STOP_ORDER_DIRECTION_SELL)

        def _to_q(price: float) -> Quotation:
            units = int(price)
            nano = round((price - units) * 1_000_000_000)
            return Quotation(units=units, nano=nano)

        return self.__post_stop_order(
            account_id=account_id,
            figi=figi,
            count_lots=lots,
            price=_to_q(limit_price),
            stop_price=_to_q(stop_price),
            direction=direction,
            expiration_type=StopOrderExpirationType.STOP_ORDER_EXPIRATION_TYPE_GOOD_TILL_CANCEL,
            stop_order_type=StopOrderType.STOP_ORDER_TYPE_STOP_LIMIT,
            expire_date=datetime.datetime(2099, 12, 31, tzinfo=datetime.timezone.utc),
        )

    @invest_api_retry()
    @invest_error_logging
    def get_stop_orders(self, account_id: str) -> list[StopOrder]:
        with Client(self.__token, app_name=self.__app_name, target=INVEST_TARGET) as client:
            return client.stop_orders.get_stop_orders(account_id=account_id).stop_orders

    @invest_api_retry()
    @invest_error_logging
    def cancel_stop_order(self, account_id: str, stop_order_id: str) -> None:
        with Client(self.__token, app_name=self.__app_name, target=INVEST_TARGET) as client:
            client.stop_orders.cancel_stop_order(account_id=account_id, stop_order_id=stop_order_id)
