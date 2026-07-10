"""LevelReactionStrategy — live-обёртка провалидированного уровневого сигнала
«подтверждённый откат» (combo: быстрый подход + память уровня + чистое касание).

Эдж проверен гонтлетом (интрабар тейк/стоп, без перекрытия, held-out train≈test
+0.35 ATR). Торгуемая логика — ТА ЖЕ, что валидировали: стратегия гоняет
level_reaction_dataset.collect по скользящему буферу и ловит момент ПОДТВЕРЖДЕНИЯ
эпизода (confirm_sink). Вход в этот момент backward-looking — forward-резолв для
входа не нужен, look-ahead'а нет. Эквивалентность live≡офлайн доказана тестом
(совпадение по (confirm_bar, level_price), 0 расхождений полей).

Вход: LONG на support, SHORT на resistance. Тейк/стоп от УРОВНЯ (не от входа):
+1.0 ATR / −0.3 ATR — ровно BOUNCE_ATR/BREAK_ATR из определения сигнала.
"""
from __future__ import annotations

import logging
from decimal import Decimal
from typing import Optional

from tinkoff.invest import HistoricCandle
from tinkoff.invest.utils import quotation_to_decimal

from trade_system.signal import Signal, SignalType
from trade_system.strategies.base_strategy import IStrategy

import level_reaction_dataset as lr

__all__ = ("LevelReactionStrategy",)

logger = logging.getLogger(__name__)

# Тейк/стоп в ATR от уровня — из определения сигнала (BOUNCE_ATR / BREAK_ATR).
_TAKE_ATR = 1.0
_STOP_ATR = 0.3
# Порог буфера: уровневой памяти нужно достаточно истории. Кап, чтобы collect не
# считался слишком долго (5-мин cadence — считаем весь буфер раз в бар).
_MAX_BUFFER_BARS = 8000       # ~90 торговых дней 5-минуток
_MIN_BUFFER_BARS = 1200       # пока меньше — сигналов не даём (мало дневных баров)


def _candle_to_bar(c: HistoricCandle) -> dict:
    return {
        "t": c.time,
        "o": float(quotation_to_decimal(c.open)),
        "h": float(quotation_to_decimal(c.high)),
        "l": float(quotation_to_decimal(c.low)),
        "c": float(quotation_to_decimal(c.close)),
        "v": float(c.volume),
        "d": c.time.astimezone(lr.MSK).date(),
    }


def _combo(s: dict) -> bool:
    """Тот же фиксированный combo-фильтр, что провалидирован в _combo_filter."""
    return (s["approach_v6"] >= 0.6
            and (s["touches_before"] >= 1 or s["prev_outcome"] == "break")
            and s["penetration_atr"] < 0)


class LevelReactionStrategy(IStrategy):
    def __init__(self, settings=None) -> None:
        self._settings = settings
        self._bars: list[dict] = []
        self._short_enabled: bool = True
        self._lot: int = 1

    @property
    def settings(self):
        return self._settings

    def update_lot_count(self, lot: int) -> None:
        self._lot = lot

    def update_short_status(self, status: bool) -> None:
        self._short_enabled = status

    def analyze_candles(self, candles: list[HistoricCandle]) -> Optional[Signal]:
        prev_n = len(self._bars)
        self._bars.extend(_candle_to_bar(c) for c in candles)
        if len(self._bars) > _MAX_BUFFER_BARS:
            drop = len(self._bars) - _MAX_BUFFER_BARS
            self._bars = self._bars[drop:]
            prev_n = max(0, prev_n - drop)
        if len(self._bars) < _MIN_BUFFER_BARS:
            return None

        sink: list[dict] = []
        try:
            lr.collect(self._bars, round_valid_from=self._bars[0]["d"], confirm_sink=sink)
        except SystemExit:
            return None   # мало дневных баров — collect ругается, ждём накопления

        # интересуют только подтверждения на СВЕЖИХ барах этого вызова, прошедшие combo
        fresh = [s for s in sink if s["confirm_bar"] >= prev_n and _combo(s)]
        if not fresh:
            return None
        # если несколько — берём самый свежий, среди равных — сильнейший уровень
        sig = max(fresh, key=lambda s: (s["confirm_bar"], s["strength"]))

        side_long = sig["side"] == "support"
        if not side_long and not self._short_enabled:
            return None   # шорты запрещены настройкой — resistance-вход пропускаем

        level = Decimal(str(sig["level_price"]))
        atr = Decimal(str(sig["atr"]))
        take = Decimal(str(_TAKE_ATR))
        stop = Decimal(str(_STOP_ATR))
        if side_long:
            stype = SignalType.LONG
            tp, sl = level + take * atr, level - stop * atr
        else:
            stype = SignalType.SHORT
            tp, sl = level - take * atr, level + stop * atr

        figi = getattr(self._settings, "figi", "") if self._settings else ""
        signal = Signal(figi=figi, signal_type=stype, take_profit_level=tp, stop_loss_level=sl)
        logger.info("LevelReactionStrategy signal: %s level=%s kind=%s v6=%.2f "
                    "tb=%d prev=%s pen=%.2f", signal, sig["level_price"], sig["kind"],
                    sig["approach_v6"], sig["touches_before"], sig["prev_outcome"],
                    sig["penetration_atr"])
        return signal
