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
from regime import REGIMES, classify_regime, classify_regime_probs, REGIME_WEIGHT_MODS, change_point_score
from cluster_models import ClusterModels
from narrative import (
    NarrativeState, NarrativeWeights, NarrativeThresholds, classify_directional,
    classify_volume, classify_price_reaction, update_narrative,
    fit_narrative_thresholds,
)
from indicators import score_adaptive_ma, score_trend_quality, zlema, t3, mmi
from indicators_fractal import score_fractal, score_entropy_regime
from indicators_ehlers import (
    score_cyber_cycle, score_decycler, score_fisher_rsi, score_ebsw, even_better_sinewave,
)
from indicators_volume import score_klinger, score_vzo, score_twiggs, score_rmi, score_zscore
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
HEDGE_WARMUP_TRADES = 15           # на первых N сделках eta линейно растёт от 0 до HEDGE_ETA
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
    "MKT_STRUCTURE": 120, "TRIANGLE": 120,
    "CYBER_CYCLE": 30, "FISHER_RSI": 30, "EBSW": 30, "RMI": 30, "ZSCORE": 30,
    "MMI_SIGNAL": 30, "VR_SIGNAL": 30, "FRACTAL": 30, "ENTROPY": 30,
    "VOL_MOMENTUM": 60, "KLINGER": 60, "VZO": 60, "TWIGGS": 60, "BS_PRESSURE": 60,
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
AGREE_SHARE_MIN = 0.50             # доля силы согласных от силы всех высказавшихся

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
                        "ADAPTIVE_MA", "DECYCLER", "SINEWAVE_SIGNAL", "SSA_SIGNAL"}),
    "volume": frozenset({"VOL_MOMENTUM", "KLINGER", "VZO", "TWIGGS", "BS_PRESSURE",
                         "YZ_VOL_SIGNAL", "VR_SIGNAL"}),
    "oscillator": frozenset({"CYBER_CYCLE", "FISHER_RSI", "EBSW", "RMI", "ZSCORE",
                              "MMI_SIGNAL"}),
    "structure": frozenset({"VWAP_SIGNAL", "CHANGE_POINT", "WICK_REJECTION", "VSA",
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
BACKTEST_BLOCKED_REGIMES: frozenset[str] = frozenset(
    r.strip() for r in _ebr_bt.split(",") if r.strip()
) if _ebr_bt is not None else frozenset({"stress", "ranging", "trending_up"})

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
    sum_quality: float = 0.0  # больше не входит в update(); оставлено для статистики и старого JSON-формата

    def update(self, quality: float, abs_score: float = 1.0) -> None:
        """Hedge (multiplicative weights): вес умножается на exp(eta·(quality-0.5))
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
        (|score|≈0.9) — обновляет его в полную силу."""
        self.total += 1
        self.sum_quality += quality
        conf = max(0.1, min(1.0, abs_score))
        eta = HEDGE_ETA * min(1.0, self.total / HEDGE_WARMUP_TRADES) * conf
        self.weight *= math.exp(eta * (quality - 0.5))
        self.weight = max(0.05, min(1.0, self.weight))


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
    mods = {"trending_up": 0.85, "trending_down": 0.85, "ranging": 1.0,
            "high_vol": 1.25, "low_vol": 0.90, "stress": 1.40}
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
    """
    Контекстные свечные паттерны: форма × объём × предшествующий тренд × близость к уровню.
    Каждый паттерн имеет базовый скор, который умножается на контекстные множители.
    Итог ∈ [-1, 1].
    """
    if len(candles) < 5:
        return 0.0

    def f(c, attr): return _to_f(getattr(c, attr))

    # Последние свечи
    last = candles[-1]
    lh, ll, lo_, lc = f(last, "high"), f(last, "low"), f(last, "open"), f(last, "close")
    lrng = lh - ll or 1e-9
    lbody = abs(lc - lo_)
    lbody_frac = lbody / lrng

    prev = candles[-2]
    ph, pl, po, pc = f(prev, "high"), f(prev, "low"), f(prev, "open"), f(prev, "close")
    prng = ph - pl or 1e-9

    # Предшествующий тренд: последние N свечей (не считая текущую)
    trend_w = candles[-6:-1]
    trend_closes = [f(c, "close") for c in trend_w]
    trend_slope = (trend_closes[-1] - trend_closes[0]) / (abs(trend_closes[0]) or 1.0)
    prior_bullish = trend_slope > 0.001
    prior_bearish = trend_slope < -0.001

    # Объём: последняя свеча vs медиана окна
    vols = [c.volume for c in candles[-20:]]
    med_vol = sorted(vols)[len(vols) // 2] or 1
    vol_ratio = last.volume / med_vol  # 1.0 = средний объём

    # Объём хвоста: насколько объём «принадлежит» отвергнутой зоне
    lower_wick = (min(lo_, lc) - ll) / lrng
    upper_wick = (lh - max(lo_, lc)) / lrng

    # Множитель объёма: от 0.5 (мёртвый) до 1.5 (высокий)
    vol_mult = min(1.5, max(0.5, 0.5 + vol_ratio * 0.5))

    # Контекст истощения: 3+ свечи подряд в одну сторону перед текущей
    last3 = candles[-4:-1]
    consec_down = all(f(c, "close") < f(c, "open") for c in last3)
    consec_up   = all(f(c, "close") > f(c, "open") for c in last3)
    # Объём последних свечей убывает → истощение движения
    last3_vols = [c.volume for c in last3]
    vol_fading = last3_vols[-1] < last3_vols[0] * 0.8 if last3_vols[0] > 0 else False

    scores = []

    # ── Молот (Hammer) ──────────────────────────────────────────────────────
    # Длинный нижний хвост + маленькое тело: покупатели поглотили продажи.
    # Контекст: после медвежьего движения, лучше на уровне поддержки.
    if lower_wick > 0.55 and lbody_frac < 0.35 and upper_wick < 0.2:
        base = 0.65
        ctx = (1.3 if consec_down else 0.6) * (1.2 if prior_bearish else 0.8)
        scores.append(base * ctx * vol_mult)

    # ── Перевёрнутый молот / Shooting Star ──────────────────────────────────
    # Длинный верхний хвост: продавцы поглотили покупателей.
    if upper_wick > 0.55 and lbody_frac < 0.35 and lower_wick < 0.2:
        base = -0.65
        ctx = (1.3 if consec_up else 0.6) * (1.2 if prior_bullish else 0.8)
        scores.append(base * ctx * vol_mult)

    # ── Бычье поглощение (Bullish Engulfing) ────────────────────────────────
    # Тело последней свечи полностью поглощает тело предыдущей медвежьей.
    # Контекст: после серии падения, объём нарастает.
    if pc < po and lc > lo_ and lc >= po and lo_ <= pc:
        engulf_strength = lbody / (abs(pc - po) or 1e-9)  # насколько больше тела
        base = min(0.9, 0.55 + engulf_strength * 0.15)
        ctx = (1.3 if consec_down else 0.7) * (1.2 if prior_bearish else 0.9)
        vol_eng = min(1.6, max(0.5, vol_ratio * 0.6 + 0.7))  # объём важнее для engulfing
        scores.append(base * ctx * vol_eng)

    # ── Медвежье поглощение (Bearish Engulfing) ─────────────────────────────
    if pc > po and lc < lo_ and lc <= po and lo_ >= pc:
        engulf_strength = lbody / (abs(pc - po) or 1e-9)
        base = -min(0.9, 0.55 + engulf_strength * 0.15)
        ctx = (1.3 if consec_up else 0.7) * (1.2 if prior_bullish else 0.9)
        vol_eng = min(1.6, max(0.5, vol_ratio * 0.6 + 0.7))
        scores.append(base * ctx * vol_eng)

    # ── Doji (неопределённость после движения) ──────────────────────────────
    # Сам по себе нейтрален, но после сильного движения = истощение.
    if lbody_frac < 0.08:
        if consec_down and vol_fading:
            scores.append(0.35 * vol_mult)   # возможный разворот вверх
        elif consec_up and vol_fading:
            scores.append(-0.35 * vol_mult)  # возможный разворот вниз
        # Doji без контекста — 0, не добавляем шум

    # ── Inside Bar (компрессия) ──────────────────────────────────────────────
    # Диапазон последней свечи внутри предыдущей — сжатие энергии.
    # Не голосует если текущий бар NR7 (тогда SPRING уже считает компрессию,
    # двойной счёт раздует composite без оснований).
    ranges_7_ib = [_to_f(c.high) - _to_f(c.low) for c in candles[-7:]] if len(candles) >= 7 else []
    is_nr7 = bool(ranges_7_ib) and lrng == min(ranges_7_ib)
    if lh <= ph and ll >= pl and not is_nr7:
        compression = (lrng / prng) if prng > 0 else 1.0
        base_strength = (1.0 - compression) * 0.4
        if prior_bullish:
            scores.append(base_strength * vol_mult)
        elif prior_bearish:
            scores.append(-base_strength * vol_mult)

    # ── Три солдата / три вороны ─────────────────────────────────────────────
    # 3 последовательные направленные свечи с нарастающим объёмом — не разворот,
    # а ПРОДОЛЖЕНИЕ тренда (не против него!).
    if len(candles) >= 4:
        last3c = candles[-3:]
        c1, c2, c3 = last3c
        three_up = (f(c1,"close")>f(c1,"open") and f(c2,"close")>f(c2,"open") and f(c3,"close")>f(c3,"open")
                    and f(c2,"close")>f(c1,"close") and f(c3,"close")>f(c2,"close"))
        three_dn = (f(c1,"close")<f(c1,"open") and f(c2,"close")<f(c2,"open") and f(c3,"close")<f(c3,"open")
                    and f(c2,"close")<f(c1,"close") and f(c3,"close")<f(c2,"close"))
        vol3 = [c.volume for c in last3c]
        vol_growing = vol3[2] >= vol3[0] * 0.9  # объём не падает

        if three_up and vol_growing and prior_bullish:
            scores.append(0.5 * vol_mult)   # тренд продолжается
        if three_dn and vol_growing and prior_bearish:
            scores.append(-0.5 * vol_mult)

    # ── Tweezer (пинцет) — двойная вершина/основание ─────────────────────────
    # Два бара с одинаковым хаем (шорт) или лоем (лонг) ± 0.1% → отвержение уровня.
    tolerance = lrng * 0.15
    if abs(lh - ph) < tolerance and upper_wick > 0.3 and prior_bullish:
        scores.append(-0.5 * vol_mult)   # двойная вершина
    if abs(ll - pl) < tolerance and lower_wick > 0.3 and prior_bearish:
        scores.append(0.5 * vol_mult)    # двойное основание

    if not scores:
        return 0.0

    # Берём сигнал с максимальным abs (самый сильный паттерн на баре)
    best = max(scores, key=abs)
    return max(-1.0, min(1.0, best))


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
    """
    VR_SIGNAL: VR>1.3 → +0.5 (тренд), VR<0.7 → −0.5 (возврат к среднему),
    иначе нейтрально. См. _variance_ratio.
    """
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
    Слом рыночной структуры (BOS — Break of Structure).

    Алгоритм:
    1. Находим свинг-хаи и свинг-лои за окно SWING_W (фракталы ±LOOKBACK баров).
    2. Проверяем последнюю последовательность: восходящая структура = HH + HL
       (каждый новый хай/лой выше предыдущего), нисходящая = LH + LL.
    3. Слом восходящей: появился LH (хай ниже предыдущего) ИЛИ LL (лой ниже предыдущего).
       Слом нисходящей: появился HH или HL.
    4. Сила сигнала зависит от:
       - насколько "сломан" хай/лой в % (глубина нарушения);
       - объёма на баре, сформировавшем слом (аномальный объём = сильный сигнал);
       - количества свингов в последовательности до слома (3+ = устоявшийся тренд).

    Возвращает: > 0 (бычий BOS — структура разворачивается вверх),
                < 0 (медвежий BOS — структура разворачивается вниз),
                0   (структура не сломана или данных недостаточно).
    """
    # ~8 торговых часов: на M5 ≈ 96 баров, на H1 ≈ 8, на M1 ≈ 480
    _SWING_W = _adaptive_window(candles, target_hours=8.0, min_bars=30, max_bars=300)
    _LOOKBACK = 3       # баров с каждой стороны для подтверждения свинга
    _MIN_SWINGS = 2     # минимум свингов для определения структуры

    if len(candles) < _SWING_W:
        return 0.0
    atr_pct = _compute_atr(candles)
    if atr_pct <= 0:
        return 0.0

    window = candles[-_SWING_W:]
    vols = [float(c.volume) for c in window]
    avg_vol = statistics.mean(vols) or 1.0

    # Находим свинг-хаи и свинг-лои
    swing_highs: list[tuple[int, float, float]] = []  # (idx, price, vol_ratio)
    swing_lows:  list[tuple[int, float, float]] = []
    n = len(window)
    for i in range(_LOOKBACK, n - _LOOKBACK):
        h = _to_f(window[i].high)
        lo = _to_f(window[i].low)
        vol_r = float(window[i].volume) / avg_vol
        if all(_to_f(window[i - j].high) < h and _to_f(window[i + j].high) < h
               for j in range(1, _LOOKBACK + 1)):
            swing_highs.append((i, h, vol_r))
        if all(_to_f(window[i - j].low) > lo and _to_f(window[i + j].low) > lo
               for j in range(1, _LOOKBACK + 1)):
            swing_lows.append((i, lo, vol_r))

    if len(swing_highs) < _MIN_SWINGS or len(swing_lows) < _MIN_SWINGS:
        return 0.0

    sh = swing_highs
    sl = swing_lows

    # Структура определяется по последним 2 парам свингов (было 3 — слишком редко).
    # «Бычья» = оба последних хая выше предыдущих И оба последних лоя выше предыдущих.
    # «Медвежья» = зеркально.
    # Достаточно 2 свингов каждого типа — это минимальная наблюдаемая структура.
    def seq_ascending(pts: list) -> bool:
        return len(pts) >= 2 and pts[-1][1] > pts[-2][1]

    def seq_descending(pts: list) -> bool:
        return len(pts) >= 2 and pts[-1][1] < pts[-2][1]

    was_bullish = seq_ascending(sh) and seq_ascending(sl)
    was_bearish = seq_descending(sh) and seq_descending(sl)

    if not was_bullish and not was_bearish:
        return 0.0

    # Сила структуры: сколько последовательных свингов подтверждают структуру
    def count_seq(pts: list, ascending: bool) -> int:
        count = 0
        for i in range(len(pts) - 1, 0, -1):
            if ascending and pts[i][1] > pts[i - 1][1]:
                count += 1
            elif not ascending and pts[i][1] < pts[i - 1][1]:
                count += 1
            else:
                break
        return count

    score = 0.0

    if was_bullish:
        lh_broken = sh[-1][1] < sh[-2][1] if len(sh) >= 2 else False
        ll_broken = sl[-1][1] < sl[-2][1] if len(sl) >= 2 else False
        if lh_broken or ll_broken:
            depth_h = (sh[-2][1] - sh[-1][1]) / (sh[-2][1] or 1) if lh_broken else 0.0
            depth_l = (sl[-2][1] - sl[-1][1]) / (sl[-2][1] or 1) if ll_broken else 0.0
            depth = max(depth_h, depth_l)
            vol_boost = min(1.5, (sh[-1][2] if lh_broken else sl[-1][2]))
            strength = min(1.0, depth / atr_pct) * vol_boost
            trend_len = count_seq(sh, ascending=True) + count_seq(sl, ascending=True)
            n_swings_bonus = min(1.4, 1.0 + 0.1 * trend_len)
            score = -min(1.0, strength * 0.8 * n_swings_bonus)

    elif was_bearish:
        hh_broken = sh[-1][1] > sh[-2][1] if len(sh) >= 2 else False
        hl_broken = sl[-1][1] > sl[-2][1] if len(sl) >= 2 else False
        if hh_broken or hl_broken:
            depth_h = (sh[-1][1] - sh[-2][1]) / (sh[-2][1] or 1) if hh_broken else 0.0
            depth_l = (sl[-1][1] - sl[-2][1]) / (sl[-2][1] or 1) if hl_broken else 0.0
            depth = max(depth_h, depth_l)
            vol_boost = min(1.5, (sh[-1][2] if hh_broken else sl[-1][2]))
            strength = min(1.0, depth / atr_pct) * vol_boost
            trend_len = count_seq(sh, ascending=False) + count_seq(sl, ascending=False)
            n_swings_bonus = min(1.4, 1.0 + 0.1 * trend_len)
            score = +min(1.0, strength * 0.8 * n_swings_bonus)

    return max(-1.0, min(1.0, score))


def score_spring(candles: list[HistoricCandle]) -> float:
    """
    Сжатие пружины (Spring/Compression → Impulse).

    Два суб-паттерна:

    A. КОМПРЕССИЯ + ИМПУЛЬС (после отката в тренде или у уровня):
       - последние COMP_BARS баров показывают убывающий диапазон (ATR убывает);
       - объём в компрессии выше среднего (накопление/распределение);
       - текущий бар — резкий выход: диапазон > IMPULSE_FRAC * ATR, закрытие
         в верхней/нижней трети, объём > VOL_THRESH * среднего.

    B. NR7 с объёмом (Narrow Range 7):
       - текущий бар имеет наименьший диапазон за последние 7 баров (NR7);
       - объём накапливался в компрессии (средний объём компрессии > базового);
       - следующий (текущий) бар — расширение с объёмом.
       Возвращает слабый сигнал (±0.4) о готовности к выходу.

    Направление определяется:
    - предшествующим трендом (slope closes);
    - закрытием импульсного бара (верх/низ диапазона).

    Объём — обязательный фактор: компрессия без накопленного объёма = не пружина.
    """
    # компрессия ~1 час: M5→12 баров, H1→1 (min 4), M1→60
    _COMP_BARS = _adaptive_window(candles, target_hours=1.0, min_bars=4, max_bars=60)
    _VOL_THRESH = 1.4   # объём на импульсном баре
    _VOL_COMP = 0.9     # средний объём во время компрессии (≥ базового × это)
    _IMPULSE_FRAC = 0.9 # импульсный бар ≥ IMPULSE_FRAC * ATR
    # база объёма: ~2.5 часа до компрессии
    _BASE_VOL_BARS = _adaptive_window(candles, target_hours=2.5, min_bars=10, max_bars=150)

    if len(candles) < _COMP_BARS + 15:
        return 0.0
    atr_pct = _compute_atr(candles)
    if atr_pct <= 0:
        return 0.0
    last_price = _to_f(candles[-1].close)
    atr_abs = atr_pct * last_price

    vols_base = [float(c.volume) for c in candles[-_BASE_VOL_BARS:-_COMP_BARS - 1]]
    avg_vol = statistics.mean(vols_base) if vols_base else 1.0
    if avg_vol <= 0:
        return 0.0

    last = candles[-1]
    lh = _to_f(last.high); ll = _to_f(last.low)
    lc = _to_f(last.close); lo_ = _to_f(last.open)
    lrng = lh - ll or 1e-9
    last_vol_r = float(last.volume) / avg_vol

    comp_candles = candles[-_COMP_BARS - 1:-1]  # предшествующие COMP_BARS баров
    comp_ranges = [_to_f(c.high) - _to_f(c.low) for c in comp_candles]
    comp_vol_r = statistics.mean(float(c.volume) / avg_vol for c in comp_candles)

    # Убывающий диапазон: каждый следующий меньше предыдущего (не строго — допускаем 1 выброс)
    violations = sum(1 for i in range(1, len(comp_ranges)) if comp_ranges[i] > comp_ranges[i - 1])
    is_compressing = violations <= 1 and comp_ranges[-1] < comp_ranges[0] * 0.7

    score = 0.0

    # ── Паттерн A: компрессия + импульсный выход ──────────────────────────
    if (is_compressing
            and comp_vol_r >= _VOL_COMP
            and lrng >= _IMPULSE_FRAC * atr_abs
            and last_vol_r >= _VOL_THRESH):

        # Направление по закрытию импульсного бара
        close_pos = (lc - ll) / lrng
        trend_closes = [_to_f(c.close) for c in candles[-15:-1]]
        trend_slope = (trend_closes[-1] - trend_closes[0]) / (abs(trend_closes[0]) or 1)

        if close_pos >= 0.65:
            # Закрытие в верхней трети — бычий выход
            strength = min(1.0, (lrng / atr_abs) * last_vol_r * 0.4)
            score = +strength
        elif close_pos <= 0.35:
            # Закрытие в нижней трети — медвежий выход
            strength = min(1.0, (lrng / atr_abs) * last_vol_r * 0.4)
            score = -strength

        # Если импульс против недавнего тренда — это не продолжение, а разворот;
        # сигнал всё равно даём (пружина отталкивается), но без дополнительного буста.

    # NR7 (Narrow Range 7) намеренно не даёт направленного сигнала:
    # самый узкий бар за 7 = сжатие без известного направления выхода.
    # Давать голос в сторону предшествующего тренда — двойной счёт с PRICE_TREND.
    # Паттерн A (компрессия + подтверждённый импульс) достаточен.

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
    Auction Market Theory: грубый POC (Point of Control) и расстояние от него.

    POC = бар с максимальным объёмом в сессии (последние N баров).
    Логика AMT: цена тяготеет к POC при балансе, уходит от него при дисбалансе.

    Сигнал:
      >0: цена выше POC + последние бары уходят вверх → бычий дисбаланс.
      <0: цена ниже POC + уходит вниз → медвежий дисбаланс.
      ≈0: цена у POC → принятие (рынок сбалансирован).

    При нахождении у POC сигнал слабый — цена ищет двустороннюю торговлю.
    """
    _WIN = _adaptive_window(candles, target_hours=4.0, min_bars=20, max_bars=200)
    if len(candles) < _WIN + 5:
        return 0.0

    window = candles[-_WIN:]
    vols = [float(c.volume) for c in window]
    avg_vol = statistics.mean(vols) or 1.0

    # Грубый POC: бар с максимальным объёмом
    poc_idx = max(range(len(window)), key=lambda i: vols[i])
    poc_price = (_to_f(window[poc_idx].high) + _to_f(window[poc_idx].low)) / 2

    cl_now = _to_f(candles[-1].close)
    atr = _compute_atr(candles)
    if atr <= 0 or poc_price <= 0:
        return 0.0
    atr_abs = atr * poc_price

    dist = (cl_now - poc_price) / atr_abs   # в единицах ATR

    # Слабый сигнал у POC, нарастающий при удалении
    # Направление последних 3 баров усиливает/ослабляет
    last_closes = [_to_f(c.close) for c in candles[-4:]]
    momentum = (last_closes[-1] - last_closes[0]) / (atr_abs or 1e-9)

    raw = math.tanh(dist * 0.5) * math.tanh(abs(momentum) * 0.3) * (1 if momentum > 0 else -1)
    # Если цена рядом с POC (< 0.3 ATR) — нейтральный сигнал (принятие)
    if abs(dist) < 0.3:
        raw *= 0.2
    return round(max(-1.0, min(1.0, raw)), 4)


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
    Ликвидационный каскад — обнаружение и оценка его фазы.

    Каскад = принудительная волна стоп-аутов:
    1. ФАЗА 1 — ускорение: огромный объём + широкий бар + закрытие у экстремума.
       Сигнал: контрарный (идти ПРОТИВ направления каскада — ждём разворота).
    2. ФАЗА 2 — остановка каскада: после 1-2 экстремальных баров появляется
       Stopping Volume или поглощение (VSA-признаки) — подтверждение разворота.
    3. ФАЗА 3 — возврат: цена движется обратно с нарастающим объёмом покупок.

    Алгоритм:
    - Ищем каскадный бар: vol_ratio>2.5, spread_ratio>1.8, close у экстремума.
    - Если каскадный бар был 1-4 бара назад → смотрим текущий бар как сигнал.
    - Если текущий бар показывает разворот (close_pos против направления каскада)
      + объём нормализуется → даём контрарный сигнал (иди против каскада).
    - Если каскадный бар прямо сейчас (текущий) → слабый сигнал (ранний).
    """
    _LOOKBACK = 5  # ищем каскад в последних N барах
    if len(candles) < 20:
        return 0.0

    vols = [float(c.volume) for c in candles]
    avg_vol = statistics.mean(vols[-20:-1]) or 1.0
    avg_spread_lst = [_to_f(c.high) - _to_f(c.low) for c in candles[-15:-1]]
    avg_spread = statistics.mean(avg_spread_lst) or 1e-9

    def bar_info(c):
        h, lo, op, cl = _to_f(c.high), _to_f(c.low), _to_f(c.open), _to_f(c.close)
        rng = h - lo or 1e-9
        return {
            "vol_r": float(c.volume) / avg_vol,
            "spread_r": rng / avg_spread,
            "close_pos": (cl - lo) / rng,
            "dir": 1 if cl >= op else -1,
        }

    # Ищем каскадный бар в окне
    cascade_bar = None
    cascade_age = None
    for age in range(1, min(_LOOKBACK + 1, len(candles))):
        b = bar_info(candles[-1 - age])
        is_cascade = (b["vol_r"] > 2.5 and b["spread_r"] > 1.8
                      and (b["close_pos"] < 0.2 or b["close_pos"] > 0.8))
        if is_cascade:
            cascade_bar = b
            cascade_age = age
            break

    curr = bar_info(candles[-1])

    # Нет каскадного бара в прошлом — проверяем текущий
    if cascade_bar is None:
        if (curr["vol_r"] > 3.0 and curr["spread_r"] > 2.0
                and (curr["close_pos"] < 0.15 or curr["close_pos"] > 0.85)):
            # Активный каскад прямо сейчас — ранний слабый контрарный
            cascade_dir = curr["dir"]
            return round(-cascade_dir * 0.4, 4)
        return 0.0

    # Каскад был cascade_age баров назад — оцениваем разворот
    cascade_dir = cascade_bar["dir"]   # направление каскада (+1 вверх, -1 вниз)

    # Признаки разворота: текущий бар идёт ПРОТИВ направления каскада
    reversal_sign = -1 if cascade_dir > 0 else 1
    curr_against = (reversal_sign > 0 and curr["close_pos"] > 0.55) or \
                   (reversal_sign < 0 and curr["close_pos"] < 0.45)

    # Объём нормализуется (не ещё один каскадный бар)
    vol_normalized = curr["vol_r"] < 2.0

    if curr_against and vol_normalized:
        # Чем свежее каскад (age=1) — тем сильнее сигнал разворота
        freshness = 1.0 - (cascade_age - 1) / _LOOKBACK
        strength = min(1.0, cascade_bar["vol_r"] / 3.0 * freshness)
        return round(reversal_sign * strength * 0.85, 4)

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
    ("SSA_SIGNAL",     score_ssa_signal),
    ("HAWKES_SIGNAL",  score_hawkes_signal),
    ("VSA",            score_vsa),
    ("WICK_REJECTION", score_wick_rejection),
    ("TRIANGLE",       score_triangle),
    # VSA/Wyckoff/AMT/OrderFlow — расширенный блок
    ("CUMUL_DELTA",    score_cumul_delta),
    ("AMT_POC",        score_amt_poc),
    ("VSA_ABSORPTION", score_vsa_absorption),
    ("CASCADE",        score_cascade),
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
    + [OI_SQUEEZE_NAME, INST_OI_NAME, RETAIL_CONTRA_NAME]
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
    "TWIGGS":         {"min_bars": 15, "weight_5m": 1.05},
    "HAWKES_SIGNAL":  {"min_bars": 25, "weight_5m": 1.30},  # самоусиление потока
    "VSA":            {"min_bars": 12, "weight_5m": 1.05},
    "CUMUL_DELTA":    {"min_bars": 15, "weight_5m": 1.20},  # накопленная агрессия на 5м надёжнее
    "AMT_POC":        {"min_bars": 20, "weight_5m": 1.10},  # POC смысл на 5м-сессии
    "VSA_ABSORPTION": {"min_bars": 12, "weight_5m": 1.15},  # поглощение на 5м крупнее
    "CASCADE":        {"min_bars": 15, "weight_5m": 1.25},  # каскады видны на 5м лучше
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

AUTO_ATR_TAKE_KS = (2.0, 3.0, 4.0)
# Нижняя граница была 1.0 — на минутных барах atr_pct часто ~0.4-0.6%, и
# stop_dist=1.0*atr_pct получался теснее fixed-стопа (1.5%): walk-forward
# регулярно выбирал эту границу как "лучшую" по шумному прошлому окну,
# а вживую/на новых данных это просто частые выбивания шумом до того, как
# сигнал успевал сработать (см. короткое avg-время удержания ATR-сделок
# в бэктесте — 2-4 раза короче fixed).
AUTO_ATR_STOP_KS = (1.5, 2.0, 3.0)
AUTO_ATR_MIN_TRADES = 20           # меньше сделок на истории — авто-подбору не доверяем
                                    # (sweep по 3-9 исходам — это подбор по шуму, не сигнал)
ATR_SHRINK_K = 8                   # псевдо-наблюдения к fixed-бейзлайну (как REGIME_SHRINKAGE_K в history.py) —
                                    # тянет оценку ATR-кандидата на маленькой выборке к консервативному fixed,
                                    # без этого argmax по 45 кандидатам (3×3×5) почти всегда выбирает
                                    # комбинацию, выигравшую за счёт пары случайных сделок в eval-окне
                                    # ("optimizer's curse") — отсюда систематический проигрыш ATR живому fixed-режиму.
ATR_MIN_EDGE_SEM = 1.0              # переключаться на ATR-кандидата только если он бьёт fixed больше чем на
                                     # свой SEM — иначе "победа" неотличима от шума

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
# 0.0 — старое поведение (без масштабирования), оставлено в сетке, чтобы
# walk-forward мог сам решить, что лучше, а не считать масштабирование
# обязательным.
AUTO_ATR_SCALE_EXPS = (0.0, 0.3, 0.4, 0.5, 0.6)


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
        self.__ticker_weights: dict[str, MethodWeight] = {name: MethodWeight() for name in ALL_METHOD_NAMES}
        self.__squeeze_provider: Optional[SqueezeProvider] = None
        self.__inst_oi_provider: Optional[ScoreProvider] = None
        self.__retail_contra_provider: Optional[ScoreProvider] = None
        self.__tradestats_provider: Optional[TradeStatsProvider] = None
        self.__multi_ticker_provider: Optional[MultiTickerProvider] = None
        self.__regime_confidence: float = 1.0
        self.__last_regime: str = "ranging"
        self.__regime_stable_bars: int = 0
        self.__last_scores: dict[str, float] = {}
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
        # Кэш тяжёлых операций: пересчитываем раз в N баров, между ними — старое значение.
        # RQA O(n²), wavelet O(n log n), regime (CUSUM+PELT+Z-score) — всё CPU-bound.
        # На 1м-свечах N=5 (обновление каждые 5 минут), на 5м — N=3.
        self.__heavy_cache_n: int = 5 if interval_min == 1 else 3
        self.__heavy_bar_counter: int = 0
        self.__cached_rqa_mult: float = 1.0
        self.__cached_wavelet_mult: float = 1.0
        self.__cached_regime_probs: dict = {"ranging": 1.0}
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
                               block_ranging: bool = False) -> list[dict]:
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

                entry = _to_f(candles[i].close)
                window = candles[i + 1:i + 1 + max_bars]
                # Последние 3 элемента scores — M1/M2/M3 (см. ALL_METHOD_NAMES) —
                # сохраняем сырыми скорами для attribution в дашборде/бэктесте.
                m1_sc, m2_sc, m3_sc = scores[-3], scores[-2], scores[-1]
                signals.append({
                    "direction": direction, "entry": entry, "atr_pct": atr_pct, "window": window,
                    "entry_time": candles[i].time,
                    "m1": m1_sc, "m2": m2_sc, "m3": m3_sc,
                    "method_scores": dict(self.__last_scores),
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

        methods = []
        for name in ALL_METHOD_NAMES:
            hedge = self.__weights[name]
            blended_weight = self.__blended_hedge_weight(name, regime_probs)
            eff_weight = (
                blended_weight * regime_mods.get(name, 1.0) * redundancy_mult.get(name, 1.0)
                * (MICROSTRUCTURE_WEIGHT_BOOST if name in MICROSTRUCTURE_METHOD_NAMES else 1.0)
            )
            methods.append({
                "name": name,
                "hedge_weight": round(blended_weight, 4),
                "hedge_trades": hedge.total,
                "regime_mult": round(regime_mods.get(name, 1.0), 4),
                "redundancy_mult": round(redundancy_mult.get(name, 1.0), 4),
                "effective_weight": round(eff_weight, 4),
                "is_microstructure": name in MICROSTRUCTURE_METHOD_NAMES,
            })
        methods.sort(key=lambda m: m["effective_weight"], reverse=True)

        return {
            "ready": True,
            "regime": regime,
            "regime_probs": {r: round(p, 3) for r, p in regime_probs.items()},
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
            signals = self.backtest_scan_signals(candles, max_bars=max_bars)

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
                    stop_price = _lp.stop
                    take_price = _lp.take
                    take_dist = _lp.take_dist_pct
                    stop_dist = _lp.stop_dist_pct
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

            # Per-method attribution: скоры из method_scores сигнала,
            # исключая M1/M2/M3 (они агрегаты, а не самостоятельные методы).
            for mname, m_sc in sig.get("method_scores", {}).items():
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
                    # L1-контекст на момент входа (None если данных не было)
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

        if do_heavy:
            self.__cached_regime_probs = classify_regime_probs(closes, volumes)
            self.__cached_change_point = change_point_score(closes)
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

        regime_probs = self.__cached_regime_probs

        base_scores = [fn(window) for _, fn in METHODS] + [
            self.__score_level_context_mtf(),
            self.__score_market_structure_mtf(),
            self.__score_spring_mtf(),
            self.__score_oi_squeeze(),
            self.__score_provider(self.__inst_oi_provider),
            self.__score_provider(self.__retail_contra_provider),
        ] + [self.__score_tradestats(name) for name in TRADESTATS_METHOD_NAMES] \
          + [self.__cached_change_point, self.__score_multi_ticker()]

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
        weights = [
            self.__blended_hedge_weight(name, regime_probs)
            * self.__ic_bayes_weight(name)   # IC-prior (байес-фьюжн с фолбэком 0.5)
            * regime_mods.get(name, 1.0)
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

        weighted = sum(s * w for s, w in zip(scores_for_composite[:n_base], weights[:n_base]))
        weight_sum = sum(weights[:n_base]) or 1.0
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
        # сигналы. MMI_SIGNAL возвращает -0.5 при m>75, 0.5 при m<50.
        # Если он сильно против — трендовые плейбуки нейтрализуем.
        try:
            mmi_idx = BASE_METHOD_NAMES.index("MMI_SIGNAL")
            mmi_score = scores[mmi_idx]
        except (ValueError, IndexError):
            mmi_score = 0.0
        trend_playbook_active = any(p in ("TREND_PULLBACK_L", "TREND_PULLBACK_S", "REGIME_SHIFT") for p in active_playbooks)
        if mmi_score < -0.4 and abs(composite) > 0.05 and not trend_playbook_active:
            composite *= 0.35
            logger.debug(f"{self.__settings.figi}: MMI вето (рынок вязкий) → ×0.35")

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
        # __last_scores хранит сырые скоры — для архива и диагностики
        self.__last_scores = dict(zip(ALL_METHOD_NAMES, scores))
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

        # P5: адаптивный порог доли согласия по L1-контексту (клип 0.40..0.60).
        agreement_threshold = AGREE_SHARE_MIN - 0.10 * self.__l1_score * sign_val
        agreement_threshold = max(0.40, min(0.60, agreement_threshold))

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
        if total_strength <= 0 or not (
            agree_strength >= AGREE_STRENGTH_MIN and
            agree_strength / total_strength >= agreement_threshold
        ):
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

        # ── Условие 5 (P7): вето кластерных моделей M1/M2/M3 по уверенности IC ──
        against_votes = 0.0
        for mname in (M1_NAME, M2_NAME, M3_NAME):
            prior = self.__ic(mname)
            ic_conf = min(1.0, prior.n_updates / 15.0)
            score = self.__last_scores.get(mname, 0.0)
            if prior.ic_smoothed < -IC_SIGNIFICANCE:
                continue   # модель работает наоборот для этого тикера — игнор
            if score * sign_val < -0.3:
                against_votes += ic_conf
        if against_votes >= 2.0:
            return False, "gate_m3_veto"

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
            split = int(len(signals) * 0.6)
            eval_signals = signals[split:] if len(signals) - split >= AUTO_ATR_MIN_TRADES else signals
            # fixed-режим на том же eval-окне — бейзлайн для shrinkage и для
            # проверки значимости edge (см. _shrunk_atr_score, ATR_MIN_EDGE_SEM):
            # без него argmax по 45 кандидатам почти всегда находит "победителя"
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
        take_k = self.__atr_take_k if self.__atr_take_k is not None else self.__auto_atr_take_k
        stop_k = self.__atr_stop_k if self.__atr_stop_k is not None else self.__auto_atr_stop_k
        if take_k is not None and stop_k is not None and atr_pct > 0:
            scale_exp = self.__atr_scale_exp if self.__atr_scale_exp is not None else self.__auto_atr_scale_exp
            hold_scale = ATR_SCALE_HOLDING_BARS ** scale_exp if scale_exp else 1.0
            take_off = Decimal(str(take_k * atr_pct * hold_scale * noise_scale))
            stop_off = Decimal(str(stop_k * atr_pct * hold_scale * noise_scale))
            if direction == SignalType.LONG:
                return Decimal("1") + take_off, Decimal("1") - stop_off
            return Decimal("1") - take_off, Decimal("1") + stop_off
        scale = Decimal(str(noise_scale))
        if direction == SignalType.LONG:
            take_off = (self.__long_take - Decimal("1")) * scale
            stop_off = (Decimal("1") - self.__long_stop) * scale
            return Decimal("1") + take_off, Decimal("1") - stop_off
        take_off = (Decimal("1") - self.__short_take) * scale
        stop_off = (self.__short_stop - Decimal("1")) * scale
        return Decimal("1") - take_off, Decimal("1") + stop_off

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

        for name in ALL_METHOD_NAMES:
            score = self.__open_trade.method_scores.get(name, 0.0)
            if abs(score) < 0.05:
                continue
            aligned = (score > 0 and self.__open_trade.signal_type == SignalType.LONG) or \
                      (score < 0 and self.__open_trade.signal_type == SignalType.SHORT)
            target = quality if aligned else 1.0 - quality
            # Мультипликатор обновления = IC-точность метода, а не abs(score).
            # abs(score) отражает "громкость" — уверенные но плохие методы
            # получали такой же сильный апдейт как точные. ICPrior.weight()
            # нормирует накопленную предсказательную силу в [0.1, 1.0].
            ic_acc = self.__ic(name).weight()
            self.__weights[name].update(target, ic_acc)
            self.__ticker_weights[name].update(target, ic_acc)
            if self.__last_regime in self.__regime_weights:
                self.__regime_weights[self.__last_regime][name].update(target, ic_acc)

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
        if bucket is None or bucket[name].n_updates == 0:
            return self.__ic_priors["__global__"][name]
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
