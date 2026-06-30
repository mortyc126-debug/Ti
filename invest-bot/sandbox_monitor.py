"""
sandbox_monitor.py — Мониторинг sandbox-портфеля в реальном времени.

Запускается как asyncio-задача при TINKOFF_SANDBOX=1.
Каждые POLL_INTERVAL секунд (по умолчанию 15 мин) тянет актуальный
sandbox-портфель и отправляет сводку в Telegram.

Также предоставляет функцию get_portfolio_text() для ручного вызова
из дашборда или Telegram-команды /sandbox.

Зачем: при SIGNAL_ONLY=1 ордера не выставляются — нет сделок для трекинга.
При SIGNAL_ONLY=0 + TINKOFF_SANDBOX=1 реальные сделки идут в виртуальный
счёт; этот модуль показывает их ход в Telegram без лазания в API вручную.
"""

import asyncio
import logging
import os

from tinkoff.invest import Client
from tinkoff.invest.constants import INVEST_GRPC_API_SANDBOX

logger = logging.getLogger(__name__)

IS_SANDBOX = os.getenv("TINKOFF_SANDBOX") == "1"
POLL_INTERVAL = int(os.getenv("SANDBOX_MONITOR_INTERVAL", "900"))   # секунд (дефолт 15 мин)
STARTUP_DELAY = 90   # секунд после старта бота перед первым репортом


# ── Asyncio-задача ────────────────────────────────────────────────────────────

async def run_monitor(
    token: str,
    app_name: str,
    messages_queue: asyncio.Queue,
) -> None:
    """
    Фоновая задача мониторинга sandbox-портфеля.
    При TINKOFF_SANDBOX=0 сразу выходит (no-op).
    """
    if not IS_SANDBOX:
        return

    logger.info("sandbox_monitor: запущен (интервал %ds)", POLL_INTERVAL)
    await asyncio.sleep(STARTUP_DELAY)

    while True:
        try:
            text = get_portfolio_text(token, app_name)
            if text:
                await messages_queue.put(text)
                logger.debug("sandbox_monitor: репорт отправлен")
        except Exception as e:
            logger.warning("sandbox_monitor: ошибка репорта: %s", e)

        await asyncio.sleep(POLL_INTERVAL)


# ── Синхронный запрос портфеля ────────────────────────────────────────────────

def get_portfolio_text(token: str, app_name: str) -> str | None:
    """
    Синхронно запрашивает sandbox-портфель и возвращает форматированный текст.
    Возвращает None если данных нет или ошибка.
    Можно вызывать из синхронного контекста (дашборд, Telegram-команда /sandbox).
    """
    try:
        with Client(token, app_name=app_name, target=INVEST_GRPC_API_SANDBOX) as client:
            accounts = client.sandbox.get_sandbox_accounts().accounts
            if not accounts:
                return "🏖 Sandbox: нет счётов. Запусти sandbox_setup.py"
            account_id = accounts[0].id

            portfolio = client.sandbox.get_sandbox_portfolio(account_id=account_id)
            return _format_portfolio(portfolio, account_id)

    except Exception as e:
        logger.warning("sandbox_monitor get_portfolio: %s", e)
        return None


def _format_portfolio(portfolio, account_id: str) -> str:
    from datetime import datetime
    from tinkoff.invest.utils import quotation_to_decimal

    now = datetime.now().strftime("%H:%M:%S")

    def _q(val) -> float:
        try:
            return float(quotation_to_decimal(val))
        except Exception:
            return 0.0

    total_rub = _q(portfolio.total_amount_portfolio)
    expected_yield_pct = _q(portfolio.expected_yield)

    lines = [
        f"🏖 Sandbox {now} [acc: ...{account_id[-6:]}]",
        f"Портфель: {total_rub:,.0f} ₽  |  P&L: {expected_yield_pct:+.2f}%",
    ]

    positions = portfolio.positions
    if not positions:
        lines.append("Открытых позиций нет.")
        return "\n".join(lines)

    lines.append(f"Позиции ({len(positions)}):")
    for pos in positions:
        try:
            qty = pos.quantity.units if pos.quantity else 0
            avg = _q(pos.average_position_price)
            cur = _q(pos.current_price)
            pnl = _q(pos.expected_yield)
            figi_short = pos.figi[-8:] if pos.figi else "?"
            instr_type = (pos.instrument_type or "?")[:3].upper()
            pnl_sign = "+" if pnl >= 0 else ""
            lines.append(
                f"  {instr_type} {figi_short}: "
                f"{qty} × {avg:.2f} → {cur:.2f}  "
                f"({pnl_sign}{pnl:.0f} ₽)"
            )
        except Exception:
            pass

    return "\n".join(lines)


# ── Sandbox account discovery (helper для accounts_service) ───────────────────

def get_or_create_sandbox_account(token: str, app_name: str) -> str | None:
    """
    Возвращает id первого sandbox-счёта.
    Если счётов нет — создаёт новый и пополняет 100k ₽.
    """
    from tinkoff.invest import MoneyValue
    try:
        with Client(token, app_name=app_name, target=INVEST_GRPC_API_SANDBOX) as client:
            accounts = client.sandbox.get_sandbox_accounts().accounts
            if accounts:
                account_id = accounts[0].id
                logger.info(f"sandbox: найден счёт {account_id}")
                return account_id

            account_id = client.sandbox.open_sandbox_account().account_id
            client.sandbox.sandbox_pay_in(
                account_id=account_id,
                amount=MoneyValue(currency="rub", units=100_000, nano=0),
            )
            logger.info(f"sandbox: создан счёт {account_id}, зачислено 100 000 ₽")
            return account_id
    except Exception as e:
        logger.error(f"sandbox: get_or_create_account: {e}")
        return None
