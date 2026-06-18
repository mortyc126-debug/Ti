import asyncio
import logging
import os
import sys
from logging.handlers import RotatingFileHandler

from blog.blog_worker import BlogWorker
from blog.blogger import Blogger
from configuration.configuration import ProgramConfiguration
from invest_api.services.accounts_service import AccountService
from invest_api.services.client_service import ClientService
from invest_api.services.instruments_service import InstrumentService
from invest_api.services.market_data_service import MarketDataService
from invest_api.services.operations_service import OperationService
from invest_api.services.orders_service import OrderService
from invest_api.services.market_data_stream_service import MarketDataStreamService
from trade_system.strategies.strategy_factory import StrategyFactory
from trading.trade_service import TradeService
from news import NewsCollector

# the configuration file name
CONFIG_FILE = "settings.ini"

logger = logging.getLogger(__name__)


def _make_news_price_getter(instrument_service: InstrumentService, market_data_service: MarketDataService):
    """
    price_getter для NewsCollector: тикер -> текущая цена.
    FIGI резолвится через share_by_ticker и кэшируется (не дёргать API
    на каждую новость по уже известному тикеру).
    """
    from tinkoff.invest.utils import quotation_to_decimal

    figi_cache: dict[str, str] = {}

    def price_getter(ticker: str) -> float | None:
        figi = figi_cache.get(ticker)
        if figi is None:
            found = instrument_service.share_by_ticker(ticker)
            if found is None:
                return None
            _, figi = found
            figi_cache[ticker] = figi

        price = market_data_service.get_last_price(figi)
        return float(quotation_to_decimal(price)) if price is not None else None

    return price_getter


async def start_asyncio_trading(
    blog_worker_loop: BlogWorker,
    trade_service_loop: TradeService,
    news_collector: NewsCollector | None = None,
) -> None:
    # Some asyncio MAGIC for Windows OS
    if sys.version_info[0] == 3 and sys.version_info[1] >= 8 and sys.platform.startswith('win'):
        asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())

    logger.info("Start loop workers for trading")

    blog_task = asyncio.create_task(blog_worker_loop.worker())
    trade_task = asyncio.create_task(trade_service_loop.worker())
    news_task = asyncio.create_task(news_collector.run_forever()) if news_collector else None

    await blog_task
    await trade_task
    if news_task:
        await news_task


def prepare_logs() -> None:
    if not os.path.exists("logs/"):
        os.makedirs("logs/")

    logging.basicConfig(
        level=logging.DEBUG,
        format="%(asctime)s - %(module)s - %(levelname)s - %(funcName)s: %(lineno)d - %(message)s",
        handlers=[RotatingFileHandler('logs/robot.log', maxBytes=100000000, backupCount=10, encoding='utf-8')],
        encoding="utf-8"
    )


if __name__ == "__main__":
    prepare_logs()

    logger.info("Program start")

    try:
        config = ProgramConfiguration(CONFIG_FILE)
        logger.info("Configuration has been loaded")
    except Exception as ex:
        logger.critical("Load configuration error: %s", repr(ex))
    else:
        account_service = AccountService(config.tinkoff_token, config.tinkoff_app_name)
        client_service = ClientService(config.tinkoff_token, config.tinkoff_app_name)
        instrument_service = InstrumentService(config.tinkoff_token, config.tinkoff_app_name)
        operation_service = OperationService(config.tinkoff_token, config.tinkoff_app_name)
        order_service = OrderService(config.tinkoff_token, config.tinkoff_app_name)
        stream_service = MarketDataStreamService(config.tinkoff_token, config.tinkoff_app_name)
        market_data_service = MarketDataService(config.tinkoff_token, config.tinkoff_app_name)

        if account_service.verify_token():
            logger.info(f"Blog settings: {config.blog_settings}")

            trade_strategies = \
                [StrategyFactory.new_factory(x.name, x) for x in config.trade_strategy_settings]

            # Queue to keep messages for TG. TradeService(via Blogger) produce, BlogWorker consume (send)
            messages_queue = asyncio.Queue()

            blog_worker = BlogWorker(config.blog_settings, messages_queue)
            trade_service = TradeService(
                account_service=account_service,
                client_service=client_service,
                instrument_service=instrument_service,
                operation_service=operation_service,
                order_service=order_service,
                stream_service=stream_service,
                market_data_service=market_data_service,
                blogger=Blogger(config.blog_settings, config.trade_strategy_settings, messages_queue),
                account_settings=config.account_settings,
                trading_settings=config.trading_settings,
                strategies=trade_strategies,
                mega_alerts_settings=config.mega_alerts_settings
            )

            news_collector = NewsCollector(
                price_getter=_make_news_price_getter(instrument_service, market_data_service)
            )

            asyncio.run(start_asyncio_trading(blog_worker, trade_service, news_collector))

        else:
            logger.critical("Client verification has been failed")

    logger.info("Program end")
