"""
oi_layers.py — фоновый сервис слоёв открытого интереса (юр/физ) для squeeze-сигнала.

ОИ на MOEX обновляется раз в 5 минут, на границах :00/:05 (так заявлено на
сайте MOEX) — поэтому поллим раз в 5 минут, выровненные на эти границы, а не
на каждой свече и не "постоянными запросами". Разбивка юр/физ (FutOI) доступна
только через REST analyticalproducts/futoi (AlgoPack, нужен MOEX_TOKEN) — через
стрим Т-Инвестиции (MarketDataStreamService, который даёт только OHLCV-свечи)
эти данные не идут, поэтому полностью без сетевых запросов не обойтись. Но они
редкие, фоновые и не блокируют торговый цикл свечей.

Слои = декомпозиция дневного ΔOI на "слои" {date, price, size} — порт
_buildOiLayers/_buildOiLayerSeries из oi-signal-v10.html. squeeze_score —
доля СВЕЖИХ (<= FRESH_DAYS дней) и КРУПНЫХ (>= SIZABLE доли стороны) слоёв,
которые сейчас в минусе по цене. Это про "кто-то быстро и крупно набрал
позицию, и это вызвало движение" — а не статичный порог вида "физики держат
65% шорта" (это была заглушка из чужой спеки, в реальный метод не переносилась).
"""
import asyncio
import json
import logging
import os
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import date, datetime, timedelta

__all__ = ("OiLayersService",)

logger = logging.getLogger(__name__)

POLL_MINUTES = 5     # ОИ обновляется раз в 5 минут на границах :00/:05
FRESH_DAYS = 5        # слой младше — "свежий"
SIZABLE = 0.15        # доля стороны, начиная с которой слой "крупный"
HISTORY_FILE = "data/oi_daily.json"

# Тикер акции -> тикер фьючерса для FutOI. Только сопоставления, сверенные
# с реальным ответом MOEX (см. cf-worker.js FUTOI_FULL_MAP). Для тикеров не
# из списка squeeze не считается (None) — не угадываем тикер.
FUTOI_MAP = {
    "SBER": "SBERF", "GAZP": "GAZPF", "LKOH": "LKOHF", "GMKN": "GMKNF",
    "NVTK": "NVTKF", "ROSN": "ROSNF", "TATN": "TATNF", "MGNT": "MGNTF",
}

MOEX_TOKEN = os.getenv("MOEX_TOKEN")
FUTOI_URL = "https://apim.moex.com/iss/analyticalproducts/futoi/securities.json"


@dataclass
class OiLayer:
    layer_date: str
    price: float
    size: float

    def age_days(self, last_date: str) -> int:
        try:
            return (date.fromisoformat(last_date) - date.fromisoformat(self.layer_date)).days
        except ValueError:
            return 0

    def pnl_pct(self, cur_price: float, direction: str) -> float:
        if self.price <= 0:
            return 0.0
        diff = (cur_price - self.price) / self.price
        return diff if direction == "long" else -diff


def _build_layers(rows: list[dict]) -> dict:
    """
    rows — снэпшоты по возрастанию tradedate: {tradedate, price, long, short}
    (long/short уже сложены yur+fiz). Наращивание ΔOI кладёт новый слой,
    схлопывание режет существующие слои pro-rata (порядок закрытия позиций
    по агрегату FutOI не известен).
    """
    layers = {"long": [], "short": []}
    prev = {"long": 0.0, "short": 0.0}
    for r in rows:
        for side in ("long", "short"):
            qty = float(r.get(side) or 0)
            delta = qty - prev[side]
            if delta > 1e-9:
                layers[side].append(OiLayer(layer_date=r["tradedate"], price=float(r.get("price") or 0), size=delta))
            elif delta < -1e-9:
                shrink = -delta
                total = sum(l.size for l in layers[side]) or 1.0
                frac = min(1.0, shrink / total)
                for l in layers[side]:
                    l.size *= (1 - frac)
                layers[side] = [l for l in layers[side] if l.size > 1e-6]
            prev[side] = qty
    return layers


def _squeeze_from_layers(layers: dict, last_date: str, cur_price: float) -> dict:
    """
    squeeze_up   — шорты недавно крупно нарастили и сейчас в минусе
                   (риск шорт-сквиза — цену вынесет вверх)
    squeeze_down — лонги недавно крупно нарастили и сейчас в минусе
                   (риск лонг-сквиза — цену вынесет вниз)
    """
    out = {"squeeze_up": 0.0, "squeeze_down": 0.0}
    for side, key in (("short", "squeeze_up"), ("long", "squeeze_down")):
        total = sum(l.size for l in layers.get(side, []))
        if total <= 0:
            continue
        risky = 0.0
        for l in layers[side]:
            if l.age_days(last_date) > FRESH_DAYS:
                continue
            if l.size / total < SIZABLE:
                continue
            if l.pnl_pct(cur_price, side) < 0:
                risky += l.size
        out[key] = risky / total
    return out


def _fetch_futoi_snapshot(sym: str) -> dict | None:
    """Синхронный (блокирующий) HTTP-запрос — звать только через asyncio.to_thread."""
    if not MOEX_TOKEN:
        logger.warning("oi_layers: MOEX_TOKEN не задан — squeeze-сигнал недоступен")
        return None
    url = f"{FUTOI_URL}?{urllib.parse.urlencode({'ticker': sym, 'iss.meta': 'off', 'limit': 1000})}"
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {MOEX_TOKEN}", "Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.load(resp)
    except Exception as e:
        logger.warning(f"oi_layers: futoi запрос {sym} упал: {e}")
        return None

    block = data.get("futoi")
    if not block or not block.get("columns") or not block.get("data"):
        return None
    cols = block["columns"]
    rows = [dict(zip(cols, row)) for row in block["data"]]
    rows = [r for r in rows if r.get("ticker") == sym]
    if not rows:
        return None

    by_group = {}
    for r in rows:
        g = str(r.get("clgroup") or "").upper()
        if g not in ("YUR", "FIZ"):
            continue
        if g not in by_group or str(r.get("tradetime") or "") > str(by_group[g].get("tradetime") or ""):
            by_group[g] = r

    tradedate = (by_group.get("YUR") or by_group.get("FIZ") or {}).get("tradedate")
    if not tradedate:
        return None
    long_qty = float(by_group.get("YUR", {}).get("pos_long") or 0) + float(by_group.get("FIZ", {}).get("pos_long") or 0)
    short_qty = abs(float(by_group.get("YUR", {}).get("pos_short") or 0)) + abs(float(by_group.get("FIZ", {}).get("pos_short") or 0))
    return {"tradedate": tradedate, "long": long_qty, "short": short_qty}


class OiLayersService:
    """
    Фоновый поллер ОИ. Запускается на торговый день (asyncio.create_task),
    раз в POLL_MINUTES (выровнено на :00/:05) обновляет дневную историю по
    отслеживаемым тикерам и пересчитывает squeeze-score в памяти.
    """

    def __init__(self, price_getter=None):
        """price_getter(stock_ticker) -> float | None — последняя цена акции."""
        self.price_getter = price_getter or (lambda _t: None)
        self._history: dict[str, list[dict]] = {}
        self._scores: dict[str, dict] = {}
        self._load()

    def _load(self):
        if not os.path.exists(HISTORY_FILE):
            return
        try:
            with open(HISTORY_FILE, encoding="utf-8") as f:
                self._history = json.load(f)
        except (json.JSONDecodeError, OSError) as e:
            logger.warning(f"oi_layers: не удалось загрузить историю: {e}")

    def _save(self):
        os.makedirs("data", exist_ok=True)
        try:
            tmp = HISTORY_FILE + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(self._history, f, ensure_ascii=False)
            os.replace(tmp, HISTORY_FILE)
        except OSError as e:
            logger.warning(f"oi_layers: не удалось сохранить историю: {e}")

    async def poll_loop(self, tickers: list[str]) -> None:
        """Бесконечный цикл — отменяется снаружи (task.cancel()) в конце торгового дня."""
        tracked = [t for t in tickers if t in FUTOI_MAP]
        skipped = [t for t in tickers if t not in FUTOI_MAP]
        if skipped:
            logger.info(f"oi_layers: нет проверенного FutOI-тикера для {skipped} — squeeze не считается")
        if not tracked:
            return
        try:
            while True:
                await self._sleep_to_next_boundary()
                await self._poll_once(tracked)
        except asyncio.CancelledError:
            logger.debug("oi_layers: poll_loop остановлен")
            raise

    async def _poll_once(self, tickers: list[str]) -> None:
        for ticker in tickers:
            sym = FUTOI_MAP[ticker]
            snap = await asyncio.to_thread(_fetch_futoi_snapshot, sym)
            if not snap:
                continue
            hist = self._history.setdefault(ticker, [])
            if hist and hist[-1]["tradedate"] == snap["tradedate"]:
                hist[-1] = snap
            else:
                hist.append(snap)
            hist[:] = hist[-120:]  # храним ~120 последних дней, достаточно для слоёв

            price = self.price_getter(ticker)
            if price:
                layers = _build_layers(hist)
                self._scores[ticker] = _squeeze_from_layers(layers, snap["tradedate"], price)
        self._save()

    @staticmethod
    async def _sleep_to_next_boundary() -> None:
        now = datetime.utcnow()
        next_minute = (now.minute // POLL_MINUTES + 1) * POLL_MINUTES
        next_time = now.replace(second=0, microsecond=0) + timedelta(minutes=next_minute - now.minute)
        next_time += timedelta(seconds=20)  # запас, чтобы MOEX успел опубликовать снэпшот
        wait = (next_time - datetime.utcnow()).total_seconds()
        if wait > 0:
            await asyncio.sleep(wait)

    def squeeze_score(self, ticker: str, direction: str) -> float:
        """
        direction: "long" | "short" — направление ТЕКУЩЕЙ/предполагаемой позиции.
        Возвращает риск сквиза для этого направления: 0.0 если данных нет.
        """
        scores = self._scores.get(ticker)
        if not scores:
            return 0.0
        # короткая позиция боится squeeze_up (шорты выносит вверх), длинная — squeeze_down
        return scores["squeeze_up"] if direction == "short" else scores["squeeze_down"]

    def is_squeeze_risk(self, ticker: str, direction: str, threshold: float = 0.5) -> bool:
        return self.squeeze_score(ticker, direction) >= threshold
