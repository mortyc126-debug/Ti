import uuid
from decimal import Decimal

from grpc import StatusCode
from tinkoff.invest import MoneyValue, Quotation, Candle, HistoricCandle
from tinkoff.invest.utils import quotation_to_decimal, decimal_to_quotation

__all__ = ()


def rub_currency_name() -> str:
    return "rub"


def moex_exchange_name() -> str:
    return "MOEX"


def moneyvalue_to_decimal(money_value: MoneyValue) -> Decimal:
    return quotation_to_decimal(
        Quotation(
            units=money_value.units,
            nano=money_value.nano
        )
    )


def decimal_to_moneyvalue(decimal: Decimal, currency: str = rub_currency_name()) -> MoneyValue:
    quotation = decimal_to_quotation(decimal)
    return MoneyValue(
        currency=currency,
        units=quotation.units,
        nano=quotation.nano
    )


def generate_order_id() -> str:
    return str(uuid.uuid4())


def candle_to_historiccandle(candle: Candle) -> HistoricCandle:
    return HistoricCandle(
        open=candle.open,
        high=candle.high,
        low=candle.low,
        close=candle.close,
        volume=candle.volume,
        time=candle.time,
        is_complete=True
    )


def aggcandle_to_historiccandle(agg, time) -> HistoricCandle:
    """Конвертирует AggCandle (timeframe.py, float OHLCV из нескольких 1min-баров)
    в HistoricCandle — чтобы стратегия считала сигнал на агрегированном 5min-баре
    так же, как в бэктесте (там CANDLE_WINDOW=30 строится из 5min-свечей)."""
    return HistoricCandle(
        open=decimal_to_quotation(Decimal(str(agg.open))),
        high=decimal_to_quotation(Decimal(str(agg.high))),
        low=decimal_to_quotation(Decimal(str(agg.low))),
        close=decimal_to_quotation(Decimal(str(agg.close))),
        volume=agg.volume,
        time=time,
        is_complete=True
    )


def invest_api_retry_status_codes() -> set[StatusCode]:
    return {StatusCode.CANCELLED, StatusCode.DEADLINE_EXCEEDED, StatusCode.RESOURCE_EXHAUSTED,
            StatusCode.FAILED_PRECONDITION, StatusCode.ABORTED, StatusCode.INTERNAL,
            StatusCode.UNAVAILABLE, StatusCode.DATA_LOSS, StatusCode.UNKNOWN}
