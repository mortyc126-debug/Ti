"""
HierarchicalStrategy — 4-слойная иерархическая стратегия.

Архитектура:
  D1  (контекст/bias)  — EMA20, структура цены (HH/HL vs LH/LL), ATR(14)
  H1  (уровень/гипотеза) — откат к уровню свинга H1, глубина 25–70% свинга, R:R ≥1.5
  M5  (триггер)        — вход на старте ATR-волны (<60% дневного ATR от экстремума),
                          разворотная свеча (тело ≥30%), объём ≥80% среднего
  Exit                 — структурный стоп (свинг M5 ± 0.08%), цель D1-структурная

Ресэмплинг делается один раз в `backtest_scan_signals`, затем при обходе
M5-баров индексы D1/H1 двигаются вперёд без повторного перебора.
"""
from __future__ import annotations

import logging
import math
import statistics
from dataclasses import dataclass, field
from datetime import datetime, timezone
from decimal import Decimal
from typing import Optional

from tinkoff.invest import HistoricCandle

from trade_system.signal import Signal, SignalType

__all__ = ("HierarchicalStrategy",)

logger = logging.getLogger(__name__)

# ── константы таймфреймов ────────────────────────────────────────────────────
_D1_MIN = 840      # торговый день РФ: 10:00–18:50 МСК (~840 мин)
_H1_MIN = 60
_M5_MIN = 5

# ── параметры стратегии ───────────────────────────────────────────────────────
_EMA_PERIOD = 20
_ATR_PERIOD = 14
_SWING_LOOKBACK = 5        # полуокно для поиска свинга (слева и справа)
_PULLBACK_MIN = 0.25       # минимальная глубина отката от свинга (доля)
_PULLBACK_MAX = 0.70       # максимальная глубина (дальше — слом структуры)
_WAVE_MAX_PCT = 0.60       # вход только если прошли <60% дневного ATR
_BODY_MIN_RATIO = 0.30     # тело разворотной свечи ≥ 30% от high-low
_VOL_MIN_RATIO = 0.80      # объём ≥ 80% скользящего среднего объёма
_VOL_MA_PERIOD = 20
_MIN_RR = 1.5              # минимальное R:R (цель / стоп)
_STRUCT_BUF = 0.0008       # буфер структурного стопа (0.08%)


# ── примитивные типы данных ───────────────────────────────────────────────────

@dataclass
class Bar:
    time: datetime
    open: float
    high: float
    low: float
    close: float
    volume: float


@dataclass
class D1Context:
    bias: int          # +1 LONG, -1 SHORT, 0 нейтрально
    atr: float
    ema: float
    swing_high: float  # ближайший структурный максимум
    swing_low: float   # ближайший структурный минимум


@dataclass
class H1Setup:
    direction: int     # +1 / -1
    level: float       # уровень входа (граница зоны отката)
    target: float      # структурная цель D1
    stop_ref: float    # ориентировочный стоп (уточняется на M5)
    rr: float


@dataclass
class M5Trigger:
    direction: int
    entry: float
    stop: float        # структурный стоп (свинг M5 ± buffer)
    target: float
    bar_idx: int       # индекс в M5-массиве


# ── вспомогательные функции ───────────────────────────────────────────────────

def _candle_to_bar(c: HistoricCandle) -> Bar:
    def _f(q) -> float:
        try:
            from tinkoff.invest.utils import quotation_to_decimal
            return float(quotation_to_decimal(q))
        except Exception:
            return float(getattr(q, "units", 0)) + getattr(q, "nano", 0) * 1e-9

    return Bar(
        time=c.time if isinstance(c.time, datetime) else c.time,
        open=_f(c.open),
        high=_f(c.high),
        low=_f(c.low),
        close=_f(c.close),
        volume=float(c.volume),
    )


def _resample(bars: list[Bar], tf_minutes: int) -> list[Bar]:
    """Схлопывает M5-бары в бары нужного таймфрейма."""
    if not bars:
        return []
    result: list[Bar] = []
    bucket: list[Bar] = []

    def _flush(b: list[Bar]) -> Bar:
        return Bar(
            time=b[0].time,
            open=b[0].open,
            high=max(x.high for x in b),
            low=min(x.low for x in b),
            close=b[-1].close,
            volume=sum(x.volume for x in b),
        )

    # выравниваем по границе TF
    for bar in bars:
        minutes_since_midnight = bar.time.hour * 60 + bar.time.minute
        slot = (minutes_since_midnight // tf_minutes) * tf_minutes
        if bucket:
            prev_slot = (bucket[0].time.hour * 60 + bucket[0].time.minute) // tf_minutes * tf_minutes
            # новый день или новый слот → сбрасываем
            if bar.time.date() != bucket[0].time.date() or slot != prev_slot:
                result.append(_flush(bucket))
                bucket = []
        bucket.append(bar)
    if bucket:
        result.append(_flush(bucket))
    return result


def _ema(values: list[float], period: int) -> list[float]:
    if not values:
        return []
    k = 2.0 / (period + 1)
    out = [values[0]]
    for v in values[1:]:
        out.append(v * k + out[-1] * (1 - k))
    return out


def _atr(bars: list[Bar], period: int) -> list[float]:
    """Возвращает список ATR той же длины что и bars (первые period-1 = NaN)."""
    if len(bars) < 2:
        return [float("nan")] * len(bars)
    trs = [float("nan")]
    for i in range(1, len(bars)):
        tr = max(
            bars[i].high - bars[i].low,
            abs(bars[i].high - bars[i - 1].close),
            abs(bars[i].low - bars[i - 1].close),
        )
        trs.append(tr)
    # RMA (Wilder MA)
    out: list[float] = [float("nan")] * len(bars)
    # первое значение — простое среднее за period
    if len(trs) >= period + 1:
        first = sum(trs[1: period + 1]) / period
        out[period] = first
        for i in range(period + 1, len(trs)):
            out[i] = (out[i - 1] * (period - 1) + trs[i]) / period
    return out


def _swings(bars: list[Bar], lookback: int = _SWING_LOOKBACK) -> tuple[list[float], list[float]]:
    """Возвращает (swing_highs, swing_lows) — списки той же длины.
    В позиции i стоит nan, если i не является свингом, иначе — значение экстремума.
    """
    n = len(bars)
    sh = [float("nan")] * n
    sl = [float("nan")] * n
    for i in range(lookback, n - lookback):
        if all(bars[i].high >= bars[i - j].high for j in range(1, lookback + 1)) and \
           all(bars[i].high >= bars[i + j].high for j in range(1, lookback + 1)):
            sh[i] = bars[i].high
        if all(bars[i].low <= bars[i - j].low for j in range(1, lookback + 1)) and \
           all(bars[i].low <= bars[i + j].low for j in range(1, lookback + 1)):
            sl[i] = bars[i].low
    return sh, sl


def _last_valid(values: list[float], up_to: int) -> float:
    """Последнее не-nan значение в values[:up_to+1]."""
    for i in range(up_to, -1, -1):
        if not math.isnan(values[i]):
            return values[i]
    return float("nan")


# ── слои анализа ──────────────────────────────────────────────────────────────

def _d1_context(d1_bars: list[Bar], idx: int) -> Optional[D1Context]:
    """Вычисляет D1-контекст по барам до idx включительно."""
    if idx < _EMA_PERIOD + _ATR_PERIOD:
        return None

    closes = [b.close for b in d1_bars[: idx + 1]]
    ema_series = _ema(closes, _EMA_PERIOD)
    atr_series = _atr(d1_bars[: idx + 1], _ATR_PERIOD)

    ema = ema_series[-1]
    atr = atr_series[-1]
    if math.isnan(atr) or atr <= 0:
        return None

    sh, sl = _swings(d1_bars[: idx + 1])
    last_sh = _last_valid(sh, idx)
    last_sl = _last_valid(sl, idx)

    close = d1_bars[idx].close

    # bias: цена выше EMA → потенциально LONG; структура HH/HL
    if close > ema and not math.isnan(last_sh) and not math.isnan(last_sl):
        # ищем предыдущий swing high перед last_sh
        prev_sh = float("nan")
        for i in range(idx - 1, -1, -1):
            if not math.isnan(sh[i]) and d1_bars[i].high < d1_bars[sh.index(last_sh) if last_sh in sh else idx].high:
                prev_sh = sh[i]
                break
        # HH = последний свинг-хай выше предыдущего
        bias = 1 if (math.isnan(prev_sh) or last_sh > prev_sh) else 0
    elif close < ema and not math.isnan(last_sh) and not math.isnan(last_sl):
        prev_sl = float("nan")
        for i in range(idx - 1, -1, -1):
            if not math.isnan(sl[i]) and sl[i] > last_sl:
                prev_sl = sl[i]
                break
        bias = -1 if (math.isnan(prev_sl) or last_sl < prev_sl) else 0
    else:
        bias = 0

    return D1Context(
        bias=bias,
        atr=atr,
        ema=ema,
        swing_high=last_sh if not math.isnan(last_sh) else close,
        swing_low=last_sl if not math.isnan(last_sl) else close,
    )


def _h1_setup(h1_bars: list[Bar], idx: int, d1: D1Context) -> Optional[H1Setup]:
    """Ищет откат к уровню H1-свинга в направлении D1-bias."""
    if d1.bias == 0 or idx < _SWING_LOOKBACK * 2:
        return None

    sh, sl = _swings(h1_bars[: idx + 1])
    close = h1_bars[idx].close

    if d1.bias == 1:
        # LONG: ищем откат к ближайшему H1 swing low
        level = _last_valid(sl, idx)
        if math.isnan(level):
            return None
        target = d1.swing_high
        swing_range = d1.swing_high - d1.swing_low
        if swing_range <= 0:
            return None
        depth = (d1.swing_high - close) / swing_range
        if not (_PULLBACK_MIN <= depth <= _PULLBACK_MAX):
            return None
        stop_ref = level - d1.atr * 0.3
        risk = close - stop_ref
        reward = target - close
    else:
        # SHORT: откат к ближайшему H1 swing high
        level = _last_valid(sh, idx)
        if math.isnan(level):
            return None
        target = d1.swing_low
        swing_range = d1.swing_high - d1.swing_low
        if swing_range <= 0:
            return None
        depth = (close - d1.swing_low) / swing_range
        if not (_PULLBACK_MIN <= depth <= _PULLBACK_MAX):
            return None
        stop_ref = level + d1.atr * 0.3
        risk = stop_ref - close
        reward = close - target

    if risk <= 0 or reward <= 0:
        return None
    rr = reward / risk
    if rr < _MIN_RR:
        return None

    return H1Setup(
        direction=d1.bias,
        level=level,
        target=target,
        stop_ref=stop_ref,
        rr=rr,
    )


def _m5_trigger(m5_bars: list[Bar], idx: int, h1: H1Setup, d1_atr: float) -> Optional[M5Trigger]:
    """Проверяет триггер на M5: волна ATR, разворотная свеча, объём."""
    if idx < _VOL_MA_PERIOD + _SWING_LOOKBACK:
        return None

    bar = m5_bars[idx]

    # объём ≥ 80% среднего
    vol_avg = statistics.mean(b.volume for b in m5_bars[max(0, idx - _VOL_MA_PERIOD): idx])
    if vol_avg > 0 and bar.volume < _VOL_MIN_RATIO * vol_avg:
        return None

    # тело разворотной свечи ≥ 30% диапазона
    bar_range = bar.high - bar.low
    if bar_range <= 0:
        return None
    body = abs(bar.close - bar.open)
    if body / bar_range < _BODY_MIN_RATIO:
        return None

    # направление тела должно совпадать с h1.direction
    if h1.direction == 1 and bar.close <= bar.open:
        return None
    if h1.direction == -1 and bar.close >= bar.open:
        return None

    # поиск ближайшего экстремума M5 для оценки позиции в ATR-волне
    sh, sl = _swings(m5_bars[: idx + 1], lookback=3)
    if h1.direction == 1:
        wave_start = _last_valid(sl, idx)
        if math.isnan(wave_start):
            return None
        wave_traveled = bar.close - wave_start
    else:
        wave_start = _last_valid(sh, idx)
        if math.isnan(wave_start):
            return None
        wave_traveled = wave_start - bar.close

    if wave_traveled < 0:
        return None
    # волна не должна быть > _WAVE_MAX_PCT дневного ATR
    if wave_traveled > _WAVE_MAX_PCT * d1_atr:
        return None

    # структурный стоп: M5 свинг ± буфер
    if h1.direction == 1:
        stop = wave_start * (1 - _STRUCT_BUF)
    else:
        stop = wave_start * (1 + _STRUCT_BUF)

    entry = bar.close
    risk = abs(entry - stop)
    if risk <= 0:
        return None

    # цель из H1
    reward = abs(h1.target - entry)
    if reward / risk < _MIN_RR:
        return None

    return M5Trigger(
        direction=h1.direction,
        entry=entry,
        stop=stop,
        target=h1.target,
        bar_idx=idx,
    )


# ── основной класс ────────────────────────────────────────────────────────────

class HierarchicalStrategy:
    """
    Иерархическая стратегия D1→H1→M5.

    Не наследует IStrategy (не используется в live-боте напрямую),
    но предоставляет тот же API бэктеста что и OICompositeStrategy:
      backtest_scan_signals(candles) → list[dict]
      backtest_barriers(signals, candles, ...) → dict
    """

    def backtest_scan_signals(
        self,
        candles: list[HistoricCandle],
        figi: str = "",
    ) -> list[dict]:
        """Возвращает список сигналов-dict (те же поля что у OICompositeStrategy)."""
        if len(candles) < (_D1_MIN // _M5_MIN) * (_EMA_PERIOD + _ATR_PERIOD + 10):
            return []

        m5 = [_candle_to_bar(c) for c in candles]
        h1 = _resample(m5, _H1_MIN)
        d1 = _resample(m5, _D1_MIN)

        # индексы: для каждого M5-бара — индекс последнего завершённого D1/H1-бара
        def _tf_idx(m5_bars: list[Bar], tf_bars: list[Bar], m5_i: int) -> int:
            t = m5_bars[m5_i].time
            result = -1
            for j, b in enumerate(tf_bars):
                if b.time <= t:
                    result = j
                else:
                    break
            return result

        signals: list[dict] = []

        for i in range(_SWING_LOOKBACK + _VOL_MA_PERIOD + 1, len(m5)):
            d1_i = _tf_idx(m5, d1, i - 1)  # только завершённые бары
            h1_i = _tf_idx(m5, h1, i - 1)

            if d1_i < _EMA_PERIOD + _ATR_PERIOD:
                continue
            if h1_i < _SWING_LOOKBACK * 2:
                continue

            ctx = _d1_context(d1, d1_i)
            if ctx is None or ctx.bias == 0:
                continue

            setup = _h1_setup(h1, h1_i, ctx)
            if setup is None:
                continue

            trig = _m5_trigger(m5, i, setup, ctx.atr)
            if trig is None:
                continue

            direction = "LONG" if trig.direction == 1 else "SHORT"
            signals.append({
                "figi": figi,
                "time": m5[i].time,
                "direction": direction,
                "entry": trig.entry,
                "stop": trig.stop,
                "target": trig.target,
                "rr": abs(trig.target - trig.entry) / abs(trig.entry - trig.stop),
                "d1_bias": ctx.bias,
                "d1_atr": ctx.atr,
                "h1_level": setup.level,
                "wave_pct": (abs(trig.entry - (m5[i].low if trig.direction == 1 else m5[i].high))) / ctx.atr
                            if ctx.atr > 0 else 0,
                "bar_idx": i,
            })

        return signals

    def backtest_barriers(
        self,
        signals: list[dict],
        candles: list[HistoricCandle],
        atr_mult_tp: float = 3.0,
        atr_mult_sl: float = 1.0,
        max_hold_bars: int = 200,
    ) -> dict:
        """
        Симуляция сделок по структурным стопу и цели из сигналов.
        Возвращает dict совместимый с OICompositeStrategy.backtest_barriers.
        """
        if not signals or not candles:
            return {"trades": [], "stats": {}}

        m5 = [_candle_to_bar(c) for c in candles]

        trades: list[dict] = []
        in_trade = False
        next_entry_bar = 0

        for sig in signals:
            bar_idx = sig["bar_idx"]
            if bar_idx < next_entry_bar or in_trade:
                continue

            entry = sig["entry"]
            stop = sig["stop"]
            target = sig["target"]
            direction = sig["direction"]
            dir_sign = 1 if direction == "LONG" else -1

            # ищем выход в последующих M5-барах
            win = False
            exit_price = entry
            exit_bar = bar_idx
            exit_reason = "timeout"

            for j in range(bar_idx + 1, min(bar_idx + max_hold_bars + 1, len(m5))):
                bar = m5[j]
                if dir_sign == 1:
                    if bar.low <= stop:
                        exit_price = stop
                        exit_reason = "stop"
                        exit_bar = j
                        break
                    if bar.high >= target:
                        exit_price = target
                        win = True
                        exit_reason = "target"
                        exit_bar = j
                        break
                else:
                    if bar.high >= stop:
                        exit_price = stop
                        exit_reason = "stop"
                        exit_bar = j
                        break
                    if bar.low <= target:
                        exit_price = target
                        win = True
                        exit_reason = "target"
                        exit_bar = j
                        break
            else:
                exit_price = m5[min(bar_idx + max_hold_bars, len(m5) - 1)].close
                exit_reason = "timeout"
                win = (exit_price - entry) * dir_sign > 0

            pnl_pct = (exit_price - entry) / entry * dir_sign * 100

            trades.append({
                "time": sig["time"],
                "direction": direction,
                "entry": entry,
                "exit": exit_price,
                "stop": stop,
                "target": target,
                "win": win,
                "pnl_pct": pnl_pct,
                "exit_reason": exit_reason,
                "rr": sig.get("rr", 0),
                "d1_bias": sig.get("d1_bias", 0),
                "h1_level": sig.get("h1_level", 0),
                "wave_pct": sig.get("wave_pct", 0),
            })

            next_entry_bar = exit_bar + 1

        if not trades:
            return {"trades": [], "stats": {}}

        wins = [t for t in trades if t["win"]]
        losses = [t for t in trades if not t["win"]]
        total = len(trades)
        win_rate = len(wins) / total if total else 0
        avg_win = statistics.mean(t["pnl_pct"] for t in wins) if wins else 0
        avg_loss = statistics.mean(t["pnl_pct"] for t in losses) if losses else 0
        pf = abs(avg_win * len(wins) / (avg_loss * len(losses))) if losses and avg_loss != 0 else float("inf")

        stats = {
            "total": total,
            "wins": len(wins),
            "losses": len(losses),
            "win_rate": win_rate,
            "avg_win_pct": avg_win,
            "avg_loss_pct": avg_loss,
            "profit_factor": pf,
            "expectancy": win_rate * avg_win + (1 - win_rate) * avg_loss,
        }

        return {"trades": trades, "stats": stats}
