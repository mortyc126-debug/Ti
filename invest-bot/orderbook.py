"""
orderbook.py — фоновый слой стакана (depth of market) через стрим Т-Инвестиции
(MarketDataStreamService.start_async_orderbook_stream, тот же gRPC-стрим, что
свечи, просто другая подписка). Включается/выключается с дашборда
(RuntimeOverrides.orderbook_enabled) — по умолчанию выключено, т.к. это
дополнительная живая подписка сверх свечной.

Задача: не просто imbalance (объём bid vs ask), а отличить "живую" защиту
уровня от "мёртвых" заявок, которые сбивают сильным движением. Левел
считается живым, только если его объём РЕАЛЬНО уменьшается/обновляется со
временем — если объём на уровне стоит неизменным много снэпшотов подряд, а
цена тем не менее идёт сквозь него, он помечается stale и не учитывается
в imbalance (см. _classify_levels).
"""
import logging
import time
from collections import deque
from dataclasses import dataclass, field

__all__ = ("OrderBookService",)

logger = logging.getLogger(__name__)

# Сколько последних снэпшотов на тикер держим для оценки "живости" уровня.
HISTORY_LEN = 30
# Уровень считается "мёртвым", если простоял без изменения объёма дольше
# этого числа снэпшотов подряд, пока находился в пределах STALE_PRICE_TOL
# от лучшей цены (т.е. был близко к месту движения, но никак не реагировал).
STALE_MIN_SNAPSHOTS = 8
STALE_PRICE_TOL = 0.002  # 0.2% от цены — "близко к движению"


@dataclass
class _LevelTrack:
    last_qty: float
    unchanged_count: int = 0


@dataclass
class _TickerState:
    snapshots: deque = field(default_factory=lambda: deque(maxlen=HISTORY_LEN))
    bid_tracks: dict[float, _LevelTrack] = field(default_factory=dict)
    ask_tracks: dict[float, _LevelTrack] = field(default_factory=dict)
    imbalance: float = 0.0
    stale_ratio: float = 0.0
    updated_ts: float = 0.0


def _update_tracks(tracks: dict[float, _LevelTrack], levels: list[tuple[float, float]]) -> None:
    seen = set()
    for price, qty in levels:
        seen.add(price)
        t = tracks.get(price)
        if t is None:
            tracks[price] = _LevelTrack(last_qty=qty)
            continue
        if qty == t.last_qty:
            t.unchanged_count += 1
        else:
            t.unchanged_count = 0
            t.last_qty = qty
    # уровни, исчезнувшие из стакана, больше не отслеживаем
    for price in list(tracks.keys()):
        if price not in seen:
            del tracks[price]


def _live_volume(tracks: dict[float, _LevelTrack], levels: list[tuple[float, float]],
                  best_price: float) -> tuple[float, float]:
    """(объём живых уровней, объём мёртвых уровней) среди levels."""
    live, dead = 0.0, 0.0
    for price, qty in levels:
        t = tracks.get(price)
        near_action = best_price > 0 and abs(price - best_price) / best_price <= STALE_PRICE_TOL
        if t and t.unchanged_count >= STALE_MIN_SNAPSHOTS and near_action:
            dead += qty
        else:
            live += qty
    return live, dead


class OrderBookService:
    """
    Потребляет async-генератор OrderBook (trader.py запускает фоновой
    task), хранит rolling-состояние по тикеру, отдаёт провайдеры:
    imbalance_score(ticker) -> [-1..1] (живой объём bid-ask, нормированный)
    stale_ratio(ticker) -> [0..1] доля объёма у лучших цен, который "мёртвый"
    """

    def __init__(self) -> None:
        self._state: dict[str, _TickerState] = {}

    def on_orderbook(self, ticker: str, bids: list[tuple[float, float]],
                       asks: list[tuple[float, float]]) -> None:
        """bids/asks — [(price, quantity), ...], от лучшей цены вглубь."""
        st = self._state.setdefault(ticker, _TickerState())
        _update_tracks(st.bid_tracks, bids)
        _update_tracks(st.ask_tracks, asks)

        best_bid = bids[0][0] if bids else 0.0
        best_ask = asks[0][0] if asks else 0.0
        mid = (best_bid + best_ask) / 2 if best_bid and best_ask else (best_bid or best_ask)

        bid_live, bid_dead = _live_volume(st.bid_tracks, bids, mid)
        ask_live, ask_dead = _live_volume(st.ask_tracks, asks, mid)

        total_live = bid_live + ask_live
        st.imbalance = (bid_live - ask_live) / total_live if total_live > 0 else 0.0

        total_vol = bid_live + ask_live + bid_dead + ask_dead
        st.stale_ratio = (bid_dead + ask_dead) / total_vol if total_vol > 0 else 0.0
        st.updated_ts = time.time()

    def imbalance_score(self, ticker: str) -> float:
        st = self._state.get(ticker)
        return st.imbalance if st else 0.0

    def stale_ratio(self, ticker: str) -> float:
        st = self._state.get(ticker)
        return st.stale_ratio if st else 0.0

    def has_data(self, ticker: str, max_age_s: float = 30.0) -> bool:
        st = self._state.get(ticker)
        return bool(st and st.updated_ts and (time.time() - st.updated_ts) <= max_age_s)
