import asyncio
import datetime
import logging

from blog.blogger import Blogger
from configuration.settings import AccountSettings, TradingSettings, BlogSettings, StrategySettings, \
    MegaAlertsSettings, FuturesTradingSettings
from invest_api.services.accounts_service import AccountService
from invest_api.services.client_service import ClientService
from invest_api.services.instruments_service import InstrumentService
from invest_api.services.market_data_service import MarketDataService
from invest_api.services.operations_service import OperationService
from invest_api.services.orders_service import OrderService
from invest_api.services.stop_orders_service import StopOrderService
from invest_api.services.market_data_stream_service import MarketDataStreamService
from mega_alerts import MegaAlertsService
from trade_system.strategies.base_strategy import IStrategy
from trading.trader import Trader, BotShutdownRequested
import runtime_overrides
import sandbox_monitor

# Между чанками длинного сна (ночь/выходные/ожидание открытия рынка) —
# проверка дашбордовского shutdown_requested. 30с — тот же порядок величины,
# что и мягкая остановка внутри торгового дня (флаг читается на каждой свече,
# т.е. ~раз в минуту), не нагружает диск (один stat/json.load раз в 30с).
SLEEP_CHECK_INTERVAL_SEC = 30

__all__ = ("TradeService")

logger = logging.getLogger(__name__)


class TradeService:
    """
    Represent logic keep trading going
    """
    def __init__(
            self,
            account_service: AccountService,
            client_service: ClientService,
            instrument_service: InstrumentService,
            operation_service: OperationService,
            order_service: OrderService,
            stop_order_service: StopOrderService,
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
        self.__stop_order_service = stop_order_service
        self.__stream_service = stream_service
        self.__market_data_service = market_data_service
        self.__blogger = blogger
        self.__account_settings = account_settings
        self.__trading_settings = trading_settings
        self.__strategies = strategies
        self.__mega_alerts_settings = mega_alerts_settings
        self.__futures_trading_settings = futures_trading_settings
        # Один инстанс и одна фоновая daily_loop-задача на весь процесс — раньше
        # MegaAlertsService создавался внутри Trader.__init__ и пересоздавался
        # каждый торговый день вместе с новым Trader; старая задача никогда не
        # отменялась (только oi_task/tradestats_task отменялись в trade_day's
        # finally) — за N дней работы накапливалось N "осиротевших" daily_loop,
        # каждый раз в сутки бьющих MOEX API и независимо пишущих в один и тот
        # же data/mega_alerts.json.
        self.__mega_alerts = MegaAlertsService()
        self.__mega_alerts_task: asyncio.Task | None = None
        self.__sandbox_monitor_task: asyncio.Task | None = None

    async def worker(self) -> None:
        self.__mega_alerts_task = asyncio.create_task(self.__mega_alerts.daily_loop())
        # Sandbox-монитор: периодически шлёт в Telegram статус virtual-портфеля.
        # При TINKOFF_SANDBOX=0 run_monitor() мгновенно выходит (no-op).
        self.__sandbox_monitor_task = asyncio.create_task(
            sandbox_monitor.run_monitor(
                self.__account_service._AccountService__token,
                self.__account_service._AccountService__app_name,
                self.__blogger._Blogger__messages_queue,
            )
        )
        try:
            try:
                logger.info("Finding account for trading")
                account_id = self.__account_service.trading_account_id(self.__account_settings)

                if not account_id:
                    logger.error("Account for trading hasn't been found")
                    return None

                logger.info(f"Account id: {account_id}")

            except Exception as ex:
                logger.error(f"Start trading error: {repr(ex)}")
                return None

            await self.__working_loop(account_id)
        finally:
            self.__mega_alerts_task.cancel()
            if self.__sandbox_monitor_task:
                self.__sandbox_monitor_task.cancel()

    async def __working_loop(self, account_id: str) -> None:
        logger.info("Start every day trading")

        while True:
            logger.info("Check trading schedule on today")

            try:
                is_trading_day, start_time, end_time = \
                    self.__instrument_service.moex_today_trading_schedule()
                # for tests purposes
                #is_trading_day, start_time, end_time = \
                #    True, \
                #    datetime.datetime.utcnow().replace(tzinfo=datetime.timezone.utc) + datetime.timedelta(seconds=10), \
                #    datetime.datetime.utcnow().replace(tzinfo=datetime.timezone.utc) + datetime.timedelta(minutes=12)

                if is_trading_day and datetime.datetime.utcnow().replace(tzinfo=datetime.timezone.utc) <= end_time:
                    logger.info(f"Today is trading day. Trading will start after {start_time}")

                    await TradeService.__sleep_to(
                        start_time + datetime.timedelta(seconds=self.__trading_settings.delay_start_after_open)
                    )

                    logger.info(f"Trading day has been started")

                    await Trader(
                        client_service=self.__client_service,
                        instrument_service=self.__instrument_service,
                        operation_service=self.__operation_service,
                        order_service=self.__order_service,
                        stop_order_service=self.__stop_order_service,
                        stream_service=self.__stream_service,
                        market_data_service=self.__market_data_service,
                        blogger=self.__blogger,
                        mega_alerts=self.__mega_alerts,
                        mega_alerts_settings=self.__mega_alerts_settings,
                        futures_trading_settings=self.__futures_trading_settings
                    ).trade_day(
                        account_id,
                        self.__trading_settings,
                        self.__strategies,
                        end_time,
                        self.__account_settings.min_rub_on_account
                    )

                    logger.info("Trading day has been completed")
                else:
                    logger.info("Today is not trading day. Sleep on next morning")
            except BotShutdownRequested:
                logger.info("Остановка с дашборда: завершаю __working_loop")
                return
            except Exception as ex:
                logger.error(f"Start trading today error: {repr(ex)}")

            # Отдельный try: ночной сон должен произойти в ЛЮБОМ случае выше
            # (успех, "не торговый день" или обычная ошибка) — иначе после
            # Exception цикл тут же вернётся к проверке расписания без паузы
            # (риск горячего цикла ретраев при устойчивой ошибке API/сети).
            # BotShutdownRequested здесь ловится отдельно, а не общим except
            # Exception выше — иначе он ушёл бы в лог как обычная ошибка вместо
            # чистой остановки.
            try:
                logger.info("Sleep to next morning")
                await TradeService.__sleep_to_next_morning()
            except BotShutdownRequested:
                logger.info("Остановка с дашборда: завершаю __working_loop (во время ночного сна)")
                return

    @staticmethod
    async def __sleep_to_next_morning() -> None:
        future = datetime.datetime.utcnow() + datetime.timedelta(days=1)
        next_time = datetime.datetime(year=future.year, month=future.month, day=future.day,
                                      hour=6, minute=0, tzinfo=datetime.timezone.utc)

        await TradeService.__sleep_to(next_time)

    @staticmethod
    async def __sleep_to(next_time: datetime) -> None:
        """Чанкованный сон вместо одного долгого asyncio.sleep — иначе
        мягкая остановка с дашборда (bot_supervisor.stop_bot →
        shutdown_requested) не работала здесь вообще: Trader.pop_shutdown_
        requested() проверяется только внутри __trading (на свечах активной
        торговой сессии), а этот сон покрывает и ночь/выходные (до ~60ч), и
        ожидание открытия рынка внутри торгового дня — раньше в оба окна
        флаг с дашборда игнорировался, единственным способом остановить
        бота там был force_kill (SIGKILL/taskkill)."""
        now = datetime.datetime.utcnow().replace(tzinfo=datetime.timezone.utc)

        logger.debug(f"Sleep from {now} to {next_time}")
        total_seconds = (next_time - now).total_seconds()

        while total_seconds > 0:
            chunk = min(total_seconds, SLEEP_CHECK_INTERVAL_SEC)
            await asyncio.sleep(chunk)
            total_seconds -= chunk

            data = runtime_overrides.load_overrides()
            if data.get("shutdown_requested"):
                data["shutdown_requested"] = False
                runtime_overrides.save_overrides(data)
                logger.info("Остановка с дашборда: обнаружена во время сна (ночь/выходные/ожидание открытия)")
                raise BotShutdownRequested()
