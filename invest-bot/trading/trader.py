import asyncio
import datetime
import logging
import os
from collections import deque
from decimal import Decimal

from tinkoff.invest import Candle, OrderExecutionReportStatus
from tinkoff.invest.utils import quotation_to_decimal

from blog.blogger import Blogger
from invest_api.services.client_service import ClientService
from invest_api.services.instruments_service import InstrumentService
from invest_api.services.market_data_service import MarketDataService
from invest_api.services.operations_service import OperationService
from invest_api.services.orders_service import OrderService
from invest_api.services.market_data_stream_service import MarketDataStreamService
from invest_api.utils import candle_to_historiccandle
from trade_system.signal import SignalType
from trade_system.strategies.base_strategy import IStrategy
from trading.trade_results import TradeResults
from configuration.settings import TradingSettings, MegaAlertsSettings, StrategySettings, FuturesTradingSettings
from trade_system.strategies.strategy_factory import StrategyFactory
from risk import RiskManager
from oi_layers import OiLayersService
from tradestats import TradeStatsService
from mega_alerts import MegaAlertsService
from archive import ArchiveStore
from db_api_client import DbApiClient

__all__ = ("Trader")

logger = logging.getLogger(__name__)

# Адаптивный выход (risk.check_exit: трейлинг Chandelier + squeeze-протекция)
# — один из РЕЖИМОВ работы, не замена фиксированного стоп/тейк сигнала
# стратегии. По умолчанию выключен, чтобы не менять текущее поведение.
ADAPTIVE_EXIT_ENABLED = os.getenv("ADAPTIVE_EXIT", "0") == "1"


class Trader:
    """
    The class encapsulate main trade logic.
    """

    def __init__(
            self,
            client_service: ClientService,
            instrument_service: InstrumentService,
            operation_service: OperationService,
            order_service: OrderService,
            stream_service: MarketDataStreamService,
            market_data_service: MarketDataService,
            blogger: Blogger,
            mega_alerts_settings: MegaAlertsSettings = MegaAlertsSettings(),
            futures_trading_settings: FuturesTradingSettings = FuturesTradingSettings()
    ) -> None:
        self.__today_trade_results: TradeResults = None
        self.__client_service = client_service
        self.__instrument_service = instrument_service
        self.__operation_service = operation_service
        self.__order_service = order_service
        self.__stream_service = stream_service
        self.__market_data_service = market_data_service
        self.__blogger = blogger
        self.__mega_alerts_settings = mega_alerts_settings
        self.__futures_trading_settings = futures_trading_settings
        self.__risk = RiskManager()
        self.__last_prices: dict[str, float] = {}
        self.__oi_layers = OiLayersService(price_getter=lambda t: self.__last_prices.get(t))
        self.__oi_task: asyncio.Task | None = None
        self.__tradestats = TradeStatsService()
        self.__tradestats_task: asyncio.Task | None = None
        self.__mega_alerts = MegaAlertsService()
        self.__mega_alerts_task: asyncio.Task | None = None
        self.__archive = ArchiveStore()
        self.__trading_settings: TradingSettings = TradingSettings()
        # Объёмы последних закрытых свечей по тикеру — основа для оценки
        # размера позиции по ликвидности (см. __liquidity_lots_cap).
        self.__candle_volumes: dict[str, deque] = {}

    async def trade_day(
            self,
            account_id: str,
            trading_settings: TradingSettings,
            strategies: list[IStrategy],
            trade_day_end_time: datetime,
            min_rub: int
    ) -> None:
        logger.info("Start preparations for trading today")
        self.__trading_settings = trading_settings
        today_trade_strategies = self.__get_today_strategies(strategies)
        if not today_trade_strategies:
            logger.info("No shares to trade today.")
            return None

        self.__risk.equity_getter = lambda: float(self.__operation_service.available_rub_on_account(account_id) or 0)

        configured_tickers = [s.settings.ticker for s in today_trade_strategies.values()]
        if self.__mega_alerts_task is None:
            # MEGA-ALERTS живёт дольше одного торгового дня — обновляется
            # раз в сутки по ВСЕМУ рынку, не только по сегодняшним тикерам.
            self.__mega_alerts_task = asyncio.create_task(self.__mega_alerts.daily_loop())
        await self.__mega_alerts.refresh_once()
        tracked_hits = [t for t in configured_tickers if self.__mega_alerts.alerts_for(t)]
        candidate_tickers = [t for t in self.__mega_alerts.tickers_today("eq") if t not in configured_tickers]

        added_strategies: dict[str, IStrategy] = {}
        if self.__mega_alerts_settings.auto_trade and candidate_tickers:
            dynamic_strategies = self.__build_dynamic_strategies(candidate_tickers)
            if dynamic_strategies:
                added_strategies = self.__get_today_strategies(dynamic_strategies)
                today_trade_strategies.update(added_strategies)
                logger.info(
                    f"MEGA-ALERTS: добавлены в торговлю на сегодня "
                    f"{[s.settings.ticker for s in added_strategies.values()]}"
                )
        if self.__futures_trading_settings.enabled and self.__futures_trading_settings.base_tickers:
            futures_strategies = self.__build_futures_strategies(
                today_trade_strategies, self.__futures_trading_settings.base_tickers
            )
            if futures_strategies:
                added_futures = self.__get_today_strategies(futures_strategies)
                today_trade_strategies.update(added_futures)
                logger.info(
                    f"FUTURES: добавлены в торговлю на сегодня "
                    f"{[s.settings.ticker for s in added_futures.values()]}"
                )

        self.__blogger.mega_alerts_message(
            tracked_hits, [t for t in candidate_tickers if t not in [s.settings.ticker for s in added_strategies.values()]]
        )

        self.__clear_all_positions(account_id, today_trade_strategies)

        tracked_tickers = [s.settings.ticker for s in today_trade_strategies.values()]
        self.__oi_task = asyncio.create_task(self.__oi_layers.poll_loop(tracked_tickers))
        self.__tradestats_task = asyncio.create_task(self.__tradestats.poll_loop(tracked_tickers))

        for strategy in today_trade_strategies.values():
            if hasattr(strategy, "set_squeeze_provider"):
                strategy.set_squeeze_provider(self.__oi_layers.squeeze_score)
            if hasattr(strategy, "set_inst_oi_provider"):
                strategy.set_inst_oi_provider(self.__oi_layers.inst_oi_score)
            if hasattr(strategy, "set_retail_contra_provider"):
                strategy.set_retail_contra_provider(self.__oi_layers.retail_contra_score)
            if hasattr(strategy, "set_tradestats_provider"):
                strategy.set_tradestats_provider(self.__tradestats.score)

        rub_before_trade_day = self.__operation_service.available_rub_on_account(account_id)
        logger.info(f"Amount of RUB on account {rub_before_trade_day} and minimum for trading: {min_rub}")
        if rub_before_trade_day < min_rub:
            return None

        logger.info("Start trading today")
        self.__blogger.start_trading_message(today_trade_strategies, rub_before_trade_day)

        try:
            await self.__trading(
                account_id,
                trading_settings,
                today_trade_strategies,
                trade_day_end_time
            )
            logger.debug("Test Results:")
            logger.debug(f"Current: {self.__today_trade_results.get_current_open_orders()}")
            logger.debug(f"Old: {self.__today_trade_results.get_closed_orders()}")
        except Exception as ex:
            logger.error(f"Trading error: {repr(ex)}")
        finally:
            await self.__cancel_task(self.__oi_task)
            self.__oi_task = None
            await self.__cancel_task(self.__tradestats_task)
            self.__tradestats_task = None

        self.__archive_today(today_trade_strategies)

        logger.info("Finishing trading today")
        self.__blogger.finish_trading_message()

        try:
            if self.__today_trade_results:
                for key_figi, value_order_id in self.__clear_all_positions(account_id, today_trade_strategies).items():
                    trade_order = self.__today_trade_results.close_position(key_figi, value_order_id)
                    self.__blogger.close_position_message(trade_order)
            else:
                self.__clear_all_positions(account_id, today_trade_strategies)
        except Exception as ex:
            logger.error(f"Finishing trading error: {repr(ex)}")

        logger.info("Show trade results today")
        try:
            self.__summary_today_trade_results(account_id, rub_before_trade_day)
        except Exception as ex:
            logger.error(f"Summary trading day error: {repr(ex)}")

    async def __trading(
            self,
            account_id: str,
            trading_settings: TradingSettings,
            strategies: dict[str, IStrategy],
            trade_day_end_time: datetime
    ) -> None:
        logger.info(f"Subscribe and read Candles for {strategies.keys()}")

        # End trading before close trade session
        trade_before_time: datetime = \
            trade_day_end_time - datetime.timedelta(seconds=trading_settings.stop_trade_before_close)

        signals_before_time: datetime = \
            trade_day_end_time - datetime.timedelta(minutes=trading_settings.stop_signals_before_close)
        logger.debug(f"Stop time: signals - {signals_before_time}, trading - {trade_before_time}")

        current_candles: dict[str, Candle] = dict()
        self.__today_trade_results = TradeResults()

        async for candle in self.__stream_service.start_async_candles_stream(
                list(strategies.keys()),
                trade_before_time
        ):
            current_figi_candle = current_candles.setdefault(candle.figi, candle)
            if candle.time < current_figi_candle.time:
                # it happens (based on API documentation)
                logger.debug("Skip candle from past.")
                continue

            self.__last_prices[strategies[candle.figi].settings.ticker] = float(quotation_to_decimal(candle.close))

            # check price from candle for take or stop price levels
            current_trade_order = self.__today_trade_results.get_current_trade_order(candle.figi)
            if current_trade_order:
                high, low = quotation_to_decimal(candle.high), quotation_to_decimal(candle.low)

                # Logic is:
                # if stop or take price level is between high and low, then stop or take will be executed
                try:
                    if ADAPTIVE_EXIT_ENABLED:
                        # Адаптивный выход — единственная логика закрытия позиции:
                        # фиксированные stop/take из сигнала игнорируются, чтобы
                        # трейлинг-стоп мог двигаться и забирать большее движение,
                        # а не закрываться по первому касанию исходного take_profit.
                        self.__check_adaptive_exit(account_id, candle, strategies)
                    elif low <= current_trade_order.signal.stop_loss_level <= high:
                        logger.info(f"STOP LOSS: {current_trade_order}")
                        self.__risk_close(strategies[candle.figi], float(current_trade_order.signal.stop_loss_level), "stop_loss")
                        self.__close_position_and_send_message(account_id, candle.figi, strategies)

                    elif low <= current_trade_order.signal.take_profit_level <= high:
                        logger.info(f"TAKE PROFIT: {current_trade_order}")
                        self.__risk_close(strategies[candle.figi], float(current_trade_order.signal.take_profit_level), "take_profit")
                        self.__close_position_and_send_message(account_id, candle.figi, strategies)
                except Exception as ex:
                    logger.error(f"Error check Stop loss and Take profit levels: {repr(ex)}")

            if candle.time > current_figi_candle.time:
                self.__candle_volumes.setdefault(candle.figi, deque(maxlen=20)).append(current_figi_candle.volume)

            if candle.time > current_figi_candle.time and \
                    datetime.datetime.utcnow().replace(tzinfo=datetime.timezone.utc) <= signals_before_time:
                signal_new = strategies[candle.figi].analyze_candles(
                    [candle_to_historiccandle(current_figi_candle)]
                )

                if signal_new:
                    logger.info(f"New signal: {signal_new}")

                    try:
                        if signal_new.signal_type == SignalType.CLOSE:
                            if current_trade_order:
                                logger.info(f"Close position by close signal: {current_trade_order}")
                                self.__risk_close(strategies[candle.figi], float(quotation_to_decimal(candle.close)), "close_signal")
                                self.__close_position_and_send_message(account_id, candle.figi, strategies)
                            else:
                                logger.info(f"New signal has been skipped. No open position to close.")

                        elif current_trade_order:
                            logger.info(f"New signal has been skipped. Previous signal is still alive.")

                        elif not self.__market_data_service.is_stock_ready_for_trading(candle.figi):
                            logger.info(f"New signal has been skipped. Stock isn't ready for trading")

                        else:
                            strategy = strategies[candle.figi]
                            # signal_only = только Telegram, без реального ордера
                            is_signal_only = getattr(strategy, 'signal_only', False)

                            if is_signal_only:
                                logger.info(f"SIGNAL ONLY mode: {signal_new} (no order placed)")
                                self.__blogger.open_position_message(
                                    self.__today_trade_results.open_position(
                                        candle.figi, "signal_only", signal_new
                                    )
                                )
                            else:
                                risk_ticker = strategy.settings.ticker
                                direction = "long" if signal_new.signal_type == SignalType.LONG else "short"
                                confidence = getattr(strategy, 'confidence', 0.7)

                                risk_ok, risk_why = self.__risk.can_open(risk_ticker, direction, confidence)
                                if not risk_ok:
                                    logger.info(f"New signal has been skipped. Risk gate: {risk_why}")
                                    current_candles[candle.figi] = candle
                                    continue

                                entry_price = float(quotation_to_decimal(candle.close))
                                stop_price = float(signal_new.stop_loss_level)
                                risk_qty, risk_size_why = self.__risk.position_size(
                                    entry_price, stop_price,
                                    point_value=strategy.settings.point_value,
                                    lot=strategy.settings.lot_size, confidence=confidence
                                )
                                logger.debug(f"Risk position_size: {risk_size_why}")

                                cash_lots = self.__open_position_lots_count(
                                    account_id,
                                    strategy.settings.max_lots_per_order,
                                    quotation_to_decimal(candle.close),
                                    strategy.settings.lot_size,
                                    margin_per_lot=Decimal(str(strategy.settings.margin_per_lot))
                                    if strategy.settings.is_future else None
                                )
                                liquidity_lots = self.__liquidity_lots_cap(candle.figi, strategy.settings.lot_size)
                                available_lots = min(cash_lots, risk_qty, liquidity_lots) if risk_qty > 0 else 0

                                logger.debug(
                                    f"Available lots: {available_lots} "
                                    f"(cash={cash_lots}, risk={risk_qty}, liquidity={liquidity_lots})"
                                )
                                if available_lots > 0:
                                    open_order_id, actual_lots = await self.__smart_order(
                                        account_id=account_id,
                                        figi=candle.figi,
                                        count_lots=available_lots,
                                        is_buy=(signal_new.signal_type == SignalType.LONG),
                                        last_price=float(quotation_to_decimal(candle.close)),
                                        strategy=strategy
                                    )
                                    if open_order_id and actual_lots > 0:
                                        if actual_lots < available_lots:
                                            logger.warning(
                                                f"PARTIAL FILL {risk_ticker}: "
                                                f"запрошено {available_lots}, исполнено {actual_lots}"
                                            )
                                        open_position = self.__today_trade_results.open_position(
                                            candle.figi,
                                            open_order_id,
                                            signal_new
                                        )
                                        self.__risk.open_position(
                                            risk_ticker, direction, actual_lots,
                                            entry_price, stop_price,
                                            point_value=strategy.settings.point_value,
                                            confidence=confidence
                                        )
                                        self.__blogger.open_position_message(open_position)
                                        logger.info(f"Open position: {open_position}")
                                    else:
                                        logger.warning(f"Open order REJECTED/FAILED для {risk_ticker}")
                                else:
                                    logger.info(f"New signal has been skipped. No available money or risk budget")
                    except Exception as ex:
                        logger.error(f"Error open new position by new signal: {repr(ex)}")

            current_candles[candle.figi] = candle

        logger.info("Today trading has been completed")

    def __summary_today_trade_results(
            self,
            account_id: str,
            rub_before_trade_day: Decimal
    ) -> None:
        logger.info("Today trading summary:")
        self.__blogger.summary_message()

        current_rub_on_depo = self.__operation_service.available_rub_on_account(account_id)
        logger.info(f"RUBs on account before:{rub_before_trade_day}, after:{current_rub_on_depo}")

        today_profit = current_rub_on_depo - rub_before_trade_day
        today_percent_profit = (today_profit / rub_before_trade_day) * 100
        logger.info(f"Today Profit:{today_profit} rub ({today_percent_profit} %)")
        self.__blogger.trading_depo_summary_message(rub_before_trade_day, current_rub_on_depo)

        if self.__today_trade_results:
            logger.info(f"Today Open Signals:")
            for figi_key, trade_order_value in self.__today_trade_results.get_current_open_orders().items():
                logger.info(f"Stock: {figi_key}")

                open_order_state = self.__order_service.get_order_state(account_id, trade_order_value.open_order_id)
                logger.info(f"Signal {trade_order_value.signal}")
                logger.info(f"Open: {open_order_state}")
                self.__blogger.summary_open_signal_message(trade_order_value, open_order_state)

            logger.info(f"All open positions should be closed manually.")

            logger.info(f"Today Closed Signals:")
            for figi_key, trade_orders_value in self.__today_trade_results.get_closed_orders().items():
                logger.info(f"Stock: {figi_key}")
                for trade_order in trade_orders_value:
                    open_order_state = self.__order_service.get_order_state(account_id, trade_order.open_order_id)
                    close_order_state = self.__order_service.get_order_state(account_id, trade_order.close_order_id)
                    logger.info(f"Signal {trade_order.signal}")
                    logger.info(f"Open: {open_order_state}")
                    logger.info(f"Close: {close_order_state}")
                    self.__blogger.summary_closed_signal_message(trade_order, open_order_state, close_order_state)
        else:
            logger.info(f"Something went wrong: today trade results is empty")
            logger.info(f"All open positions should be closed manually.")
            self.__blogger.fail_message()

        self.__blogger.final_message()

    def __open_position_lots_count(
            self,
            account_id: str,
            max_lots_per_order: int,
            price: Decimal,
            share_lot_size: int,
            margin_per_lot: Decimal | None = None
    ) -> int:
        """
        Calculate counts of lots for order.

        Для акций стоимость лота — price*lot_size (полная оплата). Для
        фьючерсов (margin_per_lot задан) — это в разы меньше: реальная
        стоимость владения одним лотом — ГО (гарантийное обеспечение),
        а не полная номинальная стоимость контракта.
        """
        current_rub_on_depo = self.__operation_service.available_rub_on_account(account_id)

        cost_per_lot = margin_per_lot if margin_per_lot and margin_per_lot > 0 else (share_lot_size * price)
        available_lots = int(current_rub_on_depo / cost_per_lot)

        return available_lots if max_lots_per_order > available_lots else max_lots_per_order

    def __liquidity_lots_cap(self, figi: str, share_lot_size: int) -> int:
        """
        Ограничивает размер ордера долей среднего объёма последних закрытых
        свечей по тикеру (MAX_VOLUME_PARTICIPATION), чтобы не выставлять
        ордер, который рынок не может спокойно поглотить (неликвид —
        проскальзывание, частичное исполнение). Пока истории свечей по
        тикеру нет (старт дня) — не ограничивает.
        """
        volumes = self.__candle_volumes.get(figi)
        if not volumes:
            return 10 ** 9

        avg_volume = sum(volumes) / len(volumes)
        cap_in_shares = avg_volume * self.__trading_settings.max_volume_participation
        return max(1, int(cap_in_shares / share_lot_size))

    async def __smart_order(
            self,
            account_id: str,
            figi: str,
            count_lots: int,
            is_buy: bool,
            last_price: float,
            strategy: IStrategy
    ) -> tuple[str | None, int]:
        """
        Лимитная заявка с авто-репрайсингом и переходом на рыночную.
        Возвращает (order_id, actual_lots) при успешном исполнении или (None, 0).

        Логика:
        1. Выставить лимит на уровне last_price.
        2. Каждые 5 сек проверять статус заявки.
        3. Если цена ушла против нас более чем на adverse_pct — немедленно
           переходим на рынок (хуже будет ещё больше).
        4. Если прошёл reprice_interval и заявка не исполнена — отменяем,
           переставляем на текущую цену (до max_attempts раз).
        5. После всех попыток — рыночная заявка.
        """
        ts = self.__trading_settings
        ticker = strategy.settings.ticker
        poll_interval = 5  # секунды между опросами состояния

        def _adverse(current: float) -> bool:
            if last_price == 0:
                return False
            move = (current - last_price) / last_price
            # Для покупки плохо когда цена выросла (платим дороже),
            # для продажи — когда упала.
            return (is_buy and move > ts.limit_adverse_move_pct) or \
                   (not is_buy and move < -ts.limit_adverse_move_pct)

        def _place_limit(price: float) -> tuple[str | None, object]:
            try:
                p = Decimal(str(price))
                resp = self.__order_service.post_limit_order(
                    account_id=account_id, figi=figi,
                    count_lots=count_lots, is_buy=is_buy, price=p
                )
                return resp.order_id, resp
            except Exception as ex:
                logger.warning(f"__smart_order place limit failed: {repr(ex)}")
                return None, None

        def _to_market() -> tuple[str | None, int]:
            try:
                resp = self.__order_service.post_market_order(
                    account_id=account_id, figi=figi,
                    count_lots=count_lots, is_buy=is_buy
                )
                if resp.execution_report_status in (
                    OrderExecutionReportStatus.EXECUTION_REPORT_STATUS_FILL,
                    OrderExecutionReportStatus.EXECUTION_REPORT_STATUS_PARTIALLYFILL,
                ):
                    try:
                        state = self.__order_service.get_order_state(account_id, resp.order_id)
                        return resp.order_id, state.lots_executed or count_lots
                    except Exception:
                        return resp.order_id, count_lots
                logger.warning(f"__smart_order market fallback REJECTED: {resp}")
                return None, 0
            except Exception as ex:
                logger.warning(f"__smart_order market fallback error: {repr(ex)}")
                return None, 0

        def _cancel(order_id: str) -> None:
            try:
                self.__order_service.cancel_order(account_id, order_id)
            except Exception:
                pass

        entry_price = last_price
        order_id, _ = _place_limit(entry_price)
        if order_id is None:
            logger.warning(f"__smart_order: limit place failed, falling back to market")
            return _to_market()

        elapsed_since_reprice = 0
        attempt = 0

        while True:
            await asyncio.sleep(poll_interval)
            elapsed_since_reprice += poll_interval

            # Проверяем статус
            try:
                state = self.__order_service.get_order_state(account_id, order_id)
            except Exception as ex:
                logger.warning(f"__smart_order get_order_state error: {repr(ex)}")
                break

            if state.execution_report_status == OrderExecutionReportStatus.EXECUTION_REPORT_STATUS_FILL:
                return order_id, state.lots_executed or count_lots

            if state.execution_report_status == OrderExecutionReportStatus.EXECUTION_REPORT_STATUS_PARTIALLYFILL:
                # Частичное — продолжаем ждать, но не бесконечно
                pass

            if state.execution_report_status in (
                OrderExecutionReportStatus.EXECUTION_REPORT_STATUS_REJECTED,
                OrderExecutionReportStatus.EXECUTION_REPORT_STATUS_CANCELLED,
            ):
                logger.warning(f"__smart_order: заявка {order_id} отклонена/отменена, рынок")
                return _to_market()

            # Проверяем неблагоприятное движение цены
            current_price = self.__last_prices.get(ticker, entry_price)
            if _adverse(current_price):
                logger.info(
                    f"__smart_order {ticker}: неблагоприятное движение "
                    f"{entry_price:.4f}->{current_price:.4f}, переход на рынок"
                )
                _cancel(order_id)
                return _to_market()

            # Репрайс по таймеру
            if elapsed_since_reprice >= ts.limit_reprice_interval_sec:
                elapsed_since_reprice = 0
                attempt += 1
                if attempt > ts.limit_reprice_max_attempts:
                    logger.info(f"__smart_order {ticker}: исчерпаны попытки репрайса, рынок")
                    _cancel(order_id)
                    return _to_market()

                _cancel(order_id)
                entry_price = current_price
                order_id, _ = _place_limit(entry_price)
                if order_id is None:
                    return _to_market()
                logger.info(f"__smart_order {ticker}: репрайс #{attempt} на {entry_price:.4f}")

        # Нештатный выход из цикла — рынок
        _cancel(order_id)
        return _to_market()

    def __clear_all_positions(
            self,
            account_id: str,
            strategies: dict[str, IStrategy]
    ) -> dict[str, str]:
        logger.info("Clear all orders and close all open positions")

        logger.debug("Cancel all order.")
        self.__client_service.cancel_all_orders(account_id)

        logger.debug("Close all positions.")
        # Снимаем с учёта risk.py то, что осталось открытым к концу дня. Точная
        # цена выхода здесь неизвестна (как и в остальном коде — closing order
        # тоже не хранит цену исполнения), поэтому approx = entry_price
        # (нейтральный pnl, не искажает день вверх/вниз).
        for strategy in strategies.values():
            risk_ticker = strategy.settings.ticker
            pos = self.__risk.positions.get(risk_ticker)
            if pos:
                self.__risk.close_position(
                    risk_ticker, pos.entry_price,
                    point_value=strategy.settings.point_value, reason="eod_clear")

        result = self.__close_position_by_figi(account_id, strategies.keys(), strategies)

        # Если какая-то позиция не закрылась (halt, rejected) — уведомляем
        by_figi = {s.settings.figi: s for s in strategies.values()}
        for figi, strategy in by_figi.items():
            if figi not in result:
                # Проверяем, есть ли реально позиция на бирже
                all_pos = list(self.__operation_service.positions_securities(account_id) or []) + \
                          list(self.__operation_service.positions_futures(account_id) or [])
                still_open = [p for p in all_pos if p.figi == figi and p.balance != 0]
                if still_open:
                    logger.error(
                        f"EOD ALERT: позиция {strategy.settings.ticker} ({figi}) "
                        f"НЕ ЗАКРЫТА (halt/rejected). Баланс={still_open[0].balance}. "
                        f"Требуется ручное закрытие!"
                    )
                    self.__blogger.fail_message()
        return result

    def __risk_close(self, strategy: IStrategy, price: float, reason: str) -> None:
        """Снять позицию из risk.py при выходе по стопу/тейку/close-сигналу."""
        risk_ticker = strategy.settings.ticker
        if risk_ticker in self.__risk.positions:
            self.__risk.close_position(
                risk_ticker, price, point_value=strategy.settings.point_value, reason=reason)

    def __check_adaptive_exit(
            self,
            account_id: str,
            candle: Candle,
            strategies: dict[str, IStrategy]
    ) -> None:
        """
        Режим ADAPTIVE_EXIT=1: для ВСЕХ открытых позиций вместо фиксированных
        stop_loss_level/take_profit_level из сигнала — risk.check_exit
        (трейлинг Chandelier + безубыток после 1R + giveback-защита пика),
        плюс для шортов — доп. squeeze-протекция по реальному squeeze_score
        из oi_layers.py (не статичный порог, а недавнее крупное наращивание
        стороны, которое сейчас в минусе по цене).
        """
        strategy = strategies[candle.figi]
        risk_ticker = strategy.settings.ticker
        pos = self.__risk.positions.get(risk_ticker)
        if not pos:
            return

        price = float(quotation_to_decimal(candle.close))
        squeeze = self.__oi_layers.is_squeeze_risk(risk_ticker, pos.direction)
        should_close, reason = self.__risk.check_exit(risk_ticker, price, squeeze=squeeze)
        if should_close:
            logger.info(f"ADAPTIVE EXIT {risk_ticker}: {reason}")
            self.__risk_close(strategy, price, reason)
            self.__close_position_and_send_message(account_id, candle.figi, strategies)

    def __close_position_and_send_message(
            self,
            account_id: str,
            figi: str,
            strategies: dict[str, IStrategy]
    ) -> None:
        close_order_id = self.__close_position_by_figi(account_id, [figi], strategies).get(figi, None)
        if close_order_id:
            trade_order = self.__today_trade_results.close_position(figi, close_order_id)
            self.__blogger.close_position_message(trade_order)

    def __close_position_by_figi(
            self,
            account_id: str,
            figies: list[str],
            strategies: dict[str, IStrategy]
    ) -> dict[str, str]:
        result: dict[str, str] = dict()
        # Tinkoff API держит фьючерсные позиции отдельно от securities — без
        # этого объединения открытые фьючерсы никогда бы не закрылись в конце дня.
        current_positions = list(self.__operation_service.positions_securities(account_id) or []) + \
            list(self.__operation_service.positions_futures(account_id) or [])

        if current_positions:
            logger.info(f"Current positions: {current_positions}")
            for position in current_positions:
                if position.figi in figies:
                    # Check a stock
                    if self.__market_data_service.is_stock_ready_for_trading(position.figi):
                        close_order = self.__order_service.post_market_order(
                            account_id=account_id,
                            figi=position.figi,
                            count_lots=abs(int(position.balance / strategies[position.figi].settings.lot_size)),
                            is_buy=(position.balance < 0)
                        )
                        if close_order.execution_report_status == OrderExecutionReportStatus.EXECUTION_REPORT_STATUS_FILL or \
                                close_order.execution_report_status == OrderExecutionReportStatus.EXECUTION_REPORT_STATUS_PARTIALLYFILL:
                            result[position.figi] = close_order.order_id
                            # Уведомляем стратегию о закрытии — обновляет EWA-веса по факту
                            strategy = strategies.get(position.figi)
                            if strategy and hasattr(strategy, "notify_position_closed"):
                                close_price = float(quotation_to_decimal(candle.close)) \
                                    if hasattr(self, "_last_close_price") else 0.0
                                last_price = self.__last_prices.get(strategy.settings.ticker, 0.0)
                                strategy.notify_position_closed(last_price or close_price)
                        else:
                            logger.warning(f"Close order REJECTED/FAILED: {close_order}")
        return result

    def __archive_today(self, today_trade_strategies: dict[str, IStrategy]) -> None:
        """
        Конец торгового дня — кладём в data/archive.json (archive.py) итоговый
        снэпшок композита по каждому тикеру, который сегодня считался, не
        только по тем, что реально торговались. Это и есть "база данных" с
        расчётами, а не только живая память процесса. Дополнительно, если
        настроена общая база (DB_API), отправляем тот же снэпшок туда —
        чтобы collector_worker.py и этот бот писали в одно общее хранилище.
        """
        db = DbApiClient(self.__mega_alerts_settings.db_api_url, self.__mega_alerts_settings.db_api_key)
        today = datetime.datetime.now(datetime.timezone.utc).date().isoformat()
        for strategy in today_trade_strategies.values():
            if not hasattr(strategy, "last_snapshot"):
                continue
            snapshot = strategy.last_snapshot()
            if not snapshot.get("scores"):
                continue
            if hasattr(strategy, "is_signal_only"):
                signal_only = strategy.is_signal_only()
            else:
                signal_only = str(getattr(strategy.settings, "settings", {}).get("SIGNAL_ONLY", "1")) == "1"
            self.__archive.record(
                strategy.settings.ticker,
                composite=snapshot["composite"],
                scores=snapshot["scores"],
                regime=snapshot["regime"],
                rolling_quality=snapshot["rolling_quality"],
                live=not signal_only
            )
            if db.configured:
                db.push_snapshot(
                    strategy.settings.ticker,
                    date=today,
                    composite=snapshot["composite"],
                    scores=snapshot["scores"],
                    regime=snapshot["regime"],
                    rolling_quality=snapshot["rolling_quality"],
                    live=not signal_only
                )

    def __build_dynamic_strategies(self, tickers: list[str]) -> list[IStrategy]:
        """
        Создаёт OICompositeStrategy на лету для тикеров, которые сегодня
        отметил MOEX MEGA-ALERTS, но которых нет в settings.ini. Параметры —
        дефолтные из [MEGA_ALERTS] (тот же шаблон, что у сконфигурированных
        тикеров). Список не сохраняется на диск — пересобирается каждый
        торговый день из текущего срез аномалий (расчёты — в data/archive.json).

        Перед включением реальной торговли: сначала спрашиваем общую базу
        расчётов (DB_API, Cloudflare D1) — если там уже есть свежий (за
        сегодня) бэктест по тикеру от collector_worker.py, используем его
        качество напрямую, не считая всё заново. Если в базе нет свежих
        данных — достраиваем недостающее сами: запрашиваем историю свечей
        (HISTORY_DAYS дней), прогреваем стратегию ей же (warmup) и считаем
        backtest_quality локально. В обоих случаях: если на истории
        >= BACKTEST_MIN_TRADES виртуальных сделок с quality >=
        BACKTEST_QUALITY_MIN, разрешаем реальные ордера (SIGNAL_ONLY=0),
        иначе тикер только шлёт сигналы.
        """
        cfg = self.__mega_alerts_settings
        db = DbApiClient(cfg.db_api_url, cfg.db_api_key)
        today = datetime.datetime.now(datetime.timezone.utc).date().isoformat()
        result: list[IStrategy] = []
        for ticker in tickers[:cfg.max_tickers]:
            resolved = self.__instrument_service.share_by_ticker(ticker)
            if not resolved:
                logger.debug(f"MEGA-ALERTS: не удалось определить figi для {ticker}, пропуск")
                continue
            share_settings, figi = resolved
            settings = StrategySettings(
                name="OICompositeStrategy",
                figi=figi,
                ticker=ticker,
                max_lots_per_order=cfg.max_lots_per_order,
                settings={
                    "SIGNAL_THRESHOLD": cfg.signal_threshold,
                    "LONG_TAKE": cfg.long_take,
                    "LONG_STOP": cfg.long_stop,
                    "SHORT_TAKE": cfg.short_take,
                    "SHORT_STOP": cfg.short_stop,
                    "SIGNAL_ONLY": cfg.signal_only,
                },
                lot_size=share_settings.lot,
                short_enabled_flag=share_settings.short_enabled_flag
            )
            strategy = StrategyFactory.new_factory("OICompositeStrategy", settings)
            if not strategy:
                continue

            try:
                candles = self.__market_data_service.get_candles_history(figi, days=cfg.history_days)
            except Exception as ex:
                logger.warning(f"MEGA-ALERTS: история свечей {ticker} не получена: {repr(ex)}")
                candles = []

            if candles and hasattr(strategy, "warmup"):
                strategy.warmup(candles)

            db_snapshot = db.latest(ticker) if db.configured else None
            from_db = bool(db_snapshot and db_snapshot.get("date") == today
                            and db_snapshot.get("backtest_trades") is not None)

            if from_db:
                quality = db_snapshot.get("backtest_quality") or 0.5
                n_trades = db_snapshot.get("backtest_trades") or 0
                logger.info(f"MEGA-ALERTS: {ticker} — беру расчёт из общей базы, локальный бэктест не считаю")
            elif candles and hasattr(strategy, "backtest_quality"):
                quality, n_trades = strategy.backtest_quality(candles)
            else:
                quality, n_trades = 0.5, 0

            live = n_trades >= cfg.backtest_min_trades and quality >= cfg.backtest_quality_min
            if live and hasattr(strategy, "set_signal_only"):
                strategy.set_signal_only(False)
            logger.info(
                f"MEGA-ALERTS: {ticker} backtest quality={quality:.2f} на {n_trades} вирт. сделках "
                f"({'реальная торговля' if live else 'только сигналы'})"
            )
            result.append(strategy)
        return result

    def __build_futures_strategies(
            self,
            base_strategies: dict[str, IStrategy],
            base_tickers: list[str]
    ) -> list[IStrategy]:
        """
        Для каждого базового тикера из [FUTURES_TRADING] BASE_TICKERS находит
        ближайший по экспирации фьючерс (FORTS) и торгует ИМ вместо акции —
        сигнальные настройки (threshold/take/stop) переиспользуются из
        STRATEGY_<TICKER>_SETTINGS той же акции в settings.ini, если она
        сконфигурирована, иначе берутся дефолты из [MEGA_ALERTS]. Размер
        позиции считается отдельно, по ГО (см. __liquidity-аналог в
        __open_position_lots_count и место вызова в __trading).
        """
        cfg = self.__mega_alerts_settings
        result: list[IStrategy] = []

        by_ticker = {s.settings.ticker: s for s in base_strategies.values()}

        for base_ticker in base_tickers:
            resolved = self.__instrument_service.future_by_base_ticker(base_ticker)
            if not resolved:
                logger.warning(f"FUTURES: контракт на {base_ticker} не найден, пропуск")
                continue
            future_settings, figi = resolved

            base_strategy = by_ticker.get(base_ticker)
            if base_strategy:
                settings_dict = dict(base_strategy.settings.settings)
                max_lots_per_order = base_strategy.settings.max_lots_per_order
            else:
                settings_dict = {
                    "SIGNAL_THRESHOLD": cfg.signal_threshold,
                    "LONG_TAKE": cfg.long_take,
                    "LONG_STOP": cfg.long_stop,
                    "SHORT_TAKE": cfg.short_take,
                    "SHORT_STOP": cfg.short_stop,
                    "SIGNAL_ONLY": cfg.signal_only,
                }
                max_lots_per_order = cfg.max_lots_per_order

            settings = StrategySettings(
                name="OICompositeStrategy",
                figi=figi,
                ticker=future_settings.ticker,
                max_lots_per_order=max_lots_per_order,
                settings=settings_dict,
                lot_size=future_settings.lot,
                short_enabled_flag=future_settings.short_enabled_flag,
                is_future=True,
                margin_per_lot=future_settings.margin_per_lot
            )
            strategy = StrategyFactory.new_factory("OICompositeStrategy", settings)
            if not strategy:
                continue
            logger.info(
                f"FUTURES: {base_ticker} -> {future_settings.ticker} (figi={figi}), "
                f"ГО за лот={future_settings.margin_per_lot:.2f} ₽, экспирация={future_settings.expiration_date}"
            )
            result.append(strategy)

        return result

    def __get_today_strategies(self, strategies: list[IStrategy]) -> dict[str, IStrategy]:
        """
        Check and Select stocks for trading today.
        """
        logger.info("Check shares and strategy settings")
        today_trade_strategy: dict[str, IStrategy] = dict()

        for strategy in strategies:
            if strategy.settings.is_future:
                # фьючерс уже проверен на торгуемость в future_by_base_ticker
                # (api_trade_available_flag) — share-специфичных полей у него нет.
                today_trade_strategy[strategy.settings.figi] = strategy
                continue

            share_settings = self.__instrument_service.share_by_figi(strategy.settings.figi)
            logger.debug(f"Check share settings for figi {strategy.settings.figi}: {share_settings}")

            if (not share_settings.otc_flag) \
                    and share_settings.buy_available_flag \
                    and share_settings.sell_available_flag \
                    and share_settings.api_trade_available_flag:
                logger.debug(f"Share is ready for trading")

                # refresh information by latest info
                strategy.update_lot_count(share_settings.lot)
                strategy.update_short_status(share_settings.short_enabled_flag)

                today_trade_strategy[strategy.settings.figi] = strategy

        return today_trade_strategy
