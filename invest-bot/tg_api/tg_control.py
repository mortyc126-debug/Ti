"""
tg_api/tg_control.py — приём команд управления ботом из Telegram.

В отличие от telegram_service.py (только отправка алертов/отчётов), этот
модуль слушает входящие сообщения (long polling) и крутит торговлю через
общий bot_control.control. Слушает только заданный chat_id — команды из
других чатов игнорируются.

Команды:
  /status        — режим (пауза/торговля) + открытые позиции, PnL, пик MFE/MAE
  /pause         — не открывать новые позиции (открытые управляются как обычно)
  /resume        — снять паузу
  /close TICKER  — срочно закрыть позицию по тикеру на следующей свече
  /close all     — срочно закрыть все открытые позиции
"""
import logging

from aiogram import Bot, Dispatcher
from aiogram.filters import Command
from aiogram.types import Message

import bot_control

__all__ = ("run_control_listener",)

logger = logging.getLogger(__name__)


def _build_dispatcher(allowed_chat_id: str) -> Dispatcher:
    dp = Dispatcher()

    def _allowed(message: Message) -> bool:
        return str(message.chat.id) == str(allowed_chat_id)

    @dp.message(Command("status"))
    async def cmd_status(message: Message) -> None:
        if not _allowed(message):
            return
        trader = bot_control.control.current_trader
        text = trader.status_text() if trader else "Бот не торгует сейчас (нет активной сессии)."
        await message.answer(text)

    @dp.message(Command("pause"))
    async def cmd_pause(message: Message) -> None:
        if not _allowed(message):
            return
        bot_control.control.paused = True
        await message.answer("⏸ Пауза: новые позиции открываться не будут. Открытые продолжают управляться стопами/тейками.")

    @dp.message(Command("resume"))
    async def cmd_resume(message: Message) -> None:
        if not _allowed(message):
            return
        bot_control.control.paused = False
        await message.answer("▶ Торговля возобновлена.")

    @dp.message(Command("close"))
    async def cmd_close(message: Message) -> None:
        if not _allowed(message):
            return
        parts = (message.text or "").split(maxsplit=1)
        if len(parts) < 2 or not parts[1].strip():
            await message.answer("Укажи тикер или all: /close SBER или /close all")
            return
        target = parts[1].strip().upper()
        bot_control.control.close_requests.add(target)
        await message.answer(f"Принято: срочное закрытие {target}. Исполнится на следующей свече.")

    return dp


async def run_control_listener(token: str, allowed_chat_id: str) -> None:
    bot = Bot(token=token)
    dp = _build_dispatcher(allowed_chat_id)
    logger.info("TG control listener: старт polling команд")
    await dp.start_polling(bot)
