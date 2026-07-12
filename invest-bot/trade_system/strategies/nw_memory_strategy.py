"""NWMemoryStrategy — live-обёртка NW-памяти T/P/color (Layer 4 / §11 концепции
kontseptsiya_temperatura_davlenie_pamyat_2.md).

Гипотеза (валидирована walk-forward, docs/NW_MEMORY_FINDINGS.md): в квадранте
«низкая T + высокая P» (lowT_highP @ t_pctl5/p_pctl90) историческая NW-память
по (T̂,P̂,color̂) предсказывает знак хода на 12 баров вперёд. Batch по 29
глубоким тикерам: 20/29 (69%) edge_raw>0 на holdout, медиана +0.26 ATR;
overfit'а нет (совпало с in-sample). Сильнее на неликвиде, слабеет на ликвиде
(на топ-ликвиде p_hold≈0.5 → голос≈0 сам собой; SBER-класс инвертирован —
память отразит p_hold<0.5 естественно, отдельно не трогаем).

Движок — `nw_memory_live.NWMemory` (тот же расчёт осей, что валидировался
офлайн). Строим память ОДИН РАЗ на тикер из прогретой истории, дальше на каждом
баре быстрый голос по recent-хвосту.

ЧЕСТНЫЙ ВЫХОД. Офлайн эдж мерился как СРОЧНЫЙ выход через k=12 баров
(direction × fwd_ret_k), гейт |p_hold−0.5|>0.10, БЕЗ тейк/стопа. Здесь так же:
вход рынком по закрытию, держим ровно _K баров → CLOSE. Тейк/стоп широкие
(_GUARD_ATR) — только страховочные рельсы от катастрофы, не торговый выход;
именно поэтому НЕ переносим сюда невалидированную тейк/стоп-сетку (та ошибка
похоронила уровневый комбо). Голосуем редко и точно: квадрант ~0.5% баров.
"""
from __future__ import annotations

import logging
from decimal import Decimal
from typing import Optional

import numpy as np
from tinkoff.invest import HistoricCandle
from tinkoff.invest.utils import quotation_to_decimal

from trade_system.signal import Signal, SignalType
from trade_system.strategies.base_strategy import IStrategy
from nw_memory_live import NWMemory, _K as _HORIZON, _N as _N_ATR

__all__ = ("NWMemoryStrategy",)

logger = logging.getLogger(__name__)

# Гейт входа: |score| ≥ _GATE. score = 2·p_hold−1, поэтому 0.20 == |p_hold−0.5|>0.10
# (порог «открыть позицию» из nw_memory.py --confidence 0.10).
_GATE = 0.20
# Окно для пересчёта осей на баре: NWMemory.score() O(len). Осям последнего бара
# нужно ≥ ~720 валидных баров (w_norm+n_macro+k); берём с запасом.
_SCORE_WINDOW = 900
_MIN_SCORE_BARS = 750
# Память строим на всей прогретой истории (глубина нужна для квадранта);
# кап буфера — чтобы rebuild/score не разрастались.
_MAX_BUFFER_BARS = 20000
# Страховочные барьеры (НЕ торговый выход): широкий тейк/стоп, чтобы выход
# случался по горизонту _HORIZON, а не по барьеру. fwd_ret 12 баров редко >3 ATR.
_GUARD_ATR = 3.0


def _rmean(x: np.ndarray, n: int) -> np.ndarray:
    cs = np.cumsum(np.insert(x, 0, 0.0))
    out = np.full(len(x), np.nan)
    out[n - 1:] = (cs[n:] - cs[:-n]) / n
    return out


def _atr_last(bars: list[HistoricCandle]) -> Optional[float]:
    """ATR(_N_ATR) по последнему бару буфера для страховочных барьеров."""
    if len(bars) < _N_ATR + 1:
        return None
    h = np.array([float(quotation_to_decimal(b.high)) for b in bars], float)
    l = np.array([float(quotation_to_decimal(b.low)) for b in bars], float)
    c = np.array([float(quotation_to_decimal(b.close)) for b in bars], float)
    prev_c = np.concatenate([[c[0]], c[:-1]])
    tr = np.maximum(h - l, np.maximum(np.abs(h - prev_c), np.abs(l - prev_c)))
    a = _rmean(tr, _N_ATR)[-1]
    return float(a) if np.isfinite(a) and a > 0 else None


class NWMemoryStrategy(IStrategy):
    def __init__(self, settings=None) -> None:
        self._settings = settings
        self._bars: list[HistoricCandle] = []
        self._short_enabled: bool = getattr(settings, "short_enabled_flag", True) if settings else True
        self._lot: int = 1
        self._hist_provider = None
        self._warmed: bool = False
        self._memory: Optional[NWMemory] = None
        # Учёт удержания: пока держим — считаем бары до _HORIZON, вход не ищем.
        self._open_dir: int = 0        # +1 long / −1 short / 0 нет позиции
        self._bars_since_entry: int = 0
        self._last_bar_t = None        # для инкремента по НОВЫМ барам

    @property
    def settings(self):
        return self._settings

    def update_lot_count(self, lot: int) -> None:
        self._lot = lot

    def update_short_status(self, status: bool) -> None:
        self._short_enabled = status

    def set_atr_history_provider(self, provider) -> None:
        """Трейдер даёт провайдер кэш-истории (тот же хук, что у Accel/Level) —
        строим память на старте, не ждём накопления живьём."""
        self._hist_provider = provider

    def _append(self, c: HistoricCandle) -> bool:
        """True если бар новый (по времени)."""
        if self._bars and c.time <= self._bars[-1].time:
            return False
        self._bars.append(c)
        return True

    def _warmup(self) -> None:
        self._warmed = True
        if not self._hist_provider or not self._settings:
            return
        try:
            hist = self._hist_provider(getattr(self._settings, "ticker", "")) or []
        except Exception as e:
            logger.warning("NWMemoryStrategy: прогрев истории не удался (%s)", e)
            return
        for c in sorted(hist, key=lambda x: x.time):
            self._append(c)
        if len(self._bars) > _MAX_BUFFER_BARS:
            self._bars = self._bars[-_MAX_BUFFER_BARS:]
        self._build_memory()

    def _build_memory(self) -> None:
        """Строит NW-память по всему буферу. None → метод молчит (мало истории/
        точек в квадранте, нет numpy)."""
        self._memory = NWMemory.build(self._bars)
        if self._memory is None:
            logger.info("NWMemoryStrategy: память не построена (мало истории/квадранта) — молчим")
        else:
            logger.info("NWMemoryStrategy: память построена, точек квадранта=%d",
                        len(self._memory.tgt_pos))

    def analyze_candles(self, candles: list[HistoricCandle]) -> Optional[Signal]:
        if not self._warmed:
            self._warmup()

        new_bar = False
        for c in candles:
            if self._append(c):
                new_bar = True
        if len(self._bars) > _MAX_BUFFER_BARS:
            self._bars = self._bars[-_MAX_BUFFER_BARS:]

        cur_t = self._bars[-1].time if self._bars else None
        is_fresh = new_bar and cur_t is not None and cur_t != self._last_bar_t
        if is_fresh:
            self._last_bar_t = cur_t

        # Держим позицию → считаем бары до горизонта, вход не ищем.
        if self._open_dir != 0:
            if is_fresh:
                self._bars_since_entry += 1
            if self._bars_since_entry >= _HORIZON:
                self._open_dir = 0
                self._bars_since_entry = 0
                figi = getattr(self._settings, "figi", "") if self._settings else ""
                logger.info("NWMemoryStrategy: горизонт %d баров пройден — CLOSE", _HORIZON)
                return Signal(figi=figi, signal_type=SignalType.CLOSE)
            return None

        if self._memory is None or not is_fresh:
            return None
        if len(self._bars) < _MIN_SCORE_BARS:
            return None

        tail = self._bars[-_SCORE_WINDOW:]
        score = self._memory.score(tail)
        if abs(score) < _GATE:
            return None

        atr = _atr_last(self._bars)
        if atr is None:
            return None

        side_long = score > 0     # p_hold>0.5 → ждём ход вверх → лонг
        if not side_long and not self._short_enabled:
            return None

        entry = Decimal(str(float(quotation_to_decimal(self._bars[-1].close))))
        guard = Decimal(str(_GUARD_ATR)) * Decimal(str(atr))
        if side_long:
            stype = SignalType.LONG
            tp, sl = entry + guard, entry - guard
        else:
            stype = SignalType.SHORT
            tp, sl = entry - guard, entry + guard

        self._open_dir = 1 if side_long else -1
        self._bars_since_entry = 0
        figi = getattr(self._settings, "figi", "") if self._settings else ""
        # entry_price=0 → вход РЫНКОМ по закрытию бара (как мерилось офлайн:
        # direction × fwd_ret_k от close; лимитка исказила бы срочный горизонт).
        signal = Signal(figi=figi, signal_type=stype,
                        take_profit_level=tp, stop_loss_level=sl)
        logger.info("NWMemoryStrategy signal: %s entry=%.6f score=%.3f p_hold=%.3f atr=%.6f",
                    signal, float(entry), score, 0.5 * (score + 1.0), atr)
        return signal
