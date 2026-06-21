"""
tg_api/tg_control.py — приём команд управления ботом из Telegram.

Команды:
  /status                     — режим + открытые позиции, PnL, MFE/MAE
  /pause                      — не открывать новые позиции
  /resume                     — снять паузу
  /close TICKER|all           — срочно закрыть позицию(и) на следующей свече
  /config                     — показать текущие настройки (bot_overrides.json)
  /enable  TICKER             — включить тикер в торговлю
  /disable TICKER             — отключить тикер (сигналы тоже)
  /signal  TICKER on|off      — переключить signal_only для тикера
  /take    TICKER VALUE       — установить long_take (напр. /take SBER 1.02)
  /stop    TICKER VALUE       — установить long_stop (напр. /stop SBER 0.98)
  /help                       — список команд
"""
import logging

from aiogram import Bot, Dispatcher
from aiogram.filters import Command
from aiogram.types import Message

import bot_control
from notification_service import _append_event
from runtime_overrides import load_overrides, save_overrides

__all__ = ("run_control_listener",)

logger = logging.getLogger(__name__)


# ─── helpers ────────────────────────────────────────────────────────────────

def _patch_overrides(ticker: str, **fields) -> None:
    """Атомарно меняет поля одного тикера в bot_overrides.json."""
    data = load_overrides()
    tickers = data.setdefault("tickers", {})
    entry = tickers.setdefault(ticker.upper(), {"enabled": True, "signal_only": None,
                                                 "long_take": None, "long_stop": None,
                                                 "short_take": None, "short_stop": None})
    entry.update(fields)
    save_overrides(data)
    _append_event("control", f"TG override: {ticker.upper()} {fields}")


def _config_text() -> str:
    data = load_overrides()
    lines = ["⚙️ <b>Текущие настройки (bot_overrides.json)</b>"]
    g = data.get("global_signal_only")
    lines.append(f"global_signal_only: {g}")
    lines.append(f"partial_tp: {data.get('partial_tp_enabled')}")
    lines.append(f"adaptive_exit: {data.get('adaptive_exit_enabled')}")
    lines.append(f"orderbook: {data.get('orderbook_enabled')}")
    tickers = data.get("tickers", {})
    if tickers:
        lines.append("")
        lines.append("<b>Тикеры:</b>")
        for t, cfg in sorted(tickers.items()):
            enabled = "✅" if cfg.get("enabled", True) else "❌"
            so = " [signal-only]" if cfg.get("signal_only") else ""
            tk = cfg.get("long_take") or "—"
            st = cfg.get("long_stop") or "—"
            lines.append(f"  {enabled} {t}{so}  take={tk} stop={st}")
    else:
        lines.append("(нет переопределений по тикерам)")
    return "\n".join(lines)


# ─── dispatcher ─────────────────────────────────────────────────────────────

def _build_dispatcher(allowed_chat_id: str) -> Dispatcher:
    dp = Dispatcher()

    def _allowed(message: Message) -> bool:
        return str(message.chat.id) == str(allowed_chat_id)

    # ── существующие команды ──────────────────────────────────────────────

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
        _append_event("control", "TG: /pause")
        await message.answer("⏸ Пауза: новые позиции открываться не будут. Открытые продолжают управляться стопами/тейками.")

    @dp.message(Command("resume"))
    async def cmd_resume(message: Message) -> None:
        if not _allowed(message):
            return
        bot_control.control.paused = False
        _append_event("control", "TG: /resume")
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
        _append_event("control", f"TG: /close {target}")
        await message.answer(f"Принято: срочное закрытие {target}. Исполнится на следующей свече.")

    # ── новые команды настройки ───────────────────────────────────────────

    @dp.message(Command("config"))
    async def cmd_config(message: Message) -> None:
        if not _allowed(message):
            return
        await message.answer(_config_text(), parse_mode="HTML")

    @dp.message(Command("enable"))
    async def cmd_enable(message: Message) -> None:
        if not _allowed(message):
            return
        parts = (message.text or "").split(maxsplit=1)
        if len(parts) < 2 or not parts[1].strip():
            await message.answer("Укажи тикер: /enable SBER")
            return
        ticker = parts[1].strip().upper()
        _patch_overrides(ticker, enabled=True)
        await message.answer(f"✅ {ticker} включён в торговлю. Применится на следующей свече.")

    @dp.message(Command("disable"))
    async def cmd_disable(message: Message) -> None:
        if not _allowed(message):
            return
        parts = (message.text or "").split(maxsplit=1)
        if len(parts) < 2 or not parts[1].strip():
            await message.answer("Укажи тикер: /disable SBER")
            return
        ticker = parts[1].strip().upper()
        _patch_overrides(ticker, enabled=False)
        await message.answer(f"❌ {ticker} отключён. Применится на следующей свече.")

    @dp.message(Command("signal"))
    async def cmd_signal(message: Message) -> None:
        if not _allowed(message):
            return
        parts = (message.text or "").split(maxsplit=2)
        if len(parts) < 3 or parts[2].lower() not in ("on", "off"):
            await message.answer("Использование: /signal SBER on  или  /signal SBER off")
            return
        ticker = parts[1].strip().upper()
        val = parts[2].lower() == "on"
        _patch_overrides(ticker, signal_only=val)
        mode = "signal-only (сделки не открываются)" if val else "боевой (реальные сделки)"
        await message.answer(f"⚙️ {ticker}: режим → {mode}. Применится на следующей свече.")

    @dp.message(Command("take"))
    async def cmd_take(message: Message) -> None:
        if not _allowed(message):
            return
        parts = (message.text or "").split(maxsplit=2)
        if len(parts) < 3:
            await message.answer("Использование: /take SBER 1.02")
            return
        ticker = parts[1].strip().upper()
        try:
            val = float(parts[2].strip())
        except ValueError:
            await message.answer("Значение должно быть числом: /take SBER 1.02")
            return
        _patch_overrides(ticker, long_take=str(val))
        await message.answer(f"⚙️ {ticker}: long_take → {val}. Применится на следующей свече.")

    @dp.message(Command("stop"))
    async def cmd_stop(message: Message) -> None:
        if not _allowed(message):
            return
        parts = (message.text or "").split(maxsplit=2)
        if len(parts) < 3:
            await message.answer("Использование: /stop SBER 0.98")
            return
        ticker = parts[1].strip().upper()
        try:
            val = float(parts[2].strip())
        except ValueError:
            await message.answer("Значение должно быть числом: /stop SBER 0.98")
            return
        _patch_overrides(ticker, long_stop=str(val))
        await message.answer(f"⚙️ {ticker}: long_stop → {val}. Применится на следующей свече.")

    @dp.message(Command("help"))
    async def cmd_help(message: Message) -> None:
        if not _allowed(message):
            return
        text = (
            "📋 <b>Команды бота</b>\n\n"
            "/status — состояние, открытые позиции, PnL\n"
            "/pause — приостановить открытие новых позиций\n"
            "/resume — возобновить торговлю\n"
            "/close TICKER|all — срочно закрыть позицию\n\n"
            "<b>Настройки (применяются на следующей свече):</b>\n"
            "/config — показать текущие переопределения\n"
            "/enable TICKER — включить тикер\n"
            "/disable TICKER — отключить тикер\n"
            "/signal TICKER on|off — signal-only режим\n"
            "/take TICKER VALUE — установить long_take (напр. 1.02)\n"
            "/stop TICKER VALUE — установить long_stop (напр. 0.98)\n"
        )
        await message.answer(text, parse_mode="HTML")

    return dp


async def run_control_listener(token: str, allowed_chat_id: str) -> None:
    bot = Bot(token=token)
    dp = _build_dispatcher(allowed_chat_id)
    logger.info("TG control listener: старт polling команд")
    try:
        await dp.start_polling(bot)
    except Exception:
        logger.exception("TG control listener: polling упал, перезапуск невозможен — проверьте токен/сеть")
        raise
    finally:
        await bot.session.close()
