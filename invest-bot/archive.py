"""
archive.py — персистентный архив расчётов композита по тикерам.

Это и есть "база данных" поверх торговой логики: бот не просто считает
композит и забывает его в памяти на день — каждый торговый день кладёт
итоговый снэпшок (composite, scores всех методов, режим рынка, rolling
quality) в data/archive.json, по ВСЕМ тикерам, которые он хоть раз
посчитал — и сконфигурированным в settings.ini, и найденным через
MEGA-ALERTS (включая те, что не прошли backtest_quality и не начали
торговаться — видно, почему отсеялись).
"""
import json
import logging
import os
from datetime import datetime, timedelta, timezone

__all__ = ("ArchiveStore",)

logger = logging.getLogger(__name__)

ARCHIVE_FILE = "data/archive.json"
DAYS_KEPT = 90


class ArchiveStore:
    def __init__(self):
        self._data: dict[str, dict[str, dict]] = {}
        self._load()

    def _load(self):
        if not os.path.exists(ARCHIVE_FILE):
            return
        try:
            with open(ARCHIVE_FILE, encoding="utf-8") as f:
                self._data = json.load(f)
        except (json.JSONDecodeError, OSError) as e:
            logger.warning(f"archive: не удалось загрузить архив: {e}")

    def _save(self):
        os.makedirs("data", exist_ok=True)
        try:
            tmp = ARCHIVE_FILE + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(self._data, f, ensure_ascii=False)
            os.replace(tmp, ARCHIVE_FILE)
        except OSError as e:
            logger.warning(f"archive: не удалось сохранить архив: {e}")

    def record(
            self,
            ticker: str,
            *,
            composite: float,
            scores: dict[str, float],
            regime: str,
            rolling_quality: float,
            live: bool,
            backtest_quality: float | None = None,
            backtest_trades: int | None = None,
            auto_atr_take_k: float | None = None,
            auto_atr_stop_k: float | None = None,
            noise_mode: bool | None = None,
            ic_warm: bool | None = None,
            stat_break_uncertainty: float | None = None,
            narrative_state: str | None = None,
            rejection_stats: dict | None = None,
    ) -> None:
        """
        Снэпшок на конец дня по одному тикеру (вызывается раз в trade_day).
        live=True значит SIGNAL_ONLY=0 у стратегии (реальные ордера разрешены),
        не "была ли сделка сегодня" — это для этого и так видно в TradeResults.
        """
        date = datetime.now(timezone.utc).date().isoformat()
        per_ticker = self._data.setdefault(ticker, {})
        per_ticker[date] = {
            "composite": round(composite, 4),
            "scores": {k: round(v, 4) for k, v in scores.items()},
            "regime": regime,
            "rolling_quality": round(rolling_quality, 4),
            "live": live,
            "backtest_quality": round(backtest_quality, 4) if backtest_quality is not None else None,
            "backtest_trades": backtest_trades,
            "auto_atr_take_k": auto_atr_take_k,
            "auto_atr_stop_k": auto_atr_stop_k,
            "noise_mode": noise_mode,
            "ic_warm": ic_warm,
            "stat_break_uncertainty": stat_break_uncertainty,
            "narrative_state": narrative_state,
            "rejection_stats": rejection_stats,
        }
        cutoff = (datetime.now(timezone.utc).date() - timedelta(days=DAYS_KEPT)).isoformat()
        per_ticker_trimmed = {d: v for d, v in per_ticker.items() if d >= cutoff}
        self._data[ticker] = per_ticker_trimmed
        self._save()

    def history(self, ticker: str) -> dict[str, dict]:
        return self._data.get(ticker, {})

    def tickers(self) -> list[str]:
        return list(self._data.keys())
