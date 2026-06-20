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
from invest_api.utils import aggcandle_to_historiccandle
from trade_system.issuer_filter import issuer_key, select_top_tickers
from trade_system.signal import Signal, SignalType
from trade_system.strategies.base_strategy import IStrategy
from history import HistoryStore
from calibration import PercentileCalibrator
from timeframe import MultiTfBuffer
from trading.trade_results import TradeResults
from configuration.settings import TradingSettings, MegaAlertsSettings, StrategySettings, FuturesTradingSettings
from trade_system.strategies.strategy_factory import StrategyFactory
from risk import RiskManager
from oi_layers import OiLayersService
from orderbook import OrderBookService
from tradestats import TradeStatsService
from mega_alerts import MegaAlertsService
from archive import ArchiveStore
from candle_archive import get_candles_cached
from db_api_client import DbApiClient
from runtime_overrides import RuntimeOverrides
import bot_control

__all__ = ("Trader")

logger = logging.getLogger(__name__)

# Адаптивный выход (risk.check_exit: трейлинг Chandelier + безубыток после 1R
# + giveback-защита пика) — единственный путь, которым в принципе вызывается
# risk.check_exit() для целой позиции. Без него стоп/тейк сигнала статичны
# и risk.py не двигает защиту прибыли вообще. Включён по умолчанию — для
# отключения (вернуться к статичным stop/take сигнала) поставить ADAPTIVE_EXIT=0.
ADAPTIVE_EXIT_ENABLED = os.getenv("ADAPTIVE_EXIT", "1") == "1"

# Частичная фиксация на первом тейке (risk.check_partial_take/reduce_position):
# половина закрывается на тейке, остаток держится с фиксированным уровнем
# защиты (треть пройденного расстояния вход->тейк). Управляется с дашборда
# (RuntimeOverrides.partial_tp_enabled) — здесь только дефолт, если в
# data/bot_overrides.json явно не выставлено. Несовместимо с ADAPTIVE_EXIT
# (там стоп/тейк сигнала вообще не используются).
PARTIAL_TP_DEFAULT_ENABLED = os.getenv("PARTIAL_TP", "0") == "1"

# После убыточного закрытия (стоп/remainder_stop в минус) — повод для входа
# мог быть ошибочным, новый вход в тот же тикер блокируется на это время.
# Прибыльное закрытие НЕ блокирует — повторный заход на той же идее это
# нормально (см. __risk_close).
LOSS_REENTRY_COOLDOWN_MINUTES = int(os.getenv("LOSS_COOLDOWN_MIN", "30"))

# Глубина истории для авто-подбора ATR_TAKE_K/ATR_STOP_K (OICompositeStrategy.
# set_atr_history_provider) — столько дней свечей берётся для sweep раз в день.
# 20 дней давало 3-24 сделки на тикер — недостаточно для надёжного выбора
# параметра по шумной метрике (expectancy на горстке исходов). D1-архив свечей
# растёт инкрементально не только за последние 90 дней, поэтому можно брать
# окно шире без доп. нагрузки на Tinkoff API.
AUTO_ATR_HISTORY_DAYS = 90

# Стрим стакана (OrderBookService): отдельная gRPC-подписка сверх свечной,
# глубина ORDERBOOK_DEPTH уровней. Выключен по умолчанию (новая живая
# подписка с доп. нагрузкой на лимиты API) — включается с дашборда
# (RuntimeOverrides.orderbook_enabled) или ORDERBOOK=1.
ORDERBOOK_DEFAULT_ENABLED = os.getenv("ORDERBOOK", "0") == "1"
ORDERBOOK_DEPTH = int(os.getenv("ORDERBOOK_DEPTH", "10"))


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
            mega_alerts: MegaAlertsService,
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
        self.__orderbook = OrderBookService()
        self.__orderbook_task: asyncio.Task | None = None
        self.__tradestats = TradeStatsService()
        self.__tradestats_task: asyncio.Task | None = None
        # MegaAlertsService и его daily_loop живут на уровне TradeService —
        # один процесс-долгоживущий инстанс на весь срок работы бота, а не
        # пересоздаётся вместе с новым Trader каждый торговый день. Иначе
        # вчерашняя daily_loop-задача от вчерашнего Trader продолжала бы
        # жить вечно в фоне (ссылку на неё уже никто не держит, отменить
        # нельзя) — за N дней работы накопилось бы N независимых циклов,
        # каждый раз в сутки бьющих MOEX API и конкурирующих за запись в
        # один и тот же data/mega_alerts.json.
        self.__mega_alerts = mega_alerts
        self.__archive = ArchiveStore()
        self.__trading_settings: TradingSettings = TradingSettings()
        self.__candle_volumes: dict[str, deque] = {}
        # Аналитическая история: per-trade attribution, перцентильная калибровка
        self.__history = HistoryStore()
        self.__calibrator = PercentileCalibrator()
        self.__tf_buffer = MultiTfBuffer()
        # Сигнал, дождавшийся подтверждения на 1min-свече после решения на 5min-баре
        # (см. _new5 в __trading_loop): {figi: {"signal": Signal, "ttl": int}}
        self.__pending_signal: dict[str, dict] = {}
        # Прогноз утреннего backtest-гейта (ticker -> {quality, n_trades, live})
        # для сверки с фактическим rolling_quality конца дня — см. __archive_today.
        self.__backtest_predictions: dict[str, dict] = {}
        # Трекинг MFE/MAE для открытых позиций: {figi: {entry, direction, max_fav, max_adv}}
        self.__pos_tracking: dict[str, dict] = {}
        # Текущие стратегии торгового дня — для TG /status и /close
        self.__current_strategies: dict[str, IStrategy] = {}
        # Настройки с дашборда (live/sandbox, take/stop, allow/deny по тикерам) —
        # см. runtime_overrides.py. Перечитывается на каждой свече по mtime.
        self.__overrides = RuntimeOverrides()
        # Кулдаун повторного входа после убыточного закрытия — см. __risk_close.
        self.__loss_cooldown_until: dict[str, datetime.datetime] = {}
        # figi, для которых размещение ордера (__smart_order, до 45с репрайса)
        # сейчас идёт фоновой asyncio.Task — см. __trading/__place_order_task.
        # Не даёт открыть вторую заявку по тому же тикеру, пока первая летит,
        # и не блокирует чтение стрима свечей по ОСТАЛЬНЫМ тикерам на это время.
        self.__pending_orders: set[str] = set()
        # Кэш MULTI_TICKER-скора (ticker -> (date, score)) — пересчитывается
        # раз в день в __multi_ticker_signal, а не на каждой свече: расчёт
        # требует скачивания истории по двум тикерам и тяжёлых numpy-вычислений
        # (transfer entropy / wavelet coherence), см. set_multi_ticker_provider.
        self.__multi_ticker_cache: dict[str, tuple] = {}

    def pause(self) -> None:
        bot_control.control.paused = True

    def resume(self) -> None:
        bot_control.control.paused = False

    def request_close(self, ticker: str) -> None:
        bot_control.control.close_requests.add(ticker.upper())

    def status_text(self) -> str:
        """
        Текстовый статус для TG /status: режим (пауза/торговля) + по
        каждой открытой позиции текущий PnL и пик MFE/MAE с момента входа.
        """
        lines = ["⏸ Пауза (новые позиции не открываются)" if bot_control.control.paused else "▶ Торговля активна"]
        has_position = False
        for figi, strategy in self.__current_strategies.items():
            order = self.__today_trade_results.get_current_trade_order(figi) if self.__today_trade_results else None
            if not order:
                continue
            has_position = True
            ticker = strategy.settings.ticker
            direction = "LONG" if order.signal.signal_type == SignalType.LONG else "SHORT"
            pt = self.__pos_tracking.get(figi)
            cur_price = self.__last_prices.get(ticker)
            line = f"{ticker} {direction}"
            if pt and pt["entry"] > 0 and cur_price:
                ep = pt["entry"]
                if direction == "LONG":
                    cur_pnl = (cur_price - ep) / ep
                    mfe = (pt["max_fav"] - ep) / ep
                    mae = (ep - pt["max_adv"]) / ep
                else:
                    cur_pnl = (ep - cur_price) / ep
                    mfe = (ep - pt["max_fav"]) / ep
                    mae = (pt["max_adv"] - ep) / ep
                line += f": сейчас {cur_pnl * 100:+.2f}%, пик +{mfe * 100:.2f}% / просадка -{mae * 100:.2f}%"
            lines.append(line)
        if not has_position:
            lines.append("Открытых позиций нет.")
        return "\n".join(lines)

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

        for strategy in today_trade_strategies.values():
            self.__validate_strategy_backtest(strategy)

        configured_tickers = [s.settings.ticker for s in today_trade_strategies.values()]
        # daily_loop() самой MegaAlertsService уже крутится фоном на уровне
        # TradeService — здесь только форсируем свежий срез на старт дня.
        await self.__mega_alerts.refresh_once()
        tracked_hits = [t for t in configured_tickers if self.__mega_alerts.alerts_for(t)]
        candidate_tickers = self.__dedup_mega_alerts_candidates(configured_tickers)

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
                for strategy in added_futures.values():
                    self.__validate_strategy_backtest(strategy)
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
        if self.__overrides.orderbook_enabled(ORDERBOOK_DEFAULT_ENABLED):
            figi_to_ticker = {s.settings.figi: s.settings.ticker for s in today_trade_strategies.values()}
            self.__orderbook_task = asyncio.create_task(
                self.__orderbook_loop(figi_to_ticker, trade_day_end_time)
            )

        db_for_history = DbApiClient(self.__mega_alerts_settings.db_api_url, self.__mega_alerts_settings.db_api_key)
        for strategy in today_trade_strategies.values():
            if hasattr(strategy, "set_squeeze_provider"):
                strategy.set_squeeze_provider(self.__oi_layers.squeeze_score)
            if hasattr(strategy, "set_inst_oi_provider"):
                strategy.set_inst_oi_provider(self.__oi_layers.inst_oi_score)
            if hasattr(strategy, "set_retail_contra_provider"):
                strategy.set_retail_contra_provider(self.__oi_layers.retail_contra_score)
            if hasattr(strategy, "set_tradestats_provider"):
                strategy.set_tradestats_provider(self.__tradestats.score)
            if hasattr(strategy, "set_atr_history_provider"):
                figi = strategy.settings.figi
                strategy.set_atr_history_provider(
                    lambda ticker, figi=figi: get_candles_cached(
                        ticker, figi, AUTO_ATR_HISTORY_DAYS, self.__market_data_service, db_for_history
                    )
                )
            if hasattr(strategy, "set_multi_ticker_provider"):
                strategy.set_multi_ticker_provider(
                    lambda ticker: self.__multi_ticker_signal(
                        ticker, today_trade_strategies, db_for_history
                    )
                )
            # Инжекция аналитической истории и калибратора — прогревает
            # перцентильные буферы и загружает динамические режимные моды.
            # db (если настроен) — дублирует закрытые сделки в общую базу.
            if hasattr(strategy, "set_history"):
                strategy.set_history(self.__history, self.__calibrator, db=db_for_history)

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
            await self.__cancel_task(self.__orderbook_task)
            self.__orderbook_task = None

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
        self.__current_strategies = strategies
        bot_control.control.current_trader = self
        self.__overrides.maybe_reload()
        self.__apply_overrides(strategies)

        async for candle in self.__stream_service.start_async_candles_stream(
                list(strategies.keys()),
                trade_before_time
        ):
            current_figi_candle = current_candles.setdefault(candle.figi, candle)
            if candle.time < current_figi_candle.time:
                # it happens (based on API documentation)
                logger.debug("Skip candle from past.")
                continue

            ticker = strategies[candle.figi].settings.ticker
            cur_price = float(quotation_to_decimal(candle.close))
            self.__last_prices[ticker] = cur_price

            # Срочное закрытие по команде из Telegram (/close TICKER|all)
            if bot_control.control.close_requests:
                self.__process_close_requests(account_id, strategies)

            # Настройки с дашборда (live/sandbox, take/stop) — перечитываем
            # дёшево (stat()), применяем к стратегиям только если файл менялся.
            if self.__overrides.maybe_reload():
                self.__apply_overrides(strategies)

            # Обновляем MFE/MAE трекинг для открытой позиции
            pt = self.__pos_tracking.get(candle.figi)
            if pt:
                high_p = float(quotation_to_decimal(candle.high))
                low_p = float(quotation_to_decimal(candle.low))
                if pt["direction"] == "LONG":
                    pt["max_fav"] = max(pt["max_fav"], high_p)
                    pt["max_adv"] = min(pt["max_adv"], low_p)
                else:
                    pt["max_fav"] = min(pt["max_fav"], low_p)
                    pt["max_adv"] = max(pt["max_adv"], high_p)

            # Обновляем tf-буфер ТОЛЬКО закрытой минутной свечой — push(candle)
            # с текущим (ещё формирующимся) candle здесь раньше вызывался на
            # каждое промежуточное обновление потока (стрим шлёт обновления
            # текущей минуты на каждую сделку внутри неё, а не только финальное
            # закрытое значение), из-за чего "5-минутный"/"часовой" бар в
            # MultiTfBuffer закрывался за случайное число тиков, а не за
            # реальные 5/60 минут, и volume суммировался многократно.
            if candle.time > current_figi_candle.time:
                _new5, _new1h = self.__tf_buffer.push(current_figi_candle)
            if hasattr(strategies[candle.figi], "set_tf_regimes"):
                tf_regimes = {"1min": strategies[candle.figi].last_snapshot().get("regime", "")}
                if self.__tf_buffer.has_5min(candle.figi):
                    from regime import classify_regime as _cr
                    c5 = self.__tf_buffer.closes_5min(candle.figi)
                    if len(c5) >= 5:
                        r5, _ = _cr(c5, [])
                        tf_regimes["5min"] = r5
                if self.__tf_buffer.has_1h(candle.figi):
                    c1h = self.__tf_buffer.closes_1h(candle.figi)
                    if len(c1h) >= 3:
                        r1h, _ = _cr(c1h, [])
                        tf_regimes["1h"] = r1h
                strategies[candle.figi].set_tf_regimes(tf_regimes)

            # check price from candle for take or stop price levels
            current_trade_order = self.__today_trade_results.get_current_trade_order(candle.figi)
            if current_trade_order:
                high, low = quotation_to_decimal(candle.high), quotation_to_decimal(candle.low)

                # Logic is:
                # if stop or take price level is between high and low, then stop or take will be executed
                risk_ticker_cur = strategies[candle.figi].settings.ticker
                risk_pos_cur = self.__risk.positions.get(risk_ticker_cur)
                try:
                    if self.__overrides.adaptive_exit_enabled(ADAPTIVE_EXIT_ENABLED):
                        # Адаптивный выход — единственная логика закрытия позиции:
                        # фиксированные stop/take из сигнала игнорируются, чтобы
                        # трейлинг-стоп мог двигаться и забирать большее движение,
                        # а не закрываться по первому касанию исходного take_profit.
                        self.__check_adaptive_exit(account_id, candle, strategies)
                    elif risk_pos_cur and risk_pos_cur.half_closed:
                        # Остаток после частичной фиксации — стоп/тейк сигнала больше не
                        # действуют, его судьбу решает remainder_stop (risk.check_exit).
                        # Если цена идёт ещё дальше в плюс — оцениваем, не пора ли
                        # зафиксировать ещё часть (размазывание по check_scale_out).
                        self.__try_scale_out(account_id, candle, strategies, risk_ticker_cur, risk_pos_cur)
                        should_close, reason = self.__risk.check_exit(risk_ticker_cur, float(quotation_to_decimal(candle.close)))
                        if should_close:
                            logger.info(f"PARTIAL TP REMAINDER CLOSE {risk_ticker_cur}: {reason}")
                            self.__exit_position(account_id, strategies[candle.figi], strategies, float(quotation_to_decimal(candle.close)), reason)
                    elif self.__overrides.partial_tp_enabled(PARTIAL_TP_DEFAULT_ENABLED) and \
                            self.__try_partial_take(account_id, candle, strategies):
                        pass  # частичная фиксация сработала — остаток остаётся открытым
                    elif low <= current_trade_order.signal.stop_loss_level <= high:
                        logger.info(f"STOP LOSS: {current_trade_order}")
                        self.__exit_position(account_id, strategies[candle.figi], strategies, float(current_trade_order.signal.stop_loss_level), "stop_loss")

                    elif low <= current_trade_order.signal.take_profit_level <= high:
                        logger.info(f"TAKE PROFIT: {current_trade_order}")
                        self.__exit_position(account_id, strategies[candle.figi], strategies, float(current_trade_order.signal.take_profit_level), "take_profit")
                except Exception as ex:
                    logger.error(f"Error check Stop loss and Take profit levels: {repr(ex)}")

            if candle.time > current_figi_candle.time:
                self.__candle_volumes.setdefault(candle.figi, deque(maxlen=20)).append(current_figi_candle.volume)

            if candle.time > current_figi_candle.time and \
                    datetime.datetime.utcnow().replace(tzinfo=datetime.timezone.utc) <= signals_before_time:
                signal_new = None
                if _new5 is not None:
                    # Решение о входе считается на агрегированном 5min-баре — так же,
                    # как в бэктесте (там CANDLE_WINDOW=30 строится из 5min-свечей).
                    # Раньше здесь отдавался каждый 1min-бар, и стратегия фактически
                    # считала сигнал по последним 30 минутам, а бэктест — по последним
                    # ~2.5 часам на тех же CANDLE_WINDOW=30: разные окна для одной цифры.
                    signal_new = strategies[candle.figi].analyze_candles(
                        [aggcandle_to_historiccandle(_new5, current_figi_candle.time)]
                    )

                if signal_new and signal_new.signal_type != SignalType.CLOSE:
                    # Не входим сразу по цене закрытия 5min-бара — ждём до 5 минутных
                    # свечей подтверждения движения в сторону сигнала (момент входа
                    # выбирается на 1min-данных), иначе входим по дедлайну как раньше.
                    logger.info(f"New signal (pending 1min confirmation): {signal_new}")
                    self.__pending_signal[candle.figi] = {"signal": signal_new, "ttl": 5}
                elif signal_new:
                    self.__handle_new_signal(account_id, candle, strategies, current_trade_order, signal_new)

                pending = self.__pending_signal.get(candle.figi)
                if pending:
                    if current_trade_order:
                        del self.__pending_signal[candle.figi]
                    else:
                        sig = pending["signal"]
                        want_long = sig.signal_type == SignalType.LONG
                        c_open = float(quotation_to_decimal(current_figi_candle.open))
                        c_close = float(quotation_to_decimal(current_figi_candle.close))
                        confirmed = (c_close >= c_open) if want_long else (c_close <= c_open)
                        pending["ttl"] -= 1
                        if confirmed or pending["ttl"] <= 0:
                            del self.__pending_signal[candle.figi]
                            self.__handle_new_signal(account_id, candle, strategies, current_trade_order, sig)

            current_candles[candle.figi] = candle

        logger.info("Today trading has been completed")

    def __handle_new_signal(self, account_id, candle, strategies, current_trade_order, signal_new) -> None:
        logger.info(f"New signal: {signal_new}")

        try:
            if signal_new.signal_type == SignalType.CLOSE:
                if current_trade_order:
                    logger.info(f"Close position by close signal: {current_trade_order}")
                    self.__exit_position(account_id, strategies[candle.figi], strategies, float(quotation_to_decimal(candle.close)), "close_signal")
                else:
                    logger.info(f"New signal has been skipped. No open position to close.")

            elif current_trade_order:
                logger.info(f"New signal has been skipped. Previous signal is still alive.")

            elif candle.figi in self.__pending_orders:
                logger.info(f"New signal has been skipped. Ордер по тикеру уже в процессе размещения.")

            elif not self.__market_data_service.is_stock_ready_for_trading(candle.figi):
                logger.info(f"New signal has been skipped. Stock isn't ready for trading")

            elif bot_control.control.paused:
                logger.info(f"New signal has been skipped. Бот на паузе (TG /pause)")

            elif self.__overrides.is_ticker_disabled(strategies[candle.figi].settings.ticker):
                logger.info(f"New signal has been skipped. Тикер запрещён к торговле с дашборда")

            elif self.__loss_cooldown_until.get(strategies[candle.figi].settings.ticker, datetime.datetime.min) \
                    > datetime.datetime.utcnow():
                logger.info(
                    f"New signal has been skipped. Кулдаун после убыточного закрытия до "
                    f"{self.__loss_cooldown_until[strategies[candle.figi].settings.ticker].isoformat()}"
                )

            else:
                strategy = strategies[candle.figi]
                # signal_only = только Telegram, без реального ордера;
                # дашборд может форсировать sandbox глобально или для тикера
                is_signal_only = self.__overrides.signal_only_for(
                    strategy.settings.ticker, getattr(strategy, 'signal_only', False)
                )

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
                        return

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
                        # Размещение/репрайс ордера (__smart_order) может ждать
                        # до limit_reprice_interval_sec * limit_reprice_max_attempts
                        # (десятки секунд). await прямо тут блокировал бы чтение
                        # стрима свечей по ВСЕМ остальным тикерам — стопы/тейки по
                        # уже открытым позициям не проверялись бы это время. Гоним
                        # фоновой таской, помечаем figi как "ордер в процессе".
                        self.__pending_orders.add(candle.figi)
                        asyncio.create_task(self.__place_order_task(
                            account_id, candle.figi, available_lots, signal_new,
                            strategy, direction, confidence, entry_price, stop_price,
                        ))
                    else:
                        logger.info(f"New signal has been skipped. No available money or risk budget")
        except Exception as ex:
            logger.error(f"Error open new position by new signal: {repr(ex)}")

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

    def __multi_ticker_signal(
            self,
            ticker: str,
            today_trade_strategies: dict[str, IStrategy],
            db_for_history: DbApiClient
    ) -> float:
        """
        MULTI_TICKER провайдер: межинструментальный сигнал между ticker и
        вторым тикером из сегодняшней корзины (детерминированно — следующий
        по сортированному списку тикеров, по кругу). Направление — знак
        transfer_entropy_score (информационный поток между рядами, см.
        indicators_multi.py), отвзвешенный wavelet_coherence_score как
        уверенностью в синхронности пары на средних горизонтах.

        Тяжёлые вычисления (скачивание истории, numpy) — раз в день на
        тикер, кэшируется в self.__multi_ticker_cache; между пересчётами
        отдаётся кэшированное значение.
        """
        today = datetime.datetime.now(datetime.timezone.utc).date()
        cached = self.__multi_ticker_cache.get(ticker)
        if cached and cached[0] == today:
            return cached[1]

        tickers = sorted(today_trade_strategies.keys())
        if len(tickers) < 2:
            self.__multi_ticker_cache[ticker] = (today, 0.0)
            return 0.0

        figi_self = next((f for f in tickers if today_trade_strategies[f].settings.ticker == ticker), None)
        if figi_self is None:
            return 0.0
        peer_figi = tickers[(tickers.index(figi_self) + 1) % len(tickers)]

        try:
            from indicators_multi import transfer_entropy_score, wavelet_coherence_score

            candles_self = get_candles_cached(
                ticker, figi_self, AUTO_ATR_HISTORY_DAYS, self.__market_data_service, db_for_history
            )
            peer_ticker = today_trade_strategies[peer_figi].settings.ticker
            candles_peer = get_candles_cached(
                peer_ticker, peer_figi, AUTO_ATR_HISTORY_DAYS, self.__market_data_service, db_for_history
            )
            n = min(len(candles_self), len(candles_peer))
            closes_self = [float(quotation_to_decimal(c.close)) for c in candles_self[-n:]]
            closes_peer = [float(quotation_to_decimal(c.close)) for c in candles_peer[-n:]]

            direction = transfer_entropy_score(closes_self, closes_peer)
            confidence = wavelet_coherence_score(closes_self, closes_peer)
            score = max(-1.0, min(1.0, direction * confidence))
        except Exception as ex:
            logger.warning(f"multi_ticker_signal {ticker} failed: {repr(ex)}")
            score = 0.0

        self.__multi_ticker_cache[ticker] = (today, score)
        return score

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

    async def __place_order_task(
            self,
            account_id: str,
            figi: str,
            available_lots: int,
            signal_new: Signal,
            strategy: IStrategy,
            direction: str,
            confidence: float,
            entry_price: float,
            stop_price: float,
    ) -> None:
        """
        Фоновая таска размещения ордера (см. вызов в __trading) — выполняет
        __smart_order и последующую регистрацию позиции (today_trade_results,
        risk.open_position, MFE/MAE трекинг) без блокировки чтения стрима
        свечей по остальным тикерам на время репрайса.
        """
        risk_ticker = strategy.settings.ticker
        try:
            open_order_id, actual_lots = await self.__smart_order(
                account_id=account_id,
                figi=figi,
                count_lots=available_lots,
                is_buy=(signal_new.signal_type == SignalType.LONG),
                last_price=entry_price,
                strategy=strategy
            )
            if open_order_id and actual_lots > 0:
                if actual_lots < available_lots:
                    logger.warning(
                        f"PARTIAL FILL {risk_ticker}: "
                        f"запрошено {available_lots}, исполнено {actual_lots}"
                    )
                # Ордер уже реально исполнен на бирже — отсюда и до конца
                # блока нельзя просто залогировать исключение и пойти дальше:
                # риск.py должен зарегистрировать позицию ПЕРВЫМ (на нём
                # держится корреляционный/портфельный лимит и трейлинг), а
                # если что-то всё равно упадёт ниже — компенсируем закрытием
                # "осиротевшего" реального ордера, а не просто логом.
                try:
                    entry_composite = 0.0
                    if hasattr(strategy, "last_snapshot"):
                        try:
                            _comp = strategy.last_snapshot().get("composite", 0.0)
                            entry_composite = _comp if direction == "long" else -_comp
                        except Exception as ex:
                            logger.warning(f"{risk_ticker}: last_snapshot() упал, entry_composite=0.0: {repr(ex)}")

                    self.__risk.open_position(
                        risk_ticker, direction, actual_lots,
                        entry_price, stop_price,
                        point_value=strategy.settings.point_value,
                        confidence=confidence,
                        take_target=float(signal_new.take_profit_level),
                        entry_composite=entry_composite,
                    )
                    open_position = self.__today_trade_results.open_position(
                        figi,
                        open_order_id,
                        signal_new
                    )
                    self.__blogger.open_position_message(open_position)
                    logger.info(f"Open position: {open_position}")
                    # Запускаем MFE/MAE трекинг для этой позиции
                    self.__pos_tracking[figi] = {
                        "direction": "LONG" if signal_new.signal_type == SignalType.LONG else "SHORT",
                        "entry": entry_price,
                        "max_fav": entry_price,
                        "max_adv": entry_price,
                    }
                except Exception as ex:
                    logger.error(
                        f"{risk_ticker}: ошибка регистрации позиции после реального исполнения "
                        f"ордера {open_order_id} — закрываю осиротевшую позицию на бирже: {repr(ex)}"
                    )
                    self.__risk.positions.pop(risk_ticker, None)
                    try:
                        self.__close_figi_with_fill_info(account_id, figi, {figi: strategy})
                    except Exception as close_ex:
                        logger.error(f"{risk_ticker}: не удалось закрыть осиротевшую позицию: {repr(close_ex)}")
            else:
                logger.warning(f"Open order REJECTED/FAILED для {risk_ticker}")
        except Exception as ex:
            logger.error(f"Error open new position by new signal: {repr(ex)}")
        finally:
            self.__pending_orders.discard(figi)

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

    def __apply_overrides(self, strategies: dict[str, IStrategy]) -> None:
        """
        Применяет take/stop оверрайды с дашборда к уже сконструированным
        стратегиям (set_take_stop_overrides переписывает закэшированные в
        __init__ Decimal). signal_only и enabled/disabled читаются на
        каждый новый сигнал напрямую из RuntimeOverrides (см. __trading) —
        здесь они не кэшируются.

        Вызывается на каждый реальный реload оверрайдов (не только когда
        для тикера заданы take/stop) — set_take_stop_overrides сама умеет
        сбрасывать множитель на дефолт settings.ini для полей, которых нет
        в overrides. Раньше вызов пропускался при пустом overrides, из-за
        чего снятие оверрайда с дашборда (поле очищено -> null) не
        применялось: стратегия молча торговала со старым значением.
        """
        for strategy in strategies.values():
            if not hasattr(strategy, "set_take_stop_overrides"):
                continue
            overrides = self.__overrides.take_stop_for(strategy.settings.ticker)
            strategy.set_take_stop_overrides(**overrides)
            logger.info(f"OVERRIDES: {strategy.settings.ticker} take/stop -> {overrides or 'default (settings.ini)'}")

    def __try_partial_take(
            self,
            account_id: str,
            candle: Candle,
            strategies: dict[str, IStrategy]
    ) -> bool:
        """
        Частичная фиксация: половина позиции закрывается реальным маркет-
        ордером при достижении take_target (см. risk.check_partial_take),
        остаток дальше защищён remainder_stop (risk.check_exit). Для
        signal_only позиций risk.positions пуст — функция просто вернёт
        False, обычные stop/take-проверки сигнала сработают как раньше.
        """
        strategy = strategies[candle.figi]
        ticker = strategy.settings.ticker
        pos = self.__risk.positions.get(ticker)
        if not pos or pos.half_closed or pos.take_target <= 0:
            return False
        high, low = float(quotation_to_decimal(candle.high)), float(quotation_to_decimal(candle.low))
        if not (low <= pos.take_target <= high):
            return False
        should, qty, remainder_stop = self.__risk.check_partial_take(ticker, pos.take_target)
        if not should:
            return False
        is_buy = (pos.direction == "short")  # закрыть часть шорта -> купить
        order_id = self.__partial_close_order(account_id, candle.figi, qty, is_buy)
        if not order_id:
            return False
        self.__risk.reduce_position(
            ticker, qty, pos.take_target,
            point_value=strategy.settings.point_value,
            reason="partial_take_profit", remainder_stop=remainder_stop,
        )
        logger.info(
            f"PARTIAL TAKE PROFIT {ticker}: -{qty} лотов @ {pos.take_target}, "
            f"остаток защищён уровнем {remainder_stop:.4f}"
        )
        return True

    def __partial_close_order(self, account_id: str, figi: str, lots: int, is_buy: bool) -> str | None:
        if not self.__market_data_service.is_stock_ready_for_trading(figi):
            return None
        order = self.__order_service.post_market_order(
            account_id=account_id, figi=figi, count_lots=lots, is_buy=is_buy
        )
        if order.execution_report_status in (
                OrderExecutionReportStatus.EXECUTION_REPORT_STATUS_FILL,
                OrderExecutionReportStatus.EXECUTION_REPORT_STATUS_PARTIALLYFILL,
        ):
            return order.order_id
        logger.warning(f"Partial-TP close order REJECTED/FAILED: {order}")
        return None

    def __try_scale_out(
            self,
            account_id: str,
            candle: Candle,
            strategies: dict[str, IStrategy],
            ticker: str,
            pos,
    ) -> None:
        """
        Размазывание фиксации после первого тейка: пока остаток открыт,
        на каждый следующий шаг (та же дистанция вход->тейк) сверяем
        текущий знаковый edge сигнала (composite) с тем, что был на входе
        (risk.check_scale_out). Если преимущество исчезает — фиксируем ещё
        часть остатка реальным ордером; иначе risk.py сам подтянет
        remainder_stop вперёд без закрытия.
        """
        if pos.fix_step <= 0 or pos.qty < 2:
            return
        strategy = strategies[candle.figi]
        if not hasattr(strategy, "last_snapshot"):
            return
        composite = strategy.last_snapshot().get("composite", 0.0)
        current_edge = composite if pos.direction == "long" else -composite
        price = float(quotation_to_decimal(candle.close))
        should, qty, remainder_stop = self.__risk.check_scale_out(ticker, price, current_edge)
        if not should:
            return
        is_buy = (pos.direction == "short")  # закрыть часть шорта -> купить
        order_id = self.__partial_close_order(account_id, candle.figi, qty, is_buy)
        if not order_id:
            return
        self.__risk.reduce_position(
            ticker, qty, price,
            point_value=strategy.settings.point_value,
            reason="scale_out_decay", remainder_stop=remainder_stop,
        )
        logger.info(
            f"SCALE-OUT FIX {ticker}: -{qty} лотов @ {price} (edge просел), "
            f"остаток защищён уровнем {remainder_stop:.4f}"
        )

    def __risk_close(self, strategy: IStrategy, price: float, reason: str) -> dict | None:
        """Снять позицию из risk.py при выходе по стопу/тейку/close-сигналу.
        Возвращает результат close_position (нужен pnl_rub для loss-cooldown)."""
        risk_ticker = strategy.settings.ticker
        if risk_ticker not in self.__risk.positions:
            return None
        result = self.__risk.close_position(
            risk_ticker, price, point_value=strategy.settings.point_value, reason=reason)
        if result and result.get("pnl_rub", 0) < 0:
            self.__loss_cooldown_until[risk_ticker] = datetime.datetime.utcnow() + \
                datetime.timedelta(minutes=LOSS_REENTRY_COOLDOWN_MINUTES)
            logger.info(
                f"LOSS COOLDOWN {risk_ticker}: pnl={result['pnl_rub']:+.0f}₽ — "
                f"новые входы заблокированы на {LOSS_REENTRY_COOLDOWN_MINUTES} мин"
            )
        return result

    async def __orderbook_loop(
            self,
            figi_to_ticker: dict[str, str],
            trade_day_end_time: datetime.datetime
    ) -> None:
        """Фоновая задача: читает стрим стакана и кормит OrderBookService.on_orderbook."""
        figies = list(figi_to_ticker.keys())
        async for ob in self.__stream_service.start_async_orderbook_stream(
                figies, trade_day_end_time, depth=ORDERBOOK_DEPTH
        ):
            ticker = figi_to_ticker.get(ob.figi)
            if not ticker:
                continue
            bids = [(float(quotation_to_decimal(o.price)), float(o.quantity)) for o in ob.bids]
            asks = [(float(quotation_to_decimal(o.price)), float(o.quantity)) for o in ob.asks]
            self.__orderbook.on_orderbook(ticker, bids, asks)

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
        drift_per_bar, vol_per_bar = strategy.path_estimate()
        regime_confidence = strategy.last_snapshot().get("regime_confidence", 1.0)
        order_flow = 0.0
        if self.__orderbook.has_data(risk_ticker):
            imbalance = self.__orderbook.imbalance_score(risk_ticker)
            order_flow = imbalance if pos.direction == "long" else -imbalance
        should_close, reason = self.__risk.check_exit(
            risk_ticker, price, squeeze=squeeze,
            drift_per_bar=drift_per_bar, vol_per_bar=vol_per_bar,
            regime_confidence=regime_confidence, order_flow=order_flow,
        )
        if should_close:
            logger.info(f"ADAPTIVE EXIT {risk_ticker}: {reason}")
            self.__exit_position(account_id, strategy, strategies, price, reason)

    def __process_close_requests(
            self,
            account_id: str,
            strategies: dict[str, IStrategy]
    ) -> None:
        """
        Срочное закрытие по команде из Telegram: тикер или "ALL".
        Запрос снимается сразу после исполнения (или если позиции по нему
        нет — чтобы не висел вечно, если тикер указали с опечаткой).
        """
        reqs = bot_control.control.close_requests
        close_all = "ALL" in reqs
        for figi, strategy in list(strategies.items()):
            ticker = strategy.settings.ticker.upper()
            if not (close_all or ticker in reqs):
                continue
            if self.__today_trade_results and self.__today_trade_results.get_current_trade_order(figi):
                logger.info(f"TG /close: срочное закрытие {strategy.settings.ticker}")
                self.__exit_position(account_id, strategy, strategies, self.__last_prices.get(strategy.settings.ticker, 0.0), "tg_close_request")
            reqs.discard(ticker)
        reqs.discard("ALL")

    def __close_figi_with_fill_info(
            self,
            account_id: str,
            figi: str,
            strategies: dict[str, IStrategy]
    ) -> tuple[str | None, int, int]:
        """
        Закрывает одну позицию по figi market-ордером, возвращает
        (order_id, исполнено_лотов, запрошено_лотов) — в отличие от
        __close_position_by_figi не прячет PARTIALLYFILL, чтобы вызывающий
        код (__exit_position) мог не терять видимость непогашенного
        остатка реальной позиции в risk.py.
        """
        current_positions = list(self.__operation_service.positions_securities(account_id) or []) + \
            list(self.__operation_service.positions_futures(account_id) or [])
        for position in current_positions:
            if position.figi != figi or position.balance == 0:
                continue
            if not self.__market_data_service.is_stock_ready_for_trading(position.figi):
                return None, 0, 0
            lot_size = strategies[position.figi].settings.lot_size
            requested_lots = abs(int(position.balance / lot_size))
            if requested_lots <= 0:
                return None, 0, 0
            close_order = self.__order_service.post_market_order(
                account_id=account_id, figi=position.figi,
                count_lots=requested_lots, is_buy=(position.balance < 0)
            )
            if close_order.execution_report_status not in (
                OrderExecutionReportStatus.EXECUTION_REPORT_STATUS_FILL,
                OrderExecutionReportStatus.EXECUTION_REPORT_STATUS_PARTIALLYFILL,
            ):
                logger.warning(f"Close order REJECTED/FAILED: {close_order}")
                return None, 0, requested_lots
            try:
                state = self.__order_service.get_order_state(account_id, close_order.order_id)
                filled_lots = state.lots_executed or requested_lots
            except Exception as ex:
                logger.warning(f"__close_figi_with_fill_info get_order_state error: {repr(ex)}")
                filled_lots = requested_lots \
                    if close_order.execution_report_status == OrderExecutionReportStatus.EXECUTION_REPORT_STATUS_FILL \
                    else 0
            return close_order.order_id, filled_lots, requested_lots
        return None, 0, 0

    def __exit_position(
            self,
            account_id: str,
            strategy: IStrategy,
            strategies: dict[str, IStrategy],
            price: float,
            reason: str,
    ) -> None:
        """
        Единая точка выхода из позиции по стопу/тейку/сигналу/Telegram.
        Раньше risk_close (снятие позиции из risk.py) вызывался ДО
        закрывающего ордера на бирже — при PARTIALLYFILL бот считал
        позицию закрытой целиком, хотя на бирже остаётся непогашенный
        остаток, который risk.py больше не трейлит и не видит для
        корреляционного/портфельного риск-лимита. Теперь risk.py
        обновляется только по факту исполнения закрывающего ордера.
        """
        figi = strategy.settings.figi
        risk_ticker = strategy.settings.ticker
        if risk_ticker not in self.__risk.positions:
            return

        order_id, filled_lots, requested_lots = self.__close_figi_with_fill_info(account_id, figi, strategies)
        if not order_id or filled_lots <= 0:
            logger.warning(
                f"{risk_ticker}: закрывающий ордер не исполнился ({reason}), "
                f"позиция остаётся под трекингом risk.py — повтор на следующей свече"
            )
            return

        if filled_lots < requested_lots:
            logger.warning(
                f"PARTIAL CLOSE {risk_ticker}: запрошено {requested_lots}, исполнено {filled_lots} "
                f"лотов ({reason}) — остаток {requested_lots - filled_lots} лотов остаётся в risk.positions"
            )
            self.__risk.reduce_position(
                risk_ticker, filled_lots, price,
                point_value=strategy.settings.point_value, reason=reason,
            )
            # today_trade_results НЕ закрываем — current_trade_order остаётся
            # активным, следующая свеча повторит попытку закрыть остаток.
            return

        self.__risk_close(strategy, price, reason)
        trade_order = self.__today_trade_results.close_position(figi, order_id)
        self.__blogger.close_position_message(trade_order)
        self.__notify_closed_with_tracking(figi, strategies)

    def __notify_closed_with_tracking(
            self,
            figi: str,
            strategies: dict[str, IStrategy]
    ) -> None:
        """
        При закрытии позиции вычисляет реальные MFE/MAE из трекинга цен и
        передаёт их в стратегию вместо приближённого расчёта по after_candles.
        """
        strategy = strategies.get(figi)
        if strategy is None or not hasattr(strategy, "notify_position_closed"):
            return
        pt = self.__pos_tracking.pop(figi, None)
        exit_price = self.__last_prices.get(strategy.settings.ticker, 0.0)
        if pt and pt["entry"] > 0 and exit_price > 0:
            ep = pt["entry"]
            if pt["direction"] == "LONG":
                mfe = max(0.0, (pt["max_fav"] - ep) / ep)
                mae = max(0.0, (ep - pt["max_adv"]) / ep)
            else:
                mfe = max(0.0, (ep - pt["max_fav"]) / ep)
                mae = max(0.0, (pt["max_adv"] - ep) / ep)
            strategy.notify_position_closed(exit_price=exit_price, mfe=mfe, mae=mae)
        else:
            strategy.notify_position_closed()

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
                                self.__notify_closed_with_tracking(position.figi, strategies)
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
                live=not signal_only,
                auto_atr_take_k=snapshot.get("auto_atr_take_k"),
                auto_atr_stop_k=snapshot.get("auto_atr_stop_k"),
            )
            # Дублируем в HistoryStore — там хранятся ещё и сделки с attribution
            self.__history.record_daily(
                strategy.settings.ticker,
                composite=snapshot["composite"],
                scores=snapshot["scores"],
                regime=snapshot["regime"],
                regime_confidence=snapshot.get("regime_confidence", 1.0),
                rolling_quality=snapshot["rolling_quality"],
                live=not signal_only,
            )
            if db.configured:
                method_perf = self.__history.method_performance(strategy.settings.ticker)
                db.push_snapshot(
                    strategy.settings.ticker,
                    date=today,
                    composite=snapshot["composite"],
                    scores=snapshot["scores"],
                    regime=snapshot["regime"],
                    regime_confidence=snapshot.get("regime_confidence", 1.0),
                    method_weights={m: v["ewa_weight"] for m, v in method_perf.items()} or None,
                    rolling_quality=snapshot["rolling_quality"],
                    live=not signal_only
                )
            self.__record_backtest_calibration(strategy.settings.ticker, today, snapshot["rolling_quality"])
        self.__backtest_predictions.clear()

    def __record_backtest_calibration(self, ticker: str, date: str, actual_quality: float) -> None:
        """
        Сверяет утренний прогноз backtest-гейта (__validate_strategy_backtest)
        с фактическим rolling_quality конца дня — без этого нет способа узнать,
        насколько BACKTEST_QUALITY_MIN/историческая выборка вообще предсказывают
        реальный результат, а не просто шум на 5 днях истории.
        """
        prediction = self.__backtest_predictions.get(ticker)
        if prediction is None:
            return
        record = {"date": date, "ticker": ticker, "actual_quality": round(actual_quality, 4), **prediction}
        logger.info(
            f"BACKTEST-СВЕРКА: {ticker} прогноз={prediction['predicted_quality']:.2f} "
            f"факт={actual_quality:.2f} ({'торговали' if prediction['gated_live'] else 'signal-only'})"
        )
        path = "data/backtest_calibration.json"
        try:
            os.makedirs("data", exist_ok=True)
            records = []
            if os.path.exists(path):
                with open(path, encoding="utf-8") as f:
                    records = json.load(f)
            records.append(record)
            tmp = path + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(records[-500:], f, ensure_ascii=False)
            os.replace(tmp, path)
        except (OSError, json.JSONDecodeError) as ex:
            logger.warning(f"BACKTEST-СВЕРКА: не удалось сохранить {path}: {repr(ex)}")

    def __validate_strategy_backtest(self, strategy: IStrategy) -> None:
        """
        До сих пор backtest_quality прогонялся только для тикеров, найденных
        MEGA-ALERTS — сконфигурированные в settings.ini STRATEGY_<TICKER>
        с SIGNAL_ONLY=0 шли в реальную торговлю без какой-либо проверки на
        истории. Теперь перед стартом дня каждый такой тикер тоже прогоняется
        через backtest_quality (история — [MEGA_ALERTS] HISTORY_DAYS, пороги —
        BACKTEST_QUALITY_MIN/BACKTEST_MIN_TRADES). Если на истории недостаточно
        качественных вирт. сделок — стратегия на сегодня переводится в
        SIGNAL_ONLY (только Telegram), settings.ini не трогается.
        """
        if not hasattr(strategy, "is_signal_only") or not hasattr(strategy, "backtest_quality"):
            return
        if strategy.is_signal_only():
            return
        cfg = self.__mega_alerts_settings
        try:
            candles = self.__market_data_service.get_candles_history(strategy.settings.figi, days=cfg.history_days)
        except Exception as ex:
            logger.warning(f"BACKTEST: история свечей {strategy.settings.ticker} не получена: {repr(ex)}")
            return
        if not candles:
            return
        if hasattr(strategy, "warmup"):
            strategy.warmup(candles)
        quality, n_trades = strategy.backtest_quality(candles)
        live = n_trades >= cfg.backtest_min_trades and quality >= cfg.backtest_quality_min
        logger.info(
            f"BACKTEST: {strategy.settings.ticker} quality={quality:.2f} на {n_trades} вирт. сделках "
            f"({'ок, торгуем' if live else 'НЕДОСТАТОЧНО — переводим в signal-only на сегодня'})"
        )
        self.__backtest_predictions[strategy.settings.ticker] = {
            "predicted_quality": round(quality, 4), "n_trades": n_trades, "gated_live": live,
        }
        if not live and hasattr(strategy, "set_signal_only"):
            strategy.set_signal_only(True)

    def __dedup_mega_alerts_candidates(self, configured_tickers: list[str]) -> list[str]:
        """
        MOEX MEGA-ALERTS отдаёт сырой список тикеров с сегодняшними
        аномалиями — без учёта того, что обычка+префы одного эмитента
        (SBER/SBERP и т.п.) это один и тот же риск. Без дедупа бот мог бы
        потратить MAX_TICKERS слотов на дубли вместо разных эмитентов,
        а лучшую из пары мог бы и вовсе пропустить, если хуже отсортирована
        в alerts.json. Дедуп — тот же trade_system/issuer_filter.py, что
        и в dashboard.py, чтобы бэктест и реальная торговля видели
        одинаковый список тикеров.

        Порядок MEGA-ALERTS (по убыванию значимости аномалии) используем
        как demand — раньше в списке значит более востребован сегодня.
        """
        raw = [t for t in self.__mega_alerts.tickers_today("eq") if t not in configured_tickers]
        configured_keys = {issuer_key(t) for t in configured_tickers}
        infos = [
            {"ticker": t, "issuer_key": issuer_key(t), "demand": len(raw) - i}
            for i, t in enumerate(raw)
            if issuer_key(t) not in configured_keys
        ]
        kept, _ = select_top_tickers(infos, top_pct=1.0)
        return kept

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
