from configparser import ConfigParser

from configuration.settings import StrategySettings, AccountSettings, TradingSettings, BlogSettings, \
    MegaAlertsSettings, FuturesTradingSettings

__all__ = ("ProgramConfiguration")


class ProgramConfiguration:
    """
    Represent all bot configuration
    """
    def __init__(self, file_name: str) -> None:
        # classic ini file
        config = ConfigParser()
        config.read(file_name, encoding="utf-8")

        self.__tinkoff_token = config["INVEST_API"]["TOKEN"]
        self.__tinkoff_app_name = config["INVEST_API"]["APP_NAME"]

        self.__blog_settings = BlogSettings(
            blog_status=bool(int(config["BLOG"]["STATUS"])),
            bot_token=config["BLOG"]["TELEGRAM_BOT_TOKEN"],
            chat_id=config["BLOG"]["TELEGRAM_CHAT_ID"]
        )

        self.__account_settings = AccountSettings(
            min_liquid_portfolio=int(config["TRADING_ACCOUNT"]["MIN_LIQUID_PORTFOLIO"]),
            min_rub_on_account=int(config["TRADING_ACCOUNT"]["MIN_RUB_ON_ACCOUNT"])
        )

        ts = config["TRADING_SETTINGS"]
        self.__trading_settings = TradingSettings(
            delay_start_after_open=int(ts["DELAY_START_AFTER_EXCHANGE_OPEN_SECONDS"]),
            stop_trade_before_close=int(ts["STOP_TRADE_BEFORE_EXCHANGE_CLOSE_SECONDS"]),
            stop_signals_before_close=int(ts["STOP_SIGNALS_BEFORE_EXCHANGE_CLOSE_MINUTES"]),
            max_volume_participation=float(ts.get("MAX_VOLUME_PARTICIPATION", "0.1")),
            intraday_dead_zone_utc=ts.get("INTRADAY_DEAD_ZONE_UTC", "08:30-12:00"),
            daily_trend_gate=ts.get("DAILY_TREND_GATE", "1") == "1",
            corr_max_sector_positions=int(ts.get("CORR_MAX_SECTOR_POSITIONS", "2")),
            atr_lot_scale=ts.get("ATR_LOT_SCALE", "1") == "1",
        )

        if "MEGA_ALERTS" in config:
            ma = config["MEGA_ALERTS"]
            self.__mega_alerts_settings = MegaAlertsSettings(
                auto_trade=ma.get("AUTO_TRADE", "0") == "1",
                max_tickers=int(ma.get("MAX_TICKERS", "5")),
                signal_threshold=ma.get("SIGNAL_THRESHOLD", "0.25"),
                long_take=ma.get("LONG_TAKE", "1.015"),
                long_stop=ma.get("LONG_STOP", "0.985"),
                short_take=ma.get("SHORT_TAKE", "0.985"),
                short_stop=ma.get("SHORT_STOP", "1.015"),
                signal_only=ma.get("SIGNAL_ONLY", "1"),
                max_lots_per_order=int(ma.get("MAX_LOTS_PER_ORDER", "1")),
                history_days=int(ma.get("HISTORY_DAYS", "5")),
                backtest_quality_min=float(ma.get("BACKTEST_QUALITY_MIN", "0.55")),
                backtest_min_trades=int(ma.get("BACKTEST_MIN_TRADES", "3")),
                db_api_url=config["DB_API"].get("URL", "") if "DB_API" in config else "",
                db_api_key=config["DB_API"].get("API_KEY", "") if "DB_API" in config else "",
                min_avg_volume=int(ma.get("MIN_AVG_VOLUME", "0")),
            )
        else:
            self.__mega_alerts_settings = MegaAlertsSettings()

        if "FUTURES_TRADING" in config:
            ft = config["FUTURES_TRADING"]
            raw = ft.get("BASE_TICKERS", "").replace("\n", ",").replace("\r", "")
            base_tickers = [t.strip() for t in raw.split(",") if t.strip()]
            # Дефолты сигнала фьючерсов без своей STRATEGY_*_SETTINGS: секция
            # [FUTURES_DEFAULTS]; если её нет — значения из [MEGA_ALERTS] (как
            # было раньше, когда __build_futures_strategies читал их оттуда) —
            # полная обратная совместимость для конфигов без новой секции.
            ma = self.__mega_alerts_settings
            fd = config["FUTURES_DEFAULTS"] if "FUTURES_DEFAULTS" in config else {}
            self.__futures_trading_settings = FuturesTradingSettings(
                enabled=ft.get("ENABLED", "0") == "1",
                base_tickers=base_tickers,
                min_avg_volume=int(ft.get("MIN_AVG_VOLUME", "0")),
                signal_threshold=fd.get("SIGNAL_THRESHOLD", ma.signal_threshold),
                long_take=fd.get("LONG_TAKE", ma.long_take),
                long_stop=fd.get("LONG_STOP", ma.long_stop),
                short_take=fd.get("SHORT_TAKE", ma.short_take),
                short_stop=fd.get("SHORT_STOP", ma.short_stop),
                signal_only=fd.get("SIGNAL_ONLY", ma.signal_only),
                max_lots_per_order=int(fd.get("MAX_LOTS_PER_ORDER", ma.max_lots_per_order)),
            )
        else:
            self.__futures_trading_settings = FuturesTradingSettings()

        # Пароль для подтверждения переключения бота в боевой режим с дашборда
        # (runtime_overrides.py) — отдельно от TOKEN, чтобы не плодить риск
        # компрометации основного API-токена при случайной утечке.
        self.__dashboard_password = config["DASHBOARD_CONTROL"].get("PASSWORD", "") \
            if "DASHBOARD_CONTROL" in config else ""

        self.__trade_strategy_settings = []
        for strategy_section in config.sections():
            if strategy_section.startswith("STRATEGY_") and not strategy_section.endswith("_SETTINGS"):
                self.__trade_strategy_settings.append(
                    StrategySettings(
                        name=config[strategy_section]["STRATEGY_NAME"],
                        figi=config[strategy_section]["FIGI"],
                        ticker=config[strategy_section]["TICKER"],
                        max_lots_per_order=int(config[strategy_section]["MAX_LOTS_PER_ORDER"]),
                        settings=config[strategy_section + "_SETTINGS"],
                        is_future=config[strategy_section].get("IS_FUTURE", "0") == "1",
                        candle_interval_min=int(config[strategy_section].get("CANDLE_INTERVAL", "5")),
                    )
                )

    @property
    def tinkoff_token(self) -> str:
        return self.__tinkoff_token

    @property
    def tinkoff_app_name(self) -> str:
        return self.__tinkoff_app_name

    @property
    def blog_settings(self) -> BlogSettings:
        return self.__blog_settings

    @property
    def account_settings(self) -> AccountSettings:
        return self.__account_settings

    @property
    def trade_strategy_settings(self) -> list[StrategySettings]:
        return self.__trade_strategy_settings

    @property
    def trading_settings(self) -> TradingSettings:
        return self.__trading_settings

    @property
    def mega_alerts_settings(self) -> MegaAlertsSettings:
        return self.__mega_alerts_settings

    @property
    def futures_trading_settings(self) -> FuturesTradingSettings:
        return self.__futures_trading_settings

    @property
    def dashboard_password(self) -> str:
        return self.__dashboard_password
