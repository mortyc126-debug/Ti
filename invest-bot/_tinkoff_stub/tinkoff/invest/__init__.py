"""
Локальный stub для tinkoff.invest — только для офлайн-инструментов
(score_methods.py и т.п.), где score_* функции читают candle-атрибуты,
но с реальным API не общаются.

Активируется через sys.path.insert перед import oi_composite_strategy.
На реальном боте, где установлен tinkoff-investments, этот stub не
активируется — реальный пакет находится первым в sys.path.
"""
from dataclasses import dataclass, field
from decimal import Decimal
from datetime import datetime
from typing import Optional


@dataclass
class Quotation:
    units: int = 0
    nano: int = 0


@dataclass
class MoneyValue:
    currency: str = ""
    units: int = 0
    nano: int = 0


@dataclass
class HistoricCandle:
    time: Optional[datetime] = None
    open: object = None
    high: object = None
    low: object = None
    close: object = None
    volume: int = 0
    is_complete: bool = True


class CandleInterval:
    """Enum-заглушка. Значения не важны для офлайн-скриптов."""
    CANDLE_INTERVAL_UNSPECIFIED = 0
    CANDLE_INTERVAL_1_MIN = 1
    CANDLE_INTERVAL_5_MIN = 2
    CANDLE_INTERVAL_15_MIN = 3
    CANDLE_INTERVAL_HOUR = 4
    CANDLE_INTERVAL_DAY = 5


class SecurityTradingStatus:
    SECURITY_TRADING_STATUS_UNSPECIFIED = 0
    SECURITY_TRADING_STATUS_NORMAL_TRADING = 5


class Client:
    """Заглушка. Реальные вызовы к API упадут — это норма, офлайн-скрипты
    туда не ходят."""
    def __init__(self, *a, **kw): pass
    def __enter__(self): return self
    def __exit__(self, *a): pass


class GetTradingStatusResponse:
    pass


@dataclass
class LastPrice:
    figi: str = ""
    price: Optional[Quotation] = None


# Catch-all: любое имя, не определённое явно выше, при
# `from tinkoff.invest import Foo` получит тривиальный класс-заглушку.
# Так офлайн-скрипты (redundancy_analysis, lag_analysis), которые тянут
# десятки типов из SDK ради аннотаций/except, импортируются без падения,
# не общаясь с реальным API (свечи берутся из локального кэша). PEP 562.
_MADE: dict = {}


def __getattr__(name: str):
    if name in _MADE:
        return _MADE[name]
    # Классы исключений — наследуем Exception, чтобы except ловил.
    base = Exception if ("Error" in name or "Exception" in name) else object
    cls = type(name, (base,), {"__doc__": f"tinkoff.invest stub for {name}"})
    _MADE[name] = cls
    return cls
