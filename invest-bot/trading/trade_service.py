import asyncio
import datetime
import logging

from blog.blogger import Blogger
from configuration.settings import AccountSettings, TradingSettings, StrategySettings, \
    MegaAlertsSettings, FuturesTradingSettings
from invest_api.services.accounts_service import AccountService, AccountInfo
from invest_api.services.client_service import ClientService
from invest_api.services.instruments_service import InstrumentService
from invest_api.services.market_data_service import MarketDataService
from invest_api.services.operations_service import OperationService
from invest_api.services.orders_service import OrderService
from invest_api.services.market_data_stream_service import MarketDataStreamService
from mega_alerts import MegaAlertsService
from notification_service import NotificationService, capture_tb
from runtime_overrides import RuntimeOverrides
from trade_system.strategies.base_strategy import IStrategy
from trading.trader import Trader

__all__ = ("TradeService")

logger = logging.getLogger(__name__)


class TradeService:
    def __init__(
            self,
            account_service: AccountService,
            client_service: ClientService,
            instrument_service: InstrumentService,
            operation_service: OperationService,
            order_service: OrderService,
            stream_service: MarketDataStreamService,
            market_data_service: MarketDataService,
            blogger: Blogger,
            account_settings: AccountSettings,
            trading_settings: TradingSettings,
            strategies: list[IStrategy],
            mega_alerts_settings: MegaAlertsSettings = MegaAlertsSettings(),
            futures_trading_settings: FuturesTradingSettings = FuturesTradingSettings()
    ) -> None:
        self.__account_service = account_service
        self.__client_service = client_service
        self.__instrument_service = instrument_service
        self.__operation_service = operation_service
        self.__order_service = order_service
        self.__stream_service = stream_service
        self.__market_data_service = market_data_service
        self.__blogger = blogger
        self.__account_settings = account_settings
        self.__trading_settings = trading_settings
        self.__strategies = strategies
        self.__mega_alerts_settings = mega_alerts_settings
        self.__futures_trading_settings = futures_trading_settings
        self.__mega_alerts = MegaAlertsService()
        self.__mega_alerts_task: asyncio.Task | None = None
        self.__notifier = NotificationService(blogger)
        # Отдельный RuntimeOverrides для trade_service — отслеживает список включённых счетов.
        # Trader внутри читает свой экземпляр для тикерных оверрайдов.
        self.__overrides = RuntimeOverrides()

    async def worker(self) -> None:
        self.__mega_alerts_task = asyncio.create_task(self.__mega_alerts.daily_loop())
        try:
            try:
                accounts = self.__get_active_accounts()
            except Exception as ex:
                logger.error(f"Start trading error: {repr(ex)}")
                self.__notifier.error("trade_service: старт", ex, capture_tb())
                return

            if not accounts:
                msg = "Не найдено ни одного подходящего счёта для торговли"
                logger.error(msg)
                self.__notifier.error("trade_service: поиск счетов", ValueError(msg))
                return

            # Запускаем рабочий цикл параллельно для каждого счёта
            await asyncio.gather(*[self.__working_loop(acc) for acc in accounts])
        finally:
            self.__mega_alerts_task.cancel()

    def __get_active_accounts(self) -> list[AccountInfo]:
        """Возвращает список счетов с учётом оверрайдов."""
        self.__overrides.maybe_reload()
        enabled_ids = self.__overrides.enabled_account_ids()  # None = все
        accounts = self.__account_service.trading_account_ids(self.__account_settings, enabled_ids)
        logger.info(f"Счета для торговли: {[(a.id, a.name, a.account_type, a.liquid_portfolio) for a in accounts]}")
        return accounts

    async def __working_loop(self, account: AccountInfo) -> None:
        label = f"{account.name} [{account.account_type}]"
        logger.info(f"Запуск рабочего цикла для счёта: {label} ({account.id})")

        while True:
            logger.info(f"[{label}] Проверяем расписание торгов")

            try:
                is_trading_day, start_time, end_time = \
                    self.__instrument_service.moex_today_trading_schedule()

                if is_trading_day and datetime.datetime.utcnow().replace(tzinfo=datetime.timezone.utc) <= end_time:
                    logger.info(f"[{label}] Торговый день, старт после {start_time}")

                    await TradeService.__sleep_to(
                        start_time + datetime.timedelta(seconds=self.__trading_settings.delay_start_after_open)
                    )

                    # Проверяем, не отключили ли счёт пока ждали
                    self.__overrides.maybe_reload()
                    enabled_ids = self.__overrides.enabled_account_ids()
                    if enabled_ids is not None and account.id not in enabled_ids:
                        logger.info(f"[{label}] Счёт отключён в оверрайдах, пропускаем торговый день")
                        await TradeService.__sleep_to_next_morning()
                        continue

                    logger.info(f"[{label}] Начинаем торговый день")

                    await Trader(
                        client_service=self.__client_service,
                        instrument_service=self.__instrument_service,
                        operation_service=self.__operation_service,
                        order_service=self.__order_service,
                        stream_service=self.__stream_service,
                        market_data_service=self.__market_data_service,
                        blogger=self.__blogger.with_label(label),
                        mega_alerts=self.__mega_alerts,
                        mega_alerts_settings=self.__mega_alerts_settings,
                        futures_trading_settings=self.__futures_trading_settings,
                        account_label=label,
                    ).trade_day(
                        account.id,
                        self.__trading_settings,
                        self.__strategies,
                        end_time,
                        self.__account_settings.min_rub_on_account
                    )

                    logger.info(f"[{label}] Торговый день завершён")
                else:
                    logger.info(f"[{label}] Не торговый день, ждём до утра")
            except Exception as ex:
                logger.error(f"[{label}] Ошибка в рабочем цикле: {repr(ex)}")
                self.__notifier.error(f"trade_service [{label}]", ex, capture_tb())

            await TradeService.__sleep_to_next_morning()

    @staticmethod
    async def __sleep_to_next_morning() -> None:
        future = datetime.datetime.utcnow() + datetime.timedelta(days=1)
        next_time = datetime.datetime(year=future.year, month=future.month, day=future.day,
                                      hour=6, minute=0, tzinfo=datetime.timezone.utc)
        await TradeService.__sleep_to(next_time)

    @staticmethod
    async def __sleep_to(next_time: datetime) -> None:
        now = datetime.datetime.utcnow().replace(tzinfo=datetime.timezone.utc)
        logger.debug(f"Ожидание с {now} до {next_time}")
        total_seconds = (next_time - now).total_seconds()
        if total_seconds > 0:
            await asyncio.sleep(total_seconds)
