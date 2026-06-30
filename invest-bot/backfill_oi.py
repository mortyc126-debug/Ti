"""
backfill_oi.py — Загрузка исторического FutOI из MOEX AlgoPack.

AlgoPack отдаёт FutOI только на конкретную дату (один запрос = один день).
Скрипт перебирает торговые дни за последние N месяцев, на каждый делает
отдельный запрос и сохраняет результат в data/oi_daily.json.

Запуск:
    python backfill_oi.py            # 12 месяцев для всех тикеров
    python backfill_oi.py --months 6
    python backfill_oi.py --tickers SBER,GAZP --months 3
"""

import argparse
import json
import logging
import os
import time
import urllib.parse
import urllib.request
from configparser import ConfigParser
from datetime import date, timedelta

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger(__name__)

FUTOI_URL = "https://apim.moex.com/iss/analyticalproducts/futoi/securities.json"
HISTORY_FILE = "data/oi_daily.json"
PAUSE_SEC = 0.4   # пауза между запросами

FUTOI_MAP = {
    "SBER": "SBERF", "GAZP": "GAZPF", "LKOH": "LKOHF", "GMKN": "GMKNF",
    "NVTK": "NVTKF", "ROSN": "ROSNF", "TATN": "TATNF", "MGNT": "MGNTF",
}


def _get_token() -> str | None:
    token = os.getenv("MOEX_TOKEN")
    if token:
        return token
    ini = ConfigParser()
    ini.read("settings.ini", encoding="utf-8")
    return ini.get("MOEX", "TOKEN", fallback=None) or None


def _trading_days(date_from: date, date_till: date) -> list[date]:
    """Все будние дни в диапазоне (пн–пт). Выходные MOEX не публикует."""
    days = []
    cur = date_from
    while cur <= date_till:
        if cur.weekday() < 5:   # пн=0 … пт=4
            days.append(cur)
        cur += timedelta(days=1)
    return days


def _fetch_day(sym: str, token: str, trade_date: str) -> dict | None:
    """Запрос FutOI на конкретную дату. Возвращает агрегированную запись или None."""
    params = {
        "ticker": sym,
        "date": trade_date,
        "iss.meta": "off",
        "limit": 100,
    }
    url = f"{FUTOI_URL}?{urllib.parse.urlencode(params)}"
    req = urllib.request.Request(
        url,
        headers={"Authorization": f"Bearer {token}", "Accept": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            data = json.load(resp)
    except Exception as e:
        logger.debug(f"  {sym} {trade_date}: ошибка запроса: {e}")
        return None

    block = data.get("futoi")
    if not block or not block.get("columns") or not block.get("data"):
        return None
    cols = block["columns"]
    rows = [dict(zip(cols, row)) for row in block["data"]]
    rows = [r for r in rows if str(r.get("ticker") or "") == sym]
    if not rows:
        return None

    # Группируем YUR и FIZ — берём последнюю запись каждой группы по времени
    by_group: dict[str, dict] = {}
    for r in rows:
        g = str(r.get("clgroup") or "").upper()
        if g not in ("YUR", "FIZ"):
            continue
        tt = str(r.get("tradetime") or r.get("tradedate") or "")
        if g not in by_group or tt > str(by_group[g].get("tradetime") or ""):
            by_group[g] = r

    if not by_group:
        return None

    yur = by_group.get("YUR", {})
    fiz = by_group.get("FIZ", {})
    yur_long  = float(yur.get("pos_long")  or 0)
    yur_short = abs(float(yur.get("pos_short") or 0))
    fiz_long  = float(fiz.get("pos_long")  or 0)
    fiz_short = abs(float(fiz.get("pos_short") or 0))

    return {
        "tradedate": trade_date,
        "long":      yur_long + fiz_long,
        "short":     yur_short + fiz_short,
        "yur_long":  yur_long,
        "yur_short": yur_short,
        "fiz_long":  fiz_long,
        "fiz_short": fiz_short,
    }


def _load_existing() -> dict:
    if not os.path.exists(HISTORY_FILE):
        return {}
    try:
        with open(HISTORY_FILE, encoding="utf-8") as f:
            return json.load(f)
    except Exception as e:
        logger.warning(f"Не удалось прочитать {HISTORY_FILE}: {e}")
        return {}


def _save(history: dict) -> None:
    os.makedirs("data", exist_ok=True)
    tmp = HISTORY_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(history, f, ensure_ascii=False)
    os.replace(tmp, HISTORY_FILE)


def _merge(existing: list[dict], new_rows: list[dict]) -> list[dict]:
    by_date = {r["tradedate"]: r for r in existing}
    for r in new_rows:
        td = r["tradedate"]
        # Обновляем только если новая запись полнее
        if td not in by_date or r.get("long", 0) > by_date[td].get("long", 0):
            by_date[td] = r
    return sorted(by_date.values(), key=lambda x: x["tradedate"])[-500:]


def backfill(tickers: list[str], months: int, token: str) -> dict:
    date_till = date.today()
    date_from = date_till - timedelta(days=months * 31)
    days = _trading_days(date_from, date_till)

    logger.info(f"Период: {date_from} → {date_till}, дней: {len(days)}, тикеров: {len(tickers)}")

    history = _load_existing()
    log_lines: list[str] = []
    total_new = 0

    for stock_ticker in tickers:
        fut_sym = FUTOI_MAP.get(stock_ticker)
        if not fut_sym:
            msg = f"{stock_ticker}: нет в FUTOI_MAP — пропущен"
            logger.warning(msg); log_lines.append(msg)
            continue

        existing_dates = {r["tradedate"] for r in history.get(stock_ticker, [])}
        new_rows: list[dict] = []
        fetched = skipped = 0

        logger.info(f"{stock_ticker} ({fut_sym}): {len(days)} дней...")
        for d in days:
            ds = d.isoformat()
            if ds in existing_dates:
                skipped += 1
                continue
            row = _fetch_day(fut_sym, token, ds)
            if row:
                new_rows.append(row)
                fetched += 1
            time.sleep(PAUSE_SEC)

        merged = _merge(history.get(stock_ticker, []), new_rows)
        history[stock_ticker] = merged
        total_new += fetched
        msg = f"{stock_ticker}: +{fetched} новых дней (пропущено уже известных: {skipped}, итого: {len(merged)})"
        logger.info(msg); log_lines.append(msg)

        # Сохраняем после каждого тикера — если прервётся, не теряем прогресс
        _save(history)

    logger.info(f"Готово. Новых записей: {total_new}")
    return {"total_new": total_new, "tickers": len(tickers), "log": log_lines}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--months",  type=int, default=12)
    parser.add_argument("--tickers", type=str, default="")
    args = parser.parse_args()

    token = _get_token()
    if not token:
        logger.error("MOEX_TOKEN не задан. Укажите в env или settings.ini [MOEX] TOKEN=...")
        return

    tickers = [t.strip().upper() for t in args.tickers.split(",") if t.strip()] if args.tickers else list(FUTOI_MAP.keys())
    backfill(tickers, args.months, token)


if __name__ == "__main__":
    main()
