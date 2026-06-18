"""
calibration.py — перцентильная нормализация скоров методов в реальном времени.

Проблема: 39 методов OIComposite выдают скоры в разных масштабах и с разными
распределениями. VWAP_SIGNAL может давать [-3, 3], BS_PRESSURE — [-0.8, 0.8].
Когда они суммируются с весами, более "громкий" метод доминирует не потому что
он лучше, а просто потому что большe по шкале.

Решение (аналог строк 876-927 oi-signal-v10.html): перед взвешиванием
нормализовать каждый скор в его перцентильный ранг в исторической
выборке по тикеру. score → rank ∈ [0, 1], где 0.5 = медиана истории.

Затем composite считается на нормализованных скорах — все методы на
одной шкале и конкурируют честно.

Дополнительно: распознаёт аномалии (score > p99) — выброс, который не
должен "продавить" composite в одиночку.
"""
import bisect
import logging
from collections import defaultdict

__all__ = ("PercentileCalibrator",)

logger = logging.getLogger(__name__)

WINDOW = 252   # ~год торговых дней в буфере
MIN_OBS = 10   # до этого нормализация не применяется


class PercentileCalibrator:
    """
    Отсортированный скользящий буфер дневных скоров по каждому методу/тикеру.
    Обновляется инкрементально (O(log n) insort). Инициализируется из
    HistoryStore.daily_scores при старте бота.
    """

    def __init__(self, window: int = WINDOW):
        # {ticker: {method: sorted list[float]}}
        self._bufs: dict[str, dict[str, list[float]]] = defaultdict(lambda: defaultdict(list))
        self._window = window

    def warm_up(self, ticker: str, method_scores: dict[str, list[float]]) -> None:
        """
        Загружает исторические значения из HistoryStore.daily_scores.
        Вызывается один раз при старте.
        """
        for method, scores in method_scores.items():
            buf = sorted(scores[-self._window:])
            self._bufs[ticker][method] = buf
        if method_scores:
            n = sum(len(v) for v in method_scores.values())
            logger.info(f"calibration warm_up {ticker}: {len(method_scores)} методов, {n} точек")

    def update(self, ticker: str, method: str, score: float) -> None:
        """Добавляет новое значение; вытесняет старейшее при переполнении."""
        buf = self._bufs[ticker][method]
        bisect.insort(buf, score)
        if len(buf) > self._window:
            buf.pop(0)

    def rank(self, ticker: str, method: str, score: float) -> float:
        """
        Перцентильный ранг: [0, 1], где 0 = ниже всей истории, 1 = выше всей.
        До MIN_OBS наблюдений — возвращает clamp(abs(score), 0, 1), чтобы не
        ломать composite на пустой истории.
        """
        buf = self._bufs[ticker][method]
        if len(buf) < MIN_OBS:
            return min(1.0, abs(score))
        idx = bisect.bisect_left(buf, score)
        return idx / len(buf)

    def normalize(self, ticker: str, method: str, score: float) -> float:
        """
        Нормализованный скор: rank × sign(score) → [-1, 1].
        Сохраняет направление сигнала, нормализует амплитуду.
        """
        if score == 0.0:
            return 0.0
        r = self.rank(ticker, method, abs(score))
        return r * (1.0 if score > 0 else -1.0)

    def is_anomaly(self, ticker: str, method: str, score: float, pct: float = 0.99) -> bool:
        """True если score за пределами pct-перцентиля — выброс."""
        buf = self._bufs[ticker][method]
        if len(buf) < MIN_OBS:
            return False
        threshold_idx = int(len(buf) * pct)
        return abs(score) > abs(buf[min(threshold_idx, len(buf) - 1)])

    def stats(self, ticker: str, method: str) -> dict:
        """p25/p50/p75/n — для диагностики и логов."""
        buf = self._bufs[ticker][method]
        n = len(buf)
        if n < 4:
            return {"n": n}
        return {
            "n": n,
            "p25": buf[n // 4],
            "p50": buf[n // 2],
            "p75": buf[3 * n // 4],
        }

    def ready(self, ticker: str, method: str) -> bool:
        return len(self._bufs[ticker][method]) >= MIN_OBS
