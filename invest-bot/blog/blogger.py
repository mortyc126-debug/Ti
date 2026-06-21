import asyncio
import logging
from decimal import Decimal

from tinkoff.invest import OrderState

from configuration.settings import BlogSettings, StrategySettings
from invest_api.utils import moneyvalue_to_decimal
from trade_system.signal import SignalType
from trade_system.strategies.base_strategy import IStrategy
from trading.trade_results import TradeOrder

__all__ = ("Blogger")

logger = logging.getLogger(__name__)


class Blogger:
    """
    Форматирует и отправляет сообщения в Telegram-чат.
    """
    def __init__(
            self,
            blog_settings: BlogSettings,
            trade_strategies: list[StrategySettings],
            messages_queue: asyncio.Queue
    ) -> None:
        self.__blog_status = blog_settings.blog_status
        self.__trade_strategies: dict[str, StrategySettings] = {x.figi: x for x in trade_strategies}
        self.__messages_queue = messages_queue

    def __send_text_message(self, text: str) -> None:
        try:
            logger.debug(f"Добавляем сообщение в очередь TG: {text}")
            self.__messages_queue.put_nowait(text)
        except Exception as ex:
            logger.error(f"Ошибка добавления сообщения в очередь TG: {repr(ex)}")

    def start_trading_message(
            self,
            today_trade_strategy: dict[str, IStrategy],
            rub_before_trade_day: Decimal
    ) -> None:
        if self.__blog_status:
            self.__send_text_message("🟢 Бот запускается. Начинаем торговый день.")
            self.__send_text_message(f"💰 Депозит на старте: {rub_before_trade_day:.2f} ₽")
            self.__send_text_message("📋 Торгуемые тикеры сегодня:")
            for figi_key, strategy_value in today_trade_strategy.items():
                short_status = "разрешён" if strategy_value.settings.short_enabled_flag else "запрещён"
                self.__send_text_message(
                    f"  • {strategy_value.settings.ticker} (шорт: {short_status})"
                )

    def mega_alerts_message(self, tracked_hits: list[str], extra_tickers: list[str]) -> None:
        """
        Сообщение по итогам ежедневной выгрузки MOEX MEGA-ALERTS.
        """
        if not self.__blog_status:
            return
        if tracked_hits:
            self.__send_text_message(f"⚡ MEGA-ALERTS: аномалии сегодня по нашим тикерам: {', '.join(tracked_hits)}")
        if extra_tickers:
            preview = ', '.join(extra_tickers[:20])
            more = f" и ещё {len(extra_tickers) - 20}" if len(extra_tickers) > 20 else ""
            self.__send_text_message(f"⚡ MEGA-ALERTS: {len(extra_tickers)} сторонних тикеров с аномалиями: {preview}{more}")

    def finish_trading_message(self) -> None:
        if self.__blog_status:
            self.__send_text_message("🔔 Закрываем торговый день, выходим из позиций.")

    def close_position_message(self, trade_order: TradeOrder) -> None:
        if self.__blog_status and trade_order:
            direction = "ЛОНГ" if trade_order.signal.signal_type == SignalType.LONG else "ШОРТ"
            ticker = self.__trade_strategies[trade_order.signal.figi].ticker
            self.__send_text_message(f"🔴 {ticker}: позиция {direction} закрыта.")

    def open_position_message(self, trade_order: TradeOrder) -> None:
        if self.__blog_status and trade_order:
            direction = "ЛОНГ" if trade_order.signal.signal_type == SignalType.LONG else "ШОРТ"
            ticker = self.__trade_strategies[trade_order.signal.figi].ticker
            self.__send_text_message(
                f"🟢 {ticker}: открыта позиция {direction}. "
                f"Тейк-профит: {trade_order.signal.take_profit_level:.2f}. "
                f"Стоп-лосс: {trade_order.signal.stop_loss_level:.2f}."
            )

    def trading_depo_summary_message(
            self,
            rub_before_trade_day: Decimal,
            current_rub_on_depo: Decimal
    ) -> None:
        if self.__blog_status:
            self.__send_text_message(
                f"💼 Депозит: начало дня {rub_before_trade_day:.2f} ₽ → конец дня {current_rub_on_depo:.2f} ₽"
            )
            today_profit = current_rub_on_depo - rub_before_trade_day
            today_percent_profit = (today_profit / rub_before_trade_day * 100) if rub_before_trade_day else 0
            sign = "+" if today_profit >= 0 else ""
            self.__send_text_message(
                f"📊 Результат дня: {sign}{today_profit:.2f} ₽ ({sign}{today_percent_profit:.2f}%)"
            )

    def notify_message(self, text: str) -> None:
        """Прямая отправка произвольного текста — для NotificationService."""
        if self.__blog_status:
            self.__send_text_message(text)

    def fail_message(self):
        if self.__blog_status:
            self.__send_text_message(
                "🚨 ВНИМАНИЕ: произошла критическая ошибка. "
                "Пытаемся закрыть все позиции. "
                "Если не получится — закройте вручную!"
            )

    def summary_message(self):
        if self.__blog_status:
            self.__send_text_message("📋 Итоги торгового дня:")

    def final_message(self):
        if self.__blog_status:
            self.__send_text_message("✅ Торговля завершена. До встречи на следующем торговом дне!")

    def summary_open_signal_message(self, trade_order: TradeOrder, open_order_state: OrderState):
        if self.__blog_status:
            direction = "ЛОНГ" if trade_order.signal.signal_type == SignalType.LONG else "ШОРТ"
            ticker = self.__trade_strategies[trade_order.signal.figi].ticker
            summary_commission = moneyvalue_to_decimal(open_order_state.executed_commission) + \
                                 moneyvalue_to_decimal(open_order_state.service_commission)
            self.__send_text_message(
                f"⚠️ {ticker}: позиция {direction} осталась открытой.\n"
                f"  Лотов исполнено: {open_order_state.lots_executed}\n"
                f"  Средняя цена: {moneyvalue_to_decimal(open_order_state.average_position_price):.2f} ₽\n"
                f"  Сумма ордера: {moneyvalue_to_decimal(open_order_state.total_order_amount):.2f} ₽\n"
                f"  Комиссия: {summary_commission:.2f} ₽\n"
                f"  ⚡ Требуется ручное закрытие!"
            )

    def summary_closed_signal_message(self,
                                      trade_order: TradeOrder,
                                      open_order_state: OrderState,
                                      close_order_state: OrderState
                                      ) -> None:
        if self.__blog_status:
            direction = "ЛОНГ" if trade_order.signal.signal_type == SignalType.LONG else "ШОРТ"
            ticker = self.__trade_strategies[trade_order.signal.figi].ticker
            summary_commission = moneyvalue_to_decimal(open_order_state.executed_commission) + \
                                 moneyvalue_to_decimal(open_order_state.service_commission) + \
                                 moneyvalue_to_decimal(close_order_state.executed_commission) + \
                                 moneyvalue_to_decimal(close_order_state.service_commission)
            pnl = moneyvalue_to_decimal(close_order_state.total_order_amount) - \
                  moneyvalue_to_decimal(open_order_state.total_order_amount)
            sign = "+" if pnl >= 0 else ""
            self.__send_text_message(
                f"📌 {ticker}: сделка {direction} закрыта.\n"
                f"  Цена входа: {moneyvalue_to_decimal(open_order_state.average_position_price):.2f} ₽\n"
                f"  Цена выхода: {moneyvalue_to_decimal(close_order_state.average_position_price):.2f} ₽\n"
                f"  Лотов: {close_order_state.lots_executed}\n"
                f"  Результат: {sign}{pnl:.2f} ₽\n"
                f"  Комиссии: {summary_commission:.2f} ₽"
            )
