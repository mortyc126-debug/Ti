"""
candle_archive.py — кэш исторических свечей: локальный диск (быстрый,
без сети) перед общей базой (Cloudflare D1, см. cf-collector/worker.js +
db_api_client.py), чтобы повторные бэктесты (например, с другими
take/stop, или бэктест → потом портфельная симуляция по тем же тикерам)
не дёргали ни Tinkoff, ни даже D1 за уже виденные на этой машине дни, и
чтобы со временем накопился архив глубже 90 дней, которые отдаёт сам API
за один проход.

D1 — общая база (шарится между машинами/процессами коллектора), но каждое
обращение к ней — HTTP round-trip на Cloudflare, и при больших периодах
(150+ дней) это сам по себе заметно медленно, даже когда Tinkoff вообще
не дёргается. Локальный кэш (data/candle_cache/<ticker>.json) — это копия
уже виденных в D1/Tinkoff свечей на конкретном ноуте: если день там есть,
к D1 за ним больше не ходим.

Логика инкрементальная на обоих уровнях: смотрим, какие календарные дни
из запрошенного периода уже есть локально — за остальными идём в D1, а
то, чего и там нет, докачиваем у Tinkoff (MarketDataService.
get_candles_for_dates), дописываем во ВСЕ уровни кэша и отдаём
объединённый набор. Выходные/праздники без торгов будут давать пустой
"недостающий" день при каждом холодном кэше (свечей для них просто нет
ни на одном уровне) — это дешёвый пустой запрос, не страшно.
"""
import json
import logging
import os
from datetime import datetime, timedelta, timezone, date
from decimal import Decimal

from tinkoff.invest import HistoricCandle, Quotation
from tinkoff.invest.utils import quotation_to_decimal, decimal_to_quotation

from db_api_client import DbApiClient
from invest_api.services.market_data_service import MarketDataService

__all__ = ("get_candles_cached",)

logger = logging.getLogger(__name__)

LOCAL_CACHE_DIR = os.path.join("data", "candle_cache")


def _candle_to_row(c: HistoricCandle) -> dict:
    return {
        "time": c.time.isoformat(),
        "open": float(quotation_to_decimal(c.open)),
        "high": float(quotation_to_decimal(c.high)),
        "low": float(quotation_to_decimal(c.low)),
        "close": float(quotation_to_decimal(c.close)),
        "volume": c.volume,
    }


def _row_to_candle(row: dict) -> HistoricCandle:
    def q(v: float) -> Quotation:
        return decimal_to_quotation(Decimal(str(v)))

    return HistoricCandle(
        time=datetime.fromisoformat(row["time"]),
        open=q(row["open"]), high=q(row["high"]),
        low=q(row["low"]), close=q(row["close"]),
        volume=int(row["volume"]),
        is_complete=True,
    )


def _local_cache_path(ticker: str) -> str:
    return os.path.join(LOCAL_CACHE_DIR, f"{ticker}.json")


def _load_local(ticker: str) -> list[dict]:
    path = _local_cache_path(ticker)
    if not os.path.exists(path):
        return []
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (json.JSONDecodeError, OSError):
        logger.warning(f"{ticker}: локальный кэш свечей повреждён, читаю с нуля")
        return []


def _save_local(ticker: str, rows: list[dict]) -> None:
    os.makedirs(LOCAL_CACHE_DIR, exist_ok=True)
    rows = sorted(rows, key=lambda r: r["time"])
    path = _local_cache_path(ticker)
    tmp_path = path + ".tmp"
    with open(tmp_path, "w", encoding="utf-8") as f:
        json.dump(rows, f)
    # atomic replace — несколько параллельных процессов дашборда не должны
    # увидеть частично записанный файл.
    os.replace(tmp_path, path)


def get_candles_cached(
        ticker: str, figi: str, days: int,
        market_data: MarketDataService, db: DbApiClient
) -> list[HistoricCandle]:
    now = datetime.now(timezone.utc)
    date_from = (now - timedelta(days=days)).date()
    date_to = now.date()
    all_days = [date_from + timedelta(days=i) for i in range((date_to - date_from).days + 1)]

    local_rows = _load_local(ticker)
    local_by_day: dict[str, list[dict]] = {}
    for row in local_rows:
        local_by_day.setdefault(row["time"][:10], []).append(row)
    missing_locally = [d for d in all_days if d.isoformat() not in local_by_day]

    if not missing_locally:
        logger.info(f"{ticker}: все {len(all_days)} дней из локального кэша ({date_from}..{date_to}), без сети")
        rows = [r for d in all_days for r in local_by_day.get(d.isoformat(), [])]
        return [_row_to_candle(r) for r in rows]

    if not db.configured:
        fresh = market_data.get_candles_for_dates(figi, missing_locally) if missing_locally else []
    else:
        archived = db.get_candles(
            ticker, missing_locally[0].isoformat(), missing_locally[-1].isoformat()
        ) if missing_locally else []
        have_in_d1 = {row["time"][:10] for row in archived}
        for row in archived:
            local_by_day.setdefault(row["time"][:10], []).append(row)
        missing_days = [d for d in missing_locally if d.isoformat() not in have_in_d1]

        if missing_days:
            logger.info(f"{ticker}: докачиваю {len(missing_days)} дней у Tinkoff (нет ни локально, ни в D1)")
            fresh = market_data.get_candles_for_dates(figi, missing_days)
            if fresh:
                db.push_candles(ticker, [_candle_to_row(c) for c in fresh])
        else:
            fresh = []

    for c in fresh:
        local_by_day.setdefault(c.time.date().isoformat(), []).append(_candle_to_row(c))

    all_rows = [r for d in all_days for r in local_by_day.get(d.isoformat(), [])]
    _save_local(ticker, [r for rows in local_by_day.values() for r in rows])

    merged = [_row_to_candle(r) for r in all_rows]
    merged.sort(key=lambda c: c.time)
    return merged

