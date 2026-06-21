"""
tg_api/tg_control.py — приём команд управления ботом из Telegram.

В отличие от telegram_service.py (только отправка алертов/отчётов), этот
модуль слушает входящие сообщения (long polling) и крутит торговлю через
общий bot_control.control. Слушает только заданный chat_id — команды из
других чатов игнорируются.

Команды:
  /status                          — режим (пауза/торговля) + открытые позиции, PnL, пик MFE/MAE
  /pause                           — не открывать новые позиции (открытые управляются как обычно)
  /resume                          — снять паузу
  /close TICKER                    — срочно закрыть позицию по тикеру на следующей свече
  /close all                       — срочно закрыть все открытые позиции
  /adopt TICKER LONG take=X stop=Y — передать ручную позицию боту под управление
  /adopt TICKER SHORT take=X stop=Y entry=Z — то же, с явной ценой входа
"""
import logging
from decimal import Decimal, InvalidOperation

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

    @dp.message(Command("adopt"))
    async def cmd_adopt(message: Message) -> None:
        if not _allowed(message):
            return
        # /adopt SBER LONG take=250.50 stop=240.00 entry=245.00
        text = (message.text or "").split(maxsplit=1)[1].strip() if len((message.text or "").split(maxsplit=1)) > 1 else ""
        parts = text.split()
        if len(parts) < 4:
            await message.answer(
                "Формат: /adopt TICKER LONG|SHORT take=X stop=Y [entry=Z]\n"
                "Пример: /adopt SBER LONG take=250.50 stop=240.00"
            )
            return
        ticker = parts[0].upper()
        direction = parts[1].upper()
        if direction not in ("LONG", "SHORT"):
            await message.answer("Направление должно быть LONG или SHORT")
            return
        kwargs: dict[str, str] = {}
        for p in parts[2:]:
            if "=" in p:
                k, v = p.split("=", 1)
                kwargs[k.lower()] = v
        try:
            take = Decimal(kwargs["take"])
            stop = Decimal(kwargs["stop"])
            entry = Decimal(kwargs["entry"]) if "entry" in kwargs else None
        except (KeyError, InvalidOperation):
            await message.answer("Не хватает take= или stop=, или некорректное число")
            return
        bot_control.control.adopt_requests.append(
            bot_control.AdoptRequest(ticker=ticker, direction=direction, take=take, stop=stop, entry=entry)
        )
        await message.answer(
            f"📥 Принято: передаю {ticker} {direction} боту под управление.\n"
            f"Тейк: {take}, Стоп: {stop}" + (f", Вход: {entry}" if entry else " (вход = текущая цена)") +
            "\nИсполнится на следующей свече."
        )

    @dp.message(Command("move_stop"))
    async def cmd_move_stop(message: Message) -> None:
        if not _allowed(message):
            return
        # /move_stop SBER 242.00 [take=255.00]
        parts = ((message.text or "").split(maxsplit=1)[1].strip()
                 if len((message.text or "").split(maxsplit=1)) > 1 else "").split()
        if len(parts) < 2:
            await message.answer("Формат: /move_stop TICKER НОВЫЙ_СТОП [take=НОВЫЙ_ТЕЙК]\nПример: /move_stop SBER 242.00")
            return
        ticker = parts[0].upper()
        try:
            new_stop = Decimal(parts[1])
            kw: dict[str, str] = {}
            for p in parts[2:]:
                if "=" in p:
                    k, v = p.split("=", 1)
                    kw[k.lower()] = v
            new_take = Decimal(kw["take"]) if "take" in kw else None
        except InvalidOperation:
            await message.answer("Некорректное число")
            return
        bot_control.control.move_stop_requests.append(
            bot_control.MoveStopRequest(ticker=ticker, new_stop=new_stop, new_take=new_take)
        )
        reply = f"📐 Принято: двигаю стоп {ticker} → {new_stop}"
        if new_take:
            reply += f", тейк → {new_take}"
        await message.answer(reply + "\nИсполнится на следующей свече.")

    return dp


async def run_control_listener(token: str, allowed_chat_id: str) -> None:
    bot = Bot(token=token)
    dp = _build_dispatcher(allowed_chat_id)
    logger.info("TG control listener: старт polling команд")
    await dp.start_polling(bot)
