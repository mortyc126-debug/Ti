"""
mega_alerts.py — фоновый сервис MOEX MEGA-ALERTS: готовая аномалия-детекция
по ВСЕМ инструментам рынка за день (нужна подписка на datashop/algopack
alerts.json, см. oi-signal-v10.html::fetchMegaAlerts/loadMegaAlerts).

В отличие от oi_layers.py/tradestats.py (поллят только сконфигурированные
тикеры), alerts.json отдаёт срез по ВСЕМУ рынку одним запросом — это и есть
"база данных по всем тикерам", которую нужно обновлять минимум раз в день.
Бот достраивает детальный композит (29 методов) только по тикерам из
settings.ini, а mega_alerts даёт более широкий, но грубый слой: какие ещё
тикеры на рынке сегодня показали аномальные объёмы/движения — для ручного
просмотра и как наводка на расширение списка отслеживаемых тикеров.
"""
import asyncio
import json
import logging
import os
import urllib.request
from datetime import datetime, timedelta, timezone

__all__ = ("MegaAlertsService",)

logger = logging.getLogger(__name__)

MARKETS = ("eq", "fo")
HISTORY_FILE = "data/mega_alerts.json"
DAYS_KEPT = 14
MOEX_TOKEN = os.getenv("MOEX_TOKEN")
ALERTS_URL_TMPL = "https://apim.moex.com/iss/datashop/algopack/{market}/alerts.json"


def _fetch_alerts(market: str, trade_date: str) -> list[dict]:
    """Синхронный (блокирующий) HTTP-запрос — звать только через asyncio.to_thread."""
    if not MOEX_TOKEN:
        logger.warning("mega_alerts: MOEX_TOKEN не задан — alerts недоступны")
        return []
    url = f"{ALERTS_URL_TMPL.format(market=market)}?date={trade_date}&iss.meta=off"
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {MOEX_TOKEN}", "Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            data = json.load(resp)
    except Exception as e:
        logger.warning(f"mega_alerts: запрос {market}/{trade_date} упал: {e}")
        return []
    block = data.get("alerts")
    if not block or not block.get("columns") or not block.get("data"):
        return []
    cols = block["columns"]
    return [dict(zip(cols, row)) for row in block["data"]]


def _secid(row: dict) -> str:
    return str(row.get("secid") or row.get("SECID") or "").upper()


class MegaAlertsService:
    """
    Раз в сутки тянет alerts.json по обоим рынкам (eq, fo) и хранит срез за
    последние DAYS_KEPT дней в data/mega_alerts.json. tickers_today() даёт
    плоский список тикеров, отмеченных аномалией сегодня — для расширения
    зоны внимания бота поверх жёстко сконфигурированных в settings.ini.
    """

    def __init__(self):
        self._by_date: dict[str, dict[str, list[dict]]] = {}
        self._load()

    def _load(self):
        if not os.path.exists(HISTORY_FILE):
            return
        try:
            with open(HISTORY_FILE, encoding="utf-8") as f:
                self._by_date = json.load(f)
        except (json.JSONDecodeError, OSError) as e:
            logger.warning(f"mega_alerts: не удалось загрузить историю: {e}")

    def _save(self):
        os.makedirs("data", exist_ok=True)
        try:
            tmp = HISTORY_FILE + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(self._by_date, f, ensure_ascii=False)
            os.replace(tmp, HISTORY_FILE)
        except OSError as e:
            logger.warning(f"mega_alerts: не удалось сохранить историю: {e}")

    async def daily_loop(self) -> None:
        """Бесконечный цикл: обновление раз в сутки + сразу при старте."""
        try:
            while True:
                await self.refresh_once()
                await asyncio.sleep(24 * 3600)
        except asyncio.CancelledError:
            logger.debug("mega_alerts: daily_loop остановлен")
            raise

    async def refresh_once(self) -> None:
        trade_date = datetime.now(timezone.utc).date().isoformat()
        by_market: dict[str, list[dict]] = {}
        for market in MARKETS:
            rows = await asyncio.to_thread(_fetch_alerts, market, trade_date)
            by_market[market] = rows
            logger.info(f"mega_alerts: {market}/{trade_date} — {len(rows)} аномалий")
        self._by_date[trade_date] = by_market
        cutoff = (datetime.now(timezone.utc).date() - timedelta(days=DAYS_KEPT)).isoformat()
        self._by_date = {d: v for d, v in self._by_date.items() if d >= cutoff}
        self._save()

    def tickers_today(self, market: str | None = None) -> list[str]:
        """Список тикеров с аномалией за последнюю загруженную дату (без дублей, в порядке появления)."""
        if not self._by_date:
            return []
        latest = max(self._by_date)
        markets = (market,) if market else MARKETS
        seen, out = set(), []
        for m in markets:
            for row in self._by_date[latest].get(m, []):
                sid = _secid(row)
                if sid and sid not in seen:
                    seen.add(sid)
                    out.append(sid)
        return out

    def alerts_for(self, ticker: str, market: str | None = None) -> list[dict]:
        """Все алёрты по тикеру за последнюю загруженную дату."""
        if not self._by_date:
            return []
        latest = max(self._by_date)
        markets = (market,) if market else MARKETS
        out = []
        for m in markets:
            out.extend(row for row in self._by_date[latest].get(m, []) if _secid(row) == ticker.upper())
        return out

    def hits_last_days(self, days: int = 7, market: str | None = None) -> dict[str, int]:
        """Сколько раз каждый secid отметился аномалией за последние days дней
        загруженной истории (не календарных — сколько реально накоплено в
        data/mega_alerts.json, максимум DAYS_KEPT). Используется как бонус
        «востребованности» при ранжировании топ-N (ticker_universe.py) —
        грубее объёма, но ловит то, что появилось внезапно."""
        counts: dict[str, int] = {}
        if not self._by_date:
            return counts
        markets = (market,) if market else MARKETS
        for date in sorted(self._by_date, reverse=True)[:days]:
            for m in markets:
                for row in self._by_date[date].get(m, []):
                    sid = _secid(row)
                    if sid:
                        counts[sid] = counts.get(sid, 0) + 1
        return counts
