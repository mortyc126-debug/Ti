"""
backfill_oi.py — Загрузка исторического FutOI из MOEX AlgoPack.

Скачивает историю открытого интереса (юр/физ) за последние N месяцев
и заполняет data/oi_daily.json — тот же файл, что читают OiLayersService
(живой режим) и OiBacktestProvider (бэктест).

После запуска этого скрипта прогоны на симуляторе будут учитывать реальный
открытый интерес на каждую дату — без ожидания пока бот накопит историю сам.

Запуск:
    python backfill_oi.py            # 12 месяцев для всех тикеров
    python backfill_oi.py --months 6
    python backfill_oi.py --tickers SBER,GAZP --months 3

Требования:
    MOEX_TOKEN задан в env или в settings.ini [MOEX] TOKEN=...
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
PAGE_SIZE = 1000   # максимум строк за один запрос
PAUSE_SEC = 0.5    # пауза между запросами (не флудим AlgoPack)

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


def _fetch_page(sym: str, token: str, date_from: str, date_till: str, start: int = 0) -> list[dict]:
    """Одна страница FutOI из AlgoPack. Возвращает список строк (все clgroup)."""
    params = {
        "ticker": sym,
        "from": date_from,
        "till": date_till,
        "iss.meta": "off",
        "limit": PAGE_SIZE,
        "start": start,
    }
    url = f"{FUTOI_URL}?{urllib.parse.urlencode(params)}"
    req = urllib.request.Request(
        url,
        headers={"Authorization": f"Bearer {token}", "Accept": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.load(resp)
    except Exception as e:
        logger.warning(f"  ошибка запроса {sym} start={start}: {e}")
        return []

    block = data.get("futoi")
    if not block or not block.get("columns") or not block.get("data"):
        return []
    cols = block["columns"]
    rows = [dict(zip(cols, row)) for row in block["data"]]
    return [r for r in rows if r.get("ticker") == sym]


def _fetch_all(sym: str, token: str, date_from: str, date_till: str) -> list[dict]:
    """Полная история символа за период — постраничная выгрузка."""
    all_rows = []
    start = 0
    while True:
        page = _fetch_page(sym, token, date_from, date_till, start)
        if not page:
            break
        all_rows.extend(page)
        if len(page) < PAGE_SIZE:
            break
        start += len(page)
        time.sleep(PAUSE_SEC)
    return all_rows


def _aggregate_by_date(rows: list[dict]) -> list[dict]:
    """
    Агрегирует строки по дате: объединяет YUR и FIZ в одну запись.
    Формат выходной записи совпадает с тем, что пишет OiLayersService._poll_once.
    """
    by_date: dict[str, dict] = {}
    for r in rows:
        td = str(r.get("tradedate") or "")
        if not td:
            continue
        g = str(r.get("clgroup") or "").upper()
        if g not in ("YUR", "FIZ"):
            continue
        entry = by_date.setdefault(td, {
            "tradedate": td,
            "yur_long": 0.0, "yur_short": 0.0,
            "fiz_long": 0.0, "fiz_short": 0.0,
        })
        pos_long  = float(r.get("pos_long")  or 0)
        pos_short = abs(float(r.get("pos_short") or 0))
        if g == "YUR":
            # берём последнюю по времени запись в пределах дня
            if pos_long > entry["yur_long"] or pos_short > entry["yur_short"]:
                entry["yur_long"]  = pos_long
                entry["yur_short"] = pos_short
        else:
            if pos_long > entry["fiz_long"] or pos_short > entry["fiz_short"]:
                entry["fiz_long"]  = pos_long
                entry["fiz_short"] = pos_short

    result = []
    for td, e in sorted(by_date.items()):
        e["long"]  = e["yur_long"]  + e["fiz_long"]
        e["short"] = e["yur_short"] + e["fiz_short"]
        result.append(e)
    return result


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
    """Сливает новые строки в существующий список, без дублей по дате."""
    by_date = {r["tradedate"]: r for r in existing}
    for r in new_rows:
        td = r["tradedate"]
        if td not in by_date:
            by_date[td] = r
        else:
            # Обновляем если новая запись полнее (есть price или больше OI)
            old = by_date[td]
            if r.get("price") and not old.get("price"):
                by_date[td] = {**r, **{k: v for k, v in old.items() if v}}
            elif r.get("long", 0) > old.get("long", 0):
                by_date[td] = r
    merged = sorted(by_date.values(), key=lambda x: x["tradedate"])
    return merged[-500:]   # держим не более 500 дней (~2 года)


def backfill(tickers: list[str], months: int, token: str) -> None:
    date_till = date.today().isoformat()
    date_from = (date.today() - timedelta(days=months * 31)).isoformat()

    logger.info(f"Период: {date_from} → {date_till}, тикеров: {len(tickers)}")

    history = _load_existing()
    total_new = 0

    for stock_ticker in tickers:
        fut_sym = FUTOI_MAP.get(stock_ticker)
        if not fut_sym:
            logger.warning(f"{stock_ticker}: нет записи в FUTOI_MAP — пропускаю")
            continue

        logger.info(f"{stock_ticker} ({fut_sym}): загружаю...")
        rows = _fetch_all(fut_sym, token, date_from, date_till)
        if not rows:
            logger.warning(f"  нет данных")
            continue

        aggregated = _aggregate_by_date(rows)
        existing = history.get(stock_ticker, [])
        merged = _merge(existing, aggregated)
        new_count = len(merged) - len(existing)
        history[stock_ticker] = merged
        total_new += max(0, new_count)
        logger.info(f"  {len(aggregated)} дней получено, +{max(0,new_count)} новых (итого {len(merged)})")
        time.sleep(PAUSE_SEC)

    _save(history)
    logger.info(f"Сохранено в {HISTORY_FILE}. Всего новых записей: {total_new}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Загрузка исторического FutOI из MOEX AlgoPack")
    parser.add_argument("--months", type=int, default=12, help="Глубина истории в месяцах (дефолт 12)")
    parser.add_argument("--tickers", type=str, default="", help="Список тикеров через запятую (дефолт — все из FUTOI_MAP)")
    args = parser.parse_args()

    token = _get_token()
    if not token:
        logger.error("MOEX_TOKEN не задан. Укажите в env или settings.ini [MOEX] TOKEN=...")
        return

    tickers = [t.strip().upper() for t in args.tickers.split(",") if t.strip()] if args.tickers else list(FUTOI_MAP.keys())
    backfill(tickers, args.months, token)


if __name__ == "__main__":
    main()
