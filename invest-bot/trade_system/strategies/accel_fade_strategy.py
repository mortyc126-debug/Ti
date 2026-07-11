"""AccelFadeStrategy — live-обёртка провалидированного сигнала «фейд климакса».

Гипотеза (проверена гонтлетом): аномальное ускорение ПО тренду — это климакс,
за которым разворот. Вход ПРОТИВ ускорения (fade). Умеренное ускорение не трогаем.

Эдж честный, в отличие от уровневого комбо:
  - вход РЫНОЧНЫЙ по закрытию спайк-бара, барьеры интрабар ОТ реальной цены входа
    (никакого недостижимого уровня);
  - издержки заложены явно; held-out (train<2026-04-01 | test≥) при cost 0.06 ATR:
    TRAIN +0.209 / TEST +0.148 на ячейке тейк1.0/стоп0.3, N_test≈59k. Точка
    безубытка по издержкам ≈0.20 ATR(5м) — для ликвидного фьюча с запасом.

Детектор бит-в-бит из accel_spike_test.py (interval=5м): accel_m=3, halflife=50,
n_atr=20, trend_w=50, порог аномалии 2.0. Условие входа полностью backward-looking
(anom/знак/тренд по прошлому и текущему бару) — look-ahead'а нет.
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

__all__ = ("AccelFadeStrategy",)

logger = logging.getLogger(__name__)

# Параметры детектора — ровно те, на которых считался эдж (5-минутный ТФ).
_ACCEL_M = 3           # окно ROC и разности для резкого ускорения
_EWM_HALFLIFE = 50.0   # полужизнь скользящей нормы |accel|
_N_ATR = 20
_TREND_W = 50          # окно знака тренда
_ANOM_MIN = 2.0        # порог аномалии для входа
# Лучшая ячейка гонтлета: тейк 1.0 ATR / стоп 0.3 ATR (от цены входа).
_TAKE_ATR = 1.0
_STOP_ATR = 0.3
# Фильтр новостей (прокси по объёму): спайк с объёмом ≥ X× недавней нормы — это
# сюрприз/новость (репрайс, не откатывает), fade таких втрое хуже. Проверено на
# истории: отсев поднял held-out test 0.148 → 0.168, новостные на тесных тейках в
# минус. Не интерпретируем новость — ловим её ОТПЕЧАТОК в объёме.
_NEWS_VOL_THR = 3.0
# Буфер: хватить на trend_w + n_atr + прогрев EWM-нормы; кап, чтобы recompute был быстрым.
_MIN_BUFFER_BARS = _TREND_W + _N_ATR + 4 * _ACCEL_M + 200   # ~прогрев EWM
_MAX_BUFFER_BARS = 6000


def _candle_to_bar(c: HistoricCandle) -> dict:
    return {
        "t": c.time,
        "h": float(quotation_to_decimal(c.high)),
        "l": float(quotation_to_decimal(c.low)),
        "c": float(quotation_to_decimal(c.close)),
        "v": float(c.volume),
    }


def _rmean(x: np.ndarray, n: int) -> np.ndarray:
    cs = np.cumsum(np.insert(x, 0, 0.0))
    out = np.full(len(x), np.nan)
    out[n - 1:] = (cs[n:] - cs[:-n]) / n
    return out


def _ewm_causal(x: np.ndarray, halflife: float) -> np.ndarray:
    """Причинное скользящее типичное значение (EWM) с пропуском ведущих NaN."""
    alpha = 1.0 - 0.5 ** (1.0 / halflife)
    out = np.full(len(x), np.nan)
    acc = None
    for i in range(len(x)):
        xi = x[i]
        if np.isnan(xi):
            continue
        acc = xi if acc is None else alpha * xi + (1 - alpha) * acc
        out[i] = acc
    return out


class AccelFadeStrategy(IStrategy):
    def __init__(self, settings=None) -> None:
        self._settings = settings
        self._bars: list[dict] = []
        self._short_enabled: bool = getattr(settings, "short_enabled_flag", True) if settings else True
        self._lot: int = 1
        self._hist_provider = None
        self._warmed: bool = False
        self._last_signal_t = None   # чтобы не эмитить один спайк-бар дважды

    @property
    def settings(self):
        return self._settings

    def update_lot_count(self, lot: int) -> None:
        self._lot = lot

    def update_short_status(self, status: bool) -> None:
        self._short_enabled = status

    def set_atr_history_provider(self, provider) -> None:
        """Трейдер даёт провайдер кэш-истории (тот же хук, что у Level/OI) —
        прогреваем буфер на старте, не ждём накопления живьём."""
        self._hist_provider = provider

    def _append(self, c: HistoricCandle) -> None:
        b = _candle_to_bar(c)
        if self._bars and b["t"] <= self._bars[-1]["t"]:
            return
        self._bars.append(b)

    def _warmup(self) -> None:
        self._warmed = True
        if not self._hist_provider or not self._settings:
            return
        try:
            hist = self._hist_provider(getattr(self._settings, "ticker", "")) or []
        except Exception as e:
            logger.warning("AccelFadeStrategy: прогрев истории не удался (%s)", e)
            return
        for c in sorted(hist, key=lambda x: x.time):
            self._append(c)
        if len(self._bars) > _MAX_BUFFER_BARS:
            self._bars = self._bars[-_MAX_BUFFER_BARS:]
        logger.info("AccelFadeStrategy: буфер прогрет историей — %d баров", len(self._bars))

    def analyze_candles(self, candles: list[HistoricCandle]) -> Optional[Signal]:
        if not self._warmed:
            self._warmup()
        for c in candles:
            self._append(c)
        if len(self._bars) > _MAX_BUFFER_BARS:
            self._bars = self._bars[-_MAX_BUFFER_BARS:]
        if len(self._bars) < _MIN_BUFFER_BARS:
            return None

        c = np.array([b["c"] for b in self._bars], float)
        h = np.array([b["h"] for b in self._bars], float)
        l = np.array([b["l"] for b in self._bars], float)
        n = len(c)
        m = _ACCEL_M

        # Резкое ускорение: v = ROC за m баров; accel = изменение v за m баров.
        v = np.full(n, np.nan)
        v[m:] = (c[m:] - c[:-m]) / c[:-m]
        accel = np.full(n, np.nan)
        accel[m:] = v[m:] - v[:-m]
        absacc = np.abs(accel)

        # Робастная аномалия: |accel| / недавнее типичное |accel| (причинно, сдвиг на 1).
        base = _ewm_causal(absacc, _EWM_HALFLIFE)
        base_prev = np.concatenate([[np.nan], base[:-1]])

        prev_c = np.concatenate([[c[0]], c[:-1]])
        tr = np.maximum(h - l, np.maximum(np.abs(h - prev_c), np.abs(l - prev_c)))
        atr = _rmean(tr, _N_ATR)

        i = n - 1                      # проверяем ПОСЛЕДНИЙ завершённый бар
        bp = base_prev[i]
        if not (np.isfinite(bp) and bp > 0):
            return None
        anom = absacc[i] / bp
        s = np.sign(accel[i])
        if i < _TREND_W:
            return None
        trend = np.sign(c[i] - c[i - _TREND_W])
        ai = atr[i]
        # Условие эджа: аномалия ≥ порога, ускорение ПО тренду, живой ATR.
        if not (np.isfinite(anom) and s != 0 and trend != 0
                and anom >= _ANOM_MIN and s == trend
                and np.isfinite(ai) and ai > 0):
            return None

        # ФИЛЬТР НОВОСТЕЙ (прокси по объёму): если объём спайк-бара ≥ порога от
        # недавней нормы — это сюрприз/репрайс, fade проигрывает. Отсекаем.
        vol = np.array([b["v"] for b in self._bars], float)
        vbase = _ewm_causal(vol, _EWM_HALFLIFE)
        if i >= 1 and np.isfinite(vbase[i - 1]) and vbase[i - 1] > 0:
            if vol[i] / vbase[i - 1] >= _NEWS_VOL_THR:
                logger.info("AccelFadeStrategy: спайк с новостным объёмом "
                            "(%.1f× нормы) — пропуск", vol[i] / vbase[i - 1])
                return None

        # один спайк-бар — один сигнал (analyze_candles может звать повторно на том же баре)
        t_now = self._bars[i]["t"]
        if self._last_signal_t is not None and t_now <= self._last_signal_t:
            return None

        fdir = -int(s)                 # fade = ПРОТИВ ускорения: +1 лонг / −1 шорт
        side_long = fdir > 0
        if not side_long and not self._short_enabled:
            return None                # шорты запрещены настройкой

        entry = Decimal(str(c[i]))
        atr_d = Decimal(str(ai))
        take = Decimal(str(_TAKE_ATR))
        stop = Decimal(str(_STOP_ATR))
        if side_long:
            stype = SignalType.LONG
            tp, sl = entry + take * atr_d, entry - stop * atr_d
        else:
            stype = SignalType.SHORT
            tp, sl = entry - take * atr_d, entry + stop * atr_d

        self._last_signal_t = t_now
        figi = getattr(self._settings, "figi", "") if self._settings else ""
        # entry_price=0 (default) → вход РЫНКОМ: fade надо брать сразу на спайке,
        # лимитка бы промахнулась; издержки учтены в валидации.
        signal = Signal(figi=figi, signal_type=stype,
                        take_profit_level=tp, stop_loss_level=sl)
        logger.info("AccelFadeStrategy signal: %s entry=%.6f anom=%.2f accel_sign=%d "
                    "trend=%d atr=%.6f", signal, c[i], anom, int(s), int(trend), ai)
        return signal
