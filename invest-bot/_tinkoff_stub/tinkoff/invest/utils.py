"""tinkoff.invest.utils stub — только для quotation_to_decimal."""
from datetime import datetime, timezone
from decimal import Decimal
from . import Quotation, MoneyValue


def now() -> datetime:
    """Реальная возвращает timezone-aware UTC now."""
    return datetime.now(timezone.utc)


def quotation_to_decimal(q) -> Decimal:
    """Реальная функция принимает Quotation/MoneyValue (units+nano) и
    возвращает Decimal. Здесь: если это дукт-типированный объект с
    units/nano — собираем как настоящая; если это уже число (float/
    int/Decimal) — обёртываем в Decimal. Второй кейс нужен для
    духового прогона score_methods, где candle.close = float."""
    if isinstance(q, (Quotation, MoneyValue)):
        return Decimal(q.units) + Decimal(q.nano) / Decimal(10 ** 9)
    if hasattr(q, "units") and hasattr(q, "nano"):
        return Decimal(int(q.units)) + Decimal(int(q.nano)) / Decimal(10 ** 9)
    return Decimal(str(q))


def decimal_to_quotation(d: Decimal) -> Quotation:
    units = int(d)
    nano = int((d - units) * (10 ** 9))
    return Quotation(units=units, nano=nano)
