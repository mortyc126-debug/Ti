"""
OICompositeStrategy — многометодная стратегия на основе анализа свечей.

Методы (адаптировано из oi-signal-v10):
  PRICE_TREND    — линейная регрессия цены закрытия (N свечей)
  VOL_MOMENTUM   — объём × направление движения цены
  VWAP_SIGNAL    — отклонение от VWAP скользящего окна
  BS_PRESSURE    — давление быков/медведей по телу свечи
  CANDLE_PATTERN — паттерны (engulfing, pin-bar, doji)
  ADAPTIVE_MA    — отклонение цены от KAMA (indicators.py, Фаза 3)
  TREND_QUALITY  — TQI: знак×сила тренда, уже ∈[-1,1] (indicators.py, Фаза 3)
  FRACTAL        — среднее FDI/Hurst/PFE-скоров (indicators_fractal.py, Фаза 3)
  ENTROPY        — перестановочная энтропия как множитель уверенности (Фаза 3)
  CYBER_CYCLE, DECYCLER, FISHER_RSI, EBSW — Ehlers DSP-индикаторы
  (indicators_ehlers.py, Фаза 3)
  KLINGER, VZO, TWIGGS, RMI, ZSCORE — объём/относит. сила/статистика
  (indicators_volume.py, Фаза 3, финал)
  OI_SQUEEZE     — squeeze-score из oi_layers.py (реальный сквиз по FutOI,
                   не статичный порог), если провайдер подключён извне
  INST_OI        — m_INST_OI: нетто-позиция юрлиц (FutOI), если провайдер подключён
  RETAIL_CONTRA  — m_RETAIL_CONTRA: расхождение юр/физ по направлению (FutOI)
  BS_PRESSURE_TS, AGGRESSOR_FLOW, LARGE_IMPACT, VWAP_SIGNAL_TS, VOL_MOMENTUM_TS,
  OB_IMBALANCE, CANCEL_SIGNAL — микроструктура из tradestats.py (tradestats/
  obstats/orderstats, AlgoPack), если провайдер подключён извне
  CHANGE_POINT   — голос направления, только если >=2 из 3 алгоритмов
                   (CUSUM/PELT/Z-Score, regime.py) нашли свежий излом тренда
  VOLATILITY_REG — режим волатильности (тренд vs. боковик)

Режим рынка (regime.py.classify_regime: trending_up/trending_down/ranging/
high_vol/low_vol/stress) применяется как множитель веса КАЖДОГО метода
(REGIME_WEIGHT_MODS) — например VOL_MOMENTUM надёжнее в тренде, VWAP_SIGNAL —
в боковике. Это не отдельный сигнал, а модулятор существующих весов.

Каждый метод возвращает score ∈ [-1, 1].
Композитный сигнал = взвешенная сумма → порог → LONG/SHORT, но сигнал
пропускается дальше только если прошёл фильтры качества (см. ниже) —
иначе веса методов будут обучаться на случайном шуме, а бот будет торговать
на "мусорных" сигналах, пока веса не накопят историю.

Фильтры качества перед выдачей сигнала:
  1. СОГЛАСИЕ МЕТОДОВ — хотя бы MIN_AGREE_METHODS методов высказались
     (|score| >= AGREE_SCORE_MIN) в направлении composite. Иначе один
     сильный метод может протащить сигнал, пока остальные молчат/против.
  2. ЛИКВИДНОСТЬ — последняя свеча не аномально тонкая относительно медианы
     объёма по окну (защита от шума на пустом стакане).
  3. СКОЛЬЗЯЩЕЕ КАЧЕСТВО — если последние сделки стратегии в среднем
     низкого качества (rolling quality), порог временно повышается —
     самозатухание в плохой полосе, без ручного выключения.

Веса EWA обновляются после закрытия каждой сделки (quality = MFE / (MFE + MAE)).
Сохраняются в JSON-файл рядом с bot'ом.
"""
import datetime
import json
import logging
import math
import os
import statistics
import time
from configparser import ConfigParser
from dataclasses import dataclass, field
from decimal import Decimal
from typing import Callable, Optional

from tinkoff.invest import HistoricCandle
from tinkoff.invest.utils import quotation_to_decimal

from configuration.settings import StrategySettings
from trade_system.signal import Signal, SignalType
from trade_system.strategies.base_strategy import IStrategy
# regime импортируется первым: его модуль-уровневый код кладёт ../formulas в
# sys.path, поэтому ниже научные модули из formulas/ становятся импортируемы.
from regime import classify_regime, REGIME_WEIGHT_MODS, change_point_score
from cluster_models import ClusterModels
from indicators import score_adaptive_ma, score_trend_quality, zlema, t3, mmi
from indicators_fractal import score_fractal, score_entropy_regime
from indicators_ehlers import (
    score_cyber_cycle, score_decycler, score_fisher_rsi, score_ebsw, even_better_sinewave,
)
from indicators_volume import score_klinger, score_vzo, score_twiggs, score_rmi, score_zscore

# ── Научные модули из formulas/ (numpy/scipy) — опциональны ──────────────────
# Каждый завёрнут в try/except: без numpy/scipy бот продолжает работать на
# базовых методах, а "научные" методы молча отдают нейтральный 0.0.
try:
    from kalman_filter import KalmanFilter
    _HAS_KALMAN = True
except Exception:
    _HAS_KALMAN = False

try:
    from hawkes_processes import hawkes_processes
    _HAS_HAWKES = True
except Exception:
    _HAS_HAWKES = False

try:
    from recurrence_quantification_analysis import rqa_signal
    _HAS_RQA = True
except Exception:
    _HAS_RQA = False

try:
    from wavelet_transform import wavelet_transform
    _HAS_WAVELET = True
except Exception:
    _HAS_WAVELET = False

try:
    from singular_spectrum_analysis import analyze as ssa_analyze
    _HAS_SSA = True
except Exception:
    _HAS_SSA = False

try:
    import numpy as _np
    _HAS_NUMPY = True
except Exception:
    _HAS_NUMPY = False

__all__ = ("OICompositeStrategy",)

logger = logging.getLogger(__name__)

# ── Константы ────────────────────────────────────────────────────────────────
WEIGHTS_FILE = "oi_weights.json"   # файл весов (рядом с main.py)
CANDLE_WINDOW = 30                 # свечей в окне для расчётов
MIN_CANDLES = 10                   # минимум свечей для первого сигнала
SIGNAL_THRESHOLD = 0.25            # порог composite для сигнала
WEIGHT_ALPHA = 0.1                 # скорость обучения EWA (0.1 = медленно, стабильно)
MFE_MAE_BARS = 15                  # максимум баров для записи MFE/MAE

# ── Фильтры качества сигнала ────────────────────────────────────────────────
MIN_AGREE_METHODS = 3              # минимум методов согласны по направлению
AGREE_SCORE_MIN = 0.15             # |score| >= это значит "метод высказался"
LIQUIDITY_MIN_RATIO = 0.3          # объём последней свечи >= 0.3 * медианы окна
LOW_QUALITY_THRESHOLD = 0.4        # rolling quality ниже этого — "плохая полоса"
LOW_QUALITY_MULT = 1.3             # ужесточение порога в плохой полосе
QUALITY_ALPHA = 0.15               # скорость EWA для rolling quality

# ── ATR-фильтр шума ──────────────────────────────────────────────────────────
ATR_PERIOD = 14                    # период ATR
MIN_ATR_FACTOR = 1.5               # ATR должен быть >= комиссия × этот фактор

# ── Комиссия Т-Инвестиций по тарифам (round-trip = вход+выход) ──────────────
# Акции/облигации/ETF/расписки — фикс. % от суммы сделки. Фьючерсы — % от
# стоимости контракта, тариф растёт по мере падения дневного оборота —
# берём ставку первой (самой высокой) ступени, чтобы не переоценить качество.
# settings.ini [COMMISSION] TARIFF=TRADER|PREMIUM переключает обе ставки сразу.
COMMISSION_TABLE = {
    "TRADER": {"stock": 0.0005 * 2, "future": 0.0004 * 2},   # 0.1% / 0.08%
    "PREMIUM": {"stock": 0.0004 * 2, "future": 0.00025 * 2},  # 0.08% / 0.05%
}


def _ini_tariff() -> str:
    _ini = ConfigParser()
    _ini.read("settings.ini", encoding="utf-8")
    tariff = _ini.get("COMMISSION", "TARIFF", fallback="TRADER").upper()
    return tariff if tariff in COMMISSION_TABLE else "TRADER"


def commission_rt(is_future: bool, tariff: Optional[str] = None) -> float:
    """Round-trip комиссия для типа инструмента на заданном (или ini-) тарифе."""
    rates = COMMISSION_TABLE[tariff if tariff in COMMISSION_TABLE else _ini_tariff()]
    return rates["future"] if is_future else rates["stock"]


COMMISSION_RT = commission_rt(is_future=False)  # дефолт для мест без доступа к settings (ATR-фильтр)


@dataclass
class MethodWeight:
    weight: float = 0.5
    total: int = 0
    sum_quality: float = 0.0

    def update(self, quality: float) -> None:
        """Обновить вес по результату сделки: quality ∈ [0, 1]."""
        self.total += 1
        self.sum_quality += quality
        rolling_acc = self.sum_quality / self.total
        self.weight = (1 - WEIGHT_ALPHA) * self.weight + WEIGHT_ALPHA * rolling_acc
        self.weight = max(0.05, min(1.0, self.weight))


@dataclass
class OpenTrade:
    signal_type: SignalType
    entry_price: Decimal
    method_scores: dict
    after_candles: list = field(default_factory=list)
    commission_rt: float = COMMISSION_RT  # ставка по типу инструмента (акция/фьючерс)

    def add_candle(self, candle: HistoricCandle) -> None:
        self.after_candles.append(candle)

    def calc_quality(self) -> float:
        """MFE/MAE → quality ∈ [0, 1]. MFE уменьшается на commission_rt —
        движение цены меньше комиссии за круг не даёт реальной прибыли."""
        ep = float(self.entry_price)
        mfe = mae = 0.0
        for c in self.after_candles:
            h = float(quotation_to_decimal(c.high))
            lo = float(quotation_to_decimal(c.low))
            if self.signal_type == SignalType.LONG:
                mfe = max(mfe, (h - ep) / ep)
                mae = max(mae, (ep - lo) / ep)
            else:
                mfe = max(mfe, (ep - lo) / ep)
                mae = max(mae, (h - ep) / ep)
        mfe_net = max(0.0, mfe - self.commission_rt)
        return mfe_net / (mfe_net + mae + 1e-8)


# ── Методы анализа (чистые функции) ──────────────────────────────────────────

def _to_f(q) -> float:
    """Quotation или уже float → float."""
    try:
        return float(quotation_to_decimal(q))
    except Exception:
        return float(q)


def _linreg_slope(values: list[float]) -> float:
    """Нормированный наклон линейной регрессии: > 0 = рост, < 0 = падение."""
    n = len(values)
    if n < 2:
        return 0.0
    xs = list(range(n))
    mx, my = (n - 1) / 2, sum(values) / n
    num = sum((xs[i] - mx) * (values[i] - my) for i in range(n))
    den = sum((xs[i] - mx) ** 2 for i in range(n)) or 1e-9
    slope = num / den
    # нормируем на диапазон цен
    price_range = max(values) - min(values) or abs(my) or 1
    return max(-1.0, min(1.0, slope * n / price_range))


def _adaptive_threshold(base: float, regime: str) -> float:
    """
    Порог входа под режим рынка: в тренде вход дешевле (легче ловить движение),
    в стрессе/высокой волатильности дороже (меньше ложных входов на шуме).
    """
    mods = {"trending_up": 0.85, "trending_down": 0.85, "ranging": 1.0,
            "high_vol": 1.25, "low_vol": 0.90, "stress": 1.40}
    return base * mods.get(regime, 1.0)


def _compute_atr(candles: list[HistoricCandle], period: int = ATR_PERIOD) -> float:
    """
    ATR (Average True Range) как доля цены: средний True Range за period баров,
    делённый на последнюю цену. Фильтр против "мёртвых" инструментов, где
    движение меньше комиссии (торговать бессмысленно).
    """
    if len(candles) < 2:
        return 0.0
    trs: list[float] = []
    for i in range(1, len(candles)):
        h = _to_f(candles[i].high)
        lo = _to_f(candles[i].low)
        prev_c = _to_f(candles[i - 1].close)
        tr = max(h - lo, abs(h - prev_c), abs(lo - prev_c))
        trs.append(tr)
    if not trs:
        return 0.0
    window = trs[-period:]
    atr = sum(window) / len(window)
    last_price = _to_f(candles[-1].close) or 1e-9
    return atr / last_price


def score_price_trend(candles: list[HistoricCandle]) -> float:
    """
    PRICE_TREND: вместо наклона линрегрессии — скорость скрытого тренда по
    Kalman-фильтру (Local Level Model). Фильтр сглаживает шум наблюдений и
    отдаёт чистую оценку тренда; velocity = приращение тренда за последний бар,
    нормированное на цену, прогнанное через tanh. Без numpy/Kalman — fallback
    на исходный _linreg_slope (полная обратная совместимость).
    """
    closes = [_to_f(c.close) for c in candles]
    if not _HAS_KALMAN or len(closes) < 3:
        return _linreg_slope(closes)
    try:
        mid_price = sum(closes) / len(closes) or 1e-9
        # R ~ дисперсия шума цены, Q << R для гладкого тренда. Берём от масштаба цены.
        scale = (mid_price * 0.005) ** 2 or 1e-9
        kf = KalmanFilter(R=scale, Q=scale * 0.01)
        filtered = [r.trend for r in kf.batch(closes)]
        if len(filtered) < 2:
            return _linreg_slope(closes)
        velocity = (filtered[-1] - filtered[-2]) / mid_price
        return max(-1.0, min(1.0, math.tanh(velocity * 50)))
    except Exception:
        return _linreg_slope(closes)


def score_vol_momentum(candles: list[HistoricCandle]) -> float:
    """
    Объём × направление за последние N свечей, нормировано. Поверх базовой
    формулы — множитель Хокса: если всплески объёма образуют самовозбуждающийся
    каскад (branching_ratio n = alpha/decay >= 1.0), движение по объёму усиливаем
    ×1.5; затухающий поток (n < 0.5) ослабляем ×0.5. Без scipy/Hawkes или при
    сбое оптимизации — исходная формула (множитель ×1.0).
    """
    if len(candles) < 2:
        return 0.0
    bull_vol = sum(c.volume for c in candles if _to_f(c.close) >= _to_f(c.open))
    bear_vol = sum(c.volume for c in candles if _to_f(c.close) < _to_f(c.open))
    total = bull_vol + bear_vol or 1
    base = (bull_vol - bear_vol) / total

    if not _HAS_HAWKES:
        return base
    try:
        volumes = [float(c.volume) for c in candles]
        med = statistics.median(volumes) if volumes else 0.0
        # крупные бары = объём > median*1.5; их индексы — времена событий потока
        event_times = [float(i) for i, v in enumerate(volumes) if v > med * 1.5]
        if len(event_times) < 5:
            return base
        res = hawkes_processes(event_times)
        n = res["branching_ratio"]
        if n >= 1.0:
            mult = 1.5
        elif n < 0.5:
            mult = 0.5
        else:
            mult = 1.0
        return max(-1.0, min(1.0, base * mult))
    except Exception:
        return base


def score_vwap_signal(candles: list[HistoricCandle]) -> float:
    """Отклонение последней цены от скользящего VWAP."""
    volumes = [c.volume for c in candles]
    total_vol = sum(volumes) or 1
    typicals = [(_to_f(c.high) + _to_f(c.low) + _to_f(c.close)) / 3 for c in candles]
    vwap = sum(t * v for t, v in zip(typicals, volumes)) / total_vol
    last_price = _to_f(candles[-1].close)
    deviation = (last_price - vwap) / (vwap or 1)
    # насыщение при ±1%
    return max(-1.0, min(1.0, deviation / 0.01))


def score_bs_pressure(candles: list[HistoricCandle]) -> float:
    """Давление покупателей/продавцов по размеру тела свечи относительно диапазона."""
    scores = []
    for c in candles:
        h, lo, op, cl = _to_f(c.high), _to_f(c.low), _to_f(c.open), _to_f(c.close)
        rng = h - lo or 1e-9
        body = (cl - op) / rng        # > 0 бычья, < 0 медвежья
        upper_wick = (h - max(op, cl)) / rng
        lower_wick = (min(op, cl) - lo) / rng
        # бычья с маленьким верхним фитилём — сильный сигнал вверх
        s = body - upper_wick + lower_wick
        scores.append(max(-1.0, min(1.0, s)))
    return sum(scores) / len(scores) if scores else 0.0


def score_candle_pattern(candles: list[HistoricCandle]) -> float:
    """Engulfing / Pin-bar / Doji на последних 2–3 свечах."""
    if len(candles) < 2:
        return 0.0
    prev, last = candles[-2], candles[-1]
    ph, pl = _to_f(prev.high), _to_f(prev.low)
    po, pc = _to_f(prev.open), _to_f(prev.close)
    lh, ll = _to_f(last.high), _to_f(last.low)
    lo_, lc = _to_f(last.open), _to_f(last.close)
    lrng = lh - ll or 1e-9

    # Bullish Engulfing
    if pc < po and lc > lo_ and lc > po and lo_ < pc:
        return 0.8

    # Bearish Engulfing
    if pc > po and lc < lo_ and lc < po and lo_ > pc:
        return -0.8

    # Bullish Pin Bar (молот)
    lower_wick = (min(lo_, lc) - ll) / lrng
    body = abs(lc - lo_) / lrng
    if lower_wick > 0.6 and body < 0.3:
        return 0.7

    # Bearish Pin Bar (перевёрнутый молот)
    upper_wick = (lh - max(lo_, lc)) / lrng
    if upper_wick > 0.6 and body < 0.3:
        return -0.7

    # Doji
    if body < 0.05:
        return 0.0  # нейтральный

    return 0.0


def score_adaptive_ma_candle(candles: list[HistoricCandle]) -> float:
    """ADAPTIVE_MA: отклонение цены от KAMA (indicators.py, Фаза 3)."""
    return score_adaptive_ma([_to_f(c.close) for c in candles])


def score_trend_quality_candle(candles: list[HistoricCandle]) -> float:
    """TREND_QUALITY: TQI (indicators.py, Фаза 3) — уже ∈[-1,1]."""
    return score_trend_quality([_to_f(c.close) for c in candles])


def score_fractal_candle(candles: list[HistoricCandle]) -> float:
    """FRACTAL: среднее FDI/Hurst/PFE-скоров (indicators_fractal.py, Фаза 3)."""
    return score_fractal([_to_f(c.close) for c in candles])


def score_entropy_candle(candles: list[HistoricCandle]) -> float:
    """ENTROPY: перестановочная энтропия как множитель уверенности к направлению (Фаза 3)."""
    return score_entropy_regime([_to_f(c.close) for c in candles])


def score_cyber_cycle_candle(candles: list[HistoricCandle]) -> float:
    """CYBER_CYCLE: пересечение нуля цикла Эрлерса (indicators_ehlers.py, Фаза 3)."""
    return score_cyber_cycle([_to_f(c.close) for c in candles])


def score_decycler_candle(candles: list[HistoricCandle]) -> float:
    """DECYCLER: знак цены минус долгосрочный low-pass тренд (Фаза 3)."""
    return score_decycler([_to_f(c.close) for c in candles])


def score_fisher_rsi_candle(candles: list[HistoricCandle]) -> float:
    """FISHER_RSI: преобразование Фишера от RSI (Фаза 3)."""
    return score_fisher_rsi([_to_f(c.close) for c in candles])


def score_ebsw_candle(candles: list[HistoricCandle]) -> float:
    """EBSW: Even Better Sinewave, RMS-нормированный roofing filter (Фаза 3)."""
    return score_ebsw([_to_f(c.close) for c in candles])


def _hlcv(candles: list[HistoricCandle]) -> tuple[list[float], list[float], list[float], list[float]]:
    highs = [_to_f(c.high) for c in candles]
    lows = [_to_f(c.low) for c in candles]
    closes = [_to_f(c.close) for c in candles]
    volumes = [float(c.volume) for c in candles]
    return highs, lows, closes, volumes


def score_klinger_candle(candles: list[HistoricCandle]) -> float:
    """KLINGER: Klinger Volume Oscillator, пересечение нуля (indicators_volume.py, Фаза 3)."""
    h, l, c, v = _hlcv(candles)
    return score_klinger(h, l, c, v)


def score_vzo_candle(candles: list[HistoricCandle]) -> float:
    """VZO: Volume Zone Oscillator (Фаза 3)."""
    _, _, c, v = _hlcv(candles)
    return score_vzo(c, v)


def score_twiggs_candle(candles: list[HistoricCandle]) -> float:
    """TWIGGS: Twiggs Money Flow (Фаза 3)."""
    h, l, c, v = _hlcv(candles)
    return score_twiggs(h, l, c, v)


def score_rmi_candle(candles: list[HistoricCandle]) -> float:
    """RMI: Relative Momentum Index, вариант RSI на разностях (Фаза 3)."""
    return score_rmi([_to_f(c.close) for c in candles])


def score_zscore_candle(candles: list[HistoricCandle]) -> float:
    """ZSCORE: rolling z-score, контр-сигнал на возврат к среднему (Фаза 3)."""
    return score_zscore([_to_f(c.close) for c in candles])


def score_volatility_regime(candles: list[HistoricCandle]) -> float:
    """
    VHF-подобный индикатор: высокое значение = тренд (сигналы надёжнее),
    низкое = боковик (режим).
    Возвращает множитель [-0.5..0.5]: не самостоятельный сигнал, а усиление/ослабление.
    """
    if len(candles) < 5:
        return 0.0
    closes = [_to_f(c.close) for c in candles]
    hi, lo = max(closes), min(closes)
    path = sum(abs(closes[i] - closes[i - 1]) for i in range(1, len(closes)))
    vhf = (hi - lo) / (path or 1e-9)
    # vhf > 0.3 → тренд, < 0.1 → боковик
    # возвращаем нормированный [0..1]: чем выше — тем надёжнее тренд
    return min(1.0, vhf / 0.3)


# ── Новые методы (Wave 2): адаптивные MA, циклы, волатильность, статистика ───

def _dev_score(price: float, ref: float) -> float:
    """Скоринг относительного отклонения цены от опорной линии (ZLEMA/T3)."""
    if ref is None or ref <= 0:
        return 0.0
    dev = (price - ref) / ref
    if dev > 0.01:
        return 1.0
    if dev > 0.003:
        return 0.5
    if dev < -0.01:
        return -1.0
    if dev < -0.003:
        return -0.5
    return 0.0


def score_zlema_signal(candles: list[HistoricCandle]) -> float:
    """ZLEMA_SIGNAL: отклонение цены от Zero-Lag EMA (indicators.py)."""
    closes = [_to_f(c.close) for c in candles]
    if len(closes) < 15:
        return 0.0
    line = zlema(closes, period=min(14, len(closes) - 1))
    ref = line[-1] if line else None
    return _dev_score(closes[-1], ref)


def score_t3_signal(candles: list[HistoricCandle]) -> float:
    """T3_SIGNAL: отклонение цены от сглаживающей T3 (indicators.py)."""
    closes = [_to_f(c.close) for c in candles]
    if len(closes) < 10:
        return 0.0
    line = t3(closes, period=min(5, max(2, len(closes) // 3)))
    ref = line[-1] if line else None
    return _dev_score(closes[-1], ref)


def score_sinewave_signal(candles: list[HistoricCandle]) -> float:
    """
    SINEWAVE_SIGNAL: Ehlers Even Better Sinewave (indicators_ehlers.py).
    Знак последнего значения → направление; пересечение нуля усиливает сигнал.
    """
    closes = [_to_f(c.close) for c in candles]
    if len(closes) < 15:
        return 0.0
    period = min(10, max(3, len(closes) // 3))
    series = even_better_sinewave(closes, hp_period=min(40, len(closes)), period=period)
    if len(series) < 2:
        return 0.0
    v, prev = series[-1], series[-2]
    if v > 0 and prev < 0:
        return 1.0
    if v < 0 and prev > 0:
        return -1.0
    return max(-1.0, min(1.0, v))


def score_mmi_signal(candles: list[HistoricCandle]) -> float:
    """
    MMI_SIGNAL: Market Meanness Index (indicators.py). Высокий MMI → рынок
    "вязкий", тренд-следящие методы рискованны (лёгкий контр-голос). Низкий →
    благоприятен для следования за движением.
    """
    closes = [_to_f(c.close) for c in candles]
    if len(closes) < 5:
        return 0.0
    m = mmi(closes, period=min(200, len(closes)))
    if m > 75:
        return -0.5
    if m < 50:
        return 0.5
    return 0.0


def _log_returns(values: list[float]) -> list[float]:
    out = []
    for i in range(1, len(values)):
        if values[i - 1] > 0 and values[i] > 0:
            out.append(math.log(values[i] / values[i - 1]))
    return out


def score_yz_vol_signal(candles: list[HistoricCandle]) -> float:
    """
    YZ_VOL_SIGNAL: Yang-Zhang волатильность (учитывает гэпы overnight + тело
    бара) и её перцентиль в скользящем окне. Высокая волатильность (>80-й
    перцентиль) — risk-off (−0.5); низкая (<20-й) — спокойный фон (+0.5).
    """
    if len(candles) < 12:
        return 0.0
    # покомпонентная YZ: overnight (close[-1]->open) + open->close (rogers-satchell-ish)
    vols: list[float] = []
    for i in range(1, len(candles)):
        prev_c = _to_f(candles[i - 1].close)
        o = _to_f(candles[i].open)
        h = _to_f(candles[i].high)
        lo = _to_f(candles[i].low)
        cl = _to_f(candles[i].close)
        if prev_c <= 0 or o <= 0 or h <= 0 or lo <= 0 or cl <= 0:
            continue
        overnight = math.log(o / prev_c) ** 2
        rs = 0.0
        if h > 0 and cl > 0 and o > 0 and lo > 0:
            rs = (math.log(h / cl) * math.log(h / o) +
                  math.log(lo / cl) * math.log(lo / o))
        vols.append(math.sqrt(max(0.0, overnight + rs)))
    if len(vols) < 6:
        return 0.0
    cur = vols[-1]
    hist = sorted(vols)
    # перцентиль текущего значения среди исторических
    rank = sum(1 for v in hist if v <= cur) / len(hist)
    if rank > 0.8:
        return -0.5
    if rank < 0.2:
        return 0.5
    return 0.0


def score_vr_signal(candles: list[HistoricCandle]) -> float:
    """
    VR_SIGNAL: Variance Ratio VR(q=4) — отношение дисперсии q-периодных
    доходностей к q×дисперсии однопериодных. VR > 1 — тренд/персистентность
    (момент), VR < 1 — возврат к среднему. VR>1.3 → +0.5, VR<0.7 → −0.5.
    """
    closes = [_to_f(c.close) for c in candles]
    rets = _log_returns(closes)
    q = 4
    if len(rets) < q * 3:
        return 0.0
    var1 = statistics.pvariance(rets)
    if var1 <= 0:
        return 0.0
    # q-периодные перекрывающиеся суммы доходностей
    q_sums = [sum(rets[i:i + q]) for i in range(len(rets) - q + 1)]
    if len(q_sums) < 2:
        return 0.0
    varq = statistics.pvariance(q_sums)
    vr = varq / (q * var1)
    if vr > 1.3:
        return 0.5
    if vr < 0.7:
        return -0.5
    return 0.0


def score_ssa_signal(candles: list[HistoricCandle]) -> float:
    """
    SSA_SIGNAL: тренд-компонента Singular Spectrum Analysis. Цена выше
    SSA-тренда → бычий голос пропорционально отклонению, ниже → медвежий.
    Без numpy/SSA — нейтрально 0.0.
    """
    closes = [_to_f(c.close) for c in candles]
    if not _HAS_SSA or len(closes) < 12:
        return 0.0
    try:
        res = ssa_analyze(_np.asarray(closes, dtype=float),
                          L=min(len(closes) // 2, 15), n_components=6)
        trend = res["trend"]
        ssa_trend = float(trend[-1])
        if ssa_trend <= 0:
            return 0.0
        dev = (closes[-1] - ssa_trend) / ssa_trend
        return max(-1.0, min(1.0, math.tanh(dev * 30)))
    except Exception:
        return 0.0


def score_hawkes_signal(candles: list[HistoricCandle]) -> float:
    """
    HAWKES_SIGNAL: branching ratio потока крупных баров как направленный
    сигнал. Каскад (n>=1.0) — усиливаем недавнее направление цены ×0.8;
    переходная зона (0.5<n<1.0) — нейтрально 0; затухание (n<0.5) — лёгкий
    контр-сигнал −0.3 (всплеск выдохся → откат вероятнее). Без scipy — 0.0.
    """
    if not _HAS_HAWKES or len(candles) < 6:
        return 0.0
    try:
        volumes = [float(c.volume) for c in candles]
        med = statistics.median(volumes) if volumes else 0.0
        event_times = [float(i) for i, v in enumerate(volumes) if v > med * 1.5]
        if len(event_times) < 5:
            return 0.0
        res = hawkes_processes(event_times)
        n = res["branching_ratio"]
        # направление недавнего движения цены
        closes = [_to_f(c.close) for c in candles]
        ref = closes[-min(5, len(closes))]
        price_dir = 1.0 if closes[-1] >= ref else -1.0
        if n >= 1.0:
            return max(-1.0, min(1.0, price_dir * 0.8))
        if n < 0.5:
            return -0.3 * price_dir
        return 0.0
    except Exception:
        return 0.0


def wavelet_confidence_mult(closes: list[float]) -> float:
    """
    WAVELET_SIGNAL (множитель уверенности, не направление): доминантный масштаб
    CWT. Короткий (2-8) — шум/скальпинг → 0.7; средний (8-32) — внутридневной
    тренд → 1.0; длинный (32+) — устойчивый цикл → 1.2. Без numpy/wavelet — 1.0.
    """
    if not _HAS_WAVELET or len(closes) < 32:
        return 1.0
    try:
        res = wavelet_transform(closes)
        scale = res["dominant_scale"]
        if scale <= 8:
            return 0.7
        if scale <= 32:
            return 1.0
        return 1.2
    except Exception:
        return 1.0


def score_wavelet_signal(candles: list[HistoricCandle]) -> float:
    """WAVELET_SIGNAL: как метод композита — нейтральный score 0.0; реальный
    эффект через wavelet_confidence_mult (множитель уверенности в composite)."""
    return 0.0


# ── Стратегия ─────────────────────────────────────────────────────────────────

METHODS = [
    ("PRICE_TREND",    score_price_trend),
    ("VOL_MOMENTUM",   score_vol_momentum),
    ("VWAP_SIGNAL",    score_vwap_signal),
    ("BS_PRESSURE",    score_bs_pressure),
    ("CANDLE_PATTERN", score_candle_pattern),
    ("ADAPTIVE_MA",    score_adaptive_ma_candle),
    ("TREND_QUALITY",  score_trend_quality_candle),
    ("FRACTAL",        score_fractal_candle),
    ("ENTROPY",        score_entropy_candle),
    ("CYBER_CYCLE",    score_cyber_cycle_candle),
    ("DECYCLER",       score_decycler_candle),
    ("FISHER_RSI",     score_fisher_rsi_candle),
    ("EBSW",           score_ebsw_candle),
    ("KLINGER",        score_klinger_candle),
    ("VZO",            score_vzo_candle),
    ("TWIGGS",         score_twiggs_candle),
    ("RMI",            score_rmi_candle),
    ("ZSCORE",         score_zscore_candle),
    # Wave 2: новые методы
    ("ZLEMA_SIGNAL",   score_zlema_signal),
    ("T3_SIGNAL",      score_t3_signal),
    ("SINEWAVE_SIGNAL", score_sinewave_signal),
    ("MMI_SIGNAL",     score_mmi_signal),
    ("YZ_VOL_SIGNAL",  score_yz_vol_signal),
    ("VR_SIGNAL",      score_vr_signal),
    ("WAVELET_SIGNAL", score_wavelet_signal),
    ("SSA_SIGNAL",     score_ssa_signal),
    ("HAWKES_SIGNAL",  score_hawkes_signal),
]

OI_SQUEEZE_NAME = "OI_SQUEEZE"
INST_OI_NAME = "INST_OI"
RETAIL_CONTRA_NAME = "RETAIL_CONTRA"
# Методы микроструктуры (tradestats/obstats/orderstats, см. tradestats.py).
# Имена соответствуют ключам TradeStatsService.SCORE_FUNCS.
TRADESTATS_METHOD_NAMES = [
    "BS_PRESSURE_TS", "AGGRESSOR_FLOW", "LARGE_IMPACT",
    "VWAP_SIGNAL_TS", "VOL_MOMENTUM_TS", "OB_IMBALANCE", "CANCEL_SIGNAL",
]
CHANGE_POINT_NAME = "CHANGE_POINT"
MULTI_TICKER_NAME = "MULTI_TICKER"
# Три кластерных модели — конкурируют наравне с остальными методами.
# Вычисляются в ClusterModels (cluster_models.py) поверх истории сделок.
M1_NAME = "M1_CLUSTER"
M2_NAME = "M2_CLUSTER"
M3_NAME = "M3_CLUSTER"

ALL_METHOD_NAMES = (
    [name for name, _ in METHODS]
    + [OI_SQUEEZE_NAME, INST_OI_NAME, RETAIL_CONTRA_NAME]
    + TRADESTATS_METHOD_NAMES
    + [CHANGE_POINT_NAME, MULTI_TICKER_NAME]
    + [M1_NAME, M2_NAME, M3_NAME]
)

# (ticker, direction) -> squeeze_score; подключается извне (Trader), т.к.
# у самой стратегии нет доступа к сети/oi_layers.py. Без подключённого
# провайдера метод просто молчит (score=0, не участвует в "согласии" и не
# обучает свой вес — см. __record_outcome).
SqueezeProvider = Callable[[str, str], float]
# (ticker) -> score [-1, 1]; m_INST_OI / m_RETAIL_CONTRA из oi_layers.py.
ScoreProvider = Callable[[str], float]
# (ticker, method_name) -> score [-1, 1]; методы микроструктуры из tradestats.py.
TradeStatsProvider = Callable[[str, str], float]
# (ticker) -> score [-1, 1]; межинструментальный сигнал (indicators_multi.py).
MultiTickerProvider = Callable[[str], float]
# (ticker) -> исторические свечи (для авто-подбора ATR_TAKE_K/ATR_STOP_K, см.
# __recalc_auto_atr) — Trader подключает get_candles_cached. Без провайдера
# (или если в settings.ini заданы явные ATR_TAKE_K/ATR_STOP_K) авто-подбор не запускается.
AtrHistoryProvider = Callable[[str], list[HistoricCandle]]

AUTO_ATR_TAKE_KS = (2.0, 3.0, 4.0)
AUTO_ATR_STOP_KS = (1.0, 1.5, 2.0)
AUTO_ATR_MIN_TRADES = 20           # меньше сделок на истории — авто-подбору не доверяем
                                    # (sweep по 3-9 исходам — это подбор по шуму, не сигнал)


class OICompositeStrategy(IStrategy):
    """
    Многометодная стратегия. Комбинирует 5 методов анализа свечей с обучаемыми весами.
    Параметры (settings.ini):
      SIGNAL_THRESHOLD  — порог composite для сигнала (0.0–1.0, default 0.25)
      LONG_TAKE         — множитель take-profit для LONG
      LONG_STOP         — множитель stop-loss для LONG
      SHORT_TAKE        — множитель take-profit для SHORT
      SHORT_STOP        — множитель stop-loss для SHORT
      SIGNAL_ONLY       — 0/1: если 1, ордера не исполняются (только Telegram)
    """

    def __init__(self, settings: StrategySettings) -> None:
        self.__settings = settings
        s = settings.settings

        self.__threshold = float(s.get("SIGNAL_THRESHOLD", SIGNAL_THRESHOLD))
        self.__long_take = Decimal(s.get("LONG_TAKE", "1.015"))
        self.__long_stop = Decimal(s.get("LONG_STOP", "0.985"))
        self.__short_take = Decimal(s.get("SHORT_TAKE", "0.985"))
        self.__short_stop = Decimal(s.get("SHORT_STOP", "1.015"))
        self.__signal_only = s.get("SIGNAL_ONLY", "0") == "1"

        # ATR-based take/stop: если в settings.ini заданы оба коэффициента —
        # уровни считаются от ATR (динамически, под текущую волатильность);
        # иначе остаются фиксированные множители LONG_TAKE/STOP (обратная совместимость).
        self.__atr_take_k = float(s["ATR_TAKE_K"]) if "ATR_TAKE_K" in s else None
        self.__atr_stop_k = float(s["ATR_STOP_K"]) if "ATR_STOP_K" in s else None

        self.__candles: list[HistoricCandle] = []
        self.__open_trade: Optional[OpenTrade] = None
        self.__weights: dict[str, MethodWeight] = self.__load_weights()
        self.__rolling_quality: float = self.__load_rolling_quality()
        self.__confidence: float = 0.7
        self.__squeeze_provider: Optional[SqueezeProvider] = None
        self.__inst_oi_provider: Optional[ScoreProvider] = None
        self.__retail_contra_provider: Optional[ScoreProvider] = None
        self.__tradestats_provider: Optional[TradeStatsProvider] = None
        self.__multi_ticker_provider: Optional[MultiTickerProvider] = None
        self.__regime_confidence: float = 1.0
        self.__last_regime: str = "ranging"
        self.__last_scores: dict[str, float] = {}
        self.__last_composite: float = 0.0
        # HistoryStore + PercentileCalibrator — опциональны, инжектируются извне
        self.__history = None
        self.__calibrator = None
        self.__db = None
        # Динамические REGIME_WEIGHT_MODS из истории (обновляются при set_history)
        self.__dynamic_regime_mods: dict[str, dict[str, float]] = {}
        # tf-регимы от MultiTfBuffer (обновляются трейдером на каждой свече)
        self.__tf_regimes: dict[str, str] = {}
        # Кластерные модели M1/M2/M3 — инициализируются при set_history
        self.__cluster_models: Optional[ClusterModels] = None
        # Авто-подбор ATR_TAKE_K/ATR_STOP_K (если в settings.ini не зафиксированы
        # явные значения) — см. __recalc_auto_atr.
        self.__atr_history_provider: Optional[AtrHistoryProvider] = None
        self.__auto_atr_take_k: Optional[float] = None
        self.__auto_atr_stop_k: Optional[float] = None
        self.__auto_atr_recalc_date: Optional[object] = None

        logger.info(
            f"OICompositeStrategy init: figi={settings.figi} "
            f"threshold={self.__threshold} signal_only={self.__signal_only}"
        )

    @property
    def settings(self) -> StrategySettings:
        return self.__settings

    @property
    def signal_only(self) -> bool:
        """Если True — ордера не выставляем, только Telegram-уведомления."""
        return self.__signal_only

    @property
    def confidence(self) -> float:
        """
        Уверенность последнего сигнала (0-1) для risk.py.
        composite ограничен ~[-1, 1] (см. __compute_composite), поэтому
        confidence = 0.5 + 0.5*|composite|: порог сигнала (composite=threshold,
        обычно 0.25) даёт ~0.6, насыщение (composite=1.0) даёт 1.0.
        """
        return self.__confidence

    def update_lot_count(self, lot: int) -> None:
        self.__settings.lot_size = lot

    def update_short_status(self, status: bool) -> None:
        self.__settings.short_enabled_flag = status

    def set_signal_only(self, flag: bool) -> None:
        """Переключение sandbox-режима после создания — для тикеров, добавленных динамически по MEGA-ALERTS."""
        self.__signal_only = flag

    def is_signal_only(self) -> bool:
        return self.__signal_only

    def set_take_stop_overrides(
            self,
            long_take: Decimal | None = None,
            long_stop: Decimal | None = None,
            short_take: Decimal | None = None,
            short_stop: Decimal | None = None,
    ) -> None:
        """
        Хот-релоад LONG_TAKE/LONG_STOP/SHORT_TAKE/SHORT_STOP из дашборда
        (runtime_overrides.py) без пересоздания стратегии. Множители
        закэшированы в __init__ как Decimal и иначе не перечитываются —
        этот сеттер единственный способ применить новые значения. Влияет
        только на сигналы, которые будут сгенерированы ПОСЛЕ вызова (уже
        открытая позиция использует stop_loss_level/take_profit_level,
        зафиксированные в сигнале на момент открытия).
        """
        if long_take is not None:
            self.__long_take = long_take
        if long_stop is not None:
            self.__long_stop = long_stop
        if short_take is not None:
            self.__short_take = short_take
        if short_stop is not None:
            self.__short_stop = short_stop

    def set_squeeze_provider(self, provider: Optional[SqueezeProvider]) -> None:
        """
        provider(ticker, direction) -> squeeze_score [0..1], см. oi_layers.py.
        Подключается Trader'ом — у него есть OiLayersService, у стратегии нет.
        """
        self.__squeeze_provider = provider

    def set_inst_oi_provider(self, provider: Optional[ScoreProvider]) -> None:
        """provider(ticker) -> m_INST_OI score, см. oi_layers.py.OiLayersService.inst_oi_score."""
        self.__inst_oi_provider = provider

    def set_retail_contra_provider(self, provider: Optional[ScoreProvider]) -> None:
        """provider(ticker) -> m_RETAIL_CONTRA score, см. oi_layers.py.OiLayersService.retail_contra_score."""
        self.__retail_contra_provider = provider

    def set_tradestats_provider(self, provider: Optional[TradeStatsProvider]) -> None:
        """provider(ticker, method_name) -> score, см. tradestats.py.TradeStatsService.score."""
        self.__tradestats_provider = provider

    def set_multi_ticker_provider(self, provider: Optional[MultiTickerProvider]) -> None:
        """provider(ticker) -> score [-1,1], межинструментальный сигнал (indicators_multi.py)."""
        self.__multi_ticker_provider = provider

    def set_atr_history_provider(self, provider: Optional[AtrHistoryProvider]) -> None:
        """
        provider(ticker) -> исторические свечи для авто-подбора ATR_TAKE_K/
        ATR_STOP_K (Trader подключает get_candles_cached). Игнорируется, если
        в settings.ini для этого тикера явно зафиксированы ATR_TAKE_K/ATR_STOP_K.
        """
        self.__atr_history_provider = provider

    def set_history(self, history, calibrator, db=None) -> None:
        """
        Инжектирует HistoryStore и PercentileCalibrator.
        После этого:
        - composite строится на перцентильно-нормализованных скорах
        - REGIME_WEIGHT_MODS заменяются динамическими (из истории сделок)
        - notify_position_closed получает реальные MFE/MAE и пишет в историю
        - если передан db (DbApiClient, configured) — сделка дублируется в
          общую базу (cf-collector), чтобы другие инстансы видели attribution
        """
        self.__history = history
        self.__calibrator = calibrator
        self.__db = db
        ticker = self.__settings.ticker
        # Прогрев калибратора из истории дневных скоров
        if calibrator is not None and history is not None:
            method_scores = {
                name: history.daily_scores(ticker, name, window_days=90)
                for name in ALL_METHOD_NAMES
            }
            calibrator.warm_up(ticker, {k: v for k, v in method_scores.items() if v})
        # Загрузка динамических режимных модификаторов из истории сделок
        self._reload_dynamic_regime_mods()
        # Инициализация кластерных моделей M1/M2/M3
        self.__cluster_models = ClusterModels(history, self.__settings.ticker)

    def _reload_dynamic_regime_mods(self) -> None:
        """Пересчитывает per-regime accuracy из истории и сохраняет в __dynamic_regime_mods."""
        if self.__history is None:
            return
        ticker = self.__settings.ticker
        regime_perf = self.__history.regime_method_performance(ticker, window_days=90)
        if not regime_perf:
            return
        # Преобразуем avg_quality → мультипликатор веса: 0.5 = нейтраль → 1.0,
        # 0.8 = хороший → 1.6, 0.2 = плохой → 0.4. Диапазон [0.2, 2.0].
        mods: dict[str, dict[str, float]] = {}
        for regime, methods in regime_perf.items():
            mods[regime] = {
                method: max(0.2, min(2.0, quality * 2.0))
                for method, quality in methods.items()
            }
        self.__dynamic_regime_mods = mods
        logger.info(
            f"{self.__settings.ticker}: загружены динамические режимные моды "
            f"для {len(mods)} режимов из истории"
        )

    def set_tf_regimes(self, tf_regimes: dict[str, str]) -> None:
        """
        Обновляет текущие режимы по таймфреймам от MultiTfBuffer.
        tf_regimes = {"1min": "trending_up", "5min": "ranging", "1h": "trending_up"}
        Используется для записи tf-контекста в историю сделок.
        """
        self.__tf_regimes = tf_regimes

    # ── Публичный метод — вызывается на каждой свече ─────────────────────────

    def analyze_candles(self, candles: list[HistoricCandle]) -> Optional[Signal]:
        self.__recalc_auto_atr()
        self.__candles.extend(candles)
        # окно: последние CANDLE_WINDOW свечей
        if len(self.__candles) > CANDLE_WINDOW:
            self.__candles = self.__candles[-CANDLE_WINDOW:]

        # накапливаем историю открытой сделки для MFE/MAE
        if self.__open_trade:
            for c in candles:
                self.__open_trade.add_candle(c)
            if len(self.__open_trade.after_candles) >= MFE_MAE_BARS:
                self.__record_outcome()

        if len(self.__candles) < MIN_CANDLES:
            return None

        # ATR-фильтр: если средний ход меньше комиссии×фактор — движение не
        # окупает торговлю, сигнал не выдаём (защита от "мёртвых" инструментов).
        atr_pct = _compute_atr(self.__candles)
        if atr_pct < commission_rt(self.__settings.is_future) * MIN_ATR_FACTOR:
            logger.debug(f"{self.__settings.figi}: пропуск — ATR {atr_pct:.4f} ниже комиссии×{MIN_ATR_FACTOR}")
            return None

        # вычисляем composite
        composite, scores = self.__compute_composite()
        logger.debug(
            f"{self.__settings.figi} composite={composite:.3f} "
            f"scores={dict(zip(ALL_METHOD_NAMES, [round(s, 3) for s in scores]))}"
        )

        # порог адаптируется под режим рынка, поверх — прогрев/плохая полоса
        adaptive = _adaptive_threshold(self.__threshold, self.__last_regime)
        effective_threshold = self.__effective_threshold(adaptive)

        direction: Optional[SignalType] = None
        if composite >= effective_threshold:
            direction = SignalType.LONG
        elif self.__settings.short_enabled_flag and composite <= -effective_threshold:
            direction = SignalType.SHORT

        if direction is None:
            return None

        if not self.__methods_agree(scores, direction):
            logger.debug(f"{self.__settings.figi}: сигнал {direction} отфильтрован — мало методов согласны")
            return None

        if not self.__liquidity_ok():
            logger.debug(f"{self.__settings.figi}: сигнал {direction} отфильтрован — тонкая свеча (низкий объём)")
            return None

        # take/stop: ATR-based если заданы коэффициенты, иначе фиксированные множители
        take_mult, stop_mult = self.__take_stop_mults(direction, atr_pct)

        # целесообразность сделки: если тейк-профит даже без проскальзывания
        # не покрывает комиссию за круг с запасом MIN_ATR_FACTOR — сделка
        # на бумаге не отрицательная, но и невыгодная, не входим.
        take_dist = abs(float(take_mult) - 1.0)
        if take_dist < commission_rt(self.__settings.is_future) * MIN_ATR_FACTOR:
            logger.debug(
                f"{self.__settings.figi}: сигнал {direction} отфильтрован — "
                f"тейк {take_dist:.4f} не покрывает комиссию с запасом"
            )
            return None

        return self.__make_signal(direction, take_mult, stop_mult, scores)

    def notify_position_closed(
            self,
            exit_price: float = 0.0,
            mfe: float = 0.0,
            mae: float = 0.0,
    ) -> None:
        """
        Вызвать извне при закрытии позиции.
        exit_price, mfe, mae — реальные значения от трейдера (доли от entry).
        Если переданы — используются вместо после-свечного расчёта OpenTrade.
        """
        if self.__open_trade:
            self.__record_outcome(exit_price=exit_price, mfe=mfe, mae=mae)

    def warmup(self, candles: list[HistoricCandle]) -> None:
        """
        Прогрев окна свечей исторической выгрузкой — чтобы новый (например,
        найденный через MEGA-ALERTS) тикер не ждал MIN_CANDLES живых свечей
        перед первым сигналом. Открытых сделок не затрагивает.
        """
        self.__candles = candles[-CANDLE_WINDOW:]

    def backtest_quality(self, candles: list[HistoricCandle], lookahead: int = MFE_MAE_BARS) -> tuple[float, int]:
        """
        Прогон композита по исторической свечной выгрузке без реальных
        сделок — оценка, "дают ли модели хороший %" на этом тикере ДО того,
        как пускать его в реальную торговлю. quality того же вида, что и в
        EWA (MFE/(MFE+MAE)), считается по виртуальным сделкам на пересечении
        порога; виртуальные сделки не пересекаются по времени (после входа
        пропускаем `lookahead` баров). Реальное состояние стратегии
        (свечи/открытая сделка) не трогает — окно подменяется только на
        время вызова.
        Возвращает (средний quality, число виртуальных сделок).
        """
        if len(candles) < CANDLE_WINDOW + lookahead + 1:
            return 0.5, 0

        saved_candles = self.__candles
        qualities: list[float] = []
        try:
            i = CANDLE_WINDOW
            while i < len(candles) - lookahead:
                self.__candles = candles[i - CANDLE_WINDOW:i]
                composite, _ = self.__compute_composite()

                direction: Optional[SignalType] = None
                if composite >= self.__threshold:
                    direction = SignalType.LONG
                elif self.__settings.short_enabled_flag and composite <= -self.__threshold:
                    direction = SignalType.SHORT

                if direction is None:
                    i += 1
                    continue

                entry = _to_f(candles[i].close)
                future = candles[i + 1:i + 1 + lookahead]
                highs = [_to_f(c.high) for c in future]
                lows = [_to_f(c.low) for c in future]
                if direction == SignalType.LONG:
                    mfe = max(0.0, (max(highs) - entry) / entry) if highs else 0.0
                    mae = max(0.0, (entry - min(lows)) / entry) if lows else 0.0
                else:
                    mfe = max(0.0, (entry - min(lows)) / entry) if lows else 0.0
                    mae = max(0.0, (max(highs) - entry) / entry) if highs else 0.0
                # MFE за вычетом комиссии за круг (своя ставка для акции/фьючерса
                # и текущего тарифа из settings.ini) — движение цены меньше
                # комиссии не даёт реальной прибыли на реальном счёте.
                mfe_net = max(0.0, mfe - commission_rt(self.__settings.is_future))
                qualities.append(mfe_net / (mfe_net + mae) if (mfe_net + mae) > 0 else 0.5)
                i += lookahead  # не пересекать виртуальные сделки
        finally:
            self.__candles = saved_candles

        if not qualities:
            return 0.5, 0
        return sum(qualities) / len(qualities), len(qualities)

    def backtest_scan_signals(self, candles: list[HistoricCandle], max_bars: int = 60) -> list[dict]:
        """
        Один проход по свечам с дорогим __compute_composite() (внутри —
        Hawkes-MLE через scipy.optimize и другие методы) — собирает все бары,
        где стратегия дала бы сигнал, вместе с ATR на момент входа и окном
        свечей для поиска барьера. Позволяет прогнать backtest_barriers() с
        разными take/stop без повторного пересчёта composite на каждой
        комбинации — см. compare_take_stop.py, где иначе один и тот же
        дорогой проход повторялся бы 10 раз на тикер.
        """
        if len(candles) < CANDLE_WINDOW + 2:
            return []

        saved_candles = self.__candles
        signals: list[dict] = []
        total_bars = len(candles) - 1 - CANDLE_WINDOW
        t_start = time.monotonic()
        t_last_log = t_start
        try:
            i = CANDLE_WINDOW
            while i < len(candles) - 1:
                done = i - CANDLE_WINDOW
                now = time.monotonic()
                if now - t_last_log >= 5 and done > 0:  # не реже раза в 5с, независимо от скорости бара
                    t_last_log = now
                    elapsed = now - t_start
                    rate = done / elapsed if elapsed > 0 else 0
                    eta = (total_bars - done) / rate if rate > 0 else 0
                    logger.info(
                        f"{self.__settings.ticker}: скан {done}/{total_bars} баров "
                        f"({100 * done / total_bars:.0f}%), {elapsed:.0f}с прошло, ~{eta:.0f}с осталось"
                    )
                self.__candles = candles[i - CANDLE_WINDOW:i]
                composite, _ = self.__compute_composite()

                direction: Optional[SignalType] = None
                if composite >= self.__threshold:
                    direction = SignalType.LONG
                elif self.__settings.short_enabled_flag and composite <= -self.__threshold:
                    direction = SignalType.SHORT

                if direction is None:
                    i += 1
                    continue

                entry = _to_f(candles[i].close)
                atr_pct = _compute_atr(self.__candles)
                window = candles[i + 1:i + 1 + max_bars]
                signals.append({
                    "direction": direction, "entry": entry, "atr_pct": atr_pct, "window": window,
                    "entry_time": candles[i].time,
                })
                i += max(1, len(window))  # не пересекать виртуальные сделки
        finally:
            self.__candles = saved_candles

        return signals

    def backtest_barriers(
            self,
            candles: Optional[list[HistoricCandle]] = None,
            take_mult: Optional[Decimal] = None,
            stop_mult: Optional[Decimal] = None,
            atr_take_k: Optional[float] = None,
            atr_stop_k: Optional[float] = None,
            max_bars: int = 60,
            signals: Optional[list[dict]] = None,
            return_trades: bool = False,
            tariff: Optional[str] = None,
    ) -> dict:
        """
        В отличие от backtest_quality() (которая мерит MFE/MAE на фиксированном
        окне и не знает про take/stop вообще), здесь честно симулируется
        исполнение: для каждой виртуальной сделки бар-за-баром ищем, какой
        барьер (take или stop) пробивается первым, до max_bars. Если ни один —
        сделка закрывается по последней цене окна (timeout).

        Передайте либо (take_mult, stop_mult) — фиксированные множители,
        либо (atr_take_k, atr_stop_k) — ATR-based (как в __take_stop_mults) —
        чтобы сравнить два режима на одной и той же истории.

        Передайте `candles`, либо готовый `signals` (из backtest_scan_signals)
        — второе избегает повторного дорогого пересчёта composite, если
        нужно сравнить несколько комбинаций take/stop на одной истории.

        return_trades=True добавляет в ответ "trades" — список отдельных
        сделок ({entry_time, exit_time, direction, net_pct, r_multiple, win}),
        нужен дашборду для портфельной симуляции (сделки разных тикеров по
        хронологии на одном виртуальном счёте).

        Возвращает {"n_trades", "win_rate", "avg_r", "expectancy_pct"} —
        expectancy_pct уже за вычетом commission_rt за круг.

        tariff — "TRADER"/"PREMIUM", переопределяет settings.ini [COMMISSION]
        TARIFF на время этого расчёта (дашборд — сравнить тарифы без правки
        settings.ini). None — берётся ini-тариф, как раньше.
        """
        if signals is None:
            signals = self.backtest_scan_signals(candles, max_bars=max_bars)

        empty = {"n_trades": 0, "win_rate": 0.0, "avg_r": 0.0, "expectancy_pct": 0.0}
        if return_trades:
            empty["trades"] = []
        if not signals:
            return empty

        comm = commission_rt(self.__settings.is_future, tariff=tariff)
        results: list[tuple[bool, float, float]] = []  # (win, r_multiple, net_pct)
        trades: list[dict] = []
        for sig in signals:
            direction, entry, atr_pct, window = sig["direction"], sig["entry"], sig["atr_pct"], sig["window"]

            if atr_take_k is not None and atr_stop_k is not None:
                if atr_pct <= 0:
                    continue
                take_dist = atr_take_k * atr_pct
                stop_dist = atr_stop_k * atr_pct
            else:
                take_dist = abs(float(take_mult) - 1.0)
                stop_dist = abs(float(stop_mult) - 1.0)

            if direction == SignalType.LONG:
                take_price = entry * (1 + take_dist)
                stop_price = entry * (1 - stop_dist)
            else:
                take_price = entry * (1 - take_dist)
                stop_price = entry * (1 + stop_dist)

            exit_pct: Optional[float] = None
            exit_time = window[-1].time if window else sig.get("entry_time")
            for c in window:
                h = _to_f(c.high)
                lo = _to_f(c.low)
                if direction == SignalType.LONG:
                    hit_take = h >= take_price
                    hit_stop = lo <= stop_price
                else:
                    hit_take = lo <= take_price
                    hit_stop = h >= stop_price
                if hit_take and hit_stop:
                    # обе цены задело в одной свече — консервативно считаем стоп первым
                    exit_pct = -stop_dist
                    exit_time = c.time
                    break
                if hit_take:
                    exit_pct = take_dist
                    exit_time = c.time
                    break
                if hit_stop:
                    exit_pct = -stop_dist
                    exit_time = c.time
                    break
            if exit_pct is None:
                last_close = _to_f(window[-1].close) if window else entry
                exit_pct = (last_close - entry) / entry if direction == SignalType.LONG \
                    else (entry - last_close) / entry

            net_pct = exit_pct - comm
            r_multiple = net_pct / stop_dist if stop_dist > 0 else 0.0
            results.append((net_pct > 0, r_multiple, net_pct))
            if return_trades:
                trades.append({
                    "entry_time": sig.get("entry_time"), "exit_time": exit_time,
                    "direction": direction.name, "net_pct": net_pct,
                    "r_multiple": r_multiple, "win": net_pct > 0,
                })

        if not results:
            return empty

        n = len(results)
        wins = sum(1 for w, _, _ in results if w)
        out = {
            "n_trades": n,
            "win_rate": wins / n,
            "avg_r": sum(r for _, r, _ in results) / n,
            "expectancy_pct": sum(p for _, _, p in results) / n,
        }
        if return_trades:
            out["trades"] = trades
        return out

    # ── Внутренние методы ─────────────────────────────────────────────────────

    def __compute_composite(self) -> tuple[float, list[float]]:
        window = self.__candles
        vhf_mult = score_volatility_regime(window)
        closes = [_to_f(c.close) for c in window]
        volumes = [float(c.volume) for c in window]

        base_scores = [fn(window) for _, fn in METHODS] + [
            self.__score_oi_squeeze(),
            self.__score_provider(self.__inst_oi_provider),
            self.__score_provider(self.__retail_contra_provider),
        ] + [self.__score_tradestats(name) for name in TRADESTATS_METHOD_NAMES] \
          + [change_point_score(closes), self.__score_multi_ticker()]

        # classify_regime возвращает (режим, уверенность-в-режиме).
        regime, regime_conf = classify_regime(closes, volumes)

        # Кластерные модели M1/M2/M3: обновляем при смене режима,
        # вычисляем на текущих скорах. До накопления истории — 0.
        base_score_dict = dict(zip(
            [name for name, _ in METHODS]
            + [OI_SQUEEZE_NAME, INST_OI_NAME, RETAIL_CONTRA_NAME]
            + TRADESTATS_METHOD_NAMES
            + [CHANGE_POINT_NAME, MULTI_TICKER_NAME],
            base_scores
        ))
        m1_sc = m2_sc = m3_sc = 0.0
        if self.__cluster_models is not None:
            if self.__cluster_models.needs_refresh(regime):
                self.__cluster_models.refresh(regime)
            m1_sc, m2_sc, m3_sc = self.__cluster_models.compute(base_score_dict)

        scores = base_scores + [m1_sc, m2_sc, m3_sc]

        # Перцентильная нормализация: если калибратор прогрет — приводим каждый
        # скор к шкале [-1, 1] относительно его исторического распределения.
        # Без нормализации "громкие" методы (большой масштаб) доминируют случайно.
        ticker = self.__settings.ticker
        if self.__calibrator is not None:
            norm_scores = []
            for name, s in zip(ALL_METHOD_NAMES, scores):
                self.__calibrator.update(ticker, name, s)
                if self.__calibrator.ready(ticker, name):
                    norm_scores.append(self.__calibrator.normalize(ticker, name, s))
                else:
                    norm_scores.append(s)
            scores_for_composite = norm_scores
        else:
            scores_for_composite = scores

        # Режимные мультипликаторы: динамические (из истории) в приоритете
        # над захардкоженными REGIME_WEIGHT_MODS. Если динамических нет —
        # откат на статику (обратная совместимость).
        if self.__dynamic_regime_mods.get(regime):
            dyn = self.__dynamic_regime_mods[regime]
            # Берём динамику для методов с историей, для остальных — статику
            static = REGIME_WEIGHT_MODS.get(regime, {})
            regime_mods = {name: dyn.get(name, static.get(name, 1.0)) for name in ALL_METHOD_NAMES}
        else:
            regime_mods = REGIME_WEIGHT_MODS.get(regime, {})

        weights = [self.__weights[name].weight * regime_mods.get(name, 1.0) for name in ALL_METHOD_NAMES]

        weighted = sum(s * w for s, w in zip(scores_for_composite, weights))
        weight_sum = sum(weights) or 1.0
        composite = (weighted / weight_sum) * (0.6 + 0.4 * vhf_mult)

        confidence_mult = self.__rqa_confidence_mult(closes)
        confidence_mult *= wavelet_confidence_mult(closes)
        confidence_mult *= regime_conf
        composite *= confidence_mult

        self.__last_regime = regime
        self.__regime_confidence = regime_conf
        # __last_scores хранит сырые скоры — для архива и диагностики
        self.__last_scores = dict(zip(ALL_METHOD_NAMES, scores))
        self.__last_composite = composite
        return composite, scores

    def __rqa_confidence_mult(self, closes: list[float]) -> float:
        """
        RQA DET на последних 30 closes → множитель уверенности composite.
        DET>0.7 (детерминированный ряд) усиливаем до 1.0+(DET-0.7)*0.5;
        DET<0.3 (хаос) ослабляем до max(0.5, DET/0.3*0.7). Без numpy/RQA — 1.0.
        """
        if not _HAS_RQA or len(closes) < 12:
            return 1.0
        try:
            res = rqa_signal(_np.asarray(closes[-30:], dtype=float), dim=3, tau=1)
            det = float(res["DET"])
            if det > 0.7:
                return 1.0 + (det - 0.7) * 0.5
            if det < 0.3:
                return max(0.5, det / 0.3 * 0.7)
            return 1.0
        except Exception:
            return 1.0

    def last_snapshot(self) -> dict:
        """Последний расчёт composite/scores/режима — для архива (archive.py), не торговая логика."""
        return {
            "composite": self.__last_composite,
            "scores": dict(self.__last_scores),
            "regime": self.__last_regime,
            "regime_confidence": self.__regime_confidence,
            "rolling_quality": self.__rolling_quality,
            "auto_atr_take_k": self.__auto_atr_take_k,
            "auto_atr_stop_k": self.__auto_atr_stop_k,
        }

    def __score_oi_squeeze(self) -> float:
        """
        squeeze_up (риск для шорта — физики/юр.лица недавно крупно нарастили
        шорт, цена против них) — бычий сигнал на LONG. squeeze_down — зеркально
        медвежий. Без подключённого провайдера (Trader не вызвал
        set_squeeze_provider) метод молчит — это ок, он просто не участвует.
        """
        if not self.__squeeze_provider:
            return 0.0
        ticker = self.__settings.ticker
        squeeze_up = self.__squeeze_provider(ticker, "short")
        squeeze_down = self.__squeeze_provider(ticker, "long")
        # m_SQUEEZE_RISK (oi-signal-v10.html): tanh-нелинейность, не линейный клип —
        # риск растёт резко после ~0.2-0.3 разницы, а не равномерно до 1.0.
        return math.tanh((squeeze_up - squeeze_down) * 2.5)

    def __score_provider(self, provider: Optional[ScoreProvider]) -> float:
        """m_INST_OI / m_RETAIL_CONTRA: без подключённого провайдера метод молчит (score=0)."""
        if not provider:
            return 0.0
        return provider(self.__settings.ticker)

    def __score_tradestats(self, method_name: str) -> float:
        """Без подключённого провайдера (нет MOEX_TOKEN / tradestats.py не подключён) — молчит."""
        if not self.__tradestats_provider:
            return 0.0
        return self.__tradestats_provider(self.__settings.ticker, method_name)

    def __score_multi_ticker(self) -> float:
        """
        MULTI_TICKER: межинструментальный сигнал (transfer entropy / wavelet
        coherence / RMT-вес, см. indicators_multi.py). Требует ряда второго
        инструмента — поэтому считается извне в провайдере. Без него молчит.
        """
        if not self.__multi_ticker_provider:
            return 0.0
        try:
            return max(-1.0, min(1.0, float(self.__multi_ticker_provider(self.__settings.ticker))))
        except Exception:
            return 0.0

    def __methods_agree(self, scores: list[float], direction: SignalType) -> bool:
        """Хотя бы MIN_AGREE_METHODS методов высказались (|score|>=AGREE_SCORE_MIN) за это направление."""
        sign = 1 if direction == SignalType.LONG else -1
        agree = sum(1 for s in scores if abs(s) >= AGREE_SCORE_MIN and (s > 0) == (sign > 0))
        return agree >= MIN_AGREE_METHODS

    def __liquidity_ok(self) -> bool:
        """Объём последней свечи не аномально мал относительно медианы окна."""
        volumes = [c.volume for c in self.__candles]
        if len(volumes) < 5:
            return True
        median_vol = statistics.median(volumes)
        if median_vol <= 0:
            return True
        return volumes[-1] >= LIQUIDITY_MIN_RATIO * median_vol

    def __effective_threshold(self, base: Optional[float] = None) -> float:
        """
        Базовый порог (по умолчанию self.__threshold; analyze_candles передаёт
        уже адаптированный под режим), ужесточённый в полосе слабых сделок.
        Прогрев-гейт по числу сделок убран: EWA весов (WEIGHT_ALPHA=0.1) и так
        слабо реагирует на первые сделки — отдельный штраф по выборке давал
        ложную уверенность в "ненадёжности" там, где выборка просто маленькая
        и шум нельзя отличить от сигнала, а не где модель размашисто переобучена.
        """
        base = self.__threshold if base is None else base
        mult = 1.0
        if self.__rolling_quality < LOW_QUALITY_THRESHOLD:
            mult *= LOW_QUALITY_MULT
        return base * mult

    def __recalc_auto_atr(self) -> None:
        """
        Авто-подбор ATR_TAKE_K/ATR_STOP_K по исторической выгрузке — раз в
        день, тот же sweep, что в дашборде (run_backtest_one): перебираем
        AUTO_ATR_TAKE_KS x AUTO_ATR_STOP_KS, берём пару с лучшим expectancy_pct.
        Не запускается, если ATR_TAKE_K/ATR_STOP_K зафиксированы в settings.ini
        (явная настройка приоритетнее) или провайдер истории не подключён.
        """
        if self.__atr_take_k is not None and self.__atr_stop_k is not None:
            return
        if self.__atr_history_provider is None:
            return
        today = datetime.datetime.now(datetime.timezone.utc).date()
        if self.__auto_atr_recalc_date == today:
            return
        self.__auto_atr_recalc_date = today

        try:
            history = self.__atr_history_provider(self.__settings.ticker)
            if not history:
                return
            signals = self.backtest_scan_signals(history)
            best = None
            for tk in AUTO_ATR_TAKE_KS:
                for sk in AUTO_ATR_STOP_KS:
                    res = self.backtest_barriers(signals=signals, atr_take_k=tk, atr_stop_k=sk)
                    if res["n_trades"] < AUTO_ATR_MIN_TRADES:
                        continue
                    if best is None or res["expectancy_pct"] > best[1]:
                        best = ((tk, sk), res["expectancy_pct"])
            if best:
                (tk, sk), exp = best
                self.__auto_atr_take_k, self.__auto_atr_stop_k = tk, sk
                logger.info(f"{self.__settings.ticker}: авто-ATR k={tk}/{sk} (expectancy={exp:.4f}%)")
        except Exception:
            logger.exception(f"{self.__settings.ticker}: авто-подбор ATR_TAKE_K/ATR_STOP_K упал")

    def __take_stop_mults(self, direction: SignalType, atr_pct: float) -> tuple[Decimal, Decimal]:
        """
        Множители take/stop. Если в settings заданы ATR_TAKE_K и ATR_STOP_K —
        уровни считаются от ATR (динамически под волатильность): take = 1 ± k*ATR%.
        Если не заданы, но подключён __atr_history_provider — используется
        авто-подобранная пара (__recalc_auto_atr). Иначе — фиксированные
        LONG_*/SHORT_* (полная обратная совместимость).
        """
        take_k = self.__atr_take_k if self.__atr_take_k is not None else self.__auto_atr_take_k
        stop_k = self.__atr_stop_k if self.__atr_stop_k is not None else self.__auto_atr_stop_k
        if take_k is not None and stop_k is not None and atr_pct > 0:
            take_off = Decimal(str(take_k * atr_pct))
            stop_off = Decimal(str(stop_k * atr_pct))
            if direction == SignalType.LONG:
                return Decimal("1") + take_off, Decimal("1") - stop_off
            return Decimal("1") - take_off, Decimal("1") + stop_off
        if direction == SignalType.LONG:
            return self.__long_take, self.__long_stop
        return self.__short_take, self.__short_stop

    def __make_signal(
            self,
            signal_type: SignalType,
            take_mult: Decimal,
            stop_mult: Decimal,
            scores: list[float],
    ) -> Signal:
        last = self.__candles[-1]
        entry = quotation_to_decimal(last.close)

        method_scores = {name: scores[i] for i, name in enumerate(ALL_METHOD_NAMES)}
        composite = sum(scores[i] * self.__weights[name].weight for i, name in enumerate(ALL_METHOD_NAMES))
        weight_sum = sum(self.__weights[name].weight for name in ALL_METHOD_NAMES) or 1.0
        self.__confidence = max(0.0, min(1.0, 0.5 + 0.5 * abs(composite / weight_sum)))

        self.__open_trade = OpenTrade(
            signal_type=signal_type,
            entry_price=entry,
            method_scores=method_scores,
            commission_rt=commission_rt(self.__settings.is_future),
        )

        signal = Signal(
            figi=self.__settings.figi,
            signal_type=signal_type,
            take_profit_level=entry * take_mult,
            stop_loss_level=entry * stop_mult,
        )
        logger.info(f"OICompositeStrategy signal: {signal} scores={method_scores}")
        return signal

    def __record_outcome(
            self,
            exit_price: float = 0.0,
            mfe: float = 0.0,
            mae: float = 0.0,
    ) -> None:
        """
        Записать MFE/MAE, обновить веса EWA, сохранить сделку в историю.
        Если exit_price/mfe/mae переданы трейдером — используем их (реальные);
        иначе считаем из after_candles (предположительные, как раньше).
        """
        if not self.__open_trade:
            return

        # Приоритет: реальные значения от трейдера
        if mfe > 0 or mae > 0:
            quality = mfe / (mfe + mae + 1e-8)
            real_exit = exit_price
        else:
            quality = self.__open_trade.calc_quality()
            real_exit = 0.0
            # Восстановить mfe/mae из after_candles для записи в историю
            ep = float(self.__open_trade.entry_price)
            mfe = mae = 0.0
            for c in self.__open_trade.after_candles:
                h = float(quotation_to_decimal(c.high))
                lo = float(quotation_to_decimal(c.low))
                if self.__open_trade.signal_type == SignalType.LONG:
                    mfe = max(mfe, (h - ep) / ep)
                    mae = max(mae, (ep - lo) / ep)
                else:
                    mfe = max(mfe, (ep - lo) / ep)
                    mae = max(mae, (h - ep) / ep)

        logger.info(
            f"{self.__settings.figi} trade closed: quality={quality:.3f} "
            f"mfe={mfe:.4f} mae={mae:.4f} "
            f"bars={len(self.__open_trade.after_candles)}"
        )

        self.__rolling_quality = (1 - QUALITY_ALPHA) * self.__rolling_quality + QUALITY_ALPHA * quality

        for name in ALL_METHOD_NAMES:
            score = self.__open_trade.method_scores.get(name, 0.0)
            if abs(score) < 0.05:
                continue
            aligned = (score > 0 and self.__open_trade.signal_type == SignalType.LONG) or \
                      (score < 0 and self.__open_trade.signal_type == SignalType.SHORT)
            target = quality if aligned else 1.0 - quality
            self.__weights[name].update(target)

        # Сохранить сделку в историю с attribution по методам
        if self.__history is not None:
            ep = float(self.__open_trade.entry_price)
            direction = "LONG" if self.__open_trade.signal_type == SignalType.LONG else "SHORT"
            exit_price = real_exit if real_exit > 0 else ep
            method_scores = dict(self.__open_trade.method_scores)
            tf_regimes = dict(self.__tf_regimes) if self.__tf_regimes else None
            self.__history.record_trade(
                self.__settings.ticker,
                direction=direction,
                entry_price=ep,
                exit_price=exit_price,
                mfe=mfe,
                mae=mae,
                method_scores=method_scores,
                regime=self.__last_regime,
                tf_regimes=tf_regimes,
            )
            # Дублируем в общую базу (cf-collector) — другие инстансы видят
            # attribution не только по своим сделкам, но и по чужим.
            if self.__db is not None and self.__db.configured:
                self.__db.push_trade(
                    self.__settings.ticker,
                    date=datetime.datetime.now(datetime.timezone.utc).date().isoformat(),
                    dir=direction,
                    entry=ep,
                    exit=exit_price,
                    mfe=mfe,
                    mae=mae,
                    quality=quality,
                    method_scores=method_scores,
                    regime=self.__last_regime,
                    tf_regimes=tf_regimes,
                )
            # Обновляем динамические режимные моды после каждой сделки
            self._reload_dynamic_regime_mods()

        self.__open_trade = None
        self.__save_weights()
        self.__save_rolling_quality()

    # ── Персистентность весов ─────────────────────────────────────────────────

    def __weights_key(self) -> str:
        return self.__settings.figi

    def __load_weights(self) -> dict[str, MethodWeight]:
        w: dict[str, MethodWeight] = {name: MethodWeight() for name in ALL_METHOD_NAMES}
        if not os.path.exists(WEIGHTS_FILE):
            return w
        try:
            with open(WEIGHTS_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
            key = self.__settings.figi
            if key in data:
                for name in w:
                    if name in data[key]:
                        d = data[key][name]
                        w[name] = MethodWeight(
                            weight=d.get("weight", 0.5),
                            total=d.get("total", 0),
                            sum_quality=d.get("sum_quality", 0.0),
                        )
            logger.info(f"Loaded weights for {key}: {[f'{n}={w[n].weight:.3f}' for n in w]}")
        except Exception as e:
            logger.warning(f"Could not load weights: {e}")
        return w

    def __save_weights(self) -> None:
        try:
            data = {}
            if os.path.exists(WEIGHTS_FILE):
                with open(WEIGHTS_FILE, "r", encoding="utf-8") as f:
                    data = json.load(f)
            key = self.__settings.figi
            data.setdefault(key, {}).update({
                name: {"weight": w.weight, "total": w.total, "sum_quality": w.sum_quality}
                for name, w in self.__weights.items()
            })
            with open(WEIGHTS_FILE, "w", encoding="utf-8") as f:
                json.dump(data, f, ensure_ascii=False, indent=2)
        except Exception as e:
            logger.warning(f"Could not save weights: {e}")

    def __load_rolling_quality(self) -> float:
        if not os.path.exists(WEIGHTS_FILE):
            return 0.5
        try:
            with open(WEIGHTS_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
            return float(data.get(self.__settings.figi, {}).get("__rolling_quality__", 0.5))
        except Exception as e:
            logger.warning(f"Could not load rolling_quality: {e}")
            return 0.5

    def __save_rolling_quality(self) -> None:
        try:
            data = {}
            if os.path.exists(WEIGHTS_FILE):
                with open(WEIGHTS_FILE, "r", encoding="utf-8") as f:
                    data = json.load(f)
            key = self.__settings.figi
            data.setdefault(key, {})["__rolling_quality__"] = self.__rolling_quality
            with open(WEIGHTS_FILE, "w", encoding="utf-8") as f:
                json.dump(data, f, ensure_ascii=False, indent=2)
        except Exception as e:
            logger.warning(f"Could not save rolling_quality: {e}")
