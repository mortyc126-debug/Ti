"""
index_context.py — положение индекса (IMOEX) относительно СВОИХ уровней как
рыночный контекст для всех тикеров.

Логика (из обсуждения): у уровня контрарный сценарий важнее инерции — самый
сильный рост рынка это отскоки индекса от дна: толпа перенабрала шорты, падение
достигло апогея у поддержки → отскок. МЕЖДУ уровнями наоборот — работает
инерция: набранные шорты продолжают давить, пока апогей не достигнут.

Поэтому index_bias ∈ [-1, 1]:
  - близко к поддержке (< NEAR_ATR дневных ATR) → сильный ПЛЮС (лонг-байас,
    растёт с близостью) — контрарно падению;
  - близко к сопротивлению → сильный МИНУС — контрарно росту;
  - между уровнями → слабая инерция (знак наклона MA20 дневного, cap 0.3);
  - у обоих уровней сразу (узкий диапазон) → 0.

Bias подаётся в композит как провайдерный метод INDEX_CONTEXT (аналог INST_OI):
свой Hedge-вес обучится сам — если контекст индекса не помогает конкретному
тикеру, вес сожмётся. Никаких жёстких гейтов «не торговать когда индекс ниже» —
это отрезало бы ровно те отскоки от дна, ради которых слой и заведён.
"""
import datetime
import logging
from bisect import bisect_right

logger = logging.getLogger(__name__)

__all__ = ("daily_from_intraday", "compute_index_bias", "IndexContextBacktestProvider")

# Порог близости к уровню в дневных ATR: ближе — включается контрарная логика.
NEAR_ATR = 0.8
# Максимальный модуль инерционной составляющей между уровнями.
MOMENTUM_CAP = 0.3
# Окно поиска swing-уровней (дневных баров) и шаг локального экстремума.
LEVEL_LOOKBACK = 60
SWING_STEP = 3
ATR_PERIOD = 14
MA_PERIOD = 20
# Минимум дневных баров для расчёта.
MIN_DAILY_BARS = 25


def daily_from_intraday(candles) -> list[dict]:
    """Агрегация внутридневных свечей (tinkoff HistoricCandle или совместимых)
    в дневные бары [{date, o, h, l, c}] по календарной дате UTC."""
    def _f(q):
        return q if isinstance(q, (int, float)) else float(q.units) + q.nano / 1e9

    days: dict = {}
    for c in candles:
        d = c.time.date()
        bar = days.get(d)
        if bar is None:
            days[d] = {"date": d, "o": _f(c.open), "h": _f(c.high),
                       "l": _f(c.low), "c": _f(c.close)}
        else:
            bar["h"] = max(bar["h"], _f(c.high))
            bar["l"] = min(bar["l"], _f(c.low))
            bar["c"] = _f(c.close)
    return [days[d] for d in sorted(days)]


def _daily_atr(daily: list[dict], period: int = ATR_PERIOD) -> float:
    trs = []
    for i in range(1, len(daily)):
        prev_c = daily[i - 1]["c"]
        trs.append(max(daily[i]["h"] - daily[i]["l"],
                       abs(daily[i]["h"] - prev_c),
                       abs(daily[i]["l"] - prev_c)))
    tail = trs[-period:]
    return sum(tail) / len(tail) if tail else 0.0


def _swing_levels(daily: list[dict], step: int = SWING_STEP) -> tuple[list[float], list[float]]:
    """Локальные экстремумы дневных hi/lo: (supports, resistances)."""
    sup, res = [], []
    for i in range(step, len(daily) - step):
        window = daily[i - step:i + step + 1]
        if daily[i]["l"] == min(b["l"] for b in window):
            sup.append(daily[i]["l"])
        if daily[i]["h"] == max(b["h"] for b in window):
            res.append(daily[i]["h"])
    return sup, res


def compute_index_bias(daily: list[dict]) -> float:
    """index_bias по дневным барам (последний бар = «сегодняшний контекст»)."""
    if len(daily) < MIN_DAILY_BARS:
        return 0.0
    daily = daily[-LEVEL_LOOKBACK:]
    close = daily[-1]["c"]
    atr = _daily_atr(daily)
    if atr <= 0:
        return 0.0

    sup_levels, res_levels = _swing_levels(daily)
    support = max((s for s in sup_levels if s < close), default=None)
    resistance = min((r for r in res_levels if r > close), default=None)

    near_sup = support is not None and (close - support) / atr < NEAR_ATR
    near_res = resistance is not None and (resistance - close) / atr < NEAR_ATR

    if near_sup and near_res:
        return 0.0  # зажат в узком диапазоне — уровни спорят, контекста нет
    if near_sup:
        # апогей падения: чем ближе к поддержке, тем сильнее лонг-байас
        closeness = 1.0 - max(0.0, (close - support) / atr) / NEAR_ATR
        return round(min(1.0, 0.4 + 0.6 * closeness), 4)
    if near_res:
        closeness = 1.0 - max(0.0, (resistance - close) / atr) / NEAR_ATR
        return round(-min(1.0, 0.4 + 0.6 * closeness), 4)

    # Между уровнями — инерция: набранное движение продолжается до апогея.
    closes = [b["c"] for b in daily[-MA_PERIOD * 2:]]
    if len(closes) < MA_PERIOD + 5:
        return 0.0
    ma_now = sum(closes[-MA_PERIOD:]) / MA_PERIOD
    ma_prev = sum(closes[-MA_PERIOD - 5:-5]) / MA_PERIOD
    slope_norm = (ma_now - ma_prev) / atr  # наклон MA20 за 5 дней в ATR
    return round(max(-MOMENTUM_CAP, min(MOMENTUM_CAP, slope_norm * 0.3)), 4)


class IndexContextBacktestProvider:
    """Исторический index_bias по датам для бэктеста — без подглядывания:
    bias даты D считается только по дневкам ДО D (не включая). Дата двигается
    тем же date-hook'ом, что OiBacktestProvider."""

    def __init__(self, daily: list[dict]):
        self.__dates: list = []
        self.__biases: list[float] = []
        for i in range(MIN_DAILY_BARS, len(daily) + 1):
            self.__dates.append(daily[i - 1]["date"])
            # контекст на день D = по дневкам до D-1 включительно
            self.__biases.append(compute_index_bias(daily[:i - 1]) if i > MIN_DAILY_BARS else 0.0)
        self.__current: float = 0.0

    @classmethod
    def from_intraday(cls, candles) -> "IndexContextBacktestProvider":
        return cls(daily_from_intraday(candles))

    def has_data(self) -> bool:
        return bool(self.__dates)

    def set_date(self, date_iso: str) -> None:
        try:
            d = datetime.date.fromisoformat(date_iso)
        except ValueError:
            return
        idx = bisect_right(self.__dates, d) - 1
        self.__current = self.__biases[idx] if idx >= 0 else 0.0

    def score(self, ticker: str = "") -> float:
        return self.__current
