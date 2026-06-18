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
  3. ПРОГРЕВ ВЕСОВ — пока веса методов не набрали WARMUP_TRADES сделок,
     порог входа увеличен (методам ещё не за что доверять).
  4. СКОЛЬЗЯЩЕЕ КАЧЕСТВО — если последние сделки стратегии в среднем
     низкого качества (rolling quality), порог временно повышается —
     самозатухание в плохой полосе, без ручного выключения.

Веса EWA обновляются после закрытия каждой сделки (quality = MFE / (MFE + MAE)).
Сохраняются в JSON-файл рядом с bot'ом.
"""
import json
import logging
import math
import os
import statistics
from dataclasses import dataclass, field
from decimal import Decimal
from typing import Callable, Optional

from tinkoff.invest import HistoricCandle
from tinkoff.invest.utils import quotation_to_decimal

from configuration.settings import StrategySettings
from trade_system.signal import Signal, SignalType
from trade_system.strategies.base_strategy import IStrategy
from regime import classify_regime, REGIME_WEIGHT_MODS, change_point_score
from indicators import score_adaptive_ma, score_trend_quality
from indicators_fractal import score_fractal, score_entropy_regime

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
WARMUP_TRADES = 8                  # сделок на метод, после которых веса "прогреты"
WARMUP_THRESHOLD_MULT = 1.5        # во сколько раз ужесточаем порог во время прогрева
LOW_QUALITY_THRESHOLD = 0.4        # rolling quality ниже этого — "плохая полоса"
LOW_QUALITY_MULT = 1.3             # ужесточение порога в плохой полосе
QUALITY_ALPHA = 0.15               # скорость EWA для rolling quality


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

    def add_candle(self, candle: HistoricCandle) -> None:
        self.after_candles.append(candle)

    def calc_quality(self) -> float:
        """MFE/MAE → quality ∈ [0, 1]."""
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
        return mfe / (mfe + mae + 1e-8)


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


def score_price_trend(candles: list[HistoricCandle]) -> float:
    closes = [_to_f(c.close) for c in candles]
    return _linreg_slope(closes)


def score_vol_momentum(candles: list[HistoricCandle]) -> float:
    """Объём × направление за последние N свечей, нормировано."""
    if len(candles) < 2:
        return 0.0
    bull_vol = sum(c.volume for c in candles if _to_f(c.close) >= _to_f(c.open))
    bear_vol = sum(c.volume for c in candles if _to_f(c.close) < _to_f(c.open))
    total = bull_vol + bear_vol or 1
    return (bull_vol - bear_vol) / total


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
ALL_METHOD_NAMES = (
    [name for name, _ in METHODS]
    + [OI_SQUEEZE_NAME, INST_OI_NAME, RETAIL_CONTRA_NAME]
    + TRADESTATS_METHOD_NAMES
    + [CHANGE_POINT_NAME]
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

        self.__candles: list[HistoricCandle] = []
        self.__open_trade: Optional[OpenTrade] = None
        self.__weights: dict[str, MethodWeight] = self.__load_weights()
        self.__rolling_quality: float = self.__load_rolling_quality()
        self.__confidence: float = 0.7
        self.__squeeze_provider: Optional[SqueezeProvider] = None
        self.__inst_oi_provider: Optional[ScoreProvider] = None
        self.__retail_contra_provider: Optional[ScoreProvider] = None
        self.__tradestats_provider: Optional[TradeStatsProvider] = None

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

    # ── Публичный метод — вызывается на каждой свече ─────────────────────────

    def analyze_candles(self, candles: list[HistoricCandle]) -> Optional[Signal]:
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

        # вычисляем composite
        composite, scores = self.__compute_composite()
        logger.debug(
            f"{self.__settings.figi} composite={composite:.3f} "
            f"scores={dict(zip(ALL_METHOD_NAMES, [round(s, 3) for s in scores]))}"
        )

        effective_threshold = self.__effective_threshold()

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

        if direction == SignalType.LONG:
            return self.__make_signal(SignalType.LONG, self.__long_take, self.__long_stop, scores)
        return self.__make_signal(SignalType.SHORT, self.__short_take, self.__short_stop, scores)

    def notify_position_closed(self) -> None:
        """Вызвать извне при закрытии позиции — записываем исход."""
        if self.__open_trade:
            self.__record_outcome()

    # ── Внутренние методы ─────────────────────────────────────────────────────

    def __compute_composite(self) -> tuple[float, list[float]]:
        window = self.__candles
        vhf_mult = score_volatility_regime(window)
        closes = [_to_f(c.close) for c in window]
        volumes = [float(c.volume) for c in window]

        scores = [fn(window) for _, fn in METHODS] + [
            self.__score_oi_squeeze(),
            self.__score_provider(self.__inst_oi_provider),
            self.__score_provider(self.__retail_contra_provider),
        ] + [self.__score_tradestats(name) for name in TRADESTATS_METHOD_NAMES] \
          + [change_point_score(closes)]

        regime = classify_regime(closes, volumes)
        regime_mods = REGIME_WEIGHT_MODS.get(regime, {})
        weights = [self.__weights[name].weight * regime_mods.get(name, 1.0) for name in ALL_METHOD_NAMES]

        # взвешенная сумма; VOL_MOMENTUM усиливается режимом тренда
        weighted = sum(s * w for s, w in zip(scores, weights))
        weight_sum = sum(weights) or 1.0
        composite = (weighted / weight_sum) * (0.6 + 0.4 * vhf_mult)
        return composite, scores

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
        return max(-1.0, min(1.0, squeeze_up - squeeze_down))

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

    def __effective_threshold(self) -> float:
        """Базовый порог, ужесточённый во время прогрева весов и в полосе слабых сделок."""
        mult = 1.0
        avg_total = sum(w.total for w in self.__weights.values()) / max(1, len(self.__weights))
        if avg_total < WARMUP_TRADES:
            mult *= WARMUP_THRESHOLD_MULT
        if self.__rolling_quality < LOW_QUALITY_THRESHOLD:
            mult *= LOW_QUALITY_MULT
        return self.__threshold * mult

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
        )

        signal = Signal(
            figi=self.__settings.figi,
            signal_type=signal_type,
            take_profit_level=entry * take_mult,
            stop_loss_level=entry * stop_mult,
        )
        logger.info(f"OICompositeStrategy signal: {signal} scores={method_scores}")
        return signal

    def __record_outcome(self) -> None:
        """Записать MFE/MAE, обновить веса EWA."""
        if not self.__open_trade:
            return

        quality = self.__open_trade.calc_quality()
        logger.info(
            f"{self.__settings.figi} trade closed: quality={quality:.3f} "
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
