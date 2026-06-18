"""
OICompositeStrategy — многометодная стратегия на основе анализа свечей.

Методы (адаптировано из oi-signal-v10):
  PRICE_TREND    — линейная регрессия цены закрытия (N свечей)
  VOL_MOMENTUM   — объём × направление движения цены
  VWAP_SIGNAL    — отклонение от VWAP скользящего окна
  BS_PRESSURE    — давление быков/медведей по телу свечи
  CANDLE_PATTERN — паттерны (engulfing, pin-bar, doji)
  VOLATILITY_REG — режим волатильности (тренд vs. боковик)

Каждый метод возвращает score ∈ [-1, 1].
Композитный сигнал = взвешенная сумма → порог → LONG/SHORT.

Веса EWA обновляются после закрытия каждой сделки (quality = MFE / (MFE + MAE)).
Сохраняются в JSON-файл рядом с bot'ом.
"""
import json
import logging
import math
import os
from dataclasses import dataclass, field
from decimal import Decimal
from typing import Optional

from tinkoff.invest import HistoricCandle
from tinkoff.invest.utils import quotation_to_decimal

from configuration.settings import StrategySettings
from trade_system.signal import Signal, SignalType
from trade_system.strategies.base_strategy import IStrategy

__all__ = ("OICompositeStrategy",)

logger = logging.getLogger(__name__)

# ── Константы ────────────────────────────────────────────────────────────────
WEIGHTS_FILE = "oi_weights.json"   # файл весов (рядом с main.py)
CANDLE_WINDOW = 30                 # свечей в окне для расчётов
MIN_CANDLES = 10                   # минимум свечей для первого сигнала
SIGNAL_THRESHOLD = 0.25            # порог composite для сигнала
WEIGHT_ALPHA = 0.1                 # скорость обучения EWA (0.1 = медленно, стабильно)
MFE_MAE_BARS = 15                  # максимум баров для записи MFE/MAE

# ── Комиссии Т-Инвестиции, тариф «Трейдер» ──────────────────────────────────
# Источник: tbank.ru/invest/tariffs/ (актуально на 2025–2026)
#
# Акции / облигации / ETF (биржевые торги, не айсберг):  0.05% за сделку
# Фьючерсы (оборот до 5 млн ₽/день):                    0.040% от стоимости контракта
# Фьючерсы (оборот 5–10 млн ₽/день):                    0.030%
# Фьючерсы (оборот свыше 10 млн ₽/день):                0.025%
# Фьючерсы из доп. списка (нестандартные):               0.080%
# Биржевая комиссия MOEX: включена в тариф (БЕСПЛАТНО — брокер берёт на себя)
#
# Для расчёта безубытка берём ROUND-TRIP = открытие + закрытие:
#   Акции:       0.05% × 2 = 0.10%
#   Фьючерсы:   0.04% × 2 = 0.08%  (типовой, при обороте до 5 млн/день)

class CommissionRate:
    """Ставки комиссии тарифа «Трейдер» (Т-Инвестиции)."""
    STOCKS      = Decimal("0.0005")   # 0.05% — акции/облигации/ETF
    FUT_TIER1   = Decimal("0.0004")   # 0.040% — фьючерсы, оборот до 5 млн ₽/день
    FUT_TIER2   = Decimal("0.0003")   # 0.030% — фьючерсы, оборот 5–10 млн ₽/день
    FUT_TIER3   = Decimal("0.00025")  # 0.025% — фьючерсы, оборот > 10 млн ₽/день
    FUT_EXTRA   = Decimal("0.0008")   # 0.080% — фьючерсы из доп. списка

    @classmethod
    def round_trip(cls, instrument_type: str = "stocks") -> Decimal:
        """Полная комиссия за сделку туда-обратно (открытие + закрытие)."""
        if instrument_type == "futures_extra":
            return cls.FUT_EXTRA * 2
        if instrument_type == "futures":
            return cls.FUT_TIER1 * 2   # консервативно: tier1 (до 5 млн/день)
        return cls.STOCKS * 2           # акции: 0.10%

    @classmethod
    def min_take_multiplier(cls, instrument_type: str = "stocks",
                            profit_margin: Decimal = Decimal("1.5")) -> Decimal:
        """
        Минимальный множитель take-profit чтобы покрыть комиссию + желаемый profit_margin.
        profit_margin=1.5 → take должен быть в 1.5× больше комиссии round-trip.
        Пример для акций: 1 + 0.10% × 1.5 = 1.0015
        """
        return Decimal("1") + cls.round_trip(instrument_type) * profit_margin


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
]


class OICompositeStrategy(IStrategy):
    """
    Многометодная стратегия. Комбинирует 5 методов анализа свечей с обучаемыми весами.
    Параметры (settings.ini):
      SIGNAL_THRESHOLD  — порог composite для сигнала (0.0–1.0, default 0.25)
      INSTRUMENT_TYPE   — тип инструмента для расчёта комиссии:
                          "stocks" (default) | "futures" | "futures_extra"
      LONG_TAKE         — множитель take-profit для LONG (если не задан — авто от комиссии)
      LONG_STOP         — множитель stop-loss для LONG
      SHORT_TAKE        — множитель take-profit для SHORT
      SHORT_STOP        — множитель stop-loss для SHORT
      PROFIT_MARGIN     — во сколько раз take должен превышать round-trip комиссию
                          (default 1.5; при 1.0 take = ровно безубыток по комиссии)
      SIGNAL_ONLY       — 0/1: если 1, ордера не исполняются (только Telegram)
    """

    def __init__(self, settings: StrategySettings) -> None:
        self.__settings = settings
        s = settings.settings

        self.__threshold = float(s.get("SIGNAL_THRESHOLD", SIGNAL_THRESHOLD))
        self.__signal_only = s.get("SIGNAL_ONLY", "0") == "1"

        # тип инструмента → правильная ставка комиссии
        self.__instrument_type = s.get("INSTRUMENT_TYPE", "stocks")
        profit_margin = Decimal(s.get("PROFIT_MARGIN", "1.5"))
        commission_rt = CommissionRate.round_trip(self.__instrument_type)

        # take-profit: если явно задан — берём из конфига, иначе считаем от комиссии
        default_take = Decimal("1") + commission_rt * profit_margin
        default_stop = Decimal("1") - commission_rt  # stop = точка безубытка по комиссии

        self.__long_take  = Decimal(s.get("LONG_TAKE",  str(default_take)))
        self.__long_stop  = Decimal(s.get("LONG_STOP",  str(default_stop)))
        self.__short_take = Decimal(s.get("SHORT_TAKE", str(Decimal("2") - default_take)))
        self.__short_stop = Decimal(s.get("SHORT_STOP", str(Decimal("2") - default_stop)))

        self.__commission_rt = commission_rt  # храним для логирования

        self.__candles: list[HistoricCandle] = []
        self.__open_trade: Optional[OpenTrade] = None
        self.__weights: dict[str, MethodWeight] = self.__load_weights()

        logger.info(
            f"OICompositeStrategy init: figi={settings.figi} "
            f"instrument={self.__instrument_type} "
            f"commission_round_trip={float(commission_rt)*100:.3f}% "
            f"long take={self.__long_take} stop={self.__long_stop} "
            f"signal_only={self.__signal_only}"
        )

    @property
    def settings(self) -> StrategySettings:
        return self.__settings

    @property
    def signal_only(self) -> bool:
        """Если True — ордера не выставляем, только Telegram-уведомления."""
        return self.__signal_only

    def update_lot_count(self, lot: int) -> None:
        self.__settings.lot_size = lot

    def update_short_status(self, status: bool) -> None:
        self.__settings.short_enabled_flag = status

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
            f"scores={dict(zip([m[0] for m in METHODS], [round(s, 3) for s in scores]))}"
        )

        if composite >= self.__threshold:
            return self.__make_signal(SignalType.LONG, self.__long_take, self.__long_stop, scores)

        if self.__settings.short_enabled_flag and composite <= -self.__threshold:
            return self.__make_signal(SignalType.SHORT, self.__short_take, self.__short_stop, scores)

        return None

    def notify_position_closed(self) -> None:
        """Вызвать извне при закрытии позиции — записываем исход."""
        if self.__open_trade:
            self.__record_outcome()

    # ── Внутренние методы ─────────────────────────────────────────────────────

    def __compute_composite(self) -> tuple[float, list[float]]:
        window = self.__candles
        vhf_mult = score_volatility_regime(window)

        scores = [fn(window) for _, fn in METHODS]
        weights = [self.__weights[name].weight for name, _ in METHODS]

        # взвешенная сумма; VOL_MOMENTUM усиливается режимом тренда
        weighted = sum(s * w for s, w in zip(scores, weights))
        weight_sum = sum(weights) or 1.0
        composite = (weighted / weight_sum) * (0.6 + 0.4 * vhf_mult)
        return composite, scores

    def __make_signal(
            self,
            signal_type: SignalType,
            take_mult: Decimal,
            stop_mult: Decimal,
            scores: list[float],
    ) -> Signal:
        last = self.__candles[-1]
        entry = quotation_to_decimal(last.close)

        method_scores = {name: scores[i] for i, (name, _) in enumerate(METHODS)}

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

        for i, (name, _) in enumerate(METHODS):
            score = self.__open_trade.method_scores.get(name, 0.0)
            if abs(score) < 0.05:
                continue
            aligned = (score > 0 and self.__open_trade.signal_type == SignalType.LONG) or \
                      (score < 0 and self.__open_trade.signal_type == SignalType.SHORT)
            target = quality if aligned else 1.0 - quality
            self.__weights[name].update(target)

        self.__open_trade = None
        self.__save_weights()

    # ── Персистентность весов ─────────────────────────────────────────────────

    def __weights_key(self) -> str:
        return self.__settings.figi

    def __load_weights(self) -> dict[str, MethodWeight]:
        w: dict[str, MethodWeight] = {name: MethodWeight() for name, _ in METHODS}
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
            data[key] = {
                name: {"weight": w.weight, "total": w.total, "sum_quality": w.sum_quality}
                for name, w in self.__weights.items()
            }
            with open(WEIGHTS_FILE, "w", encoding="utf-8") as f:
                json.dump(data, f, ensure_ascii=False, indent=2)
        except Exception as e:
            logger.warning(f"Could not save weights: {e}")
