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
    # для фьючерсов — стоимость одного пункта изменения цены в рублях
    # (для акций остаётся 1.0 — 1 пункт цены = 1 рубль)
    point_value: float = 1.0
    # интервал свечей в минутах: 1 или 5 (дефолт). Влияет на загрузку истории
    # и на окна индикаторов внутри OICompositeStrategy.
    candle_interval_min: int = 5
    # минимальный шаг цены (тик) в рублях — используется при расчёте лимит-цены
    # для биржевых стоп-лимит ордеров (слиппаж = 3 * min_price_increment).
    # Дефолт 0.01 (1 копейка) подходит большинству акций MOEX.
    min_price_increment: float = 0.01


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
    # стоимость одного пункта цены в рублях (min_price_increment_amount / min_price_increment)
    point_value: float = 1.0


@dataclass(eq=False, repr=True)
class FuturesTradingSettings:
    """Автоторговля фьючерсами на базовые активы из STRATEGY_* (вместо акций)."""
    enabled: bool = False
    base_tickers: list = field(default_factory=list)
    # Минимальный средний объём (лотов/свечу) за последние 20 баров.
    # Фьючерсы ниже порога — пропускаются (шум, нет edge).
    # 0 = фильтр отключён (поведение по умолчанию).
    min_avg_volume: int = 0
    # Дефолты сигнала для фьючерса, у которого НЕТ своей STRATEGY_<TICKER>_SETTINGS
    # (индексные/валютные/товарные базовые активы — без акции-родителя в settings.ini).
    # Раньше эти дефолты молча брались из [MEGA_ALERTS] — теперь отдельная секция
    # [FUTURES_DEFAULTS], чтобы правка автоторговли аномалий не задевала параметры
    # фьючерсов и наоборот (configuration.py при отсутствии секции подставляет
    # значения из [MEGA_ALERTS] — полная обратная совместимость).
    signal_threshold: str = "0.25"
    long_take: str = "1.015"
    long_stop: str = "0.985"
    short_take: str = "0.985"
    short_stop: str = "1.015"
    signal_only: str = "1"
    max_lots_per_order: int = 1
    # Пер-тикерная карта «базовый тикер → имя стратегии» (секция
    # [FUTURES_STRATEGY_MAP]). Перебивает глобальный STRATEGY_OVERRIDE ТОЛЬКО
    # для перечисленных тикеров — остальные фьючерсы идут по override/дефолту.
    # Так accel-fade остаётся дефолтом на всём фронте, а отдельные неликвидные
    # имена уходят на NWMemoryStrategy (жёсткое разделение по ликвидности).
    # Ключи хранятся в UPPERCASE, лукап — по base_ticker.upper().
    strategy_map: dict = field(default_factory=dict)


@dataclass(eq=False, repr=True)
class TradingSettings:
    delay_start_after_open: int = 10
    stop_trade_before_close: int = 300
    stop_signals_before_close: int = 60
    max_volume_participation: float = 0.1
    limit_reprice_interval_sec: int = 15
    limit_reprice_max_attempts: int = 3
    limit_adverse_move_pct: float = 0.0006
    # Мёртвая зона внутри дня (UTC): сигналы в этом окне отклоняются.
    # MOEX: 08:30-12:00 UTC = 11:30-15:00 MSK — обеденный боковик.
    # Формат "HH:MM-HH:MM". Пусто = фильтр отключён.
    intraday_dead_zone_utc: str = "08:30-12:00"
    # Дневной режимный гейт: если рынок сегодня в боковике (ranging/low_vol)
    # по дневным закрытиям — сигналы не генерируются. 1=включён, 0=выключен.
    daily_trend_gate: bool = True
    # Корреляционный фильтр: максимум одновременных позиций в одной группе
    # (нефть, металлы, банки и т.д.). 0 = фильтр отключён.
    corr_max_sector_positions: int = 2
    # ATR-масштабирование лотов: 1=включено. Инструменты с высоким ATR
    # получают меньше лотов (единый риск в рублях на сделку).
    atr_lot_scale: bool = True
    # Глобальный override имени стратегии: если задан — ВСЕ инструменты
    # (статические STRATEGY_*, фьючерс-автоторговля, мегаалерты) торгуют этой
    # стратегией, минуя per-ticker STRATEGY_NAME. Пусто = поведение по секциям.
    strategy_override: str = ""


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
    # Минимальный средний объём (лотов/свечу) за последние 20 баров.
    # 0 = фильтр отключён.
    min_avg_volume: int = 0


@dataclass(eq=False, repr=True)
class BlogSettings:
    blog_status: bool
    bot_token: str
    chat_id: str
