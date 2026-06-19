"""
db_api_client.py — тонкий HTTP-клиент к общей базе расчётов композита
(cf-collector/worker.js, Cloudflare D1). Используется и collector_worker.py
(пишет суточный снэпшот по всему рынку), и trading/trader.py (читает перед
тем, как решать, торговать ли новый тикер из MEGA-ALERTS).
"""
import json
import logging
import urllib.error
import urllib.request

__all__ = ("DbApiClient",)

logger = logging.getLogger(__name__)


class DbApiClient:
    def __init__(self, base_url: str, api_key: str):
        self.__base_url = base_url.rstrip("/") if base_url else ""
        self.__api_key = api_key

    @property
    def configured(self) -> bool:
        return bool(self.__base_url)

    def __request(self, method: str, path: str, body: dict | None = None, timeout: int = 15) -> dict | None:
        if not self.__base_url:
            return None
        url = f"{self.__base_url}/{path}"
        data = json.dumps(body).encode("utf-8") if body is not None else None
        req = urllib.request.Request(url, data=data, method=method, headers={
            "X-API-Key": self.__api_key,
            "Content-Type": "application/json",
            # Без явного User-Agent urllib шлёт "Python-urllib/x.y", который
            # Cloudflare иногда блокирует на уровне edge (403 раньше, чем
            # запрос дойдёт до кода воркера) — подделываем под браузер.
            "User-Agent": "Mozilla/5.0 (compatible; invest-bot-collector/1.0)",
        })
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return json.load(resp)
        except urllib.error.HTTPError as ex:
            body = ex.read().decode("utf-8", errors="replace")
            logger.warning(f"DB API {method} {path} упал: HTTP {ex.code} — {body[:300]}")
            return None
        except urllib.error.URLError as ex:
            logger.warning(f"DB API {method} {path} упал: {ex}")
            return None
        except TimeoutError:
            # urlopen на таймауте чтения ответа кидает голый TimeoutError, не
            # URLError — без этого except один медленный батч (например,
            # push_candles на большом чанке) валит весь вызывающий код.
            logger.warning(f"DB API {method} {path} упал: таймаут ({timeout}с)")
            return None
        except ConnectionError as ex:
            # Cloudflare иногда рвёт соединение без ответа (RemoteDisconnected
            # и т.п.) — это ConnectionError/OSError, тоже не URLError/HTTPError,
            # тоже валило вызывающий код без этого except.
            logger.warning(f"DB API {method} {path} упал: соединение разорвано — {ex}")
            return None

    def push_snapshot(self, ticker: str, **fields) -> None:
        self.__request("POST", "snapshot", {"ticker": ticker, **fields})

    def latest(self, ticker: str) -> dict | None:
        result = self.__request("GET", f"latest/{ticker}")
        return result.get("latest") if result else None

    def history(self, ticker: str, days: int = 90) -> list[dict]:
        result = self.__request("GET", f"history/{ticker}?days={days}")
        return result.get("history", []) if result else []

    def push_trade(self, ticker: str, **fields) -> None:
        self.__request("POST", "trade", {"ticker": ticker, **fields})

    def get_trades(self, ticker: str, days: int = 60) -> list[dict]:
        result = self.__request("GET", f"trades/{ticker}?days={days}")
        return result.get("trades", []) if result else []

    def push_candles(self, ticker: str, candles: list[dict]) -> None:
        """
        candles: [{time (ISO), open, high, low, close, volume}]. Бьём на чанки —
        2000 строк в одном batch-insert D1 не укладываются в 15с (один день
        5-минутных свечей по ликвидному тикеру — это уже ~100 строк, чанк
        в 300 покрывает несколько дней истории за раз и не таймаутит).
        """
        chunk = 300
        for i in range(0, len(candles), chunk):
            self.__request("POST", "candles", {"ticker": ticker, "candles": candles[i:i + chunk]}, timeout=30)

    def get_candles(self, ticker: str, date_from: str, date_to: str) -> list[dict]:
        result = self.__request("GET", f"candles/{ticker}?from={date_from}&to={date_to}")
        return result.get("candles", []) if result else []
