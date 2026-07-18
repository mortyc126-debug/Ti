"""NWGlobalStrategy — live-стратегия кросс-тикерной NW-памяти из ГЛОБАЛЬНОГО банка.

Отличие от NWMemoryStrategy (per-ticker квадрант): память тут — ЕДИНЫЙ банк по
всем тикерам (nw_bank_build.py → data/nw_bank.npz), грузится один раз. Именно
эта версия валидирована в nw_backtest.py как ТОРГОВАЯ стратегия (не только IC):
после запрета перекрытия, интрабар тейк/стоп и реальных издержек шорт-сторона
даёт +0.083 ATR/сделку OOS на замороженном train-банке (live-путь, идентичен
inline-бэктесту +0.086). Чистая альфа +0.055 сверх беты и зоны (matched-null).

Решения зашиты по итогам исследования:
- ТОЛЬКО ШОРТ. Лонг-сторона в нуле (+0.005 ATR OOS) — торговать нечего, только
  разбавляет. Берём сигнал лишь когда p_hold<0.5 (память ждёт ход вниз).
- Выход ТЕЙК 1.0 / СТОП 0.5 ATR (в отличие от NWMemoryStrategy с горизонт-клоузом):
  именно эта сетка валидировалась в бэктесте, на ней получен эдж. ATR — Wilder(14)
  по true range, ровно как в nw_backtest._atr (иначе tp/sl уедут от валидации).
- Горизонт _MAX_HOLD баров как страховочный кап: если ни тейк, ни стоп не сработали,
  выходим по close (в бэктесте — тот же fallback min(i+maxhold)).
- Зона T̂<-0.4/P̂>0.6, радиус 0.12, ≥20 соседей — внутри NWMemoryGlobal.
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
from nw_memory_global import NWMemoryGlobal, _K as _MAX_HOLD

__all__ = ("NWGlobalStrategy",)

logger = logging.getLogger(__name__)

# Тейк/стоп в ATR — из валидированного бэктеста (take=1.0/stop=0.5).
_TAKE_ATR = 1.0
_STOP_ATR = 0.5
_ATR_N = 14  # Wilder, как nw_backtest._atr (НЕ SMA-20 из tpcolor — важно для tp/sl)
# Окно пересчёта осей на баре: NWMemoryGlobal.score() O(len). Осям последнего бара
# нужно ≥ ~720 валидных баров (w_norm+n_macro+k); берём с запасом.
_SCORE_WINDOW = 900
_MIN_SCORE_BARS = 750
_MAX_BUFFER_BARS = 20000


def _atr_wilder_last(bars: list[HistoricCandle]) -> Optional[float]:
    """ATR(_ATR_N) Wilder по последнему бару — ровно как nw_backtest._atr, чтобы
    tp/sl в ATR совпали с тем, на чём мерился эдж."""
    if len(bars) < _ATR_N + 2:
        return None
    h = np.array([float(quotation_to_decimal(b.high)) for b in bars], float)
    l = np.array([float(quotation_to_decimal(b.low)) for b in bars], float)
    c = np.array([float(quotation_to_decimal(b.close)) for b in bars], float)
    tr = np.empty(len(c))
    tr[0] = h[0] - l[0]
    tr[1:] = np.maximum.reduce([h[1:] - l[1:], np.abs(h[1:] - c[:-1]), np.abs(l[1:] - c[:-1])])
    atr = tr[1:_ATR_N + 1].mean()
    for i in range(_ATR_N + 1, len(tr)):
        atr = (atr * (_ATR_N - 1) + tr[i]) / _ATR_N
    return float(atr) if np.isfinite(atr) and atr > 0 else None


class NWGlobalStrategy(IStrategy):
    def __init__(self, settings=None) -> None:
        self._settings = settings
        self._bars: list[HistoricCandle] = []
        self._short_enabled: bool = getattr(settings, "short_enabled_flag", True) if settings else True
        self._lot: int = 1
        self._hist_provider = None
        self._warmed: bool = False
        self._memory: Optional[NWMemoryGlobal] = None
        # Учёт удержания: пока держим шорт — считаем бары до _MAX_HOLD, вход не ищем.
        self._open_dir: int = 0
        self._bars_since_entry: int = 0
        self._last_bar_t = None

    @property
    def settings(self):
        return self._settings

    def update_lot_count(self, lot: int) -> None:
        self._lot = lot

    def update_short_status(self, status: bool) -> None:
        self._short_enabled = status

    def set_atr_history_provider(self, provider) -> None:
        """Трейдер даёт провайдер кэш-истории (тот же хук, что у Accel/NWMemory) —
        прогреваем буфер на старте для расчёта осей, не ждём накопления живьём."""
        self._hist_provider = provider

    def _append(self, c: HistoricCandle) -> bool:
        if self._bars and c.time <= self._bars[-1].time:
            return False
        self._bars.append(c)
        return True

    def _warmup(self) -> None:
        self._warmed = True
        # Глобальный банк один на все тикеры — грузим из .npz один раз.
        self._memory = NWMemoryGlobal.load()
        if self._memory is None:
            logger.warning("NWGlobalStrategy: банк не загружен (нет data/nw_bank.npz "
                           "или scipy/numpy) — метод молчит")
        else:
            logger.info("NWGlobalStrategy: банк загружен, точек=%d", len(self._memory.y))
        if not self._hist_provider or not self._settings:
            return
        try:
            hist = self._hist_provider(getattr(self._settings, "ticker", "")) or []
        except Exception as e:
            logger.warning("NWGlobalStrategy: прогрев истории не удался (%s)", e)
            return
        for c in sorted(hist, key=lambda x: x.time):
            self._append(c)
        if len(self._bars) > _MAX_BUFFER_BARS:
            self._bars = self._bars[-_MAX_BUFFER_BARS:]

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
            # Горячая перезагрузка банка при смене торгового дня: ночной
            # nw_bank_refresh пересобрал .npz → подхватываем без перезапуска бота.
            if self._memory is not None and self._last_bar_t is not None \
                    and getattr(cur_t, "date", lambda: None)() != getattr(self._last_bar_t, "date", lambda: None)():
                if self._memory.maybe_reload():
                    logger.info("NWGlobalStrategy: банк обновлён, перезагружен (точек=%d)",
                                len(self._memory.y))
            self._last_bar_t = cur_t

        # Держим шорт → считаем бары до горизонта, вход не ищем. Тейк/стоп закроют
        # раньше через выставленные уровни; это лишь страховочный кап по времени.
        if self._open_dir != 0:
            if is_fresh:
                self._bars_since_entry += 1
            if self._bars_since_entry >= _MAX_HOLD:
                self._open_dir = 0
                self._bars_since_entry = 0
                figi = getattr(self._settings, "figi", "") if self._settings else ""
                logger.info("NWGlobalStrategy: горизонт %d баров пройден — CLOSE", _MAX_HOLD)
                return Signal(figi=figi, signal_type=SignalType.CLOSE)
            return None

        if self._memory is None or not is_fresh:
            return None
        if len(self._bars) < _MIN_SCORE_BARS:
            return None
        if not self._short_enabled:  # стратегия шорт-онли — без шортов молчим
            return None

        tail = self._bars[-_SCORE_WINDOW:]
        score = self._memory.score(tail)
        # ТОЛЬКО ШОРТ: берём сигнал лишь когда память ждёт ход ВНИЗ (p_hold<0.5 → score<0).
        if score >= 0.0:
            return None

        atr = _atr_wilder_last(self._bars)
        if atr is None:
            return None

        entry = Decimal(str(float(quotation_to_decimal(self._bars[-1].close))))
        tp = entry - Decimal(str(_TAKE_ATR)) * Decimal(str(atr))  # шорт: тейк ниже
        sl = entry + Decimal(str(_STOP_ATR)) * Decimal(str(atr))  # стоп выше

        self._open_dir = -1
        self._bars_since_entry = 0
        figi = getattr(self._settings, "figi", "") if self._settings else ""
        # entry_price=0 → вход РЫНКОМ по закрытию бара (как мерилось офлайн).
        signal = Signal(figi=figi, signal_type=SignalType.SHORT,
                        take_profit_level=tp, stop_loss_level=sl)
        logger.info("NWGlobalStrategy signal: SHORT entry=%.6f score=%.3f p_hold=%.3f atr=%.6f tp=%.6f sl=%.6f",
                    float(entry), score, 0.5 * (score + 1.0), atr, float(tp), float(sl))
        return signal
