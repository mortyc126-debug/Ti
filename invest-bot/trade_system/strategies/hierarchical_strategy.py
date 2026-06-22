"""
HierarchicalStrategy — 4-слойная иерархическая стратегия.

Архитектура:
  D1  (контекст/bias)    — EMA20, структура цены (HH/HL vs LH/LL), ATR(14)
  H1  (уровень/гипотеза) — откат к уровню свинга H1, глубина 25–70% свинга, R:R ≥1.5
  M5  (триггер)          — вход на старте ATR-волны (<60% дневного ATR),
                            разворотная свеча (тело ≥30%), объём ≥80% среднего
  Exit                   — структурный стоп (свинг M5 ± 0.08%), цель D1-структурная

API совместим с OICompositeStrategy: backtest_scan_signals + backtest_barriers
возвращают те же форматы dict'ов что ожидает dashboard.py.
"""
from __future__ import annotations

import logging
import math
import statistics
from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal
from typing import Optional

from tinkoff.invest import HistoricCandle

__all__ = ("HierarchicalStrategy",)

logger = logging.getLogger(__name__)

# ── константы таймфреймов ────────────────────────────────────────────────────
_D1_MIN = 840      # торговый день РФ: 10:00–18:50 МСК (~840 мин)
_H1_MIN = 60
_M5_MIN = 5

# ── параметры стратегии ───────────────────────────────────────────────────────
_EMA_PERIOD = 20
_ATR_PERIOD = 14
_SWING_LOOKBACK = 5
_PULLBACK_MIN = 0.25
_PULLBACK_MAX = 0.70
_WAVE_MAX_PCT = 0.60       # вход если прошли <60% дневного ATR от экстремума
_BODY_MIN_RATIO = 0.30
_VOL_MIN_RATIO = 0.80
_VOL_MA_PERIOD = 20
_MIN_RR = 1.5
_STRUCT_BUF = 0.0008       # буфер структурного стопа (0.08%)
_MAX_HOLD_BARS = 200       # максимум баров в сделке


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
    bias: int
    atr: float
    ema: float
    swing_high: float
    swing_low: float


@dataclass
class H1Setup:
    direction: int
    level: float
    target: float
    stop_ref: float
    rr: float


@dataclass
class M5Trigger:
    direction: int
    entry: float
    stop: float
    target: float
    bar_idx: int


# ── конвертация HistoricCandle ────────────────────────────────────────────────

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


# ── ресэмплинг ────────────────────────────────────────────────────────────────

def _resample(bars: list[Bar], tf_minutes: int) -> list[Bar]:
    if not bars:
        return []

    def _flush(b: list[Bar]) -> Bar:
        return Bar(
            time=b[0].time,
            open=b[0].open,
            high=max(x.high for x in b),
            low=min(x.low for x in b),
            close=b[-1].close,
            volume=sum(x.volume for x in b),
        )

    result: list[Bar] = []
    bucket: list[Bar] = []
    for bar in bars:
        slot = (bar.time.hour * 60 + bar.time.minute) // tf_minutes
        if bucket:
            prev_slot = (bucket[0].time.hour * 60 + bucket[0].time.minute) // tf_minutes
            if bar.time.date() != bucket[0].time.date() or slot != prev_slot:
                result.append(_flush(bucket))
                bucket = []
        bucket.append(bar)
    if bucket:
        result.append(_flush(bucket))
    return result


# ── индикаторы ────────────────────────────────────────────────────────────────

def _ema(values: list[float], period: int) -> list[float]:
    if not values:
        return []
    k = 2.0 / (period + 1)
    out = [values[0]]
    for v in values[1:]:
        out.append(v * k + out[-1] * (1 - k))
    return out


def _atr(bars: list[Bar], period: int) -> list[float]:
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
    out: list[float] = [float("nan")] * len(bars)
    if len(trs) >= period + 1:
        out[period] = sum(trs[1: period + 1]) / period
        for i in range(period + 1, len(trs)):
            out[i] = (out[i - 1] * (period - 1) + trs[i]) / period
    return out


def _swings(bars: list[Bar], lookback: int = _SWING_LOOKBACK) -> tuple[list[float], list[float]]:
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
    for i in range(up_to, -1, -1):
        if not math.isnan(values[i]):
            return values[i]
    return float("nan")


def _tf_idx(m5_bars: list[Bar], tf_bars: list[Bar], m5_i: int) -> int:
    """Индекс последнего завершённого tf-бара относительно m5_bars[m5_i]."""
    t = m5_bars[m5_i].time
    result = -1
    for j, b in enumerate(tf_bars):
        if b.time <= t:
            result = j
        else:
            break
    return result


# ── слои анализа ──────────────────────────────────────────────────────────────

def _d1_context(d1_bars: list[Bar], idx: int) -> Optional[D1Context]:
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
    if close > ema and not math.isnan(last_sh) and not math.isnan(last_sl):
        prev_sh = float("nan")
        for i in range(idx - 1, -1, -1):
            if not math.isnan(sh[i]) and sh[i] < last_sh:
                prev_sh = sh[i]
                break
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
        bias=bias, atr=atr, ema=ema,
        swing_high=last_sh if not math.isnan(last_sh) else close,
        swing_low=last_sl if not math.isnan(last_sl) else close,
    )


def _h1_setup(h1_bars: list[Bar], idx: int, d1: D1Context) -> Optional[H1Setup]:
    if d1.bias == 0 or idx < _SWING_LOOKBACK * 2:
        return None
    sh, sl = _swings(h1_bars[: idx + 1])
    close = h1_bars[idx].close
    if d1.bias == 1:
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
    return H1Setup(direction=d1.bias, level=level, target=target, stop_ref=stop_ref, rr=rr)


def _m5_trigger(m5_bars: list[Bar], idx: int, h1: H1Setup, d1_atr: float) -> Optional[M5Trigger]:
    if idx < _VOL_MA_PERIOD + _SWING_LOOKBACK:
        return None
    bar = m5_bars[idx]
    vol_avg = statistics.mean(b.volume for b in m5_bars[max(0, idx - _VOL_MA_PERIOD): idx])
    if vol_avg > 0 and bar.volume < _VOL_MIN_RATIO * vol_avg:
        return None
    bar_range = bar.high - bar.low
    if bar_range <= 0:
        return None
    body = abs(bar.close - bar.open)
    if body / bar_range < _BODY_MIN_RATIO:
        return None
    if h1.direction == 1 and bar.close <= bar.open:
        return None
    if h1.direction == -1 and bar.close >= bar.open:
        return None
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
    if wave_traveled < 0 or wave_traveled > _WAVE_MAX_PCT * d1_atr:
        return None
    stop = wave_start * (1 - _STRUCT_BUF) if h1.direction == 1 else wave_start * (1 + _STRUCT_BUF)
    entry = bar.close
    risk = abs(entry - stop)
    if risk <= 0:
        return None
    reward = abs(h1.target - entry)
    if reward / risk < _MIN_RR:
        return None
    return M5Trigger(direction=h1.direction, entry=entry, stop=stop, target=h1.target, bar_idx=idx)


# ── основной класс ────────────────────────────────────────────────────────────

class HierarchicalStrategy:
    """
    Иерархическая стратегия D1→H1→M5.

    Принимает опциональный settings-аргумент (совместимость с StrategyFactory),
    но не использует ATR-множители из settings — стоп и цель структурные.
    """

    def __init__(self, settings=None):
        self._settings = settings

    # совместимость с IStrategy-интерфейсом (для _wire_history и прочего)
    def set_history(self, *args, **kwargs):
        pass

    def update_lot_count(self, lot: int) -> None:
        pass

    def update_short_status(self, status: bool) -> None:
        pass

    @property
    def settings(self):
        return self._settings

    def backtest_scan_signals(self, candles: list[HistoricCandle]) -> list[dict]:
        """
        Сканирует M5-свечи и возвращает список сигналов в формате
        совместимом с OICompositeStrategy (entry_time, direction, ...).
        """
        if len(candles) < (_D1_MIN // _M5_MIN) * (_EMA_PERIOD + _ATR_PERIOD + 10):
            return []

        m5 = [_candle_to_bar(c) for c in candles]
        h1 = _resample(m5, _H1_MIN)
        d1 = _resample(m5, _D1_MIN)

        # кешируем свинги для D1 и H1 — пересчитываем инкрементально
        signals: list[dict] = []

        for i in range(_SWING_LOOKBACK + _VOL_MA_PERIOD + 1, len(m5)):
            d1_i = _tf_idx(m5, d1, i - 1)
            h1_i = _tf_idx(m5, h1, i - 1)
            if d1_i < _EMA_PERIOD + _ATR_PERIOD or h1_i < _SWING_LOOKBACK * 2:
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
            atr_close = ctx.atr
            signals.append({
                "entry_time": m5[i].time,
                "direction": direction,
                "entry_price": trig.entry,
                "take_price": trig.target,
                "stop_price": trig.stop,
                "atr": atr_close,
                "rr": abs(trig.target - trig.entry) / abs(trig.entry - trig.stop),
                "d1_bias": ctx.bias,
                "d1_atr": ctx.atr,
                "h1_level": setup.level,
                "bar_idx": i,
                # кластерные скоры — в иерархической стратегии не используются
                "m1": 0.0, "m2": 0.0, "m3": 0.0,
                "method_scores": {},
            })

        return signals

    def backtest_barriers(
        self,
        candles: Optional[list[HistoricCandle]] = None,
        *,
        signals: Optional[list[dict]] = None,
        take_mult: Optional[Decimal] = None,
        stop_mult: Optional[Decimal] = None,
        atr_take_k: Optional[float] = None,
        atr_stop_k: Optional[float] = None,
        atr_scale_exp: Optional[float] = None,
        return_trades: bool = False,
        tariff: Optional[str] = None,
        **kwargs,
    ) -> dict:
        """
        Симулирует сделки по структурным стопу и цели из сигналов.
        ATR-множители (take_mult, atr_take_k и т.д.) игнорируются —
        стоп и цель берутся напрямую из сигнала (структурные уровни).
        Возвращает dict с теми же ключами что OICompositeStrategy.
        """
        if not signals or not candles:
            return self._empty_result()

        m5 = [_candle_to_bar(c) for c in candles]
        trades: list[dict] = []
        next_entry_bar = 0

        for sig in signals:
            bar_idx = sig.get("bar_idx", 0)
            if bar_idx < next_entry_bar:
                continue

            entry = sig["entry_price"]
            stop = sig["stop_price"]
            target = sig["take_price"]
            direction = sig["direction"]
            dir_sign = 1 if direction == "LONG" else -1
            entry_time = sig["entry_time"]

            win = False
            exit_price = entry
            exit_bar = bar_idx
            exit_time = entry_time
            mfe = 0.0
            mae = 0.0

            for j in range(bar_idx + 1, min(bar_idx + _MAX_HOLD_BARS + 1, len(m5))):
                bar = m5[j]
                # MFE / MAE
                if dir_sign == 1:
                    mfe = max(mfe, bar.high - entry)
                    mae = max(mae, entry - bar.low)
                else:
                    mfe = max(mfe, entry - bar.low)
                    mae = max(mae, bar.high - entry)

                if dir_sign == 1:
                    if bar.low <= stop:
                        exit_price = stop; exit_bar = j; exit_time = bar.time; break
                    if bar.high >= target:
                        exit_price = target; win = True; exit_bar = j; exit_time = bar.time; break
                else:
                    if bar.high >= stop:
                        exit_price = stop; exit_bar = j; exit_time = bar.time; break
                    if bar.low <= target:
                        exit_price = target; win = True; exit_bar = j; exit_time = bar.time; break
            else:
                last_idx = min(bar_idx + _MAX_HOLD_BARS, len(m5) - 1)
                exit_price = m5[last_idx].close
                exit_bar = last_idx
                exit_time = m5[last_idx].time
                win = (exit_price - entry) * dir_sign > 0

            risk = abs(entry - stop)
            net_pct = (exit_price - entry) / entry * dir_sign  # доля (не %)
            r_multiple = (exit_price - entry) * dir_sign / risk if risk > 0 else 0.0

            # duration_min: разница в минутах между entry и exit
            try:
                delta = exit_time - entry_time
                duration_min = delta.total_seconds() / 60.0
            except Exception:
                duration_min = (exit_bar - bar_idx) * _M5_MIN

            trades.append({
                "entry_time": entry_time,
                "exit_time": exit_time,
                "direction": direction,
                "entry_price": entry,
                "exit_price": exit_price,
                "take_price": target,
                "stop_price": stop,
                "mfe": mfe,
                "mae": mae,
                "net_pct": net_pct,
                "r_multiple": r_multiple,
                "win": win,
                "duration_min": duration_min,
                # кластерные скоры (для _what_if_from_trades)
                "m1": sig.get("m1", 0.0),
                "m2": sig.get("m2", 0.0),
                "m3": sig.get("m3", 0.0),
                "method_scores": sig.get("method_scores", {}),
                # дополнительные поля иерархической стратегии
                "d1_bias": sig.get("d1_bias", 0),
                "h1_level": sig.get("h1_level", 0.0),
            })

            next_entry_bar = exit_bar + 1

        return self._calc_stats(trades, return_trades)

    @staticmethod
    def _empty_result() -> dict:
        return {
            "total": 0, "wins": 0, "losses": 0,
            "win_rate": 0.0, "expectancy_pct": 0.0,
            "avg_win_pct": 0.0, "avg_loss_pct": 0.0,
            "profit_factor": 0.0, "trades": [],
        }

    @staticmethod
    def _calc_stats(trades: list[dict], return_trades: bool) -> dict:
        if not trades:
            return HierarchicalStrategy._empty_result()

        wins = [t for t in trades if t["win"]]
        losses = [t for t in trades if not t["win"]]
        total = len(trades)
        win_rate = len(wins) / total
        avg_win = statistics.mean(t["net_pct"] for t in wins) if wins else 0.0
        avg_loss = statistics.mean(t["net_pct"] for t in losses) if losses else 0.0
        gross_win = sum(t["net_pct"] for t in wins)
        gross_loss = abs(sum(t["net_pct"] for t in losses))
        pf = gross_win / gross_loss if gross_loss > 0 else float("inf")
        expectancy = sum(t["net_pct"] for t in trades) / total

        out = {
            "total": total,
            "wins": len(wins),
            "losses": len(losses),
            "win_rate": win_rate,
            "expectancy_pct": expectancy,
            "avg_win_pct": avg_win,
            "avg_loss_pct": avg_loss,
            "profit_factor": pf,
        }
        if return_trades:
            out["trades"] = trades
        return out
