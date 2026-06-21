"""
bot_control.py — общий рантайм-флаг для управления ботом через Telegram.

Trader (trading/trader.py) выставляет current_trader на старте торгового
дня и проверяет paused/close_requests на каждой свече. tg_api/tg_control.py
(приём команд /pause /resume /close /status) читает и пишет сюда же.
Один процесс, один event loop — без блокировок.
"""

__all__ = ("control",)


from dataclasses import dataclass, field
from decimal import Decimal


@dataclass
class AdoptRequest:
    ticker: str
    direction: str          # "LONG" или "SHORT"
    take: Decimal           # абсолютная цена тейка
    stop: Decimal           # абсолютная цена стопа
    entry: Decimal | None = None  # если None — возьмём текущую цену с биржи


class BotControl:
    def __init__(self) -> None:
        self.paused: bool = False
        self.close_requests: set[str] = set()  # тикеры или "ALL"
        self.adopt_requests: list[AdoptRequest] = []
        self.current_trader = None  # type: ignore


control = BotControl()
