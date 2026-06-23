"""
narrative.py — качественный гейт поверх scores методов OICompositeStrategy.

Идея (см. обсуждение): композит — взвешенная сумма по всем методам — это
ощущения по отдельности; нарратив — это связная картина, требующая ПОСЛЕ-
ДОВАТЕЛЬНОСТИ ("объём вырос → цена не отреагировала → потом пробой" — это
другой сюжет, чем "объём вырос → цена сразу рванула"). Поэтому, в отличие
от всех остальных мультипликаторов в __compute_composite (regime/MTF/L1/
ATR-exhaustion), narrative — это:
  1) состояние с памятью МЕЖДУ барами (NarrativeState — конечный автомат),
     а не пересчёт с нуля на каждом баре;
  2) бинарный гейт ("сюжет сложился и совпадает по направлению" — пускаем
     сигнал, иначе — нет), а не ещё один множитель, чтобы не топить смысл
     в той же сумме;
  3) обучаемый по своим (narrative, regime) парам отдельно от весов методов
     (NarrativeWeights), тем же принципом EWA, что MethodWeight в
     oi_composite_strategy.py.

Группы переиспользуют STRATEGY_CLUSTERS (cluster_models.py) — те же 11
семантических кластеров, что уже используются в M1/M2/M3 — чтобы не вводить
вторую параллельную классификацию методов.
"""
import json
import logging
import os
from dataclasses import dataclass, field
from typing import Optional

from cluster_models import STRATEGY_CLUSTERS

__all__ = (
    "Tag",
    "classify_directional", "classify_volume", "classify_price_reaction",
    "NarrativeState", "update_narrative",
    "NarrativeWeights", "NarrativeThresholds",
    "fit_narrative_thresholds", "MIN_DAYS_PER_REGIME",
)

logger = logging.getLogger(__name__)

_CLUSTERS_BY_LABEL = {c["label"]: c["ids"] for c in STRATEGY_CLUSTERS}

# Порог "метод высказался" — мягче AGREE_SCORE_MIN (0.15) из
# oi_composite_strategy.py: для тега нужно не сильное мнение, а хоть какое-то.
_ABSTAIN_THRESH = 0.10
# Минимальная доля методов кластера, которые должны высказаться — иначе
# NO_OPINION (отличие от "высказались и сказали 0", это разные вещи: молчание
# методов из-за неподключённых провайдеров не должно читаться как нейтральность).
_MIN_QUORUM_SHARE = 0.34


@dataclass(frozen=True)
class Tag:
    value: str
    confidence: float  # 0..1 — доля методов кластера, которые реально высказались
    n_voted: int
    n_total: int


def _voted(scores: dict, names: list) -> list:
    return [scores[n] for n in names if abs(scores.get(n, 0.0)) >= _ABSTAIN_THRESH]


def classify_directional(scores: dict, cluster_label: str,
                          bullish_thresh: float = 0.2,
                          thresholds: "NarrativeThresholds | None" = None,
                          regime: str = "") -> Tag:
    """BULLISH/BEARISH/NEUTRAL/NO_OPINION — среднее score кластера.
    Применимо к кластерам с направленным смыслом: Тренд, Импульс,
    Адаптивные МА, Циклы, Микроструктура, Позиционирование.
    bullish_thresh — дефолт на холодном старте; если передан thresholds
    (калиброванный по перцентилям истории, см. calibrate_narrative.py) и для
    (cluster_label, regime) есть калибровка — она замещает дефолт."""
    if thresholds is not None:
        bullish_thresh = thresholds.get(cluster_label, regime, "bullish", bullish_thresh)
    names = _CLUSTERS_BY_LABEL.get(cluster_label, [])
    voted = _voted(scores, names)
    if not names or len(voted) < max(1, int(len(names) * _MIN_QUORUM_SHARE)):
        return Tag("NO_OPINION", 0.0, len(voted), len(names))
    avg = sum(voted) / len(voted)
    conf = len(voted) / len(names)
    if avg > bullish_thresh:
        return Tag("BULLISH", conf, len(voted), len(names))
    if avg < -bullish_thresh:
        return Tag("BEARISH", conf, len(voted), len(names))
    return Tag("NEUTRAL", conf, len(voted), len(names))


def classify_volume(scores: dict, cluster_label: str = "Объём",
                     accum_thresh: float = 0.2, climax_spread: float = 1.0,
                     thresholds: "NarrativeThresholds | None" = None,
                     regime: str = "") -> Tag:
    """ACCUMULATION/DISTRIBUTION/CLIMAX/NEUTRAL/NO_OPINION.
    CLIMAX определяется РАЗБРОСОМ методов группы, не средним: резкий объёмный
    скачок без согласия по знаку внутри группы типичен для климакса/выброса
    объёма (паника/кульминация), а не для направленного накопления/распределения.
    accum_thresh/climax_spread — дефолты на холодном старте, замещаются
    калиброванными значениями из thresholds, если они есть для regime."""
    if thresholds is not None:
        accum_thresh = thresholds.get(cluster_label, regime, "accum", accum_thresh)
        climax_spread = thresholds.get(cluster_label, regime, "climax_spread", climax_spread)
    names = _CLUSTERS_BY_LABEL.get(cluster_label, [])
    voted = _voted(scores, names)
    if not names or len(voted) < max(1, int(len(names) * _MIN_QUORUM_SHARE)):
        return Tag("NO_OPINION", 0.0, len(voted), len(names))
    avg = sum(voted) / len(voted)
    spread = max(voted) - min(voted)
    conf = len(voted) / len(names)
    if spread > climax_spread:
        return Tag("CLIMAX", conf, len(voted), len(names))
    if avg > accum_thresh:
        return Tag("ACCUMULATION", conf, len(voted), len(names))
    if avg < -accum_thresh:
        return Tag("DISTRIBUTION", conf, len(voted), len(names))
    return Tag("NEUTRAL", conf, len(voted), len(names))


def classify_price_reaction(price_move_pct: float, trend_tag: Tag,
                             flat_thresh_pct: float = 0.05) -> Tag:
    """BREAKOUT/FLAT/REJECT — куда фактически пошла цена относительно
    направления trend_tag. price_move_pct — % изменение цены за то же окно,
    на котором считается группа "Тренд" (PRICE_TREND и т.п.)."""
    if abs(price_move_pct) < flat_thresh_pct:
        return Tag("FLAT", 1.0, 1, 1)
    if trend_tag.value not in ("BULLISH", "BEARISH"):
        return Tag("FLAT", 0.3, 0, 1)
    sign_move = 1 if price_move_pct > 0 else -1
    sign_trend = 1 if trend_tag.value == "BULLISH" else -1
    value = "BREAKOUT" if sign_move == sign_trend else "REJECT"
    return Tag(value, trend_tag.confidence, 1, 1)


# ── Слой 2: FSM с памятью между барами ───────────────────────────────────────
#
# Один и тот же тег "объём=ACCUMULATION" ведёт в WATCHING_ACCUMULATION в любом
# случае; то, ЧТО ПРОИЗОЙДЁТ ПОСЛЕ на следующих барах (BREAKOUT/REJECT/timeout),
# определяет, в какой сюжет это превратится. Без персистентного состояния
# отличить "поглощение" от "импульса" по одному бару нельзя.

# Таймаут резолюции сюжета (баров) — зависит от режима: в высокой волатильности
# сюжет резолвится быстрее, в низковолатильном боковике — дольше.
_TIMEOUT_BARS = {
    "trending_up": 30, "trending_down": 30,
    "ranging": 60, "high_vol": 15, "low_vol": 80, "stress": 10,
}
_DEFAULT_TIMEOUT = 30
# В стрессе сюжет не строим вообще — слишком ненадёжно, как и решили раньше.
_NO_NARRATIVE_REGIMES = frozenset({"stress"})

# direction_hint каждого состояния: +1 long, -1 short, 0 — сюжет ещё не выбрал
# сторону (наблюдение) или сторона не торгуемая (нейтрально/неактуально).
_DIRECTION = {
    "NEUTRAL": 0,
    "WATCHING_ACCUMULATION": 0,
    "WATCHING_DISTRIBUTION": 0,
    "CONFIRMED_UPTREND": 1,
    "CONFIRMED_DOWNTREND": -1,
    "EXHAUSTION_LONG": 1,
    "EXHAUSTION_SHORT": -1,
    "REVERSAL_WATCH_UP": 1,
    "REVERSAL_WATCH_DOWN": -1,
}
# Состояния, в которых сюжет уже СЛОЖИЛСЯ и можно пропускать сигнал — в
# отличие от WATCHING_*/NEUTRAL, которые ещё только наблюдают за развитием.
_ACTIONABLE = frozenset({
    "CONFIRMED_UPTREND", "CONFIRMED_DOWNTREND",
    "REVERSAL_WATCH_UP", "REVERSAL_WATCH_DOWN",
})


@dataclass
class NarrativeState:
    name: str = "NEUTRAL"
    bars_in_state: int = 0
    entry_tags: dict = field(default_factory=dict)

    @property
    def direction(self) -> int:
        return _DIRECTION.get(self.name, 0)

    @property
    def is_actionable(self) -> bool:
        return self.name in _ACTIONABLE


def update_narrative(
        state: NarrativeState, *,
        trend: Tag, volume: Tag, price_reaction: Tag,
        regime: str, exhaustion: bool,
) -> NarrativeState:
    """Один шаг конечного автомата сюжета — чистая функция (старое состояние +
    новые теги) → новое состояние. exhaustion — признак того, что движение уже
    исчерпало бОльшую часть дневного ATR (см. _atr_exhaustion_mult в
    oi_composite_strategy.py: тот же сигнал, что уже даёт ATR-демпфер,
    переиспользуется здесь, а не считается заново)."""
    if regime in _NO_NARRATIVE_REGIMES:
        return NarrativeState("NEUTRAL")

    timeout = _TIMEOUT_BARS.get(regime, _DEFAULT_TIMEOUT)
    bars = state.bars_in_state + 1

    def _stay() -> NarrativeState:
        return NarrativeState(state.name, bars, state.entry_tags)

    def _enter(name: str) -> NarrativeState:
        return NarrativeState(name, 0, {
            "trend": trend.value, "volume": volume.value, "regime": regime,
        })

    def _reset() -> NarrativeState:
        return NarrativeState("NEUTRAL")

    name = state.name

    if name == "NEUTRAL":
        if trend.value == "BULLISH" and volume.value == "ACCUMULATION" and price_reaction.value == "BREAKOUT":
            return _enter("CONFIRMED_UPTREND")
        if trend.value == "BEARISH" and volume.value == "DISTRIBUTION" and price_reaction.value == "BREAKOUT":
            return _enter("CONFIRMED_DOWNTREND")
        if volume.value == "ACCUMULATION" and price_reaction.value == "FLAT":
            return _enter("WATCHING_ACCUMULATION")
        if volume.value == "DISTRIBUTION" and price_reaction.value == "FLAT":
            return _enter("WATCHING_DISTRIBUTION")
        return _stay()

    if name == "WATCHING_ACCUMULATION":
        if bars > timeout or volume.value == "DISTRIBUTION" or price_reaction.value == "REJECT":
            return _reset()
        if price_reaction.value == "BREAKOUT" and trend.value != "BEARISH":
            return _enter("CONFIRMED_UPTREND")
        return _stay()

    if name == "WATCHING_DISTRIBUTION":
        if bars > timeout or volume.value == "ACCUMULATION" or price_reaction.value == "REJECT":
            return _reset()
        if price_reaction.value == "BREAKOUT" and trend.value != "BULLISH":
            return _enter("CONFIRMED_DOWNTREND")
        return _stay()

    if name == "CONFIRMED_UPTREND":
        if trend.value == "BEARISH":
            return _reset()
        if exhaustion and volume.value == "CLIMAX":
            return _enter("EXHAUSTION_LONG")
        return _stay()

    if name == "CONFIRMED_DOWNTREND":
        if trend.value == "BULLISH":
            return _reset()
        if exhaustion and volume.value == "CLIMAX":
            return _enter("EXHAUSTION_SHORT")
        return _stay()

    if name == "EXHAUSTION_LONG":
        if bars > timeout:
            return _reset()
        if price_reaction.value == "REJECT":
            return _enter("REVERSAL_WATCH_DOWN")
        if trend.value == "BEARISH":
            return _reset()
        return _stay()

    if name == "EXHAUSTION_SHORT":
        if bars > timeout:
            return _reset()
        if price_reaction.value == "REJECT":
            return _enter("REVERSAL_WATCH_UP")
        if trend.value == "BULLISH":
            return _reset()
        return _stay()

    if name in ("REVERSAL_WATCH_UP", "REVERSAL_WATCH_DOWN"):
        if bars > max(1, timeout // 2):
            return _reset()
        return _stay()

    return _reset()


# ── Слой 4: обучение доверия к сюжетам (EWA per narrative×regime) ───────────
#
# Тот же принцип, что MethodWeight в oi_composite_strategy.py (Hedge/EWA по
# quality сделки), но на уровне сюжета — чтобы таблица переходов не превра-
# тилась в навечно зашитые правила: сюжет, который статистически не работает
# в конкретном режиме, теряет доверие и временно не допускается до сигнала,
# без ручного вмешательства.

NARRATIVE_WEIGHTS_FILE = "data/narrative_weights.json"
_EWA_ALPHA = 0.1
# Меньше этого числа сделок по (narrative, regime) — холодный старт,
# доверяем по умолчанию, чтобы дать сюжету накопить историю (как
# AUTO_ATR_MIN_TRADES в oi_composite_strategy.py).
_MIN_TRADES_TRUSTED = 8


class NarrativeWeights:
    """EWA quality по каждой паре (narrative, regime). Персистентность —
    JSON-файл рядом с history.json/archive.json."""

    def __init__(self, path: str = NARRATIVE_WEIGHTS_FILE):
        self._path = path
        self._data: dict[str, dict[str, dict]] = {}
        self._load()

    def _load(self) -> None:
        if os.path.exists(self._path):
            try:
                with open(self._path, encoding="utf-8") as f:
                    self._data = json.load(f)
            except (json.JSONDecodeError, OSError) as e:
                logger.warning(f"narrative_weights: не удалось загрузить: {e}")

    def _save(self) -> None:
        try:
            os.makedirs(os.path.dirname(self._path) or ".", exist_ok=True)
            tmp = self._path + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(self._data, f, ensure_ascii=False, indent=2)
            os.replace(tmp, self._path)
        except OSError as e:
            logger.warning(f"narrative_weights: не удалось сохранить: {e}")

    def record_outcome(self, narrative: str, regime: str, quality: float) -> None:
        bucket = self._data.setdefault(narrative, {}).setdefault(
            regime, {"n": 0, "ewa": 0.5},
        )
        bucket["n"] += 1
        bucket["ewa"] = (1 - _EWA_ALPHA) * bucket["ewa"] + _EWA_ALPHA * quality
        self._save()

    def trust(self, narrative: str, regime: str) -> tuple:
        bucket = self._data.get(narrative, {}).get(regime)
        if not bucket:
            return 0.5, 0
        return bucket["ewa"], bucket["n"]

    def is_trusted(self, narrative: str, regime: str, min_quality: float = 0.45) -> bool:
        ewa, n = self.trust(narrative, regime)
        if n < _MIN_TRADES_TRUSTED:
            return True
        return ewa >= min_quality


# ── Слой 1.5: калиброванные пороги тегов (перцентили по истории) ────────────
#
# bullish_thresh/accum_thresh/climax_spread в classify_directional/
# classify_volume по умолчанию — захардкоженные числа для холодного старта
# (когда истории ещё нет). calibrate_narrative.py считает реальные перцентили
# распределения кластерных скоров ПО РЕЖИМАМ (то, что бычье в trending_up,
# может быть медианой в ranging) и пишет их сюда — тогда пороги берутся из
# данных конкретного тикера, а не угадываются.

NARRATIVE_THRESHOLDS_FILE = "data/narrative_thresholds.json"


class NarrativeThresholds:
    """Калиброванные пороги по (cluster_label, regime). JSON вида
    {cluster_label: {regime: {"bullish": .., "accum": .., "climax_spread": ..}}},
    пишется calibrate_narrative.py. Без калибровки get() возвращает default,
    переданный вызывающей стороной (см. classify_directional/classify_volume)."""

    def __init__(self, path: str = NARRATIVE_THRESHOLDS_FILE):
        self._path = path
        self._data: dict[str, dict[str, dict[str, float]]] = {}
        self._load()

    def _load(self) -> None:
        if os.path.exists(self._path):
            try:
                with open(self._path, encoding="utf-8") as f:
                    self._data = json.load(f)
            except (json.JSONDecodeError, OSError) as e:
                logger.warning(f"narrative_thresholds: не удалось загрузить: {e}")

    def get(self, cluster_label: str, regime: str, key: str, default: float) -> float:
        bucket = self._data.get(cluster_label, {}).get(regime)
        if not bucket or key not in bucket:
            return default
        return bucket[key]

    def set_data(self, data: dict[str, dict[str, dict[str, float]]]) -> None:
        """Подставить пороги напрямую (in-memory), минуя файл — для
        адаптивной пере-калибровки в процессе бэктеста (run_backtest_one)."""
        self._data = data


# Перцентили, определяющие "явно выраженный" сигнал — выше них направление
# считается не шумом, а реальным согласием кластера. 65/35 — не середина
# (50/50 ловила бы шум), но и не крайность (90/10 почти никогда не сработает).
_DIRECTIONAL_PCT = 0.65
_VOLUME_PCT = 0.65
# Перцентиль РАЗБРОСА (не среднего) для CLIMAX — верхний хвост распределения
# спреда внутри группы "Объём" за день.
_CLIMAX_SPREAD_PCT = 0.85

MIN_DAYS_PER_REGIME = 20


def _percentile(values: list[float], pct: float) -> float:
    if not values:
        return 0.0
    s = sorted(values)
    idx = min(len(s) - 1, max(0, int(len(s) * pct)))
    return s[idx]


def fit_narrative_thresholds(by_regime: dict[str, list[dict[str, float]]]) -> dict | None:
    """Чистая версия расчёта порогов — принимает уже собранные дневные
    method_scores по режимам (см. HistoryStore.daily_method_scores_by_regime
    / BacktestHistoryStore — структура та же), без обращения к диску.
    Используется и для офлайн-калибровки (calibrate_narrative.py), и для
    адаптивной пере-калибровки внутри бэктеста (run_backtest_one)."""
    if not by_regime:
        return None
    result: dict[str, dict[str, dict[str, float]]] = {}
    for cl in STRATEGY_CLUSTERS:
        label = cl["label"]
        ids = cl["ids"]
        for regime, day_scores_list in by_regime.items():
            if len(day_scores_list) < MIN_DAYS_PER_REGIME:
                continue
            avgs: list[float] = []
            spreads: list[float] = []
            for day_scores in day_scores_list:
                vals = [day_scores[m] for m in ids if m in day_scores]
                if not vals:
                    continue
                avgs.append(sum(vals) / len(vals))
                spreads.append(max(vals) - min(vals))
            if not avgs:
                continue
            bullish = _percentile([abs(a) for a in avgs], _DIRECTIONAL_PCT)
            accum = _percentile([abs(a) for a in avgs], _VOLUME_PCT)
            climax_spread = _percentile(spreads, _CLIMAX_SPREAD_PCT)
            result.setdefault(label, {})[regime] = {
                "bullish": round(bullish, 4),
                "accum": round(accum, 4),
                "climax_spread": round(climax_spread, 4),
                "n_days": len(avgs),
            }
    return result or None
