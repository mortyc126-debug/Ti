"""
timeframe.py — даунсемплер 1min-свечей → 5min и 1h.

T-Invest API не поддерживает несколько интервалов в одной подписке, поэтому
бот работает только на 1min-стриме. Этот модуль агрегирует минутные свечи
в 5min и 1h-бары — для более стабильного определения режима рынка.

Принцип: 5 последовательных 1min-свечей = 1 завершённый 5min-бар.
60 последовательных 1min-свечей = 1 завершённый 1h-бар.

Завершённые бары хранятся в скользящем буфере заданного размера.
"""
from collections import defaultdict, deque
from dataclasses import dataclass
from typing import Optional

from tinkoff.invest import Candle
from tinkoff.invest.utils import quotation_to_decimal

__all__ = ("MultiTfBuffer", "AggCandle")


@dataclass
class AggCandle:
    """Агрегированная OHLCV-свеча из нескольких 1min-баров."""
    open: float
    high: float
    low: float
    close: float
    volume: int
    bar_count: int


class MultiTfBuffer:
    """
    Два независимых агрегатора на figi: 5min (5 баров) и 1h (60 баров).
    Готовые свечи хранятся в deque фиксированного размера.
    """

    def __init__(self, max_5min: int = 288, max_1h: int = 100):
        self._acc5: dict[str, list[Candle]] = defaultdict(list)
        self._acc1h: dict[str, list[Candle]] = defaultdict(list)
        self._done5: dict[str, deque] = defaultdict(lambda: deque(maxlen=max_5min))
        self._done1h: dict[str, deque] = defaultdict(lambda: deque(maxlen=max_1h))

    def push(self, candle: Candle) -> tuple[Optional[AggCandle], Optional[AggCandle]]:
        """
        Принимаем 1min-свечу. Возвращает (new_5min, new_1h):
        None если соответствующий тф ещё не закрылся.
        """
        figi = candle.figi
        new5 = new1h = None

        self._acc5[figi].append(candle)
        if len(self._acc5[figi]) >= 5:
            new5 = _aggregate(self._acc5[figi])
            self._done5[figi].append(new5)
            self._acc5[figi].clear()

        self._acc1h[figi].append(candle)
        if len(self._acc1h[figi]) >= 60:
            new1h = _aggregate(self._acc1h[figi])
            self._done1h[figi].append(new1h)
            self._acc1h[figi].clear()

        return new5, new1h

    def get_5min(self, figi: str) -> list[AggCandle]:
        return list(self._done5[figi])

    def get_1h(self, figi: str) -> list[AggCandle]:
        return list(self._done1h[figi])

    def closes_5min(self, figi: str) -> list[float]:
        return [c.close for c in self._done5[figi]]

    def closes_1h(self, figi: str) -> list[float]:
        return [c.close for c in self._done1h[figi]]

    def has_5min(self, figi: str, min_bars: int = 5) -> bool:
        return len(self._done5[figi]) >= min_bars

    def has_1h(self, figi: str, min_bars: int = 3) -> bool:
        return len(self._done1h[figi]) >= min_bars


def _aggregate(candles: list[Candle]) -> AggCandle:
    def f(q):
        return float(quotation_to_decimal(q))
    return AggCandle(
        open=f(candles[0].open),
        high=max(f(c.high) for c in candles),
        low=min(f(c.low) for c in candles),
        close=f(candles[-1].close),
        volume=sum(c.volume for c in candles),
        bar_count=len(candles),
    )
