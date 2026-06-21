"""
runtime_overrides.py — настройки бота, регулируемые с дашборда без перезапуска
процесса. Дашборд (отдельный процесс) пишет data/bot_overrides.json, бот
(trader.py) перечитывает файл по mtime на каждой свече и применяет изменения
к уже работающим стратегиям (OICompositeStrategy.set_signal_only /
set_take_stop_overrides). Изменения take/stop влияют только на сигналы,
которые стратегия сгенерирует ПОСЛЕ применения — уже открытая позиция
торгуется с уровнями, зафиксированными в её сигнале на момент входа.

Формат файла:
{
  "global_signal_only": null | true | false,   // null — нет глобального оверрайда
  "partial_tp_enabled": null | true | false,    // null — берём дефолт из PARTIAL_TP_DEFAULT_ENABLED (trader.py)
  "adaptive_exit_enabled": null | true | false, // null — берём дефолт из ADAPTIVE_EXIT_ENABLED (trader.py)
  "orderbook_enabled": null | true | false,     // null — берём дефолт из ORDERBOOK_DEFAULT_ENABLED (trader.py)
  "paused": false,                              // true — пауза: новые позиции не открываются (как /pause в ТГ)
  "close_requests": [],                         // тикеры или "ALL" — срочное закрытие, бот очищает после исполнения
  "tickers": {
    "SBER": {
      "enabled": true,                          // false — новые сигналы не открываются (ни реально, ни signal-only)
      "signal_only": null | true | false,       // null — берём из settings.ini
      "long_take": null | "1.02", ...           // null — берём из settings.ini
    }
  }
}
"""
import json
import logging
import os
from decimal import Decimal

__all__ = ("RuntimeOverrides", "OVERRIDES_FILE")

logger = logging.getLogger(__name__)

OVERRIDES_FILE = "data/bot_overrides.json"

_DECIMAL_FIELDS = ("long_take", "long_stop", "short_take", "short_stop")


def load_overrides(path: str = OVERRIDES_FILE) -> dict:
    if not os.path.exists(path):
        return {"global_signal_only": None, "tickers": {}}
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, json.JSONDecodeError) as ex:
        logger.warning(f"runtime_overrides: не удалось прочитать {path}: {repr(ex)}")
        return {"global_signal_only": None, "tickers": {}}
    data.setdefault("global_signal_only", None)
    data.setdefault("partial_tp_enabled", None)
    data.setdefault("adaptive_exit_enabled", None)
    data.setdefault("orderbook_enabled", None)
    data.setdefault("paused", False)
    data.setdefault("close_requests", [])
    data.setdefault("tickers", {})
    return data


def save_overrides(data: dict, path: str = OVERRIDES_FILE) -> None:
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    os.replace(tmp, path)


class RuntimeOverrides:
    """
    Polled внутри Trader: maybe_reload() — дёшево (один stat()), перечитывает
    JSON только если mtime изменился с прошлой проверки.
    """

    def __init__(self, path: str = OVERRIDES_FILE) -> None:
        self.__path = path
        self.__mtime: float = 0.0
        self.__data: dict = {"global_signal_only": None, "tickers": {}}

    def maybe_reload(self) -> bool:
        try:
            mtime = os.path.getmtime(self.__path)
        except OSError:
            return False
        if mtime == self.__mtime:
            return False
        self.__mtime = mtime
        self.__data = load_overrides(self.__path)
        logger.info(f"runtime_overrides: перечитан {self.__path}")
        return True

    def is_ticker_disabled(self, ticker: str) -> bool:
        t = self.__data["tickers"].get(ticker.upper())
        return bool(t and t.get("enabled") is False)

    def signal_only_for(self, ticker: str, default: bool) -> bool:
        """Эффективный signal_only для тикера: global override > per-ticker override > дефолт стратегии."""
        if self.__data.get("global_signal_only") is True:
            return True
        t = self.__data["tickers"].get(ticker.upper())
        if t and t.get("signal_only") is not None:
            return bool(t["signal_only"])
        if self.__data.get("global_signal_only") is False:
            return False
        return default

    def partial_tp_enabled(self, default: bool) -> bool:
        v = self.__data.get("partial_tp_enabled")
        return default if v is None else bool(v)

    def adaptive_exit_enabled(self, default: bool) -> bool:
        v = self.__data.get("adaptive_exit_enabled")
        return default if v is None else bool(v)

    def orderbook_enabled(self, default: bool) -> bool:
        v = self.__data.get("orderbook_enabled")
        return default if v is None else bool(v)

    def is_paused(self) -> bool:
        return bool(self.__data.get("paused", False))

    def pop_close_requests(self) -> set[str]:
        """Возвращает набор тикеров/ALL и очищает список в файле."""
        reqs = self.__data.get("close_requests", [])
        if not reqs:
            return set()
        result = {r.upper() for r in reqs}
        self.__data["close_requests"] = []
        save_overrides(self.__data, self.__path)
        return result

    def pop_adopt_requests(self) -> list:
        """Возвращает список AdoptRequest-словарей и очищает из файла."""
        reqs = self.__data.get("adopt_requests", [])
        if not reqs:
            return []
        self.__data["adopt_requests"] = []
        save_overrides(self.__data, self.__path)
        return reqs

    def take_stop_for(self, ticker: str) -> dict[str, Decimal]:
        """Только заданные (не null) поля — для set_take_stop_overrides(**kwargs)."""
        t = self.__data["tickers"].get(ticker.upper(), {})
        result = {}
        for field in _DECIMAL_FIELDS:
            v = t.get(field)
            if v is not None:
                result[field] = Decimal(str(v))
        return result
