"""
history.py — полноценная аналитическая база для самообучения стратегии.

Хранит не только дневные снэпшоты (как ArchiveStore), но и отдельные
сделки с attribution по каждому методу — чтобы система знала кто из
39 методов был прав, в каком режиме, и с каким качеством.

Аналог IndexedDB-хранилища в oi-signal-v10.html (dbSaveWeight + signals
store), но в виде простого JSON, без браузера.

Структура data/history.json:
{
  "SBER": {
    "2024-01-15": {
      "composite": 0.42,
      "scores": {method: score},
      "regime": "trending_up",
      "regime_confidence": 0.88,
      "rolling_quality": 0.58,
      "live": true,
      "trades": [
        {
          "dir": "LONG",
          "entry": 280.5, "exit": 283.2,
          "mfe": 0.0097, "mae": 0.0031,   # доли от entry
          "quality": 0.758,
          "method_scores": {method: score},  # скоры НА МОМЕНТ входа
          "tf_regime": {"1min": "trending_up", "5min": "ranging", "1h": "trending_up"}
        }
      ]
    }
  }
}
"""
import json
import logging
import os
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from typing import Optional

__all__ = ("HistoryStore",)

logger = logging.getLogger(__name__)

HISTORY_FILE = "data/history.json"
DAYS_KEPT = 90
EWA_ALPHA = 0.1
MIN_OBS = 30  # минимум сделок до того как вес начинает отклоняться от 0.5


class HistoryStore:
    def __init__(self):
        self._data: dict[str, dict[str, dict]] = {}
        self._load()

    # ── I/O ──────────────────────────────────────────────────────────────────

    def _load(self):
        if not os.path.exists(HISTORY_FILE):
            return
        try:
            with open(HISTORY_FILE, encoding="utf-8") as f:
                self._data = json.load(f)
        except (json.JSONDecodeError, OSError) as e:
            logger.warning(f"history: не удалось загрузить: {e}")

    def _save(self):
        os.makedirs("data", exist_ok=True)
        try:
            tmp = HISTORY_FILE + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(self._data, f, ensure_ascii=False)
            os.replace(tmp, HISTORY_FILE)
        except OSError as e:
            logger.warning(f"history: не удалось сохранить: {e}")

    def _cutoff(self, days: int = DAYS_KEPT) -> str:
        return (datetime.now(timezone.utc).date() - timedelta(days=days)).isoformat()

    def _trim(self, ticker: str):
        cutoff = self._cutoff()
        self._data[ticker] = {d: v for d, v in self._data[ticker].items() if d >= cutoff}

    # ── Запись ───────────────────────────────────────────────────────────────

    def record_daily(
            self,
            ticker: str,
            *,
            composite: float,
            scores: dict[str, float],
            regime: str,
            regime_confidence: float = 1.0,
            rolling_quality: float,
            live: bool,
    ) -> None:
        """Дневной снэпшот — вызывается в конце торговой сессии."""
        date = datetime.now(timezone.utc).date().isoformat()
        day = self._data.setdefault(ticker, {}).setdefault(date, {})
        day.update({
            "composite": round(composite, 4),
            "scores": {k: round(v, 4) for k, v in scores.items()},
            "regime": regime,
            "regime_confidence": round(regime_confidence, 4),
            "rolling_quality": round(rolling_quality, 4),
            "live": live,
        })
        self._trim(ticker)
        self._save()

    def record_trade(
            self,
            ticker: str,
            *,
            direction: str,           # "LONG" | "SHORT"
            entry_price: float,
            exit_price: float,
            mfe: float,               # доля от entry: (лучшая цена - entry) / entry
            mae: float,               # доля от entry: (entry - худшая цена) / entry
            method_scores: dict[str, float],
            regime: str = "",
            tf_regimes: Optional[dict[str, str]] = None,
    ) -> None:
        """
        Запись сделки с attribution по методам.
        quality = mfe / (mfe + mae + 1e-8) — непрерывная метрика [0,1],
        аналогично oi-signal-v10.html строки 1364.
        """
        quality = mfe / (mfe + mae + 1e-8)
        date = datetime.now(timezone.utc).date().isoformat()
        day = self._data.setdefault(ticker, {}).setdefault(date, {})
        trades = day.setdefault("trades", [])
        record = {
            "dir": direction,
            "entry": round(entry_price, 4),
            "exit": round(exit_price, 4),
            "mfe": round(mfe, 6),
            "mae": round(mae, 6),
            "quality": round(quality, 4),
            "method_scores": {k: round(v, 4) for k, v in method_scores.items()},
        }
        if regime:
            record["regime"] = regime
        if tf_regimes:
            record["tf_regimes"] = tf_regimes
        trades.append(record)
        self._trim(ticker)
        self._save()

    # ── Чтение: сырые данные ──────────────────────────────────────────────────

    def get_trades(self, ticker: str, window_days: int = 60) -> list[dict]:
        """Все сделки за последние window_days дней."""
        cutoff = self._cutoff(window_days)
        result = []
        for date, day in self._data.get(ticker, {}).items():
            if date >= cutoff:
                result.extend(day.get("trades", []))
        return result

    def daily_scores(self, ticker: str, method: str, window_days: int = 30) -> list[float]:
        """Исторические значения скора метода по дням — для перцентильной калибровки."""
        cutoff = self._cutoff(window_days)
        return [
            day["scores"][method]
            for date, day in sorted(self._data.get(ticker, {}).items())
            if date >= cutoff and method in day.get("scores", {})
        ]

    # ── Аналитика: точность методов ──────────────────────────────────────────

    def method_performance(
            self, ticker: str, window_days: int = 60
    ) -> dict[str, dict]:
        """
        Точность каждого метода за window_days дней.
        Метод "поддержал" сделку если score был в направлении входа.
        target_acc = quality если поддержал, (1 - quality) если против.
        Аналог строк 2857-2878 в oi-signal-v10.html.

        Возвращает:
        {method: {wins, total, avg_quality, ewa_weight}}
        """
        trades = self.get_trades(ticker, window_days)
        per_method: dict[str, dict] = {}

        for trade in trades:
            q = trade["quality"]
            direction = trade["dir"]
            for method, score in trade.get("method_scores", {}).items():
                aligned = (score > 0 and direction == "LONG") or \
                          (score < 0 and direction == "SHORT")
                target_acc = q if aligned else (1.0 - q)
                s = per_method.setdefault(method, {
                    "wins": 0, "total": 0, "sum_q": 0.0, "ewa_weight": 0.5
                })
                s["total"] += 1
                s["sum_q"] += target_acc
                if aligned and q > 0.55:
                    s["wins"] += 1

        for s in per_method.values():
            n = s["total"]
            s["avg_quality"] = s["sum_q"] / n if n > 0 else 0.5
            # вес начинает отклоняться от дефолта 0.5 только после MIN_OBS сделок
            if n >= MIN_OBS:
                raw = s["sum_q"] / n
                s["ewa_weight"] = max(0.05, min(1.0, raw))

        return per_method

    def regime_method_performance(
            self, ticker: str, window_days: int = 90
    ) -> dict[str, dict[str, float]]:
        """
        Средняя точность каждого метода В КАЖДОМ режиме.
        Возвращает {regime: {method: avg_quality}}.
        Используется для динамической замены захардкоженных REGIME_WEIGHT_MODS.
        """
        cutoff = self._cutoff(window_days)
        # {regime: {method: [quality_values]}}
        acc: dict[str, dict[str, list[float]]] = defaultdict(lambda: defaultdict(list))

        for date, day in self._data.get(ticker, {}).items():
            if date < cutoff:
                continue
            for trade in day.get("trades", []):
                regime = trade.get("regime") or day.get("regime", "")
                if not regime:
                    continue
                q = trade["quality"]
                direction = trade["dir"]
                for method, score in trade.get("method_scores", {}).items():
                    aligned = (score > 0 and direction == "LONG") or \
                              (score < 0 and direction == "SHORT")
                    acc[regime][method].append(q if aligned else 1.0 - q)

        return {
            regime: {m: sum(v) / len(v) for m, v in methods.items() if v}
            for regime, methods in acc.items()
        }

    def timeframe_method_performance(
            self, ticker: str, window_days: int = 60
    ) -> dict[str, dict[str, dict[str, float]]]:
        """
        Точность методов в разрезе таймфреймов (если tf_regimes записан в сделке).
        Возвращает {tf: {regime: {method: avg_quality}}}.
        """
        cutoff = self._cutoff(window_days)
        # {tf: {regime: {method: [values]}}}
        acc: dict = defaultdict(lambda: defaultdict(lambda: defaultdict(list)))

        for date, day in self._data.get(ticker, {}).items():
            if date < cutoff:
                continue
            for trade in day.get("trades", []):
                tf_regimes = trade.get("tf_regimes", {})
                if not tf_regimes:
                    continue
                q = trade["quality"]
                direction = trade["dir"]
                for tf, regime in tf_regimes.items():
                    for method, score in trade.get("method_scores", {}).items():
                        aligned = (score > 0 and direction == "LONG") or \
                                  (score < 0 and direction == "SHORT")
                        acc[tf][regime][method].append(q if aligned else 1.0 - q)

        return {
            tf: {
                regime: {m: sum(v) / len(v) for m, v in methods.items() if v}
                for regime, methods in regimes.items()
            }
            for tf, regimes in acc.items()
        }

    def percentile_rank(self, ticker: str, method: str, score: float, window_days: int = 30) -> float:
        """
        Нормализует score в перцентильный ранг [0, 1] относительно истории.
        0.5 = медиана, 1.0 = исторический максимум, 0.0 = минимум.
        Если истории недостаточно — возвращает clamp(abs(score), 0, 1).
        """
        history = self.daily_scores(ticker, method, window_days)
        if len(history) < 5:
            return min(1.0, abs(score))
        below = sum(1 for h in history if h < score)
        return below / len(history)

    def win_rate(self, ticker: str, window_days: int = 30) -> Optional[float]:
        """Доля сделок с quality > 0.55 за period."""
        trades = self.get_trades(ticker, window_days)
        if not trades:
            return None
        wins = sum(1 for t in trades if t["quality"] > 0.55)
        return wins / len(trades)

    def tickers(self) -> list[str]:
        return list(self._data.keys())
