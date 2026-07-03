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
  1. СОГЛАСИЕ МЕТОДОВ — взвешенная (EWA-весом метода) сила согласных
     методов (|score| >= AGREE_SCORE_MIN) должна быть достаточной и
     абсолютно (AGREE_STRENGTH_MIN), и относительно силы несогласных
     (AGREE_SHARE_MIN). Раньше считался только сырой счёт методов — три
     слабых согласных метода проходили гейт, даже если один сильный
     (высоковесный) метод был против.
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
from collections import deque
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
from regime import REGIMES, classify_regime, classify_regime_probs, REGIME_WEIGHT_MODS, change_point_score, classify_phase, PHASE_WEIGHT_MODS, squeeze_adjust
from cluster_models import ClusterModels
from narrative import (
    NarrativeState, NarrativeWeights, NarrativeThresholds, classify_directional,
    classify_volume, classify_price_reaction, update_narrative,
    fit_narrative_thresholds,
)
from indicators import score_adaptive_ma, score_trend_quality, zlema, t3, mmi
from indicators_fractal import score_fractal, score_entropy_regime, chop_energy_mult
from indicators_ehlers import (
    score_cyber_cycle, score_decycler, score_fisher_rsi, score_ebsw, even_better_sinewave,
    score_mama_fama, score_ehlers_mode, score_cyber_phase, fisher_rsi,
)
from indicators_volume import (
    score_klinger, score_vzo, score_twiggs, score_rmi, score_zscore,  # совместимость
    score_obv_div, score_chaikin_ad, score_mfi_div,
    score_vol_asymmetry, volume_profile, score_vol_profile,
    twiggs_money_flow, klinger_oscillator,
)
from trade_system.strategies.level_pattern import (
    detect_level_pattern, build_levels, MultiTFLevelCache,
    level_volume_gate, LevelGateResult,
)

# Ревизия логики стратегии — пишется в каждую сделку (history.py record_trade),
# чтобы калибровка (lasso_calibration.py, rule_miner.py) могла отличить сделки,
# насчитанные текущей механикой, от устаревших (до фикса ATR-барьеров SBER/
# LKOH/YDEX, до появления LEVEL_CONTEXT и т.п.) и не смешивать их без разбора.
# Поднимать при значимых изменениях входа/выхода/набора методов.
STRATEGY_VERSION = "2026-06-23-mtf-level-cache"

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
WEIGHTS_FILE = "oi_weights.json"       # файл весов (рядом с main.py)
GLOBAL_IC_FILE = "data/global_ic_prior.json"  # агрегированный sign-IC по всем тикерам

# Гейт "уровень + объём": если LEVEL_VOLUME_GATE=1, вход только у tier 1-2
# дневных/недельных уровней с исторической силой реакций и объёмным подтверждением.
LEVEL_VOLUME_GATE_ENABLED: bool = os.getenv("LEVEL_VOLUME_GATE", "0") == "1"
CANDLE_WINDOW = 30                 # свечей в окне для расчётов
MIN_CANDLES = 10                   # минимум свечей для первого сигнала
SIGNAL_THRESHOLD = 0.12            # порог composite для сигнала
HEDGE_ETA = 0.6                    # темп Hedge-обучения весов методов (multiplicative weights)
HEDGE_WARMUP_TRADES = 6            # на первых N сделках eta линейно растёт от 0 до HEDGE_ETA
# Байесовский shrinkage: per-regime вес → global.
# alpha = n / (n + SHRINK_N): при n=0 полностью global, при n=SHRINK_N — 50/50.
# Вместо бинарного порога (было: HEDGE_REGIME_MIN_OBS = 15) — плавный переход.
HEDGE_REGIME_SHRINK_N = 20
# Lasso prior shrinkage: global Hedge-вес → lasso-prior (при малом числе сделок
# сначала доверяем data-driven prior, затем Hedge берёт управление).
LASSO_SHRINK_N = 30

# IC-калибровка: предсказательная сила методов по ценовой динамике
IC_RECALC_INTERVAL = 100   # каждые N баров пересчитываем IC
IC_WINDOW         = 500    # количество баров для rolling IC
IC_FORWARD_LAG    = 20     # горизонт форвардного возврата (баров)
IC_SIGNIFICANCE   = 0.03   # порог значимости IC (ниже → метод нейтральный)
# Trade-level IC: корреляция aligned_score на входе → quality (MFE/MAE).
# Более честная метрика чем price IC: именно это нам важно, а не форвардный возврат.
IC_QUALITY_WINDOW     = 200   # сколько последних сделок хранить
IC_QUALITY_MIN_TRADES = 20    # меньше — только price-IC (недостаточно данных)
IC_QUALITY_BLEND      = 0.55  # доля quality-IC при смешивании с price-IC

# P1: per-method естественный горизонт прогноза (минуты). Трендовые методы
# предсказывают на ~2ч вперёд, осцилляторы — на ~30мин, объём — на ~1ч,
# микроструктура — на ~15мин. Лаг в барах = TARGET // interval_min.
_METHOD_IC_TARGET_MINUTES: dict[str, int] = {
    "PRICE_TREND": 120, "TREND_QUALITY": 120, "ZLEMA_SIGNAL": 120, "T3_SIGNAL": 120,
    "ADAPTIVE_MA": 120, "DECYCLER": 120, "SINEWAVE_SIGNAL": 120, "SSA_SIGNAL": 120,
    "NADARAYA_WATSON": 120, "FRACTIONAL_DIFF": 120,
    "MKT_STRUCTURE": 120, "TRIANGLE": 120,
    "CYBER_CYCLE": 30, "FISHER_RSI": 30, "EBSW": 30, "RMI": 30, "ZSCORE": 30,
    "MMI_SIGNAL": 30, "VR_SIGNAL": 30, "FRACTAL": 30, "ENTROPY": 30,
    "VOL_MOMENTUM": 60, "KLINGER": 60, "VZO": 60, "TWIGGS": 60, "BS_PRESSURE": 60, "DONCHIAN": 60,
    "YZ_VOL_SIGNAL": 60, "VSA": 60, "VWAP_SIGNAL": 60, "VOLATILITY_REGIME": 60,
    "HAWKES_SIGNAL": 15, "BS_PRESSURE_TS": 15, "AGGRESSOR_FLOW": 15, "LARGE_IMPACT": 15,
    "VWAP_SIGNAL_TS": 15, "VOL_MOMENTUM_TS": 15, "OB_IMBALANCE": 15, "CANCEL_SIGNAL": 15,
    "OI_SQUEEZE": 15, "INST_OI": 15, "RETAIL_CONTRA": 15, "WICK_REJECTION": 15,
    "SPRING": 15, "LEVEL_CONTEXT": 15, "CANDLE_PATTERN": 15, "CHANGE_POINT": 15,
    "MULTI_TICKER": 60, "WAVELET_SIGNAL": 60,
}
_IC_DEFAULT_TARGET_MINUTES = 60   # для методов вне таблицы (M1/M2/M3 и пр.)

# ── Lag-коррекция по результатам lag_analysis.py ─────────────────────────────
# Таблица составлена по 60-дневному прогону (медиана лага по 35 тикерам).
# Корректируем только методы с лагом < 10 баров И стабильным лагом в режиме
# (σ_lag < 2 баров — не измерена здесь, взяты топ по |corr| как прокси
# стабильности). Методы с нестабильным/длинным лагом корректировать не стоит:
# взятие производной добавляет шум, а не убирает запаздывание.
_LAG_TABLE: dict[str, dict[str, int]] = {
    "high_vol": {
        "T3_SIGNAL": 4, "TREND_QUALITY": 5, "ZLEMA_SIGNAL": 6,
        "VWAP_SIGNAL": 7, "VR_SIGNAL": 7, "FISHER_RSI": 7, "YZ_VOL_SIGNAL": 6,
    },
    "trending_up": {
        "ZLEMA_SIGNAL": 5, "BS_PRESSURE": 7,
    },
    "trending_down": {
        "ZSCORE": 6, "KLINGER": 6, "FISHER_RSI": 7,
    },
    "ranging": {
        "SINEWAVE_SIGNAL": 4, "MMI_SIGNAL": 5, "VWAP_SIGNAL": 7,
        "ZLEMA_SIGNAL": 7, "TREND_QUALITY": 7, "FISHER_RSI": 7,
    },
    "stress": {
        "EBSW": 6, "VOL_MOMENTUM": 6, "YZ_VOL_SIGNAL": 7,
    },
    "low_vol": {
        "RMI": 7, "T3_SIGNAL": 7, "FISHER_RSI": 6,
    },
}
_LAG_HISTORY_LEN = 14  # max lag в таблице + 2 буфера
MFE_MAE_BARS = 15                  # максимум баров для записи MFE/MAE

# P3: отключение убыточных плейбуков по фактической статистике.
PLAYBOOK_DISABLE_MIN_N = 8
PLAYBOOK_DISABLE_MIN_AVG_R = -0.3
# P9: трейлинг-стоп из распределения MFE.
TRAIL_MIN_DIST_FRACTION = 0.5

# ── Фильтры качества сигнала ────────────────────────────────────────────────
AGREE_SCORE_MIN = 0.15             # |score| >= это значит "метод высказался"
AGREE_STRENGTH_MIN = 0.12          # минимальная взвешенная сила согласных методов
AGREE_SHARE_MIN = 0.35             # доля силы согласных от силы всех высказавшихся
# Сниженный порог согласия для сделок ПО тренду (trending_down SHORT, trending_up LONG).
# Трендовый контекст сам по себе — фильтр; не нужно дополнительно требовать 35% согласия.
AGREE_SHARE_TREND_FOLLOW = 0.28

# Методы-контрсигналы: когда «согласны» с направлением, WR падает ниже базы.
# KLINGER WR=36%, DONCHIAN=35%, PRICE_ACCEL=40% при согласии vs 47-57% при несогласии.
# Инвертируются в __init__ через _inverted_methods — их голос идёт против направления.
_EMPIRICAL_INVERTED_METHODS: frozenset[str] = frozenset({"KLINGER", "DONCHIAN", "PRICE_ACCEL"})

# Четыре дополнительных условия гейта:
# 1. IC-взвешенный net_agreement (абсолютный, не доля)
GATE_NET_AGREEMENT_THRESHOLD = 0.05  # net = sum(ic_weight * score * sign); > 0.05 → pass
# 2. Групповое согласие: минимум групп из 5 (тренд/объём/осцилляторы/структура/микроструктура)
GATE_MIN_GROUPS_AGREE = 3
# 3. Нестабильность composite: std за последние 5 баров
GATE_COMPOSITE_STD_MAX = 0.35
GATE_COMPOSITE_HISTORY_LEN = 5
# P2: знаковая стабильность вместо сырого std (замена условия 3).
GATE_STABILITY_MIN = 0.55
GATE_STABILITY_DECAY = 0.3
# 4. Конфликт L2/L3: блокировать если L2 уверен в обратном
GATE_L2_CONFLICT_THRESHOLD = 0.30

# BOCD–FSM синхронизация: ниже этого порога FSM откатывается из CONFIRMED
# в WATCHING — вход невозможен пока BOCD не подтвердит стабильность режима.
BOCD_NARRATIVE_SYNC_THR = 0.60

# Группы методов для условия 2 (независимость голосов)
_GATE_GROUPS: dict[str, frozenset] = {
    "trend": frozenset({"PRICE_TREND", "TREND_QUALITY", "ZLEMA_SIGNAL", "T3_SIGNAL",
                        "ADAPTIVE_MA", "SINEWAVE_SIGNAL", "SSA_SIGNAL",
                        "NADARAYA_WATSON", "FRACTIONAL_DIFF"}),
    "volume": frozenset({"VOL_MOMENTUM", "KLINGER", "VZO", "TWIGGS", "BS_PRESSURE"}),
    "oscillator": frozenset({"FISHER_RSI", "RMI", "ZSCORE"}),
    "structure": frozenset({"VWAP_SIGNAL", "CHANGE_POINT", "WICK_REJECTION", "VSA",
                             "DONCHIAN", "MA_ENVELOPE",
                             "CANDLE_PATTERN", "TRIANGLE", "FRACTAL", "ENTROPY",
                             "LEVEL_CONTEXT", "MKT_STRUCTURE", "SPRING"}),
    "microstructure": frozenset({"HAWKES_SIGNAL", "BS_PRESSURE_TS", "AGGRESSOR_FLOW",
                                  "LARGE_IMPACT", "VWAP_SIGNAL_TS", "VOL_MOMENTUM_TS",
                                  "OB_IMBALANCE", "CANCEL_SIGNAL",
                                  "OI_SQUEEZE", "INST_OI", "RETAIL_CONTRA"}),
}

# Микроструктурные методы (TRADESTATS + HAWKES_SIGNAL) смотрят на действие
# участников рынка (поток ордеров/агрессии) ДО того как оно проявится в цене —
# структурно ведущие, в отличие от технических индикаторов цены (PRICE_TREND,
# VOL_MOMENTUM, ZSCORE и т.п.), которые по построению смотрят на уже
# прошедшее движение через скользящее окно. Это грубая, категориальная
# классификация (TRADESTATS-методы микроструктурны по определению, не по
# измерению) — точная калибровка по фактическому лагу каждого метода ждёт
# данных lag_analysis.py. До тех пор явный бустинг компенсирует то, что
# чисто EWA-вес (effWR) недооценивает шумный-но-ведущий сигнал по сравнению
# с техническим, который "дозревает" синхронно с уже состоявшимся движением.
MICROSTRUCTURE_WEIGHT_BOOST = 1.25  # множитель веса в композите
MICROSTRUCTURE_AGREE_BOOST = 1.3    # множитель силы в гейте __methods_agree

# На 1-минутных свечах RSI/z-score-осцилляторы перевозбуждаются за 2-3 бара
# и сигнализируют разворот в начале тренда. Трендовые методы — наоборот, точнее.

# Режим-специфичные знаки скора отключены: анализ AFKS давал инверсию ZSCORE
# в trending_up/low_vol, но AFLT показал противоположное — константа глобальная
# и ломает тикеры где ZSCORE прямой. Оставлено для возможного per-ticker подхода.
_REGIME_METHOD_SIGN: dict[str, dict[str, int]] = {}

# ── Альт-трансформации скоров (по данным IndLab) ─────────────────────────────
# Для каждой категории — своя логика переинтерпретации классического скора.
# Применяется к scores_for_composite перед взвешиванием.
# Категории и методы выбраны там, где alt лучше классики ≥80% тикеров.
_ALT_OSC: frozenset = frozenset({
    # Осцилляторы: дивергенция цены и скора → антисигнал (lookback=10)
    "FISHER_RSI", "RMI", "VZO", "ZSCORE", "T3_SIGNAL", "ZLEMA_SIGNAL",
})
_ALT_TREND: frozenset = frozenset({
    # Тренд: климакс-истощение (4 бара на экстремуме → разворот)
    "PRICE_TREND", "TREND_QUALITY", "ADAPTIVE_MA", "MA_TENSION", "PRICE_ACCEL",
})
_ALT_VOLUME: frozenset = frozenset({
    # Объём/деньги: сигнал без подтверждения объёмом → антисигнал
    "CUMUL_DELTA", "TWIGGS", "KLINGER", "AGGRESSOR_FLOW",
    "VOL_MOMENTUM", "VOL_MOMENTUM_TS",
})
_ALT_STRUCTURE: frozenset = frozenset({
    # Структура/цикл: инверсия при боковике (Chop ≥ 61.8)
    "CYBER_PHASE", "ICHIMOKU_SIGNAL", "ALLIGATOR", "FRACTAL",
    "MAMA_FAMA", "SINEWAVE_SIGNAL",
})
_ALT_DSP: frozenset = frozenset({
    # DSP/сглаживание: первый разворот знака → антисигнал (ложный флип)
    "NADARAYA_WATSON", "FRACTIONAL_DIFF", "CHANGE_POINT", "ENTROPY",
    "HAWKES_SIGNAL",
})
# Методы без альт-трансформации (классика лучше): каналы, SSA, MFI-подобные
_ALT_NONE: frozenset = frozenset({
    "BB_KELTNER_SQUEEZE", "DONCHIAN", "MA_ENVELOPE", "SSA_SIGNAL",
    "OI_SQUEEZE", "INST_OI",
})

_ALT_LOOKBACK = 10   # окно дивергенции для осцилляторов и объёма
_ALT_STREAK   = 4    # баров подряд на экстремуме для тренда
_ALT_CHOP_THR = 61.8 # порог Choppiness Index для структурного инвертирования


def _choppiness_index(candles: list, period: int = 14) -> float:
    """Choppiness Index — мера хаотичности рынка. >61.8 = боковик/шум."""
    if len(candles) < period + 1:
        return 50.0
    window = candles[-period - 1:]
    highs  = [float(c.high.units) + float(c.high.nano) / 1e9 if hasattr(c.high, 'units') else float(c.high) for c in window]
    lows   = [float(c.low.units)  + float(c.low.nano)  / 1e9 if hasattr(c.low, 'units')  else float(c.low)  for c in window]
    closes = [float(c.close.units)+ float(c.close.nano)/ 1e9 if hasattr(c.close,'units')  else float(c.close) for c in window]
    try:
        true_ranges = []
        for i in range(1, len(window)):
            tr = max(highs[i] - lows[i], abs(highs[i] - closes[i-1]), abs(lows[i] - closes[i-1]))
            true_ranges.append(tr)
        atr_sum = sum(true_ranges)
        high_max = max(highs[1:])
        low_min  = min(lows[1:])
        rng = high_max - low_min
        if rng < 1e-9 or atr_sum < 1e-9:
            return 50.0
        import math
        ci = 100.0 * math.log10(atr_sum / rng) / math.log10(period)
        return max(0.0, min(100.0, ci))
    except Exception:
        return 50.0


def _apply_alt_transforms(
    names: list,
    scores_fc: list,
    score_history: dict,   # name → list[float] (raw, уже обновлены)
    closes: list,
    candles: list,
) -> list:
    """
    Применяет alt-трансформации к scores_for_composite.
    Возвращает новый список той же длины.
    """
    chop = _choppiness_index(candles)
    result = list(scores_fc)

    for i, name in enumerate(names):
        if name in _ALT_NONE:
            continue
        s = scores_fc[i]
        hist = score_history.get(name, [])

        if name in _ALT_OSC:
            # Дивергенция: цена обновила экстремум, а скор — нет → антисигнал
            lb = _ALT_LOOKBACK
            if len(hist) >= lb and len(closes) >= lb:
                ph = closes[-lb:]
                sh = [h for h in hist[-lb:] if h is not None]
                if sh and ph:
                    p_max, p_min = max(ph), min(ph)
                    s_max, s_min = max(sh), min(sh)
                    if closes[-1] >= p_max and s < s_max:
                        result[i] = -abs(s) if s != 0 else -0.3   # медвежья дивергенция
                    elif closes[-1] <= p_min and s > s_min:
                        result[i] =  abs(s) if s != 0 else  0.3   # бычья дивергенция

        elif name in _ALT_TREND:
            # Климакс-истощение: 4+ баров подряд на максимуме |score| → разворот
            if len(hist) >= _ALT_STREAK:
                nz = [v for v in hist if v is not None]
                if nz:
                    max_abs = max(abs(v) for v in nz)
                    if max_abs > 0:
                        win = hist[-_ALT_STREAK:]
                        if all(v is not None and v >= max_abs for v in win):
                            result[i] = -max_abs
                        elif all(v is not None and v <= -max_abs for v in win):
                            result[i] =  max_abs

        elif name in _ALT_VOLUME:
            # Нет подтверждения объёмом → антисигнал
            if s != 0 and candles and len(candles) >= _ALT_LOOKBACK + 1:
                vols = [float(c.volume) if hasattr(c, 'volume') else 0.0 for c in candles]
                vol_avg = sum(vols[-_ALT_LOOKBACK-1:-1]) / _ALT_LOOKBACK if _ALT_LOOKBACK > 0 else 0.0
                if vol_avg > 0 and vols[-1] < vol_avg * 0.7:
                    result[i] = -s   # сигнал без объёмного подтверждения

        elif name in _ALT_STRUCTURE:
            # Боковик (Chop ≥ 61.8) → инвертируем структурный сигнал
            if chop >= _ALT_CHOP_THR and s != 0:
                result[i] = -s

        elif name in _ALT_DSP:
            # Первый разворот знака DSP-фильтра → антисигнал (ложный флип)
            if len(hist) >= 2:
                nz_hist = [v for v in hist[:-1] if v is not None and v != 0]
                if nz_hist:
                    last_sign = 1 if nz_hist[-1] > 0 else -1
                    cur_sign  = 1 if s > 0 else (-1 if s < 0 else 0)
                    if cur_sign != 0 and cur_sign != last_sign:
                        result[i] = -cur_sign * abs(s)   # первый флип = ложный

    return result


_1MIN_WEIGHT_MODS: dict[str, float] = {
    "FISHER_RSI":       0.2,   # RSI-осциллятор
    "RMI":              0.2,   # RSI-вариант
    "ZSCORE":           0.25,  # mean-reversion против тренда
    "SINEWAVE_SIGNAL":  0.3,   # цикловой детектор
    "CYBER_CYCLE":      0.4,   # Ehlers short-cycle
    "EBSW":             0.5,   # bandstop, частично полезен
    "PRICE_TREND":      1.4,
    "VOL_MOMENTUM":     1.3,
    "ADAPTIVE_MA":      1.3,
    "ZLEMA_SIGNAL":     1.3,
    "T3_SIGNAL":        1.3,
    "TREND_QUALITY":    1.2,
    "KLINGER":          1.2,
    "VZO":              1.1,
    "VWAP_SIGNAL":      1.2,
}

# MTF: при торговле на 1м-свечах агрегируем виртуальные 5м-свечи и используем
# направление ZLEMA на них как фильтр тренда старшего ТФ.
# Сигналы ПРОТИВ 5м-тренда получают штраф MTF_COUNTER_MULT (подавление).
# Сигналы ПО 5м-тренду — небольшой буст MTF_TREND_MULT.
_MTF_FACTOR = 5           # сколько 1м-свечей = 1 свеча старшего ТФ
_MTF_COUNTER_MULT = 0.25  # composite × 0.25 если против тренда старшего ТФ
_MTF_TREND_MULT   = 1.15  # composite × 1.15 если по тренду старшего ТФ
_MTF_MIN_BARS = 15        # минимум виртуальных свечей для расчёта тренда

# ── L1: Структурный контекст (дневной уровень) ────────────────────────────────
# Иерархия сигналов: L1 (структура, дни/недели) → L2 (режим, часы) → L3 (вход, минуты).
# L1 — ворота: лонг в верхней трети N-дневного диапазона в боковике блокируется,
# тренд смягчает штраф. Данных нет (<L1_MA_DAYS торговых дней) → нейтраль 1.0.
_L1_COUNTER_MULT  = 0.10   # composite × 0.10 при жёстком структурном противоречии
_L1_SOFT_MULT     = 0.35   # composite × 0.35 при мягком структурном противоречии
_L1_TREND_MULT    = 1.15   # composite × 1.15 если структура подтверждает направление
_L1_HARD_ZONE     = 0.15   # верхние/нижние 15% N-дневного диапазона — жёсткий блок
_L1_SOFT_ZONE     = 0.30   # верхние/нижние 30% — мягкий штраф
_L1_RANGE_DAYS    = 30     # период дней для расчёта ценового диапазона (percentile)
_L1_MA_DAYS       = 50     # период дней для расчёта MA и проверки наличия истории
_L1_LEVEL_DAYS    = 130    # период дней для MTF-кеша уровней (полгода = 126 торг. дней + запас)

# ── Вето отказа от уровня (LEVEL_CONTEXT) ─────────────────────────────────────
# L1-гейт смотрит на структуру 30д/MA50 и пропускает шорт/лонг у края диапазона,
# если есть тренд (MA5 vs MA20) — то есть трактует резкое движение к локальному
# лою/хаю как пробой, а не как "тот самый уровень, от которого уже был полный
# разворот". Сам LEVEL_CONTEXT это видит (отказ с длинной тенью у уровня), но
# в композите это всего один голос среди ~30 методов — вес размывается, и
# сильный сигнал отказа практически не влияет на итог. Здесь даём ему вето:
# если LEVEL_CONTEXT даёт сильный сигнал ПРОТИВ направления композита, давим
# композит независимо от того, что говорят остальные методы и L1.
_LEVEL_VETO_THRESH = 0.65  # |score_level_context| выше — считается "сильным" отказом
                            # (было 0.45, но MTF-версия может давать до ±1.0, порог поднят)
_LEVEL_VETO_MULT   = 0.15  # composite × это при вето

# Вето сильного структурного сигнала (CASCADE/VSA_ABSORPTION/IMPULSE_PULLBACK):
# если один из этих методов даёт |score| >= порога И направлен против composite,
# composite давится сильнее, чем через линейное взвешивание.
_STRONG_SIGNAL_VETO_METHODS = {"CASCADE", "VSA_ABSORPTION", "IMPULSE_PULLBACK", "WANING_IMPULSES", "FALSE_BREAKOUT"}
_STRONG_SIGNAL_VETO_THRESH  = 0.60  # |score| >= этого → считается "сильным" противосигналом
_STRONG_SIGNAL_VETO_MULT    = 0.12  # composite × это (жёстче LEVEL_VETO, т.к. методы прицельные)

# Narrative-гейт в бэктесте: сколько баров нужно FSM для разогрева
# (NEUTRAL → WATCHING → CONFIRMED требует ≥2 переходов). Пока баров < порога
# гейт молчит, после — работает точно так же как в живой торговле.
_NARRATIVE_WARMUP_BARS = 5


def _aggregate_candles(candles: list, factor: int) -> list:
    """Агрегирует список 1м-свечей в виртуальные свечи старшего ТФ.
    O=open[0], H=max(high), L=min(low), C=close[-1], V=sum(volume) по каждому блоку."""
    from tinkoff.invest import HistoricCandle
    from decimal import Decimal

    result = []
    for start in range(0, len(candles) - factor + 1, factor):
        block = candles[start:start + factor]
        opens  = [_to_f(c.open)   for c in block]
        highs  = [_to_f(c.high)   for c in block]
        lows   = [_to_f(c.low)    for c in block]
        closes = [_to_f(c.close)  for c in block]
        vols   = [float(c.volume) for c in block]

        # Создаём объект с нужными атрибутами (duck-typing: все score_* читают .close/.high/.low/.volume)
        class _VCandle:
            pass
        vc = _VCandle()
        vc.open   = block[0].open
        vc.high   = block[0].high   # переиспользуем объект для хранения — значение ниже
        vc.low    = block[0].low
        vc.close  = block[-1].close
        vc.volume = int(sum(vols))
        vc.time   = block[-1].time
        # перезаписываем H/L через атрибуты простого объекта
        vc._h = max(highs)
        vc._l = min(lows)

        # score_* функции читают c.high / c.low через _to_f → нужны совместимые типы
        # Простейший workaround: заменим high/low на объект с нужным полем units
        class _MV:
            def __init__(self, val):
                # _to_f ожидает MoneyValue (units+nano) или Quotation — имитируем
                self.units = int(val)
                self.nano  = int(round((val - int(val)) * 1_000_000_000))
        vc.high = _MV(max(highs))
        vc.low  = _MV(min(lows))

        result.append(vc)
    return result


def _mtf_trend_score(candles_1m: list, factor: int = _MTF_FACTOR) -> float:
    """ZLEMA-тренд на виртуальных свечах старшего ТФ. Возвращает +1 (бычий) / -1 (медвежий) / 0 (нейтрально)."""
    agg = _aggregate_candles(candles_1m, factor)
    if len(agg) < _MTF_MIN_BARS:
        return 0.0
    closes = [_to_f(c.close) for c in agg]
    period = min(14, len(closes) - 1)
    line = zlema(closes, period=period)
    if line is None or len(line) < 2:
        return 0.0
    slope = line[-1] - line[-2]
    # Нормируем по последней цене чтобы сравнивать по всем инструментам
    rel = slope / (closes[-1] or 1.0)
    if rel > 0.0001:
        return 1.0
    if rel < -0.0001:
        return -1.0
    return 0.0
def _l1_mult_from_context(
    composite: float,
    pct: float,
    above_ma50: bool,
    trending_up: bool,
    trending_down: bool,
) -> float:
    """
    Применяет структурный множитель L1 к composite.
    Параметры кэшируются стратегией и обновляются раз в N баров.
    Логика: лонг в верхней трети N-дневного диапазона в боковике → блок;
    тренд (MA5>MA20) снимает блок — возможен пробой, не мешаем.
    """
    if abs(composite) < 1e-6:
        return 1.0
    if composite > 0:  # попытка лонга
        if pct > (1.0 - _L1_HARD_ZONE):
            return 1.0 if trending_up else _L1_COUNTER_MULT
        if pct > (1.0 - _L1_SOFT_ZONE):
            if trending_up:
                return 1.0  # трендовый пробой вверх — не блокируем
            return _L1_SOFT_MULT if above_ma50 else _L1_SOFT_MULT * 0.7
        if pct < _L1_SOFT_ZONE and not above_ma50 and not trending_down:
            return _L1_TREND_MULT  # структурно выгодно: у низа диапазона, ниже MA50
        return 1.0
    else:  # попытка шорта
        if pct < _L1_HARD_ZONE:
            return 1.0 if trending_down else _L1_COUNTER_MULT
        if pct < _L1_SOFT_ZONE:
            if trending_down:
                return 1.0  # трендовый пробой вниз — не блокируем
            return _L1_SOFT_MULT if not above_ma50 else _L1_SOFT_MULT * 0.7
        if pct > (1.0 - _L1_SOFT_ZONE) and above_ma50 and not trending_up:
            return _L1_TREND_MULT  # структурно выгодно: у верха диапазона, выше MA50
        return 1.0


def _last_swing_price(candles: list[HistoricCandle], direction: int, lookback: int = 5) -> float:
    """Последний локальный экстремум в окне свечей.
    direction > 0 → ищем swing low (начало восходящего импульса).
    direction < 0 → ищем swing high (начало нисходящего импульса).
    Возвращает цену экстремума или 0.0 если не найден.
    """
    if len(candles) < lookback * 2 + 1:
        return 0.0
    best_i = -1
    best_val = 0.0
    for i in range(lookback, len(candles) - lookback):
        if direction > 0:
            val = _to_f(candles[i].low)
            if all(_to_f(candles[i].low) <= _to_f(candles[j].low)
                   for j in range(i - lookback, i + lookback + 1) if j != i):
                if best_i == -1 or i > best_i:
                    best_i = i
                    best_val = val
        else:
            val = _to_f(candles[i].high)
            if all(_to_f(candles[i].high) >= _to_f(candles[j].high)
                   for j in range(i - lookback, i + lookback + 1) if j != i):
                if best_i == -1 or i > best_i:
                    best_i = i
                    best_val = val
    return best_val


def _atr_exhaustion_mult(composite: float, candles: list[HistoricCandle],
                         atr_pct: float, daily_atr: float) -> float:
    """Демпфирует composite если текущий импульс (от последнего свинга) уже
    прошёл значительную долю дневного ATR.
    Числитель: расстояние от последнего свинга до текущей цены.
    Знаменатель: скользящее среднее дневного диапазона (10 дней).
    0–50% дневного ATR → без ограничений; 50–80% → плавное демпфирование; >80% → 0.15×."""
    if abs(composite) < 1e-6 or not candles:
        return 1.0
    # знаменатель: дневной ATR; fallback на M5 ATR × 5 если дневной ещё не накоплен
    denom = daily_atr if daily_atr > 0 else atr_pct * 5
    if denom <= 0:
        return 1.0
    close_px = _to_f(candles[-1].close)
    direction = 1 if composite > 0 else -1
    swing = _last_swing_price(candles, direction)
    if swing <= 0 or close_px <= 0:
        return 1.0
    impulse_pct = abs(close_px - swing) / swing * 100
    ratio = impulse_pct / denom
    if ratio >= _ATR_EX_HARD:
        return _ATR_EX_HARD_MULT
    if ratio >= _ATR_EX_SOFT:
        t = (ratio - _ATR_EX_SOFT) / (_ATR_EX_HARD - _ATR_EX_SOFT)
        return 1.0 - t * (1.0 - _ATR_EX_HARD_MULT)
    return 1.0


LIQUIDITY_MIN_RATIO = 0.3          # объём последней свечи >= 0.3 * медианы окна
LOW_QUALITY_THRESHOLD = 0.4        # rolling quality ниже этого — "плохая полоса"
LOW_QUALITY_MULT = 1.3             # ужесточение порога в плохой полосе
QUALITY_ALPHA = 0.15               # скорость EWA для rolling quality

# Layer-lag-penalty: после смены режима первые LAG_PENALTY_BARS баров доверять
# режимным мультипликаторам меньше — effWR/REGIME_WEIGHT_MODS откалиброваны на
# уже устоявшемся режиме, а сразу после переключения это ещё переходный шум.
LAG_PENALTY_BARS = 5
LAG_PENALTY_MIN = 0.6              # confidence-множитель сразу после смены режима

# ── ATR-exhaustion: подавление входов когда дневной ATR почти исчерпан ───────
_ATR_EX_SOFT      = 0.50   # 50% ATR от свинга → начало демпфирования
_ATR_EX_HARD      = 0.80   # 80% ATR → жёсткое демпфирование (импульс почти исчерпан)
_ATR_EX_HARD_MULT = 0.15   # множитель при исчерпании

# ── ATR-фильтр шума ──────────────────────────────────────────────────────────
ATR_PERIOD = 14                    # период ATR
MIN_ATR_FACTOR = 1.5               # ATR должен быть >= комиссия × этот фактор

# ── Блокировка режимов рынка в бэктесте ──────────────────────────────────────
# Те же режимы что в trader.py (ENTRY_BLOCKED_REGIMES) — бэктест должен
# пропускать сделки в тех же условиях, в которых бот их пропустит живьём.
# Так оценка backtest_quality становится честной: не нужно ждать прогона
# чтобы увидеть что ranging-сделки убыточны — они не попадут ни в WR ни в
# качество бэктеста, как и не попадут в реальную торговлю.
_ebr_bt = os.getenv("ENTRY_BLOCKED_REGIMES", None)
# trending_up убран синхронно с trader.py (см. комментарий там): блок резал
# и лонги в отскоке от дна, а старая атрибуция не разделяла направления.
BACKTEST_BLOCKED_REGIMES: frozenset[str] = frozenset(
    r.strip() for r in _ebr_bt.split(",") if r.strip()
) if _ebr_bt is not None else frozenset({"stress", "ranging"})

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
    weight: float = 0.30   # консервативный старт: метод зарабатывает доверие, не получает аванс
    total: int = 0
    sum_quality: float = 0.0  # больше не входит в update(); оставлено для статистики и старого JSON-формата

    def update(self, quality: float, abs_score: float = 1.0, neutral: float = 0.5) -> None:
        """Hedge (multiplicative weights): вес умножается на exp(eta·(quality-neutral))
        вместо прежнего EWA-от-средней-за-всю-историю. Старая схема (rolling_acc =
        sum_quality/total, затем EWA к ней) тем медленнее реагировала на свежий
        результат, чем больше сделок уже накопилось — отклик затухал со временем,
        а не оставался постоянным. Hedge всегда одинаково отзывчив на новую
        сделку — это и есть непрерывная адаптация, а не разовая калибровка под
        текущие условия рынка.
        eta линейно растёт от 0 до HEDGE_ETA на первых HEDGE_WARMUP_TRADES сделках,
        чтобы шум одной-двух первых сделок не выталкивал вес метода в край
        диапазона [0.05, 1.0] на пустой выборке.
        abs_score ∈ [0,1] — уверенность метода в своём сигнале: масштабирует eta
        так что слабый (|score|≈0.1) голос почти не меняет вес, а уверенный
        (|score|≈0.9) — обновляет его в полную силу.
        neutral — скользящее среднее quality по всем сделкам; метод награждается
        за то, что его сделки превышают средний уровень, а не за абстрактный 0.5.
        Это устраняет систематическое снижение весов когда среднее quality < 0.5."""
        self.total += 1
        self.sum_quality += quality
        conf = max(0.1, min(1.0, abs_score))
        eta = HEDGE_ETA * min(1.0, self.total / HEDGE_WARMUP_TRADES) * conf
        self.weight *= math.exp(eta * (quality - neutral))
        # Отрицательный вес допустим: метод систематически вредный → инвертируем его голос.
        # Нижний порог -1.0 симметричен верхнему 1.0.
        self.weight = max(-1.0, min(1.0, self.weight))


@dataclass
class ICPrior:
    """IC-prior для метода: предсказательная сила на ценовой динамике."""
    ic_smoothed: float = 0.0   # сглаженный IC (EMA, адаптивная α)
    invert: bool = False        # True если метод работает в инверсии (IC отрицательный)
    n_updates: int = 0          # сколько раз пересчитывался
    # P1: режим шума — все IC ниже порога значимости (метод неинформативен).
    noise_mode: bool = False
    # P4: «эффективное» число обновлений с распадом 0.99 за апдейт — для
    # доверия к IC (conf = n_updates_effective / 50). Свежий поток обновлений
    # повышает уверенность, давняя тишина — снижает.
    n_updates_effective: float = 0.0

    def update(self, ic_raw: float, significance: float = 0.03) -> None:
        """Обновляет сглаженный IC. P4: α адаптивна — при низкой уверенности
        (нестабильный IC) обновляемся быстрее (0.15), при стабильной — медленнее
        (0.05)."""
        self.n_updates += 1
        self.n_updates_effective = self.n_updates_effective * 0.99 + 1.0
        conf = self.confidence()
        alpha = 0.15 if conf < 0.5 else 0.05
        self.ic_smoothed = (1.0 - alpha) * self.ic_smoothed + alpha * ic_raw
        self.invert = self.ic_smoothed < -significance

    def confidence(self) -> float:
        """P4: уверенность в IC ∈ [0, 1] по эффективному числу обновлений."""
        return min(1.0, self.n_updates_effective / 50.0)

    def weight(self) -> float:
        """Переводит IC в вес [0.1, 1.0]."""
        ic_abs = abs(self.ic_smoothed)
        # IC=0 → 0.1 (минимальный вес), IC=0.20+ → 1.0
        return max(0.1, min(1.0, 0.1 + 0.9 * ic_abs / 0.20))


@dataclass
class ThresholdAdapters:
    """P8: компоненты адаптивного порога сигнала.
    vol_history — последние ATR% (волатильность); ticker_composite_history —
    нормированные |composite|; session_stats — r-результаты по часу суток;
    regime_thresholds — калиброванный множитель порога по режиму."""
    vol_history: list = field(default_factory=list)             # последние 100 ATR%
    ticker_composite_history: list = field(default_factory=list)  # последние 200 |composite|
    session_stats: dict = field(default_factory=dict)            # {hour: [r,...]}
    regime_thresholds: dict = field(default_factory=dict)        # {regime: mult}

    def add_vol(self, atr_pct: float) -> None:
        if atr_pct and atr_pct > 0:
            self.vol_history.append(atr_pct)
            if len(self.vol_history) > 100:
                self.vol_history.pop(0)

    def add_composite(self, comp: float) -> None:
        if comp:
            self.ticker_composite_history.append(abs(comp))
            if len(self.ticker_composite_history) > 200:
                self.ticker_composite_history.pop(0)

    def add_session(self, hour: int, r_value: float) -> None:
        lst = self.session_stats.setdefault(int(hour), [])
        lst.append(r_value)
        if len(lst) > 100:
            lst.pop(0)

    def effective_threshold(self, base: float, regime: str, hour: int) -> float:
        """Множит base на vol/ticker/regime/session-множители, клип [0.5,3.0]×base."""
        import statistics as _st
        vol_mult = 1.0
        if len(self.vol_history) >= 20:
            med = _st.median(self.vol_history)
            if med > 0:
                vol_mult = (self.vol_history[-1] / med) ** 0.5
        ticker_mult = 1.0
        if len(self.ticker_composite_history) >= 50:
            srt = sorted(self.ticker_composite_history)
            p70 = srt[min(len(srt) - 1, int(0.70 * len(srt)))]
            if p70 > 0:
                ticker_mult = p70 / 0.20
        regime_mult = self.regime_thresholds.get(regime, 1.0)
        session_mult = 1.0
        hs = self.session_stats.get(int(hour))
        if hs and len(hs) >= 8:
            wr = sum(1 for r in hs if r > 0) / len(hs)
            session_mult = 1.0 + 0.2 * (wr - 0.5) * 2.0
        raw = base * vol_mult * ticker_mult * regime_mult * session_mult
        return max(base * 0.5, min(base * 3.0, raw))


@dataclass
class StatBreakDetector:
    """P10: детектор статистического слома распределения цены/волатильности.
    Сравнивает две половины истории по 4 признакам; при ≥2 флагах наращивает
    uncertainty, иначе экспоненциально гасит."""
    close_history: deque = field(default_factory=lambda: deque(maxlen=100))
    vol_history: deque = field(default_factory=lambda: deque(maxlen=100))
    uncertainty: float = 0.0
    breaks_detected: int = 0

    def update(self, close: float, atr_pct: float) -> None:
        if close and close > 0:
            self.close_history.append(float(close))
        if atr_pct is not None:
            self.vol_history.append(float(atr_pct))

    @staticmethod
    def _std(xs):
        n = len(xs)
        if n < 2:
            return 0.0
        m = sum(xs) / n
        return (sum((x - m) ** 2 for x in xs) / n) ** 0.5

    @staticmethod
    def _mean(xs):
        return sum(xs) / len(xs) if xs else 0.0

    @staticmethod
    def _autocorr1(xs):
        n = len(xs)
        if n < 3:
            return 0.0
        m = sum(xs) / n
        num = sum((xs[i] - m) * (xs[i - 1] - m) for i in range(1, n))
        den = sum((x - m) ** 2 for x in xs)
        return num / den if den > 1e-12 else 0.0

    @staticmethod
    def _kurtosis(xs):
        n = len(xs)
        if n < 4:
            return 0.0
        m = sum(xs) / n
        var = sum((x - m) ** 2 for x in xs) / n
        if var <= 1e-12:
            return 0.0
        return sum((x - m) ** 4 for x in xs) / n / (var ** 2)

    def check_break(self) -> float:
        ch = list(self.close_history)
        if len(ch) < 20:
            self.uncertainty *= 0.9
            return self.uncertainty
        half = len(ch) // 2
        older, recent = ch[:half], ch[half:]
        n_flags = 0
        std_o = self._std(older)
        std_r = self._std(recent)
        if std_o > 1e-12:
            ratio = std_r / std_o
            if ratio > 2.0 or ratio < 0.5:
                n_flags += 1
            if abs(self._mean(recent) - self._mean(older)) / std_o > 2.0:
                n_flags += 1
        if abs(self._autocorr1(recent) - self._autocorr1(older)) > 0.3:
            n_flags += 1
        if self._kurtosis(recent) / max(1.0, self._kurtosis(older)) > 2.5:
            n_flags += 1
        if n_flags >= 2:
            self.breaks_detected += 1
            self.uncertainty = min(1.0, self.uncertainty + 0.3 * n_flags / 4.0)
        else:
            self.uncertainty *= 0.9
        return self.uncertainty


@dataclass
class OpenTrade:
    signal_type: SignalType
    entry_price: Decimal
    method_scores: dict
    after_candles: list = field(default_factory=list)
    commission_rt: float = COMMISSION_RT  # ставка по типу инструмента (акция/фьючерс)
    narrative_name: str = "NEUTRAL"  # имя состояния NarrativeState на момент входа
    playbooks: list = field(default_factory=list)  # активные плейбуки на входе (P3)
    regime: str = "ranging"  # режим на момент входа (P3)

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

def _candle_tf_minutes(candles) -> float:
    """Средний интервал между свечами в минутах (по последним 10 парам)."""
    sample = candles[-11:] if len(candles) >= 11 else candles
    deltas = []
    for i in range(1, len(sample)):
        try:
            d = (sample[i].time - sample[i - 1].time).total_seconds() / 60.0
            if 0 < d < 1500:  # отсекаем ночные/выходные разрывы
                deltas.append(d)
        except Exception:
            pass
    return statistics.median(deltas) if deltas else 5.0


def _adaptive_window(candles, target_hours: float, min_bars: int = 10, max_bars: int = 120) -> int:
    """Количество баров, соответствующее target_hours часам на данном таймфрейме."""
    tf = _candle_tf_minutes(candles)
    bars = int(round(target_hours * 60 / tf))
    return max(min_bars, min(max_bars, bars))


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
    # trending_down был 0.85 (опускал порог) → убыток -22% net на 55% сделок.
    # Поднято до 1.50: в нисходящем режиме нужно сильное подтверждение.
    # low_vol: было 0.90 → 1.30. В боковике стопы бьют случайно (1118 стопов, net=-705%).
    mods = {"trending_up": 0.85, "trending_down": 1.50, "ranging": 1.0,
            "high_vol": 1.25, "low_vol": 1.30, "stress": 1.40}
    return base * mods.get(regime, 1.0)


def _compute_atr(candles: list[HistoricCandle], period: int = ATR_PERIOD, tail_q: float = 0.8) -> float:
    """
    Ширина волатильности как доля цены — не среднее True Range (как в
    классическом ATR), а tail_q-квантиль True Range за окно из 3×period
    баров (EVT-lite: "Block Maxima" в миниатюре — берём не среднее, а
    хвостовое значение распределения движений).

    Среднее по 14 барам сильно сглаживает резкие всплески: после спайка
    волатильности оно ещё долго "помнит" спокойный период до него и
    отстаёт от факта. Квантиль по более длинному окну реагирует быстрее
    на смену режима и не недооценивает риск редких крупных движений —
    отсюда и нереалистично узкие/широкие стопы, на которые жаловались
    (ATR_TAKE_K/ATR_STOP_K умножали лагающую и заниженную оценку).
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
    window = trs[-period * 3:]
    last_price = _to_f(candles[-1].close) or 1e-9
    if len(window) < 5:
        return (sum(window) / len(window)) / last_price
    sorted_w = sorted(window)
    idx = min(len(sorted_w) - 1, max(0, round(tail_q * (len(sorted_w) - 1))))
    return sorted_w[idx] / last_price


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
    Асимметрия объёма: объём на барах по тренду vs против тренда.

    Если движение вниз идёт на нарастающем объёме, а откаты вверх — на
    падающем → продавцы агрессивны, следуем вниз. Наоборот → поглощение.

    В связке с OI это даёт почти полную картину: OI говорит кто и сколько,
    объём говорит с какой агрессией прямо сейчас.

    Поверх базового сигнала — мультипликатор Хокса: самовозбуждающийся каскад
    крупных баров (branching_ratio ≥ 1) → ×1.5; затухающий → ×0.5.
    """
    if len(candles) < 6:
        return 0.0
    closes = [_to_f(c.close) for c in candles]
    volumes = [float(c.volume) for c in candles]
    lb = min(20, len(closes))
    base = score_vol_asymmetry(closes, volumes, lookback=lb)

    if not _HAS_HAWKES:
        return base
    try:
        med = statistics.median(volumes) if volumes else 0.0
        event_times = [float(i) for i, v in enumerate(volumes) if v > med * 1.5]
        if len(event_times) < 5:
            return base
        res = hawkes_processes(event_times)
        n = res["branching_ratio"]
        mult = 1.5 if n >= 1.0 else (0.5 if n < 0.5 else 1.0)
        return max(-1.0, min(1.0, base * mult))
    except Exception:
        return base


def score_vwap_signal(candles: list[HistoricCandle]) -> float:
    """
    Сессионный VWAP как маркер «кто в плюсе».

    Логика:
    - VWAP сбрасывается на каждый торговый день (по времени свечей).
      Все кто купили ниже VWAP — в прибыли, выше — в убытке.
    - Пробой VWAP с удержанием → смена баланса (сильный сигнал).
    - Возврат к VWAP в середине движения и отскок → продолжение.
    - Большое отклонение + убывающий объём → истощение расширения.

    Три компонента итогового score:
    1. Позиция цены относительно VWAP (в ATR-единицах) — базовый сигнал.
    2. Пробой/отскок: пересечение VWAP за последние 3 бара.
    3. Истощение: цена далеко от VWAP + объём на убыли.
    """
    if len(candles) < 5:
        return 0.0

    # Определяем начало текущей сессии по дате первой свечи
    try:
        last_date = candles[-1].time.date()
        session = [c for c in candles if c.time.date() == last_date]
    except Exception:
        session = candles

    if not session:
        session = candles

    # Сессионный VWAP
    cum_pv = cum_v = 0.0
    for c in session:
        tp = (_to_f(c.high) + _to_f(c.low) + _to_f(c.close)) / 3
        cum_pv += tp * c.volume
        cum_v += c.volume
    vwap = cum_pv / (cum_v or 1e-9)

    last_price = _to_f(candles[-1].close)
    atr = _compute_atr(candles)
    if atr <= 0 or vwap <= 0:
        return 0.0
    atr_abs = atr * vwap

    # 1. Позиция в ATR-единицах (насыщение при 2 ATR)
    pos_score = math.tanh((last_price - vwap) / (atr_abs * 2.0))

    # 2. Пересечение VWAP за последние 3 бара → подтверждение пробоя
    cross_score = 0.0
    prev_closes = [_to_f(c.close) for c in candles[-4:-1]]
    if prev_closes:
        prev_side = [1 if p > vwap else -1 for p in prev_closes]
        cur_side = 1 if last_price > vwap else -1
        if cur_side != prev_side[-1]:
            # Пересечение — добавляем в сторону пробоя, но только если держится 1+ бар
            cross_score = cur_side * 0.3

    # 3. Истощение: далеко от VWAP + убывающий объём
    exhaust_score = 0.0
    dist_atr = abs(last_price - vwap) / atr_abs
    if dist_atr > 1.5 and len(session) >= 4:
        vols = [c.volume for c in session[-4:]]
        if vols[-1] < vols[-2] < vols[-3]:  # объём падает 3 бара подряд
            exhaust_score = -(1 if last_price > vwap else -1) * 0.4

    raw = pos_score + cross_score + exhaust_score
    return round(max(-1.0, min(1.0, raw)), 4)


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
    """
    Свечной анализ через параметры, а не паттерны по имени.

    Пять независимых измерений текущей свечи:
    1. Закрытие внутри диапазона (важнее цвета)
    2. Перекрытие соседей (сколько баров «проглочено»)
    3. Тень против угла тренда (sweep против движения)
    4. Тело/тень (чистота движения vs борьба)
    5. Аномалия объёма (статистический выброс)

    Каждое измерение даёт вклад ∈ [-1, 1].
    Итог = взвешенная сумма с учётом контекста (тренд, уровень).
    """
    if len(candles) < 20:
        return 0.0

    def _f(c, attr): return _to_f(getattr(c, attr))

    last = candles[-1]
    lh = _f(last, "high");  ll = _f(last, "low")
    lo_ = _f(last, "open"); lc = _f(last, "close")
    lrng  = lh - ll or 1e-9
    lbody = abs(lc - lo_)
    lbody_frac = lbody / lrng

    prev = candles[-2]
    ph = _f(prev, "high"); pl = _f(prev, "low")

    # ── Предшествующий тренд (угол) ──────────────────────────────────────────
    # Взвешенный по позиции: ближние свечи весят больше
    trend_w = candles[-8:-1]
    if len(trend_w) < 2:
        return 0.0
    closes = [_f(c, "close") for c in trend_w]
    # Линейный наклон через least-squares-like (простой)
    n = len(closes)
    mean_c = sum(closes) / n
    mean_i = (n - 1) / 2
    num = sum((i - mean_i) * (closes[i] - mean_c) for i in range(n))
    den = sum((i - mean_i) ** 2 for i in range(n)) or 1.0
    slope_pct = num / den / (mean_c or 1.0)   # нормирован к цене
    prior_bullish = slope_pct > 0.0005
    prior_bearish = slope_pct < -0.0005
    angle_mult = min(2.0, 1.0 + abs(slope_pct) * 500)  # крутой угол = сильнее контраст

    # ── Объём: медиана 50 баров (устойчива к выбросам) ───────────────────────
    vols_w = sorted(float(c.volume) for c in candles[-50:])
    med_vol = vols_w[len(vols_w) // 2] or 1.0
    vol_ratio = float(last.volume) / med_vol

    # Аномалия объёма: Z-score по последним 20 барам
    vols_20 = [float(c.volume) for c in candles[-20:]]
    mu_v = sum(vols_20) / len(vols_20)
    sd_v = (sum((v - mu_v) ** 2 for v in vols_20) / len(vols_20)) ** 0.5
    vol_z = (float(last.volume) - mu_v) / (sd_v if sd_v > 1e-9 else max(mu_v, 1.0))

    # ── 1. Закрытие внутри диапазона (direction pressure) ────────────────────
    # 0 = нижний экстремум, 1 = верхний; не цвет, а позиция закрытия
    close_pos = (lc - ll) / lrng  # 0..1
    if close_pos >= 0.85:
        dp = 1.0        # максимальное давление вверх
    elif close_pos >= 0.65:
        dp = 0.55
    elif close_pos >= 0.35:
        dp = 0.0        # неопределённость
    elif close_pos >= 0.15:
        dp = -0.55
    else:
        dp = -1.0       # максимальное давление вниз

    # ── 2. Перекрытие соседей (каскадное поглощение) ─────────────────────────
    # Считаем сколько предыдущих баров входит в диапазон текущего
    overlap_count = 0
    for i in range(2, min(12, len(candles))):
        ph_i = _f(candles[-i], "high")
        pl_i = _f(candles[-i], "low")
        if lh >= ph_i and ll <= pl_i:
            overlap_count += 1
        else:
            break  # только непрерывная цепочка
    # Перекрытие 1-2 = норма (0), 5-7 = значимое событие, 10+ = институциональный
    if overlap_count >= 10:
        overlap_score = 0.90
    elif overlap_count >= 7:
        overlap_score = 0.70
    elif overlap_count >= 5:
        overlap_score = 0.50
    elif overlap_count >= 3:
        overlap_score = 0.30
    elif overlap_count >= 1:
        overlap_score = 0.10
    else:
        overlap_score = 0.0
    # Знак: если тело вверх → бычий sweep, вниз → медвежий
    overlap_dir = 1.0 if dp >= 0 else -1.0

    # ── 3. Тень против угла тренда (sweep против движения) ───────────────────
    lower_wick_frac = (min(lo_, lc) - ll) / lrng
    upper_wick_frac = (lh - max(lo_, lc)) / lrng

    # Аномалия тени: длиннее среднего за 20 баров?
    avg_lwick = sum(
        (min(_f(c,"open"), _f(c,"close")) - _f(c,"low")) / max(_f(c,"high") - _f(c,"low"), 1e-9)
        for c in candles[-20:-1]
    ) / 19
    avg_uwick = sum(
        (_f(c,"high") - max(_f(c,"open"), _f(c,"close"))) / max(_f(c,"high") - _f(c,"low"), 1e-9)
        for c in candles[-20:-1]
    ) / 19

    shadow_score = 0.0
    # Нижняя тень против бычьего угла = попытка продавцов отбита
    if prior_bullish and lower_wick_frac > max(0.40, avg_lwick * 1.5):
        shadow_score = lower_wick_frac * angle_mult * 0.6
    # Верхняя тень против медвежьего угла = попытка покупателей отбита
    elif prior_bearish and upper_wick_frac > max(0.40, avg_uwick * 1.5):
        shadow_score = -upper_wick_frac * angle_mult * 0.6
    # Нижняя тень вдоль медвежьего движения — продолжение давления
    elif prior_bearish and lower_wick_frac < 0.15 and dp < -0.4:
        shadow_score = -0.25
    # Верхняя тень вдоль бычьего движения — продолжение
    elif prior_bullish and upper_wick_frac < 0.15 and dp > 0.4:
        shadow_score = 0.25

    # ── 4. Тело/тень: чистота победителя ─────────────────────────────────────
    # Тело 80%+ = нет борьбы, чистое движение → сигнал продолжения
    # Тело < 15% после серии = равновесие / истощение → возможный разворот
    last3_vols = [float(c.volume) for c in candles[-4:-1]]
    vol_fading = (last3_vols[-1] < last3_vols[0] * 0.75) if last3_vols[0] > 0 else False
    consec_down = all(_f(c,"close") < _f(c,"open") for c in candles[-4:-1])
    consec_up   = all(_f(c,"close") > _f(c,"open") for c in candles[-4:-1])

    body_score = 0.0
    if lbody_frac >= 0.80:
        # Чистое движение → продолжение в направлении dp
        body_score = 0.40 * (1.0 if dp > 0 else -1.0)
    elif lbody_frac < 0.12:
        # Истощение: значимо только после серии + убывающий объём
        if consec_down and vol_fading:
            body_score = 0.30   # разворот вверх
        elif consec_up and vol_fading:
            body_score = -0.30  # разворот вниз

    # ── 5. Аномалия объёма ────────────────────────────────────────────────────
    # Z-score > 2 = статистически аномальная свеча, там что-то произошло.
    # Усиливает другие сигналы, сам по себе не даёт направления.
    vol_anomaly_mult = 1.0
    if vol_z > 3.0:
        vol_anomaly_mult = 1.50   # institutional move
    elif vol_z > 2.0:
        vol_anomaly_mult = 1.30
    elif vol_z > 1.0:
        vol_anomaly_mult = 1.15
    elif vol_ratio < 0.4:
        vol_anomaly_mult = 0.50   # мёртвый объём — глушим сигнал

    # ── Контекст: близость к уровню (грубо) ──────────────────────────────────
    lvl_w = candles[-21:-1]
    level_mult = 1.0
    if lvl_w:
        sup = min(_f(c, "low")  for c in lvl_w)
        res = max(_f(c, "high") for c in lvl_w)
        rng = res - sup or lrng
        near_sup = (ll - sup) / rng < 0.08
        near_res = (res - lh)  / rng < 0.08
        if (near_sup and dp > 0) or (near_res and dp < 0):
            level_mult = 1.30   # сигнал у уровня в правильном направлении
        elif (near_sup and dp < 0) or (near_res and dp > 0):
            level_mult = 0.70   # контрарный сигнал у уровня — гасим

    # ── Сборка ────────────────────────────────────────────────────────────────
    # dp — основное направление (закрытие в диапазоне)
    # shadow_score — тень против/вдоль угла
    # overlap_score × overlap_dir — каскадное поглощение
    # body_score — чистота движения / истощение
    # Веса подобраны так чтобы сумма не превышала ±1 в типичных случаях

    raw = (
        dp * 0.35
        + shadow_score * 0.30
        + overlap_score * overlap_dir * 0.25
        + body_score * 0.10
    )
    raw *= vol_anomaly_mult * level_mult

    # Inside Bar (компрессия без NR7): сжатие → продолжение тренда
    # Не входит в основную формулу чтобы не бить дважды в ту же сторону
    ranges_7 = [_to_f(c.high) - _to_f(c.low) for c in candles[-7:]] if len(candles) >= 7 else []
    is_nr7 = bool(ranges_7) and lrng == min(ranges_7)
    if lh <= ph and ll >= pl and not is_nr7:
        compression = (lrng / (ph - pl)) if (ph - pl) > 0 else 1.0
        inside_push = (1.0 - compression) * 0.20
        if prior_bullish:
            raw += inside_push
        elif prior_bearish:
            raw -= inside_push

    return max(-1.0, min(1.0, round(raw, 4)))


def score_adaptive_ma_candle(candles: list[HistoricCandle]) -> float:
    """
    ADAPTIVE_MA: Efficiency Ratio (ER) Кауфмана + отклонение от KAMA.

    Документ: ER = реальное движение / сумма всех колебаний.
    - ER 0-0.3: боговик/компрессия (цена металась туда-сюда)
    - ER 0.7-0.95: здоровый каскад (цена идёт направленно)
    - ER падает при росте цены = дивергенция = затухание (распределение)

    1. Базовый сигнал: отклонение цены от KAMA (тренд vs. KAMA-линия)
    2. ER как усилитель/ослабитель: высокий ER → каскад → усиливаем;
       низкий ER → боговик → ослабляем
    3. ER-дивергенция: цена новый экстремум, ER падает → распределение
    """
    closes = [_to_f(c.close) for c in candles]
    n = len(closes)
    if n < 20:
        return score_adaptive_ma(closes)

    # Efficiency Ratio за последние N баров
    er_period = min(20, n - 1)

    def _er(series, period):
        if len(series) < period + 1:
            return 0.5
        direction = abs(series[-1] - series[-period])
        volatility = sum(abs(series[i] - series[i - 1]) for i in range(len(series) - period, len(series)))
        return direction / (volatility or 1e-9)

    er_now = _er(closes, er_period)
    # ER 10 баров назад для дивергенции
    er_past = _er(closes[:-10], er_period) if n > er_period + 10 else er_now

    # 1. Базовый: отклонение от KAMA
    base = score_adaptive_ma(closes)

    # 2. ER-множитель: высокий ER = каскад (усиляем), низкий = боговик (ослабляем)
    # ER 0.7+ → mult ~1.3; ER 0.2- → mult ~0.5
    if er_now > 0.7:
        er_mult = 1.0 + (er_now - 0.7) * 1.0    # до +0.3 при ER=1.0
    elif er_now < 0.3:
        er_mult = 0.4 + er_now * 2.0             # от 0.4 до 1.0
    else:
        er_mult = 1.0

    # 3. ER-дивергенция: цена идёт вверх, ER падает — каскад затухает
    price_chg = closes[-1] - closes[-(min(10, n))]
    er_fell = er_past - er_now > 0.20   # ER упал значимо
    divergence = 0.0
    if er_fell and abs(price_chg) > closes[-1] * 0.003:
        # Цена движется но ER падает → контр-сигнал
        divergence = -math.copysign(min(0.40, (er_past - er_now) * 1.5), price_chg)

    result = base * er_mult + divergence
    return max(-1.0, min(1.0, result))


def score_trend_quality_candle(candles: list[HistoricCandle]) -> float:
    """TREND_QUALITY: TQI (indicators.py, Фаза 3) — уже ∈[-1,1]."""
    return score_trend_quality([_to_f(c.close) for c in candles])


def score_fractal_candle(candles: list[HistoricCandle]) -> float:
    """FRACTAL: убран из голосования — FDI/Hurst не дают направление. Всегда 0.0.
    Функция сохранена для обратной совместимости весов в WEIGHTS_FILE."""
    return 0.0


def _chop_energy_mult_candle(candles: list[HistoricCandle]) -> float:
    """Множитель тейка от накопленной энергии хаоса (Choppiness + ER)."""
    if len(candles) < 30:
        return 1.0
    highs  = [_to_f(c.high)  for c in candles]
    lows   = [_to_f(c.low)   for c in candles]
    closes = [_to_f(c.close) for c in candles]
    return chop_energy_mult(highs, lows, closes)


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
    """
    FISHER_RSI: Fisher-преобразование RSI — состояние перегрева/перепроданности.

    Классические пороги удалены — Fisher нелинеен, в крайностях очень резкий.

    1. Крайность состояния: Fisher > +2 / < -2 = физическое перегревание.
       Когда начинает возвращаться из крайности — сигнал начала выброса/разворота.
    2. "Честность" движения: цена движется но Fisher не в экстремуме и уже откатывает → ловушка.
    3. Дивергенция: цена новый экстремум, Fisher нет → энергия уже развернулась.
    4. Зависание в нейтрали (-0.5..+0.5) при движущейся цене → шум, не тренд.
    5. Скорость выхода из крайности: резкое → режим меняется агрессивно.
    """
    closes = [_to_f(c.close) for c in candles]
    n = len(closes)
    if n < 15:
        return 0.0
    period = min(10, n - 1)
    fr = fisher_rsi(closes, period=period)
    if len(fr) < 5:
        return 0.0

    v = fr[-1]
    prev = fr[-2]

    # 1. Крайность + поворот из неё
    EXTREME = 1.8
    at_top    = v > EXTREME
    at_bottom = v < -EXTREME
    turning_down = at_top    and v < prev   # поворачивает вниз из перегрева
    turning_up   = at_bottom and v > prev   # поворачивает вверх из перепроданности

    if turning_up:
        phase = 0.90
    elif turning_down:
        phase = -0.90
    elif at_top:
        phase = 0.30    # ещё в крайности, пока не повернул — слабый сигнал продолжения
    elif at_bottom:
        phase = -0.30
    else:
        phase = math.tanh(v * 0.5) * 0.4   # в середине — слабый сигнал по направлению

    # 2. Нейтральное зависание при движущейся цене → антисигнал (шум)
    lb = min(10, n - 1)
    price_move = abs(closes[-1] - closes[-lb]) / (closes[-lb] + 1e-9)
    neutral_zone = abs(v) < 0.5
    trap_penalty = 0.0
    if neutral_zone and price_move > 0.005:   # цена движется, Fisher в нейтрали
        trap_penalty = -math.copysign(0.25, closes[-1] - closes[-lb])

    # 3. Дивергенция: цена на новом экстремуме, Fisher нет
    lb2 = min(20, n - 1)
    price_chg = closes[-1] - closes[-lb2]
    fr_chg    = fr[-1] - fr[-lb2]
    divergence = 0.0
    if price_chg < -1e-4 and fr_chg > 0.3:    # цена вниз, Fisher разворачивается вверх
        divergence = min(0.5, fr_chg * 0.3)
    elif price_chg > 1e-4 and fr_chg < -0.3:  # цена вверх, Fisher разворачивается вниз
        divergence = max(-0.5, fr_chg * 0.3)

    # 4. Скорость выхода из крайности (крутой разворот = агрессивная смена режима)
    speed = abs(v - fr[-3]) if len(fr) >= 3 else 0.0
    speed_mult = 1.0 + min(0.20, speed * 0.15)

    # 5. Нитка в крайности: сколько баров подряд Fisher держался у порога
    streak = 0
    for val in reversed(fr[:-1]):
        if abs(val) > EXTREME:
            streak += 1
        else:
            break
    # Первый поворот после длинного зависания = выброс
    if (turning_up or turning_down) and streak >= 2:
        streak_mult = 1.0 + min(0.50, streak * 0.15)
        phase *= streak_mult

    result = phase * speed_mult + trap_penalty + divergence * 0.4
    return max(-1.0, min(1.0, result))


def score_ebsw_candle(candles: list[HistoricCandle]) -> float:
    """EBSW: Even Better Sinewave, RMS-нормированный roofing filter (Фаза 3)."""
    return score_ebsw([_to_f(c.close) for c in candles])


def score_mama_fama_candle(candles: list[HistoricCandle]) -> float:
    """
    MAMA_FAMA: антисигнал схождения линий при продолжающемся движении цены.

    MAMA и FAMA расходились = тренд набирал силу.
    Начали сходиться назад при продолжении движения цены = тренд ломается изнутри.
    Антисигнал продолжения: согласие MAMA/FAMA теряется.
    """
    closes = [_to_f(c.close) for c in candles]
    n = len(closes)
    if n < 20:
        return 0.0

    base = score_mama_fama(closes)

    # Детектируем схождение после расхождения
    from indicators_ehlers import mama_fama as _mama_fama
    mama_s, fama_s, _ = _mama_fama(closes)

    def _last(arr, k=1):
        vals = [v for v in arr if not (isinstance(v, float) and math.isnan(v))]
        return vals[-k] if len(vals) >= k else None

    m1 = _last(mama_s, 1); f1 = _last(fama_s, 1)
    m3 = _last(mama_s, 3); f3 = _last(fama_s, 3)
    m8 = _last(mama_s, 8); f8 = _last(fama_s, 8)
    if None in (m1, f1, m3, f3, m8, f8):
        return base

    price_ref = abs(m1) or 1.0
    gap_now  = abs(m1 - f1) / price_ref
    gap_3    = abs(m3 - f3) / price_ref
    gap_8    = abs(m8 - f8) / price_ref

    # Был большой разрыв (расхождение), сейчас сходится
    was_diverging = gap_8 > gap_now * 1.3
    converging    = gap_now < gap_3 * 0.85

    if was_diverging and converging:
        # Цикл завершается: линии сходятся после расхождения.
        # Точка максимальной неопределённости приближается — вот-вот новый цикл
        # в противоположную сторону, часто резкий потому что цикл накопился.
        old_direction = 1 if (m8 - f8) > 0 else -1
        convergence_speed = min(1.0, (gap_3 - gap_now) / (gap_3 + 1e-9))
        reversal_strength = min(0.75, 0.35 + convergence_speed * 0.50)
        # Сигнал разворота: против направления завершающегося цикла
        return max(-1.0, min(1.0, -old_direction * reversal_strength))

    return base


def score_ehlers_mode_candle(candles: list[HistoricCandle]) -> float:
    """EHLERS_MODE: детектор режима цикл→тренд; молчит в цикле (Эрлерс)."""
    return score_ehlers_mode([_to_f(c.close) for c in candles])


def score_cyber_phase_candle(candles: list[HistoricCandle]) -> float:
    """CYBER_PHASE: позиция + скорость в цикле Эрлерса (≠ пересечение нуля)."""
    return score_cyber_phase([_to_f(c.close) for c in candles])


def _hlcv(candles: list[HistoricCandle]) -> tuple[list[float], list[float], list[float], list[float]]:
    highs = [_to_f(c.high) for c in candles]
    lows = [_to_f(c.low) for c in candles]
    closes = [_to_f(c.close) for c in candles]
    volumes = [float(c.volume) for c in candles]
    return highs, lows, closes, volumes


def score_klinger_candle(candles: list[HistoricCandle]) -> float:
    """
    KLINGER: Klinger Volume Oscillator — денежный поток через истинный диапазон.

    Не OBV (тот просто знак объёма). KVO учитывает направление hlc и диапазон свечи —
    точнее показывает где деньги были агрессивны внутри бара.

    1. Направление + амплитуда потока (tanh-нормировка по rolling RMS)
    2. Дивергенция: цена на новом экстремуме, KVO нет → затухание потока
    3. Накопление в боковике: KVO систематически в одну сторону при плоской цене
    4. Расширение KVO/signal: сжатие = компрессия, расширение = начало выброса
    5. Переключение: KVO пересёк нуль → инициатива переключилась
    """
    h, l, c, v = _hlcv(candles)
    n = len(c)
    if n < 20:
        return 0.0
    fast = min(34, n // 2)
    slow = min(55, n - 1)
    kvo = klinger_oscillator(h, l, c, v, fast=fast, slow=slow)
    if len(kvo) < 5:
        return 0.0
    signal_period = min(13, len(kvo) // 2)
    # signal line — EMA от KVO
    alpha = 2 / (signal_period + 1)
    sig = [kvo[0]]
    for x in kvo[1:]:
        sig.append(alpha * x + (1 - alpha) * sig[-1])

    kvo_now = kvo[-1]
    sig_now = sig[-1]

    # Нормируем KVO по rolling RMS чтобы сравнивать амплитуды разных тикеров
    rms = (sum(x * x for x in kvo[-20:]) / min(20, n)) ** 0.5 or 1.0

    # 1. Направление + амплитуда: tanh нормированного значения
    base = math.tanh(kvo_now / (rms * 1.5))

    # 2. Дивергенция: цена на новом экстремуме, KVO нет
    lb = min(20, n - 1)
    price_chg = c[-1] - c[-lb]
    kvo_chg   = kvo[-1] - kvo[-lb]
    divergence = 0.0
    if price_chg < -1e-4 and kvo_chg > rms * 0.1:    # цена вниз, поток разворачивается → бычья
        divergence = min(0.6, kvo_chg / (rms + 1e-9) * 0.4)
    elif price_chg > 1e-4 and kvo_chg < -rms * 0.1:  # цена вверх, поток слабеет → медвежья
        divergence = max(-0.6, kvo_chg / (rms + 1e-9) * 0.4)

    # 3. Накопление в боковике: KVO систематически в одну сторону при плоской цене
    price_range = max(c[-lb:]) - min(c[-lb:])
    price_mean  = sum(c[-lb:]) / lb
    flat = price_range / (price_mean + 1e-9) < 0.015   # цена двигалась менее 1.5%
    acc_win = min(10, n)
    pos_kvo = sum(1 for x in kvo[-acc_win:] if x > rms * 0.05)
    neg_kvo = sum(1 for x in kvo[-acc_win:] if x < -rms * 0.05)
    accumulation = 0.0
    if flat:
        if pos_kvo >= acc_win * 0.7:
            accumulation = 0.30    # скрытое накопление
        elif neg_kvo >= acc_win * 0.7:
            accumulation = -0.30   # скрытое распределение

    # 4. Расширение KVO/signal: большой спред = сильный направленный поток
    spread = kvo_now - sig_now
    spread_norm = math.tanh(spread / (rms + 1e-9))
    expansion_bonus = spread_norm * 0.25

    # 5. Переключение: недавнее пересечение нуля = смена инициативы
    switch = 0.0
    if len(kvo) >= 3:
        if kvo[-2] < 0 and kvo_now > 0:
            switch = 0.20    # переключился в покупку
        elif kvo[-2] > 0 and kvo_now < 0:
            switch = -0.20   # переключился в продажу

    # 6. Экстремум + начало поворота = выброс из накопления
    # Если KVO был на пике амплитуды и начал разворачиваться → деньги пошли
    extreme_win = min(10, len(kvo))
    kvo_peak = max(abs(x) for x in kvo[-extreme_win:]) or 1.0
    at_kvo_extreme = abs(kvo[-2] if len(kvo) >= 2 else kvo_now) > kvo_peak * 0.80
    breakout_pulse = 0.0
    if at_kvo_extreme and len(kvo) >= 3:
        if kvo[-2] > 0 and kvo_now < kvo[-2]:     # был вверху, начал опускаться
            breakout_pulse = -0.30
        elif kvo[-2] < 0 and kvo_now > kvo[-2]:   # был внизу, начал подниматься
            breakout_pulse = 0.30

    result = base * 0.45 + divergence * 0.45 + accumulation + expansion_bonus + switch + breakout_pulse
    return max(-1.0, min(1.0, result))


def score_vzo_candle(candles: list[HistoricCandle]) -> float:
    """
    VZO: Volume Zone Oscillator — объём в контексте зоны цены.

    Взвешивает объём по положению закрытия внутри диапазона свечи:
    закрылась вверху → объём считается «покупкой», внизу → «продажей».
    Точнее OBV (тот только знак) — показывает где физически торговался объём.

    1. Асимметрия в боковике: объём систематически вверху/внизу диапазона
    2. Насыщение в экстремуме + поворот → начало выброса
    3. Дивергенция VZO и цены: скрытое накопление при боковой цене
    4. Переключение направления: смена инициативы
    5. Скорость прыжка к экстремуму: агрессивность концентрации объёма
    """
    h, l, c, v = _hlcv(candles)
    n = len(c)
    if n < 10:
        return 0.0

    # Взвешиваем объём по положению закрытия в диапазоне свечи [0..1]
    # 1.0 = закрылся на хае (весь объём — покупка), 0.0 = на лоу (продажа)
    signed_vol = []
    for i in range(n):
        rng = (h[i] - l[i]) or 1e-9
        close_pos = (c[i] - l[i]) / rng   # 0..1
        weight = 2 * close_pos - 1         # -1..+1
        signed_vol.append(v[i] * weight)

    period = min(14, n - 1)
    alpha = 2 / (period + 1)
    ema_sv = [signed_vol[0]]
    ema_v  = [v[0]]
    for i in range(1, n):
        ema_sv.append(alpha * signed_vol[i] + (1 - alpha) * ema_sv[-1])
        ema_v.append(alpha * v[i]           + (1 - alpha) * ema_v[-1])
    vzo_series = [ema_sv[i] / ema_v[i] if ema_v[i] else 0.0 for i in range(n)]

    vzo_now = vzo_series[-1]
    vzo_prev = vzo_series[-2] if n >= 2 else vzo_now

    # 1. Базовый сигнал
    base = math.tanh(vzo_now * 3.0)

    # 2. Насыщение в экстремуме + поворот
    EXTREME = 0.65
    at_top    = vzo_now > EXTREME
    at_bottom = vzo_now < -EXTREME
    if at_top and vzo_now < vzo_prev:
        saturation = -0.50   # объём был вверху, дисбаланс разруливается → выброс вниз
    elif at_bottom and vzo_now > vzo_prev:
        saturation = 0.50    # объём был внизу, разруливается → выброс вверх
    else:
        saturation = 0.0

    # 3. Дивергенция: VZO монотонно растёт при боковой цене → скрытое накопление
    lb = min(20, n - 1)
    price_range = max(c[-lb:]) - min(c[-lb:])
    price_mean  = sum(c[-lb:]) / lb
    flat = price_range / (price_mean + 1e-9) < 0.015
    vzo_trend = vzo_series[-1] - vzo_series[-lb]
    accumulation = 0.0
    if flat and abs(vzo_trend) > 0.10:
        accumulation = math.copysign(min(0.40, abs(vzo_trend) * 2), vzo_trend)

    # 4. Переключение: смена инициативы
    switch = 0.0
    if n >= 3 and vzo_series[-2] < 0 and vzo_now > 0:
        switch = 0.20
    elif n >= 3 and vzo_series[-2] > 0 and vzo_now < 0:
        switch = -0.20

    # 5. Скорость прыжка к экстремуму
    lb3 = min(3, n - 1)
    speed = abs(vzo_now - vzo_series[-lb3])
    speed_mult = 1.0 + min(0.25, speed * 0.8)

    result = (base * 0.35 + saturation + accumulation + switch) * speed_mult
    return max(-1.0, min(1.0, result))


def score_donchian_candle(candles: list[HistoricCandle]) -> float:
    """
    DONCHIAN: асимметрия боковика через каналы Дончиана.

    В боковике максимумы касались верхней полосы много раз → там плотно накопились
    позиции/стопы. Выброс пойдёт в сторону менее плотного края (там меньше барьеров).

    1. Считаем касания верхней/нижней полосы за период боковика
    2. Асимметрия = скрытое направление: плотная сторона = стена → выброс в другую
    3. Только в боковике (price_range_pct < 4%): вне боковика сигнал бесполезен
    4. Близость к краю на последнем баре как дополнение (прижали к полосе)
    """
    h, l, c, _ = _hlcv(candles)
    n = len(c)
    if n < 20:
        return 0.0

    period = min(20, n - 1)
    upper = max(h[-period:])
    lower = min(l[-period:])
    mid = (upper + lower) / 2
    band_range = upper - lower
    if band_range < 1e-9:
        return 0.0

    # Только в боковике
    price_range_pct = band_range / (mid + 1e-9)
    if price_range_pct > 0.04:
        return 0.0

    # Касания полос: high близко к верхней, low близко к нижней
    touch_thr = band_range * 0.15
    upper_touches = sum(1 for hi in h[-period:] if hi >= upper - touch_thr)
    lower_touches = sum(1 for lo in l[-period:] if lo <= lower + touch_thr)
    total = upper_touches + lower_touches
    if total < 2:
        return 0.0

    # asymmetry > 0 = верх плотнее → выброс идёт вниз → сигнал отрицательный
    asymmetry = (upper_touches - lower_touches) / total
    signal = -math.tanh(asymmetry * 2.5)

    # Сила пропорциональна степени асимметрии
    strength = abs(asymmetry)
    if strength < 0.20:
        return 0.0

    # Близость текущей цены к менее плотному краю усиливает сигнал
    close_pos = (c[-1] - lower) / band_range  # 0=у нижней, 1=у верхней
    if signal > 0 and close_pos < 0.25:       # ждём выброса вверх, цена у нижней → усиление
        signal *= 1.20
    elif signal < 0 and close_pos > 0.75:     # ждём выброса вниз, цена у верхней → усиление
        signal *= 1.20

    return max(-1.0, min(1.0, signal * (0.5 + strength * 0.5)))


def score_twiggs_candle(candles: list[HistoricCandle]) -> float:
    """
    TWIGGS: детектор фазового перехода денежного потока.

    TMF как индикатор состояния цикла денег, не «куда идут».
    Когда TMF в экстремуме — фаза накопления/распределения завершается.
    Когда начинает разворачиваться — выброс в противоположную сторону.

    1. Экстремум + поворот: TMF был высоко/низко, начал разворачиваться →
       деньги сменили сторону, выброс. Главный сигнал.
    2. Насыщение (streak ≥3 баров в экстремуме): максимальное напряжение →
       усиление сигнала разворота как у Fisher.
    3. Дивергенция: цена на новом экстремуме, TMF не подтверждает → ловушка.
    4. Вспышка: TMF резко вырос и уже падает → деньги вошли и вышли,
       пора в обратную сторону.
    5. Тихое накопление в боковике → направленный выброс (единственный
       про-направленный сигнал: энергия накоплена, ещё не реализована).
    """
    h, l, c, v = _hlcv(candles)
    n = len(c)
    if n < 15:
        return 0.0
    period = min(21, n - 1)
    tmf = twiggs_money_flow(h, l, c, v, period=period)
    if len(tmf) < 5:
        return 0.0

    tmf_now  = tmf[-1]
    tmf_prev = tmf[-2]

    EXTREME = 0.65

    # 1. Экстремум + поворот = смена фазы денежного потока
    at_top    = tmf_now > EXTREME
    at_bottom = tmf_now < -EXTREME
    turning_down = at_top    and tmf_now < tmf_prev
    turning_up   = at_bottom and tmf_now > tmf_prev

    if turning_up:
        phase = 0.85
    elif turning_down:
        phase = -0.85
    elif at_top:
        phase = -0.25   # ещё в экстремуме, но сигнализируем насыщение
    elif at_bottom:
        phase = 0.25
    else:
        # Вне экстремума: слабый сигнал по направлению (деньги ещё накапливаются)
        phase = math.tanh(tmf_now * 3.0) * 0.30

    # 2. Streak в экстремуме усиливает сигнал разворота
    streak = 0
    for val in reversed(tmf[:-1]):
        if abs(val) > EXTREME:
            streak += 1
        else:
            break
    if (turning_up or turning_down) and streak >= 2:
        phase *= 1.0 + min(0.45, streak * 0.15)

    # 3. Дивергенция: цена на экстремуме, TMF нет → ловушка
    lb = min(20, n - 1)
    price_chg = c[-1] - c[-lb]
    tmf_chg   = tmf[-1] - tmf[-lb]
    divergence = 0.0
    if price_chg < -1e-4 and tmf_chg > 0.02:
        divergence = min(0.55, tmf_chg * 7)
    elif price_chg > 1e-4 and tmf_chg < -0.02:
        divergence = max(-0.55, tmf_chg * 7)

    # 4. Вспышка: TMF резко вырос и уже падает → деньги вошли и вышли
    flash = 0.0
    if len(tmf) >= 4:
        peak = max(abs(x) for x in tmf[-4:-1])
        if peak > 0.70 and abs(tmf_now) < peak * 0.50:
            flash = -math.copysign(0.40, tmf[-2])

    # 5. Тихое накопление: TMF долго умеренно в одну сторону при плоской цене
    acc_win = min(10, n)
    acc_vals = tmf[-acc_win:]
    pos_count = sum(1 for x in acc_vals if 0.05 < x < EXTREME)
    neg_count = sum(1 for x in acc_vals if -EXTREME < x < -0.05)
    accumulation = 0.0
    lb2 = min(acc_win, n - 1)
    price_range_pct = (max(c[-lb2:]) - min(c[-lb2:])) / (c[-1] + 1e-9)
    flat = price_range_pct < 0.015
    if flat:
        if pos_count >= acc_win * 0.7:
            accumulation = 0.35   # деньги тихо накапливались → выброс вверх
        elif neg_count >= acc_win * 0.7:
            accumulation = -0.35

    result = phase + divergence * 0.45 + flash + accumulation
    return max(-1.0, min(1.0, result))


def score_rmi_candle(candles: list[HistoricCandle]) -> float:
    """RMI: Relative Momentum Index, вариант RSI на разностях (Фаза 3)."""
    return score_rmi([_to_f(c.close) for c in candles])


def score_zscore_candle(candles: list[HistoricCandle]) -> float:
    """
    ZSCORE: детектор исчерпания энергии → сигнал разворота.

    Z близко к 0 при движущейся цене = цена на пределе напряжения в текущую сторону,
    энергия в этом направлении кончилась. Вот-вот переключится, часто резче.
    Сигнал: разворот в противоположную сторону.

    |Z| > 2 = экстремальное отклонение → классический возврат к среднему.
    """
    closes = [_to_f(c.close) for c in candles]
    n = len(closes)
    if n < 15:
        return 0.0
    period = min(20, n)
    window = closes[-period:]
    mean = sum(window) / period
    std = (sum((x - mean) ** 2 for x in window) / period) ** 0.5
    if std < 1e-9:
        return 0.0
    z = (closes[-1] - mean) / std

    lb = min(10, n - 1)
    price_move = (closes[-1] - closes[-lb]) / (closes[-lb] + 1e-9)
    moving = abs(price_move) > 0.003
    direction = 1 if price_move > 0 else -1

    # Z ≈ 0 при движущейся цене: энергия в этом направлении исчерпана → разворот
    if abs(z) < 0.5 and moving:
        reversal_strength = min(0.75, 0.40 + abs(price_move) * 40)
        return max(-1.0, min(1.0, -direction * reversal_strength))

    # |Z| > 2: экстремальное отклонение → возврат к среднему
    if z > 2.0:
        base = -min(0.75, (z - 1.5) * 0.40)
    elif z < -2.0:
        base = min(0.75, (-z - 1.5) * 0.40)
    else:
        base = 0.0

    # Z-дивергенция: документ — цена новый экстремум, Z нет → распределение/затухание
    # Смотрим на окно: где был пик цены и какой там был Z
    divergence = 0.0
    if n >= 25:
        lb_div = min(20, n - 2)
        window_closes = closes[-lb_div - 1:]
        # Считаем Z для каждого бара окна
        zs = []
        for i in range(len(window_closes)):
            w = window_closes[max(0, i - period + 1):i + 1]
            if len(w) < 3:
                zs.append(0.0)
                continue
            m = sum(w) / len(w)
            s = (sum((x - m) ** 2 for x in w) / len(w)) ** 0.5 or 1e-9
            zs.append((w[-1] - m) / s)
        # Если цена сейчас на новом максимуме за окно, но Z не на новом максимуме
        if closes[-1] >= max(window_closes) - 1e-9 and zs and z < max(zs) - 0.5:
            divergence = -min(0.45, (max(zs) - z) * 0.2)   # медвежья дивергенция
        elif closes[-1] <= min(window_closes) + 1e-9 and zs and z > min(zs) + 0.5:
            divergence = min(0.45, (z - min(zs)) * 0.2)    # бычья дивергенция

    return max(-1.0, min(1.0, base + divergence))


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
    SINEWAVE_SIGNAL: Ehlers Even Better Sinewave — фаза и амплитуда цикла.

    Классическое пересечение нуля удалено — это запаздывающий шумный дубль.

    Что реально используется:
    1. Фаза: синусоида в экстремуме = максимальное натяжение (нитка).
       Поворот от экстремума = начало выброса → основной сигнал.
    2. Амплитуда: энергия цикла. Большой размах = выброс будет сильным.
    3. Скорость разворота: крутой поворот от экстремума = резкий выброс.
    4. Дивергенция: цена делает новый экстремум, EBS не подтверждает →
       энергия цикла уже разворачивается, цена скоро последует.
    """
    closes = [_to_f(c.close) for c in candles]
    n = len(closes)
    if n < 20:
        return 0.0
    period = min(10, max(3, n // 3))
    series = even_better_sinewave(closes, hp_period=min(40, n), period=period)
    if len(series) < 6:
        return 0.0

    v = series[-1]

    # 1. Фаза цикла: экстремум → поворот
    win5 = series[-5:]
    at_peak   = (v > 0.55) and (v >= max(win5[:-1]))   # вверху, начинает поворачивать
    at_trough = (v < -0.55) and (v <= min(win5[:-1]))  # внизу, начинает поворачивать

    turn_down = at_peak   and v < series[-2]   # повернул вниз от вершины
    turn_up   = at_trough and v > series[-2]   # повернул вверх от дна

    if turn_up:
        phase_signal = 0.85
    elif turn_down:
        phase_signal = -0.85
    else:
        # В середине цикла — слабый сигнал по направлению движения синусоиды
        phase_signal = math.tanh((v - series[-2]) * 8) * 0.4

    # 2. Амплитуда как энергия: RMS последних 5 баров vs предыдущих 10
    rms_now  = (sum(x * x for x in series[-5:]) / 5) ** 0.5
    rms_old  = (sum(x * x for x in series[-15:-5]) / 10) ** 0.5 if n >= 15 else rms_now
    energy_mult = min(1.4, max(0.6, rms_now / (rms_old + 1e-9)))

    # 3. Скорость поворота: чем круче разворот, тем резче выброс
    speed = abs(v - series[-3]) if n >= 3 else 0.0
    speed_mult = 1.0 + min(0.25, speed * 0.8)

    # 4. Дивергенция: цена делает новый экстремум, EBS — нет
    lb = min(15, n - 1)
    price_chg = closes[-1] - closes[-lb]
    ebs_chg   = series[-1] - series[-lb]
    divergence = 0.0
    if price_chg < -1e-4 and ebs_chg > 0.08:    # цена вниз, EBS разворачивается вверх
        divergence = min(0.5, ebs_chg * 4)
    elif price_chg > 1e-4 and ebs_chg < -0.08:  # цена вверх, EBS разворачивается вниз
        divergence = max(-0.5, ebs_chg * 4)

    result = phase_signal * energy_mult * speed_mult + divergence * 0.4
    return max(-1.0, min(1.0, result))


def score_mmi_signal(candles: list[HistoricCandle]) -> float:
    """MMI_SIGNAL: не в METHODS — вызывается только из вето-логики напрямую."""
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
    """YZ_VOL_SIGNAL: не в METHODS — режим волатильности учтён в REGIME_WEIGHT_MODS."""
    if len(candles) < 12:
        return 0.0
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
        rs = (math.log(h / cl) * math.log(h / o) + math.log(lo / cl) * math.log(lo / o))
        vols.append(math.sqrt(max(0.0, overnight + rs)))
    if len(vols) < 6:
        return 0.0
    cur = vols[-1]
    rank = sum(1 for v in vols if v <= cur) / len(vols)
    if rank > 0.8:
        return -0.5
    if rank < 0.2:
        return 0.5
    return 0.0


def _variance_ratio(candles: list[HistoricCandle], q: int = 4) -> Optional[float]:
    """
    Variance Ratio VR(q) — отношение дисперсии q-периодных доходностей к
    q×дисперсии однопериодных. VR > 1 — тренд/персистентность (момент),
    VR < 1 — возврат к среднему (шум). None — недостаточно данных.
    Вынесено из score_vr_signal, чтобы то же сырое число использовать для
    адаптации ширины стопа (см. __noise_stop_scale), не только для голоса
    в композите.
    """
    closes = [_to_f(c.close) for c in candles]
    rets = _log_returns(closes)
    if len(rets) < q * 3:
        return None
    var1 = statistics.pvariance(rets)
    if var1 <= 0:
        return None
    # q-периодные перекрывающиеся суммы доходностей
    q_sums = [sum(rets[i:i + q]) for i in range(len(rets) - q + 1)]
    if len(q_sums) < 2:
        return None
    varq = statistics.pvariance(q_sums)
    return varq / (q * var1)


def score_vr_signal(candles: list[HistoricCandle]) -> float:
    """VR_SIGNAL: не в METHODS — Variance Ratio используется в __noise_stop_scale."""
    vr = _variance_ratio(candles)
    if vr is None:
        return 0.0
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


def score_nadaraya_watson(candles: list[HistoricCandle]) -> float:
    """
    NADARAYA_WATSON: ядерная регрессия с гауссовым ядром даёт гладкую
    оценку «справедливой цены» без предположений о форме тренда.

    Сигнал двухкомпонентный:
    1. Наклон NW-линии за последние 5 баров → направление тренда
    2. Отклонение текущей цены от NW-линии → mean-reversion потенциал

    Итог: если тренд вверх и цена выше NW → слабый бычий сигнал (подтверждение);
    если тренд вверх но цена сильно выше NW → риск перекупленности (ослабление);
    если тренд вверх и цена ниже NW → сильный бычий сигнал (откат в тренде).
    """
    closes = [_to_f(c.close) for c in candles]
    n = len(closes)
    if n < 25:
        return 0.0

    # Ширина окна: ~30% длины ряда, минимум 8 баров
    h = max(8.0, n * 0.30)

    def nw(idx: int) -> float:
        total_w = 0.0
        total_wc = 0.0
        for j in range(n):
            w = math.exp(-0.5 * ((idx - j) / h) ** 2)
            total_w += w
            total_wc += w * closes[j]
        return total_wc / (total_w + 1e-9)

    nw_now  = nw(n - 1)
    nw_prev = nw(n - 6)   # 5 баров назад — для оценки наклона

    if nw_now <= 0 or nw_prev <= 0:
        return 0.0

    # Наклон NW-линии (нормированный)
    slope = (nw_now - nw_prev) / (nw_prev * 5)   # % в бар
    slope_signal = math.tanh(slope * 200)          # ±1 при наклоне ≥0.5% за 5 баров

    # Отклонение цены от NW (mean-reversion компонента, знак инверсный к наклону)
    dev = (closes[-1] - nw_now) / (nw_now + 1e-9)
    # Если цена ниже NW при восходящем наклоне — усиливаем бычий сигнал
    # Если цена выше NW при восходящем наклоне — ослабляем (риск перекупленности)
    dev_signal = -math.tanh(dev * 50)             # инверсия: ниже NW → +, выше → −

    # Итог: 60% наклон (тренд первичен) + 40% отклонение (mean-reversion вторично)
    raw = slope_signal * 0.60 + dev_signal * 0.40
    return float(max(-1.0, min(1.0, raw)))


def score_fractional_diff(candles: list[HistoricCandle]) -> float:
    """
    FRACTIONAL_DIFF: дробное дифференцирование ряда цен с d=0.4.

    Стандартная разность (d=1) убирает тренд но теряет всю память о прошлом.
    Дробная (d∈(0,1)) делает ряд стационарнее чем цены, но сохраняет долгосрочную
    память — важную для понимания где находимся в цикле.

    Веса обрываются при |w_k| < threshold (fixed-width window).
    Сигнал: знак + наклон frac-diff серии → направление «очищенного» тренда.
    """
    closes = [_to_f(c.close) for c in candles]
    n = len(closes)
    if n < 30:
        return 0.0

    d = 0.4       # оптимальный баланс: стационарность без потери памяти
    threshold = 1e-4
    window = min(n - 1, 40)

    # Вычисляем веса w_k = (-1)^k * C(d, k)
    weights = [1.0]
    for k in range(1, window + 1):
        w = weights[-1] * (d - k + 1) / k
        if abs(w) < threshold:
            break
        weights.append(w)

    wlen = len(weights)
    if n < wlen:
        return 0.0

    # Применяем к концу ряда
    def fd(idx: int) -> float:
        return sum(weights[k] * closes[idx - k] for k in range(wlen))

    fd_now  = fd(n - 1)
    fd_prev = fd(n - 4)
    fd_old  = fd(n - 9) if n >= wlen + 9 else fd_prev

    # Знак текущего значения (≈ позиция цены относительно долгосрочного тренда)
    # fd > 0 → цена выше своей взвешенной «памяти» → бычий контекст
    sign_signal = math.tanh(fd_now / (abs(fd_now) + 1e-3) * abs(fd_now) / (closes[-1] * 0.005 + 1e-9))

    # Наклон frac-diff серии — краткосрочный импульс в очищенном пространстве
    slope = fd_now - fd_prev
    slope_old = fd_prev - fd_old
    # Ускорение наклона: нарастающий импульс сильнее одиночного значения
    accel_mult = 1.2 if (slope > 0 and slope_old > 0) or (slope < 0 and slope_old < 0) else 0.8
    slope_signal = math.tanh(slope / (closes[-1] * 0.002 + 1e-9)) * accel_mult

    raw = sign_signal * 0.45 + slope_signal * 0.55
    return float(max(-1.0, min(1.0, raw)))


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


def score_vsa(candles: list[HistoricCandle]) -> float:
    """
    Volume Spread Analysis — паттерны VSA/Wyckoff на последних барах.

    Паттерны (каждый даёт скор от -1 до +1, итог — взвешенное среднее):

    Бычьи:
      No Supply    — узкий спред + низкий объём + закрытие в нижней половине
                     на нисходящем баре после даунтренда → нет давления продаж
      Stopping Vol — очень высокий объём + широкий спред вниз + закрытие
                     в верхней трети → поглощение продаж
      Test         — низкий объём + узкий спред вниз + закрытие выше середины
                     после высокообъёмного даунбара → успешный тест предложения
      Effort Up    — широкий спред вверх + высокий объём + закрытие в верхней
                     трети → усилие совпадает с результатом

    Медвежьи:
      No Demand    — узкий спред + низкий объём + закрытие в верхней половине
                     на восходящем баре после аптренда → нет спроса
      Up-thrust    — широкий спред вверх + высокий объём + закрытие в нижней
                     трети (ложный пробой, отвержение)
      SOW          — широкий спред вниз + высокий объём + закрытие в нижней
                     трети → знак слабости
    """
    if len(candles) < 10:
        return 0.0

    vols = [float(c.volume) for c in candles]
    vol_ma = statistics.mean(vols[-20:]) if len(vols) >= 20 else statistics.mean(vols)
    if vol_ma <= 0:
        return 0.0

    def bar(c):
        h, lo, op, cl = _to_f(c.high), _to_f(c.low), _to_f(c.open), _to_f(c.close)
        rng = h - lo or 1e-9
        return h, lo, op, cl, rng

    last = candles[-1]
    h, lo, op, cl, rng = bar(last)
    vol = float(last.volume)
    vol_ratio = vol / vol_ma          # >1.5 высокий, <0.6 низкий
    close_pos = (cl - lo) / rng       # 0=низ, 1=верх
    is_up = cl >= op
    spread_ratio = rng / (statistics.mean(
        [_to_f(c.high) - _to_f(c.low) for c in candles[-10:-1]]) or 1e-9)

    # предшествующий тренд последних 5 баров
    closes_5 = [_to_f(c.close) for c in candles[-6:-1]]
    trend = closes_5[-1] - closes_5[0]  # >0 аптренд, <0 даунтренд

    # предыдущий бар
    prev = candles[-2]
    ph, plo, pop, pcl, prng = bar(prev)
    prev_vol = float(prev.volume)
    prev_vol_ratio = prev_vol / vol_ma

    signals: list[float] = []

    # ── No Supply (бычий) ───────────────────────────────────────────────────
    if (not is_up and spread_ratio < 0.8 and vol_ratio < 0.7
            and close_pos < 0.5 and trend < 0):
        signals.append(0.7)

    # ── No Demand (медвежий) ────────────────────────────────────────────────
    if (is_up and spread_ratio < 0.8 and vol_ratio < 0.7
            and close_pos > 0.5 and trend > 0):
        signals.append(-0.7)

    # ── Stopping Volume / Climax (бычий) ───────────────────────────────────
    if (not is_up and vol_ratio > 1.8 and spread_ratio > 1.2
            and close_pos > 0.6 and trend < 0):
        signals.append(0.9)

    # ── Sign of Weakness (медвежий) ─────────────────────────────────────────
    if (not is_up and vol_ratio > 1.8 and spread_ratio > 1.2
            and close_pos < 0.35 and trend > 0):
        signals.append(-0.9)

    # ── Up-thrust (медвежий) ────────────────────────────────────────────────
    if (is_up and vol_ratio > 1.4 and spread_ratio > 1.2 and close_pos < 0.35):
        signals.append(-0.85)

    # ── Test (бычий) — низкий объём после высокообъёмного даунбара ──────────
    if (not is_up and vol_ratio < 0.6 and spread_ratio < 0.9
            and close_pos > 0.5 and prev_vol_ratio > 1.4 and pcl < pop):
        signals.append(0.75)

    # ── Effort Up (бычий) ───────────────────────────────────────────────────
    if (is_up and vol_ratio > 1.5 and spread_ratio > 1.1 and close_pos > 0.65):
        signals.append(0.8)

    # ── Effort Down (медвежий) ──────────────────────────────────────────────
    if (not is_up and vol_ratio > 1.5 and spread_ratio > 1.1 and close_pos < 0.35):
        signals.append(-0.8)

    # ── Широкий спред + низкий объём = охота за стопами ───────────────────────
    # Цена выбила стопы (широкая свеча), но объём мал = стопы собраны, инициативы нет.
    # Охота завершена → цена разворачивается и идёт в противоположную сторону резче.
    if spread_ratio > 1.3 and vol_ratio < 0.60:
        stop_hunt_dir = 1 if is_up else -1
        signals.append(-stop_hunt_dir * 0.80)  # разворот после охоты

    # ── Узкий спред + высокий объём = поглощение → каскад в другую сторону ────
    # Огромный объём не двигает цену = поглощение. Когда поглощение завершится,
    # цена резко пойдёт в противоположную сторону — накопленная энергия выйдет.
    if spread_ratio < 0.55 and vol_ratio > 1.8:
        recent_close = sum(_to_f(c.close) for c in candles[-5:-1]) / 4
        absorb_dir = 1 if cl > recent_close else -1
        signals.append(-absorb_dir * 0.75)  # каскад против направления поглощения

    if not signals:
        return 0.0
    # берём максимальный по модулю сигнал (не усредняем — паттерны не складываются)
    return max(signals, key=abs)


def _score_one_level(
    candles, window_size: int, atr_abs: float, cl_now: float, level,
    touch_frac: float, reject_frac: float, confirm_bars: int,
    vol_strong: float, vol_breakout: float, vols_ref: list,
) -> float:
    """
    Скор поведения цены у одного уровня за window_size баров.
    level — объект с атрибутами .price и .tier (PriceLevel).
    Возвращает значение до применения tier_w (caller применяет сам).
    """
    lp = level.price
    touch_zone = touch_frac * atr_abs
    tier_w = {1: 1.3, 2: 1.2, 3: 1.0, 4: 0.8, 5: 0.7}.get(level.tier, 1.0)

    window = candles[-window_size:]
    avg_vol = statistics.mean(vols_ref) if vols_ref else 1.0

    reject_res: list[float] = []
    reject_sup: list[float] = []
    breakout_above_idx: list[int] = []
    breakout_above_vols: list[float] = []
    breakout_below_idx: list[int] = []
    breakout_below_vols: list[float] = []

    for i, c in enumerate(window):
        h = _to_f(c.high); lo = _to_f(c.low); cl = _to_f(c.close)
        vol_ratio = float(c.volume) / avg_vol if avg_vol > 0 else 1.0
        if lo < lp and h >= lp - touch_zone and cl < lp - reject_frac * atr_abs:
            reject_res.append(vol_ratio)
        if h > lp and lo <= lp + touch_zone and cl > lp + reject_frac * atr_abs:
            reject_sup.append(vol_ratio)
        if cl > lp + touch_zone * 0.5:
            breakout_above_idx.append(i); breakout_above_vols.append(vol_ratio)
        elif cl < lp - touch_zone * 0.5:
            breakout_below_idx.append(i); breakout_below_vols.append(vol_ratio)

    score = 0.0
    first_half = window_size // 2

    if len(reject_res) >= 2:
        strength = min(1.0, len(reject_res) / 3.0)
        vol_boost = min(1.3, statistics.mean(reject_res) / vol_strong)
        score = -strength * 0.85 * min(1.3, vol_boost)
    elif len(reject_sup) >= 2:
        strength = min(1.0, len(reject_sup) / 3.0)
        vol_boost = min(1.3, statistics.mean(reject_sup) / vol_strong)
        score = +strength * 0.85 * min(1.3, vol_boost)

    had_above = any(i < first_half for i in breakout_above_idx)
    had_below = any(i < first_half for i in breakout_below_idx)
    now_below = cl_now < lp - touch_zone * 0.3
    now_above = cl_now > lp + touch_zone * 0.3

    if had_above and now_below:
        bv = max((v for i, v in zip(breakout_above_idx, breakout_above_vols) if i < first_half), default=1.0)
        vm = min(1.2, bv / vol_breakout) if bv >= vol_breakout else 0.85
        score = -0.75 * vm
    elif had_below and now_above:
        bv = max((v for i, v in zip(breakout_below_idx, breakout_below_vols) if i < first_half), default=1.0)
        vm = min(1.2, bv / vol_breakout) if bv >= vol_breakout else 0.85
        score = +0.75 * vm

    tail = window[-confirm_bars:]
    tail_avg_vol = statistics.mean(float(c.volume) / avg_vol for c in tail) if tail else 1.0
    if all(_to_f(c.close) > lp + touch_zone * 0.3 for c in tail):
        vol_conf = min(1.2, tail_avg_vol / vol_strong) if tail_avg_vol >= 1.0 else 0.7
        score = +0.65 * vol_conf
    elif all(_to_f(c.close) < lp - touch_zone * 0.3 for c in tail):
        vol_conf = min(1.2, tail_avg_vol / vol_strong) if tail_avg_vol >= 1.0 else 0.7
        score = -0.65 * vol_conf

    return max(-1.0, min(1.0, score * tier_w))


def score_level_context(candles: list[HistoricCandle], external_nearest=None) -> float:
    """
    Поведение цены у ближайшего уровня за последние WINDOW баров.

    Один бар — шум. Метод смотрит на паттерн взаимодействия за окно:

    Паттерны (в порядке убывания приоритета):
    1. СЕРИЯ ОТКАЗОВ от сопротивления/поддержки (≥2 баров касались уровня,
       большинство закрылись обратно) → медвежий/бычий сигнал.
       Сила пропорциональна количеству отказов и объёму.
    2. ЛОЖНЫЙ ПРОБОЙ: был закрытый пробой уровня → затем возврат обратно
       → текущая цена на противоположной стороне → сигнал разворота.
       Объём на пробойном баре усиливает сигнал: аномальный объём = захват
       ликвидности (стопы сбили), вероятность разворота выше.
    3. ПОДТВЕРЖДЁННЫЙ ПРОБОЙ: 3+ закрытий подряд за уровнем (в хвосте окна)
       + объём на пробойном баре выше среднего → сигнал продолжения.
       Без объёма пробой слабее (множитель 0.7).
    4. Далеко от уровня или нет паттерна → 0.

    Объём везде обязателен: паттерн без объёма = шум рынка, не торгуем.
    Tier 1-2 (неделя/день) весят сильнее, чем фракталы/круглые числа.
    """
    # ~3 торговых часа: на M5 ≈ 36 баров, на M1 ≈ 180, на H1 ≈ 3 → min 10
    _WINDOW = _adaptive_window(candles, target_hours=3.0, min_bars=12, max_bars=100)
    _TOUCH_FRAC = 0.35      # бар "касается" уровня если H или L в пределах TOUCH_FRAC*ATR
    _REJECT_FRAC = 0.4      # закрытие считается "отказом" если ушло на REJECT_FRAC*ATR от уровня
    _CONFIRM_BARS = max(3, _WINDOW // 8)   # ~12% окна подряд за уровнем
    _VOL_STRONG = 1.2       # объём "усиленный"
    _VOL_BREAKOUT = 1.5     # объём на пробое — "аномальный" (захват ликвидности)

    if len(candles) < 40:
        return 0.0
    atr_pct = _compute_atr(candles)
    if atr_pct <= 0:
        return 0.0
    cl_now = _to_f(candles[-1].close)
    atr_abs = atr_pct * cl_now
    if atr_abs <= 0:
        return 0.0

    # Уровни: либо из многогоризонтного кеша (MTF), либо строятся локально
    if external_nearest is not None:
        # external_nearest(price, max_dist) → [(horizon, PriceLevel)]
        candidates = external_nearest(cl_now, 2.5 * atr_abs)
        if not candidates:
            return 0.0
        # Агрегируем скоры по каждому уровню и берём взвешенное среднее
        # (горизонт: неделя×1.0, месяц×1.4, полгода×1.8)
        _HORIZON_W = {"week": 1.0, "month": 1.4, "half": 1.8}
        horizon_scores: list[tuple[float, float]] = []  # (score, weight)
        for horizon, lv in candidates[:6]:  # не больше 6 уровней
            s = _score_one_level(candles, _WINDOW, atr_abs, cl_now, lv,
                                  _TOUCH_FRAC, _REJECT_FRAC, _CONFIRM_BARS,
                                  _VOL_STRONG, _VOL_BREAKOUT,
                                  vols_ref=[float(c.volume) for c in candles[-(_WINDOW + 20): -_WINDOW]])
            if s != 0.0:
                # Корректировка по полярности уровня (S/R flip enrichment):
                # Сигнал совпадает с полярностью (бычий у поддержки / медвежий у сопротивления) —
                # усиливаем; противоречит (например, медвежий сигнал, но уровень поддержка) —
                # гасим. S/R flip-уровни (flipped=True) реагируют сильнее: ретест после пробоя
                # — одна из самых надёжных точек входа.
                pol = getattr(lv, "polarity", "neutral")
                flipped = getattr(lv, "flipped", False)
                if pol == "support" and s > 0:
                    s *= 1.20 if flipped else 1.10
                elif pol == "resistance" and s < 0:
                    s *= 1.20 if flipped else 1.10
                elif pol == "support" and s < 0:
                    s *= 0.70   # медвежий сигнал у поддержки — контрарный, гасим
                elif pol == "resistance" and s > 0:
                    s *= 0.70   # бычий сигнал у сопротивления — контрарный, гасим
                hw = _HORIZON_W.get(horizon, 1.0)
                horizon_scores.append((s, hw))
        if not horizon_scores:
            return 0.0
        total_w = sum(w for _, w in horizon_scores)
        agg = sum(s * w for s, w in horizon_scores) / total_w
        return max(-1.0, min(1.0, agg))

    # Fallback: строим уровни по истории до начала окна (без look-ahead)
    ls = build_levels(candles[:-_WINDOW])
    nearest = ls.nearest(cl_now, max_dist=2.5 * atr_abs)
    if nearest is None:
        return 0.0

    vols_ref = [float(c.volume) for c in candles[-(_WINDOW + 20): -_WINDOW]]
    return _score_one_level(
        candles, _WINDOW, atr_abs, cl_now, nearest,
        _TOUCH_FRAC, _REJECT_FRAC, _CONFIRM_BARS, _VOL_STRONG, _VOL_BREAKOUT,
        vols_ref,
    )


def score_market_structure(candles: list[HistoricCandle]) -> float:
    """
    Рыночная структура: BOS, CHoCH, Equal Highs, глубина HL, скорость структуры.

    Уровни сигнала:
      CHoCH (Change of Character) — только один из пары сломан (LH без LL, или LL без LH).
        Это предупреждение, не разворот. Оценка × 0.35.
      BOS (Break of Structure) — сломаны ОБА (LH + LL в бычьей структуре).
        Подтверждённый слом. Полная оценка × 0.8.

    Дополнительные компоненты:
      - Глубина HL (только для бычьей структуры):
          < 30% откат от импульса = сильная структура (+бонус)
          > 60% = слабая, накопление ещё не зрело (−бонус)
      - Скорость структуры: если время между HL и следующим HH растёт (2→4→8 баров),
          энергия падает — опережает дивергенции.
      - Equal Highs: два хая в пределах 0.2% — пул ликвидности, сигнал ловушки.
      - BOS на низком объёме (< 1.2× avg) = fake BOS, оценка × 0.4.
    """
    _SWING_W = _adaptive_window(candles, target_hours=8.0, min_bars=30, max_bars=300)
    _LOOKBACK = 3
    _MIN_SWINGS = 2

    if len(candles) < _SWING_W:
        return 0.0
    atr_pct = _compute_atr(candles)
    if atr_pct <= 0:
        return 0.0

    window = candles[-_SWING_W:]
    vols = [float(c.volume) for c in window]
    avg_vol = statistics.mean(vols) or 1.0
    n = len(window)

    # Свинг-хаи и лои: (idx_in_window, price, vol_ratio)
    swing_highs: list[tuple[int, float, float]] = []
    swing_lows:  list[tuple[int, float, float]] = []
    for i in range(_LOOKBACK, n - _LOOKBACK):
        h  = _to_f(window[i].high)
        lo = _to_f(window[i].low)
        vr = float(window[i].volume) / avg_vol
        if all(_to_f(window[i - j].high) < h and _to_f(window[i + j].high) < h
               for j in range(1, _LOOKBACK + 1)):
            swing_highs.append((i, h, vr))
        if all(_to_f(window[i - j].low) > lo and _to_f(window[i + j].low) > lo
               for j in range(1, _LOOKBACK + 1)):
            swing_lows.append((i, lo, vr))

    if len(swing_highs) < _MIN_SWINGS or len(swing_lows) < _MIN_SWINGS:
        return 0.0

    sh, sl = swing_highs, swing_lows

    was_bullish = sh[-1][1] > sh[-2][1] and sl[-1][1] > sl[-2][1]
    was_bearish = sh[-1][1] < sh[-2][1] and sl[-1][1] < sl[-2][1]

    if not was_bullish and not was_bearish:
        return 0.0

    def count_seq(pts: list, ascending: bool) -> int:
        c = 0
        for i in range(len(pts) - 1, 0, -1):
            if (ascending and pts[i][1] > pts[i - 1][1]) or \
               (not ascending and pts[i][1] < pts[i - 1][1]):
                c += 1
            else:
                break
        return c

    score = 0.0

    if was_bullish:
        lh = sh[-1][1] < sh[-2][1]   # последний хай ниже предыдущего → LH
        ll = sl[-1][1] < sl[-2][1]   # последний лой ниже → LL

        if not lh and not ll:
            # Структура цела — смотрим глубину HL и скорость
            # Глубина последнего HL: откат / (предыдущий импульс)
            impulse = sh[-1][1] - sl[-2][1] if len(sl) >= 2 and len(sh) >= 1 else 0.0
            retrace = sh[-1][1] - sl[-1][1] if impulse > 0 else 0.0
            depth_ratio = retrace / (impulse or 1e-9) if impulse > 0 else 0.5
            # Чем мельче откат — тем сильнее структура (бычий бонус)
            if impulse > 0:
                if depth_ratio < 0.30:
                    score = +0.30   # очень мелкий откат — агрессивное накопление
                elif depth_ratio < 0.50:
                    score = +0.15
                elif depth_ratio > 0.65:
                    score = -0.10   # глубокий откат — слабая структура
            # Скорость: расстояние HL→HH в барах (последние 2 пары)
            if len(sh) >= 2 and len(sl) >= 2:
                speed_prev = sh[-2][0] - sl[-2][0]
                speed_curr = sh[-1][0] - sl[-1][0]
                if speed_prev > 0 and speed_curr > speed_prev * 1.5:
                    score -= 0.15   # структура замедляется — затухание
        elif lh or ll:
            # CHoCH: один из пары сломан (предупреждение)
            bos = lh and ll  # оба — подтверждённый BOS
            depth = max(
                (sh[-2][1] - sh[-1][1]) / (sh[-2][1] or 1) if lh else 0.0,
                (sl[-2][1] - sl[-1][1]) / (sl[-2][1] or 1) if ll else 0.0,
            )
            vol_r = sh[-1][2] if lh else sl[-1][2]
            # Фильтр fake BOS: объём должен быть > 1.2× avg на баре слома
            vol_factor = 1.0 if vol_r >= 1.2 else 0.4
            strength = min(1.0, depth / atr_pct) * min(1.5, vol_r)
            trend_bonus = min(1.4, 1.0 + 0.1 * (count_seq(sh, True) + count_seq(sl, True)))
            choch_mult = 0.8 if bos else 0.35   # BOS полный / CHoCH предупреждение
            score = -min(1.0, strength * choch_mult * trend_bonus) * vol_factor

    elif was_bearish:
        hh = sh[-1][1] > sh[-2][1]
        hl = sl[-1][1] > sl[-2][1]

        if not hh and not hl:
            impulse = sl[-1][1] - sh[-2][1] if len(sh) >= 2 and len(sl) >= 1 else 0.0
            retrace = sl[-1][1] - sh[-1][1] if impulse < 0 else 0.0
            depth_ratio = abs(retrace) / (abs(impulse) or 1e-9) if impulse < 0 else 0.5
            if impulse < 0:
                if depth_ratio < 0.30:
                    score = -0.30
                elif depth_ratio < 0.50:
                    score = -0.15
                elif depth_ratio > 0.65:
                    score = +0.10
            if len(sh) >= 2 and len(sl) >= 2:
                speed_prev = sl[-2][0] - sh[-2][0]
                speed_curr = sl[-1][0] - sh[-1][0]
                if speed_prev > 0 and speed_curr > speed_prev * 1.5:
                    score += 0.15
        elif hh or hl:
            bos = hh and hl
            depth = max(
                (sh[-1][1] - sh[-2][1]) / (sh[-2][1] or 1) if hh else 0.0,
                (sl[-1][1] - sl[-2][1]) / (sl[-2][1] or 1) if hl else 0.0,
            )
            vol_r = sh[-1][2] if hh else sl[-1][2]
            vol_factor = 1.0 if vol_r >= 1.2 else 0.4
            strength = min(1.0, depth / atr_pct) * min(1.5, vol_r)
            trend_bonus = min(1.4, 1.0 + 0.1 * (count_seq(sh, False) + count_seq(sl, False)))
            choch_mult = 0.8 if bos else 0.35
            score = +min(1.0, strength * choch_mult * trend_bonus) * vol_factor

    # Equal Highs: два последних свинг-хая в пределах 0.2% — пул ликвидности.
    # Сам по себе не направленный сигнал, но усиливает противоположный CHoCH.
    eq_high_trap = (len(sh) >= 2 and
                    abs(sh[-1][1] - sh[-2][1]) / (sh[-2][1] or 1) < 0.002)
    eq_low_trap  = (len(sl) >= 2 and
                    abs(sl[-1][1] - sl[-2][1]) / (sl[-2][1] or 1) < 0.002)
    if eq_high_trap and score < 0:
        score *= 1.25   # equal highs + CHoCH вниз = ловушка сработала, усиливаем медвежий
    if eq_low_trap and score > 0:
        score *= 1.25

    return max(-1.0, min(1.0, score))


def score_spring(candles: list[HistoricCandle]) -> float:
    """
    Wyckoff Spring / Upthrust / Тихий Spring + компрессия-импульс.

    Блок 1 — Wyckoff Spring (бычий): пробой лоя диапазона + быстрый возврат.
      Глубина пробоя → сила каскада (собрали много стопов → сильнее движение).
      Соотношение объёма: vol_return > vol_breakout = аномально агрессивный вход.

    Блок 2 — Тихий Spring (No Supply): цена касается лоя на объёме 3-5× НИЖЕ
      среднего → крупняк уже набрал, стопов почти нет → самое взрывное движение.

    Блок 3 — Upthrust (медвежий): зеркало spring — пробой хая + возврат.
      Держит пробой < 2 баров = upthrust (vs BOS который держит 2+).
      Equal Highs + upthrust = двойная ловушка (усиление ×1.25).

    Блок 4 — Компрессия + импульс (прежняя логика: NR / ATR squeeze → выход).
    """
    _BASE_VOL_BARS = _adaptive_window(candles, target_hours=2.5, min_bars=10, max_bars=150)
    _COMP_BARS     = _adaptive_window(candles, target_hours=1.0,  min_bars=4,  max_bars=60)

    if len(candles) < _BASE_VOL_BARS + 5:
        return 0.0
    atr_pct = _compute_atr(candles)
    if atr_pct <= 0:
        return 0.0
    last_price = _to_f(candles[-1].close)
    atr_abs = atr_pct * last_price or 1e-9

    vols_base = [float(c.volume) for c in candles[-_BASE_VOL_BARS:-_COMP_BARS - 1]]
    avg_vol = statistics.mean(vols_base) if vols_base else 1.0
    if avg_vol <= 0:
        return 0.0

    # Диапазон за последние ~20 баров (до текущего) — уровень поддержки/сопротивления
    _RANGE_W = min(20, len(candles) - 3)
    range_window = candles[-_RANGE_W - 2:-2]
    rng_high = max(_to_f(c.high) for c in range_window)
    rng_low  = min(_to_f(c.low)  for c in range_window)

    score = 0.0

    # ── Блок 1: Wyckoff Spring / Upthrust ─────────────────────────────────────
    # Смотрим последние 3 бара: был ли пробой + возврат за 1-2 свечи
    for lag in range(1, 3):
        if len(candles) < lag + 2:
            break
        bar_poke  = candles[-(lag + 1)]    # бар пробоя
        bar_after = candles[-lag]           # бар после (или текущий)
        curr_bar  = candles[-1]

        poke_low  = _to_f(bar_poke.low)
        poke_high = _to_f(bar_poke.high)
        poke_vol  = float(bar_poke.volume)
        after_cl  = _to_f(bar_after.close)
        after_vol = float(bar_after.volume)

        # Spring: пробил лой диапазона вниз, следующий бар вернулся выше лоя
        if poke_low < rng_low * 0.9995 and after_cl > rng_low:
            depth = (rng_low - poke_low) / (atr_abs or 1e-9)
            # Глубина → сила (0.3% = слабо; 1.5-2% = много стопов собрали)
            depth_mult = min(1.5, 0.6 + depth * 0.6)
            # Соотношение объёмов: return_vol > breakout_vol = агрессивный вход
            vol_ratio = after_vol / (poke_vol or 1.0)
            if vol_ratio > 1.2:
                vol_mult = min(1.4, 0.9 + vol_ratio * 0.25)
            elif vol_ratio < 0.4:
                # Объём возврата мал — ложный spring
                vol_mult = 0.4
            else:
                vol_mult = 1.0
            spring_score = min(0.85, 0.45 * depth_mult * vol_mult) / max(1, lag)
            if spring_score > score:
                score = spring_score
            break

        # Upthrust: пробил хай диапазона вверх, следующий бар вернулся ниже хая
        if poke_high > rng_high * 1.0005 and after_cl < rng_high:
            depth = (poke_high - rng_high) / (atr_abs or 1e-9)
            depth_mult = min(1.5, 0.6 + depth * 0.6)
            vol_ratio = after_vol / (poke_vol or 1.0)
            if vol_ratio > 1.2:
                vol_mult = min(1.4, 0.9 + vol_ratio * 0.25)
            elif vol_ratio < 0.4:
                vol_mult = 0.4
            else:
                vol_mult = 1.0
            ut_score = -min(0.85, 0.45 * depth_mult * vol_mult) / max(1, lag)
            # Equal Highs + Upthrust = двойная ловушка (усиление)
            prev_high_bars = candles[-_RANGE_W - 4:-_RANGE_W - 1] if len(candles) >= _RANGE_W + 4 else []
            if prev_high_bars:
                prev_rng_high = max(_to_f(c.high) for c in prev_high_bars)
                if abs(poke_high - prev_rng_high) / (prev_rng_high or 1) < 0.002:
                    ut_score *= 1.25  # sweep двойной ликвидности
            if ut_score < score:
                score = ut_score
            break

    # ── Блок 2: Тихий Spring (No Supply Test) ─────────────────────────────────
    # Касание лоя диапазона на объёме << среднего → крупняк уже набрал
    if score == 0.0:
        curr = candles[-1]
        curr_low = _to_f(curr.low)
        curr_cl  = _to_f(curr.close)
        curr_vol = float(curr.volume)
        vol_ratio_quiet = curr_vol / avg_vol
        # Цена близко к лою диапазона, закрытие выше → тест без пробоя
        near_low  = curr_low <= rng_low * 1.001 and curr_cl > rng_low
        near_high = _to_f(curr.high) >= rng_high * 0.999 and curr_cl < rng_high
        if near_low and vol_ratio_quiet < 0.30:
            # Тихий spring: аномально мало продавцов у поддержки
            score = +min(0.70, 0.50 + (0.30 - vol_ratio_quiet) * 1.5)
        elif near_high and vol_ratio_quiet < 0.30:
            # Тихий upthrust: мало покупателей у сопротивления
            score = -min(0.70, 0.50 + (0.30 - vol_ratio_quiet) * 1.5)

    # ── Блок 4: Компрессия + импульс (прежняя логика) ────────────────────────
    if score == 0.0 and len(candles) >= _COMP_BARS + 10:
        last = candles[-1]
        lh = _to_f(last.high); ll = _to_f(last.low)
        lc = _to_f(last.close)
        lrng = lh - ll or 1e-9
        last_vol_r = float(last.volume) / avg_vol

        comp_candles = candles[-_COMP_BARS - 1:-1]
        comp_ranges = [_to_f(c.high) - _to_f(c.low) for c in comp_candles]
        comp_vol_r = statistics.mean(float(c.volume) / avg_vol for c in comp_candles)
        violations = sum(1 for i in range(1, len(comp_ranges)) if comp_ranges[i] > comp_ranges[i - 1])
        is_compressing = violations <= 1 and comp_ranges[-1] < comp_ranges[0] * 0.7

        if (is_compressing and comp_vol_r >= 0.9
                and lrng >= 0.9 * atr_abs and last_vol_r >= 1.4):
            close_pos = (lc - ll) / lrng
            if close_pos >= 0.65:
                score = +min(1.0, (lrng / atr_abs) * last_vol_r * 0.4)
            elif close_pos <= 0.35:
                score = -min(1.0, (lrng / atr_abs) * last_vol_r * 0.4)

    return max(-1.0, min(1.0, score))


def score_wick_rejection(candles: list[HistoricCandle]) -> float:
    """
    Хвостовое отвержение: покупатели/продавцы систематически отвергают экстремумы.

    Логика:
    - Верхний хвост = high - max(open, close): зона, куда цена зашла но не устояла.
    - Нижний хвост = min(open, close) - low: аналогично снизу.
    - Сравниваем накопленное давление хвостов за окно:
      доминируют нижние → покупатели отталкивают цену вверх (бычий сигнал),
      доминируют верхние → продавцы давят (медвежий).
    - Усиление: тело свечи мало относительно ATR (хвост, а не тело несёт движение).
    - Объём на хвостовых барах выше среднего → отвержение значимо.
    """
    _WINDOW = _adaptive_window(candles, target_hours=2.0, min_bars=8, max_bars=80)
    if len(candles) < _WINDOW + 5:
        return 0.0
    atr_pct = _compute_atr(candles)
    if atr_pct <= 0:
        return 0.0
    last_price = _to_f(candles[-1].close)
    atr_abs = atr_pct * last_price or 1e-9

    window = candles[-_WINDOW:]
    vols = [float(c.volume) for c in window]
    avg_vol = statistics.mean(vols) or 1.0

    upper_total = 0.0
    lower_total = 0.0
    for c in window:
        h = _to_f(c.high); l = _to_f(c.low)
        o = _to_f(c.open); cl = _to_f(c.close)
        rng = h - l or 1e-9
        upper_wick = h - max(o, cl)
        lower_wick = min(o, cl) - l
        body = abs(cl - o)
        # Взвешиваем: чем меньше тело, тем значимее хвост
        body_factor = max(0.3, 1.0 - body / rng)
        # Взвешиваем на объём
        vol_w = (float(c.volume) / avg_vol) * body_factor
        upper_total += upper_wick / rng * vol_w
        lower_total += lower_wick / rng * vol_w

    total = upper_total + lower_total or 1e-9
    # Дисбаланс [-1, +1]: +1 = нижние хвосты доминируют (бычье отвержение)
    imbalance = (lower_total - upper_total) / total

    # Усиление если дисбаланс последних 3 баров совпадает с общим
    last3 = candles[-3:]
    last3_upper = sum((_to_f(c.high) - max(_to_f(c.open), _to_f(c.close))) for c in last3)
    last3_lower = sum((min(_to_f(c.open), _to_f(c.close)) - _to_f(c.low)) for c in last3)
    recent_confirm = 1.2 if (imbalance > 0 and last3_lower > last3_upper) or \
                             (imbalance < 0 and last3_upper > last3_lower) else 0.8

    return max(-1.0, min(1.0, imbalance * recent_confirm))


def score_triangle(candles: list[HistoricCandle]) -> float:
    """
    Графические треугольники: сходящиеся максимумы и минимумы.

    Три типа (классическая интерпретация):
    - Симметричный: хаи падают + лои растут → нейтральный до пробоя.
    - Восходящий: хаи горизонтальны + лои растут → бычий bias.
    - Нисходящий: хаи падают + лои горизонтальны → медвежий bias.

    КОНТЕКСТНАЯ ПЕРЕИНТЕРПРЕТАЦИЯ:
    Восходящий треугольник в нисходящем тренде — флаг распределения,
    пробой вниз с амплитудой кратно больше высоты треугольника.
    Аналогично нисходящий в аптренде — ловушка для медведей.

    ТРИ ДОПОЛНИТЕЛЬНЫХ ИЗМЕРЕНИЯ:
    1. Касания горизонтальной линии: каждый тест сопротивления/поддержки
       накапливает стопы. 4+ касания = взрывной мув при пробое.
    2. Объём на касаниях ("усилие без результата"): если на волнах к
       сопротивлению объём растёт, но цена не проходит — это VSA-признак
       дистрибуции (покупателей поглощают). Для поддержки — наоборот.
    3. Размер фигуры / дневной ATR: маленький треугольник относительно ATR =
       высокая степень сжатия = потенциал выхода кратно выше высоты паттерна.
    """
    _WINDOW = _adaptive_window(candles, target_hours=6.0, min_bars=12, max_bars=120)
    _SWING_STEP = max(2, _WINDOW // 8)
    if len(candles) < _WINDOW * 2 + 5:
        return 0.0

    window = candles[-_WINDOW:]
    highs = [_to_f(c.high) for c in window]
    lows  = [_to_f(c.low)  for c in window]
    vols  = [float(c.volume) for c in window]
    n = len(window)

    def _linreg(vals: list[float]) -> tuple[float, float]:
        xs = list(range(len(vals)))
        mx = statistics.mean(xs); my = statistics.mean(vals)
        ssxx = sum((x - mx) ** 2 for x in xs) or 1e-9
        ssyy = sum((y - my) ** 2 for y in vals) or 1e-9
        ssxy = sum((xs[i] - mx) * (vals[i] - my) for i in range(len(vals)))
        slope = ssxy / ssxx
        r2 = (ssxy ** 2) / (ssxx * ssyy)
        return slope, r2

    def _swing_highs(vals: list[float], step: int) -> list[tuple[int, float]]:
        pts = []
        for i in range(step, len(vals) - step):
            if vals[i] == max(vals[max(0, i - step):i + step + 1]):
                pts.append((i, vals[i]))
        return pts

    def _swing_lows(vals: list[float], step: int) -> list[tuple[int, float]]:
        pts = []
        for i in range(step, len(vals) - step):
            if vals[i] == min(vals[max(0, i - step):i + step + 1]):
                pts.append((i, vals[i])  )
        return pts

    sh = _swing_highs(highs, _SWING_STEP)
    sl = _swing_lows(lows, _SWING_STEP)

    if len(sh) < 2 or len(sl) < 2:
        return 0.0

    slope_h, r2_h = _linreg([p[1] for p in sh])
    slope_l, r2_l = _linreg([p[1] for p in sl])

    atr_pct = _compute_atr(candles)
    if atr_pct <= 0:
        return 0.0
    last_price = _to_f(candles[-1].close) or 1.0
    atr_abs = atr_pct * last_price
    norm = atr_abs * n

    slope_h_n = slope_h / norm * n
    slope_l_n = slope_l / norm * n

    _FLAT_THRESH = 0.15

    h_falling = slope_h_n < -_FLAT_THRESH
    h_flat    = abs(slope_h_n) <= _FLAT_THRESH
    l_rising  = slope_l_n >  _FLAT_THRESH
    l_flat    = abs(slope_l_n) <= _FLAT_THRESH

    # ── Пре-трендовый контекст ────────────────────────────────────────────────
    pre_window = candles[-(2 * _WINDOW):-_WINDOW]
    pre_closes = [_to_f(c.close) for c in pre_window]
    pre_slope_n = 0.0
    if len(pre_closes) >= 4:
        pre_s, _ = _linreg(pre_closes)
        pre_slope_n = pre_s / (atr_abs * len(pre_closes)) * len(pre_closes)
    pre_downtrend = pre_slope_n < -0.10
    pre_uptrend   = pre_slope_n >  0.10

    # ── 1. Касания горизонтальной линии ──────────────────────────────────────
    # Считаем свинговые точки, которые пришли близко к проецируемой
    # горизонтали (в пределах 0.3 ATR). Больше касаний = больше стопов накоплено.
    touch_tol = atr_abs * 0.3
    # Линия сопротивления: проецируем из sh[-1] по slope_h
    def _proj_resist(i: int) -> float:
        return sh[-1][1] + slope_h * (i - sh[-1][0])
    def _proj_support(i: int) -> float:
        return sl[-1][1] + slope_l * (i - sl[-1][0])

    resist_touches = sum(
        1 for idx, val in sh if abs(val - _proj_resist(idx)) < touch_tol
    )
    support_touches = sum(
        1 for idx, val in sl if abs(val - _proj_support(idx)) < touch_tol
    )
    # Мультипликатор: 2 касания → 1.0, 3 → 1.2, 4 → 1.4, 5+ → 1.6
    def _touch_mult(touches: int) -> float:
        return min(1.6, 1.0 + max(0, touches - 2) * 0.2)

    # ── 2. Объём на касаниях ("усилие без результата") ───────────────────────
    # Для каждой волны к горизонтальной линии считаем средний объём
    # на барах вблизи свинговой точки (±_SWING_STEP).
    # Если объём на поздних волнах выше, чем на ранних — поглощение.
    def _vol_near_touches(touches: list[tuple[int, float]]) -> list[float]:
        result = []
        for idx, _ in touches:
            lo = max(0, idx - _SWING_STEP)
            hi = min(n, idx + _SWING_STEP + 1)
            result.append(statistics.mean(vols[lo:hi]) if lo < hi else 0.0)
        return result

    resist_vols = _vol_near_touches(sh)
    support_vols = _vol_near_touches(sl)

    def _effort_without_result(touch_vols: list[float]) -> float:
        """Растёт ли объём на последовательных касаниях (поглощение)?
        +1 = объём явно растёт (дистрибуция/аккумуляция); -1 = снижается (истощение)."""
        if len(touch_vols) < 2:
            return 0.0
        early = statistics.mean(touch_vols[:len(touch_vols) // 2]) or 1.0
        late  = statistics.mean(touch_vols[len(touch_vols) // 2:]) or 1.0
        ratio = late / early
        if ratio > 1.25:
            return +1.0   # объём растёт на касаниях — поглощение
        if ratio < 0.8:
            return -1.0   # объём сухой — истощение продавцов/покупателей
        return 0.0

    resist_effort = _effort_without_result(resist_vols)   # +1 = поглощение покупателей
    support_effort = _effort_without_result(support_vols)  # +1 = поглощение продавцов

    # ── Степень схождения ─────────────────────────────────────────────────────
    range_start = highs[0] - lows[0] or 1e-9
    range_end   = highs[-1] - lows[-1]
    convergence = max(0.0, 1.0 - range_end / range_start)

    # ── 3. Размер фигуры относительно дневного ATR ───────────────────────────
    # triangle_height / atr_abs: < 0.3 → очень сжатая пружина (коэф. 1.5),
    # 0.3–0.8 → нормальный (1.0), > 0.8 → крупный паттерн (0.8).
    triangle_height = (highs[0] - lows[0]) * (1.0 - convergence * 0.5)  # средняя высота
    size_ratio = triangle_height / (atr_abs or 1.0)
    if size_ratio < 0.3:
        compression_mult = 1.5   # маленький треугольник = высокое сжатие
    elif size_ratio < 0.8:
        compression_mult = 1.0
    else:
        compression_mult = 0.8   # слишком большой — менее предсказуем

    vol_half1 = statistics.mean(vols[:n // 2]) or 1.0
    vol_half2 = statistics.mean(vols[n // 2:]) or 1.0
    vol_declining = vol_half2 < vol_half1 * 0.85

    # ── Пробой ────────────────────────────────────────────────────────────────
    last_h = _to_f(candles[-1].high); last_l = _to_f(candles[-1].low)
    last_c = _to_f(candles[-1].close)
    proj_high = sh[-1][1] + slope_h * (n - 1 - sh[-1][0])
    proj_low  = sl[-1][1] + slope_l * (n - 1 - sl[-1][0])
    breakout_up   = last_c > proj_high and last_h > proj_high
    breakout_down = last_c < proj_low  and last_l < proj_low

    vol_last = float(candles[-1].volume) / (statistics.mean(vols) or 1.0)
    breakout_vol_ok = vol_last >= 1.3

    quality = (r2_h + r2_l) / 2

    # Итоговая база: сжатие × качество × объём-фактор × сжатие-по-размеру
    def _base(declining_vol: bool) -> float:
        return convergence * quality * (1.2 if declining_vol else 0.8) * compression_mult

    score = 0.0

    if h_falling and l_rising:
        # Симметричный: нейтрален до пробоя
        touch_avg = _touch_mult((resist_touches + support_touches) // 2)
        if breakout_up and breakout_vol_ok:
            context = 1.3 if pre_uptrend else (0.6 if pre_downtrend else 1.0)
            score = +convergence * quality * context * touch_avg * compression_mult
        elif breakout_down and breakout_vol_ok:
            context = 1.3 if pre_downtrend else (0.6 if pre_uptrend else 1.0)
            score = -convergence * quality * context * touch_avg * compression_mult

    elif h_flat and l_rising:
        # Восходящий треугольник.
        # resist_effort > 0: объём растёт на касаниях сопротивления = покупателей поглощают.
        # В даунтренде это дистрибуция; в аптренде — борьба у уровня.
        base = _base(vol_declining)
        resist_tm = _touch_mult(resist_touches)
        absorption = resist_effort > 0  # объём растёт на касаниях верха

        if pre_downtrend:
            # Флаг распределения: пробой вниз взрывной
            # Если ещё и объём на касаниях растёт — поглощение подтверждает
            absorption_boost = 1.3 if absorption else 1.0
            if breakout_down and breakout_vol_ok:
                score = -min(1.0, base * 2.0 * resist_tm * absorption_boost)
            elif breakout_up and breakout_vol_ok:
                score = +min(1.0, base * 0.3)   # ложный пробой
            else:
                score = -base * 0.5 * (1.2 if absorption else 1.0)
        else:
            # Стандартное накопление
            # Если объём на касаниях снижается — истощение продавцов, пробой вверх надёжнее
            exhaustion_boost = 1.2 if resist_effort < 0 else 1.0
            if breakout_up and breakout_vol_ok:
                score = +min(1.0, base * 1.5 * resist_tm * exhaustion_boost)
            elif breakout_down and breakout_vol_ok:
                score = -min(1.0, base * 0.7)
            else:
                score = +base * 0.4 * exhaustion_boost

    elif h_falling and l_flat:
        # Нисходящий треугольник.
        base = _base(vol_declining)
        support_tm = _touch_mult(support_touches)
        absorption = support_effort > 0  # объём растёт на касаниях поддержки = продавцов поглощают

        if pre_uptrend:
            # Ловушка для медведей: пробой вверх взрывной
            absorption_boost = 1.3 if absorption else 1.0
            if breakout_up and breakout_vol_ok:
                score = +min(1.0, base * 2.0 * support_tm * absorption_boost)
            elif breakout_down and breakout_vol_ok:
                score = -min(1.0, base * 0.3)
            else:
                score = +base * 0.5 * (1.2 if absorption else 1.0)
        else:
            exhaustion_boost = 1.2 if support_effort < 0 else 1.0
            if breakout_down and breakout_vol_ok:
                score = -min(1.0, base * 1.5 * support_tm * exhaustion_boost)
            elif breakout_up and breakout_vol_ok:
                score = +min(1.0, base * 0.7)
            else:
                score = -base * 0.4 * exhaustion_boost

    return max(-1.0, min(1.0, score))


# ── Плейбуки: конъюнктивные сигналы ──────────────────────────────────────────
# Линейная взвешенная сумма (composite) хорошо агрегирует независимые сигналы,
# но теряет нелинейные эффекты: Hawkes(+0.8) + VSA(+0.7) вместе — качественно
# другое событие, не сумма. Плейбуки проверяют смысловые конъюнкции ПЕРЕД
# усреднением и при совпадении дают этой связке 60% веса в итоговом composite.
#
# Возвращает (playbook_score ∈[-1,1], список активных плейбуков).
# Если ни один не активирован — (0.0, []), тогда работает чистая линейная сумма.
def _compute_playbooks(sd: dict[str, float], regime: str,
                       sd_l2: dict[str, float] | None = None) -> tuple[float, list[str]]:
    def g(name: str) -> float:
        return sd.get(name, 0.0)

    def l2(name: str) -> float:
        """Скор метода на L2 (5м). 0.0 если L2 недоступен."""
        return (sd_l2 or {}).get(name, 0.0)

    def cross_tf_mult(name: str, d: int) -> float:
        """
        Кросс-ТФ согласованность: L1 и L2 в одну сторону → буст ×1.15,
        в разные → штраф ×0.70. Если L2 нейтрален (|v|<0.1) → нет эффекта.
        """
        v = l2(name)
        if abs(v) < 0.1:
            return 1.0
        return 1.15 if v * d > 0 else 0.70

    def conf(value: float, threshold: float) -> float:
        """Нормировка уверенности: насколько значение превышает порог.
        threshold=0.35, value=0.80 → conf=0.69. Сглаживает бинарную активацию:
        сигнал чуть выше порога весит меньше, чем чётко выраженный."""
        if threshold >= 1.0:
            return 1.0
        return min(1.0, (abs(value) - threshold) / (1.0 - threshold))

    active: list[str] = []
    scores: list[float] = []

    hawkes  = g("HAWKES_SIGNAL")
    vsa     = g("VSA")
    level   = g("LEVEL_CONTEXT")
    tq      = g("TREND_QUALITY")
    fractal = g("FRACTAL")
    vol_mom = g("VOL_MOMENTUM")
    cp      = g("CHANGE_POINT")
    oi_sq   = g("OI_SQUEEZE")
    spring  = g("SPRING")
    wick    = g("WICK_REJECTION")
    sine    = g("SINEWAVE_SIGNAL")
    mkt     = g("MKT_STRUCTURE")
    vwap    = g("VWAP_SIGNAL")
    candle_p = g("CANDLE_PATTERN")
    triangle = g("TRIANGLE")
    price_t  = g("PRICE_TREND")
    rmi      = g("RMI")
    fisher   = g("FISHER_RSI")
    multi    = g("MULTI_TICKER")
    inst_oi  = g("INST_OI")
    retail   = g("RETAIL_CONTRA")
    aggr     = g("AGGRESSOR_FLOW") or g("BS_PRESSURE_TS")

    # ── Плейбук 1: Институциональное поглощение ──────────────────────────────
    # Крупный агрессор поглощает на уровне с самоусиливающимся потоком.
    # Вероятность движения нелинейно выше суммы частей.
    if abs(hawkes) > 0.35 and abs(vsa) > 0.3 and abs(level) > 0.25:
        d = 1 if hawkes > 0 else -1
        if vsa * d > 0 and level * d > 0:
            # уверенность = среднее нормированных превышений порогов
            c = (conf(hawkes, 0.35) + conf(vsa, 0.3) + conf(level, 0.25)) / 3
            strength = (abs(hawkes) + abs(vsa) + abs(level)) / 3 * (0.5 + 0.5 * c)
            if aggr * d > 0.2:
                strength *= 1.3
            # HAWKES на 5м подтверждает — поглощение уже реальное, не шум 1м
            strength *= cross_tf_mult("HAWKES_SIGNAL", d)
            active.append("ABSORPTION")
            scores.append(d * min(1.0, strength) * 1.2)

    # ── Плейбук 2: Ложный пробой (Вайкофф) ───────────────────────────────────
    # Медведей выбило стопы, возврат от уровня. Не работает в сильном тренде.
    if abs(spring) > 0.3 and abs(wick) > 0.3:
        d = 1 if spring > 0 else -1
        if wick * d > 0 and level * d > 0:
            if abs(tq) < 0.65 or tq * d > 0:
                c = (conf(spring, 0.3) + conf(wick, 0.3)) / 2
                strength = (abs(spring) + abs(wick)) / 2 * (0.5 + 0.5 * c)
                if abs(oi_sq) > 0.15 and oi_sq * d > 0:
                    strength *= 1.2
                active.append("FAKEOUT")
                scores.append(d * min(1.0, strength))

    # ── Плейбук 3: Смена режима — первое движение ─────────────────────────────
    # CHANGE_POINT = нулевой уровень: сработал → перезапуск, не просто голос.
    # CHANGE_POINT_L2 на 5м — излом первичен, 1м лишь подтверждает.
    if abs(cp) > 0.45 and abs(sine) > 0.25:
        d = 1 if cp > 0 else -1
        if sine * d > 0 and mkt * d > 0:
            c = (conf(cp, 0.45) + conf(sine, 0.25) + conf(mkt, 0.1)) / 3
            strength = (abs(cp) + abs(sine) + abs(mkt)) / 3 * (0.5 + 0.5 * c)
            if fractal * d > 0.15:
                strength *= 1.15
            cp_l2 = l2("CHANGE_POINT_L2")
            if abs(cp_l2) > 0.3 and cp_l2 * d > 0:
                strength *= 1.20  # излом виден и на 5м — очень сильный сигнал
            active.append("REGIME_SHIFT")
            scores.append(d * min(1.0, strength) * 1.1)

    # ── Плейбук 4: Консолидация перед пробоем ────────────────────────────────
    # Нарастающее давление в треугольнике. Направление — по inst_oi vs retail.
    if abs(triangle) > 0.35 and abs(oi_sq) > 0.15:
        d = 1 if triangle > 0 else -1
        if oi_sq * d > 0:
            oi_bias = inst_oi * d + retail * d
            c = (conf(triangle, 0.35) + conf(oi_sq, 0.15)) / 2
            strength = (abs(triangle) + abs(oi_sq)) / 2 * (0.5 + 0.5 * c)
            if oi_bias > 0.1:
                strength *= 1.15
            active.append("CONSOLIDATION_BREAK")
            scores.append(d * min(1.0, strength) * 0.9)

    # ── Плейбук 5: Трендовое продолжение на откате ───────────────────────────
    # Здоровый тренд (фрактал + TQ), откат слабый по объёму, свечной сигнал.
    # TQ и FRACTAL на L2 (5м) — более надёжная оценка тренда чем 1м.
    tq_l2  = l2("TREND_QUALITY")
    frac_l2 = l2("FRACTAL")
    if tq > 0.5 and fractal > 0.1 and vwap < 0.15 and 0.0 < vol_mom < 0.35 and candle_p > 0.2:
        c = (conf(tq, 0.5) + conf(fractal, 0.1) + conf(candle_p, 0.2)) / 3
        strength = (tq + fractal + candle_p) / 3 * (0.5 + 0.5 * c)
        # Если L2 тоже бычий — тренд реален, не только на 1м-шуме
        if tq_l2 > 0.3:
            strength *= 1.15
        elif tq_l2 < -0.2:
            strength *= 0.65  # L2 против L3-тренда — ослабляем
        active.append("TREND_PULLBACK_L")
        scores.append(min(1.0, strength) * 0.85)
    elif tq < -0.5 and fractal > 0.1 and vwap > -0.15 and -0.35 < vol_mom < 0.0 and candle_p < -0.2:
        c = (conf(tq, 0.5) + conf(fractal, 0.1) + conf(candle_p, 0.2)) / 3
        strength = (abs(tq) + fractal + abs(candle_p)) / 3 * (0.5 + 0.5 * c)
        if tq_l2 < -0.3:
            strength *= 1.15
        elif tq_l2 > 0.2:
            strength *= 0.65
        active.append("TREND_PULLBACK_S")
        scores.append(-min(1.0, strength) * 0.85)

    # ── Плейбук 6: Дивергенция истощения (контртрендовый) ────────────────────
    # Движение "на пустышке": без агрессии и объёма, осциллятор перегрет,
    # корреляты не подтверждают. Меньший размер — поэтому cap 0.7.
    if abs(price_t) > 0.45 and abs(vol_mom) < 0.2 and abs(hawkes) < 0.25:
        d = 1 if price_t > 0 else -1
        osc_extreme = (rmi * d < -0.35) or (fisher * d < -0.35)
        multi_disagrees = multi != 0.0 and multi * d < 0
        if osc_extreme and vol_mom * d < 0.05:
            c = conf(price_t, 0.45)
            strength = abs(price_t) * 0.55 * (0.5 + 0.5 * c)
            if multi_disagrees:
                strength *= 1.2
            active.append("EXHAUSTION_DIV")
            scores.append(-d * min(0.7, strength))

    # ── Плейбук 7: ОИ-консенсус ──────────────────────────────────────────────
    # Несколько ОИ-признаков сложились в одну сторону = качественно другое
    # событие, чем один сильный (юр/физ картина согласована по всем срезам).
    # Требование: ≥3 активных (|s|≥0.15) из 5 ОИ-скоров одного знака и НИ
    # ОДНОГО активного против. Буст скромный (cap 0.6): все пять считаются из
    # ОДНОГО FutOI-снэпшота — это не пять независимых свидетелей, а пять
    # взглядов на одну таблицу (INST_OI и RETAIL_CONTRA почти дублируются).
    # Как плейбук получает статистику по режимам и авто-отключение бесплатно.
    oi_votes = [g(n) for n in ("OI_SQUEEZE", "INST_OI", "RETAIL_CONTRA",
                               "DELTA_QUADRANT", "OI_ABSORPTION")]
    oi_active = [v for v in oi_votes if abs(v) >= 0.15]
    if len(oi_active) >= 3:
        pos_n = sum(1 for v in oi_active if v > 0)
        neg_n = len(oi_active) - pos_n
        if pos_n == 0 or neg_n == 0:
            d = 1 if pos_n else -1
            avg_str = sum(abs(v) for v in oi_active) / len(oi_active)
            # 3 признака → ×1.0, 4 → ×1.15, 5 → ×1.3
            count_mult = 1.0 + 0.15 * (len(oi_active) - 3)
            active.append("OI_CONSENSUS")
            scores.append(d * min(0.6, avg_str * count_mult))

    if not scores:
        return 0.0, []

    # Конфликт плейбуков (разные направления) = неопределённость → ослабление.
    pos = sum(1 for s in scores if s > 0)
    neg = sum(1 for s in scores if s < 0)
    if pos > 0 and neg > 0:
        net = sum(scores)
        if abs(net) < 0.15:
            return 0.0, active
        return max(-1.0, min(1.0, net * 0.35)), active

    return max(-1.0, min(1.0, sum(scores) / len(scores))), active


# ── Дивергентный мета-сигнал ──────────────────────────────────────────────────
# Отдельно от плейбуков: измеряет расхождение между трендовой и объёмной группой.
# Если цена делает экстремум, а объём/агрессия угасают — дивергенция сильнее
# нейтрального скора, который получается при простом суммировании.
def _divergence_score(sd: dict[str, float]) -> float:
    """
    Возвращает скор дивергенции ∈[-1,1].
    Положительный = цена падает, но объём бычий (скрытое накопление).
    Отрицательный = цена растёт, но объём медвежий (скрытое распределение).
    0.0 = нет значимой дивергенции.
    """
    def g(n: str) -> float:
        return sd.get(n, 0.0)

    trend_sign = (g("PRICE_TREND") + g("TREND_QUALITY") + g("ZLEMA_SIGNAL")) / 3
    vol_sign   = (g("VOL_MOMENTUM") + g("KLINGER") + g("VZO")) / 3

    if abs(trend_sign) < 0.15 or abs(vol_sign) < 0.1:
        return 0.0  # обе группы нейтральны — не дивергенция

    # Дивергенция: знаки противоположны
    if trend_sign * vol_sign < 0:
        # сила дивергенции = среднее абсолютных значений × направление (по объёму)
        magnitude = (abs(trend_sign) + abs(vol_sign)) / 2
        return max(-1.0, min(1.0, (1 if vol_sign > 0 else -1) * magnitude * 0.7))
    return 0.0


def score_price_accel(candles: list[HistoricCandle]) -> float:
    """
    Ускорение/замедление ценового движения.

    Смотрит на то как меняется скорость баров, а не их направление.
    Скорость бара = знак × |close - open| / price (направленное тело в %).

    Acceleration = текущая скорость vs средняя скорость предыдущих N баров.
    Jerk = изменение ускорения (2-я производная).

    Сигналы:
    > 0: движение ускоряется в бычью сторону (или замедляется медвежье) → бычий.
    < 0: движение ускоряется в медвежью сторону → медвежий.

    Применения:
    - Нарастающие бычьи бары → тренд развивается, входить по тренду.
    - Нарастающие медвежьи бары → каскад ускоряется, ждать разворота.
    - Затухающие бары в сторону тренда → истощение, риск разворота.

    Нормируется через tanh чтобы не быть слишком чувствительным к масштабу.
    """
    _WIN = _adaptive_window(candles, target_hours=0.75, min_bars=6, max_bars=40)
    if len(candles) < _WIN + 5:
        return 0.0

    price_ref = _to_f(candles[-1].close) or 1.0

    # Скорость каждого бара: знак × тело / цена
    def bar_velocity(c) -> float:
        cl, op = _to_f(c.close), _to_f(c.open)
        return (cl - op) / price_ref

    window = candles[-_WIN - 1:]
    velocities = [bar_velocity(c) for c in window]

    if len(velocities) < 4:
        return 0.0

    # Средняя скорость окна (без последнего бара)
    avg_v = statistics.mean(velocities[:-1])
    curr_v = velocities[-1]

    # Ускорение: текущий vs средний
    accel = curr_v - avg_v

    # Jerk: последние 3 скорости — растёт ли ускорение?
    if len(velocities) >= 5:
        v_recent = velocities[-3:]
        dv = [v_recent[i+1] - v_recent[i] for i in range(len(v_recent)-1)]
        jerk = dv[-1] - dv[0] if len(dv) >= 2 else 0.0
    else:
        jerk = 0.0

    # Итоговый сигнал: ускорение + слабый вклад jerk
    raw = accel + jerk * 0.3
    # Масштаб: типичное тело ~0.1-0.3% → нормируем на 0.002
    norm = math.tanh(raw / (0.002 or 1e-9))
    return round(max(-1.0, min(1.0, norm)), 4)


def score_cumul_delta(candles: list[HistoricCandle]) -> float:
    """
    Накопленный tick-flow (Order Flow): сумма направленного объёма за N баров.

    Прокси tick_flow на баре = объём × знак(close - open).
    Накопленная дельта показывает кто доминирует в агрессии суммарно —
    не за один бар, а за последний час/полтора.

    Нормируется на диапазон [min..max] накопленной дельты в окне,
    чтобы сигнал был ∈ [-1, 1] и сравним между инструментами.

    >0: покупатели накапливают агрессию → бычий.
    <0: продавцы накапливают → медвежий.
    Уклон к нулю в середине окна = рынок двусторонний (AMT balance).
    """
    _WIN = _adaptive_window(candles, target_hours=1.5, min_bars=15, max_bars=90)
    if len(candles) < _WIN + 5:
        return 0.0

    window = candles[-_WIN:]
    deltas = []
    cum = 0.0
    for c in window:
        vol = float(c.volume)
        cl, op = _to_f(c.close), _to_f(c.open)
        sign = 1.0 if cl >= op else -1.0
        # масштабируем на body_frac чтобы дожи почти не давали вклад
        body_frac = abs(cl - op) / ((_to_f(c.high) - _to_f(c.low)) or 1e-9)
        cum += vol * sign * min(1.0, body_frac * 2)
        deltas.append(cum)

    if not deltas:
        return 0.0
    mn, mx = min(deltas), max(deltas)
    rng = mx - mn
    if rng < 1e-9:
        return 0.0
    # нормируем: текущее значение в диапазоне окна
    norm = (deltas[-1] - mn) / rng * 2 - 1   # [-1..1]
    # бонус: если дельта растёт последние 3 бара — усиливаем сигнал
    if len(deltas) >= 4:
        recent_trend = (deltas[-1] - deltas[-4]) / (rng or 1e-9)
        norm = max(-1.0, min(1.0, norm + recent_trend * 0.3))
    return round(norm, 4)


def score_amt_poc(candles: list[HistoricCandle]) -> float:
    """
    Volume Profile — нестандартное применение по документу.

    Пять компонентов:

    1. POC-дрейф (термометр накопления): POC медленно ползёт вверх/вниз
       за 5 «сессий» — скрытое накопление/распределение, опережает цену.

    2. CHoCH на объёме: POC вчерашней сессии меняет роль — если цена
       пробила его вверх и держит = поддержка (бычий); пробила и упала
       обратно = перевёртыш, POC стал сопротивлением (медвежий).

    3. Расстояние цена→POC в ATR-зонах:
       < 0.5 ATR → нейтраль (рынок у баланса)
       1–2 ATR  → резинка натянута, тяготение обратно к POC
       > 3 ATR  → экстремум, каскад заканчивается ИЛИ начинается режим

    4. LVN-карман: пустая зона (< 20% avg-бина) выше/ниже текущей цены
       — ускоритель, нет сопротивления до следующего HVN.

    5. Позиция внутри/вне Value Area (базовый сигнал, как раньше).
    """
    _WIN = _adaptive_window(candles, target_hours=4.0, min_bars=20, max_bars=240)
    if len(candles) < max(30, _WIN // 2):
        return 0.0

    atr = _compute_atr(candles)
    if atr <= 0:
        return 0.0
    cl_now = _to_f(candles[-1].close)
    atr_abs = atr * (cl_now or 1.0)

    # ── Текущая сессия ─────────────────────────────────────────────────────────
    window = candles[-_WIN:]
    highs = [_to_f(c.high) for c in window]
    lows  = [_to_f(c.low)  for c in window]
    vols  = [float(c.volume) for c in window]

    poc, vah, val, bins, price_lo, bin_size = volume_profile(highs, lows, vols, n_bins=48)
    if poc <= 0 or bin_size <= 0:
        return 0.0

    n_bins = len(bins)
    avg_bin = (sum(bins) / n_bins) or 1e-9

    # ── Компонент 1: POC-дрейф за 5 сессий ────────────────────────────────────
    # Делим доступную историю на 5 равных кусков, считаем POC каждого.
    poc_drift_score = 0.0
    chunk_size = min(_WIN, len(candles) // 5)
    if chunk_size >= 10:
        poc_series = []
        for i in range(5):
            slc = candles[-(5 - i) * chunk_size: -(4 - i) * chunk_size or len(candles)]
            if len(slc) < 5:
                continue
            ph = [_to_f(c.high) for c in slc]
            pl = [_to_f(c.low) for c in slc]
            pv = [float(c.volume) for c in slc]
            p, *_ = volume_profile(ph, pl, pv, n_bins=24)
            if p > 0:
                poc_series.append(p)
        if len(poc_series) >= 3:
            # Линейный уклон POC — нормируем на ATR
            xs = list(range(len(poc_series)))
            mx = sum(xs) / len(xs)
            my = sum(poc_series) / len(poc_series)
            slope_num = sum((xs[i] - mx) * (poc_series[i] - my) for i in range(len(xs)))
            slope_den = sum((x - mx) ** 2 for x in xs) or 1e-9
            slope = slope_num / slope_den  # цена/период
            # Нормируем: сколько ATR в среднем движется POC за период
            drift_atr = slope / (atr_abs or 1e-9)
            # 0.05 ATR/период = умеренное накопление; 0.15+ = сильное
            poc_drift_score = max(-0.5, min(0.5, drift_atr * 4.0))

    # ── Компонент 2: CHoCH на объёме ──────────────────────────────────────────
    # «Прошлый» POC = POC предыдущей сессии (второй кусок с конца).
    choch_score = 0.0
    if chunk_size >= 10 and len(candles) >= chunk_size * 2:
        prev_slc = candles[-2 * chunk_size:-chunk_size]
        ph2 = [_to_f(c.high) for c in prev_slc]
        pl2 = [_to_f(c.low) for c in prev_slc]
        pv2 = [float(c.volume) for c in prev_slc]
        prev_poc, *_ = volume_profile(ph2, pl2, pv2, n_bins=24)
        if prev_poc > 0:
            dist_prev = cl_now - prev_poc
            # Цена выше прошлого POC → тест как поддержки?
            if 0 < dist_prev < 0.5 * atr_abs:
                # Цена вернулась почти к prev_poc снизу → держит = бычий
                choch_score = +0.35
            elif -0.5 * atr_abs < dist_prev < 0:
                # Пробила вниз и вернулась → держит сверху = медвежий CHoCH
                choch_score = -0.35
            elif dist_prev < -atr_abs:
                # Далеко ниже прошлого POC — структура сломана, медвежий
                choch_score = -0.20
            elif dist_prev > atr_abs:
                # Далеко выше — принятие нового уровня, бычий
                choch_score = +0.20

    # ── Компонент 3: расстояние цена→POC в ATR-зонах ─────────────────────────
    dist_poc = cl_now - poc
    dist_atr = abs(dist_poc) / (atr_abs or 1e-9)
    dist_sign = 1 if dist_poc >= 0 else -1

    if dist_atr < 0.5:
        # У баланса — нейтраль
        dist_score = 0.0
    elif dist_atr <= 2.0:
        # Резинка: тяготение обратно к POC (сигнал ПРОТИВ текущего удаления)
        dist_score = -dist_sign * min(0.35, (dist_atr - 0.5) * 0.20)
    elif dist_atr <= 3.0:
        # Ещё не экстремум, но далеко — слабый против
        dist_score = -dist_sign * 0.25
    else:
        # > 3 ATR: экстремум — либо каскад истощается (контрарный),
        # либо новый режим (сигнал слабый, нужны другие подтверждения)
        dist_score = -dist_sign * 0.40

    # ── Компонент 4: LVN-карман выше/ниже (ускоритель) ───────────────────────
    lvn_score = 0.0
    # Ищем зону LVN (< 20% avg_bin) в 1–2 ATR над/под ценой
    if bin_size > 0:
        search_bins = max(1, int(2.0 * atr_abs / bin_size))
        curr_bin = max(0, min(n_bins - 1, int((cl_now - price_lo) / bin_size)))

        # Над ценой
        above_end = min(n_bins, curr_bin + search_bins + 1)
        above_zone = bins[curr_bin + 1:above_end] if curr_bin + 1 < n_bins else []
        if above_zone and (sum(above_zone) / len(above_zone)) < 0.20 * avg_bin:
            lvn_score += 0.25   # воздушный карман вверх — ускоритель бычий

        # Под ценой
        below_start = max(0, curr_bin - search_bins)
        below_zone = bins[below_start:curr_bin] if curr_bin > 0 else []
        if below_zone and (sum(below_zone) / len(below_zone)) < 0.20 * avg_bin:
            lvn_score -= 0.25   # воздушный карман вниз — ускоритель медвежий

    # ── Компонент 5: базовая позиция VA (как раньше, уменьшен вес) ───────────
    va_score = 0.0
    if cl_now > vah:
        va_strength = min(0.5, (cl_now - vah) / (atr_abs or 1e-9) * 0.4)
        va_score = 0.25 + va_strength
    elif cl_now < val:
        va_strength = min(0.5, (val - cl_now) / (atr_abs or 1e-9) * 0.4)
        va_score = -(0.25 + va_strength)
    elif cl_now > poc:
        va_score = 0.15 * (cl_now - poc) / ((vah - poc) or 1e-9)
    else:
        va_score = -0.15 * (poc - cl_now) / ((poc - val) or 1e-9)

    # ── Итог: взвешенная сумма ─────────────────────────────────────────────────
    # Веса: дрейф POC и CHoCH — самые «редкие» и ценные сигналы.
    # dist_score контрарный → не перевешивает трендовые компоненты.
    total = (
        poc_drift_score * 0.30 +
        choch_score     * 0.25 +
        dist_score      * 0.20 +
        lvn_score       * 0.15 +
        va_score        * 0.10
    )
    return round(max(-1.0, min(1.0, total)), 4)


def score_vsa_absorption(candles: list[HistoricCandle]) -> float:
    """
    VSA-поглощение (Absorption / Effort without Result).

    Распознаёт бары где объём сильно выше среднего, но ценовой диапазон
    непропорционально мал — крупный участник поглощает давление противоположной стороны.

    Поглощение продаж (бычий):
      - большой объём (>2× средний)
      - маленький спред (< 0.6× средний)
      - закрытие в верхней половине бара
      - на нисходящем движении (3-5 баров до)
      → продавцы выдыхаются, покупатели поглощают

    Поглощение покупок (медвежий):
      - те же условия по объёму/спреду
      - закрытие в нижней половине
      - на восходящем движении
      → покупатели поглощаются, скоро разворот

    Сила сигнала пропорциональна: (vol_ratio - 2) × (1 - spread_ratio).
    """
    _TREND_W = _adaptive_window(candles, target_hours=0.5, min_bars=5, max_bars=30)
    if len(candles) < _TREND_W + 10:
        return 0.0

    # Базовые параметры текущего бара
    last = candles[-1]
    lh, ll = _to_f(last.high), _to_f(last.low)
    lo_, lc = _to_f(last.open), _to_f(last.close)
    spread = lh - ll or 1e-9
    close_pos = (lc - ll) / spread

    vols = [float(c.volume) for c in candles[-20:]]
    spreads = [_to_f(c.high) - _to_f(c.low) for c in candles[-10:-1]]
    avg_vol = statistics.mean(vols[:-1]) or 1.0
    avg_spread = statistics.mean(spreads) or 1e-9

    vol_ratio = float(last.volume) / avg_vol
    spread_ratio = spread / avg_spread

    # Поглощение: аномальный объём + аномально маленький ход
    if vol_ratio < 1.8 or spread_ratio > 0.7:
        return 0.0

    # Предшествующий тренд
    trend_closes = [_to_f(c.close) for c in candles[-_TREND_W - 1:-1]]
    trend = (trend_closes[-1] - trend_closes[0]) / (abs(trend_closes[0]) or 1.0)

    # Сила поглощения
    strength = min(1.0, (vol_ratio - 1.8) * 0.5) * (1.0 - min(0.7, spread_ratio)) / 0.7

    if close_pos >= 0.5 and trend < -0.001:
        # Поглощение продаж → бычий
        return round(min(1.0, strength * 0.9), 4)
    elif close_pos < 0.5 and trend > 0.001:
        # Поглощение покупок → медвежий
        return round(-min(1.0, strength * 0.9), 4)
    return 0.0


def score_cascade(candles: list[HistoricCandle]) -> float:
    """
    Ликвидационный каскад — немедленный контрарный сигнал на аномальном баре.

    Принцип: каскадный бар истощает одну сторону (маржин-коллы / стоп-хант).
    Лучший вход — сразу после него, не через 1-5 баров «подтверждения».
    Ждать начала отскока = терять половину движения.

    Три признака каскадного бара (достаточно двух из трёх):
      1. vol_ratio > 2.5× среднего за 20 баров
      2. body_ratio > 1.8× среднего тела + закрытие у экстремума (< 20% или > 80%)
      3. Прокол-ловушка: хвост > 55% диапазона + закрытие против хвоста

    Сила сигнала:
      — Прокол (spike): ±0.75 — цена уже вернулась внутрь бара, разворот встроен
      — Тело + аномальный объём: ±0.55
      — Одиночный критерий (объём или тело): ±0.35 (слабее, только два из трёх не набралось)
    Дополнительно усиливается пропорционально vol_ratio сверх порога (до ×1.3).

    Ретроспективный lookback убран: к моменту «подтверждения» 1-5 баров спустя
    вход уже опоздал, а голосование в направлении каскада против начавшегося
    отскока — ошибочная логика.
    """
    if len(candles) < 20:
        return 0.0

    vols = [float(c.volume) for c in candles]
    avg_vol = statistics.mean(vols[-20:-1]) or 1.0

    bodies = [abs(_to_f(c.close) - _to_f(c.open)) for c in candles[-15:-1]]
    avg_body = statistics.mean(bodies) or 1e-9

    c = candles[-1]
    h, lo, op, cl = _to_f(c.high), _to_f(c.low), _to_f(c.open), _to_f(c.close)
    rng = h - lo or 1e-9
    body = abs(cl - op)
    close_pos = (cl - lo) / rng
    vol_r = float(c.volume) / avg_vol
    body_r = body / avg_body

    upper_wick = (h - max(op, cl)) / rng
    lower_wick = (min(op, cl) - lo) / rng
    spike_up = upper_wick > 0.55 and close_pos < 0.45   # стоп-хант вверх + возврат → медвежий паттерн
    spike_dn = lower_wick > 0.55 and close_pos > 0.55   # стоп-хант вниз + возврат → бычий паттерн

    crit_vol  = vol_r > 2.5
    crit_body = body_r > 1.8 and (close_pos < 0.2 or close_pos > 0.8)
    crit_spike = spike_up or spike_dn

    n_criteria = sum([crit_vol, crit_body, crit_spike])
    if n_criteria < 2:
        return 0.0

    # Направление против каскада
    if spike_up:
        direction = -1   # прокол вверх → идти вниз
    elif spike_dn:
        direction = +1   # прокол вниз → идти вверх
    else:
        direction = -1 if cl >= op else +1   # против тела каскада

    # Сила: прокол надёжнее тела (разворот уже виден внутри бара)
    if crit_spike:
        base = 0.75
    elif crit_vol and crit_body:
        base = 0.55
    else:
        base = 0.35

    # Усиление за экстремальный объём (vol_r >> 2.5 — не шум, а реальная паника)
    vol_boost = min(1.3, 1.0 + max(0.0, vol_r - 2.5) * 0.1)

    return round(direction * base * vol_boost, 4)


def score_impulse_pullback(candles: list[HistoricCandle]) -> float:
    """
    IMPULSE_PULLBACK: откат vs разворот — три оси различия.

    Откат (продолжение тренда):
      - объём на откате < объёма импульса (никто не мешает)
      - глубина отката < 38% размера импульса (HL держится)
      - No Supply на дне: последние бары отката — убывающий объём + закрытие
        выше 50% диапазона (покупатели поглощают без усилий)

    Разворот (против импульса):
      - объём на откате > 65% объёма импульса (агрессивное давление)
      - глубина > 62% (CHoCH: пробой предыдущего HL/LH)
      - возобновление слабее отката по объёму

    Нейтраль: глубина 38–62%, объём умеренный → 0.

    Сигнал:
      Откат + No Supply → +0.45..+0.75 (лучшая точка входа в тренд)
      Разворот слабый возобновление → −0.55..−0.85
      Промежуточные зоны — пропорционально.
    """
    if len(candles) < 15:
        return 0.0
    try:
        atr = _compute_atr(candles)

        win = candles[-28:]
        n   = len(win)
        closes = [_to_f(c.close) for c in win]
        highs  = [_to_f(c.high)  for c in win]
        lows   = [_to_f(c.low)   for c in win]
        vols   = [float(c.volume) for c in win]

        overall = closes[-1] - closes[0]
        if abs(overall) < 1e-9:
            return 0.0
        imp_dir = 1 if overall > 0 else -1

        # Свинг-точка: граница импульс → откат
        search = range(2, n - 3)
        if imp_dir > 0:
            swing_idx = max(search, key=lambda i: closes[i])
            if closes[-1] >= closes[swing_idx]:
                return 0.0
            impulse_range = closes[swing_idx] - closes[0]
            pullback_depth = closes[swing_idx] - closes[-1]
        else:
            swing_idx = min(search, key=lambda i: closes[i])
            if closes[-1] <= closes[swing_idx]:
                return 0.0
            impulse_range = closes[0] - closes[swing_idx]
            pullback_depth = closes[-1] - closes[swing_idx]

        if impulse_range <= 0:
            return 0.0

        depth_ratio = pullback_depth / impulse_range  # 0..1+

        # Объёмные фазы
        imp_vols = vols[:swing_idx + 1]
        pb_vols  = vols[swing_idx:]
        if len(imp_vols) < 2 or len(pb_vols) < 2:
            return 0.0

        imp_avg = sum(imp_vols) / len(imp_vols)
        pb_avg  = sum(pb_vols)  / len(pb_vols)
        vol_ratio = pb_avg / (imp_avg or 1e-9)

        # ── No Supply: дно отката на убывающем объёме + закрытие выше середины ──
        # Последние 3 бара фазы отката
        last_pb = win[swing_idx:][-3:]
        no_supply = False
        if len(last_pb) >= 2:
            pb_tail_vols = [float(c.volume) for c in last_pb]
            vol_falling = pb_tail_vols[-1] < pb_tail_vols[0] * 0.75
            last_c = last_pb[-1]
            lc_ = _to_f(last_c.close)
            lh_ = _to_f(last_c.high)
            ll_ = _to_f(last_c.low)
            close_pos = (lc_ - ll_) / (lh_ - ll_ or 1e-9)
            # Закрытие выше 50% диапазона свечи = покупатели поглощают
            no_supply = vol_falling and close_pos > 0.50

        # ── HL integrity: предыдущий HL (или LH) не пробит ──
        # Для бычьего: предыдущее дно импульса (closes[0]) — если откат не ушёл ниже
        if imp_dir > 0:
            prev_hl = min(closes[:swing_idx + 1])
            hl_intact = closes[-1] > prev_hl - 0.3 * atr
        else:
            prev_lh = max(closes[:swing_idx + 1])
            hl_intact = closes[-1] < prev_lh + 0.3 * atr

        # ── Возобновляющие бары (в направлении импульса после свинга) ──
        resuming_vols = [
            vols[i] for i in range(swing_idx, n)
            if i > 0 and (
                closes[i] > closes[i - 1] if imp_dir > 0 else closes[i] < closes[i - 1]
            )
        ]
        resume_avg = sum(resuming_vols) / len(resuming_vols) if resuming_vols else 0.0
        resumption_weak = resume_avg < pb_avg * 0.80 if resuming_vols else True

        # ══ Классификация ════════════════════════════════════════════════════

        # 1. Здоровый HL-откат → продолжение в направлении импульса
        if depth_ratio < 0.38 and vol_ratio < 0.50 and hl_intact:
            base = 0.45
            if no_supply:
                base += 0.20   # No Supply = лучшая точка входа
            if vol_ratio < 0.25:
                base += 0.10   # совсем тихий откат
            return round(imp_dir * min(0.75, base), 4)

        # 2. Умеренный откат, HL держится → слабый сигнал продолжения
        if depth_ratio < 0.50 and vol_ratio < 0.65 and hl_intact:
            base = 0.20
            if no_supply:
                base += 0.15
            return round(imp_dir * base, 4)

        # 3. Нейтральная зона — ничего не говорим
        if 0.38 <= depth_ratio <= 0.62 and 0.40 <= vol_ratio <= 0.70:
            return 0.0

        # 4. Глубокий откат + агрессивный объём → разворот
        if depth_ratio > 0.62 and vol_ratio > 0.65:
            excess = min(1.0, (vol_ratio - 0.65) / 0.35)
            if resumption_weak:
                # Возобновление слабее отката — разворот подтверждён
                return round(-imp_dir * min(0.85, 0.55 + excess * 0.30), 4)
            else:
                return round(-imp_dir * (0.35 + excess * 0.20), 4)

        # 5. HL пробит (CHoCH) при любом объёме → против импульса
        if not hl_intact:
            choch_strength = min(0.65, 0.35 + depth_ratio * 0.20)
            return round(-imp_dir * choch_strength, 4)

        # 6. Агрессивный объём без глубины — давление против, но HL держится
        if vol_ratio > 0.65 and depth_ratio < 0.38:
            excess = min(1.0, (vol_ratio - 0.65) / 0.35)
            if resumption_weak:
                return round(-imp_dir * (0.30 + excess * 0.20), 4)
            else:
                # Возобновление сильнее → откат поглощён, продолжение
                return round(imp_dir * 0.20, 4)

        return 0.0
    except Exception:
        return 0.0


def score_waning_impulses(candles: list[HistoricCandle]) -> float:
    """
    WANING_IMPULSES: затухающие импульсы — три признака одновременно:
      1. Объём на последовательных импульсных волнах убывает.
      2. Откаты становятся пропорционально больше от волны к волне.
      3. На последнем (третьем) импульсе — длинная тень в направлении движения
         (пробная агрессия, которую никто не поддержал).

    Сигнал: истощение текущего движения → разворот ближе.
    Возвращает score против направления последнего движения (от -0.3 до -0.85).
    При отсутствии паттерна → 0.0.

    Алгоритм:
    - Делим последние 60 баров на импульс-откат-импульс-откат-импульс
      через последовательные локальные экстремумы (свинги).
    - Требуем не менее 3 импульсных фаз.
    - Проверяем убывание среднего объёма волн и рост относительного размера откатов.
    - Дополнительный балл за длинную тень на последнем баре в направлении тренда.
    """
    if len(candles) < 30:
        return 0.0

    win = candles[-60:]
    closes = [_to_f(c.close) for c in win]
    highs  = [_to_f(c.high)  for c in win]
    lows   = [_to_f(c.low)   for c in win]
    vols   = [float(c.volume) for c in win]
    n = len(win)

    overall = closes[-1] - closes[0]
    if abs(overall) < 1e-9:
        return 0.0
    trend_dir = 1 if overall > 0 else -1

    # Находим свинг-точки (локальные экстремумы с окном ±3)
    SW = 3
    swings = []   # (idx, price, kind) — kind: 'peak' | 'trough'
    for i in range(SW, n - SW):
        hi = all(highs[i] >= highs[j] for j in range(i - SW, i + SW + 1) if j != i)
        lo = all(lows[i]  <= lows[j]  for j in range(i - SW, i + SW + 1) if j != i)
        if hi:
            swings.append((i, highs[i], 'peak'))
        elif lo:
            swings.append((i, lows[i], 'trough'))

    if len(swings) < 4:
        return 0.0

    # Фильтруем: чередующиеся peak/trough
    alt = [swings[0]]
    for s in swings[1:]:
        if s[2] != alt[-1][2]:
            alt.append(s)
    if len(alt) < 4:
        return 0.0

    # Собираем фазы: импульс = движение по тренду, откат = против тренда
    impulse_vols = []   # средний объём i-го импульса
    pullback_sizes = [] # относительный размер i-го отката / предшествующего импульса

    for i in range(len(alt) - 1):
        a, b = alt[i], alt[i + 1]
        seg_vols = vols[a[0]:b[0] + 1]
        if not seg_vols:
            continue
        avg_v = sum(seg_vols) / len(seg_vols)
        price_move = abs(b[1] - a[1])

        is_impulse = (trend_dir > 0 and b[2] == 'peak') or (trend_dir < 0 and b[2] == 'trough')
        if is_impulse:
            impulse_vols.append((avg_v, price_move))
        else:
            if impulse_vols:
                prev_imp_move = impulse_vols[-1][1]
                rel = price_move / (prev_imp_move or 1e-9)
                pullback_sizes.append(rel)

    if len(impulse_vols) < 3 or len(pullback_sizes) < 2:
        return 0.0

    # Признак 1: убывание объёма на импульсах
    imp_vs = [v for v, _ in impulse_vols[-3:]]
    vol_decay = (imp_vs[0] - imp_vs[-1]) / (imp_vs[0] or 1e-9)
    # vol_decay > 0 = убывание; <0 = нарастание (паттерн не тот)
    if vol_decay <= 0:
        return 0.0

    # Признак 2: рост относительного размера откатов
    pb = pullback_sizes[-min(2, len(pullback_sizes)):]
    pb_growing = len(pb) < 2 or pb[-1] >= pb[0] * 0.85  # допуск 15%

    # Признак 3: длинная тень последнего бара в направлении тренда
    last = win[-1]
    body = abs(_to_f(last.close) - _to_f(last.open))
    if trend_dir > 0:
        upper_wick = _to_f(last.high) - max(_to_f(last.close), _to_f(last.open))
        tail_ratio = upper_wick / (body or 1e-9)
    else:
        lower_wick = min(_to_f(last.close), _to_f(last.open)) - _to_f(last.low)
        tail_ratio = lower_wick / (body or 1e-9)
    has_exhaustion_wick = tail_ratio > 1.5

    # Итоговый сигнал против текущего тренда
    strength = min(1.0, vol_decay * 2.0)   # 0..1
    base = 0.30 + strength * 0.40          # 0.30..0.70
    if pb_growing:
        base = min(0.85, base + 0.15)
    if has_exhaustion_wick:
        base = min(0.85, base + 0.10)

    return round(-trend_dir * base, 4)


def score_vol_compression(candles: list[HistoricCandle]) -> float:
    """
    VOL_COMPRESSION: сужение ценового диапазона при сохранении/нарастании объёма.

    Это накопление или распределение в компрессии. Чем дольше и плотнее —
    тем резче выход. Направление определяется первым импульсом на пробое
    (этот метод сам по себе не даёт направление — возвращает 0 пока
    нет пробоя; после пробоя усиливает сигнал в его сторону).

    Логика:
    - ATR последних 10 баров vs ATR предыдущих 20 — если ATR сжался >30%
      при объёме ≥ 80% от среднего за 30 баров → компрессия активна.
    - Пробой: последний бар выходит за диапазон сжатия с объёмом > 120% среднего.
    - До пробоя: 0.0. После пробоя: +0.4..+0.75 в сторону пробоя.
    """
    if len(candles) < 35:
        return 0.0

    def _atr(cs):
        tr = []
        for i in range(1, len(cs)):
            h, l, pc = _to_f(cs[i].high), _to_f(cs[i].low), _to_f(cs[i - 1].close)
            tr.append(max(h - l, abs(h - pc), abs(l - pc)))
        return sum(tr) / len(tr) if tr else 0.0

    recent_atr  = _atr(candles[-11:])   # последние 10 баров
    base_atr    = _atr(candles[-31:-10]) # предыдущие 20 баров
    if base_atr < 1e-9:
        return 0.0
    compression_ratio = recent_atr / base_atr  # <1 = сжатие

    if compression_ratio > 0.72:  # сжатие меньше 28% — не компрессия
        return 0.0

    avg_vol_30 = sum(float(c.volume) for c in candles[-30:]) / 30
    avg_vol_10 = sum(float(c.volume) for c in candles[-10:]) / 10
    vol_sustain = avg_vol_10 / (avg_vol_30 or 1e-9)

    if vol_sustain < 0.75:  # объём просел — просто тихий рынок, не компрессия
        return 0.0

    # Граница компрессионного диапазона
    comp_candles = candles[-12:-1]  # последние 10 баров без текущего
    comp_high = max(_to_f(c.high)  for c in comp_candles)
    comp_low  = min(_to_f(c.low)   for c in comp_candles)

    last = candles[-1]
    last_close = _to_f(last.close)
    last_vol   = float(last.volume)
    vol_surge  = last_vol / (avg_vol_30 or 1e-9)

    breakout_up   = last_close > comp_high and vol_surge > 1.15
    breakout_down = last_close < comp_low  and vol_surge > 1.15

    if not breakout_up and not breakout_down:
        return 0.0   # компрессия активна, но пробоя ещё нет

    # Сила сигнала: чем сильнее сжатие и больше объём — тем больше
    squeeze_depth = min(1.0, (0.72 - compression_ratio) / 0.42)  # 0..1
    vol_factor    = min(1.0, (vol_surge - 1.0) / 1.0)
    base = 0.40 + 0.35 * squeeze_depth + 0.15 * vol_factor
    base = min(0.80, base)
    return round((1 if breakout_up else -1) * base, 4)


def score_false_breakout(candles: list[HistoricCandle]) -> float:
    """
    FALSE_BREAKOUT: настоящий ложный пробой — 4 из 6 условий обязательны.

    Чек-лист (по документу):
    1. Объём на sweep-баре × 2+ от среднего               (обязательно)
    2. Глубина пробоя ≥ 0.3% от цены / ≥ 0.5 ATR         (обязательно)
    3. Возврат за 1-2 свечи (не дрейф за 5-10)           (обязательно)
    4. Объёмное основание: вблизи уровня был исторический объём ≥ 1.5× avg
    5. Подтверждение потока: объём на возврате > объёма sweep
    6. За уровнем — пространство (нет плотного объёма сразу за ним)

    < 4 условий → sweep сомнительный → 0.
    """
    if len(candles) < 30:
        return 0.0
    try:
        atr = _compute_atr(candles)
        price = _to_f(candles[-1].close)
        avg_vol = sum(float(c.volume) for c in candles[-20:]) / 20
        if avg_vol <= 0 or atr <= 0:
            return 0.0

        range_bars = candles[-22:-2]
        rng_high = max(_to_f(c.high) for c in range_bars)
        rng_low  = min(_to_f(c.low)  for c in range_bars)
        rng = rng_high - rng_low
        if rng < 1e-9:
            return 0.0

        # Объёмное основание: был ли исторически высокий объём вблизи уровня
        # (прокси для POC/HVN — бар с объёмом ≥ 1.5× avg в ±1 ATR от уровня)
        def _has_vol_basis(level: float) -> bool:
            for c in candles[-40:-2]:
                mid = (_to_f(c.high) + _to_f(c.low)) / 2
                if abs(mid - level) <= 1.0 * atr and float(c.volume) >= 1.5 * avg_vol:
                    return True
            return False

        # LVN за уровнем: пространство (нет плотного объёма сразу за ним)
        def _has_space_beyond(level: float, direction: int) -> bool:
            beyond = [c for c in candles[-40:-2]
                      if (direction > 0 and _to_f(c.low) > level)
                      or (direction < 0 and _to_f(c.high) < level)]
            if not beyond:
                return True  # нет баров за уровнем → пространство есть
            avg_beyond = sum(float(c.volume) for c in beyond) / len(beyond)
            return avg_beyond < 1.3 * avg_vol  # нет плотного объёма

        tail = candles[-4:]  # смотрим последние 4 бара
        for i in range(len(tail) - 1):
            c_sweep = tail[i]
            sweep_vol = float(c_sweep.volume)
            ch = _to_f(c_sweep.high)
            cl = _to_f(c_sweep.low)

            broke_up   = ch > rng_high * 1.001
            broke_down = cl < rng_low  * 0.999
            if not broke_up and not broke_down:
                continue

            # Проверяем возврат за 1-2 бара после sweep (не медленный дрейф)
            return_bars = tail[i + 1: i + 3]  # макс 2 бара
            for j, rb in enumerate(return_bars):
                rb_close = _to_f(rb.close)
                rb_vol   = float(rb.volume)
                lag = j + 1  # 1 или 2 бара

                if broke_up and rb_close >= rng_high:
                    continue  # ещё не вернулся
                if broke_down and rb_close <= rng_low:
                    continue

                # ── Чек-лист ──────────────────────────────────────────────
                conditions = 0

                # 1. Объём sweep × 2+
                if sweep_vol >= 2.0 * avg_vol:
                    conditions += 1

                # 2. Глубина ≥ 0.3% И ≥ 0.5 ATR
                if broke_up:
                    depth = ch - rng_high
                    direction = -1
                else:
                    depth = rng_low - cl
                    direction = +1
                depth_pct = depth / (price or 1.0)
                if depth_pct >= 0.003 and depth >= 0.5 * atr:
                    conditions += 1

                # 3. Возврат быстрый (lag ≤ 2 — уже гарантировано диапазоном)
                if lag <= 2:
                    conditions += 1

                # 4. Объёмное основание у уровня
                level = rng_high if broke_up else rng_low
                if _has_vol_basis(level):
                    conditions += 1

                # 5. Объём возврата > объёма sweep (агрессивное отторжение)
                if rb_vol > sweep_vol * 0.85:
                    conditions += 1

                # 6. Пространство за уровнем
                if _has_space_beyond(level, direction):
                    conditions += 1

                if conditions < 4:
                    return 0.0  # сомнительный sweep — пропускаем

                # Сила пропорциональна глубине + числу условий
                cond_mult = 0.7 + (conditions - 4) * 0.15  # 0.70 / 0.85 / 1.00
                strength  = min(0.85, (0.40 + depth_pct * 30) * cond_mult)
                # Слабый объём sweep → гасим (уже прошло условие 1, но можно усилить)
                if sweep_vol < 3.0 * avg_vol:
                    strength *= 0.85

                return round(direction * strength, 4)

        return 0.0
    except Exception:
        return 0.0


def score_level_absorption(candles: list[HistoricCandle]) -> float:
    """
    LEVEL_ABSORPTION: объём нарастает при подходе к уровню, цена там тормозит.

    Кто-то поглощает поток прямо на уровне. Когда поглотители закончат —
    пробой будет резким (за уровнем стоят стопы). Метод НЕ предсказывает
    направление сам по себе — он усиливает уже имеющийся сигнал или молчит.

    Детектирует:
    - Цена движется к экстремуму последних 15 баров (≤ ATR × 0.5 от него).
    - Объём последних 3 баров нарастает (каждый следующий > предыдущего).
    - Последний бар: маленькое тело (< 35% от диапазона) → цена там тормозит.
    - Возвращает +0.3..+0.6 в направлении движения к уровню (предстоящий пробой).
    """
    if len(candles) < 20:
        return 0.0

    win = candles[-16:]
    closes = [_to_f(c.close) for c in win]
    highs  = [_to_f(c.high)  for c in win]
    lows   = [_to_f(c.low)   for c in win]

    level_high = max(highs[:-1])   # экстремум без текущего бара
    level_low  = min(lows[:-1])

    # ATR за 15 баров
    trs = [max(highs[i] - lows[i], abs(highs[i] - closes[i - 1]),
               abs(lows[i] - closes[i - 1])) for i in range(1, len(win) - 1)]
    atr = sum(trs) / len(trs) if trs else 0.0
    if atr < 1e-9:
        return 0.0

    last = win[-1]
    lc = _to_f(last.close)
    lh = _to_f(last.high)
    ll = _to_f(last.low)
    body = abs(_to_f(last.close) - _to_f(last.open))
    bar_range = lh - ll
    small_body = bar_range > 1e-9 and (body / bar_range) < 0.35

    near_high = (level_high - lc) < atr * 0.5
    near_low  = (lc - level_low)  < atr * 0.5

    if not near_high and not near_low:
        return 0.0

    # Объём нарастает последние 3 бара
    tail_vols = [float(c.volume) for c in win[-3:]]
    vol_rising = tail_vols[1] > tail_vols[0] * 0.90 and tail_vols[2] > tail_vols[1] * 0.90

    if not vol_rising or not small_body:
        return 0.0

    # Направление: движение к уровню
    approach_dir = 1 if near_high else -1
    avg_vol_15 = sum(float(c.volume) for c in win) / len(win)
    vol_surge = tail_vols[-1] / (avg_vol_15 or 1e-9)
    strength = min(0.60, 0.30 + min(1.0, vol_surge - 0.8) * 0.30)
    return round(approach_dir * strength, 4)


# ── Вспомогательные функции для новых методов ────────────────────────────────

def _sma(values: list[float], period: int) -> list[float]:
    out = []
    for i in range(len(values)):
        if i < period - 1:
            out.append(float('nan'))
        else:
            out.append(sum(values[i - period + 1:i + 1]) / period)
    return out

def _ema(values: list[float], period: int) -> list[float]:
    k = 2.0 / (period + 1)
    out = []
    for i, v in enumerate(values):
        if i == 0:
            out.append(v)
        else:
            out.append(out[-1] + k * (v - out[-1]))
    return out

def _smma(values: list[float], period: int) -> list[float]:
    """Wilder's smoothed MA (используется в Аллигаторе)."""
    out = []
    for i, v in enumerate(values):
        if i < period - 1:
            out.append(float('nan'))
        elif i == period - 1:
            out.append(sum(values[:period]) / period)
        else:
            out.append((out[-1] * (period - 1) + v) / period)
    return out

def _rsi(closes: list[float], period: int = 14) -> list[float]:
    gains, losses = [], []
    rsi_out = [float('nan')] * len(closes)
    for i in range(1, len(closes)):
        d = closes[i] - closes[i - 1]
        gains.append(max(0.0, d))
        losses.append(max(0.0, -d))
        if i < period:
            continue
        if i == period:
            ag = sum(gains[-period:]) / period
            al = sum(losses[-period:]) / period
        else:
            ag = (ag * (period - 1) + gains[-1]) / period  # type: ignore[possibly-undefined]
            al = (al * (period - 1) + losses[-1]) / period  # type: ignore[possibly-undefined]
        rsi_out[i] = 100.0 - 100.0 / (1.0 + ag / (al or 1e-9))
    return rsi_out

def _std(values: list[float]) -> float:
    n = len(values)
    if n < 2:
        return 0.0
    m = sum(values) / n
    return math.sqrt(sum((v - m) ** 2 for v in values) / (n - 1))

def _true_atr_list(candles: list[HistoricCandle], period: int) -> list[float]:
    """Классический ATR(period) барный список."""
    trs = [0.0]
    for i in range(1, len(candles)):
        h = _to_f(candles[i].high); l = _to_f(candles[i].low)
        pc = _to_f(candles[i - 1].close)
        trs.append(max(h - l, abs(h - pc), abs(l - pc)))
    result = []
    for i in range(len(trs)):
        if i < period:
            result.append(float('nan'))
        elif i == period:
            result.append(sum(trs[1:period + 1]) / period)
        else:
            result.append((result[-1] * (period - 1) + trs[i]) / period)
    return result


# ── Новые методы: Ишимоку / BB-Keltner / MA-tension / RSI-div / ATR-fuel / Alligator ──

def score_ichimoku_signal(candles: list[HistoricCandle]) -> float:
    """
    ICHIMOKU_SIGNAL: неклассическое использование Ишимоку.

    1. Tenkan/Kijun дистанция как режим-детектор:
       - близко (<0.1%) = боговик/неопределённость → слабый нейтральный сигнал
       - далеко (>0.3%) = каскад/сильный тренд → усиливаем сигнал по направлению TK
       - пересечение = начало смены фазы → сигнал в сторону нового направления
    2. Kijun-магнит: цена далеко от Kijun → ожидание возврата (против тренда).
    3. Толщина будущего облака: тонкое = пустота (пространство для движения),
       толстое = стена впереди.
    4. Chikou в пустоте: текущее закрытие вне диапазона 26 баров назад → свобода.
    5. Текущее облако: цена внутри толстого облака = трение.
    """
    if len(candles) < 60:
        return 0.0

    highs  = [_to_f(c.high)  for c in candles]
    lows   = [_to_f(c.low)   for c in candles]
    closes = [_to_f(c.close) for c in candles]
    n = len(closes)

    def _midprice(h_slice, l_slice):
        return (max(h_slice) + min(l_slice)) / 2.0 if h_slice else 0.0

    if n < 26:
        return 0.0
    tenkan = _midprice(highs[-9:],  lows[-9:])
    kijun  = _midprice(highs[-26:], lows[-26:])
    cur    = closes[-1]

    # 1. Tenkan/Kijun — режим-детектор (документ: дистанция определяет фазу)
    tk_dist = abs(tenkan - kijun) / (kijun or 1e-9)
    tk_dir = 1 if tenkan > kijun else -1   # +1 бычий, -1 медвежий
    if tk_dist < 0.001:
        # Боговик: Tenkan и Kijun почти совпадают — неопределённость
        tk_score = 0.0
    elif tk_dist > 0.003:
        # Каскад: далеко → сильный тренд, голосуем по направлению TK/KJ
        tk_score = tk_dir * min(0.45, tk_dist * 100)
    else:
        tk_score = tk_dir * 0.20   # переходная зона

    # Пересечение Tenkan/Kijun за последние 3 бара = начало смены фазы
    tk_cross = 0.0
    if n >= 12:
        tenkan_3 = _midprice(highs[-12:-3], lows[-12:-3])
        kijun_3  = _midprice(highs[-29:-3], lows[-29:-3]) if n >= 32 else tenkan_3
        prev_tk_dir = 1 if tenkan_3 > kijun_3 else -1
        if prev_tk_dir != tk_dir:
            # Свежее пересечение: сигнал в новую сторону
            tk_cross = tk_dir * 0.35

    # 2. Kijun-магнит: цена далеко → возврат (против тренда)
    kijun_dev = (cur - kijun) / (kijun or 1e-9)
    kijun_signal = -math.tanh(kijun_dev * 8.0) * 0.35

    # 3. Текущее облако (Senkou A/B построенное 26 баров назад)
    cloud_score = 0.0
    if n >= 52:
        sa_past = _midprice(highs[-52:-26], lows[-52:-26])
        sb_past = _midprice(highs[-78:-26], lows[-78:-26]) if n >= 78 else sa_past
        cloud_thick_past = abs(sa_past - sb_past)
        atr_now = _compute_atr(candles)
        cloud_in_atr = cloud_thick_past / ((_to_f(candles[-1].close) or 1) * max(atr_now, 0.001))
        cloud_top = max(sa_past, sb_past)
        cloud_bot = min(sa_past, sb_past)
        if cloud_bot <= cur <= cloud_top and cloud_in_atr > 1.5:
            cloud_score = -0.25   # цена в толстом облаке = трение

    # 4. Будущее облако: тонкое = пустота, толстое = стена
    senkou_a_future = (tenkan + kijun) / 2.0
    senkou_b_future = _midprice(highs[-52:], lows[-52:]) if n >= 52 else tenkan
    future_cloud_thick = abs(senkou_a_future - senkou_b_future)
    atr_abs = _compute_atr(candles) * (cur or 1)
    future_void = future_cloud_thick / (atr_abs or 1e-9)
    trend_dir_sign = 1 if cur > kijun else -1
    if future_void < 0.5:
        future_score = trend_dir_sign * 0.25   # пустота впереди
    elif future_void > 2.0:
        future_score = -trend_dir_sign * 0.20  # стена впереди
    else:
        future_score = 0.0

    # 5. Chikou в пустоте
    chikou_score = 0.0
    if n >= 27:
        chikou_price = closes[-1]
        chikou_context = candles[-28:-24] if n >= 28 else []
        if chikou_context:
            ctx_hi = max(_to_f(c.high) for c in chikou_context)
            ctx_lo = min(_to_f(c.low)  for c in chikou_context)
            ctx_range = ctx_hi - ctx_lo
            if ctx_range > 1e-9:
                gap_ratio = min(1.0, max(0.0,
                    (chikou_price - ctx_hi) / ctx_range if chikou_price > ctx_hi
                    else (ctx_lo - chikou_price) / ctx_range if chikou_price < ctx_lo
                    else 0.0
                ))
                chikou_score = trend_dir_sign * gap_ratio * 0.20

    total = (tk_score * 0.30 + tk_cross * 0.20
             + kijun_signal * 0.25 + cloud_score * 0.10
             + future_score * 0.10 + chikou_score * 0.05)
    return round(max(-1.0, min(1.0, total)), 4)


def score_ma_envelope(candles: list[HistoricCandle]) -> float:
    """
    MA_ENVELOPE: канал из двух линий MA ± k%.

    Двойная логика зависящая от режима:
    - Боковик (цена долго внутри канала): касание нижней границы → LONG,
      касание верхней → SHORT (контрарная, mean-reversion).
    - Тренд (цена пробила границу и держится снаружи): пробой вверх → LONG,
      пробой вниз → SHORT (импульсная, трендовая).

    Параметры: MA20, ширина канала = 1.5 × ATR / цена.
    Адаптивная ширина: для медленных инструментов канал уже, для летучих — шире.
    """
    h, l, c, v = _hlcv(candles)
    n = len(c)
    if n < 22:
        return 0.0

    period = 20
    ma = sum(c[-period:]) / period

    # Ширина канала: 1.5 × ATR / MA (адаптивно к волатильности)
    atr = sum(max(h[i] - l[i], abs(h[i] - c[i-1]), abs(l[i] - c[i-1]))
              for i in range(-period, 0)) / period
    k = min(0.03, max(0.005, 1.5 * atr / (ma + 1e-9)))

    upper = ma * (1 + k)
    lower = ma * (1 - k)
    price = c[-1]

    # Позиция цены относительно канала: <0 ниже нижней, >1 выше верхней, 0..1 внутри
    band_range = upper - lower
    if band_range < 1e-9:
        return 0.0
    pos = (price - lower) / band_range  # 0=у нижней, 1=у верхней, <0 или >1 снаружи

    # Сколько последних баров цена провела внутри/снаружи канала
    lookback = min(10, n - 1)
    inside = sum(1 for i in range(-lookback, 0) if lower <= c[i] <= upper)
    inside_ratio = inside / lookback

    if inside_ratio >= 0.7:
        # Режим боковика: цена долго внутри — контрарная логика
        if pos <= 0.15:
            # У нижней границы — отскок вверх
            raw = 0.4 + (0.15 - pos) * 2.0
        elif pos >= 0.85:
            # У верхней границы — отскок вниз
            raw = -(0.4 + (pos - 0.85) * 2.0)
        else:
            return 0.0
    else:
        # Режим пробоя: цена снаружи канала — импульсная логика
        if pos > 1.0:
            # Выше верхней границы — бычий пробой
            raw = 0.3 + min(0.5, (pos - 1.0) * 3.0)
        elif pos < 0.0:
            # Ниже нижней границы — медвежий пробой
            raw = -(0.3 + min(0.5, abs(pos) * 3.0))
        else:
            # Возврат внутрь после пробоя — угасание импульса
            raw = 0.0

    return float(max(-1.0, min(1.0, raw)))


def score_bb_keltner_squeeze(candles: list[HistoricCandle]) -> float:
    """
    BB_KELTNER_SQUEEZE (TTM Squeeze): Bollinger Bands внутри Keltner Channels.

    Когда BB_upper < KC_upper И BB_lower > KC_lower — компрессия на максимуме,
    энергия накоплена. Выход из сжатия (BB вышли из KC) + импульс momentum →
    сильный направленный сигнал.

    Momentum: закрытие относительно средней из (высокого хая + низкого лоя +
    закрытия) за N баров — стандартный TTM-momentum. Его наклон определяет
    направление пробоя.
    """
    if len(candles) < 25:
        return 0.0

    P = 20
    win = candles[-P - 5:]
    closes = [_to_f(c.close) for c in win]
    highs  = [_to_f(c.high)  for c in win]
    lows   = [_to_f(c.low)   for c in win]

    if len(closes) < P:
        return 0.0

    # Bollinger Bands (20, 2σ)
    bb_mid = sum(closes[-P:]) / P
    bb_std = _std(closes[-P:])
    bb_upper = bb_mid + 2.0 * bb_std
    bb_lower = bb_mid - 2.0 * bb_std

    # Keltner Channel (EMA20, 1.5×ATR14)
    kc_mid = _ema(closes, P)[-1]
    atr_vals = _true_atr_list(win, 14)
    kc_atr = next((v for v in reversed(atr_vals) if not math.isnan(v)), 0.0)
    kc_upper = kc_mid + 1.5 * kc_atr
    kc_lower = kc_mid - 1.5 * kc_atr

    squeeze_on  = (bb_upper < kc_upper) and (bb_lower > kc_lower)
    squeeze_off = (bb_upper > kc_upper) and (bb_lower < kc_lower)

    # TTM momentum
    hh = max(highs[-P:])
    ll = min(lows[-P:])
    delta = closes[-1] - (hh + ll + bb_mid) / 3.0
    mom_vals = []
    for i in range(min(5, len(closes) - P)):
        idx = -(P + i)
        hh_i = max(highs[idx - P:idx] or [highs[idx]])
        ll_i = min(lows[idx - P:idx]  or [lows[idx]])
        mid_i = sum(closes[idx - P:idx] or [closes[idx]]) / P
        mom_vals.insert(0, closes[idx] - (hh_i + ll_i + mid_i) / 3.0)

    mom_slope = 0.0
    if len(mom_vals) >= 2:
        mom_slope = (delta - mom_vals[0]) / (abs(mom_vals[0]) or 1e-9)

    # Длительность сжатия — прокси через насколько текущая ширина BB ниже
    # исторического медиана. Используем уже вычисленные closes/highs/lows.
    # Считаем за последние 40 баров серию bb_std и смотрим сколько подряд
    # были ниже медианы — без повторного вызова _true_atr_list.
    duration_mult = 1.0
    if len(closes) >= P + 10:
        hist_window = min(40, len(closes) - P)
        bb_stds = []
        for k in range(hist_window):
            slc = closes[-(P + hist_window) + k: -(hist_window) + k or len(closes)]
            if len(slc) >= P:
                bb_stds.append(_std(slc[-P:]))
        if bb_stds:
            med_std = sorted(bb_stds)[len(bb_stds) // 2]
            # Текущая ширина в долях от медианной: <0.5 = глубокое сжатие
            compression_depth = bb_std / (med_std or 1e-9)
            # duration_mult: чем глубже и дольше сжатие — тем сильнее выброс
            duration_mult = max(1.0, min(1.60, 1.0 + (1.0 - compression_depth) * 0.8))

    if squeeze_on:
        direction = math.copysign(1, delta) if abs(delta) > 1e-9 else 0
        # В сжатии: слабый сигнал по направлению momentum
        return round(direction * 0.20, 4)

    if squeeze_off:
        direction = math.copysign(1, delta) if abs(delta) > 1e-9 else 0
        strength = min(0.95, (0.45 + min(1.0, abs(mom_slope)) * 0.35) * duration_mult)
        return round(direction * strength, 4)

    return 0.0


def score_ma_tension(candles: list[HistoricCandle]) -> float:
    """
    MA_TENSION: неклассическое использование скользящих средних.

    Три сигнала:
    1. Резинка MA50: расстояние цены от MA50 → натяжение, ожидание возврата.
    2. Все три МА (MA5, MA20, MA50) в дискомфорте одновременно →
       максимальное напряжение (сигнал против тренда).
    3. Угол MA20: резкий перегиб → импульс реальный, а не шум (сигнал по тренду).

    Комбинация: при сильном натяжении → против тренда;
    при свежем перегибе без натяжения → по тренду.
    """
    if len(candles) < 55:
        return 0.0

    closes = [_to_f(c.close) for c in candles]
    cur = closes[-1]

    ma5  = sum(closes[-5:])  / 5
    ma20 = sum(closes[-20:]) / 20
    ma50 = sum(closes[-50:]) / 50

    # Нормированные отклонения
    dev5  = (cur - ma5)  / (cur or 1e-9)
    dev20 = (cur - ma20) / (cur or 1e-9)
    dev50 = (cur - ma50) / (cur or 1e-9)

    # 1. Натяжение от MA50
    tension = math.tanh(dev50 * 15.0)   # ±1 при ~7% отклонении
    rubber_score = -tension * 0.40       # против тренда

    # 2. Все три в одном направлении и далеко → максимальное напряжение
    same_side = (dev5 > 0) == (dev20 > 0) == (dev50 > 0)
    all_far = abs(dev5) > 0.005 and abs(dev20) > 0.008 and abs(dev50) > 0.012
    if same_side and all_far:
        direction = 1 if dev50 > 0 else -1
        spread_score = -direction * 0.25  # против: все в дискомфорте → разрядка
    else:
        spread_score = 0.0

    # 3. Угол MA20: наклон за последние 5 баров
    ma20_prev = sum(closes[-25:-5]) / 20
    angle = (ma20 - ma20_prev) / (ma20_prev or 1e-9)
    # Резкий перегиб (>0.5% за 5 баров) → подтверждение импульса
    if abs(angle) > 0.003:
        bend_dir = 1 if angle > 0 else -1
        bend_score = bend_dir * min(0.35, abs(angle) * 80)
    else:
        bend_score = 0.0

    total = rubber_score * 0.45 + spread_score * 0.30 + bend_score * 0.25
    return round(max(-1.0, min(1.0, total)), 4)


def score_rsi_divergence(candles: list[HistoricCandle]) -> float:
    """
    RSI_DIVERGENCE: дивергенция RSI vs цена.

    Цена делает новый экстремум, RSI нет → затухание импульса.
    Совпадает с WANING_IMPULSES но через другой инструмент — двойное подтверждение.

    Логика:
    - Берём RSI(14) за последние 40 баров.
    - Ищем два последних ценовых экстремума (пиков/впадин) с шагом ≥8 баров.
    - Если цена обновила экстремум, но RSI нет → дивергенция.
    - Вес: RSI(3) в экстремальной зоне (>90 или <10) → усиление сигнала.
    """
    if len(candles) < 45:
        return 0.0

    win = candles[-45:]
    closes = [_to_f(c.close) for c in win]
    highs  = [_to_f(c.high)  for c in win]
    lows   = [_to_f(c.low)   for c in win]
    n = len(closes)

    rsi14 = _rsi(closes, 14)
    rsi3  = _rsi(closes, 3)

    # Направление: последний бар vs первый
    overall_dir = 1 if closes[-1] > closes[0] else -1

    # Ищем два пика (бычий тренд) или две впадины (медвежий)
    SW = 4
    extremes = []   # (idx, price, rsi)
    for i in range(SW, n - SW):
        if math.isnan(rsi14[i]):
            continue
        if overall_dir > 0:
            if all(highs[i] >= highs[j] for j in range(i - SW, i + SW + 1) if j != i):
                extremes.append((i, highs[i], rsi14[i]))
        else:
            if all(lows[i] <= lows[j] for j in range(i - SW, i + SW + 1) if j != i):
                extremes.append((i, lows[i], rsi14[i]))

    if len(extremes) < 2:
        return 0.0

    # Берём последние два экстремума с разницей ≥ 6 баров
    e2 = extremes[-1]
    e1 = next((e for e in reversed(extremes[:-1]) if e2[0] - e[0] >= 6), None)
    if e1 is None:
        return 0.0

    price_new_extreme = (e2[1] > e1[1]) if overall_dir > 0 else (e2[1] < e1[1])
    rsi_new_extreme   = (e2[2] > e1[2]) if overall_dir > 0 else (e2[2] < e1[2])

    if not price_new_extreme or rsi_new_extreme:
        return 0.0   # нет дивергенции

    # Дивергенция: цена обновила экстремум, RSI нет
    rsi_gap = abs(e2[2] - e1[2]) / 100.0   # 0..1
    last_rsi3 = next((v for v in reversed(rsi3) if not math.isnan(v)), 50.0)

    # RSI(3) в экстремальной зоне → истощение подтверждено
    rsi3_extreme = (overall_dir > 0 and last_rsi3 > 85) or \
                   (overall_dir < 0 and last_rsi3 < 15)
    strength = min(0.75, 0.35 + rsi_gap * 0.80)
    if rsi3_extreme:
        strength = min(0.85, strength + 0.15)

    return round(-overall_dir * strength, 4)


def score_atr_exhaustion(candles: list[HistoricCandle]) -> float:
    """
    ATR_EXHAUSTION: антисигнал на движение без волатильной энергии.

    1. Волатильность сжалась (короткий ATR < длинного * 0.75) при движущейся цене
       = движение по инерции без энергии → антисигнал продолжения.
    2. Пройдено >1.8 ATR за 20 баров → топливо исчерпано → антисигнал продолжения.
    3. Пройдено <0.4 ATR → потенциал ещё есть → слабый сигнал за продолжение.
    """
    n = len(candles)
    if n < 25:
        return 0.0

    atr_long = _compute_atr(candles, period=21)
    atr_short = _compute_atr(candles[-15:], period=7) if n >= 15 else atr_long
    if atr_long < 1e-6:
        return 0.0

    win = candles[-20:]
    first_close = _to_f(win[0].close)
    last_close  = _to_f(win[-1].close)
    move_pct = abs(last_close - first_close) / (first_close or 1e-9)
    direction = 1 if last_close > first_close else -1

    total_path = sum(abs(_to_f(win[i].close) - _to_f(win[i - 1].close))
                     for i in range(1, len(win)))
    path_ratio  = total_path / (first_close * atr_long or 1e-9)
    netto_ratio = move_pct / atr_long

    # Сжатие волатильности = максимальная компрессия энергии
    # Волатильность на минимуме → выброс неизбежен и будет резким
    # Направление: по стороне куда цена медленно дрейфовала во время сжатия
    vol_contracting = atr_short < atr_long * 0.75
    if vol_contracting:
        contraction = min(1.0, (atr_long - atr_short) / (atr_long + 1e-9))
        # Чем сильнее сжатие — тем сильнее будущий выброс
        spring_strength = min(0.80, 0.40 + contraction * 0.50)
        # Направление дрейфа во время компрессии = вероятное направление выброса
        return round(direction * spring_strength, 4)

    if netto_ratio > 1.8 or path_ratio > 2.5:
        # Пройдено слишком много ATR → топливо кончилось → разворот
        excess = min(1.0, (netto_ratio - 1.5) / 1.5)
        return round(-direction * min(0.70, 0.35 + excess * 0.45), 4)

    if netto_ratio < 0.40:
        # Потенциал не использован → рынок ещё не определился
        slack = min(1.0, (0.40 - netto_ratio) / 0.40)
        return round(direction * min(0.35, 0.15 + slack * 0.25), 4)

    return 0.0


def score_alligator(candles: list[HistoricCandle]) -> float:
    """
    ALLIGATOR: три SMMA (5, 8, 13) — неклассическое использование.

    Сигналы:
    1. Расхождение линий (аллигатор ест): тренд силён, каскад в полную силу.
    2. Схождение после расхождения (засыпает): движение затухает.
    3. Резкое расхождение всех трёх сразу → импульс очень силён.
    4. Все три слились → максимальная неопределённость, готовится движение.
    5. Цена vs линии: откат до "зубов" (SMMA8) — тренд жив.
       Пробой "губ" (SMMA13) — тренд под вопросом.
    """
    if len(candles) < 20:
        return 0.0

    closes = [_to_f(c.close) for c in candles]
    highs  = [_to_f(c.high)  for c in candles]
    lows   = [_to_f(c.low)   for c in candles]

    # Медиан-цена как база для Аллигатора
    median = [(highs[i] + lows[i]) / 2.0 for i in range(len(closes))]

    lips  = _smma(median, 5)
    teeth = _smma(median, 8)
    jaw   = _smma(median, 13)

    # Берём последние валидные значения
    def _last_valid(arr):
        return next((v for v in reversed(arr) if not math.isnan(v)), None)

    lv_lips  = _last_valid(lips)
    lv_teeth = _last_valid(teeth)
    lv_jaw   = _last_valid(jaw)
    if lv_lips is None or lv_teeth is None or lv_jaw is None:
        return 0.0

    cur = closes[-1]
    spread = max(lv_lips, lv_teeth, lv_jaw) - min(lv_lips, lv_teeth, lv_jaw)
    atr_abs = _compute_atr(candles) * (cur or 1)

    if atr_abs < 1e-9:
        return 0.0

    spread_ratio = spread / atr_abs

    # История расхождения: сравниваем spread сейчас vs 5 баров назад
    def _spread_at(idx):
        l5 = lips[idx]  if idx < len(lips)  else float('nan')
        t8 = teeth[idx] if idx < len(teeth) else float('nan')
        j13 = jaw[idx]  if idx < len(jaw)   else float('nan')
        if any(math.isnan(v) for v in (l5, t8, j13)):
            return 0.0
        return max(l5, t8, j13) - min(l5, t8, j13)

    spread_5ago = _spread_at(-6) / atr_abs if len(candles) >= 6 else spread_ratio

    spread_growing   = spread_ratio > spread_5ago * 1.05
    spread_shrinking = spread_ratio < spread_5ago * 0.90

    # Тренд-направление: порядок линий
    bull_order = lv_lips > lv_teeth > lv_jaw   # губы выше зубов выше челюсти
    bear_order = lv_lips < lv_teeth < lv_jaw
    trend_dir  = 1 if bull_order else (-1 if bear_order else 0)

    score = 0.0

    # 4. Все три слились → компрессия, готовится движение (нейтральный сигнал)
    if spread_ratio < 0.15:
        return 0.0   # молчим, не знаем направление

    # 3. Резкое расхождение — импульс реален
    if spread_growing and spread_ratio > 0.5:
        score += trend_dir * min(0.45, spread_ratio * 0.35)

    # 2. Схождение после расхождения — затухание
    if spread_shrinking and spread_5ago > 0.4:
        score -= trend_dir * 0.30

    # 5. Цена относительно линий
    if trend_dir != 0:
        above_jaw   = cur > lv_jaw
        above_teeth = cur > lv_teeth
        above_lips  = cur > lv_lips
        if trend_dir > 0:
            if above_lips and above_teeth and above_jaw:
                score += 0.20   # всё по тренду
            elif above_jaw and not above_lips:
                score += 0.05   # откат до зубов, тренд жив
            elif not above_jaw:
                score -= 0.20   # пробой губ, тренд под вопросом
        else:
            if not above_lips and not above_teeth and not above_jaw:
                score -= 0.20
            elif not above_jaw and above_lips:
                score -= 0.05
            elif above_jaw:
                score += 0.20

    return round(max(-1.0, min(1.0, score)), 4)


# ── Расширение тейк-профита при сильном потенциале ────────────────────────────

def _tp_extension_mult(candles: list, is_long: bool) -> float:
    """
    Оценивает потенциал продолжения движения по набору признаков.

    Три признака → ×1.5 (тейк на 50% дальше).
    Четыре+ включая Fisher RSI в крайности → ×2.0 (тейк вдвое дальше).

    Признаки: Klinger в экстремуме не переключается, Fisher RSI в крайности,
    объём на импульсах держится, Donchian расширяется, VZO асимметрия чистая,
    MAMA/FAMA расходятся, ATR растёт, Z-score усиливается в сторону движения.
    """
    if not candles or len(candles) < 25:
        return 1.0

    try:
        hl   = [_to_f(c.high)  for c in candles]
        ll   = [_to_f(c.low)   for c in candles]
        cl   = [_to_f(c.close) for c in candles]
        vl   = [float(c.volume) for c in candles]
        n    = len(cl)

        score = 0
        fisher_holding = False

        # 1. Klinger в экстремуме + не переключается + в нужную сторону
        try:
            fast = min(34, n // 2); slow = min(55, n - 1)
            kvo = klinger_oscillator(hl, ll, cl, vl, fast=fast, slow=slow)
            if len(kvo) >= 3:
                rms = (sum(x * x for x in kvo[-20:]) / min(20, n)) ** 0.5 or 1.0
                kvo_dir_ok = (kvo[-1] > 0) == is_long
                kvo_extreme = abs(kvo[-1]) > rms * 1.1
                kvo_stable  = abs(kvo[-1]) >= abs(kvo[-2]) * 0.80
                if kvo_dir_ok and kvo_extreme and kvo_stable:
                    score += 1
        except Exception:
            pass

        # 2. Fisher RSI в крайности + там держится
        try:
            fr = fisher_rsi(cl, period=min(10, n - 1))
            if len(fr) >= 3:
                EXTREME = 1.8
                fr_now = fr[-1]
                fr_dir_ok = (fr_now > 0) == is_long
                fr_in_ext = abs(fr_now) > EXTREME
                fr_stable  = abs(fr_now) >= abs(fr[-2]) * 0.85
                if fr_dir_ok and fr_in_ext and fr_stable:
                    score += 1
                    fisher_holding = True
        except Exception:
            pass

        # 3. Объём на последних импульсах держится (не падает)
        try:
            vol_recent = sum(vl[-5:]) / 5
            vol_base   = sum(vl[-15:]) / 15
            if vol_base > 0 and vol_recent >= vol_base * 0.88:
                score += 1
        except Exception:
            pass

        # 4. Donchian расширяется в сторону движения
        try:
            p = min(20, n - 1)
            cur_upper = max(hl[-p:]); cur_lower = min(ll[-p:])
            if n > p + 5:
                old_upper = max(hl[-p - 5:-5]); old_lower = min(ll[-p - 5:-5])
            else:
                old_upper, old_lower = cur_upper, cur_lower
            cur_range = cur_upper - cur_lower
            old_range = old_upper - old_lower
            expanding = cur_range > old_range * 1.04
            upper_broke = cur_upper > old_upper and is_long
            lower_broke = cur_lower < old_lower and not is_long
            if expanding and (upper_broke or lower_broke):
                score += 1
        except Exception:
            pass

        # 5. VZO асимметрия чистая (объём в одну сторону)
        try:
            sv = []
            for i in range(n):
                rng = (hl[i] - ll[i]) or 1e-9
                sv.append(vl[i] * (2 * (cl[i] - ll[i]) / rng - 1))
            alpha_v = 2 / 15
            esv = [sv[0]]; ev = [vl[0]]
            for i in range(1, n):
                esv.append(alpha_v * sv[i] + (1 - alpha_v) * esv[-1])
                ev.append(alpha_v * vl[i] + (1 - alpha_v) * ev[-1])
            vzo_now = esv[-1] / ev[-1] if ev[-1] else 0.0
            vzo_ok = (vzo_now > 0.20 and is_long) or (vzo_now < -0.20 and not is_long)
            if vzo_ok:
                score += 1
        except Exception:
            pass

        # 6. MAMA/FAMA расходятся (тренд усиливается)
        try:
            from indicators_ehlers import mama_fama as _mf
            ms, fs, _ = _mf(cl)
            def _lv(arr, k=1):
                v = [x for x in arr if not (isinstance(x, float) and math.isnan(x))]
                return v[-k] if len(v) >= k else None
            m1, f1, m3, f3 = _lv(ms,1), _lv(fs,1), _lv(ms,3), _lv(fs,3)
            if None not in (m1, f1, m3, f3):
                pr = abs(m1) or 1.0
                gap_now = abs(m1 - f1) / pr
                gap_3   = abs(m3 - f3) / pr
                dir_ok  = (m1 > f1) == is_long
                if dir_ok and gap_now > gap_3 * 1.05:
                    score += 1
        except Exception:
            pass

        # 7. ATR растёт (волатильность нарастает, каскад ускоряется)
        try:
            atr_s = _compute_atr(candles[-12:], period=7) if n >= 12 else 0.0
            atr_l = _compute_atr(candles,       period=21)
            if atr_l > 0 and atr_s > atr_l * 1.10:
                score += 1
        except Exception:
            pass

        # 8. Z-score усиливается в сторону движения
        try:
            pw = min(20, n)
            ww = cl[-pw:]
            mu = sum(ww) / pw
            sd = (sum((x - mu) ** 2 for x in ww) / pw) ** 0.5
            if sd > 1e-9:
                z = (cl[-1] - mu) / sd
                z_dir_ok = (z > 0.8 and is_long) or (z < -0.8 and not is_long)
                if z_dir_ok:
                    score += 1
        except Exception:
            pass

        if score >= 4 and fisher_holding:
            return 2.0
        if score >= 3:
            return 1.5
        return 1.0

    except Exception:
        return 1.0


# ── SMC / ICT ─────────────────────────────────────────────────────────────────

def score_level_quality(candles: list[HistoricCandle]) -> float:
    """
    Качество текущего уровня: сколько независимых методов его «видят».

    Алгоритм «3 из 5» (по документу):
      1. Order Block (свеча с объёмом ≥ 2×) рядом с ценой
      2. POC / HVN Volume Profile рядом (кластер ≈ HVN)
      3. Значимый H/L структуры (Significant High/Low, объём × 2+)
      4. Weekly Open / 52W High/Low
      5. Второе касание с реакцией (подтверждённый уровень)

    Score = (count / 5) × direction × strength_mult.
    Сигнал в направлении отскока от уровня (бычий снизу, медвежий сверху).

    Composite POC cluster: несколько недельных POC в 0.5% зоне → ×1.3.
    """
    if len(candles) < 50:
        return 0.0
    try:
        def _h(c): return _to_f(c.high)
        def _l(c): return _to_f(c.low)
        def _c(c): return _to_f(c.close)
        def _o(c): return _to_f(c.open)
        def _v(c): return _to_f(c.volume)

        atr     = _compute_atr(candles)
        price   = _c(candles[-1])
        avg_vol = sum(_v(c) for c in candles[-20:]) / 20
        if atr <= 0 or avg_vol <= 0:
            return 0.0

        prox = 1.2 * atr  # «рядом» = 1.2 ATR

        criteria = 0
        direction = 0.0  # +1 бычий, -1 медвежий

        # ── 1. Order Block: последняя медвежья/бычья свеча перед импульсом ──
        for i in range(2, min(25, len(candles) - 1)):
            c_ob  = candles[-(i + 1)]
            c_imp = candles[-i]
            imp_size = abs(_c(c_imp) - _o(c_imp))
            if imp_size < 1.2 * atr:
                continue
            is_bull_ob = _c(c_ob) < _o(c_ob) and _c(c_imp) > _o(c_imp)
            is_bear_ob = _c(c_ob) > _o(c_ob) and _c(c_imp) < _o(c_imp)
            ob_lo = min(_o(c_ob), _c(c_ob), _l(c_ob))
            ob_hi = max(_o(c_ob), _c(c_ob), _h(c_ob))
            if is_bull_ob and ob_lo <= price <= ob_hi + prox:
                criteria += 1
                direction += 1.0
                break
            if is_bear_ob and ob_lo - prox <= price <= ob_hi:
                criteria += 1
                direction -= 1.0
                break

        # ── 2. POC / HVN: зона с концентрацией объёма рядом ──
        win = min(100, len(candles) - 1)
        seg = candles[-win:-1]
        if seg:
            prices_v: list[tuple[float, float]] = [
                ((_h(c) + _l(c)) / 2, _v(c)) for c in seg
            ]
            prices_v.sort(key=lambda x: x[0])
            total_v   = sum(v for _, v in prices_v) or 1.0
            top_pv    = max(prices_v, key=lambda x: x[1])
            poc_price = top_pv[0]
            if abs(poc_price - price) <= prox:
                criteria += 1
                direction += 1.0 if price < poc_price else -1.0

        # ── 3. Significant High/Low: хай/лой на объёме ≥ 2× среднего ──
        sig_found = False
        for i in range(2, min(50, len(candles) - 1)):
            c = candles[-i]
            if _v(c) < 2.0 * avg_vol:
                continue
            hi, lo = _h(c), _l(c)
            if abs(hi - price) <= prox:
                criteria += 1
                direction -= 1.0  # сопротивление сверху
                sig_found = True
                break
            if abs(lo - price) <= prox:
                criteria += 1
                direction += 1.0  # поддержка снизу
                sig_found = True
                break

        # ── 4. Weekly Open / 52W High/Low ──
        # Группируем по дням
        by_day: dict = {}
        for c in candles:
            d = c.time.date()
            if d not in by_day:
                by_day[d] = {"h": _h(c), "l": _l(c), "o": _o(c), "c": _c(c)}
            else:
                if _h(c) > by_day[d]["h"]: by_day[d]["h"] = _h(c)
                if _l(c) < by_day[d]["l"]: by_day[d]["l"] = _l(c)
                by_day[d]["c"] = _c(c)
        sorted_days = sorted(by_day.keys())
        today_d = candles[-1].time.date()

        # Weekly Open
        import datetime as _dt
        wday = today_d.weekday()
        week_start = today_d - _dt.timedelta(days=wday)
        wo_day = next((d for d in sorted_days if d >= week_start), None)
        if wo_day and wo_day in by_day:
            wo = by_day[wo_day]["o"]
            if abs(wo - price) <= prox:
                criteria += 1
                direction += 1.0 if price >= wo else -1.0

        # 52W high/low
        year_days = [d for d in sorted_days if d < today_d][-252:]
        if year_days:
            yh = max(by_day[d]["h"] for d in year_days)
            yl = min(by_day[d]["l"] for d in year_days)
            if abs(yh - price) <= prox:
                criteria += 1
                direction -= 1.0
            elif abs(yl - price) <= prox:
                criteria += 1
                direction += 1.0

        # ── 5. Второе касание с реакцией: уровень подтверждён ──
        # Ищем касание любого из выявленных POC/OB-уровней раньше в истории
        # Упрощённо: был ли ценовой разворот вблизи текущей цены в прошлом
        touches_with_reaction = 0
        for i in range(5, min(60, len(candles) - 1)):
            cp = _c(candles[-i])
            if abs(cp - price) <= prox:
                # Был ли разворот: свеча перед касанием и после — противоположные стороны
                before = _c(candles[-(i + 1)]) if i + 1 < len(candles) else cp
                after  = _c(candles[-(i - 1)]) if i > 1 else cp
                moved_away = abs(after - price) > 0.8 * atr
                if moved_away:
                    touches_with_reaction += 1
        if touches_with_reaction >= 2:
            criteria += 1
            # Направление: последнее касание было снизу или сверху
            direction += 1.0 if price > sum(
                _c(candles[-i]) for i in range(5, min(15, len(candles)-1))
            ) / min(10, len(candles)-6) else -1.0

        if criteria == 0:
            return 0.0

        # ── Composite POC cluster: несколько недельных POC в 0.5% зоне ──
        cluster_mult = 1.0
        week_pocs: list[float] = []
        for start_i in range(0, min(5, len(sorted_days) // 5)):
            w_days = sorted_days[start_i * 5: (start_i + 1) * 5]
            if not w_days:
                continue
            w_seg = [c for c in candles if c.time.date() in set(w_days)]
            if not w_seg:
                continue
            w_pv = [( (_h(c) + _l(c)) / 2, _v(c)) for c in w_seg]
            if w_pv:
                wm = max(w_pv, key=lambda x: x[1])
                week_pocs.append(wm[0])
        if len(week_pocs) >= 2:
            cluster_zone = 0.005 * price
            near_poc = [p for p in week_pocs if abs(p - price) <= cluster_zone]
            if len(near_poc) >= 2:
                cluster_mult = 1.3

        strength_mult = min(1.5, 0.5 + criteria * 0.25) * cluster_mult
        dir_sign = 1.0 if direction > 0 else -1.0 if direction < 0 else 0.0
        raw = dir_sign * (criteria / 5.0) * strength_mult
        return max(-1.0, min(1.0, round(raw, 4)))
    except Exception:
        return 0.0


def score_fvg(candles: list[HistoricCandle]) -> float:
    """
    Fair Value Gap (имбаланс): три свечи, где между тенью 1-й и тенью 3-й
    осталась «дыра» — зона без торговли.

    Логика:
    - Откат вошёл в ближайший незакрытый FVG → сигнал в направлении FVG.
    - Размер FVG (% от цены) масштабирует силу сигнала.
    - Незакрытые «старые» FVG выше/ниже цены = признак силы тренда
      (рынок не возвращается → тренд жив).
    - Вложенный FVG (nested): внутри зоны ещё один → максимальное ускорение.
    """
    if len(candles) < 20:
        return 0.0
    try:
        def _f(c): return _to_f(c.close)
        def _h(c): return _to_f(c.high)
        def _l(c): return _to_f(c.low)

        price = _f(candles[-1])
        atr   = _compute_atr(candles)
        if atr <= 0:
            return 0.0

        # Собираем все незакрытые FVG за последние 40 баров
        window = candles[-42:-2]  # оставляем [-2:] как «текущий» трипл
        bullish_fvgs: list[tuple[float, float, int]] = []  # (low, high, age)
        bearish_fvgs: list[tuple[float, float, int]] = []

        for i in range(1, len(window) - 1):
            c1, c2, c3 = window[i - 1], window[i], window[i + 1]
            gap_bull = _l(c3) - _h(c1)   # бычий FVG: low c3 > high c1
            gap_bear = _l(c1) - _h(c3)   # медвежий FVG: low c1 > high c3
            age = len(window) - i
            if gap_bull > 0.0001 * price:
                bullish_fvgs.append((_h(c1), _l(c3), age))
            if gap_bear > 0.0001 * price:
                bearish_fvgs.append((_h(c3), _l(c1), age))

        if not bullish_fvgs and not bearish_fvgs:
            return 0.0

        score = 0.0

        # 1. Откат вошёл в ближайший незакрытый FVG → сигнал в направлении FVG
        # Бычий FVG: цена опустилась в зону [low_fvg, high_fvg] с нижней стороны
        for fvg_lo, fvg_hi, age in sorted(bullish_fvgs, key=lambda x: x[2]):
            mid = (fvg_lo + fvg_hi) / 2
            gap_size = (fvg_hi - fvg_lo) / price
            size_mult = min(1.5, 0.6 + gap_size / (atr / price) * 0.3)
            age_decay = max(0.4, 1.0 - age * 0.02)
            if fvg_lo <= price <= fvg_hi:
                # Цена внутри зоны — восстановление к верхней границе
                s = 0.45 * size_mult * age_decay
                score += s
                break
            elif price < fvg_lo and price > fvg_lo - 0.5 * atr:
                # Откат коснулся верхней границы снизу — лучшая точка входа
                s = 0.55 * size_mult * age_decay
                score += s
                break

        # Медвежий FVG
        for fvg_lo, fvg_hi, age in sorted(bearish_fvgs, key=lambda x: x[2]):
            gap_size = (fvg_hi - fvg_lo) / price
            size_mult = min(1.5, 0.6 + gap_size / (atr / price) * 0.3)
            age_decay = max(0.4, 1.0 - age * 0.02)
            if fvg_lo <= price <= fvg_hi:
                s = -0.45 * size_mult * age_decay
                score += s
                break
            elif price > fvg_hi and price < fvg_hi + 0.5 * atr:
                s = -0.55 * size_mult * age_decay
                score += s
                break

        # 2. Незакрытые старые FVG в направлении тренда = признак силы
        # Если FVG выше цены (бычьи) и цена не вернулась → бычья сила
        above_bull = sum(1 for lo, hi, a in bullish_fvgs if lo > price and a > 3)
        below_bear = sum(1 for lo, hi, a in bearish_fvgs if hi < price and a > 3)
        if above_bull >= 2:
            score += min(0.20, 0.07 * above_bull)
        if below_bear >= 2:
            score -= min(0.20, 0.07 * below_bear)

        # 3. Вложенный FVG (nested): зона внутри зоны — ускорение
        # Упрощённо: бычий FVG внутри другого бычьего FVG
        nested_bull = 0
        nested_bear = 0
        for i in range(len(bullish_fvgs)):
            lo1, hi1, _ = bullish_fvgs[i]
            for j in range(len(bullish_fvgs)):
                if i == j: continue
                lo2, hi2, _ = bullish_fvgs[j]
                if lo2 >= lo1 and hi2 <= hi1:
                    nested_bull += 1
        for i in range(len(bearish_fvgs)):
            lo1, hi1, _ = bearish_fvgs[i]
            for j in range(len(bearish_fvgs)):
                if i == j: continue
                lo2, hi2, _ = bearish_fvgs[j]
                if lo2 >= lo1 and hi2 <= hi1:
                    nested_bear += 1
        if nested_bull and score > 0:
            score *= 1.25
        if nested_bear and score < 0:
            score *= 1.25

        return max(-1.0, min(1.0, round(score, 4)))
    except Exception:
        return 0.0


def score_order_block(candles: list[HistoricCandle]) -> float:
    """
    Order Block (OB): последняя свеча противоположного направления перед
    импульсом — место где крупняк ставил лимитные заявки.

    Бычий OB: последняя медвежья свеча перед бычьим импульсом ≥ 1.5 ATR.
    Цена возвращается к диапазону этой свечи → бычий сигнал.

    Состояния:
    - Fresh OB (нетронутый): первое касание → максимальный сигнал.
    - Mitigated OB: уже использован (цена прошла насквозь) → смена роли,
      становится Breaker Block (противоположный сигнал).
    - OB + HVN: если OB совпадает с зоной высокого объёма → бонус ×1.3.
    """
    if len(candles) < 30:
        return 0.0
    try:
        def _o(c): return _to_f(c.open)
        def _c(c): return _to_f(c.close)
        def _h(c): return _to_f(c.high)
        def _l(c): return _to_f(c.low)
        def _v(c): return _to_f(c.volume)

        atr = _compute_atr(candles)
        if atr <= 0:
            return 0.0

        price   = _c(candles[-1])
        avg_vol = sum(_v(c) for c in candles[-20:]) / 20

        # Ищем OB в последних 30 барах (не считая текущий)
        lookback = candles[-31:-1]
        score = 0.0

        for i in range(2, len(lookback)):
            c_ob  = lookback[i - 2]   # потенциальный OB
            c_imp = lookback[i - 1]   # импульсная свеча
            # Размер импульса
            imp_size = abs(_c(c_imp) - _o(c_imp))
            if imp_size < 1.2 * atr:
                continue

            is_bull_ob = _c(c_ob) < _o(c_ob) and _c(c_imp) > _o(c_imp)
            is_bear_ob = _c(c_ob) > _o(c_ob) and _c(c_imp) < _o(c_imp)

            if not is_bull_ob and not is_bear_ob:
                continue

            ob_lo = min(_o(c_ob), _c(c_ob), _l(c_ob))
            ob_hi = max(_o(c_ob), _c(c_ob), _h(c_ob))
            age   = len(lookback) - i + 1

            # Проверяем был ли OB пробит насквозь после импульса (Mitigation)
            post_candles = lookback[i:]
            mitigated = False
            for pc in post_candles:
                if is_bull_ob and _l(pc) < ob_lo:
                    mitigated = True; break
                if is_bear_ob and _h(pc) > ob_hi:
                    mitigated = True; break

            age_decay  = max(0.3, 1.0 - age * 0.025)
            imp_mult   = min(1.5, imp_size / atr * 0.5)

            # Объёмный бонус: OB совпадает с зоной повышенного объёма (≈HVN)
            ob_vol = _v(c_ob)
            vol_mult = 1.3 if ob_vol > 1.5 * avg_vol else 1.0

            if is_bull_ob:
                # Fresh OB: цена вернулась в зону снизу
                if not mitigated and ob_lo <= price <= ob_hi + 0.3 * atr:
                    s = 0.50 * age_decay * imp_mult * vol_mult
                    score += s
                # Breaker Block: OB пробит → смена роли на медвежье
                elif mitigated and ob_hi - 0.2 * atr <= price <= ob_hi + 0.5 * atr:
                    s = -0.30 * age_decay * imp_mult
                    score += s

            if is_bear_ob:
                if not mitigated and ob_lo - 0.3 * atr <= price <= ob_hi:
                    s = -0.50 * age_decay * imp_mult * vol_mult
                    score += s
                elif mitigated and ob_lo - 0.5 * atr <= price <= ob_lo + 0.2 * atr:
                    s = 0.30 * age_decay * imp_mult
                    score += s

        return max(-1.0, min(1.0, round(score, 4)))
    except Exception:
        return 0.0


def score_liquidity_sweep(candles: list[HistoricCandle]) -> float:
    """
    Liquidity Sweep = Wyckoff Spring/Upthrust в языке SMC.

    Классификация ликвидности по иерархии:
    - Слабая: внутридневные хаи/лои (5-10 баров)
    - Средняя: хаи/лои 15-30 баров
    - Сильная: хаи/лои 50+ баров

    Сигнал: пробой уровня + возврат за 1-2 бара.
    Чем выше иерархия уровня → тем сильнее сигнал.

    Cascade of Sweeps: несколько sweeps подряд в одном направлении =
    методичный сбор ликвидности → удваивает ожидаемое движение.

    Sweep без объёма = слабый (×0.5). С объёмом > avg = сильный.
    """
    if len(candles) < 60:
        return 0.0
    try:
        def _h(c): return _to_f(c.high)
        def _l(c): return _to_f(c.low)
        def _c(c): return _to_f(c.close)
        def _v(c): return _to_f(c.volume)

        atr     = _compute_atr(candles)
        price   = _c(candles[-1])
        avg_vol = sum(_v(c) for c in candles[-20:]) / 20
        if atr <= 0 or avg_vol <= 0:
            return 0.0

        # Объёмное основание у уровня: прокси для POC/HVN
        def _vol_basis(level: float) -> bool:
            for c in candles[-60:-3]:
                mid = (_h(c) + _l(c)) / 2
                if abs(mid - level) <= 1.0 * atr and _v(c) >= 1.5 * avg_vol:
                    return True
            return False

        # Пространство за уровнем: нет плотного объёма сразу за ним (LVN)
        def _space_beyond(level: float, direction: int) -> bool:
            beyond = [c for c in candles[-60:-3]
                      if (direction > 0 and _l(c) > level)
                      or (direction < 0 and _h(c) < level)]
            if not beyond:
                return True
            avg_b = sum(_v(c) for c in beyond) / len(beyond)
            return avg_b < 1.3 * avg_vol

        # Уровни ликвидности по иерархии
        TIERS: list[tuple[int, float, float]] = [
            (8,  0.30, 2.0),   # слабая: 8 баров, вес 0.30, мин объём ×2
            (20, 0.50, 2.0),   # средняя: 20 баров
            (50, 0.75, 2.0),   # сильная: 50 баров
        ]

        score       = 0.0
        sweep_count_ssl = 0
        sweep_count_bsl = 0

        for bars, weight, vol_thresh in TIERS:
            if len(candles) < bars + 3:
                continue
            window   = candles[-(bars + 3):-2]
            lvl_high = max(_h(c) for c in window)
            lvl_low  = min(_l(c) for c in window)

            cur  = candles[-2]   # потенциальная sweep-свеча
            prev = candles[-1]   # возврат

            cur_vol  = _v(cur)
            prev_vol = _v(prev)

            # SSL Sweep: пробой лоя + возврат вверх
            if _l(cur) < lvl_low and _c(prev) > lvl_low:
                depth_abs = lvl_low - _l(cur)
                depth_pct = depth_abs / (price or 1.0)
                depth_atr = depth_abs / atr

                # Чек-лист: считаем выполненные условия
                conds = 0
                if cur_vol >= vol_thresh * avg_vol:   conds += 1  # 1. объём ×2+
                if depth_pct >= 0.003 and depth_atr >= 0.5: conds += 1  # 2. глубина
                conds += 1                                         # 3. возврат 1 бар (гарантирован)
                if _vol_basis(lvl_low):               conds += 1  # 4. объёмное основание
                if prev_vol >= cur_vol * 0.7:         conds += 1  # 5. объём возврата
                if _space_beyond(lvl_low, +1):        conds += 1  # 6. пространство за

                if conds < 4:
                    continue  # сомнительный sweep

                cond_mult  = 0.70 + (conds - 4) * 0.15
                depth_mult = min(1.4, 0.8 + depth_atr * 0.4)
                s = weight * depth_mult * cond_mult
                score += s
                sweep_count_ssl += 1

            # BSL Sweep: пробой хая + возврат вниз
            if _h(cur) > lvl_high and _c(prev) < lvl_high:
                depth_abs = _h(cur) - lvl_high
                depth_pct = depth_abs / (price or 1.0)
                depth_atr = depth_abs / atr

                conds = 0
                if cur_vol >= vol_thresh * avg_vol:   conds += 1
                if depth_pct >= 0.003 and depth_atr >= 0.5: conds += 1
                conds += 1
                if _vol_basis(lvl_high):              conds += 1
                if prev_vol >= cur_vol * 0.7:         conds += 1
                if _space_beyond(lvl_high, -1):       conds += 1

                if conds < 4:
                    continue

                cond_mult  = 0.70 + (conds - 4) * 0.15
                depth_mult = min(1.4, 0.8 + depth_atr * 0.4)
                s = -(weight * depth_mult * cond_mult)
                score += s
                sweep_count_bsl += 1

        # Cascade of Sweeps: несколько sweeps подряд = ×1.5
        # Ищем последовательные SSL sweeps в последних 10 барах
        cascade_ssl = 0
        cascade_bsl = 0
        for i in range(max(0, len(candles) - 12), len(candles) - 3):
            seg     = candles[max(0, i - 10):i]
            if len(seg) < 5: continue
            lv_lo   = min(_l(c) for c in seg)
            lv_hi   = max(_h(c) for c in seg)
            if _l(candles[i]) < lv_lo and _c(candles[i + 1]) > lv_lo:
                cascade_ssl += 1
            if _h(candles[i]) > lv_hi and _c(candles[i + 1]) < lv_hi:
                cascade_bsl += 1

        if cascade_ssl >= 3 and score > 0:
            score *= 1.5
        if cascade_bsl >= 3 and score < 0:
            score *= 1.5

        return max(-1.0, min(1.0, round(score, 4)))
    except Exception:
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
    # CYBER_CYCLE, DECYCLER, EBSW — классические пересечения нуля, не переработаны → убраны из голосования
    ("FISHER_RSI",     score_fisher_rsi_candle),
    ("KLINGER",        score_klinger_candle),
    ("VZO",            score_vzo_candle),
    ("DONCHIAN",       score_donchian_candle),
    ("TWIGGS",         score_twiggs_candle),
    ("RMI",            score_rmi_candle),
    ("ZSCORE",         score_zscore_candle),
    # Wave 2: новые методы
    ("ZLEMA_SIGNAL",   score_zlema_signal),
    ("T3_SIGNAL",      score_t3_signal),
    ("SINEWAVE_SIGNAL", score_sinewave_signal),
    # MMI_SIGNAL, YZ_VOL_SIGNAL, VR_SIGNAL убраны — режим без направления.
    # MMI → вето в __compute_scores; VR → __noise_stop_scale; YZ → REGIME_WEIGHT_MODS.
    ("SSA_SIGNAL",        score_ssa_signal),
    ("NADARAYA_WATSON",   score_nadaraya_watson),
    ("FRACTIONAL_DIFF",   score_fractional_diff),
    ("HAWKES_SIGNAL",  score_hawkes_signal),
    ("VSA",            score_vsa),
    ("WICK_REJECTION", score_wick_rejection),
    ("TRIANGLE",       score_triangle),
    # VSA/Wyckoff/AMT/OrderFlow — расширенный блок
    ("PRICE_ACCEL",    score_price_accel),
    ("CUMUL_DELTA",    score_cumul_delta),
    ("AMT_POC",        score_amt_poc),
    ("VSA_ABSORPTION",   score_vsa_absorption),
    ("CASCADE",          score_cascade),
    ("IMPULSE_PULLBACK", score_impulse_pullback),
    # Затухание / компрессия / ложный пробой / поглощение на уровне
    ("WANING_IMPULSES",  score_waning_impulses),
    ("VOL_COMPRESSION",  score_vol_compression),
    ("FALSE_BREAKOUT",   score_false_breakout),
    ("LEVEL_ABSORPTION", score_level_absorption),
    # Ишимоку / BB-Keltner / MA / RSI-div / ATR-топливо / Аллигатор
    ("ICHIMOKU_SIGNAL",     score_ichimoku_signal),
    ("BB_KELTNER_SQUEEZE",  score_bb_keltner_squeeze),
    ("MA_ENVELOPE",         score_ma_envelope),
    ("MA_TENSION",          score_ma_tension),
    ("RSI_DIVERGENCE",      score_rsi_divergence),
    ("ATR_EXHAUSTION",      score_atr_exhaustion),
    ("ALLIGATOR",           score_alligator),
    ("MAMA_FAMA",           score_mama_fama_candle),
    ("EHLERS_MODE",         score_ehlers_mode_candle),
    ("CYBER_PHASE",         score_cyber_phase_candle),
    # SMC / ICT
    ("FVG",                 score_fvg),
    ("ORDER_BLOCK",         score_order_block),
    ("LIQUIDITY_SWEEP",     score_liquidity_sweep),
    # Качество уровня: 3 из 5 независимых методов
    ("LEVEL_QUALITY",       score_level_quality),
]

# Структурные методы — используют MultiTFLevelCache инстанса стратегии,
# поэтому вынесены из METHODS и вызываются отдельно в __compute_scores.
LEVEL_CONTEXT_NAME  = "LEVEL_CONTEXT"
MKT_STRUCTURE_NAME  = "MKT_STRUCTURE"
SPRING_NAME         = "SPRING"
STRUCTURAL_METHOD_NAMES = [LEVEL_CONTEXT_NAME, MKT_STRUCTURE_NAME, SPRING_NAME]

OI_SQUEEZE_NAME = "OI_SQUEEZE"
INST_OI_NAME = "INST_OI"
RETAIL_CONTRA_NAME = "RETAIL_CONTRA"
DELTA_QUADRANT_NAME = "DELTA_QUADRANT"
OI_ABSORPTION_NAME = "OI_ABSORPTION"
# Положение индекса (IMOEX) к своим дневным уровням: контрарно у уровней
# (апогей падения у поддержки → лонг-байас), инерция между ними. Провайдерный,
# как INST_OI — считает index_context.py, подключает Trader/дашборд.
INDEX_CONTEXT_NAME = "INDEX_CONTEXT"
# Методы микроструктуры (tradestats/obstats/orderstats, см. tradestats.py).
# Имена соответствуют ключам TradeStatsService.SCORE_FUNCS.
TRADESTATS_METHOD_NAMES = [
    "BS_PRESSURE_TS", "AGGRESSOR_FLOW", "LARGE_IMPACT",
    "VWAP_SIGNAL_TS", "VOL_MOMENTUM_TS", "OB_IMBALANCE", "CANCEL_SIGNAL",
]
# Категориально ведущие методы (см. MICROSTRUCTURE_WEIGHT_BOOST/_AGREE_BOOST выше).
MICROSTRUCTURE_METHOD_NAMES = frozenset(TRADESTATS_METHOD_NAMES + ["HAWKES_SIGNAL"])
CHANGE_POINT_NAME = "CHANGE_POINT"
MULTI_TICKER_NAME = "MULTI_TICKER"
# Три кластерных модели — конкурируют наравне с остальными методами.
# Вычисляются в ClusterModels (cluster_models.py) поверх истории сделок.
M1_NAME = "M1_CLUSTER"
M2_NAME = "M2_CLUSTER"
M3_NAME = "M3_CLUSTER"

BASE_METHOD_NAMES = (
    [name for name, _ in METHODS]
    + STRUCTURAL_METHOD_NAMES
    + [OI_SQUEEZE_NAME, INST_OI_NAME, RETAIL_CONTRA_NAME, DELTA_QUADRANT_NAME, OI_ABSORPTION_NAME]
    + [INDEX_CONTEXT_NAME]
    + TRADESTATS_METHOD_NAMES
    + [CHANGE_POINT_NAME, MULTI_TICKER_NAME]
)
CLUSTER_MODEL_NAMES = [M1_NAME, M2_NAME, M3_NAME]

# ── L2 (5м): полная конфигурация методов ─────────────────────────────────────
# METHOD_TF_CONFIG: для каждого метода — на каких ТФ считается, минимум баров
# для стабильного результата (иначе 0.0 без мусора), вес на данном ТФ.
# Tick-методы (AGGRESSOR_FLOW, BS_PRESSURE_TS и пр.) — только TF=1, т.к.
# смысл в потоке реальных тиков; агрегация в 5м-бар убьёт сигнал.
_MTF5_BUFFER_MINUTES = 500  # временной горизонт L2-буфера в минутах рабочего ТФ
                             # на 1м → 500 баров (100 L2-баров), на 5м → 100 баров (20 L2-баров)
_MTF5_MIN_5M_BARS = 12    # минимум L2-баров для расчёта composite
_MTF5_BLEND_W     = 0.30  # доля L2 в финальном composite (L3 = 0.70)
_MTF5_MOMENTUM_LEN = 4    # длина окна Signal Momentum для L2 composite

# {name: {min_bars, weight_5m}}
# min_bars — минимум 5м-баров, при меньшем — метод молчит (0.0)
# weight_5m — относительный вес на 5м (1.0 = нейтральный)
METHOD_TF_CONFIG: dict[str, dict] = {
    # Трендовые — стабильны на 5м, вес выше
    "PRICE_TREND":    {"min_bars": 10, "weight_5m": 1.10},
    "TREND_QUALITY":  {"min_bars": 15, "weight_5m": 1.20},  # HH/HL меньше шума на 5м
    "ADAPTIVE_MA":    {"min_bars": 12, "weight_5m": 1.10},
    "ZLEMA_SIGNAL":   {"min_bars": 10, "weight_5m": 1.05},
    "T3_SIGNAL":      {"min_bars": 10, "weight_5m": 1.05},
    # Объёмные — на 5м ловят реальный поток, не 1м-шум
    "VOL_MOMENTUM":   {"min_bars": 10, "weight_5m": 1.10},
    "KLINGER":        {"min_bars": 15, "weight_5m": 1.10},
    "VZO":            {"min_bars": 15, "weight_5m": 1.05},
    "DONCHIAN":       {"min_bars": 20, "weight_5m": 1.10},  # структура боковика лучше на 5м
    "MA_ENVELOPE":    {"min_bars": 22, "weight_5m": 1.10},
    "TWIGGS":         {"min_bars": 15, "weight_5m": 1.05},
    "HAWKES_SIGNAL":     {"min_bars": 25, "weight_5m": 1.30},
    "NADARAYA_WATSON":   {"min_bars": 25, "weight_5m": 1.10},
    "FRACTIONAL_DIFF":   {"min_bars": 30, "weight_5m": 1.10},
    "VSA":            {"min_bars": 12, "weight_5m": 1.05},
    "PRICE_ACCEL":    {"min_bars": 8,  "weight_5m": 1.10},  # ускорение/замедление баров
    "CUMUL_DELTA":    {"min_bars": 15, "weight_5m": 1.20},  # накопленная агрессия на 5м надёжнее
    "AMT_POC":        {"min_bars": 20, "weight_5m": 1.10},  # POC смысл на 5м-сессии
    "VSA_ABSORPTION": {"min_bars": 12, "weight_5m": 1.15},  # поглощение на 5м крупнее
    "CASCADE":          {"min_bars": 15, "weight_5m": 1.25},  # каскады видны на 5м лучше
    "IMPULSE_PULLBACK": {"min_bars": 20, "weight_5m": 1.15},  # откат от импульса — среднесрок
    # Паттерновые — на 5м значимее чем на 1м
    "CANDLE_PATTERN": {"min_bars": 8,  "weight_5m": 1.15},
    "WICK_REJECTION": {"min_bars": 8,  "weight_5m": 1.15},
    # Фрактальные — нужно много баров для стабильного Hurst/FDI
    "FRACTAL":        {"min_bars": 40, "weight_5m": 1.25},
    "ENTROPY":        {"min_bars": 20, "weight_5m": 1.10},
    # VWAP — на 1м точнее отражает реальный VWAP сессии
    "VWAP_SIGNAL":    {"min_bars": 10, "weight_5m": 0.85},
    # Цикловые — на 5м менее стабильны при коротком окне
    "SINEWAVE_SIGNAL": {"min_bars": 20, "weight_5m": 0.80},
    "CYBER_CYCLE":    {"min_bars": 30, "weight_5m": 0.80},
    "EBSW":           {"min_bars": 25, "weight_5m": 0.85},
    # ZSCORE — mean-reversion; работает и на 5м
    "ZSCORE":         {"min_bars": 15, "weight_5m": 0.95},
    # RMI/FISHER — на 5м лучше чем на 1м (меньше перевозбуждения)
    "RMI":            {"min_bars": 15, "weight_5m": 1.05},
    "FISHER_RSI":     {"min_bars": 15, "weight_5m": 1.05},
}

# Методы с конфигом на 5м + доступные как чистые функции в METHODS
_MTF5_FUNCS: list[tuple[str, object, int, float]] = [
    (name, fn, METHOD_TF_CONFIG[name]["min_bars"], METHOD_TF_CONFIG[name]["weight_5m"])
    for name, fn in METHODS
    if name in METHOD_TF_CONFIG
]


def _compute_l2_composite(candles_1m: list, factor: int = _MTF_FACTOR) -> tuple[float, dict[str, float]]:
    """
    L2-composite и индивидуальные скоры на виртуальных 5м-барах.
    min_bars соблюдается: метод молчит (0.0) пока не накоплено достаточно 5м-баров.
    Возвращает (composite ∈[-1,1], {method_name: score}).
    """
    try:
        bars_5m = _aggregate_candles(candles_1m, factor)
    except Exception:
        return 0.0, {}
    n5 = len(bars_5m)
    if n5 < _MTF5_MIN_5M_BARS:
        return 0.0, {}

    scores: dict[str, float] = {}
    total_w = 0.0
    total_wv = 0.0

    for name, fn, min_b, w5 in _MTF5_FUNCS:
        if n5 < min_b:
            # Метод молчит — недостаточно данных, не подаём мусор.
            scores[name] = 0.0
            continue
        try:
            sc = fn(bars_5m)
        except Exception:
            sc = 0.0
        scores[name] = sc
        if sc != 0.0:
            total_wv += sc * w5
            total_w  += w5

    # CHANGE_POINT на 5м — отдельный сигнал, не в METHODS
    try:
        closes_5m = [_to_f(c.close) for c in bars_5m]
        cp_l2 = change_point_score(closes_5m) if n5 >= 15 else 0.0
    except Exception:
        cp_l2 = 0.0
    scores["CHANGE_POINT_L2"] = cp_l2
    if cp_l2 != 0.0:
        total_wv += cp_l2 * 1.15  # детектор слома режима ценнее на 5м
        total_w  += 1.15

    # YZ_VOL на 5м — волатильность без 1м-шума; сохраняется отдельно для порогов
    try:
        yz_l2 = score_yz_vol_signal(bars_5m) if n5 >= 12 else 0.0
    except Exception:
        yz_l2 = 0.0
    scores["YZ_VOL_L2"] = yz_l2
    # YZ_VOL не голосует в composite (risk-off не направленный), но хранится для порога

    composite = (total_wv / total_w) if total_w > 0 else 0.0
    return max(-1.0, min(1.0, composite)), scores

def _l2_momentum_mult(buf: list[float], l2_composite: float) -> float:
    """
    Signal Momentum для L2: если 5м-composite последовательно рос/падал N баров
    и теперь разворачивается — штрафуем. Это сигнал ослабления импульса на старшем
    ТФ, который L3 ещё не видит (у него короткое окно).
    Возвращает мультипликатор [0.5, 1.0]: 1.0 = нет штрафа, 0.5 = разворот импульса.
    """
    n = len(buf)
    if n < _MTF5_MOMENTUM_LEN or abs(l2_composite) < 0.05:
        return 1.0
    # Проверяем: все предыдущие N значений росли (или падали), а последнее — наоборот
    prev = buf[-_MTF5_MOMENTUM_LEN - 1:-1]
    if len(prev) < _MTF5_MOMENTUM_LEN:
        return 1.0
    all_up   = all(prev[i] < prev[i + 1] for i in range(len(prev) - 1))
    all_down = all(prev[i] > prev[i + 1] for i in range(len(prev) - 1))
    if all_up and l2_composite < prev[-1]:
        return 0.65   # импульс рос, теперь падает → ослабляем
    if all_down and l2_composite > prev[-1]:
        return 0.65   # импульс падал, теперь растёт → ослабляем контртрендовый сигнал
    return 1.0


# M1/M2/M3 считаются и трекаются (вес/история/attribution) наравне с базовыми
# методами — чтобы их качество было сравнимо с остальными в архиве и при
# обучении весов. Но в живой композит (то, что реально открывает сделки) они
# НЕ входят: они строятся из тех же base_scores, что и остальные методы, и их
# сложение с этими же методами в одной взвешенной сумме означало бы повторный
# счёт уже учтённого сигнала. См. __compute_composite — composite считается
# только по BASE_METHOD_NAMES, M1/M2/M3 копятся отдельно для будущего
# самостоятельного бэктеста/решающего слоя.
ALL_METHOD_NAMES = BASE_METHOD_NAMES + CLUSTER_MODEL_NAMES

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

# Лимитный вход: смещение от рыночной цены (0.025% ≈ полспреда фьючерса).
# LONG покупает ниже last.close, SHORT продаёт выше — экономия на спреде.
LIMIT_ENTRY_OFFSET_PCT = 0.00025

# Минимальное соотношение тейк/стоп. При R:R < 1.5 и WR 46% EV отрицателен.
# Если ATR-расчёт даёт меньший тейк, принудительно расширяем до 1.5× стопа.
MIN_TAKE_STOP_RATIO = 1.5

# Минимальная дистанция стопа. При стопе < 0.6% комиссия RT (~0.08%) = 13%+ от стопа.
MIN_STOP_DIST_PCT = 0.006

AUTO_ATR_TAKE_KS = (2.5, 3.0, 3.5)
# Нижняя граница была 1.0 — на минутных барах atr_pct часто ~0.4-0.6%, и
# stop_dist=1.0*atr_pct получался теснее fixed-стопа (1.5%): walk-forward
# регулярно выбирал эту границу как "лучшую" по шумному прошлому окну,
# а вживую/на новых данных это просто частые выбивания шумом до того, как
# сигнал успевал сработать (см. короткое avg-время удержания ATR-сделок
# в бэктесте — 2-4 раза короче fixed).
# Диапазон сужен (2.5-3.5 вместо 2.0-4.0): при 45 кандидатах на eval-окне
# 12-16 сделок argmax стабильно выигрывал шум — отсюда fixed >> WF.
# Меньше степеней свободы = меньше шансов для optimizer's curse.
AUTO_ATR_STOP_KS = (1.5, 2.0, 2.5)
AUTO_ATR_MIN_TRADES = 20           # меньше сделок на истории — авто-подбору не доверяем
                                    # (sweep по 3-9 исходам — это подбор по шуму, не сигнал)
ATR_SHRINK_K = 8                   # псевдо-наблюдения к fixed-бейзлайну (как REGIME_SHRINKAGE_K в history.py) —
                                    # тянет оценку ATR-кандидата на маленькой выборке к консервативному fixed,
                                    # без этого argmax по 27 кандидатам (3×3×3) почти всегда выбирает
                                    # комбинацию, выигравшую за счёт пары случайных сделок в eval-окне
                                    # ("optimizer's curse") — отсюда систематический проигрыш ATR живому fixed-режиму.
ATR_MIN_EDGE_SEM = 2.0              # переключаться на ATR-кандидата только если он бьёт fixed больше чем на
                                     # 2 своих SEM — 1.0 было слишком мягко, шум регулярно проходил порог
# Сколько последних past_signals использовать для eval-окна.
# None = весь past (старое поведение). 80 = только последние 80 сигналов:
# старые режимные данные не должны тянуть параметры к прошлым условиям.
ATR_EVAL_LOOKBACK = 80

# _compute_atr меряет волатильность ОДНОГО бара (TR-квантиль), а сделка
# держится десятки баров до take/stop/timeout (max_bars) — без масштабирования
# take_k/stop_k калибруются под однобарное движение, а не под фактическую
# экспозицию за время удержания. Кумулятивный разброс растёт с числом баров N
# примерно как N**scale_exp (0.5 — чистое случайное блуждание; меньше — если
# внутри дня есть mean-reversion, больше — если momentum). ATR_SCALE_HOLDING_BARS
# — оценка типичного N для масштабирования; берём существующий max_bars
# (одно и то же число уже используется и в backtest_barriers, и неявно
# ограничивает живую сделку через __recalc_auto_atr/backtest_scan_signals) —
# не лог реальных медианных длительностей, чтобы не тащить отдельный сбор
# статистики на первом шаге; можно уточнить позже, если экспонента приживётся.
ATR_SCALE_HOLDING_BARS = 8   # медианное удержание ~40м = ~8 баров M5
# Диапазон сужен (0.3-0.5 вместо 0.0-0.6): убраны крайние значения,
# 0.0 (без масштабирования) и 0.6 (сильное); grid стал 3×3×3=27 вместо 3×3×5=45.
AUTO_ATR_SCALE_EXPS = (0.3, 0.4, 0.5)


def _shrunk_atr_score(trades: list[dict], fixed_pct: float, k: int = ATR_SHRINK_K) -> tuple[float, float]:
    """Shrinkage-оценка expectancy ATR-кандидата (см. ATR_SHRINK_K) — тянет
    к fixed_pct силой k псевдо-наблюдений, чтобы argmax по сетке не выбирал
    комбинацию, выигравшую за счёт пары случайных сделок на маленьком
    eval-окне. Возвращает (shrunk_score, sem)."""
    n = len(trades)
    if n == 0:
        return fixed_pct, 0.0
    vals = [t["net_pct"] for t in trades]
    raw = sum(vals) / n
    sem = statistics.pstdev(vals) / (n ** 0.5) if n > 1 else abs(raw)
    shrunk = (n * raw + k * fixed_pct) / (n + k)
    return shrunk, sem


def _compute_ic(scores: list[float], closes: list[float], forward_lag: int) -> float:
    """
    Pearson IC между scores[t] и return(t, forward_lag).
    Форвардный возврат: (close[t+lag] - close[t]) / close[t].
    Только бары где есть и score и форвардный возврат.
    """
    if len(scores) < forward_lag + 10 or len(closes) < len(scores) + forward_lag:
        return 0.0
    n = len(scores) - forward_lag
    xs = scores[:n]
    ys = [(closes[t + forward_lag] - closes[t]) / closes[t] if closes[t] != 0 else 0.0
          for t in range(n)]
    if len(xs) < 10:
        return 0.0
    mean_x = sum(xs) / len(xs)
    mean_y = sum(ys) / len(ys)
    cov = sum((x - mean_x) * (y - mean_y) for x, y in zip(xs, ys))
    var_x = sum((x - mean_x) ** 2 for x in xs)
    var_y = sum((y - mean_y) ** 2 for y in ys)
    denom = (var_x * var_y) ** 0.5
    return cov / denom if denom > 1e-10 else 0.0


def _compute_ic_quality(aligned_scores: list[float], qualities: list[float]) -> float:
    """
    Pearson IC между aligned_score на входе в сделку и quality (MFE/(MFE+MAE)).
    aligned_score = score * direction_sign (+1 для LONG, -1 для SHORT):
    нормализует шкалу так, что «сильный сигнал в нужную сторону» → положительный
    aligned_score вне зависимости от типа сделки.

    В отличие от _compute_ic (corr со future price return), здесь целевая
    переменная — реальное торговое качество входа. Метод может иметь слабый
    price IC но стабильно выбирать хорошие точки входа (высокий IC_quality).
    """
    n = len(aligned_scores)
    if n < 10 or len(qualities) != n:
        return 0.0
    mean_x = sum(aligned_scores) / n
    mean_y = sum(qualities) / n
    cov  = sum((x - mean_x) * (y - mean_y) for x, y in zip(aligned_scores, qualities))
    vx   = sum((x - mean_x) ** 2 for x in aligned_scores)
    vy   = sum((y - mean_y) ** 2 for y in qualities)
    denom = (vx * vy) ** 0.5
    return cov / denom if denom > 1e-10 else 0.0


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

        self._disabled_methods: set[str] = set()
        self._inverted_methods: set[str] = set()
        self.__threshold = float(s.get("SIGNAL_THRESHOLD", SIGNAL_THRESHOLD))
        self.__long_take = Decimal(s.get("LONG_TAKE", "1.015"))
        self.__long_stop = Decimal(s.get("LONG_STOP", "0.985"))
        self.__short_take = Decimal(s.get("SHORT_TAKE", "0.985"))
        self.__short_stop = Decimal(s.get("SHORT_STOP", "1.015"))
        # Дефолты из settings.ini — нужны, чтобы set_take_stop_overrides могла
        # сбросить значение обратно, когда оверрайд с дашборда убрали (null).
        self.__default_long_take = self.__long_take
        self.__default_long_stop = self.__long_stop
        self.__default_short_take = self.__short_take
        self.__default_short_stop = self.__short_stop
        self.__signal_only = s.get("SIGNAL_ONLY", "0") == "1"

        # ATR-based take/stop: если в settings.ini заданы оба коэффициента —
        # уровни считаются от ATR (динамически, под текущую волатильность);
        # иначе остаются фиксированные множители LONG_TAKE/STOP (обратная совместимость).
        self.__atr_take_k = float(s["ATR_TAKE_K"]) if "ATR_TAKE_K" in s else None
        self.__atr_stop_k = float(s["ATR_STOP_K"]) if "ATR_STOP_K" in s else None
        self.__atr_scale_exp = float(s["ATR_SCALE_EXP"]) if "ATR_SCALE_EXP" in s else None

        # На 1-мин свечах используем увеличенное окно чтобы покрыть то же
        # календарное время что и CANDLE_WINDOW баров на 5-мин (30×5 = 150 мин).
        interval_min = getattr(settings, "candle_interval_min", 5)
        self.__interval_min = interval_min
        self.__candle_window = CANDLE_WINDOW if interval_min >= 5 else CANDLE_WINDOW * 5
        self.__min_candles = MIN_CANDLES if interval_min >= 5 else MIN_CANDLES * 3

        self.__candles: list[HistoricCandle] = []
        self.__open_trade: Optional[OpenTrade] = None
        self.__weights: dict[str, MethodWeight] = self.__load_weights()
        self.__regime_weights: dict[str, dict[str, MethodWeight]] = self.__load_regime_weights()
        # IC-prior: предсказательная сила метода по ценовой динамике.
        # P4: per-regime — {regime: {method: ICPrior}}. Глобальный слой ("__global__")
        # — фолбэк для ещё не виденных режимов.
        self.__ic_priors: dict[str, dict[str, ICPrior]] = {
            "__global__": {name: ICPrior() for name in ALL_METHOD_NAMES}
        }
        for _rg in REGIMES:
            self.__ic_priors[_rg] = {name: ICPrior() for name in ALL_METHOD_NAMES}
        self.__load_global_ic_prior()  # warm-start: агрегированный sign-IC по всем тикерам
        # P1: per-method лаг (бары) = естественный горизонт // interval_min.
        self.__ic_lags: dict[str, int] = {
            name: _METHOD_IC_TARGET_MINUTES.get(name, _IC_DEFAULT_TARGET_MINUTES)
                  // max(1, interval_min)
            for name in ALL_METHOD_NAMES
        }
        # Буфер скоров и closes для rolling IC
        self.__ic_score_buf: dict[str, list[float]] = {name: [] for name in ALL_METHOD_NAMES}
        self.__ic_close_buf: list[float] = []
        self.__ic_bar_counter: int = 0
        # Trade-level IC: aligned_score на входе → quality.
        # Ключ метода → список aligned_scores за последние IC_QUALITY_WINDOW сделок.
        self.__ic_trade_score_buf: dict[str, list[float]] = {name: [] for name in ALL_METHOD_NAMES}
        self.__ic_trade_quality_buf: list[float] = []
        self.__rolling_quality: float = self.__load_rolling_quality()
        # per-regime EWA: ключ = режим, значение = скользящее качество только по сделкам в этом режиме.
        # Используется в __effective_threshold вместо глобального — чтобы убыточная серия в ranging
        # не ужесточала порог для trending_up и наоборот.
        self.__rolling_quality_by_regime: dict[str, float] = self.__load_rolling_quality_by_regime()
        self.__confidence: float = 0.7
        # Буфер скоров за последние _LAG_HISTORY_LEN баров — для lag-коррекции.
        # Хранит scores_for_composite (после нормализации, до взвешивания),
        # чтобы для метода с лагом k читать правильный исторический скор.
        self.__score_history: list[list[float]] = []
        # Lasso prior — data/lasso_weights.json, keyed by figi.
        # Загружается один раз на старте; обновить можно reload_lasso_priors().
        self.__lasso_priors: dict[str, float] = self.__load_lasso_priors()
        # Пер-тикерные Hedge-веса методов — второй слой адаптации поверх глобального.
        # Обновляются в close_trade так же как __weights, но отдельно для каждой
        # стратегии (тикера): один метод может быть хорош на BR и плох на Si.
        self.__ticker_weights: dict[str, MethodWeight] = self.__load_ticker_weights()
        self.__squeeze_provider: Optional[SqueezeProvider] = None
        self.__inst_oi_provider: Optional[ScoreProvider] = None
        self.__retail_contra_provider: Optional[ScoreProvider] = None
        self.__delta_quadrant_provider: Optional[ScoreProvider] = None
        self.__oi_absorption_provider: Optional[ScoreProvider] = None
        self.__index_context_provider: Optional[ScoreProvider] = None
        self.__tradestats_provider: Optional[TradeStatsProvider] = None
        self.__multi_ticker_provider: Optional[MultiTickerProvider] = None
        self.__regime_confidence: float = 1.0
        self.__last_regime: str = "ranging"
        self.__regime_stable_bars: int = 0
        self.__last_scores: dict[str, float] = {}
        # Теневые скоры: то же самое, но БЕЗ гейта по _disabled_methods (только
        # инверсия) — нужны, чтобы видеть гипотетический винрейт выключенного
        # метода в статистике, не давая ему при этом голосовать в композите
        # или участвовать в обучении весов (Hedge/IC/Lasso используют
        # __last_scores, не это поле).
        self.__last_scores_shadow: dict[str, float] = {}
        self.__last_composite: float = 0.0
        self.__composite_history: list[float] = []   # буфер для gate условия 3
        self.__last_playbooks: list[str] = []
        self.__last_entropy_score: float = 0.0
        self.__last_yz_vol_l2: float = 0.0
        # P5: единый L1-скор [-1,1], влияет на пороги и согласие методов.
        self.__l1_score: float = 0.0
        # P3: статистика плейбуков {regime: {playbook: {n,wins,sum_r,mfe_list,mae_list}}}
        self.__playbook_stats: dict[str, dict[str, dict]] = {}
        self.__playbook_disabled: dict[str, set] = {}
        # P6: жизненный цикл нарратива {ticker: {regime: state}} + счётчик баров.
        self.__narrative_lifecycle: dict[str, dict[str, str]] = {}
        self.__narrative_bars_since_confirmed: dict[str, dict[str, int]] = {}
        # P8: адаптивный порог сигнала.
        self.__threshold_adapters: ThresholdAdapters = ThresholdAdapters()
        # P9: распределение MFE {regime: {playbook: [mfe,...]}}
        self.__mfe_distribution: dict[str, dict[str, list]] = {}
        # P10: детектор статистического слома.
        self.__stat_break: StatBreakDetector = StatBreakDetector()
        # HistoryStore + PercentileCalibrator — опциональны, инжектируются извне
        self.__history = None
        self.__calibrator = None
        self.__db = None
        # MethodCalibrator — адаптивные параметры индикаторов под тикер (еженедельно)
        self.__method_calibrator = None
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
        self.__auto_atr_scale_exp: Optional[float] = None
        self.__auto_atr_recalc_date: Optional[object] = None
        # L1: расширенный буфер для структурного контекста (дни/недели).
        # Хранит _L1_MA_DAYS+5 торговых дней свечей; обновляется каждый бар в
        # analyze_candles и устанавливается явно в backtest_scan_signals.
        bars_per_day = int(6.5 * 60 / interval_min)
        self.__l1_buffer_size: int = (_L1_LEVEL_DAYS + 5) * bars_per_day  # покрывает и MA50, и MTF-уровни полгода
        self.__l1_buffer: list = []
        # Кэш L1-контекста (пересчитывается вместе с тяжёлыми операциями):
        self.__l1_pct: float = 0.5           # percentile цены в N-дневном диапазоне
        self.__l1_above_ma50: bool = True
        self.__l1_trending_up: bool = False
        self.__l1_trending_down: bool = False
        self.__l1_data_ready: bool = False   # False пока нет _L1_MA_DAYS дней истории
        # Многогоризонтный кеш уровней (неделя/месяц/полгода)
        self.__level_cache: MultiTFLevelCache = MultiTFLevelCache()
        # ATR-exhaustion: дневной ход в % от цены (знаковый, +вверх/-вниз).
        self.__daily_open_price: float = 0.0
        self.__daily_open_date: Optional[object] = None
        self.__day_move_pct: float = 0.0
        self.__last_atr_pct: float = 0.0
        # дневной диапазон для корректного знаменателя exhaustion
        self.__daily_high: float = 0.0
        self.__daily_low: float = float("inf")
        self.__daily_atr_buf: list[float] = []   # буфер последних 10 дневных ATR
        self.__daily_atr: float = 0.0            # скользящее среднее дневного ATR (%)
        # Дневной режим (старший ТФ) — контекст для DAILY_TREND_GATE в trader.py.
        # Накапливаем закрытия ПО ДНЯМ на смене дня и классифицируем тем же
        # classify_regime, что и внутридневной. Пока дней < минимума — режим "" и
        # гейт не срабатывает (как и было, пока ключ вообще не заполнялся).
        self.__daily_close_buf: list[float] = []  # закрытия последних дней
        self.__daily_regime: str = ""
        # Кэш тяжёлых операций: пересчитываем раз в N баров, между ними — старое значение.
        # RQA O(n²), wavelet O(n log n), regime (CUSUM+PELT+Z-score) — всё CPU-bound.
        # На 1м-свечах N=5 (обновление каждые 5 минут), на 5м — N=3.
        self.__heavy_cache_n: int = 5 if interval_min == 1 else 3
        self.__heavy_bar_counter: int = 0
        self.__cached_rqa_mult: float = 1.0
        self.__cached_wavelet_mult: float = 1.0
        self.__cached_regime_probs: dict = {"ranging": 1.0}
        self.__cached_phase: str = "accumulation"
        self.__cached_phase_conf: float = 0.3
        self.__cached_change_point: float = 0.0
        self.__cached_mtf_trend: float = 0.0
        self.__cached_mtf5_composite: float = 0.0
        self.__cached_mtf5_scores: dict[str, float] = {}
        # Signal Momentum L2: история composite на 5м для детекции ослабления
        self.__mtf5_momentum_buf: list[float] = []
        # Размер буфера для L2 в барах рабочего ТФ: одинаковый временной
        # горизонт независимо от interval_min.
        self.__mtf5_buffer_bars: int = max(
            _MTF5_MIN_5M_BARS * _MTF_FACTOR,
            _MTF5_BUFFER_MINUTES // max(1, interval_min),
        )
        # Narrative-гейт (narrative.py): FSM с памятью между барами + EWA-доверие
        # по (narrative, regime). Локальный, без внешних провайдеров — в отличие
        # от history/calibrator, не нуждается в set_*-инъекции.
        self.__narrative_state = NarrativeState()
        self.__narrative_weights = NarrativeWeights()
        self.__narrative_thresholds = NarrativeThresholds()
        self.__last_narrative_tags: dict = {}

        # Счётчики отклонений — сбрасываются при каждом бэктесте через reset_rejection_stats()
        self.rejection_stats: dict[str, int] = {
            "below_threshold": 0,
            "methods_disagree": 0,   # включает все 4 условия гейта
            "gate_net_agreement": 0,  # условие 1b: IC-взвешенный net
            "gate_group_diversity": 0,  # условие 2: < 3 групп согласны
            "gate_composite_std": 0,    # условие 3: нестабильный composite
            "gate_l2_conflict": 0,      # условие 4: L2/L3 конфликт
            "gate_m3_veto": 0,          # P7: вето кластерных моделей M1/M2/M3
            "narrative_blocked": 0,
            "liquidity": 0,
        }

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

    def reset_weights_cold(self) -> None:
        """Сброс Hedge-весов (глобальных и режимных) в холодный старт — для
        бэктеста, где обучение (в backtest_barriers) должно идти с нуля, а не
        от загруженных из oi_weights.json живых весов. Инстанс бэктеста
        одноразовый, live-файл не трогается."""
        self.__weights = {name: MethodWeight() for name in ALL_METHOD_NAMES}
        self.__regime_weights = {regime: {name: MethodWeight() for name in ALL_METHOD_NAMES}
                                 for regime in REGIMES}
        self.__rolling_quality = 0.5

    def weights_snapshot(self) -> dict:
        """Текущее состояние Hedge-весов (global + по режимам) — снимается
        дашбордом ПОСЛЕ обучающего прохода backtest_barriers (обучение весов
        живёт именно там, не в backtest_scan_signals)."""
        def _wsnap(wd):
            return {n: {"weight": round(w.weight, 4), "total": w.total,
                        "sum_quality": round(w.sum_quality, 4)}
                    for n, w in wd.items()}
        return {
            "figi": self.__settings.figi,
            "ticker": self.__settings.ticker,
            "global": _wsnap(self.__weights),
            "regimes": {rg: _wsnap(m) for rg, m in self.__regime_weights.items()},
        }

    def set_disabled_methods(self, names: list[str] | set[str]) -> None:
        """Отключить указанные методы голосования для прогона бэктеста."""
        self._disabled_methods = set(names)

    def set_inverted_methods(self, names: list[str] | set[str]) -> None:
        """Методы-контр-индикаторы: их скор умножается на -1 вместо обнуления."""
        self._inverted_methods = set(names)

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
        None означает "оверрайда нет" — сбрасывает множитель обратно на
        значение из settings.ini, а не оставляет прежний (иначе снятие
        оверрайда с дашборда молча игнорировалось бы навсегда).
        """
        self.__long_take = long_take if long_take is not None else self.__default_long_take
        self.__long_stop = long_stop if long_stop is not None else self.__default_long_stop
        self.__short_take = short_take if short_take is not None else self.__default_short_take
        self.__short_stop = short_stop if short_stop is not None else self.__default_short_stop

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

    def set_delta_quadrant_provider(self, provider: Optional[ScoreProvider]) -> None:
        """provider(ticker) -> DELTA_QUADRANT score, см. oi_layers.py.OiLayersService.delta_quadrant_score."""
        self.__delta_quadrant_provider = provider

    def set_oi_absorption_provider(self, provider: Optional[ScoreProvider]) -> None:
        """provider(ticker) -> OI_ABSORPTION score, см. oi_layers.py.OiLayersService.absorption_score."""
        self.__oi_absorption_provider = provider

    def set_index_context_provider(self, provider: Optional[ScoreProvider]) -> None:
        """provider(ticker) -> INDEX_CONTEXT score: положение индекса к своим
        дневным уровням (index_context.py). Без провайдера метод молчит."""
        self.__index_context_provider = provider

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
        # Прогрев калибратора из полной истории баров (bar-by-bar replay).
        # daily_scores даёт ≤90 точек (1/день) — этого мало для новых инструментов.
        # Здесь прокручиваем все исторические свечи через scan_method_scores и
        # наполняем калибратор реальным распределением скоров по конкретному тикеру.
        if calibrator is not None and self.__atr_history_provider is not None:
            self.__warm_up_calibrator_from_candles(ticker, calibrator)
        # MethodCalibrator: адаптивный подбор параметров индикаторов под тикер.
        # Запускается раз в 7 дней; параметры сохраняются в method_params.json.
        try:
            from method_calibrator import MethodCalibrator
            import os as _os
            _mc_path = _os.path.join(_os.path.dirname(__file__), "../../method_params.json")
            mc = MethodCalibrator(store_path=_mc_path, window=self.__candle_window)
            if mc.needs_recalc(ticker) and self.__atr_history_provider is not None:
                _mc_candles = self.__atr_history_provider(ticker)
                if _mc_candles and len(_mc_candles) >= self.__candle_window + 20:
                    _raw = [
                        {"close": _to_f(c.close), "high": _to_f(c.high),
                         "low": _to_f(c.low), "vol": float(c.volume)}
                        for c in _mc_candles
                    ]
                    mc.calibrate(ticker, _raw)
            self.__method_calibrator = mc
        except Exception as _mc_exc:
            logger.warning(f"{ticker}: MethodCalibrator init/calibrate failed: {_mc_exc}")
        # Загрузка динамических режимных модификаторов из истории сделок
        self._reload_dynamic_regime_mods()
        # Инициализация кластерных моделей M1/M2/M3
        self.__cluster_models = ClusterModels(history, self.__settings.ticker)

    def __warm_up_calibrator_from_candles(self, ticker: str, calibrator) -> None:
        """
        Bar-by-bar replay исторических свечей → populate calibrator.
        Вместо ≤90 daily snapshots получаем тысячи реальных наблюдений
        скоров, специфичных для этого тикера/режима/волатильности.
        Сэмплируем каждый STEP-й бар чтобы не делать полный O(N²) проход.
        """
        try:
            candles = self.__atr_history_provider(ticker)
        except Exception as exc:
            logger.warning(f"{ticker}: не удалось получить свечи для bar-calibration: {exc}")
            return
        if not candles or len(candles) < self.__candle_window + 2:
            logger.info(f"{ticker}: слишком мало свечей для bar-calibration ({len(candles) if candles else 0})")
            return

        # Шаг сэмплирования: не нужно каждый бар — соседние корреляции высоки.
        # STEP=3 даёт ~1000 точек из 3000 свечей за AUTO_ATR_HISTORY_DAYS.
        STEP = 3
        rows = self.scan_method_scores(candles)
        sampled = rows[::STEP]
        n_updated = 0
        for row in sampled:
            for name, s in row["scores"].items():
                calibrator.update(ticker, name, s)
            n_updated += 1
        logger.info(
            f"{ticker}: bar-calibration из {len(candles)} свечей → "
            f"{n_updated} баров × {len(ALL_METHOD_NAMES)} методов"
        )

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
        if len(self.__candles) > self.__candle_window:
            self.__candles = self.__candles[-self.__candle_window:]
        # L1-буфер: накапливаем длинную историю для структурного контекста
        self.__l1_buffer.extend(candles)
        if len(self.__l1_buffer) > self.__l1_buffer_size:
            self.__l1_buffer = self.__l1_buffer[-self.__l1_buffer_size:]
        # Многогоризонтный кеш уровней — обновляем по TTL (не каждый бар)
        self.__level_cache.update(self.__l1_buffer)

        # накапливаем историю открытой сделки для MFE/MAE
        if self.__open_trade:
            for c in candles:
                self.__open_trade.add_candle(c)
            if len(self.__open_trade.after_candles) >= MFE_MAE_BARS:
                self.__record_outcome()

        if len(self.__candles) < self.__min_candles:
            return None

        # ATR-фильтр: если средний ход меньше комиссии×фактор — движение не
        # окупает торговлю, сигнал не выдаём (защита от "мёртвых" инструментов).
        atr_pct = _compute_atr(self.__candles)
        self.__last_atr_pct = atr_pct
        if atr_pct < commission_rt(self.__settings.is_future) * MIN_ATR_FACTOR:
            logger.debug(f"{self.__settings.figi}: пропуск — ATR {atr_pct:.4f} ниже комиссии×{MIN_ATR_FACTOR}")
            return None

        # ATR-exhaustion: обновляем дневной open и дневной ход
        if self.__candles:
            last_c = self.__candles[-1]
            cur_day = last_c.time.date()
            if cur_day != self.__daily_open_date:
                # новый день — сохраняем вчерашний дневной ATR в буфер
                if self.__daily_high > 0 and self.__daily_low < float("inf") and self.__daily_open_price > 0:
                    d_atr = (self.__daily_high - self.__daily_low) / self.__daily_open_price * 100
                    self.__daily_atr_buf.append(d_atr)
                    if len(self.__daily_atr_buf) > 10:
                        self.__daily_atr_buf.pop(0)
                    self.__daily_atr = sum(self.__daily_atr_buf) / len(self.__daily_atr_buf)
                # закрытие завершившегося дня → буфер дневных закрытий, режим старшего ТФ
                if self.__daily_open_price > 0:
                    self.__daily_close_buf.append(_to_f(last_c.open))  # open нового дня ≈ close прошлого
                    if len(self.__daily_close_buf) > 60:
                        self.__daily_close_buf.pop(0)
                    if len(self.__daily_close_buf) >= 10:
                        self.__daily_regime, _ = classify_regime(self.__daily_close_buf)
                self.__daily_open_date = cur_day
                self.__daily_open_price = _to_f(last_c.open)
                self.__daily_high = _to_f(last_c.high)
                self.__daily_low = _to_f(last_c.low)
            else:
                self.__daily_high = max(self.__daily_high, _to_f(last_c.high))
                self.__daily_low = min(self.__daily_low, _to_f(last_c.low))
            close_px = _to_f(last_c.close)
            if self.__daily_open_price > 0:
                self.__day_move_pct = (close_px - self.__daily_open_price) / self.__daily_open_price * 100

        # вычисляем composite
        composite, scores = self.__compute_composite()
        logger.debug(
            f"{self.__settings.figi} composite={composite:.3f} "
            f"scores={dict(zip(ALL_METHOD_NAMES, [round(s, 3) for s in scores]))}"
        )

        # порог адаптируется под режим рынка, поверх — прогрев/плохая полоса
        adaptive = _adaptive_threshold(self.__threshold, self.__last_regime)
        effective_threshold = self.__effective_threshold(adaptive)

        # Энтропийная коррекция: низкая энтропия → порог снижается до ×0.85;
        # высокая (хаос) → ×1.25.
        ent = self.__last_entropy_score
        if ent > 0.2:
            effective_threshold *= max(0.85, 1.0 - ent * 0.3)
        elif ent < -0.2:
            effective_threshold *= min(1.25, 1.0 + abs(ent) * 0.5)

        # YZ_VOL на L2 (5м): высокая волатильность → повышаем порог (шум выше).
        yz_l2 = self.__last_yz_vol_l2
        if yz_l2 < -0.3:   # vol высокая (score_yz_vol_signal < 0 при >80-м перцентиле)
            effective_threshold *= min(1.30, 1.0 + abs(yz_l2) * 0.4)

        # Асимметричный порог: L2 бычий → шорты требуют больше подтверждений,
        # и наоборот. Шаг от 0 до ×1.20 в зависимости от силы L2.
        # P5/P8/P10/P1: единый адаптивный порог по направлению.
        _hour = self.__candles[-1].time.hour if self.__candles else 0
        threshold_long  = self.__effective_signal_threshold(
            effective_threshold, SignalType.LONG, self.__last_regime, _hour)
        threshold_short = self.__effective_signal_threshold(
            effective_threshold, SignalType.SHORT, self.__last_regime, _hour)
        l2_comp = self.__cached_mtf5_composite
        if abs(l2_comp) > 0.1:
            asym = min(0.20, abs(l2_comp) * 0.25)
            if l2_comp > 0:      # L2 бычий: лонги легче, шорты труднее
                threshold_long  *= max(0.85, 1.0 - asym)
                threshold_short *= min(1.20, 1.0 + asym)
            else:                # L2 медвежий: шорты легче, лонги труднее
                threshold_short *= max(0.85, 1.0 - asym)
                threshold_long  *= min(1.20, 1.0 + asym)

        direction: Optional[SignalType] = None
        if composite >= threshold_long:
            direction = SignalType.LONG
        elif self.__settings.short_enabled_flag and composite <= -threshold_short:
            direction = SignalType.SHORT

        if direction is None:
            self.rejection_stats["below_threshold"] += 1
            return None

        _agree, _reason = self.__methods_agree_with_reason(scores, direction)
        if not _agree:
            logger.debug(f"{self.__settings.figi}: сигнал {direction} отфильтрован — {_reason}")
            self.rejection_stats["methods_disagree"] += 1
            if _reason in self.rejection_stats:
                self.rejection_stats[_reason] += 1
            return None

        if not self.__narrative_allows(direction, composite=composite, threshold=threshold_long if direction == SignalType.LONG else threshold_short):
            logger.debug(f"{self.__settings.figi}: сигнал {direction} отфильтрован — сюжет не сложился ({self.__narrative_state.name})")
            self.rejection_stats["narrative_blocked"] += 1
            return None

        if not self.__liquidity_ok():
            logger.debug(f"{self.__settings.figi}: сигнал {direction} отфильтрован — тонкая свеча (низкий объём)")
            self.rejection_stats["liquidity"] += 1
            return None

        if LEVEL_VOLUME_GATE_ENABLED:
            _lvg = level_volume_gate(
                candles=self.__candles,
                l1_buffer=self.__l1_buffer,
                atr=atr_pct * (_to_f(self.__candles[-1].close) if self.__candles else 1.0),
            )
            if not _lvg.passed:
                logger.debug(
                    f"{self.__settings.figi}: сигнал {direction} отфильтрован — "
                    f"level_volume_gate ({_lvg.reason}, "
                    f"dist_atr={_lvg.dist_atr:.2f}, strength={_lvg.strength:.2f})"
                )
                self.rejection_stats.setdefault("level_volume_gate", 0)
                self.rejection_stats["level_volume_gate"] += 1
                return None

        # Gate: «мусорная» микроструктура — три сильных микроструктурных метода
        # против направления → рынок реально движется в другую сторону.
        # ENTROPY, VSA, KLINGER показывают наибольший Δ WR (8-8.7%) при
        # голосовании против направления; комбинация всех трёх — надёжный фильтр.
        _dir_sign = 1 if direction == SignalType.LONG else -1
        _entropy = scores.get("ENTROPY", 0.0) * _dir_sign
        _vsa     = scores.get("VSA",     0.0) * _dir_sign
        _klinger = scores.get("KLINGER", 0.0) * _dir_sign
        _ms_against = sum(1 for v in (_entropy, _vsa, _klinger) if v < 0.0)
        if _ms_against >= 2:
            logger.debug(
                f"{self.__settings.figi}: сигнал {direction} отфильтрован — "
                f"entropy={_entropy:.3f} vsa={_vsa:.3f} klinger={_klinger:.3f} (микроструктура против)"
            )
            self.rejection_stats.setdefault("gate_microstructure", 0)
            self.rejection_stats["gate_microstructure"] += 1
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
        self.__candles = candles[-self.__candle_window:]

    def backtest_quality(self, candles: list[HistoricCandle], lookahead: int = MFE_MAE_BARS) -> tuple[float, int]:
        """
        Прогон композита по исторической свечной выгрузке без реальных
        сделок — оценка, "дают ли модели хороший %" на этом тикере ДО того,
        как пускать его в реальную торговлю (гейт BACKTEST_QUALITY_MIN на
        реальные ордера). Реальное состояние стратегии (свечи/открытая
        сделка) не трогает — окно подменяется только на время вызова.

        Раньше отбор виртуальных сделок (composite>=self.__threshold) и
        MFE/MAE-расчёт (максимум/минимум по всему lookahead-окну без учёта
        стопа) отличались от того, что реально доходит до реальных денег
        в analyze_candles — гейт мог одобрить тикер по сигналам, которые
        стратегия в проде вообще не выдала бы (другой порог, нет
        __methods_agree/__liquidity_ok/ATR-фильтров), и завышенно оценить
        качество (избегая случаев, когда стоп пробивается раньше, чем
        достигается пик избыточного движения). Теперь:
        - отбор сигналов идёт той же цепочкой фильтров, что в
          analyze_candles (effective_threshold с учётом режима,
          __methods_agree, __liquidity_ok, ATR/комиссия);
        - MFE/MAE считаются честно бар-за-баром по реальным take/stop
          уровням (__take_stop_mults), как в backtest_barriers — если стоп
          пробивается раньше пика, MFE не растёт дальше точки пробития.

        Возвращает (средний quality, число виртуальных сделок).
        """
        if len(candles) < self.__candle_window + lookahead + 1:
            return 0.5, 0

        saved_candles = self.__candles
        saved_score_history = list(self.__score_history)
        saved_l1_state = (
            list(self.__l1_buffer), self.__l1_pct, self.__l1_above_ma50,
            self.__l1_trending_up, self.__l1_trending_down, self.__l1_data_ready,
        )
        saved_atr_ex_state = (
            self.__daily_open_price, self.__daily_open_date,
            self.__day_move_pct, self.__last_atr_pct,
            self.__daily_high, self.__daily_low,
            list(self.__daily_atr_buf), self.__daily_atr,
        )
        saved_l2_state_q = (
            self.__cached_mtf5_composite,
            dict(self.__cached_mtf5_scores),
            list(self.__mtf5_momentum_buf),
        )
        saved_ic_state_q = (
            {rg: {n: ICPrior(p.ic_smoothed, p.invert, p.n_updates, p.noise_mode, p.n_updates_effective)
                  for n, p in bucket.items()} for rg, bucket in self.__ic_priors.items()},
            {n: list(v) for n, v in self.__ic_score_buf.items()},
            list(self.__ic_close_buf),
            self.__ic_bar_counter,
            {n: list(v) for n, v in self.__ic_trade_score_buf.items()},
            list(self.__ic_trade_quality_buf),
        )
        import copy as _copy
        saved_new_state_q = (
            self.__l1_score,
            _copy.deepcopy(self.__playbook_stats),
            _copy.deepcopy(self.__playbook_disabled),
            _copy.deepcopy(self.__narrative_lifecycle),
            _copy.deepcopy(self.__narrative_bars_since_confirmed),
            _copy.deepcopy(self.__threshold_adapters),
            _copy.deepcopy(self.__mfe_distribution),
            _copy.deepcopy(self.__stat_break),
        )
        qualities: list[float] = []
        comm = commission_rt(self.__settings.is_future)
        last_l1_day = None
        try:
            i = CANDLE_WINDOW
            while i < len(candles) - lookahead:
                self.__candles = candles[i - self.__candle_window:i]
                # L1-буфер обновляем раз в день — агрегация дорогая (O(N) баров)
                cur_day = candles[i].time.date()
                if cur_day != last_l1_day:
                    last_l1_day = cur_day
                    self.__l1_buffer = candles[max(0, i - self.__l1_buffer_size):i]
                    self.__recalc_l1_context()
                    # новый день — фиксируем вчерашний дневной ATR
                    if self.__daily_high > 0 and self.__daily_low < float("inf") and self.__daily_open_price > 0:
                        d_atr = (self.__daily_high - self.__daily_low) / self.__daily_open_price * 100
                        self.__daily_atr_buf.append(d_atr)
                        if len(self.__daily_atr_buf) > 10:
                            self.__daily_atr_buf.pop(0)
                        self.__daily_atr = sum(self.__daily_atr_buf) / len(self.__daily_atr_buf)
                    self.__daily_open_date = cur_day
                    self.__daily_open_price = _to_f(candles[i].open)
                    self.__daily_high = _to_f(candles[i].high)
                    self.__daily_low = _to_f(candles[i].low)
                else:
                    self.__daily_high = max(self.__daily_high, _to_f(candles[i].high))
                    self.__daily_low = min(self.__daily_low, _to_f(candles[i].low))

                atr_pct = _compute_atr(self.__candles)
                self.__last_atr_pct = atr_pct
                if atr_pct < comm * MIN_ATR_FACTOR:
                    i += 1
                    continue

                close_px = _to_f(candles[i].close)
                if self.__daily_open_price > 0:
                    self.__day_move_pct = (close_px - self.__daily_open_price) / self.__daily_open_price * 100

                composite, scores = self.__compute_composite()
                adaptive = _adaptive_threshold(self.__threshold, self.__last_regime)
                effective_threshold = self.__effective_threshold(adaptive)
                _hour = candles[i].time.hour
                thr_long = self.__effective_signal_threshold(
                    effective_threshold, SignalType.LONG, self.__last_regime, _hour)
                thr_short = self.__effective_signal_threshold(
                    effective_threshold, SignalType.SHORT, self.__last_regime, _hour)

                direction: Optional[SignalType] = None
                if composite >= thr_long:
                    direction = SignalType.LONG
                elif self.__settings.short_enabled_flag and composite <= -thr_short:
                    direction = SignalType.SHORT

                if direction is None:
                    self.rejection_stats["below_threshold"] += 1
                    i += 1
                    continue
                if self.__last_regime in BACKTEST_BLOCKED_REGIMES or (block_ranging and self.__last_regime == "ranging"):
                    self.rejection_stats["below_threshold"] += 1
                    i += 1
                    continue
                _agree, _reason = self.__methods_agree_with_reason(scores, direction)
                if not _agree:
                    self.rejection_stats["methods_disagree"] += 1
                    if _reason in self.rejection_stats:
                        self.rejection_stats[_reason] += 1
                    i += 1
                    continue
                # Narrative-гейт убран из backtest_scan_signals: FSM требует разогрева
                # между барами (NEUTRAL → WATCHING → CONFIRMED), которого нет на холодном
                # старте бэктеста — в итоге блокирует почти все сигналы. В живой торговле
                # (analyze_candles) гейт остаётся и продолжает фильтровать.
                if not self.__liquidity_ok():
                    self.rejection_stats["liquidity"] += 1
                    i += 1
                    continue

                take_mult, stop_mult = self.__take_stop_mults(direction, atr_pct)
                take_dist = abs(float(take_mult) - 1.0)
                stop_dist = abs(float(stop_mult) - 1.0)
                if take_dist < comm * MIN_ATR_FACTOR:
                    i += 1
                    continue

                entry = _to_f(candles[i].close)
                if direction == SignalType.LONG:
                    take_price, stop_price = entry * (1 + take_dist), entry * (1 - stop_dist)
                else:
                    take_price, stop_price = entry * (1 - take_dist), entry * (1 + stop_dist)

                # Бар-за-баром, как в backtest_barriers: считаем mfe/mae только
                # до момента, когда впервые пробивается take или stop —
                # дальше движение цены уже не относится к этой сделке.
                mfe, mae = 0.0, 0.0
                future = candles[i + 1:i + 1 + lookahead]
                for c in future:
                    h, lo = _to_f(c.high), _to_f(c.low)
                    if direction == SignalType.LONG:
                        hit_take, hit_stop = h >= take_price, lo <= stop_price
                    else:
                        hit_take, hit_stop = lo <= take_price, h >= stop_price
                    if hit_take and hit_stop:
                        # обе цены задело в одной свече — консервативно считаем
                        # стоп первым (как в backtest_barriers): mfe этой свечи
                        # не засчитываем, mae фиксируем на уровне стопа.
                        mae = max(mae, stop_dist)
                        break
                    if hit_stop:
                        mae = max(mae, stop_dist)
                        break
                    if hit_take:
                        mfe = max(mfe, take_dist)
                        break
                    if direction == SignalType.LONG:
                        mfe = max(mfe, (h - entry) / entry)
                        mae = max(mae, (entry - lo) / entry)
                    else:
                        mfe = max(mfe, (entry - lo) / entry)
                        mae = max(mae, (h - entry) / entry)

                # MFE за вычетом комиссии за круг (своя ставка для акции/фьючерса
                # и текущего тарифа из settings.ini) — движение цены меньше
                # комиссии не даёт реальной прибыли на реальном счёте.
                mfe_net = max(0.0, mfe - comm)
                qualities.append(mfe_net / (mfe_net + mae) if (mfe_net + mae) > 0 else 0.5)
                i += lookahead  # не пересекать виртуальные сделки
        finally:
            self.__candles = saved_candles
            self.__score_history = saved_score_history
            (self.__l1_buffer, self.__l1_pct, self.__l1_above_ma50,
             self.__l1_trending_up, self.__l1_trending_down, self.__l1_data_ready) = saved_l1_state
            (self.__daily_open_price, self.__daily_open_date,
             self.__day_move_pct, self.__last_atr_pct,
             self.__daily_high, self.__daily_low,
             self.__daily_atr_buf, self.__daily_atr) = saved_atr_ex_state
            (self.__cached_mtf5_composite,
             self.__cached_mtf5_scores,
             self.__mtf5_momentum_buf) = saved_l2_state_q
            (self.__ic_priors, self.__ic_score_buf,
             self.__ic_close_buf, self.__ic_bar_counter,
             self.__ic_trade_score_buf, self.__ic_trade_quality_buf) = saved_ic_state_q
            (self.__l1_score, self.__playbook_stats, self.__playbook_disabled,
             self.__narrative_lifecycle, self.__narrative_bars_since_confirmed,
             self.__threshold_adapters, self.__mfe_distribution,
             self.__stat_break) = saved_new_state_q

        if not qualities:
            return 0.5, 0
        return sum(qualities) / len(qualities), len(qualities)

    def backtest_scan_signals(self, candles: list[HistoricCandle], max_bars: int = 60,
                               adaptive_narrative: bool = False,
                               narrative_recalib_every_days: int = 20,
                               block_ranging: bool = False,
                               oi_date_hook=None) -> list[dict]:
        """
        Один проход по свечам с дорогим __compute_composite() (внутри —
        Hawkes-MLE через scipy.optimize и другие методы) — собирает все бары,
        где стратегия дала бы сигнал, вместе с ATR на момент входа и окном
        свечей для поиска барьера. Позволяет прогнать backtest_barriers() с
        разными take/stop без повторного пересчёта composite на каждой
        комбинации — см. compare_take_stop.py, где иначе один и тот же
        дорогой проход повторялся бы 10 раз на тикер.
        """
        if len(candles) < self.__candle_window + 2:
            return []

        saved_candles = self.__candles
        saved_score_history = list(self.__score_history)
        saved_l1_state = (
            list(self.__l1_buffer), self.__l1_pct, self.__l1_above_ma50,
            self.__l1_trending_up, self.__l1_trending_down, self.__l1_data_ready,
        )
        saved_atr_ex_state = (
            self.__daily_open_price, self.__daily_open_date,
            self.__day_move_pct, self.__last_atr_pct,
            self.__daily_high, self.__daily_low,
            list(self.__daily_atr_buf), self.__daily_atr,
        )
        # L2-состояние нужно восстанавливать так же как L1 — иначе состояние
        # «протекает» из lookahead-окна симуляции обратно в основной скан.
        saved_l2_state = (
            self.__cached_mtf5_composite,
            dict(self.__cached_mtf5_scores),
            list(self.__mtf5_momentum_buf),
        )
        saved_ic_state = (
            {rg: {n: ICPrior(p.ic_smoothed, p.invert, p.n_updates, p.noise_mode, p.n_updates_effective)
                  for n, p in bucket.items()} for rg, bucket in self.__ic_priors.items()},
            {n: list(v) for n, v in self.__ic_score_buf.items()},
            list(self.__ic_close_buf),
            self.__ic_bar_counter,
            {n: list(v) for n, v in self.__ic_trade_score_buf.items()},
            list(self.__ic_trade_quality_buf),
        )
        # Narrative FSM сбрасывается в начале: в бэктесте нет накопленной истории
        # переходов живой торговли, поэтому стартуем с NEUTRAL честно.
        saved_composite_history = list(self.__composite_history)
        self.__composite_history = []
        saved_narrative_state = self.__narrative_state
        self.__narrative_state = NarrativeState()
        # Сброс EWA-весов до равномерных: бэктест должен стартовать «холодным»,
        # без знания исходов сделок, которые ещё не произошли. Использование
        # весов из oi_weights.json (обученных на полной истории, включая будущее
        # относительно начала окна) — форма look-ahead bias.
        saved_weights = {n: MethodWeight(w.weight, w.total, w.sum_quality)
                         for n, w in self.__weights.items()}
        saved_regime_weights = {
            regime: {n: MethodWeight(w.weight, w.total, w.sum_quality)
                     for n, w in methods.items()}
            for regime, methods in self.__regime_weights.items()
        }
        self.__weights = {name: MethodWeight() for name in ALL_METHOD_NAMES}
        self.__regime_weights = {regime: {name: MethodWeight() for name in ALL_METHOD_NAMES}
                                  for regime in REGIMES}
        import copy as _copy
        saved_new_state = (
            self.__l1_score,
            _copy.deepcopy(self.__playbook_stats),
            _copy.deepcopy(self.__playbook_disabled),
            _copy.deepcopy(self.__narrative_lifecycle),
            _copy.deepcopy(self.__narrative_bars_since_confirmed),
            _copy.deepcopy(self.__threshold_adapters),
            _copy.deepcopy(self.__mfe_distribution),
            _copy.deepcopy(self.__stat_break),
        )
        signals: list[dict] = []
        total_bars = len(candles) - 1 - self.__candle_window
        t_start = time.monotonic()
        t_last_log = t_start
        last_sim_day: Optional[str] = None
        last_l1_day = None
        days_since_recalib = 0
        narrative_bars_seen = 0   # счётчик для warmup narrative-гейта
        try:
            i = CANDLE_WINDOW
            while i < len(candles) - 1:
                done = i - self.__candle_window
                now = time.monotonic()
                if now - t_last_log >= 5 and done > 0:
                    t_last_log = now
                    elapsed = now - t_start
                    rate = done / elapsed if elapsed > 0 else 0
                    eta = (total_bars - done) / rate if rate > 0 else 0
                    logger.info(
                        f"{self.__settings.ticker}: скан {done}/{total_bars} баров "
                        f"({100 * done / total_bars:.0f}%), {elapsed:.0f}с прошло, ~{eta:.0f}с осталось"
                    )
                self.__candles = candles[i - self.__candle_window:i]
                # L1-буфер: обновляем раз в день (агрегация — O(N) баров)
                cur_day = candles[i].time.date()
                if cur_day != last_l1_day:
                    if oi_date_hook is not None:
                        oi_date_hook(cur_day.isoformat())
                    last_l1_day = cur_day
                    self.__l1_buffer = candles[max(0, i - self.__l1_buffer_size):i]
                    self.__recalc_l1_context()
                    # новый день — фиксируем вчерашний дневной ATR
                    if self.__daily_high > 0 and self.__daily_low < float("inf") and self.__daily_open_price > 0:
                        d_atr = (self.__daily_high - self.__daily_low) / self.__daily_open_price * 100
                        self.__daily_atr_buf.append(d_atr)
                        if len(self.__daily_atr_buf) > 10:
                            self.__daily_atr_buf.pop(0)
                        self.__daily_atr = sum(self.__daily_atr_buf) / len(self.__daily_atr_buf)
                    self.__daily_open_date = cur_day
                    self.__daily_open_price = _to_f(candles[i].open)
                    self.__daily_high = _to_f(candles[i].high)
                    self.__daily_low = _to_f(candles[i].low)
                else:
                    self.__daily_high = max(self.__daily_high, _to_f(candles[i].high))
                    self.__daily_low = min(self.__daily_low, _to_f(candles[i].low))

                atr_pct = _compute_atr(self.__candles)
                self.__last_atr_pct = atr_pct
                comm = commission_rt(self.__settings.is_future)
                if atr_pct < comm * MIN_ATR_FACTOR:
                    i += 1
                    continue

                # ATR-exhaustion: обновляем дневной ход на каждой свече
                close_px = _to_f(candles[i].close)
                if self.__daily_open_price > 0:
                    self.__day_move_pct = (close_px - self.__daily_open_price) / self.__daily_open_price * 100

                composite, scores = self.__compute_composite()
                narrative_bars_seen += 1

                if self.__history is not None and hasattr(self.__history, "set_sim_date"):
                    sim_day = candles[i].time.date().isoformat()
                    if sim_day != last_sim_day:
                        last_sim_day = sim_day
                        self.__history.set_sim_date(sim_day)
                        self.__history.record_daily(
                            self.__settings.ticker,
                            composite=composite,
                            scores=self.__last_scores,
                            regime=self.__last_regime,
                            regime_confidence=self.__regime_confidence,
                            rolling_quality=self.__rolling_quality,
                            live=False,
                        )
                        # Адаптивная пере-калибровка narrative-порогов В ПРОЦЕССЕ
                        # скана: в отличие от lasso-приоров (которым нужны исходы
                        # сделок, доступные только после backtest_barriers — пост-
                        # фактум обновление было бы причинно бессмысленным), пороги
                        # narrative читаются классификаторами на каждом баре заново
                        # (classify_directional/classify_volume, см. ниже), а нужные
                        # для фита дневные method_scores уже накоплены record_daily
                        # выше в этом же проходе — обновление здесь меняет реальное
                        # поведение всех последующих баров той же симуляции.
                        if adaptive_narrative:
                            days_since_recalib += 1
                            if days_since_recalib >= narrative_recalib_every_days:
                                days_since_recalib = 0
                                trades_by_regime = self.__history.trades_by_regime(
                                    self.__settings.ticker, window_days=36500,
                                )
                                fitted = fit_narrative_thresholds(trades_by_regime)
                                if fitted:
                                    self.__narrative_thresholds.set_data(fitted)
                adaptive = _adaptive_threshold(self.__threshold, self.__last_regime)
                effective_threshold = self.__effective_threshold(adaptive)
                ent = self.__last_entropy_score
                if ent > 0.2:
                    effective_threshold *= max(0.85, 1.0 - ent * 0.3)
                elif ent < -0.2:
                    effective_threshold *= min(1.25, 1.0 + abs(ent) * 0.5)
                # YZ_VOL_L2 + асимметричный порог (те же правила что и в analyze_candles)
                yz_l2 = self.__last_yz_vol_l2
                if yz_l2 < -0.3:
                    effective_threshold *= min(1.30, 1.0 + abs(yz_l2) * 0.4)
                _hour = candles[i].time.hour
                thr_long = self.__effective_signal_threshold(
                    effective_threshold, SignalType.LONG, self.__last_regime, _hour)
                thr_short = self.__effective_signal_threshold(
                    effective_threshold, SignalType.SHORT, self.__last_regime, _hour)
                l2c = self.__cached_mtf5_composite
                if abs(l2c) > 0.1:
                    asym = min(0.20, abs(l2c) * 0.25)
                    if l2c > 0:
                        thr_long  *= max(0.85, 1.0 - asym)
                        thr_short *= min(1.20, 1.0 + asym)
                    else:
                        thr_short *= max(0.85, 1.0 - asym)
                        thr_long  *= min(1.20, 1.0 + asym)

                direction: Optional[SignalType] = None
                if composite >= thr_long:
                    direction = SignalType.LONG
                elif self.__settings.short_enabled_flag and composite <= -thr_short:
                    direction = SignalType.SHORT

                if direction is None:
                    i += 1
                    continue
                _agree, _reason = self.__methods_agree_with_reason(scores, direction)
                if not _agree:
                    self.rejection_stats["methods_disagree"] += 1
                    if _reason in self.rejection_stats:
                        self.rejection_stats[_reason] += 1
                    i += 1
                    continue
                # Narrative-гейт: применяем только после warmup-окна. Первые
                # _NARRATIVE_WARMUP_BARS баров FSM разогревается (NEUTRAL → WATCHING
                # → CONFIRMED требует ≥2 переходов) — пока пропускаем.
                if narrative_bars_seen >= _NARRATIVE_WARMUP_BARS:
                    _thr_dir = thr_long if direction == SignalType.LONG else thr_short
                    if not self.__narrative_allows(direction, composite=composite, threshold=_thr_dir):
                        self.rejection_stats["narrative_blocked"] += 1
                        i += 1
                        continue
                if not self.__liquidity_ok():
                    i += 1
                    continue
                if self.__last_regime in BACKTEST_BLOCKED_REGIMES:
                    i += 1
                    continue

                _close = _to_f(candles[i].close)
                # Лимитный вход: покупаем LONG чуть ниже close, SHORT — чуть выше.
                # Экономит ~полспреда (LIMIT_ENTRY_OFFSET_PCT) по сравнению с рыночным.
                if direction == SignalType.LONG:
                    entry = _close * (1 - LIMIT_ENTRY_OFFSET_PCT)
                else:
                    entry = _close * (1 + LIMIT_ENTRY_OFFSET_PCT)
                window = candles[i + 1:i + 1 + max_bars]
                # Последние 3 элемента scores — M1/M2/M3 (см. ALL_METHOD_NAMES) —
                # сохраняем сырыми скорами для attribution в дашборде/бэктесте.
                m1_sc, m2_sc, m3_sc = scores[-3], scores[-2], scores[-1]
                signals.append({
                    "direction": direction, "entry": entry, "atr_pct": atr_pct, "window": window,
                    "entry_time": candles[i].time,
                    "m1": m1_sc, "m2": m2_sc, "m3": m3_sc,
                    "method_scores": dict(self.__last_scores),
                    # Теневые скоры (без гейта по _disabled_methods) — только для
                    # статистики "что теряется, если метод не активен"; НЕ должны
                    # использоваться для обучения весов/лассо/нарратива.
                    "method_scores_shadow": dict(self.__last_scores_shadow),
                    "regime": self.__last_regime,
                    "noise_scale": self.__noise_stop_scale(),
                    # L1-контекст на момент входа
                    "l1_pct": round(self.__l1_pct, 3) if self.__l1_data_ready else None,
                    "l1_above_ma50": self.__l1_above_ma50 if self.__l1_data_ready else None,
                    "l1_trending_up": self.__l1_trending_up if self.__l1_data_ready else None,
                    "l1_trending_down": self.__l1_trending_down if self.__l1_data_ready else None,
                    "atr_ex_ratio": round(self.__day_move_pct / self.__last_atr_pct, 2)
                                    if self.__last_atr_pct > 0 else None,
                    # Активные плейбуки на момент входа — для attribution в дашборде
                    "active_playbooks": list(self.__last_playbooks),
                    # Уровень активации трейлинга на момент входа — не пересчитывать
                    # при последующих backtest-прогонах по этому же сигналу.
                    "trail_activation_pct": self.__trail_activation_pct(
                        self.__last_regime, self.__last_playbooks),
                    # Стабильность режима на момент входа: BOCD confidence < 0.60
                    # означало FSM откатился из CONFIRMED в WATCHING — вход мог быть
                    # на переходном режиме. Для attribution и аудита.
                    "regime_confidence_at_entry": round(self.__regime_confidence, 4),
                    "regime_unstable_at_entry": self.__regime_confidence < BOCD_NARRATIVE_SYNC_THR,
                    # Исторические свечи до точки входа — для detect_level_pattern
                    "history_window": candles[max(0, i - 60):i + 1],
                })
                i += max(1, len(window))  # не пересекать виртуальные сделки
        finally:
            self.__candles = saved_candles
            self.__score_history = saved_score_history
            (self.__l1_buffer, self.__l1_pct, self.__l1_above_ma50,
             self.__l1_trending_up, self.__l1_trending_down, self.__l1_data_ready) = saved_l1_state
            (self.__daily_open_price, self.__daily_open_date,
             self.__day_move_pct, self.__last_atr_pct,
             self.__daily_high, self.__daily_low,
             self.__daily_atr_buf, self.__daily_atr) = saved_atr_ex_state
            (self.__cached_mtf5_composite,
             self.__cached_mtf5_scores,
             self.__mtf5_momentum_buf) = saved_l2_state
            self.__weights = saved_weights
            self.__regime_weights = saved_regime_weights
            self.__narrative_state = saved_narrative_state
            self.__composite_history = saved_composite_history
            (self.__ic_priors, self.__ic_score_buf,
             self.__ic_close_buf, self.__ic_bar_counter,
             self.__ic_trade_score_buf, self.__ic_trade_quality_buf) = saved_ic_state
            (self.__l1_score, self.__playbook_stats, self.__playbook_disabled,
             self.__narrative_lifecycle, self.__narrative_bars_since_confirmed,
             self.__threshold_adapters, self.__mfe_distribution,
             self.__stat_break) = saved_new_state

        return signals

    def scan_method_scores(self, candles: list[HistoricCandle]) -> list[dict]:
        """
        В отличие от backtest_scan_signals (который пишет бар только когда
        composite пересёк threshold) — здесь пишется КАЖДЫЙ бар, безусловно,
        с сырыми скорами всех методов и close-ценой. Нужно для измерения лага
        метода относительно будущей цены (кросс-корреляция score/forward
        return со сдвигом, см. lag_analysis.py) — для этого нужен непрерывный
        ряд score(t), а не только моменты сигналов (которые сами по себе уже
        отфильтрованы по "score созрел", т.е. смещены к месту, где лаг скрыт).
        """
        if len(candles) < self.__candle_window + 2:
            return []

        saved_candles = self.__candles
        saved_score_history = list(self.__score_history)
        rows: list[dict] = []
        try:
            for i in range(self.__candle_window, len(candles)):
                self.__candles = candles[i - self.__candle_window:i]
                _, scores = self.__compute_composite()
                closes_w = [_to_f(c.close) for c in self.__candles]
                volumes_w = [float(c.volume) for c in self.__candles]
                regime_probs = classify_regime_probs(closes_w, volumes_w)
                rows.append({
                    "time": candles[i].time,
                    "close": _to_f(candles[i].close),
                    "scores": dict(zip(ALL_METHOD_NAMES, scores)),
                    "regime": max(regime_probs, key=regime_probs.get),
                })
        finally:
            self.__candles = saved_candles
            self.__score_history = saved_score_history

        return rows

    def diagnostics_snapshot(self, candles: list[HistoricCandle]) -> dict:
        """
        Снимок текущего внутреннего состояния композита на последнем окне —
        для дашборда (страница "Диагностика стратегии"): что сейчас весит
        Hedge на метод, как смешиваются regime_mods/redundancy по
        regime_probs, готовы ли M1/M2/M3 и в каких режимах накоплена
        RMT-корреляция (см. cluster_models.py). Read-only: не трогает
        __cluster_models/__last_regime, считает регим/смеси заново на этом
        окне, не вмешиваясь в состояние, которое использует analyze_candles.
        """
        if len(candles) < self.__candle_window:
            return {"ready": False}

        window = candles[-self.__candle_window:]
        closes = [_to_f(c.close) for c in window]
        volumes = [float(c.volume) for c in window]
        regime_probs = classify_regime_probs(closes, volumes)
        # Тот же дневной контекст, что и на живом пути (__compute_composite:
        # squeeze_adjust). Без него дашборд-диагностика показывала бы trending_up
        # там, где живой вход-гейт уже видит ranging (внутридневной сквиз против
        # дневного тренда) — и пользователь не понимал бы, почему сделки нет.
        regime_probs = squeeze_adjust(regime_probs, self.__daily_regime)
        regime = max(regime_probs, key=regime_probs.get)

        regime_mods: dict[str, float] = {}
        for name in ALL_METHOD_NAMES:
            mult = 0.0
            for r, p in regime_probs.items():
                if p <= 0.0:
                    continue
                dyn = self.__dynamic_regime_mods.get(r)
                static = REGIME_WEIGHT_MODS.get(r, {})
                mult += p * (dyn.get(name, static.get(name, 1.0)) if dyn else static.get(name, 1.0))
            regime_mods[name] = mult

        if self.__cluster_models is not None:
            if self.__cluster_models.needs_refresh(regime):
                self.__cluster_models.refresh(regime)
            redundancy_mult = self.__cluster_models.redundancy_dampen(ALL_METHOD_NAMES, regime_probs)
            cluster_ready = self.__cluster_models._ready
            corr_regimes = sorted(self.__cluster_models._corr_by_regime.keys())
        else:
            redundancy_mult = {}
            cluster_ready = False
            corr_regimes = []

        _snap_phase_raw = PHASE_WEIGHT_MODS.get(self.__cached_phase, {})
        _snap_phase_conf = self.__cached_phase_conf
        methods = []
        for name in ALL_METHOD_NAMES:
            hedge = self.__weights[name]
            blended_weight = self.__blended_hedge_weight(name, regime_probs)
            _snap_floor = max(0.0, 0.25 * (1.0 - _snap_phase_conf))
            snap_blended_mod = max(_snap_floor, min(1.75,
                1.0
                + (regime_mods.get(name, 1.0) - 1.0)
                + (_snap_phase_raw.get(name, 1.0) - 1.0) * _snap_phase_conf
            ))
            eff_weight = (
                blended_weight * snap_blended_mod * redundancy_mult.get(name, 1.0)
                * (MICROSTRUCTURE_WEIGHT_BOOST if name in MICROSTRUCTURE_METHOD_NAMES else 1.0)
            )
            methods.append({
                "name": name,
                "hedge_weight": round(blended_weight, 4),
                "hedge_trades": hedge.total,
                "regime_mult": round(snap_blended_mod, 4),
                "redundancy_mult": round(redundancy_mult.get(name, 1.0), 4),
                "effective_weight": round(eff_weight, 4),
                "is_microstructure": name in MICROSTRUCTURE_METHOD_NAMES,
            })
        methods.sort(key=lambda m: m["effective_weight"], reverse=True)

        return {
            "ready": True,
            "regime": regime,
            "regime_probs": {r: round(p, 3) for r, p in regime_probs.items()},
            "phase": self.__cached_phase,
            "phase_conf": round(self.__cached_phase_conf, 3),
            "rolling_quality": round(self.__rolling_quality, 4),
            "rolling_quality_by_regime": {r: round(q, 4) for r, q in self.__rolling_quality_by_regime.items()},
            "cluster_models_ready": cluster_ready,
            "cluster_corr_regimes": corr_regimes,
            "methods": methods,
        }

    def backtest_barriers(
            self,
            candles: Optional[list[HistoricCandle]] = None,
            take_mult: Optional[Decimal] = None,
            stop_mult: Optional[Decimal] = None,
            atr_take_k: Optional[float] = None,
            atr_stop_k: Optional[float] = None,
            atr_scale_exp: Optional[float] = None,
            max_bars: int = 60,
            signals: Optional[list[dict]] = None,
            return_trades: bool = False,
            tariff: Optional[str] = None,
            record_history: bool = True,
            adaptive_lasso: bool = False,
            lasso_recalib_every_trades: int = 30,
            oi_date_hook=None,
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

        record_history=False — не писать сделки в BacktestHistoryStore.
        Нужно для sweep-вызовов (подбор atr_take_k/atr_stop_k по сетке):
        иначе один и тот же сигнал переписывается в историю по разу на
        каждую проверяемую пару (tk, sk) и на каждый день walk-forward —
        раздувает историю задвоениями и портит effWR в ClusterModels.

        adaptive_lasso=True — настоящая адаптивность lasso-приоров внутри
        одного прогона. Сигналы уже идут в хронологическом порядке (как и
        для адаптивных M1/M2/M3 cluster-models выше в этом же цикле), и
        исход каждой сделки (mfe/mae/take/stop) известен сразу после её
        обработки — без отдельного прохода. Это и есть "интерливинг скана и
        барьеров день за днём": вместо одного fit_lasso_coefficients ПОСЛЕ
        всего прогона (lasso_calibration._calibrate_one, пост-фактум) —
        каждые lasso_recalib_every_trades сделок фитим lasso на всех
        сделках, накопленных К ЭТОМУ МОМЕНТУ, и обновляем self.__lasso_priors
        — приоры влияют на __global_weight только следующих сделок,
        причинно корректно (в отличие от narrative-порогов, тут нужны были
        именно исходы, поэтому раньше это не делалось вообще).
        """
        if signals is None:
            signals = self.backtest_scan_signals(candles, max_bars=max_bars, oi_date_hook=oi_date_hook)

        empty = {"n_trades": 0, "win_rate": 0.0, "avg_r": 0.0, "expectancy_pct": 0.0, "model_stats": {}}
        if return_trades:
            empty["trades"] = []
        if not signals:
            return empty

        comm = commission_rt(self.__settings.is_future, tariff=tariff)
        results: list[tuple[bool, float, float]] = []  # (win, r_multiple, net_pct)
        trades: list[dict] = []
        # Attribution M1/M2/M3: для каждой модели считаем win_rate среди
        # сделок, где её скор согласен с направлением сделки (agree), и
        # отдельно среди тех, где она была против (disagree) — нулевой
        # скор (модель промолчала) не считается ни тем, ни другим.
        model_tally = {
            m: {"agree_n": 0, "agree_win": 0, "agree_dur": 0.0, "disagree_n": 0, "disagree_win": 0, "disagree_dur": 0.0}
            for m in ("m1", "m2", "m3")
        }
        # Attribution по отдельным методам (BASE_METHOD_NAMES): та же логика agree/disagree.
        # Ключ — имя метода (PRICE_TREND, VOL_MOMENTUM, …).
        method_tally: dict[str, dict] = {}
        lasso_trades: list[dict] = []
        trades_since_lasso_recalib = 0
        for sig in signals:
            # Адаптивный пересчёт M1/M2/M3: кластерные модели накапливают историю
            # из предыдущих записанных сделок (record_history=True), поэтому каждый
            # следующий сигнал получает актуальные effWR вместо дефолтных 0.5.
            # Без этого backtest_scan_signals генерирует 0,0,0 (история пуста),
            # и attribution бессмысленен. Shallow-copy sig, чтобы не мутировать оригинал.
            if self.__cluster_models is not None and sig.get("method_scores"):
                base_sc = {k: v for k, v in sig["method_scores"].items()
                           if k not in {M1_NAME, M2_NAME, M3_NAME}}
                sig_regime = sig.get("regime", "")
                if self.__cluster_models.needs_refresh(sig_regime):
                    self.__cluster_models.refresh(sig_regime)
                if self.__cluster_models._ready:
                    rm1, rm2, rm3 = self.__cluster_models.compute(base_sc)
                    sig = dict(sig)
                    sig["m1"], sig["m2"], sig["m3"] = rm1, rm2, rm3

            direction, entry, atr_pct, window = sig["direction"], sig["entry"], sig["atr_pct"], sig["window"]

            if atr_take_k is not None and atr_stop_k is not None:
                if atr_pct <= 0:
                    continue
                # atr_pct — волатильность ОДНОГО бара (TR-квантиль), а сделка
                # держится десятки баров до take/stop/timeout — без этого
                # take_k/stop_k калибруются под однобарное движение, не под
                # фактическую экспозицию. holding**exp — грубая оценка
                # накопленного разброса (см. ATR_SCALE_HOLDING_BARS).
                hold_scale = ATR_SCALE_HOLDING_BARS ** atr_scale_exp if atr_scale_exp else 1.0
                take_dist = atr_take_k * atr_pct * hold_scale
                stop_dist = atr_stop_k * atr_pct * hold_scale
            else:
                take_dist = abs(float(take_mult) - 1.0)
                stop_dist = abs(float(stop_mult) - 1.0)
            # Шумовая адаптация (__noise_stop_scale, записана в сигнал на
            # момент входа в backtest_scan_signals) применяется к ОБОИМ
            # барьерам, не только к стопу — раньше она ужимала только стоп,
            # из-за чего в шумном режиме (noise_scale<1) требуемое R:R для
            # выхода в плюс росло именно тогда, когда edge и так слабее.
            noise_scale = sig.get("noise_scale", 1.0)
            take_dist *= noise_scale
            stop_dist *= noise_scale

            # Расширение тейка при наличии признаков сильного потенциала на входе
            _hist = sig.get("history_window") or []
            _tp_ext = _tp_extension_mult(_hist, direction == SignalType.LONG)
            take_dist *= _tp_ext

            # Минимальный стоп: при стопе < 0.6% комиссия RT (~0.08%) съедает >13%.
            stop_dist = max(stop_dist, MIN_STOP_DIST_PCT)
            # Минимальное R:R: тейк должен быть ≥ 1.5× стопа, иначе EV отрицателен.
            take_dist = max(take_dist, stop_dist * MIN_TAKE_STOP_RATIO)

            if direction == SignalType.LONG:
                take_price = entry * (1 + take_dist)
                stop_price = entry * (1 - stop_dist)
            else:
                take_price = entry * (1 - take_dist)
                stop_price = entry * (1 + stop_dist)

            # Попытка заменить фиксированные барьеры уровневыми.
            # Используем свечи до момента входа (sig["window"] содержит свечи
            # после входа — для форвард-тест). Берём последние 60 свечей из
            # полного candle-окна стратегии как исторический контекст.
            entry_mode = "fixed"
            _lp: Optional[object] = None
            _lp_candles = sig.get("history_window")
            if _lp_candles is not None and len(_lp_candles) >= 30:
                _lp = detect_level_pattern(
                    _lp_candles,
                    direction=direction.name,
                    atr_value=atr_pct * entry if atr_pct > 0 else 0.0,
                )
                if _lp is not None:
                    # Вариант В: уровневый тейк (структурная цель) + фиксированный стоп
                    # (ATR-based, устойчив к шуму). Полная замена стопа давала WR=19%
                    # из-за тесных уровневых стопов, выбиваемых шумом фьючерсов.
                    take_price = _lp.take
                    take_dist = _lp.take_dist_pct
                    # stop_price / stop_dist остаются фиксированными
                    entry_mode = "level"

            # P9: уровень активации трейлинга (p50 MFE для regime/playbook).
            # Используем уже сохранённый уровень из снапшота сигнала (если есть) —
            # это значение было актуальным на момент входа. Пересчёт по текущему
            # __mfe_distribution дал бы уровень из будущего → дисконтинюити backtest/live.
            sig_regime = sig.get("regime", "")
            sig_playbooks = sig.get("active_playbooks") or []
            if "trail_activation_pct" in sig:
                trail_activation_pct = sig["trail_activation_pct"]  # сохранённый на момент входа
            else:
                trail_activation_pct = self.__trail_activation_pct(sig_regime, sig_playbooks)
            entry_mode_trailing = False

            exit_pct: Optional[float] = None
            exit_time = window[-1].time if window else sig.get("entry_time")
            extreme = entry   # лучший экстремум хода (high для LONG, low для SHORT)
            trail_active = False
            trail_stop_price = None
            # Реальные MFE/MAE по ходу симуляции — для непрерывного quality
            # в Hedge-обучении (см. ниже), вместо бинарного win→1.0/lose→0.0.
            real_mfe = 0.0
            real_mae = 0.0
            for c in window:
                h = _to_f(c.high)
                lo = _to_f(c.low)
                if direction == SignalType.LONG:
                    real_mfe = max(real_mfe, (h - entry) / entry)
                    real_mae = max(real_mae, (entry - lo) / entry)
                else:
                    real_mfe = max(real_mfe, (entry - lo) / entry)
                    real_mae = max(real_mae, (h - entry) / entry)
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
                if hit_stop:
                    exit_pct = -stop_dist
                    exit_time = c.time
                    break
                # P9: до фиксированного тейка проверяем активацию трейлинга.
                if trail_activation_pct is not None and not trail_active and take_dist > 0:
                    if direction == SignalType.LONG:
                        moved = (h - entry) / entry
                    else:
                        moved = (entry - lo) / entry
                    if moved >= trail_activation_pct:
                        trail_active = True
                        entry_mode_trailing = True
                if trail_active:
                    # обновляем экстремум и Chandelier-стоп (take_dist × 0.5)
                    if direction == SignalType.LONG:
                        extreme = max(extreme, h)
                        trail_stop_price = extreme * (1 - take_dist * TRAIL_MIN_DIST_FRACTION)
                        if lo <= trail_stop_price:
                            exit_pct = (trail_stop_price - entry) / entry
                            exit_time = c.time
                            break
                    else:
                        extreme = min(extreme, lo)
                        trail_stop_price = extreme * (1 + take_dist * TRAIL_MIN_DIST_FRACTION)
                        if h >= trail_stop_price:
                            exit_pct = (entry - trail_stop_price) / entry
                            exit_time = c.time
                            break
                if hit_take and not trail_active:
                    exit_pct = take_dist
                    exit_time = c.time
                    break
            if exit_pct is None:
                last_close = _to_f(window[-1].close) if window else entry
                exit_pct = (last_close - entry) / entry if direction == SignalType.LONG \
                    else (entry - last_close) / entry

            net_pct = exit_pct - comm
            r_multiple = net_pct / stop_dist if stop_dist > 0 else 0.0
            win = net_pct > 0
            results.append((win, r_multiple, net_pct))

            # Hedge-обучение весов в бэктесте — та же логика, что close_trade:
            # aligned метод получает quality как target, opposed — 1-quality.
            # Quality — непрерывный MFE/(MFE+MAE) из реального хода цены в окне
            # симуляции (как в live), а НЕ бинарный win→1.0/lose→0.0: прежняя
            # аппроксимация take_dist/stop_dist награждала таймаут с копеечным
            # плюсом как полный тейк и делала веса бэктеста экстремальнее живых.
            if real_mfe > 0 or real_mae > 0:
                _quality_h = real_mfe / (real_mfe + real_mae + 1e-9)
            else:
                _quality_h = 1.0 if win else 0.0  # пустое окно — прежний фолбэк
            _neutral_h = max(0.20, min(0.80, self.__rolling_quality))
            self.__rolling_quality = 0.95 * self.__rolling_quality + 0.05 * _quality_h
            _ms = sig.get("method_scores") or {}
            for _name in list(self.__weights):
                _sc = _ms.get(_name, 0.0)
                if abs(_sc) < 0.05:
                    continue
                # Согласованность с фактическим голосом в композите: если IC
                # инвертировал метод, судим по инвертированному скору — иначе
                # Hedge продолжал бы штрафовать метод по сырому знаку, загонял
                # вес в минус и вторая инверсия (минус-вес × минус-скор)
                # возвращала бы голос в исходное плохое направление.
                _eff_sc = -_sc if self.__ic(_name).invert else _sc
                _aligned = (_eff_sc > 0 and direction == SignalType.LONG) or \
                           (_eff_sc < 0 and direction == SignalType.SHORT)
                _target = _quality_h if _aligned else 1.0 - _quality_h
                _ic_acc = min(1.0, abs(_sc))
                self.__weights[_name].update(_target, _ic_acc, neutral=_neutral_h)
                self.__ticker_weights[_name].update(_target, _ic_acc, neutral=_neutral_h)
                if self.__last_regime in self.__regime_weights:
                    self.__regime_weights[self.__last_regime][_name].update(_target, _ic_acc, neutral=_neutral_h)

            # P3/P9: статистика плейбуков + распределение MFE по этой сделке.
            _approx_mfe = max(0.0, exit_pct) if exit_pct > 0 else (take_dist if win else 0.0)
            _approx_mae = 0.0 if exit_pct > 0 else abs(exit_pct)
            self.__update_playbook_stats(
                sig.get("regime", ""), sig.get("active_playbooks") or [],
                r_multiple, win, _approx_mfe, _approx_mae,
            )
            # P8: посессионная статистика (r по часу входа).
            _et = sig.get("entry_time")
            if _et is not None and hasattr(_et, "hour"):
                self.__threshold_adapters.add_session(_et.hour, r_multiple)

            if adaptive_lasso and sig.get("method_scores"):
                lasso_trades.append({
                    "method_scores": sig["method_scores"],
                    "mfe": take_dist if win else 0.0,
                    "mae": 0.0 if win else stop_dist,
                    "dir": "LONG" if direction == SignalType.LONG else "SHORT",
                })
                trades_since_lasso_recalib += 1
                if trades_since_lasso_recalib >= lasso_recalib_every_trades:
                    trades_since_lasso_recalib = 0
                    import lasso_calibration
                    fitted = lasso_calibration.fit_lasso_coefficients(
                        lasso_trades, alpha=0.01, l1_ratio=0.8, use_group_lasso=False,
                    )
                    if fitted:
                        self.set_lasso_priors(self.priors_from_lasso_coefficients(fitted["coefficients"]))

            entry_time = sig.get("entry_time")
            duration_min = 0.0
            if entry_time is not None and exit_time is not None and hasattr(exit_time, "__sub__"):
                try:
                    duration_min = (exit_time - entry_time).total_seconds() / 60.0
                except TypeError:
                    duration_min = 0.0

            dir_sign = 1 if direction == SignalType.LONG else -1
            trade_models = {}
            for m in ("m1", "m2", "m3"):
                m_sc = sig.get(m, 0.0)
                trade_models[m] = m_sc
                if m_sc == 0:
                    continue
                tally = model_tally[m]
                if (m_sc > 0) == (dir_sign > 0):
                    tally["agree_n"] += 1
                    tally["agree_win"] += int(win)
                    tally["agree_dur"] += duration_min
                else:
                    tally["disagree_n"] += 1
                    tally["disagree_win"] += int(win)
                    tally["disagree_dur"] += duration_min

            # Per-method attribution: берём ТЕНЕВЫЕ скоры (method_scores_shadow) —
            # для активных методов они совпадают с method_scores, а для выключенных
            # показывают гипотетический винрейт ("что теряется, если метод не
            # активен"), не участвуя при этом в обучении весов (см. __record_outcome/
            # Hedge-цикл выше — те читают именно method_scores, не shadow).
            # Исключаем M1/M2/M3 (они агрегаты, а не самостоятельные методы).
            for mname, m_sc in (sig.get("method_scores_shadow") or sig.get("method_scores", {})).items():
                if mname in {M1_NAME, M2_NAME, M3_NAME}:
                    continue
                if abs(m_sc) < 0.02:  # метод промолчал — не считаем
                    continue
                t = method_tally.setdefault(mname, {"agree_n": 0, "agree_win": 0, "disagree_n": 0, "disagree_win": 0})
                if (m_sc > 0) == (dir_sign > 0):
                    t["agree_n"] += 1
                    t["agree_win"] += int(win)
                else:
                    t["disagree_n"] += 1
                    t["disagree_win"] += int(win)

            # Пишем сделку в бэктестовую историю (см. backtest_scan_signals) —
            # без этого effWR в ClusterModels остаётся дефолтным 0.5 для всех
            # методов, как и в самом начале живой торговли без сделок.
            # mfe/mae здесь — грубая аппроксимация по факту take/stop (а не
            # реальный максимум хода), но того же знака/масштаба, что и quality
            # формула в live __record_outcome.
            if record_history and self.__history is not None and hasattr(self.__history, "set_sim_date") \
                    and entry_time is not None:
                approx_mfe = take_dist if win else 0.0
                approx_mae = 0.0 if win else stop_dist
                exit_price = entry * (1 + exit_pct) if direction == SignalType.LONG \
                    else entry * (1 - exit_pct)
                self.__history.set_sim_date(entry_time.date().isoformat())
                self.__history.record_trade(
                    self.__settings.ticker,
                    direction="LONG" if direction == SignalType.LONG else "SHORT",
                    entry_price=entry,
                    exit_price=exit_price,
                    mfe=approx_mfe,
                    mae=approx_mae,
                    method_scores=sig.get("method_scores", {}),
                    regime=sig.get("regime", ""),
                    code_version=STRATEGY_VERSION,
                )

            if return_trades:
                exit_price_val = entry * (1 + exit_pct) if direction == SignalType.LONG \
                    else entry * (1 - exit_pct)
                approx_mfe = take_dist if win else 0.0
                approx_mae = 0.0 if win else stop_dist
                # Определяем причину выхода по ценам
                if exit_pct > 0 and abs(exit_pct - take_dist) < 1e-9:
                    exit_reason = "take"
                elif exit_pct < 0 and abs(exit_pct + stop_dist) < 1e-9:
                    exit_reason = "stop"
                else:
                    exit_reason = "timeout"

                # Топ-5 методов согласных с направлением (по силе скора)
                dir_sign = 1 if direction == SignalType.LONG else -1
                ms = sig.get("method_scores", {})
                top_agree = sorted(
                    [(n, v) for n, v in ms.items() if v * dir_sign > 0.01],
                    key=lambda x: abs(x[1]), reverse=True
                )[:5]
                top_against = sorted(
                    [(n, v) for n, v in ms.items() if v * dir_sign < -0.01],
                    key=lambda x: abs(x[1]), reverse=True
                )[:3]

                trades.append({
                    "entry_time": entry_time, "exit_time": exit_time,
                    "direction": direction.name, "net_pct": net_pct,
                    "r_multiple": r_multiple, "win": win, "duration_min": round(duration_min, 1),
                    "m1": trade_models["m1"], "m2": trade_models["m2"], "m3": trade_models["m3"],
                    "entry_price": round(entry, 4),
                    "exit_price": round(exit_price_val, 4),
                    "take_price": round(take_price, 4),
                    "stop_price": round(stop_price, 4),
                    "mfe": round(approx_mfe, 6),
                    "mae": round(approx_mae, 6),
                    "exit_reason": exit_reason,
                    "regime": sig.get("regime", ""),
                    "entry_mode": entry_mode,
                    "pattern": _lp.pattern if entry_mode == "level" and _lp is not None else None,
                    "level_kind": _lp.level_kind if entry_mode == "level" and _lp is not None else None,
                    "level_tier": _lp.level_tier if entry_mode == "level" and _lp is not None else None,
                    "agree_count": len([v for v in ms.values() if v * dir_sign > 0.05]),
                    "against_count": len([v for v in ms.values() if v * dir_sign < -0.05]),
                    "top_agree": top_agree,
                    "top_against": top_against,
                    "method_scores": ms,
                    # Теневые скоры (без гейта по _disabled_methods) — для
                    # статистики выключенных методов, см. _method_stats_from_trades.
                    "method_scores_shadow": sig.get("method_scores_shadow", {}),
                    # L1-контекст на момент входа (None если данных не было)
                    "atr_pct": sig.get("atr_pct"),
                    "l1_pct": sig.get("l1_pct"),
                    "l1_above_ma50": sig.get("l1_above_ma50"),
                    "l1_trending_up": sig.get("l1_trending_up"),
                    "l1_trending_down": sig.get("l1_trending_down"),
                    "atr_ex_ratio": sig.get("atr_ex_ratio"),
                    "active_playbooks": sig.get("active_playbooks", []),
                    # P9: трейлинг-стоп из распределения MFE.
                    "trail_activation_pct": round(trail_activation_pct, 6)
                                            if trail_activation_pct is not None else None,
                    "entry_mode_trailing": entry_mode_trailing,
                    # Последние 5 свечей до входа (OHLCV) — для CSV-экспорта и AI-анализа
                    "candle_context": [
                        {
                            "t": str(c.time)[:16],
                            "o": round(_to_f(c.open), 4),
                            "h": round(_to_f(c.high), 4),
                            "l": round(_to_f(c.low), 4),
                            "c": round(_to_f(c.close), 4),
                            "v": int(c.volume),
                        }
                        for c in (sig.get("history_window") or [])[-5:]
                    ],
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
        out["model_stats"] = {
            m.upper() + "_CLUSTER": {
                "agree_n": t["agree_n"],
                "agree_win_rate": t["agree_win"] / t["agree_n"] if t["agree_n"] else None,
                "agree_avg_duration_min": t["agree_dur"] / t["agree_n"] if t["agree_n"] else None,
                "disagree_n": t["disagree_n"],
                "disagree_win_rate": t["disagree_win"] / t["disagree_n"] if t["disagree_n"] else None,
                "disagree_avg_duration_min": t["disagree_dur"] / t["disagree_n"] if t["disagree_n"] else None,
            }
            for m, t in model_tally.items()
        }
        out["method_stats"] = {
            mname: {
                "agree_n": t["agree_n"],
                "agree_win_rate": t["agree_win"] / t["agree_n"] if t["agree_n"] else None,
                "disagree_n": t["disagree_n"],
                "disagree_win_rate": t["disagree_win"] / t["disagree_n"] if t["disagree_n"] else None,
                "hedge_weight": round(self.__weights[mname].weight, 4) if mname in self.__weights else None,
                # Метод выключен из голосования/обучения весов — winrate выше
                # посчитан по теневым (shadow) скорам, т.е. гипотетический.
                "disabled": mname in self._disabled_methods,
            }
            for mname, t in method_tally.items()
        }
        # Attribution по плейбукам: для каждого — сколько сделок, сколько побед,
        # и отдельно — когда был активен vs. когда не было ни одного плейбука.
        playbook_tally: dict[str, dict] = {}
        no_playbook_n = no_playbook_win = 0
        for tr in (trades if return_trades else []):
            pbs = tr.get("active_playbooks") or []
            win_tr = tr.get("win", False)
            if not pbs:
                no_playbook_n += 1
                no_playbook_win += int(win_tr)
            for pb in pbs:
                t = playbook_tally.setdefault(pb, {"n": 0, "wins": 0})
                t["n"] += 1
                t["wins"] += int(win_tr)
        out["playbook_stats"] = {
            pb: {"n": t["n"], "win_rate": t["wins"] / t["n"] if t["n"] else None}
            for pb, t in playbook_tally.items()
        }
        out["playbook_stats"]["__no_playbook__"] = {
            "n": no_playbook_n,
            "win_rate": no_playbook_win / no_playbook_n if no_playbook_n else None,
        }
        if return_trades:
            out["trades"] = trades
        return out

    def __recalc_l1_context(self) -> None:
        """
        Пересчитывает L1-контекст из расширенного буфера свечей:
        - percentile текущей цены в _L1_RANGE_DAYS-дневном диапазоне (0..1)
        - положение относительно 50d MA
        - тренд по MA5/MA20 (есть ли направленное движение)
        Вызывается в блоке тяжёлых операций (каждые __heavy_cache_n баров)
        и при инициализации позиции буфера в бэктесте.
        """
        if not self.__l1_buffer:
            return
        by_day: dict = {}
        for c in self.__l1_buffer:
            d = c.time.date()
            h, lo, cl = _to_f(c.high), _to_f(c.low), _to_f(c.close)
            if d not in by_day:
                by_day[d] = {"h": h, "l": lo, "c": cl}
            else:
                if h > by_day[d]["h"]: by_day[d]["h"] = h
                if lo < by_day[d]["l"]: by_day[d]["l"] = lo
                by_day[d]["c"] = cl
        sorted_days = sorted(by_day.keys())
        n = len(sorted_days)
        if n < _L1_MA_DAYS:
            return  # недостаточно истории — не меняем __l1_data_ready
        current_price = _to_f(self.__l1_buffer[-1].close)
        # 30-дневный ценовой диапазон
        range_days = sorted_days[-_L1_RANGE_DAYS:]
        rng_high = max(by_day[d]["h"] for d in range_days)
        rng_low  = min(by_day[d]["l"] for d in range_days)
        rng = rng_high - rng_low
        if rng <= 0:
            return
        self.__l1_pct = max(0.0, min(1.0, (current_price - rng_low) / rng))
        # 50d MA
        ma50 = sum(by_day[d]["c"] for d in sorted_days[-_L1_MA_DAYS:]) / _L1_MA_DAYS
        self.__l1_above_ma50 = current_price > ma50
        # MA5/MA20 — детектор тренда: снимает блок при пробойном движении
        n5 = min(5, n); n20 = min(20, n)
        ma5  = sum(by_day[d]["c"] for d in sorted_days[-n5:])  / n5
        ma20 = sum(by_day[d]["c"] for d in sorted_days[-n20:]) / n20
        self.__l1_trending_up   = ma5 > ma20 * 1.002
        self.__l1_trending_down = ma5 < ma20 * 0.998
        self.__l1_data_ready = True
        # P5: единый L1-скор [-1,1] = 0.5·тренд + 0.3·позиция + 0.2·диапазон.
        trend_component = 1.0 if self.__l1_trending_up else (-1.0 if self.__l1_trending_down else 0.0)
        position_component = 2.0 * self.__l1_pct - 1.0
        range_component = 1.0 - 2.0 * abs(self.__l1_pct - 0.5)
        self.__l1_score = max(-1.0, min(1.0,
            0.5 * trend_component + 0.3 * position_component + 0.2 * range_component))

    # ── Внутренние методы ─────────────────────────────────────────────────────

    def __compute_composite(self) -> tuple[float, list[float]]:
        window = self.__candles
        vhf_mult = score_volatility_regime(window)
        closes = [_to_f(c.close) for c in window]
        volumes = [float(c.volume) for c in window]

        # Тяжёлые операции пересчитываем раз в __heavy_cache_n баров:
        # regime_probs (CUSUM+PELT), change_point_score, RQA, wavelet, MTF.
        # Режим рынка меняется медленно — 5-бар кэш не теряет точности.
        self.__heavy_bar_counter += 1
        do_heavy = (self.__heavy_bar_counter % self.__heavy_cache_n == 1)

        # classify_phase — лёгкая (только статистика), обновляем на каждом баре.
        # Фазы spring/reversal короткие (2-4 свечи) — лаг do_heavy их пропускал.
        _ph_highs = [float(quotation_to_decimal(c.high)) for c in self.__candles[-len(closes):]]
        _ph_lows  = [float(quotation_to_decimal(c.low))  for c in self.__candles[-len(closes):]]
        self.__cached_phase, self.__cached_phase_conf = classify_phase(
            closes, volumes, highs=_ph_highs, lows=_ph_lows,
        )

        if do_heavy:
            self.__cached_regime_probs = classify_regime_probs(closes, volumes)
            # Инвертируем: алгоритмы детектируют излом с запозданием, движение
            # уже состоялось — сигнал теперь против нового направления (разворот).
            self.__cached_change_point = -change_point_score(closes)
            self.__cached_rqa_mult    = self.__rqa_confidence_mult(closes)
            self.__cached_wavelet_mult = wavelet_confidence_mult(closes)
            if len(self.__candles) >= _MTF_MIN_BARS * _MTF_FACTOR:
                self.__cached_mtf_trend = _mtf_trend_score(self.__candles, factor=_MTF_FACTOR)
            # L2: composite на виртуальных барах ТФ×MTF_FACTOR (5м на 1м-данных,
            # 25м на 5м-данных и т.д.). Работает на любом рабочем интервале.
            src = (self.__l1_buffer or self.__candles)[-self.__mtf5_buffer_bars:]
            if len(src) >= _MTF5_MIN_5M_BARS * _MTF_FACTOR:
                self.__cached_mtf5_composite, self.__cached_mtf5_scores = _compute_l2_composite(src)
                # Signal Momentum: буфер последних L2-значений для детекции разворота
                self.__mtf5_momentum_buf.append(self.__cached_mtf5_composite)
                if len(self.__mtf5_momentum_buf) > _MTF5_MOMENTUM_LEN + 2:
                    self.__mtf5_momentum_buf = self.__mtf5_momentum_buf[-(_MTF5_MOMENTUM_LEN + 2):]
            self.__recalc_l1_context()

        # Дневной контекст: внутридневной «тренд» против дневного = сквиз →
        # уводим в ranging (питает и argmax-режим, и веса методов). Пока дневного
        # режима нет ("") — no-op. См. squeeze_adjust в regime.py.
        regime_probs = squeeze_adjust(self.__cached_regime_probs, self.__daily_regime)

        _dm = self._disabled_methods
        _inv = self._inverted_methods
        # OI-методы считаются отдельно от METHODS (провайдерные скоры), поэтому
        # раньше их нельзя было выключить/инвертировать из панели. Теперь, когда
        # данные ОИ приходят из воркера, пропускаем их через тот же гейт.
        def _gate(name, val):
            return 0.0 if name in _dm else (-val if name in _inv else val)
        def _inv_only(name, val):
            # Инверсия без учёта _dm — для теневой (shadow) статистики: метод
            # выключен из голосования, но его "было бы" значение всё равно
            # инвертируется, если инверсия включена (это настройка знака,
            # а не активности).
            return -val if name in _inv else val

        # Скор каждого METHODS считаем ВСЕГДА, даже для выключенных — иначе
        # неоткуда взять теневой (shadow) скор для статистики "что теряется,
        # если метод не активен". Гейт по _dm применяется отдельно, ниже.
        _method_vals = [fn(window) for _, fn in METHODS]

        # Адаптивные параметры индикаторов: заменяем скор tunable-метода
        # откалиброванной под тикер функцией (MethodCalibrator). Считаем для
        # ВСЕХ методов (не только включённых) — иначе теневой скор
        # выключенного метода не отражал бы его калибровку.
        if self.__method_calibrator is not None:
            _mc_ticker = self.__settings.ticker
            _mc_highs   = [_to_f(c.high)  for c in window]
            _mc_lows    = [_to_f(c.low)   for c in window]
            for _mc_i, (_mc_name, _) in enumerate(METHODS):
                _cfn = self.__method_calibrator.get_fn(_mc_ticker, _mc_name)
                if _cfn is not None:
                    try:
                        _method_vals[_mc_i] = _cfn(closes, _mc_highs, _mc_lows, volumes)
                    except Exception:
                        pass

        oi_raw = {
            "OI_SQUEEZE": self.__score_oi_squeeze(),
            "INST_OI": self.__score_provider(self.__inst_oi_provider),
            "RETAIL_CONTRA": self.__score_provider(self.__retail_contra_provider),
            "DELTA_QUADRANT": self.__score_provider(self.__delta_quadrant_provider),
            "OI_ABSORPTION": self.__score_provider(self.__oi_absorption_provider),
        }
        _tail_scores = (
            [self.__score_level_context_mtf(), self.__score_market_structure_mtf(), self.__score_spring_mtf()]
            + [self.__score_provider(self.__index_context_provider)]
            + [self.__score_tradestats(name) for name in TRADESTATS_METHOD_NAMES]
            + [self.__cached_change_point, self.__score_multi_ticker()]
        )
        base_scores = [
            (0.0 if name in _dm else _inv_only(name, v)) for (name, _), v in zip(METHODS, _method_vals)
        ] + [
            _tail_scores[0], _tail_scores[1], _tail_scores[2],
            _gate("OI_SQUEEZE", oi_raw["OI_SQUEEZE"]),
            _gate("INST_OI", oi_raw["INST_OI"]),
            _gate("RETAIL_CONTRA", oi_raw["RETAIL_CONTRA"]),
            _gate("DELTA_QUADRANT", oi_raw["DELTA_QUADRANT"]),
            _gate("OI_ABSORPTION", oi_raw["OI_ABSORPTION"]),
        ] + _tail_scores[3:]

        # Теневые скоры METHODS + OI: инверсия без гейта по _dm (см. _inv_only).
        # Остальные (структурные/tradestats/индекс/M1-3) сейчас не переключаемы
        # через _dm, поэтому для них shadow == base.
        _shadow_scores = [
            _inv_only(name, v) for (name, _), v in zip(METHODS, _method_vals)
        ] + [
            _tail_scores[0], _tail_scores[1], _tail_scores[2],
            _inv_only("OI_SQUEEZE", oi_raw["OI_SQUEEZE"]),
            _inv_only("INST_OI", oi_raw["INST_OI"]),
            _inv_only("RETAIL_CONTRA", oi_raw["RETAIL_CONTRA"]),
            _inv_only("DELTA_QUADRANT", oi_raw["DELTA_QUADRANT"]),
            _inv_only("OI_ABSORPTION", oi_raw["OI_ABSORPTION"]),
        ] + _tail_scores[3:]

        # Layer 0: непрерывное распределение по всем режимам.
        regime = max(regime_probs, key=regime_probs.get)
        regime_conf = regime_probs[regime]

        # Lag-penalty: считаем бары подряд в одном (argmax) режиме до его смены.
        if regime == self.__last_regime:
            self.__regime_stable_bars = min(self.__regime_stable_bars + 1, LAG_PENALTY_BARS)
        else:
            self.__regime_stable_bars = 0
        lag_mult = LAG_PENALTY_MIN + (1.0 - LAG_PENALTY_MIN) * (self.__regime_stable_bars / LAG_PENALTY_BARS)

        # Кластерные модели M1/M2/M3: обновляем при смене режима,
        # вычисляем на текущих скорах. До накопления истории — 0.
        base_score_dict = dict(zip(
            [name for name, _ in METHODS]
            + STRUCTURAL_METHOD_NAMES
            + [OI_SQUEEZE_NAME, INST_OI_NAME, RETAIL_CONTRA_NAME, DELTA_QUADRANT_NAME, OI_ABSORPTION_NAME]
            # INDEX_CONTEXT_NAME — тут, а не после TRADESTATS: в base_scores он
            # стоит именно на этой позиции (см. _tail_scores/BASE_METHOD_NAMES).
            # Без него zip молча сдвигал все имена TRADESTATS/CHANGE_POINT/
            # MULTI_TICKER на 1 позицию относительно их реальных скоров.
            + [INDEX_CONTEXT_NAME]
            + TRADESTATS_METHOD_NAMES
            + [CHANGE_POINT_NAME, MULTI_TICKER_NAME],
            base_scores
        ))
        # M1/M2/M3 отключены: win rate ~35-37% → они блокировали хорошие входы
        # через P7-вето. Скоры держим 0.0 для совместимости ALL_METHOD_NAMES.
        m1_sc = m2_sc = m3_sc = 0.0

        scores = base_scores + [m1_sc, m2_sc, m3_sc]
        scores_shadow = _shadow_scores + [m1_sc, m2_sc, m3_sc]

        # Накапливаем буфер для IC-калибровки. P1: запас под максимальный
        # per-method лаг (трендовые методы могут смотреть на ~120мин вперёд).
        _max_ic_lag = max(self.__ic_lags.values()) if self.__ic_lags else IC_FORWARD_LAG
        if self.__candles:
            self.__ic_close_buf.append(_to_f(self.__candles[-1].close))
            if len(self.__ic_close_buf) > IC_WINDOW + _max_ic_lag + 10:
                self.__ic_close_buf = self.__ic_close_buf[-(IC_WINDOW + _max_ic_lag + 10):]
        for name in ALL_METHOD_NAMES:
            s = base_score_dict.get(name, 0.0)
            self.__ic_score_buf[name].append(s)
            if len(self.__ic_score_buf[name]) > IC_WINDOW + 10:
                self.__ic_score_buf[name] = self.__ic_score_buf[name][-IC_WINDOW - 10:]
        self.__ic_bar_counter += 1
        # P8: история волатильности для адаптивного порога.
        self.__threshold_adapters.add_vol(self.__last_atr_pct)
        if self.__ic_bar_counter % IC_RECALC_INTERVAL == 0:
            self.__recalc_ic_priors()
            # P10: статистический детектор слома — обновляем раз в IC_RECALC_INTERVAL.
            self.__stat_break.update(
                _to_f(self.__candles[-1].close) if self.__candles else 0.0,
                self.__last_atr_pct,
            )
            self.__stat_break.check_break()

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

        # Alt-трансформации: дивергенция/истощение/объём/чоп/флип-фейд
        # применяются к нормализованным скорам, до взвешивания.
        # История берётся из __ic_score_buf (raw), что корректно:
        # трансформация работает с тем, что метод "думал" раньше.
        if self.__candles and len(self.__candles) >= _ALT_LOOKBACK:
            _closes_for_alt = [_to_f(c.close) for c in self.__candles]
            scores_for_composite = _apply_alt_transforms(
                list(ALL_METHOD_NAMES),
                scores_for_composite,
                self.__ic_score_buf,
                _closes_for_alt,
                self.__candles,
            )

        # Layer 2: режимные мультипликаторы — взвешенная смесь по ВСЕМ режимам
        # (regime_probs), а не жёсткий выбор одного. Динамические (из истории)
        # в приоритете над захардкоженными REGIME_WEIGHT_MODS на уровне каждого
        # режима в смеси; для методов без истории в данном режиме — откат на
        # статику этого же режима (обратная совместимость).
        regime_mods: dict[str, float] = {}
        for name in ALL_METHOD_NAMES:
            mult = 0.0
            for r, p in regime_probs.items():
                if p <= 0.0:
                    continue
                dyn = self.__dynamic_regime_mods.get(r)
                static = REGIME_WEIGHT_MODS.get(r, {})
                mult += p * (dyn.get(name, static.get(name, 1.0)) if dyn else static.get(name, 1.0))
            regime_mods[name] = mult

        # RMT-очищенная корреляция (та же матрица, что и в M1/M2/M3) — штраф
        # за избыточность веса коррелирующих методов. Без этого сильно
        # скоррелированный кластер методов перетягивает композит, как
        # отдельный голос от каждого, хотя по сути это один сигнал.
        if self.__cluster_models is not None:
            redundancy_mult = self.__cluster_models.redundancy_dampen(ALL_METHOD_NAMES, regime_probs)
        else:
            redundancy_mult = {}

        # Инверсия скора для методов с отрицательным IC (метод работает наоборот)
        scores_for_composite = [
            -s if self.__ic(n).invert else s
            for n, s in zip(ALL_METHOD_NAMES, scores_for_composite)
        ]

        # Режим-специфичная инверсия: некоторые методы меняют знак в зависимости
        # от режима (напр. ZSCORE контрарен в low_vol/trending_up — ловит перехаи,
        # но является momentum-сигналом в stress/trending_down/ranging).
        if regime in _REGIME_METHOD_SIGN:
            _rsign = _REGIME_METHOD_SIGN[regime]
            scores_for_composite = [
                s * _rsign[n] if n in _rsign else s
                for n, s in zip(ALL_METHOD_NAMES, scores_for_composite)
            ]

        # P5: в середине дневного диапазона (0.3<l1_pct<0.7) осцилляторы
        # информативнее — +10% методам осцилляторной группы.
        osc_boost_on = self.__l1_data_ready and 0.3 < self.__l1_pct < 0.7
        osc_group = _GATE_GROUPS["oscillator"]
        # Фазовый слой: отклонение от 1.0, сглаженное уверенностью фазы.
        _phase_mods_raw = PHASE_WEIGHT_MODS.get(self.__cached_phase, {})
        _phase_conf = self.__cached_phase_conf

        # Блендинг regime + phase: аддитивное сложение отклонений вместо перемножения.
        # Перемножение возводило эффект в квадрат (1.5×1.5=2.25, 0.5×0.5=0.25).
        # Пол масштабируется уверенностью: чем выше conf — тем сильнее глушит
        # неподходящие методы вплоть до полного выключения при conf→1.0.
        # conf=0.3 → пол≈0.175; conf=0.7 → пол≈0.075; conf=1.0 → пол=0.0.
        _floor = max(0.0, 0.25 * (1.0 - _phase_conf))
        blended_mods: dict[str, float] = {
            name: max(_floor, min(1.75,
                1.0
                + (regime_mods.get(name, 1.0) - 1.0)
                + (_phase_mods_raw.get(name, 1.0) - 1.0) * _phase_conf
            ))
            for name in ALL_METHOD_NAMES
        }

        weights = [
            self.__blended_hedge_weight(name, regime_probs)
            * self.__ic_bayes_weight(name)   # IC-prior (байес-фьюжн с фолбэком 0.5)
            * blended_mods.get(name, 1.0)
            * redundancy_mult.get(name, 1.0)
            * (MICROSTRUCTURE_WEIGHT_BOOST if name in MICROSTRUCTURE_METHOD_NAMES else 1.0)
            * (1.10 if (osc_boost_on and name in osc_group) else 1.0)
            * self.__ticker_weights[name].weight
            for name in ALL_METHOD_NAMES
        ]

        # M1/M2/M3 — последние 3 элемента (см. ALL_METHOD_NAMES) — не входят в
        # живой композит: они построены из тех же base_scores, что уже здесь
        # просуммированы, повторное сложение было бы двойным счётом.
        n_base = len(BASE_METHOD_NAMES)

        # Методы без подключённого источника данных (провайдер = None) структурно
        # молчат — score=0 всегда. Их НЕЛЬЗЯ держать в знаменателе: иначе
        # «отсутствующий» метод считается как голос, и его вечный 0 делит сумму на
        # пустые веса, систематически занижая композит (в проде без OI/tradestats
        # так молчит ~половина методов). Метод, который посчитался и вернул 0 —
        # это реальная нейтраль, он в знаменателе остаётся.
        _absent = set()
        if self.__squeeze_provider is None:        _absent.add("OI_SQUEEZE")
        if self.__inst_oi_provider is None:        _absent.add("INST_OI")
        if self.__retail_contra_provider is None:  _absent.add("RETAIL_CONTRA")
        if self.__delta_quadrant_provider is None: _absent.add("DELTA_QUADRANT")
        if self.__oi_absorption_provider is None:  _absent.add("OI_ABSORPTION")
        if self.__index_context_provider is None:  _absent.add("INDEX_CONTEXT")
        if self.__tradestats_provider is None:     _absent.update(TRADESTATS_METHOD_NAMES)
        if self.__multi_ticker_provider is None:   _absent.add("MULTI_TICKER")

        weighted = sum(s * w for s, w in zip(scores_for_composite[:n_base], weights[:n_base]))
        # Нормируем на sum(|w|), а не sum(w): отрицательные веса вредных методов
        # корректно инвертируют их голос, не схлопывая знаменатель в ноль.
        # Исключаем структурно отсутствующие методы (нет источника данных).
        weight_sum = sum(abs(w) for name, w in zip(BASE_METHOD_NAMES[:n_base], weights[:n_base])
                         if name not in _absent) or 1.0
        linear_raw = weighted / weight_sum

        # Плейбуки: нелинейные конъюнкции — при активации берут 60% итога.
        # Дивергенция инжектируется как дополнительное смещение linear_raw.
        playbook_score, active_playbooks = _compute_playbooks(
            base_score_dict, regime, sd_l2=self.__cached_mtf5_scores
        )
        # P3: исключаем плейбуки, отключённые по убыточной статистике в этом режиме.
        _disabled_pb = self.__playbook_disabled.get(regime)
        if _disabled_pb and active_playbooks:
            active_playbooks = [p for p in active_playbooks if p not in _disabled_pb]
            if not active_playbooks:
                playbook_score = 0.0
        div_score = _divergence_score(base_score_dict)
        if abs(div_score) > 0.1:
            # Дивергенция подмешивается с весом 0.25 в линейную часть.
            linear_raw = linear_raw * 0.75 + div_score * 0.25

        if abs(playbook_score) > 0.08 and active_playbooks:
            blended_raw = 0.6 * playbook_score + 0.4 * linear_raw
        else:
            blended_raw = linear_raw
            active_playbooks = []
        self.__last_playbooks = active_playbooks

        composite = blended_raw * (0.6 + 0.4 * vhf_mult)

        confidence_mult = self.__cached_rqa_mult
        confidence_mult *= self.__cached_wavelet_mult
        confidence_mult *= regime_conf
        confidence_mult *= lag_mult
        composite *= confidence_mult

        # L2-блендинг: даёт 30% итогового composite. Работает на любом ТФ.
        l2_comp = self.__cached_mtf5_composite
        l2_scores = self.__cached_mtf5_scores
        if abs(l2_comp) > 0.01:
            composite = (1.0 - _MTF5_BLEND_W) * composite + _MTF5_BLEND_W * l2_comp

            # Signal Momentum L2: если импульс на 5м разворачивается — штрафуем.
            mom_mult = _l2_momentum_mult(self.__mtf5_momentum_buf, l2_comp)
            if mom_mult < 1.0:
                composite *= mom_mult
                logger.debug(f"{self.__settings.figi}: L2 momentum разворот → ×{mom_mult:.2f}")

            # YZ_VOL на 5м → адаптивный порог (сохраняем для использования ниже)
            self.__last_yz_vol_l2 = l2_scores.get("YZ_VOL_L2", 0.0)
        else:
            self.__last_yz_vol_l2 = 0.0
            # Fallback: старый ZLEMA-фильтр (для не-1м ТФ или пока нет 5м-истории)
            htf_trend = self.__cached_mtf_trend
            if htf_trend != 0.0:
                if (composite > 0 and htf_trend < 0) or (composite < 0 and htf_trend > 0):
                    composite *= _MTF_COUNTER_MULT
                else:
                    composite *= _MTF_TREND_MULT

        # L1-гейт: структурный контекст (30d диапазон + 50d MA).
        # Старший ворот иерархии: лонг в верхних 15% диапазона в боковике → ×0.10.
        # Тренд (MA5>MA20) снимает блок — пробойное движение не подавляем.
        if self.__l1_data_ready:
            l1_mult = _l1_mult_from_context(
                composite, self.__l1_pct, self.__l1_above_ma50,
                self.__l1_trending_up, self.__l1_trending_down,
            )
            if l1_mult != 1.0:
                logger.debug(
                    f"{self.__settings.figi}: L1 pct={self.__l1_pct:.2f} "
                    f"above_ma50={self.__l1_above_ma50} trend↑={self.__l1_trending_up} "
                    f"trend↓={self.__l1_trending_down} → ×{l1_mult:.2f}"
                )
            composite *= l1_mult

        # Вето отказа от уровня: LEVEL_CONTEXT сильно против направления
        # композита (отказ с длинной тенью у того же уровня, от которого уже
        # был разворот) — давим композит вне зависимости от L1/тренда и
        # остальных методов, иначе сигнал тонет среди ~30 голосов.
        try:
            level_idx = BASE_METHOD_NAMES.index("LEVEL_CONTEXT")
            level_score = scores[level_idx]
        except (ValueError, IndexError):
            level_score = 0.0
        if abs(level_score) >= _LEVEL_VETO_THRESH and composite * level_score < 0:
            logger.debug(
                f"{self.__settings.figi}: LEVEL_CONTEXT={level_score:+.2f} против "
                f"composite={composite:+.3f} → вето ×{_LEVEL_VETO_MULT}"
            )
            composite *= _LEVEL_VETO_MULT

        # Расширенное вето 1: MMI > 75 (рынок случайный) — подавляем трендовые
        # сигналы. MMI читается напрямую (не через scores: score_mmi_signal
        # теперь 0.0, чтобы не давать ложный направленный голос в композите).
        closes_for_mmi = [_to_f(c.close) for c in self.__candles] if self.__candles else []
        _mmi_val = mmi(closes_for_mmi, period=min(200, len(closes_for_mmi))) if len(closes_for_mmi) >= 5 else 50.0
        trend_playbook_active = any(p in ("TREND_PULLBACK_L", "TREND_PULLBACK_S", "REGIME_SHIFT") for p in active_playbooks)
        if _mmi_val > 75 and abs(composite) > 0.05 and not trend_playbook_active:
            composite *= 0.35
            logger.debug(f"{self.__settings.figi}: MMI вето (рынок вязкий, MMI={_mmi_val:.1f}) → ×0.35")

        # Расширенное вето 2: FRACTAL (Hurst < 0.5) — mean-reverting рынок,
        # подавляем трендовые методы (PRICE_TREND/ZLEMA/T3 доминируют в сумме).
        # fractal < -0.25 значит Hurst ≈ <0.45 (по реализации score_fractal).
        try:
            frac_idx = BASE_METHOD_NAMES.index("FRACTAL")
            frac_score = scores[frac_idx]
        except (ValueError, IndexError):
            frac_score = 0.0
        if frac_score < -0.25 and not active_playbooks:
            # Нет активного плейбука + рынок mean-reverting: трендовая часть ненадёжна.
            composite *= 0.45
            logger.debug(f"{self.__settings.figi}: Hurst вето (mean-revert) → ×0.45")

        # Вето сильного структурного противосигнала: CASCADE / VSA_ABSORPTION /
        # IMPULSE_PULLBACK — специализированные методы с направленным Edge. Если
        # любой из них даёт |score| ≥ порога и направлен ПРОТИВ composite, то
        # остальные 35+ методов не могут «задавить» этот сигнал голосованием —
        # composite давится тем же множителем, что и LEVEL_VETO.
        for _veto_name in _STRONG_SIGNAL_VETO_METHODS:
            try:
                _vi = BASE_METHOD_NAMES.index(_veto_name)
                _vs = scores[_vi]
            except (ValueError, IndexError):
                _vs = 0.0
            if abs(_vs) >= _STRONG_SIGNAL_VETO_THRESH and composite * _vs < 0:
                logger.debug(
                    f"{self.__settings.figi}: {_veto_name}={_vs:+.2f} против "
                    f"composite={composite:+.3f} → вето ×{_STRONG_SIGNAL_VETO_MULT}"
                )
                composite *= _STRONG_SIGNAL_VETO_MULT
                break  # достаточно одного вето

        # Энтропийный порог сохраняется для использования в analyze_candles/backtest.
        # ENTROPY возвращает > 0 при упорядоченном рынке (→ порог можно снизить),
        # < 0 при хаотичном (→ порог надо поднять).
        try:
            ent_idx = BASE_METHOD_NAMES.index("ENTROPY")
            self.__last_entropy_score = scores[ent_idx]
        except (ValueError, IndexError):
            self.__last_entropy_score = 0.0

        # ATR-exhaustion: если цена уже прошла 60-85%+ дневного ATR в направлении
        # сигнала — потенциал движения исчерпывается, демпфируем composite.
        exhaustion = False
        if self.__last_atr_pct > 0 and self.__daily_open_price > 0:
            atr_ex_mult = _atr_exhaustion_mult(composite, self.__candles, self.__last_atr_pct, self.__daily_atr)
            exhaustion = atr_ex_mult < 0.99
            if atr_ex_mult != 1.0:
                logger.debug(
                    f"{self.__settings.figi}: ATR-ex ratio="
                    f"{self.__day_move_pct / self.__last_atr_pct:.2f} "
                    f"move={self.__day_move_pct:.3f}% atr={self.__last_atr_pct:.3f}% → ×{atr_ex_mult:.2f}"
                )
            composite *= atr_ex_mult

        self.__last_regime = regime
        self.__regime_confidence = regime_conf
        # __last_scores хранит скоры ПОСЛЕ гейта по _disabled_methods (выключенный
        # метод здесь всегда 0.0) — то, что реально участвовало в композите и
        # получит доступ к обучению весов. __last_scores_shadow — то же самое,
        # но без гейта (только инверсия), для теневой статистики выключенных
        # методов (см. _last_scores_shadow в __init__).
        self.__last_scores = dict(zip(ALL_METHOD_NAMES, scores))
        self.__last_scores_shadow = dict(zip(ALL_METHOD_NAMES, scores_shadow))
        self.__last_composite = composite
        self.__composite_history.append(composite)
        # P2: знаковой стабильности нужно больше истории, чем прежним 5+2 барам.
        _hist_cap = max(GATE_COMPOSITE_HISTORY_LEN + 2, 12)
        if len(self.__composite_history) > _hist_cap:
            self.__composite_history.pop(0)
        # P8: накапливаем нормированный |composite| для калибровки порога.
        self.__threshold_adapters.add_composite(composite)
        self.__advance_narrative(base_score_dict, closes, regime, exhaustion)
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
        atr_pct = _compute_atr(self.__candles) if self.__candles else 0.0
        priors_cur = self.__ic_priors.get(self.__last_regime) or self.__ic_priors.get("__global__", {})
        return {
            "composite": self.__last_composite,
            "scores": dict(self.__last_scores),
            "regime": self.__last_regime,
            "daily_regime": self.__daily_regime,
            "regime_confidence": self.__regime_confidence,
            "regime_unstable": self.__regime_confidence < BOCD_NARRATIVE_SYNC_THR,
            "rolling_quality": self.__rolling_quality,
            "auto_atr_take_k": self.__auto_atr_take_k,
            "auto_atr_stop_k": self.__auto_atr_stop_k,
            "auto_atr_scale_exp": self.__auto_atr_scale_exp,
            "atr_pct": atr_pct,
            "trail_activation_pct": self.__trail_activation_pct(
                self.__last_regime, self.__last_playbooks),
            "active_playbooks": list(self.__last_playbooks),
            # Диагностика P1: noise_mode и прогрев IC
            "noise_mode": any(p.noise_mode for p in priors_cur.values()),
            "ic_bar_counter": self.__ic_bar_counter,
            "ic_warm": self.__ic_bar_counter >= IC_WINDOW // 2,
            "stat_break_uncertainty": round(self.__stat_break.uncertainty, 3),
            "narrative_state": self.__narrative_state.name,
            "rejection_stats": dict(self.rejection_stats),
        }

    def path_estimate(self, lookback: int = 20) -> tuple[float, float]:
        """(дрифт за бар, волатильность за бар) в единицах цены по последним
        `lookback` свечам — для оценки вероятности дойти до тейка/стопа
        (risk.check_exit). Дрифт — это просто средний шаг цены за бар, а не
        предсказание; намеренно простая оценка, без новых источников данных."""
        candles = self.__candles[-lookback:]
        if len(candles) < 3:
            return 0.0, 0.0
        closes = [_to_f(c.close) for c in candles]
        diffs = [closes[i] - closes[i - 1] for i in range(1, len(closes))]
        drift = sum(diffs) / len(diffs)
        if len(diffs) > 1:
            vol = statistics.pstdev(diffs)
        else:
            vol = abs(diffs[0])
        return drift, vol

    # ── Структурные методы (используют MultiTFLevelCache) ────────────────────

    def __score_level_context_mtf(self) -> float:
        """
        Поведение цены у уровней со всех трёх горизонтов (неделя/месяц/полгода).

        Для каждого горизонта строится независимый скор (логика та же что в
        score_level_context), затем берётся взвешенное среднее: более долгосрочные
        уровни весят больше (полгода > месяц > неделя), т.к. на них сосредоточено
        больше ликвидности и памяти участников.

        Окно поведенческого анализа (~3 ч) остаётся адаптивным по таймфрейму,
        но сами уровни берутся из кеша (пересчитываются по TTL, не на каждом баре).
        """
        candles = self.__candles
        if len(candles) < 20:
            return 0.0
        horizon_levels = self.__level_cache.nearest_across_horizons
        return score_level_context(candles, external_nearest=horizon_levels)

    def __score_market_structure_mtf(self) -> float:
        """Слом структуры — вызывает score_market_structure на l1_buffer для большего охвата."""
        buf = self.__l1_buffer if len(self.__l1_buffer) >= 30 else self.__candles
        return score_market_structure(buf)

    def __score_spring_mtf(self) -> float:
        """Сжатие пружины — вызывает score_spring на текущем окне свечей."""
        return score_spring(self.__candles)

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
        """Тонкая обёртка (для обратной совместимости) — реальная логика в
        __methods_agree_with_reason."""
        ok, _ = self.__methods_agree_with_reason(scores, direction)
        return ok

    def __sign_stability_score(self, sign_val: int) -> float:
        """P2: знаковая стабильность взамен сырого std composite.
        sign_stability — взвешенная по свежести доля совпадений знака с
        последним composite; amplitude — средняя |c|/порог; group_stability —
        IC-взвешенная доля стабильных групп; l2_confirm — подтверждение L2.
        Возвращает stability_score ∈ [0,1]."""
        hist = self.__composite_history
        if len(hist) < 2:
            return 1.0   # нет данных — не блокируем
        last = hist[-1]
        N = len(hist)
        decay = GATE_STABILITY_DECAY
        weights = [math.exp(-decay * (N - 1 - i)) for i in range(N)]
        wsum = sum(weights) or 1.0
        last_sign = 1 if last >= 0 else -1
        sign_stability = sum(
            w * (1.0 if ((1 if c >= 0 else -1) == last_sign) else 0.0)
            for w, c in zip(weights, hist)
        ) / wsum
        thr = self.__threshold if self.__threshold > 0 else SIGNAL_THRESHOLD
        amplitude = (sum(abs(c) for c in hist) / N) / thr
        amplitude = min(1.0, amplitude)
        # group_stability: IC-взвешенная доля групп, согласных по знаку с last
        score_map = self.__last_scores
        stable_groups = 0.0
        total_groups = 0.0
        for members in _GATE_GROUPS.values():
            gnet = sum(
                self.__ic(n).weight() * score_map.get(n, 0.0)
                for n in members
            )
            total_groups += 1.0
            if (1 if gnet >= 0 else -1) == last_sign:
                stable_groups += 1.0
        group_stability = stable_groups / total_groups if total_groups else 0.0
        l2 = self.__cached_mtf5_composite
        l2_confirm = 1.0 if ((1 if l2 >= 0 else -1) == last_sign) else 0.6
        return (sign_stability * 0.4 + amplitude * 0.3
                + group_stability * 0.2 + l2_confirm * 0.1)

    def __methods_agree_with_reason(
        self, scores: list[float], direction: SignalType,
    ) -> tuple[bool, str]:
        """Гейт согласия методов с причиной отказа (для счётчиков).
        Условия: 1a доля силы / 1b IC-net / 2 групповая независимость /
        3 знаковая стабильность (P2) / 4 конфликт L2 / 5 вето кластеров (P7).
        P5: порог доли согласия адаптивен по L1-скору."""
        sign_val = 1 if direction == SignalType.LONG else -1
        n_base = len(BASE_METHOD_NAMES)
        score_map = dict(zip(BASE_METHOD_NAMES, scores[:n_base]))

        # Блокировка контртрендового LONG в trending_down: статистически убыточен.
        if self.__last_regime == "trending_down" and direction == SignalType.LONG:
            return False, "blocked_counter_trend"

        # Динамический фильтр по IC: вместо захардкоженных имён — методы, у которых
        # ic_smoothed > IC_KEY_THRESHOLD в текущем режиме (per-regime из __ic_priors).
        # Работает только после прогрева (IC_WINDOW/2 баров); до этого — нейтрально.
        # Правила:
        #   • среди IC-сильных методов ни один не согласен → блокировать
        #   • 2+ IC-сильных согласны → fast-pass (прошли доп. фильтр)
        _IC_KEY_THRESHOLD = 0.05   # ic_smoothed > 5% edge → метод "ключевой"
        _IC_KEY_MIN_CONF  = 0.40   # мин. уверенность (n_effective >= ~20)
        _ic_warm = self.__ic_bar_counter >= IC_WINDOW // 2
        _key_fast_pass = False
        if _ic_warm:
            _ic_strong = [
                name for name in score_map
                if self.__ic(name).ic_smoothed > _IC_KEY_THRESHOLD
                and self.__ic(name).confidence() >= _IC_KEY_MIN_CONF
            ]
            if len(_ic_strong) >= 2:
                _ic_key_agree = sum(
                    1 for name in _ic_strong
                    if score_map[name] * sign_val > AGREE_SCORE_MIN
                )
                if _ic_key_agree == 0:
                    return False, "ic_key_none_agree"
                _key_fast_pass = _ic_key_agree >= 2

        # P5: адаптивный порог доли согласия по L1-контексту (клип 0.25..0.60).
        # Для сделок ПО тренду (trending_down SHORT / trending_up LONG) снижаем
        # базовый порог — режим уже является дополнительным фильтром направления.
        is_trend_follow = (
            (self.__last_regime == "trending_down" and direction == SignalType.SHORT) or
            (self.__last_regime == "trending_up"   and direction == SignalType.LONG)
        )
        base_share = AGREE_SHARE_TREND_FOLLOW if is_trend_follow else AGREE_SHARE_MIN
        agreement_threshold = base_share - 0.10 * self.__l1_score * sign_val
        agreement_threshold = max(0.25, min(0.60, agreement_threshold))

        agree_strength = 0.0
        total_strength = 0.0
        for name, sv in score_map.items():
            if abs(sv) < AGREE_SCORE_MIN:
                continue
            strength = self.__weights[name].weight * abs(sv)
            if name in MICROSTRUCTURE_METHOD_NAMES:
                strength *= MICROSTRUCTURE_AGREE_BOOST
            total_strength += strength
            if (sv > 0) == (sign_val > 0):
                agree_strength += strength
        if not _key_fast_pass and (total_strength <= 0 or not (
            agree_strength >= AGREE_STRENGTH_MIN and
            agree_strength / total_strength >= agreement_threshold
        )):
            return False, "methods_disagree"

        net = sum(
            self.__ic(name).weight() * sv * sign_val
            for name, sv in score_map.items()
            if abs(sv) >= AGREE_SCORE_MIN
        )
        if net < GATE_NET_AGREEMENT_THRESHOLD:
            return False, "gate_net_agreement"

        groups_agree = sum(
            1 for group_members in _GATE_GROUPS.values()
            if sum(
                self.__ic(name).weight() * sv * sign_val
                for name, sv in score_map.items()
                if name in group_members and abs(sv) >= AGREE_SCORE_MIN
            ) > 0
        )
        if groups_agree < GATE_MIN_GROUPS_AGREE:
            return False, "gate_group_diversity"

        # ── Условие 3 (P2): знаковая стабильность вместо сырого std ────────────
        if len(self.__composite_history) >= 2:
            if self.__sign_stability_score(sign_val) < GATE_STABILITY_MIN:
                return False, "gate_composite_std"

        l2 = self.__cached_mtf5_composite
        l3 = self.__last_composite
        if (abs(l2) > GATE_L2_CONFLICT_THRESHOLD and
                l2 * sign_val < 0 and l3 * sign_val > 0):
            return False, "gate_l2_conflict"

        return True, ""

    def __advance_narrative(
            self, base_score_dict: dict, closes: list[float], regime: str, exhaustion: bool,
    ) -> None:
        """
        Один шаг FSM сюжета (narrative.py) — вызывается из __compute_composite
        на каждом баре, ДО гейта в analyze_candles/backtest-циклах, чтобы
        __narrative_allows видел уже обновлённое состояние текущего бара.
        Теги считаются по сырым (ненормализованным/невзвешенным) base_score_dict
        — нарратив описывает, что "сказали" методы, а не то, как они уже
        свёрнуты в composite весами/режимными множителями.
        """
        trend = classify_directional(
            base_score_dict, "Тренд", thresholds=self.__narrative_thresholds, regime=regime,
        )
        volume = classify_volume(
            base_score_dict, "Объём", thresholds=self.__narrative_thresholds, regime=regime,
        )
        # % изменение цены за окно — тот же горизонт, что у группы "Тренд".
        lookback = min(20, len(closes) - 1)
        if lookback > 0 and closes[-1 - lookback] != 0:
            price_move_pct = (closes[-1] - closes[-1 - lookback]) / closes[-1 - lookback] * 100
        else:
            price_move_pct = 0.0
        price_reaction = classify_price_reaction(price_move_pct, trend)

        self.__narrative_state = update_narrative(
            self.__narrative_state, trend=trend, volume=volume,
            price_reaction=price_reaction, regime=regime, exhaustion=exhaustion,
        )
        # BOCD–FSM синхронизация: BOCD первичный детектор режима — FSM не
        # может оставаться в CONFIRMED пока BOCD неуверен. Откат в WATCHING
        # блокирует новые входы до восстановления стабильности режима.
        if self.__regime_confidence < BOCD_NARRATIVE_SYNC_THR:
            if self.__narrative_state.name == "CONFIRMED_UPTREND":
                self.__narrative_state = NarrativeState("WATCHING_ACCUMULATION")
            elif self.__narrative_state.name == "CONFIRMED_DOWNTREND":
                self.__narrative_state = NarrativeState("WATCHING_DISTRIBUTION")
        self.__last_narrative_tags = {
            "trend": trend.value, "volume": volume.value,
            "price_reaction": price_reaction.value,
        }
        self.__update_narrative_lifecycle(regime)

    def __update_narrative_lifecycle(self, regime: str) -> None:
        """P6: жизненный цикл FSM нарратива по (ticker, regime).
        Если FSM не доходит до CONFIRMED 200 баров → degraded (порог ×1.5);
        ещё 200 → disabled (гейт нарратива не блокирует). Восстановление в
        active, если IC любого тега выше порога значимости."""
        ticker = self.__settings.ticker
        lc = self.__narrative_lifecycle.setdefault(ticker, {})
        cnt = self.__narrative_bars_since_confirmed.setdefault(ticker, {})
        state = lc.get(regime, "active")
        confirmed = self.__narrative_state.name.startswith("CONFIRMED")
        if confirmed:
            cnt[regime] = 0
        else:
            cnt[regime] = cnt.get(regime, 0) + 1
        n = cnt.get(regime, 0)
        if n >= 400:
            state = "disabled"
        elif n >= 200:
            state = "degraded"
        elif confirmed:
            state = "active"
        # Восстановление: если IC любого «трендового/объёмного» тега значим —
        # нарратив снова информативен, возвращаем в active.
        if state != "active":
            recovered = any(
                abs(self.__ic(m).ic_smoothed) > IC_SIGNIFICANCE
                for m in ("PRICE_TREND", "VOL_MOMENTUM", "TREND_QUALITY")
            )
            if recovered:
                state = "active"
                cnt[regime] = 0
        lc[regime] = state

    def __narrative_allows(self, direction: SignalType,
                           composite: float = 0.0, threshold: float = 0.0) -> bool:
        """
        Бинарный гейт (не множитель — см. narrative.py docstring): сигнал
        проходит только если сюжет уже СЛОЖИЛСЯ (is_actionable), совпадает по
        направлению с composite, и этому (narrative, regime) сейчас доверяют
        по истории сделок (NarrativeWeights, EWA quality).

        Fast-track: если composite >= threshold * 1.5 (очень сильный сигнал,
        уже прошедший все остальные гейты) — FSM не блокирует вход. Ожидание
        CONFIRMED при таком перевесе методов означало бы опоздание на 25-75 минут.
        """
        # P6: жизненный цикл нарратива — disabled пропускает гейт полностью.
        lc = self.__narrative_lifecycle.get(self.__settings.ticker, {})
        lifecycle = lc.get(self.__last_regime, "active")
        if lifecycle == "disabled":
            return True
        # Fast-track: очень сильный composite обходит требование CONFIRMED.
        if threshold > 0 and abs(composite) >= threshold * 1.5:
            sign = 1 if direction == SignalType.LONG else -1
            # Разрешаем если FSM не против (neutral или совпадает по направлению).
            state = self.__narrative_state
            if state.direction == 0 or state.direction == sign:
                return True
        state = self.__narrative_state
        if not state.is_actionable:
            return False
        sign = 1 if direction == SignalType.LONG else -1
        if state.direction != sign:
            return False
        # degraded → порог доверия жёстче (×1.5).
        min_q = 0.45 * 1.5 if lifecycle == "degraded" else 0.45
        return self.__narrative_weights.is_trusted(state.name, self.__last_regime, min_quality=min_q)

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
        Прогрев-гейт по числу сделок убран: warm-up теперь встроен в сам
        MethodWeight.update() (HEDGE_WARMUP_TRADES) — отдельный штраф по
        выборке здесь давал ложную уверенность в "ненадёжности" там, где
        выборка просто маленькая и шум нельзя отличить от сигнала, а не где
        модель размашисто переобучена.
        """
        base = self.__threshold if base is None else base
        mult = 1.0
        # Используем per-regime качество если для текущего режима накопилась статистика,
        # иначе fallback на глобальное. Это предотвращает ужесточение порога в trending_up
        # из-за убыточной серии в ranging и наоборот.
        regime_q = self.__rolling_quality_by_regime.get(self.__last_regime)
        effective_q = regime_q if regime_q is not None else self.__rolling_quality
        if effective_q < LOW_QUALITY_THRESHOLD:
            mult *= LOW_QUALITY_MULT
        return base * mult

    def __update_playbook_stats(self, regime: str, playbooks, r_value: float,
                                win: bool, mfe: float, mae: float) -> None:
        """P3: накопить статистику плейбука и при необходимости отключить его.
        P9: попутно копим распределение MFE."""
        if not playbooks:
            return
        rg_stats = self.__playbook_stats.setdefault(regime, {})
        rg_mfe = self.__mfe_distribution.setdefault(regime, {})
        for pb in playbooks:
            st = rg_stats.setdefault(pb, {"n": 0, "wins": 0, "sum_r": 0.0,
                                          "mfe_list": [], "mae_list": []})
            st["n"] += 1
            st["wins"] += int(win)
            st["sum_r"] += r_value
            st["mfe_list"].append(mfe)
            st["mae_list"].append(mae)
            if len(st["mfe_list"]) > 200:
                st["mfe_list"].pop(0)
            if len(st["mae_list"]) > 200:
                st["mae_list"].pop(0)
            # P9: распределение MFE для трейлинга.
            dist = rg_mfe.setdefault(pb, [])
            dist.append(mfe)
            if len(dist) > 200:
                dist.pop(0)
            # P3: отключение убыточного плейбука.
            avg_r = st["sum_r"] / st["n"] if st["n"] else 0.0
            disabled = self.__playbook_disabled.setdefault(regime, set())
            if st["n"] >= PLAYBOOK_DISABLE_MIN_N and avg_r < PLAYBOOK_DISABLE_MIN_AVG_R:
                disabled.add(pb)
            elif pb in disabled and avg_r >= PLAYBOOK_DISABLE_MIN_AVG_R:
                disabled.discard(pb)

    def __trail_activation_pct(self, regime: str, playbooks):
        """P9: уровень активации трейлинга = p50 MFE для (regime, playbook),
        если накоплено >= PLAYBOOK_DISABLE_MIN_N значений. None — недостаточно."""
        rg = self.__mfe_distribution.get(regime, {})
        best = None
        for pb in (playbooks or []):
            dist = rg.get(pb)
            if dist and len(dist) >= PLAYBOOK_DISABLE_MIN_N:
                srt = sorted(dist)
                p50 = srt[len(srt) // 2]
                if best is None or p50 < best:
                    best = p50
        return best

    def get_activation_levels(self) -> dict:
        """Публичный метод: вернуть activation_levels для open_position.
        Использует текущие __last_playbooks и __last_regime + накопленные MFE.
        Если данных недостаточно — вернуть пустой dict (risk.py возьмёт дефолты)."""
        from joint_calibration import calibrate_playbook_activation_levels
        rg_mfe = self.__mfe_distribution.get(self.__last_regime, {})
        if not rg_mfe or not self.__last_playbooks:
            return {}
        # Собираем MFE только по активным плейбукам текущего сигнала
        filtered = {pb: rg_mfe[pb] for pb in self.__last_playbooks if pb in rg_mfe}
        if not filtered:
            return {}
        # calibrate_playbook_activation_levels возвращает {playbook: {breakeven, partial, trailing}}
        per_pb = calibrate_playbook_activation_levels(filtered)
        # Берём наименьшие уровни (самый осторожный плейбук из активных) как единый dict
        if not per_pb:
            return {}
        from risk_config import BREAKEVEN_SLIDE_START_R, BREAKEVEN_SLIDE_STEP2_R, BREAKEVEN_AT_R
        defaults = {"breakeven": BREAKEVEN_SLIDE_START_R,
                    "partial": BREAKEVEN_SLIDE_STEP2_R,
                    "trailing": BREAKEVEN_AT_R}
        keys = ("breakeven", "partial", "trailing")
        merged = {}
        for k in keys:
            vals = [per_pb[pb][k] for pb in per_pb if k in per_pb[pb]]
            # Если ни один плейбук не дал значение — используем дефолт явно,
            # чтобы activation_levels всегда был полным (не было молчаливого
            # fallback в check_exit через lvl.get(k, default)).
            merged[k] = min(vals) if vals else defaults[k]
        return merged

    def __system_uncertainty(self) -> float:
        """Агрегатор неопределённости системы ∈ [0,1] по нескольким источникам:
        noise_mode (все IC незначимы), статистический слом, degraded-нарратив.
        Берём максимум вклада, слегка усиливая если активно несколько."""
        priors = self.__ic_priors.get(self.__last_regime) or self.__ic_priors["__global__"]
        noise = any(p.noise_mode for p in priors.values())
        lc = self.__narrative_lifecycle.get(self.__settings.ticker, {})
        contributions = {
            "noise_mode": 0.5 if noise else 0.0,
            "stat_break": self.__stat_break.uncertainty,
            "narrative_degraded": 0.2 if lc.get(self.__last_regime) == "degraded" else 0.0,
        }
        if not contributions:
            return 0.0
        n_active = sum(1 for v in contributions.values() if v > 0.1)
        return max(contributions.values()) * (1.0 + 0.1 * max(0, n_active - 1))

    def __effective_signal_threshold(self, base: float, direction: SignalType,
                                     regime: str, hour: int) -> float:
        """Единый порог сигнала с учётом P5 (L1), P8 (адаптеры), P10 (слом),
        P1 (noise_mode) и системной неопределённости.
        base — уже адаптированный под режим/энтропию порог."""
        sign_val = 1 if direction == SignalType.LONG else -1
        # P5: L1-скор смещает порог (по тренду — легче, против — труднее).
        thr = base * (1.0 - 0.3 * self.__l1_score * sign_val)
        # Контртрендовый LONG в trending_down — исторически убыточен (-22% net).
        # Дополнительный множитель ×1.5: нужна вдвое более сильная уверенность.
        if regime == "trending_down" and direction == SignalType.LONG:
            thr *= 1.5
        thr = max(0.06, min(0.24, thr))
        # P8: волатильность/тикер/режим/сессия.
        thr = self.__threshold_adapters.effective_threshold(thr, regime, hour)
        # P1: режим шума — порог ×1.5.
        # Холодный старт: первые IC_WINDOW/2 баров IC физически не мог накопиться —
        # штрафовать за отсутствие данных которых ещё не могло быть логически неверно.
        priors = self.__ic_priors.get(regime) or self.__ic_priors["__global__"]
        _ic_warm = self.__ic_bar_counter >= IC_WINDOW // 2
        if _ic_warm and any(p.noise_mode for p in priors.values()):
            thr *= 1.5
        # P10: статистический слом > 0.3 → ×(1+uncertainty).
        if self.__stat_break.uncertainty > 0.3:
            thr *= (1.0 + self.__stat_break.uncertainty)
        # Системная неопределённость — мягкий дополнительный множитель.
        su = self.__system_uncertainty()
        if su > 0.3:
            thr *= (1.0 + 0.5 * su)
        # ОИ-консенсус ПРОТИВ направления: ≥3 активных ОИ-скора и все против —
        # юр/физ картина согласованно противоречит свечам. Не вето (у уровня
        # перенабранная толпа — топливо разворота, см. плейбук OI_CONSENSUS),
        # а ужесточение порога ×1.25 — в стиле warmup/low-quality тормозов.
        _oi_act = [v for v in (
            self.__last_scores.get(n, 0.0)
            for n in ("OI_SQUEEZE", "INST_OI", "RETAIL_CONTRA",
                      "DELTA_QUADRANT", "OI_ABSORPTION")
        ) if abs(v) >= 0.15]
        if len(_oi_act) >= 3 and all(v * sign_val < 0 for v in _oi_act):
            thr *= 1.25
        return thr

    def __recalc_auto_atr(self) -> None:
        """
        Авто-подбор ATR_TAKE_K/ATR_STOP_K/ATR_SCALE_EXP по исторической
        выгрузке — раз в день, тот же sweep, что в дашборде (run_backtest_one):
        перебираем AUTO_ATR_TAKE_KS x AUTO_ATR_STOP_KS x AUTO_ATR_SCALE_EXPS,
        берём тройку с лучшим expectancy_pct.
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

        # MethodCalibrator: еженедельный пересчёт (внутри needs_recalc проверяет 7 дней).
        if self.__method_calibrator is not None:
            try:
                _mc_ticker = self.__settings.ticker
                if self.__method_calibrator.needs_recalc(_mc_ticker):
                    _mc_candles = self.__atr_history_provider(_mc_ticker)
                    if _mc_candles and len(_mc_candles) >= self.__candle_window + 20:
                        _mc_raw = [
                            {"close": _to_f(c.close), "high": _to_f(c.high),
                             "low": _to_f(c.low), "vol": float(c.volume)}
                            for c in _mc_candles
                        ]
                        self.__method_calibrator.calibrate(_mc_ticker, _mc_raw)
            except Exception as _mc_exc:
                logger.warning(f"MethodCalibrator daily recalc failed: {_mc_exc}")

        try:
            history = self.__atr_history_provider(self.__settings.ticker)
            if not history:
                return
            signals = sorted(self.backtest_scan_signals(history), key=lambda s: s["entry_time"])
            # Fit/eval split: раньше (tk, sk) выбирался по expectancy_pct на том
            # же signals, на котором же и считался — best-of-N по шумной выборке
            # систематически переоценивает узкие стопы, которые в этом окне
            # случайно не выбило. Считаем sweep на отложенном "будущем" хвосте
            # истории, не участвовавшем в выборе кандидатов.
            # Rolling lookback: не тянуть параметры к старым режимным данным.
            lookback = signals[-ATR_EVAL_LOOKBACK:]
            split = int(len(lookback) * 0.6)
            eval_signals = lookback[split:] if len(lookback) - split >= AUTO_ATR_MIN_TRADES else lookback
            # fixed-режим на том же eval-окне — бейзлайн для shrinkage и для
            # проверки значимости edge (см. _shrunk_atr_score, ATR_MIN_EDGE_SEM):
            # без него argmax по 27 кандидатам (3×3×3) находит "победителя"
            # по шуму, который потом хуже живого fixed-режима ("optimizer's curse").
            fixed_res = self.backtest_barriers(signals=eval_signals, take_mult=self.__long_take,
                                                stop_mult=self.__long_stop, record_history=False)
            fixed_pct = fixed_res.get("expectancy_pct", 0.0)
            best = None
            for tk in AUTO_ATR_TAKE_KS:
                for sk in AUTO_ATR_STOP_KS:
                    for ex in AUTO_ATR_SCALE_EXPS:
                        res = self.backtest_barriers(signals=eval_signals, atr_take_k=tk, atr_stop_k=sk,
                                                      atr_scale_exp=ex, record_history=False, return_trades=True)
                        cand_trades = res.get("trades", [])
                        if len(cand_trades) < AUTO_ATR_MIN_TRADES:
                            continue
                        score, sem = _shrunk_atr_score(cand_trades, fixed_pct)
                        if best is None or score > best[1]:
                            best = ((tk, sk, ex), score, sem)
            if best is not None and best[1] - ATR_MIN_EDGE_SEM * best[2] > fixed_pct:
                (tk, sk, ex), score, sem = best
                self.__auto_atr_take_k, self.__auto_atr_stop_k, self.__auto_atr_scale_exp = tk, sk, ex
                logger.info(f"{self.__settings.ticker}: авто-ATR k={tk}/{sk} exp={ex} (shrunk_score={score:.4f}%, fixed={fixed_pct:.4f}%)")
            else:
                logger.info(f"{self.__settings.ticker}: авто-ATR — нет значимого edge над fixed "
                            f"(fixed={fixed_pct:.4f}%), параметры не меняем")
        except Exception:
            logger.exception(f"{self.__settings.ticker}: авто-подбор ATR_TAKE_K/ATR_STOP_K упал")

    def __noise_stop_scale(self) -> float:
        """
        Адаптивный множитель ширины стопа по Variance Ratio (_variance_ratio,
        тот же расчёт что в VR_SIGNAL) — "в моменте", на текущем окне свечей.
        VR<0.7 — движение шумовое/возвратное: узкий стоп оправдан, шанс на
        устойчивое продолжение низкий, держать широкий стоп — просто отдавать
        больше при развороте. VR>1.3 — персистентный тренд: стопу нужен запас,
        чтобы не выбивало обычным шумом внутри движения. Гладкая интерполяция
        между порогами VR_SIGNAL (0.7/1.3), без скачков на границах.
        """
        vr = _variance_ratio(self.__candles)
        if vr is None:
            return 1.0
        if vr <= 0.7:
            return 0.7
        if vr >= 1.3:
            return 1.15
        if vr <= 1.0:
            return 0.7 + (vr - 0.7) / 0.3 * 0.3
        return 1.0 + (vr - 1.0) / 0.3 * 0.15

    def __take_stop_mults(self, direction: SignalType, atr_pct: float) -> tuple[Decimal, Decimal]:
        """
        Множители take/stop. Если в settings заданы ATR_TAKE_K и ATR_STOP_K —
        уровни считаются от ATR (динамически под волатильность): take = 1 ± k*ATR%.
        Если не заданы, но подключён __atr_history_provider — используется
        авто-подобранная пара (__recalc_auto_atr). Иначе — фиксированные
        LONG_*/SHORT_* (полная обратная совместимость).

        Оба барьера дополнительно масштабируются __noise_stop_scale() —
        адаптация не только к волатильности (ATR%), но и к тому, шумовое
        сейчас движение или трендовое (раньше масштабировался только стоп,
        из-за чего требуемое R:R росло именно в шумных условиях — см.
        backtest_barriers).

        ATR-ширина дополнительно умножается на ATR_SCALE_HOLDING_BARS**exp —
        компенсация того, что atr_pct меряет волатильность одного бара, а
        сделка держится десятки баров (см. ATR_SCALE_HOLDING_BARS).
        """
        noise_scale = self.__noise_stop_scale()
        # Множитель тейка от накопленной энергии хаоса: чем дольше был боковик,
        # тем больше позиций накоплено и тем дальше ставим тейк при каскаде.
        # Стоп не трогаем — он защищает от потерь независимо от энергии.
        chop_k = _chop_energy_mult_candle(self.__candles) if len(self.__candles) >= 30 else 1.0
        take_k = self.__atr_take_k if self.__atr_take_k is not None else self.__auto_atr_take_k
        stop_k = self.__atr_stop_k if self.__atr_stop_k is not None else self.__auto_atr_stop_k
        if take_k is not None and stop_k is not None and atr_pct > 0:
            scale_exp = self.__atr_scale_exp if self.__atr_scale_exp is not None else self.__auto_atr_scale_exp
            hold_scale = ATR_SCALE_HOLDING_BARS ** scale_exp if scale_exp else 1.0
            stop_raw = stop_k * atr_pct * hold_scale * noise_scale
            stop_raw = max(stop_raw, MIN_STOP_DIST_PCT)
            take_raw = take_k * atr_pct * hold_scale * noise_scale * chop_k
            take_raw = max(take_raw, stop_raw * MIN_TAKE_STOP_RATIO)
            take_off = Decimal(str(take_raw))
            stop_off = Decimal(str(stop_raw))
            if direction == SignalType.LONG:
                return Decimal("1") + take_off, Decimal("1") - stop_off
            return Decimal("1") - take_off, Decimal("1") + stop_off
        scale = Decimal(str(noise_scale))
        chop_d = Decimal(str(chop_k))
        if direction == SignalType.LONG:
            take_off = (self.__long_take - Decimal("1")) * scale * chop_d
            stop_off = (Decimal("1") - self.__long_stop) * scale
        else:
            take_off = (Decimal("1") - self.__short_take) * scale * chop_d
            stop_off = (self.__short_stop - Decimal("1")) * scale
        # Те же ограничения для fixed-режима
        stop_off = max(stop_off, Decimal(str(MIN_STOP_DIST_PCT)))
        take_off = max(take_off, stop_off * Decimal(str(MIN_TAKE_STOP_RATIO)))
        if direction == SignalType.LONG:
            return Decimal("1") + take_off, Decimal("1") - stop_off
        return Decimal("1") - take_off, Decimal("1") + stop_off

    def __make_signal(
            self,
            signal_type: SignalType,
            take_mult: Decimal,
            stop_mult: Decimal,
            scores: list[float],
    ) -> Signal:
        last = self.__candles[-1]
        _close = quotation_to_decimal(last.close)
        # Лимитный вход: цена чуть лучше рынка, Trader выставит лимитку.
        _offset = Decimal(str(LIMIT_ENTRY_OFFSET_PCT))
        if signal_type == SignalType.LONG:
            entry = _close * (Decimal("1") - _offset)
        else:
            entry = _close * (Decimal("1") + _offset)

        method_scores = {name: scores[i] for i, name in enumerate(ALL_METHOD_NAMES)}
        # confidence должен опираться на тот же composite, что реально
        # пересёк порог в analyze_candles (с regime/RQA/wavelet-множителями
        # из __compute_composite), а не на пересчёт по сырым scores —
        # иначе risk.position_size()/can_open() получают эдж, не совпадающий
        # с фактическим сигналом.
        self.__confidence = max(0.0, min(1.0, 0.5 + 0.5 * abs(self.__last_composite)))

        self.__open_trade = OpenTrade(
            signal_type=signal_type,
            entry_price=entry,
            method_scores=method_scores,
            commission_rt=commission_rt(self.__settings.is_future),
            narrative_name=self.__narrative_state.name,
            playbooks=list(self.__last_playbooks),
            regime=self.__last_regime,
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
        # Trade-level IC: пишем aligned_score каждого метода + quality этой сделки.
        _dir_sign = 1 if self.__open_trade.signal_type == SignalType.LONG else -1
        self.__ic_trade_quality_buf.append(quality)
        for name in ALL_METHOD_NAMES:
            sc = self.__open_trade.method_scores.get(name, 0.0)
            self.__ic_trade_score_buf[name].append(sc * _dir_sign)
        # Ограничиваем размер буфера
        if len(self.__ic_trade_quality_buf) > IC_QUALITY_WINDOW:
            self.__ic_trade_quality_buf = self.__ic_trade_quality_buf[-IC_QUALITY_WINDOW:]
            for name in ALL_METHOD_NAMES:
                self.__ic_trade_score_buf[name] = self.__ic_trade_score_buf[name][-IC_QUALITY_WINDOW:]
        regime_key = self.__open_trade.regime if hasattr(self.__open_trade, "regime") else self.__last_regime
        prev_rq = self.__rolling_quality_by_regime.get(regime_key, 0.5)
        self.__rolling_quality_by_regime[regime_key] = (1 - QUALITY_ALPHA) * prev_rq + QUALITY_ALPHA * quality

        # P3: статистика плейбуков по живой сделке. r-аппроксимация = (mfe-mae)/mae
        # (или mfe-mae если стоп не сработал), win = mfe>mae.
        _ot = self.__open_trade
        _r = (mfe - mae) / mae if mae > 1e-9 else (mfe - mae)
        self.__update_playbook_stats(
            _ot.regime, _ot.playbooks, _r, mfe > mae, mfe, mae,
        )

        self.__narrative_weights.record_outcome(
            self.__open_trade.narrative_name, self.__last_regime, quality,
        )

        # Нейтральная точка hedge = текущее rolling_quality, а не 0.5.
        # Если среднее качество сделок = 0.40, то метод с target=0.42 уже
        # выше среднего и должен получить небольшую награду, а не штраф.
        # Без этой коррекции при quality_avg < 0.5 все методы систематически
        # деградируют к минимуму 0.05 по мере накопления выборки.
        _neutral = max(0.20, min(0.80, self.__rolling_quality))
        for name in ALL_METHOD_NAMES:
            score = self.__open_trade.method_scores.get(name, 0.0)
            if abs(score) < 0.05:
                continue
            # aligned — по ЭФФЕКТИВНОМУ скору (после IC-инверсии), как метод
            # реально голосовал в композите. Иначе IC.invert и отрицательный
            # Hedge-вес учатся на одном и том же свойстве и, сработав вместе,
            # дают двойную инверсию — голос возвращается в плохое направление.
            eff_score = -score if self.__ic(name).invert else score
            aligned = (eff_score > 0 and self.__open_trade.signal_type == SignalType.LONG) or \
                      (eff_score < 0 and self.__open_trade.signal_type == SignalType.SHORT)
            target = quality if aligned else 1.0 - quality
            # Мультипликатор обновления = IC-точность метода, а не abs(score).
            # abs(score) отражает "громкость" — уверенные но плохие методы
            # получали такой же сильный апдейт как точные. ICPrior.weight()
            # нормирует накопленную предсказательную силу в [0.1, 1.0].
            ic_acc = self.__ic(name).weight()
            self.__weights[name].update(target, ic_acc, neutral=_neutral)
            self.__ticker_weights[name].update(target, ic_acc, neutral=_neutral)
            if self.__last_regime in self.__regime_weights:
                self.__regime_weights[self.__last_regime][name].update(target, ic_acc, neutral=_neutral)

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
                code_version=STRATEGY_VERSION,
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

    # ── Lasso prior ───────────────────────────────────────────────────────────

    def __load_lasso_priors(self) -> dict[str, float]:
        """Читает data/lasso_weights.json → prior-вес [0.05, 1.0] для каждого метода.

        Lasso-коэффициенты — результат регрессии outcome ~ method_scores.
        Нулевой или отрицательный коэффициент → prior=0.05 (минимальный вес);
        положительный → линейно в [0.05, 1.0] относительно максимума.

        Это не заменяет Hedge, а задаёт стартовую точку и гравитационный центр
        до накопления достаточного числа живых сделок (LASSO_SHRINK_N).
        """
        path = "data/lasso_weights.json"
        if not os.path.exists(path):
            return {}
        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
            entry = data.get(self.__settings.figi, {})
            coefs = entry.get("coefficients", {})
            if not coefs:
                return {}
            max_pos = max((v for v in coefs.values() if v > 0), default=0.0)
            if max_pos <= 0:
                return {}
            priors: dict[str, float] = {}
            for name, coef in coefs.items():
                if coef <= 0:
                    priors[name] = 0.05
                else:
                    priors[name] = max(0.05, min(1.0, 0.05 + 0.95 * coef / max_pos))
            logger.info(
                f"{self.__settings.ticker}: lasso prior загружен для "
                f"{sum(1 for v in priors.values() if v > 0.05)}/{len(priors)} методов"
            )
            return priors
        except Exception as e:
            logger.warning(f"Could not load lasso priors: {e}")
            return {}

    def reload_lasso_priors(self) -> None:
        """Перечитать lasso prior без пересоздания стратегии.
        Вызывать после еженедельного прогона lasso_calibration.py."""
        self.__lasso_priors = self.__load_lasso_priors()


    @staticmethod
    def priors_from_lasso_coefficients(coefficients: dict[str, float]) -> dict[str, float]:
        """Та же конвертация коэффициент → prior [0.05, 1.0], что в
        __load_lasso_priors, вынесена наружу — используется адаптивной
        пере-калибровкой внутри бэктеста (run_backtest_one), где
        коэффициенты приходят из fit_lasso_coefficients() в памяти,
        а не из data/lasso_weights.json."""
        max_pos = max((v for v in coefficients.values() if v > 0), default=0.0)
        if max_pos <= 0:
            return {}
        return {
            name: (0.05 if coef <= 0 else max(0.05, min(1.0, 0.05 + 0.95 * coef / max_pos)))
            for name, coef in coefficients.items()
        }

    def set_lasso_priors(self, priors: dict[str, float]) -> None:
        """Подставить lasso-приоры напрямую (in-memory), минуя файл —
        для адаптивной пере-калибровки в процессе бэктеста."""
        if priors:
            self.__lasso_priors = priors

    def set_narrative_thresholds(self, data: dict) -> None:
        """Подставить пороги narrative напрямую (in-memory), минуя файл —
        для адаптивной пере-калибровки в процессе бэктеста."""
        if data:
            self.__narrative_thresholds.set_data(data)

    def set_shared_ic_store(self, store, tf_minutes: int) -> None:
        """Подключить SharedICEWAStore для multi-account обучения.
        После вызова __ic_priors указывает на TF-срез общего хранилища —
        все обновления IC автоматически видны другим счетам с тем же TF."""
        bucket = store.ic_bucket(tf_minutes)
        if not bucket:
            # Инициализировать bucket данными из текущего (уже обученного) состояния
            for regime, methods in self.__ic_priors.items():
                bucket[regime] = dict(methods)
        self.__ic_priors = bucket

    # ── Персистентность весов ─────────────────────────────────────────────────

    def __weights_key(self) -> str:
        return self.__settings.figi

    def __load_global_ic_prior(self) -> None:
        """Warm-start глобального IC-prior'а из data/global_ic_prior.json.

        aggregate_ic.py агрегирует sign-IC по всем тикерам из history.json
        и пишет этот файл. При холодном старте тикера (n_updates==0) глобальный
        слой __ic_priors["__global__"] засевается знаком и «виртуальными»
        обновлениями — контрарные методы сразу получают invert=True, а не ждут
        20+ сделок на КАЖДОМ тикере отдельно.
        """
        if not os.path.exists(GLOBAL_IC_FILE):
            return
        try:
            with open(GLOBAL_IC_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
            loaded = 0
            global_bucket = self.__ic_priors["__global__"]
            for name, entry in data.items():
                if name not in global_bucket:
                    continue
                prior = global_bucket[name]
                if prior.n_updates > 0:
                    continue  # уже есть собственная история — не перезаписываем
                n_global = entry.get("n", 0)
                sign_ic = entry.get("sign_ic", 0.5)
                # sign_ic ∈ [0,1] → IC ∈ [-1,1]: 0.5 → 0 (нейтральный), 0.4 → -0.2 (контрарный)
                ic_equivalent = (sign_ic - 0.5) * 2.0
                prior.ic_smoothed = ic_equivalent
                prior.invert = entry.get("invert", False)
                # Виртуальные обновления — cap 25, чтобы собственные сделки тикера
                # могли перекрыть глобальный prior за разумное время.
                prior.n_updates = min(n_global // 10, 25)
                prior.n_updates_effective = float(prior.n_updates)
                loaded += 1
            if loaded:
                logger.info(
                    f"[{self.__settings.ticker}] Global IC prior warm-start: "
                    f"{loaded} methods, "
                    f"invert={[n for n,e in data.items() if e.get('invert')]}"
                )
        except Exception as exc:
            logger.warning(f"Could not load global IC prior: {exc}")

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

    def __load_ticker_weights(self) -> dict[str, MethodWeight]:
        tw: dict[str, MethodWeight] = {name: MethodWeight() for name in ALL_METHOD_NAMES}
        if not os.path.exists(WEIGHTS_FILE):
            return tw
        try:
            with open(WEIGHTS_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
            key = self.__settings.figi
            ticker_data = data.get(key, {}).get("__ticker__", {})
            for name in tw:
                if name in ticker_data:
                    d = ticker_data[name]
                    tw[name] = MethodWeight(
                        weight=d.get("weight", 0.30),
                        total=d.get("total", 0),
                        sum_quality=d.get("sum_quality", 0.0),
                    )
        except Exception as e:
            logger.warning(f"Could not load ticker weights: {e}")
        return tw

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
            data[key]["__ticker__"] = {
                name: {"weight": w.weight, "total": w.total, "sum_quality": w.sum_quality}
                for name, w in self.__ticker_weights.items()
            }
            data[key]["__regimes__"] = {
                regime: {
                    name: {"weight": w.weight, "total": w.total, "sum_quality": w.sum_quality}
                    for name, w in methods.items()
                }
                for regime, methods in self.__regime_weights.items()
            }
            with open(WEIGHTS_FILE, "w", encoding="utf-8") as f:
                json.dump(data, f, ensure_ascii=False, indent=2)
        except Exception as e:
            logger.warning(f"Could not save weights: {e}")

    def __load_regime_weights(self) -> dict[str, dict[str, MethodWeight]]:
        """Per-regime Hedge-веса (см. HEDGE_REGIME_MIN_OBS) — отдельные от
        глобальных self.__weights, хранятся в WEIGHTS_FILE под ключом
        "__regimes__", не ломая обратную совместимость со старым плоским форматом."""
        rw: dict[str, dict[str, MethodWeight]] = {
            regime: {name: MethodWeight() for name in ALL_METHOD_NAMES} for regime in REGIMES
        }
        if not os.path.exists(WEIGHTS_FILE):
            return rw
        try:
            with open(WEIGHTS_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
            key = self.__settings.figi
            regimes_data = data.get(key, {}).get("__regimes__", {})
            for regime in REGIMES:
                if regime not in regimes_data:
                    continue
                for name in rw[regime]:
                    if name in regimes_data[regime]:
                        d = regimes_data[regime][name]
                        rw[regime][name] = MethodWeight(
                            weight=d.get("weight", 0.5),
                            total=d.get("total", 0),
                            sum_quality=d.get("sum_quality", 0.0),
                        )
        except Exception as e:
            logger.warning(f"Could not load regime weights: {e}")
        return rw

    def __ic(self, name: str) -> ICPrior:
        """P4: ICPrior метода для текущего режима; фолбэк на глобальный слой."""
        rg = self.__last_regime
        bucket = self.__ic_priors.get(rg)
        global_bucket = self.__ic_priors.get("__global__", {})
        if name not in global_bucket:
            return ICPrior()   # метод убран из METHODS — нейтральный prior
        if bucket is None or name not in bucket or bucket[name].n_updates == 0:
            return global_bucket[name]
        return bucket[name]

    def __recalc_ic_priors(self) -> None:
        """Пересчитывает IC для каждого метода на скользящем окне.
        P1: per-method лаг (естественный горизонт). P4: обновляем и глобальный
        слой, и слой текущего режима. После апдейта помечаем noise_mode, если
        все IC незначимы (< IC_SIGNIFICANCE)."""
        max_lag = max(self.__ic_lags.values()) if self.__ic_lags else IC_FORWARD_LAG
        closes = self.__ic_close_buf[-IC_WINDOW - max_lag:]
        rg = self.__last_regime
        buckets = [self.__ic_priors["__global__"]]
        if rg in self.__ic_priors:
            buckets.append(self.__ic_priors[rg])
        n_trade = len(self.__ic_trade_quality_buf)
        use_quality_ic = n_trade >= IC_QUALITY_MIN_TRADES
        for name in ALL_METHOD_NAMES:
            scores = self.__ic_score_buf[name][-IC_WINDOW:]
            if len(scores) < 30:
                continue
            lag = self.__ic_lags.get(name, IC_FORWARD_LAG)
            closes_needed = closes[-(len(scores) + lag):]
            ic_price = _compute_ic(scores, closes_needed, lag)
            if use_quality_ic:
                t_scores = self.__ic_trade_score_buf[name][-n_trade:]
                ic_q = _compute_ic_quality(t_scores, self.__ic_trade_quality_buf)
                # Блендируем: quality-IC несёт прямой сигнал о торговом исходе,
                # price-IC — менее зашумлённый (обновляется на каждом баре) prior.
                ic_raw = IC_QUALITY_BLEND * ic_q + (1.0 - IC_QUALITY_BLEND) * ic_price
            else:
                ic_raw = ic_price
            for b in buckets:
                b[name].update(ic_raw, IC_SIGNIFICANCE)
        # P1: noise_mode — все IC ниже порога значимости (поток неинформативен).
        for b in buckets:
            noisy = all(abs(p.ic_smoothed) < IC_SIGNIFICANCE for p in b.values())
            for p in b.values():
                p.noise_mode = noisy

    def __blended_hedge_weight(self, name: str, regime_probs: dict[str, float]) -> float:
        """Hedge-вес метода — иерархический, два уровня shrinkage:

        Level 1 (Lasso → Global): если есть lasso_prior для метода,
          глобальный Hedge-вес притягивается к нему пропорционально числу
          сделок: alpha = total / (total + LASSO_SHRINK_N). При малом total
          lasso prior доминирует; с накоплением истории Hedge берёт управление.
          Это гарантирует, что методы без edge (lasso_prior ≈ 0.05) не растут
          в весе на первых сделках.

        Level 2 (Global → Per-regime): вместо бинарного порога (n >= 15)
          плавный α = n / (n + HEDGE_REGIME_SHRINK_N). При n=0 полностью
          global, при n=HEDGE_REGIME_SHRINK_N — 50/50.
          Это решает проблему редких режимов (stress, low_vol): их per-regime
          вес остаётся значимым только при достаточной статистике.
        """
        hedge_w = self.__weights[name]

        # Level 1: lasso prior → global
        lasso_prior = self.__lasso_priors.get(name)
        if lasso_prior is not None and hedge_w.total < LASSO_SHRINK_N * 4:
            lasso_alpha = hedge_w.total / (hedge_w.total + LASSO_SHRINK_N)
            global_weight = lasso_alpha * hedge_w.weight + (1.0 - lasso_alpha) * lasso_prior
        else:
            global_weight = hedge_w.weight

        # Level 2: global → per-regime, взвешенный по regime_probs
        blended = 0.0
        for regime, p in regime_probs.items():
            if p <= 0.0:
                continue
            rw = self.__regime_weights.get(regime, {}).get(name)
            n = rw.total if rw is not None else 0
            alpha = n / (n + HEDGE_REGIME_SHRINK_N)
            w_local = rw.weight if rw is not None else global_weight
            blended += p * (alpha * w_local + (1.0 - alpha) * global_weight)
        return blended if blended > 0.0 else global_weight

    def __ic_bayes_weight(self, name: str) -> float:
        """P4: байесовское объединение IC-веса с фолбэком 0.5 по уверенности.
        final = weight()*conf + 0.5*(1-conf). При неуверенном IC тяготеет к 0.5
        (нейтрально), при уверенном — к фактическому IC-весу."""
        prior = self.__ic(name)
        conf = prior.confidence()
        return prior.weight() * conf + 0.5 * (1.0 - conf)

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

    def __load_rolling_quality_by_regime(self) -> dict[str, float]:
        if not os.path.exists(WEIGHTS_FILE):
            return {}
        try:
            with open(WEIGHTS_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
            stored = data.get(self.__settings.figi, {}).get("__rolling_quality_by_regime__", {})
            return {k: float(v) for k, v in stored.items()} if isinstance(stored, dict) else {}
        except Exception as e:
            logger.warning(f"Could not load rolling_quality_by_regime: {e}")
            return {}

    def __save_rolling_quality(self) -> None:
        try:
            data = {}
            if os.path.exists(WEIGHTS_FILE):
                with open(WEIGHTS_FILE, "r", encoding="utf-8") as f:
                    data = json.load(f)
            key = self.__settings.figi
            data.setdefault(key, {})["__rolling_quality__"] = self.__rolling_quality
            data[key]["__rolling_quality_by_regime__"] = self.__rolling_quality_by_regime
            with open(WEIGHTS_FILE, "w", encoding="utf-8") as f:
                json.dump(data, f, ensure_ascii=False, indent=2)
        except Exception as e:
            logger.warning(f"Could not save rolling_quality: {e}")
