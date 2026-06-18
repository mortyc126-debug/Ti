from dataclasses import dataclass, field

__all__ = ("StrategySettings", "AccountSettings", "ShareSettings", "FutureSettings", "TradingSettings",
           "BlogSettings", "MegaAlertsSettings", "FuturesTradingSettings")


@dataclass(eq=False, repr=True)
class StrategySettings:
    name: str = ""
    figi: str = ""
    ticker: str = ""
    max_lots_per_order: int = 1
    # All internal strategy settings are represented as dict. A strategy class have to parse it himself.
    # Here, we avoid any strong dependencies and obligations
    settings: dict = field(default_factory=dict)
    lot_size: int = 1
    short_enabled_flag: bool = True
    # Фьючерс вместо акции: размер позиции считается не от цены*лот, а от
    # реального гарантийного обеспечения (ГО) контракта на бирже.
    is_future: bool = False
    # ГО за один лот в рублях, на момент построения стратегии (Decimal как
    # float здесь — берётся напрямую из API, см. InstrumentService.future_by_ticker).
    margin_per_lot: float = 0.0


@dataclass(eq=False, repr=True)
class AccountSettings:
    min_liquid_portfolio: int = 10000
    min_rub_on_account: int = 5000


@dataclass(eq=False, repr=True)
class ShareSettings:
    ticker: str = ""
    lot: int = 1
    short_enabled_flag: bool = False
    otc_flag: bool = False
    buy_available_flag: bool = False
    sell_available_flag: bool = False
    api_trade_available_flag: bool = False


@dataclass(eq=False, repr=True)
class FutureSettings:
    """Информация по фьючерсному контракту (для расчёта позиции по ГО, см. trader.py)."""
    ticker: str = ""
    lot: int = 1
    short_enabled_flag: bool = True
    basic_asset: str = ""
    expiration_date: object = None
    margin_per_lot: float = 0.0


@dataclass(eq=False, repr=True)
class FuturesTradingSettings:
    """Автоторговля фьючерсами на базовые активы из STRATEGY_* (вместо акций)."""
    enabled: bool = False
    base_tickers: list = field(default_factory=list)


@dataclass(eq=False, repr=True)
class TradingSettings:
    delay_start_after_open: int = 10
    stop_trade_before_close: int = 300
    stop_signals_before_close: int = 60
    # Доля от среднего объёма последних свечей по тикеру, которую разрешено
    # выставить в одном ордере (защита от проскальзывания на неликвиде).
    max_volume_participation: float = 0.1


@dataclass(eq=False, repr=True)
class MegaAlertsSettings:
    """Динамическая торговля тикерами, которые MOEX MEGA-ALERTS отметил аномальными сегодня."""
    auto_trade: bool = False
    max_tickers: int = 5
    signal_threshold: str = "0.25"
    long_take: str = "1.015"
    long_stop: str = "0.985"
    short_take: str = "0.985"
    short_stop: str = "1.015"
    signal_only: str = "1"
    max_lots_per_order: int = 1
    history_days: int = 5
    backtest_quality_min: float = 0.55
    backtest_min_trades: int = 3
    db_api_url: str = ""
    db_api_key: str = ""


@dataclass(eq=False, repr=True)
class BlogSettings:
    blog_status: bool
    bot_token: str
    chat_id: str
