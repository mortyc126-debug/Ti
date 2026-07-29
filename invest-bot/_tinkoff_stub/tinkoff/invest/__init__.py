"""
Локальный stub для tinkoff.invest — для офлайн-инструментов на машинах,
где реальный SDK не установлен (например, Python 3.14 — wheel'а ещё нет).

Активируется через sys.path.insert перед import oi_composite_strategy /
dashboard. На реальном боте, где установлен tinkoff-investments, этот
stub не активируется — реальный пакет находится первым в sys.path.

Расширение до полноценного OFFLINE-режима: client.market_data.get_candles
теперь читает свечи из локального data/candle_cache/<ticker>.json,
инвертируя figi→ticker через oi_tickers.json (если есть). Это позволяет
гонять dashboard/ab_toggle бэктест без сети — на том, что уже собрано в
кэше. Если тикер/дни отсутствуют — вернём пустой список свечей, вызов
проходит без AttributeError.
"""
from dataclasses import dataclass, field
from decimal import Decimal
from datetime import datetime, timezone
from typing import Optional
import os
import json as _json


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


@dataclass
class GetTradingStatusResponse:
    trading_status: int = 5  # NORMAL_TRADING
    figi: str = ""


@dataclass
class _GetCandlesResponse:
    candles: list = field(default_factory=list)


@dataclass
class _GetLastPricesResponse:
    last_prices: list = field(default_factory=list)


def _find_invest_bot_root() -> str:
    """Ищем корень invest-bot/ относительно этого stub-файла.
    Путь: invest-bot/_tinkoff_stub/tinkoff/invest/__init__.py → invest-bot/."""
    here = os.path.dirname(os.path.abspath(__file__))
    return os.path.abspath(os.path.join(here, "..", "..", ".."))


class _MarketDataStub:
    """client.market_data — читает свечи из локального data/candle_cache/*.json.
    figi→ticker берётся из oi_tickers.json (кэшируется). Если figi неизвестен
    или тикера в кэше нет — возвращает пустой список свечей (не роняет вызов)."""

    _figi_to_ticker: Optional[dict] = None

    def _load_figi_map(self) -> dict:
        if _MarketDataStub._figi_to_ticker is not None:
            return _MarketDataStub._figi_to_ticker
        f2t: dict = {}
        root = _find_invest_bot_root()
        oi_path = os.path.join(root, "oi_tickers.json")
        try:
            with open(oi_path, "r", encoding="utf-8") as f:
                data = _json.load(f)
            for item in (data or []):
                t = item.get("t") or item.get("ticker")
                fg = item.get("f") or item.get("figi")
                if t and fg:
                    f2t[fg] = t
        except (OSError, ValueError):
            pass
        _MarketDataStub._figi_to_ticker = f2t
        return f2t

    def get_trading_status(self, figi=None):
        return GetTradingStatusResponse(trading_status=5, figi=figi or "")

    def get_last_prices(self, figi=None):
        return _GetLastPricesResponse(last_prices=[])

    def get_candles(self, figi=None, from_=None, to=None, interval=None, **_kw):
        f2t = self._load_figi_map()
        ticker = f2t.get(figi) if figi else None
        candles: list = []
        if not ticker:
            return _GetCandlesResponse(candles=candles)
        root = _find_invest_bot_root()
        # интервал: 1мин лежит с суффиксом _1m.json, остальное — без суффикса
        suffix = "_1m" if interval == CandleInterval.CANDLE_INTERVAL_1_MIN else ""
        path = os.path.join(root, "data", "candle_cache", f"{ticker}{suffix}.json")
        if not os.path.exists(path):
            return _GetCandlesResponse(candles=candles)
        try:
            with open(path, "r", encoding="utf-8") as f:
                rows = _json.load(f)
        except (OSError, ValueError):
            return _GetCandlesResponse(candles=candles)
        # Приводим from_/to к aware-datetime для корректного сравнения
        def _aware(dt):
            if dt is None:
                return None
            if isinstance(dt, datetime):
                return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
            return None
        f_from, f_to = _aware(from_), _aware(to)
        for r in rows:
            try:
                t = datetime.fromisoformat(r["time"])
            except (KeyError, ValueError):
                continue
            if t.tzinfo is None:
                t = t.replace(tzinfo=timezone.utc)
            if f_from is not None and t < f_from:
                continue
            if f_to is not None and t >= f_to:
                continue
            candles.append(HistoricCandle(
                time=t,
                open=float(r["open"]), high=float(r["high"]),
                low=float(r["low"]), close=float(r["close"]),
                volume=int(r["volume"]), is_complete=True,
            ))
        return _GetCandlesResponse(candles=candles)


class Client:
    """Client-заглушка: имеет .market_data со свечами из локального кэша.
    Реальные вызовы к API упадут AttributeError — офлайн-скрипты в них не ходят."""
    def __init__(self, *a, **kw):
        self.market_data = _MarketDataStub()
    def __enter__(self): return self
    def __exit__(self, *a): pass


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
