"""
tradestats.py — фоновый сервис микроструктурных данных (tradestats/obstats/
orderstats) для методов BS_PRESSURE, AGGRESSOR_FLOW, LARGE_IMPACT, OB_IMBALANCE,
CANCEL_SIGNAL и ts-вариантов VWAP_SIGNAL/VOL_MOMENTUM.

В отличие от oi_layers.py (FutOI, границы :00/:05, раз в 5 минут) — это
внутридневные данные MOEX AlgoPack (datashop/algopack/eq/{tradestats,obstats,
orderstats}), публикуются чаще, без фиксированной границы. Поллим раз в
POLL_SECONDS — компромисс между свежестью и не "постоянными запросами".

Порт m_BS_PRESSURE / m_AGGRESSOR_FLOW / m_LARGE_IMPACT / m_VWAP_SIGNAL /
m_VOL_MOMENTUM / m_OB_IMBALANCE / m_CANCEL_SIGNAL из oi-signal-v10.html.
normScore — общий нормализатор по перцентилям (p10/p50/p90) истории.
"""
import asyncio
import json
import logging
import math
import os
import statistics
import urllib.parse
import urllib.request
from datetime import date, datetime

from market_time import today_msk
import ssl_setup

__all__ = ("TradeStatsService",)

logger = logging.getLogger(__name__)

POLL_SECONDS = 60      # внутридневные данные обновляются часто, но не дёргаем чаще раза в минуту
ROLLING_WINDOW = 30     # баров в истории на тикер — достаточно для перцентилей (нужно >=5)
RECENT_N = 5             # сколько последних баров усредняем для скоров (m_BS_PRESSURE и т.п.)

BASE_URL = "https://apim.moex.com/iss/datashop/algopack/eq"


def _load_moex_token() -> str | None:
    """env MOEX_TOKEN в приоритете, иначе settings.ini [MOEX] TOKEN=. Читается
    заново на каждый вызов (не кэшируется на импорте) — правку токена с
    дашборда подхватывает следующий цикл поллинга (до POLL_SECONDS), без
    перезапуска процесса бота."""
    token = os.getenv("MOEX_TOKEN")
    if token:
        return token
    try:
        from configparser import ConfigParser
        ini = ConfigParser()
        ini.read("settings.ini", encoding="utf-8")
        return ini.get("MOEX", "TOKEN", fallback=None) or None
    except Exception:
        return None


def _normscore(value: float, series: list[float], scale: float = 2.5) -> float:
    """Порт normScore: tanh((value - p50) / (p90 - p10 + eps) * scale). Нужно >=5 баров истории."""
    if len(series) < 5:
        return 0.0
    s = sorted(series)
    p10 = s[max(0, int(len(s) * 0.10))]
    p50 = statistics.median(s)
    p90 = s[min(len(s) - 1, int(len(s) * 0.90))]
    denom = (p90 - p10) or 1e-9
    return math.tanh((value - p50) / denom * scale)


def _avg(rows: list[dict], field: str, n: int = RECENT_N) -> float:
    vals = [float(r.get(field) or 0) for r in rows[-n:]]
    return sum(vals) / len(vals) if vals else 0.0


def _fetch_stats(metric: str, ticker: str) -> list[dict]:
    """Синхронный HTTP-запрос — звать только через asyncio.to_thread."""
    token = _load_moex_token()
    if not token:
        return []
    today = today_msk().isoformat().replace("-", "")
    params = {"secid": ticker, "iss.meta": "off", "limit": 1000, "from": today, "till": today}
    url = f"{BASE_URL}/{metric}.json?{urllib.parse.urlencode(params)}"
    req = urllib.request.Request(url, headers={
        "Authorization": f"Bearer {token}", "Accept": "application/json",
        # Без явного User-Agent urllib шлёт "Python-urllib/x.y" — Cloudflare/edge
        # иногда блокирует это 403 раньше, чем запрос дойдёт до MOEX API.
        "User-Agent": "Mozilla/5.0 (compatible; invest-bot/1.0)",
    })
    try:
        with urllib.request.urlopen(req, timeout=15, context=ssl_setup.ssl_context()) as resp:
            data = json.load(resp)
    except Exception as e:
        logger.warning(f"tradestats: {metric} запрос {ticker} упал: {e}")
        return []
    block = data.get(metric)
    if not block or not block.get("columns") or not block.get("data"):
        return []
    cols = block["columns"]
    rows = [dict(zip(cols, row)) for row in block["data"]]
    rows = [r for r in rows if r.get("secid") == ticker]
    rows.sort(key=lambda r: (str(r.get("tradedate") or ""), str(r.get("tradetime") or "")))
    return rows


# ── Скоры (чистые функции от истории баров) ────────────────────────────────

def _score_bs_pressure(hist: list[dict]) -> float:
    vol_b_series = [float(r.get("vol_b") or 0) for r in hist]
    vol_s_series = [float(r.get("vol_s") or 0) for r in hist]
    vol_b, vol_s = _avg(hist, "vol_b"), _avg(hist, "vol_s")
    if len(hist) >= 5:
        z_b = math.tanh(_normscore(vol_b, vol_b_series, 1.0) * 2.0)
        z_s = math.tanh(_normscore(vol_s, vol_s_series, 1.0) * 2.0)
        return max(-1.0, min(1.0, math.tanh(z_b - z_s)))
    total = vol_b + vol_s
    if total <= 0:
        return 0.0
    return max(-1.0, min(1.0, math.tanh((vol_b - vol_s) / total * 4)))


def _score_aggressor_flow(hist: list[dict]) -> float:
    val_b, val_s = _avg(hist, "val_b"), _avg(hist, "val_s")
    trd_b, trd_s = _avg(hist, "trades_b"), _avg(hist, "trades_s")
    val_b_s = [float(r.get("val_b") or 0) for r in hist]
    val_s_s = [float(r.get("val_s") or 0) for r in hist]
    trd_b_s = [float(r.get("trades_b") or 0) for r in hist]
    trd_s_s = [float(r.get("trades_s") or 0) for r in hist]
    if len(hist) >= 5:
        z_val = _normscore(val_b, val_b_s, 1.5) - _normscore(val_s, val_s_s, 1.5)
        z_trd = _normscore(trd_b, trd_b_s, 1.0) - _normscore(trd_s, trd_s_s, 1.0)
        return max(-1.0, min(1.0, math.tanh(z_val * 0.7 + z_trd * 0.3)))
    val_total = (val_b + val_s) or 1.0
    trd_total = (trd_b + trd_s) or 1.0
    return max(-1.0, min(1.0, math.tanh((val_b - val_s) / val_total * 3 + (trd_b - trd_s) / trd_total * 2)))


def _score_large_impact(hist: list[dict]) -> float:
    vols = [float(r.get("vol") or 0) for r in hist]
    if not vols:
        return 0.0
    s = sorted(vols)
    threshold = s[min(len(s) - 1, int(len(s) * 0.75))]
    recent = hist[-RECENT_N:]
    large_b = [float(r.get("vol_b") or 0) for r in recent if float(r.get("vol_b") or 0) > threshold]
    large_s = [float(r.get("vol_s") or 0) for r in recent if float(r.get("vol_s") or 0) > threshold]
    large_b_avg = sum(large_b) / len(large_b) if large_b else 0.0
    large_s_avg = sum(large_s) / len(large_s) if large_s else 0.0
    total_large = large_b_avg + large_s_avg
    if total_large < 1:
        return 0.0
    return max(-1.0, min(1.0, math.tanh((large_b_avg - large_s_avg) / total_large * 3.5)))


def _vwap_atr_pct(hist: list[dict]) -> float:
    closes = [float(r.get("pr_close") or r.get("pr_cl") or 0) for r in hist if (r.get("pr_close") or r.get("pr_cl"))]
    if len(closes) < 3:
        return 0.005
    mean = sum(closes) / len(closes)
    if mean <= 0:
        return 0.005
    sd = statistics.pstdev(closes)
    return max(0.005, sd / mean)


def _score_vwap_signal(hist: list[dict]) -> float:
    if len(hist) < 3:
        return 0.0
    last = hist[-1]
    cur_price = float(last.get("pr_close") or last.get("pr_cl") or 0)
    vwap = float(last.get("pr_vwap") or 0)
    if vwap <= 0:
        vols = [float(r.get("vol") or 0) for r in hist]
        closes = [float(r.get("pr_close") or r.get("pr_cl") or 0) for r in hist]
        total_vol = sum(vols) or 1.0
        vwap = sum(c * v for c, v in zip(closes, vols)) / total_vol
    if vwap <= 0 or cur_price <= 0:
        return 0.0
    scale = vwap * _vwap_atr_pct(hist)
    z = (cur_price - vwap) / (scale or 1e-9)
    return max(-1.0, min(1.0, math.tanh(z * 1.5)))


def _score_vol_momentum_ts(hist: list[dict]) -> float:
    if len(hist) < 5:
        return 0.0
    vols = [float(r.get("vol") or 0) for r in hist]
    cur_vol = sum(vols[-3:]) / min(3, len(vols))
    if len(hist) >= 5:
        z_vol = _normscore(cur_vol, vols, 2.0)
    else:
        mu = sum(vols) / len(vols)
        sd = statistics.pstdev(vols) or (mu * 0.1) or 1.0
        z_vol = (cur_vol - mu) / sd
    closes = [float(r.get("pr_close") or r.get("pr_cl") or 0) for r in hist]
    direction = 0.0
    if len(closes) >= 2 and closes[-2] != 0:
        diff = closes[-1] - closes[-2]
        direction = 1.0 if diff > 0 else (-1.0 if diff < 0 else 0.0)
    return max(-1.0, min(1.0, math.tanh(z_vol * direction * 1.5)))


def _score_ob_imbalance(hist: list[dict]) -> float:
    imb = _avg(hist, "imbalance_vol_bbo")
    imb_series = [float(r.get("imbalance_vol_bbo") or 0) for r in hist]
    if len(hist) >= 5:
        score = _normscore(imb, imb_series, 2.5)
    else:
        score = math.tanh(imb * 3)
    return max(-1.0, min(1.0, score))


def _score_cancel_signal(hist: list[dict]) -> float:
    can_b, can_s = _avg(hist, "cancel_orders_b"), _avg(hist, "cancel_orders_s")
    can_b_s = [float(r.get("cancel_orders_b") or 0) for r in hist]
    can_s_s = [float(r.get("cancel_orders_s") or 0) for r in hist]
    total = can_b + can_s
    if len(hist) >= 5 and total > 0:
        z_b = _normscore(can_b, can_b_s, 1.5)
        z_s = _normscore(can_s, can_s_s, 1.5)
        return max(-1.0, min(1.0, math.tanh(z_s - z_b)))
    if total <= 0:
        return 0.0
    return max(-1.0, min(1.0, math.tanh((can_s - can_b) / total * 3)))


SCORE_FUNCS = {
    "BS_PRESSURE_TS": ("tradestats", _score_bs_pressure),
    "AGGRESSOR_FLOW": ("tradestats", _score_aggressor_flow),
    "LARGE_IMPACT": ("tradestats", _score_large_impact),
    "VWAP_SIGNAL_TS": ("tradestats", _score_vwap_signal),
    "VOL_MOMENTUM_TS": ("tradestats", _score_vol_momentum_ts),
    "OB_IMBALANCE": ("obstats", _score_ob_imbalance),
    "CANCEL_SIGNAL": ("orderstats", _score_cancel_signal),
}


class TradeStatsService:
    """
    Фоновый поллер микроструктурных данных. Запускается на торговый день
    (asyncio.create_task), раз в POLL_SECONDS обновляет внутридневную историю
    по отслеживаемым тикерам и пересчитывает скоры 7 методов в памяти.
    Без MOEX_TOKEN все методы молчат (score=0) — без подписки AlgoPack нет
    смысла даже пытаться.
    """

    def __init__(self):
        self._history: dict[str, dict[str, list[dict]]] = {}
        self._scores: dict[str, dict[str, float]] = {}

    async def poll_loop(self, tickers: list[str]) -> None:
        """Бесконечный цикл — отменяется снаружи (task.cancel()) в конце торгового дня."""
        if not _load_moex_token():
            logger.warning("tradestats: MOEX_TOKEN не задан — микроструктурные методы недоступны")
            return
        try:
            while True:
                await asyncio.sleep(POLL_SECONDS)
                await self._poll_once(tickers)
        except asyncio.CancelledError:
            logger.debug("tradestats: poll_loop остановлен")
            raise

    async def _poll_once(self, tickers: list[str]) -> None:
        for ticker in tickers:
            hist = self._history.setdefault(ticker, {"tradestats": [], "obstats": [], "orderstats": []})
            for metric in ("tradestats", "obstats", "orderstats"):
                rows = await asyncio.to_thread(_fetch_stats, metric, ticker)
                if rows:
                    hist[metric] = rows[-ROLLING_WINDOW:]

            scores = {}
            for name, (metric, fn) in SCORE_FUNCS.items():
                scores[name] = fn(hist[metric])
            self._scores[ticker] = scores

    def score(self, ticker: str, method: str) -> float:
        """method — один из ключей SCORE_FUNCS. 0.0 если данных нет."""
        return self._scores.get(ticker, {}).get(method, 0.0)
