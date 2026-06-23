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

from tinkoff.invest import CandleInterval, HistoricCandle, Quotation

_INTERVAL_MAP = {
    1: CandleInterval.CANDLE_INTERVAL_1_MIN,
    5: CandleInterval.CANDLE_INTERVAL_5_MIN,
}
from tinkoff.invest.utils import quotation_to_decimal, decimal_to_quotation

from db_api_client import DbApiClient
from invest_api.services.market_data_service import MarketDataService

__all__ = ("get_candles_cached", "get_candles_cached_futures_chain")

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


def _local_cache_path(ticker: str, interval_min: int = 5) -> str:
    suffix = "" if interval_min == 5 else f"_{interval_min}m"
    return os.path.join(LOCAL_CACHE_DIR, f"{ticker}{suffix}.json")


def _load_local(ticker: str, interval_min: int = 5) -> list[dict]:
    path = _local_cache_path(ticker, interval_min)
    if not os.path.exists(path):
        return []
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (json.JSONDecodeError, OSError):
        logger.warning(f"{ticker}: локальный кэш свечей повреждён, читаю с нуля")
        return []


def _save_local(ticker: str, rows: list[dict], interval_min: int = 5) -> None:
    os.makedirs(LOCAL_CACHE_DIR, exist_ok=True)
    rows = sorted(rows, key=lambda r: r["time"])
    path = _local_cache_path(ticker, interval_min)
    tmp_path = path + ".tmp"
    with open(tmp_path, "w", encoding="utf-8") as f:
        json.dump(rows, f)
    # atomic replace — несколько параллельных процессов дашборда не должны
    # увидеть частично записанный файл.
    os.replace(tmp_path, path)


def get_candles_cached(
        ticker: str, figi: str, days: int,
        market_data: MarketDataService, db: DbApiClient,
        candle_interval_min: int = 5,
        offset_days: int = 0,
) -> list[HistoricCandle]:
    """offset_days сдвигает ОБА конца периода в прошлое (период всё равно
    `days` дней длиной) — чтобы можно было прогнать более старый кусок
    истории (например, days=150 offset_days=150 — это дни 150..300 назад
    от сегодня), не пересчитывая то, что уже посчитано для offset_days=0."""
    now = datetime.now(timezone.utc) - timedelta(days=offset_days)
    date_from = (now - timedelta(days=days)).date()
    date_to = now.date()
    all_days = [date_from + timedelta(days=i) for i in range((date_to - date_from).days + 1)]

    interval = _INTERVAL_MAP.get(candle_interval_min, CandleInterval.CANDLE_INTERVAL_5_MIN)
    local_rows = _load_local(ticker, candle_interval_min)
    local_by_day: dict[str, list[dict]] = {}
    for row in local_rows:
        local_by_day.setdefault(row["time"][:10], []).append(row)
    missing_locally = [d for d in all_days if d.isoformat() not in local_by_day]

    if not missing_locally:
        logger.info(f"{ticker}: все {len(all_days)} дней из локального кэша ({date_from}..{date_to}), без сети")
        rows = [r for d in all_days for r in local_by_day.get(d.isoformat(), [])]
        return [_row_to_candle(r) for r in rows]

    # D1 хранит только 5-мин свечи — для 1-мин всегда идём напрямую в Tinkoff
    if not db.configured or candle_interval_min != 5:
        fresh = market_data.get_candles_for_dates(figi, missing_locally, interval=interval) if missing_locally else []
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
    _save_local(ticker, [r for rows in local_by_day.values() for r in rows], candle_interval_min)

    merged = [_row_to_candle(r) for r in all_rows]
    merged.sort(key=lambda c: c.time)
    return merged


def get_candles_cached_futures_chain(
        ticker: str, figi: str, days: int,
        market_data: MarketDataService, db: DbApiClient,
        instrument_service,
        candle_interval_min: int = 5,
        offset_days: int = 0,
) -> list[HistoricCandle]:
    """Как get_candles_cached, но если запрошенный период (days/offset_days)
    уходит раньше даты листинга ТЕКУЩЕГО фьючерсного контракта (figi —
    обычно ближайший непросроченный, из settings.ini), докачивает свечи
    предыдущих контрактов того же basic_asset (InstrumentService.
    futures_chain_by_figi) и склеивает их в одну непрерывную серию.

    Склейка — back-adjustment: на дату ролла старый контракт сдвигается по
    цене (open/high/low/close) на разницу между его последней ценой и
    первой ценой следующего (уже известного) контракта, чтобы не было
    скачка цены на стыке — иначе ATR/take-profit вокруг даты ролла считались
    бы по фантомному движению. Каскадно — для каждого следующего, более
    старого контракта в цепочке."""
    candles = get_candles_cached(ticker, figi, days, market_data, db, candle_interval_min, offset_days)

    real_now = datetime.now(timezone.utc)
    now = real_now - timedelta(days=offset_days)
    date_from = (now - timedelta(days=days)).date()
    earliest_have = min((c.time.date() for c in candles), default=None)
    # Раньше earliest_have is None (у ТЕКУЩЕГО контракта вообще нет свечей в
    # запрошенном окне — типичный случай для глубокого offset_days, когда окно
    # целиком уходит до даты листинга контракта) сразу возвращал [] и цепочку
    # предыдущих контрактов даже не пытался смотреть — хотя именно для этого
    # случая она и нужна больше всего.
    if earliest_have is not None and earliest_have <= date_from:
        return candles

    chain = instrument_service.futures_chain_by_figi(figi)
    if not chain:
        logger.info(f"{ticker}: цепочка предыдущих контрактов не найдена (basic_asset не "
                     f"определился) — глубже {earliest_have} не уйти, история обрывается на этом")
        return candles

    idx = next((i for i, (_, f, _) in enumerate(chain) if f == figi), None)
    if idx is None:
        logger.info(f"{ticker}: figi={figi} не найден в собственной цепочке basic_asset — "
                     f"глубже {earliest_have} не уйти")
        return candles
    if idx == 0:
        logger.info(f"{ticker}: это самый старый контракт в цепочке basic_asset (предыдущих "
                     f"нет) — глубже {earliest_have} физически нет истории")
        return candles

    rows_by_day: dict[str, list[dict]] = {}
    for c in candles:
        rows_by_day.setdefault(c.time.date().isoformat(), []).append(_candle_to_row(c))

    if earliest_have is not None:
        cur_earliest = earliest_have
        cur_first_row = min(rows_by_day[cur_earliest.isoformat()], key=lambda r: r["time"])
    else:
        # Нет своих свечей вообще — нет и якоря для back-adjustment к текущему
        # контракту. Начинаем поиск от верхней границы окна (now), без сдвига
        # цены на первой сшивке (diff=0); если предыдущих контрактов в цепочке
        # несколько, между НИМИ диффы считаются нормально (см. ниже).
        cur_earliest = now.date() + timedelta(days=1)
        cur_first_row = None

    for prev_ticker, prev_figi, _prev_expiration in reversed(chain[:idx]):
        target_date_to = cur_earliest - timedelta(days=1)
        if target_date_to < date_from:
            break
        # offset для get_candles_cached считаем от РЕАЛЬНОГО now — внутри та функция
        # сама вычисляет datetime.now(), поэтому сдвинутый now здесь неприменим.
        offset_old = (real_now.date() - target_date_to).days
        days_old = (target_date_to - date_from).days + 1
        prev_candles = get_candles_cached(
            prev_ticker, prev_figi, days_old, market_data, db,
            candle_interval_min, offset_days=offset_old,
        )
        prev_candles = [c for c in prev_candles if c.time.date() <= target_date_to]
        if not prev_candles:
            logger.info(f"{ticker}: предыдущий контракт {prev_ticker} ({prev_figi}) — свечей нет, цепочка обрывается")
            break

        if cur_first_row is not None:
            prev_last_row = max((_candle_to_row(c) for c in prev_candles), key=lambda r: r["time"])
            diff = cur_first_row["close"] - prev_last_row["close"]
        else:
            diff = 0.0

        for c in prev_candles:
            row = _candle_to_row(c)
            row["open"] += diff
            row["high"] += diff
            row["low"] += diff
            row["close"] += diff
            rows_by_day.setdefault(c.time.date().isoformat(), []).append(row)

        prev_earliest = min(c.time.date() for c in prev_candles)
        logger.info(
            f"{ticker}: сшит предыдущий контракт {prev_ticker} ({prev_earliest}..{target_date_to}), "
            f"сдвиг цены {diff:+.4f}"
        )

        cur_earliest = prev_earliest
        cur_first_row = min(rows_by_day[cur_earliest.isoformat()], key=lambda r: r["time"])
        if cur_earliest <= date_from:
            break

    all_rows = [r for rows in rows_by_day.values() for r in rows]
    merged = [_row_to_candle(r) for r in all_rows]
    merged.sort(key=lambda c: c.time)
    return merged

