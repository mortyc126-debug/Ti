"""
backfill_oi.py — Загрузка исторического FutOI из MOEX AlgoPack.

AlgoPack отдаёт FutOI только на конкретную дату (один запрос = один день).
Скрипт перебирает торговые дни за последние N месяцев, на каждый делает
отдельный запрос и сохраняет результат в data/oi_daily.json.

Для каждого акционного тикера (SBER, GAZP...) скрипт сначала запрашивает
публичный MOEX ISS чтобы найти фьючерсные контракты (SBERH6, SBERZ5...).
Затем для каждой исторической даты выбирает тот контракт, у которого
lasttradedate >= дата (ближайший незакрытый, т.е. фронт-месяц).
Ни одного тикера не генерируем — всё берём из MOEX.

Запуск:
    python backfill_oi.py            # 12 месяцев для всех тикеров из settings.ini
    python backfill_oi.py --months 6
    python backfill_oi.py --tickers SBER,GAZP --months 3
"""

import argparse
import json
import logging
import os
import ssl
import time
import urllib.parse
import urllib.request
from configparser import ConfigParser
from datetime import date, timedelta

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger(__name__)

_SSL_CTX = None


def _ssl_ctx():
    """SSL-контекст с валидным CA (certifi, если есть) — против
    'unable to get local issuer certificate' на iss.moex.com/apim.moex.com,
    когда системный CA-стор битый/пустой. Кэшируем."""
    global _SSL_CTX
    if _SSL_CTX is None:
        try:
            import certifi
            _SSL_CTX = ssl.create_default_context(cafile=certifi.where())
        except Exception:
            _SSL_CTX = ssl.create_default_context()
    return _SSL_CTX

FUTOI_URL = "https://apim.moex.com/iss/analyticalproducts/futoi/securities.json"
MOEX_ISS  = "https://iss.moex.com/iss"
HISTORY_FILE = "data/oi_daily.json"
PAUSE_SEC = 0.4   # пауза между запросами к AlgoPack

# Ошибки сетевых запросов внутри _fetch_futures_contracts на последний вызов
# per-тикер — чтобы backfill() мог показать их в своей строке лога (иначе
# дашборд видел бы то же "контракты не найдены", что и для честного "MOEX
# ничего не отдал", не отличая сетевую проблему от реального отсутствия данных).
_last_fetch_errors: dict[str, list[str]] = {}


def _get_token() -> str | None:
    token = os.getenv("MOEX_TOKEN")
    if token:
        return token
    ini = ConfigParser()
    ini.read("settings.ini", encoding="utf-8")
    return ini.get("MOEX", "TOKEN", fallback=None) or None


def _get_strategy_tickers() -> list[str]:
    """Читает тикеры из секций STRATEGY_* settings.ini (акционные, не фьючерсные)."""
    ini = ConfigParser()
    ini.read("settings.ini", encoding="utf-8")
    tickers = []
    for section in ini.sections():
        if not section.startswith("STRATEGY_") or "_SETTINGS" in section:
            continue
        t = ini.get(section, "TICKER", fallback=None)
        if t:
            tickers.append(t.upper())
    return tickers


def _fetch_futures_contracts(stock_ticker: str) -> list[dict]:
    """
    Запрашивает публичный MOEX ISS чтобы найти все фьючерсные контракты
    на данный акционный тикер (включая истёкшие за последние годы).
    Возвращает [{secid, lasttradedate}] отсортированных по lasttradedate.
    Не требует MOEX токена.
    """
    # Ищем по имени/коду: запрос возвращает и активные, и ближайшие истёкшие.
    # Сначала пробуем активные на FORTS (RFUD — квартальные фьючерсы).
    contracts: dict[str, str] = {}  # secid -> lasttradedate

    # Для части тикеров реальный корень серии FutOI НЕ является префиксом
    # самого акционного тикера (YDEX → "YD", короче самого "YDEX" — обычный
    # startswith(stock_ticker) физически не может совпасть ни с одним secid).
    # Портированная карта из oi_layers._FUTOI_FULL_MAP — пробуем оба префикса.
    try:
        from oi_layers import _FUTOI_FULL_MAP
        _alt_prefix = _FUTOI_FULL_MAP.get(stock_ticker.upper())
    except Exception:
        _alt_prefix = None
    _prefixes = [stock_ticker.upper()] + ([_alt_prefix.upper()] if _alt_prefix else [])
    # Ошибки самих запросов раньше глотались на уровне debug — если ОБА запроса
    # упали по сети/парсингу, наружу уходило то же "не нашли контракты", что и
    # для честного "MOEX действительно ничего не отдал". Разница критична для
    # диагностики (сеть vs реально нет данных), поэтому теперь фиксируем и
    # поднимаем в warning + пробрасываем в лог бэкфилла (см. backfill()).
    errors: list[str] = []

    # 1. Активные контракты из стакана фьючерсов FORTS
    try:
        url = (f"{MOEX_ISS}/engines/futures/markets/forts/boards/RFUD/securities.json"
               f"?iss.meta=off&securities.columns=SECID,LASTTRADEDATE")
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (compatible; invest-bot/1.0)"})
        with urllib.request.urlopen(req, timeout=15, context=_ssl_ctx()) as resp:
            data = json.load(resp)
        block = data.get("securities", {})
        cols = block.get("columns", [])
        rows = block.get("data", [])
        secid_i = cols.index("SECID") if "SECID" in cols else -1
        ltd_i   = cols.index("LASTTRADEDATE") if "LASTTRADEDATE" in cols else -1
        if secid_i >= 0 and ltd_i >= 0:
            for row in rows:
                sid = str(row[secid_i] or "")
                ltd = str(row[ltd_i] or "")
                if any(sid.upper().startswith(pfx) for pfx in _prefixes) and ltd:
                    contracts[sid] = ltd[:10]  # берём только дату YYYY-MM-DD
    except Exception as e:
        msg = f"ISS RFUD запрос упал: {e!r}"
        logger.warning(f"{stock_ticker}: {msg}")
        errors.append(msg)

    # 2. Поиск через /securities.json — покрывает истёкшие контракты за последние годы
    try:
        params = urllib.parse.urlencode({"q": stock_ticker, "iss.meta": "off",
                                         "securities.columns": "secid,matdate,type"})
        url = f"{MOEX_ISS}/securities.json?{params}"
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (compatible; invest-bot/1.0)"})
        with urllib.request.urlopen(req, timeout=15, context=_ssl_ctx()) as resp:
            data = json.load(resp)
        block = data.get("securities", {})
        cols = block.get("columns", [])
        rows = block.get("data", [])
        secid_i = cols.index("secid") if "secid" in cols else -1
        mat_i   = cols.index("matdate") if "matdate" in cols else -1
        type_i  = cols.index("type") if "type" in cols else -1
        if secid_i >= 0 and mat_i >= 0:
            for row in rows:
                sid  = str(row[secid_i] or "")
                mat  = str(row[mat_i] or "")
                typ  = str(row[type_i] or "") if type_i >= 0 else ""
                # фьючерсы = type 'futures', secid начинается на тикер
                if any(sid.upper().startswith(pfx) for pfx in _prefixes) and mat and "future" in typ.lower():
                    contracts.setdefault(sid, mat[:10])
    except Exception as e:
        msg = f"ISS securities search упал: {e!r}"
        logger.warning(f"{stock_ticker}: {msg}")
        errors.append(msg)

    _last_fetch_errors[stock_ticker] = errors
    if not contracts:
        if errors:
            logger.warning(f"{stock_ticker}: не нашли фьючерсных контрактов на MOEX ISS "
                           f"(оба запроса упали: {'; '.join(errors)})")
        else:
            logger.warning(f"{stock_ticker}: не нашли фьючерсных контрактов на MOEX ISS "
                           f"(запросы прошли успешно, но совпадений по префиксу '{stock_ticker.upper()}' нет)")
        return []

    result = sorted(
        [{"secid": k, "lasttradedate": v} for k, v in contracts.items()],
        key=lambda x: x["lasttradedate"],
    )
    logger.info(f"{stock_ticker}: найдено {len(result)} контрактов: "
                f"{[r['secid'] for r in result]}")
    return result


def _pick_contract(contracts: list[dict], trade_date: str) -> str | None:
    """
    Для заданной даты выбирает фронт-месяц: контракт с наименьшим lasttradedate
    при условии lasttradedate >= trade_date (контракт ещё не истёк).
    """
    candidates = [c for c in contracts if c["lasttradedate"] >= trade_date]
    if not candidates:
        return None
    return min(candidates, key=lambda x: x["lasttradedate"])["secid"]


def _trading_days(date_from: date, date_till: date) -> list[date]:
    """Все будние дни в диапазоне (пн–пт)."""
    days = []
    cur = date_from
    while cur <= date_till:
        if cur.weekday() < 5:
            days.append(cur)
        cur += timedelta(days=1)
    return days


def _fetch_day(sym: str, token: str, trade_date: str) -> dict | None:
    """Запрос FutOI на конкретную дату и конкретный тикер фьючерса."""
    params = {
        "ticker": sym,
        "date": trade_date,
        "iss.meta": "off",
        "limit": 100,
    }
    url = f"{FUTOI_URL}?{urllib.parse.urlencode(params)}"
    req = urllib.request.Request(
        url,
        headers={
            "Authorization": f"Bearer {token}", "Accept": "application/json",
            # Без явного User-Agent urllib шлёт "Python-urllib/x.y" — Cloudflare/edge
            # иногда блокирует это 403 раньше, чем запрос дойдёт до MOEX API.
            "User-Agent": "Mozilla/5.0 (compatible; invest-bot/1.0)",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=20, context=_ssl_ctx()) as resp:
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
        "fut_ticker": sym,   # сохраняем для отладки
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
        # Получаем реальные фьючерсные контракты с MOEX ISS
        contracts = _fetch_futures_contracts(stock_ticker)
        if not contracts:
            fetch_errs = _last_fetch_errors.get(stock_ticker) or []
            detail = f" (ошибки запроса: {'; '.join(fetch_errs)})" if fetch_errs \
                else " (запросы прошли, совпадений по префиксу нет — не сеть, а формат тикера)"
            msg = f"{stock_ticker}: контракты не найдены на MOEX ISS — пропущен{detail}"
            logger.warning(msg); log_lines.append(msg)
            continue

        existing_dates = {r["tradedate"] for r in history.get(stock_ticker, [])}
        new_rows: list[dict] = []
        fetched = skipped = no_contract = 0

        logger.info(f"{stock_ticker}: {len(days)} дней...")
        for d in days:
            ds = d.isoformat()
            if ds in existing_dates:
                skipped += 1
                continue

            # Для этой даты выбираем нужный контракт из MOEX ISS
            fut_sym = _pick_contract(contracts, ds)
            if not fut_sym:
                no_contract += 1
                continue

            row = _fetch_day(fut_sym, token, ds)
            if row:
                new_rows.append(row)
                fetched += 1
            time.sleep(PAUSE_SEC)

        merged = _merge(history.get(stock_ticker, []), new_rows)
        history[stock_ticker] = merged
        total_new += fetched
        msg = (f"{stock_ticker}: +{fetched} новых дней "
               f"(пропущено известных: {skipped}, нет контракта: {no_contract}, итого: {len(merged)})")
        logger.info(msg); log_lines.append(msg)

        # Сохраняем после каждого тикера
        _save(history)

    logger.info(f"Готово. Новых записей: {total_new}")
    return {"total_new": total_new, "tickers": len(tickers), "log": log_lines}


def backfill_by_codes(codes: list[str], date_from: "date", date_till: "date",
                      token: str, progress: dict | None = None) -> dict:
    """Прямой сбор FutOI с MOEX по КОДАМ контрактов (вариант B) за [date_from,
    date_till]. Нужен, когда вселенная прогона — произвольные фьючерсы, которых
    нет в предсобранном воркере: авто-поток раньше в MOEX за ними не ходил вовсе.

    Для каждого кода: корень контракта (GKU6→GK) → все контракты корня с MOEX ISS
    → фронт-месяц на каждую дату (_pick_contract — так же стыкует свечная цепочка
    бэктеста) → _fetch_day. Кладём под ключ = ИСХОДНЫЙ код, чтобы has_data(code)
    сматчил (вариант B). Инкрементально: известные даты не перезапрашиваем.

    Ограничения (те же, что у стокового backfill): MOEX ISS отдаёт текущие
    контракты, поэтому для давно экспирировавших фронтов старые даты могут не
    подтянуться. Цена (close) не тянется — signal_gate.oi_regime_instability
    мягко деградирует до flow_extremity (см. его докстринг)."""
    from oi_layers import _contract_root
    days = _trading_days(date_from, date_till)
    history = _load_existing()
    summary: dict[str, dict] = {}
    for code in codes:
        root = _contract_root(code)
        contracts = _fetch_futures_contracts(root)
        if not contracts:
            summary[code] = {"days": len(history.get(code, [])), "added": 0,
                             "reason": f"нет контрактов по корню {root}"}
            continue
        existing_dates = {r["tradedate"] for r in history.get(code, [])}
        new_rows: list[dict] = []
        for d in days:
            ds = d.isoformat()
            if ds in existing_dates:
                continue
            fut_sym = _pick_contract(contracts, ds)
            if not fut_sym:
                continue
            row = _fetch_day(fut_sym, token, ds)
            if row:
                row["contract"] = fut_sym   # для ref_switch в signal_gate/_prepare_rows
                new_rows.append(row)
            time.sleep(PAUSE_SEC)
        merged = _merge(history.get(code, []), new_rows)
        history[code] = merged
        summary[code] = {"days": len(merged), "added": len(new_rows), "reason": None}
        _save(history)   # прогресс переживает обрыв
        if progress is not None:
            try:
                progress[code] = f"OI собран: +{len(new_rows)} дн. (всего {len(merged)})"
            except Exception:
                pass
    return {"summary": summary, "codes": len(codes),
            "added_total": sum(v["added"] for v in summary.values())}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--months",  type=int, default=12)
    parser.add_argument("--tickers", type=str, default="")
    args = parser.parse_args()

    token = _get_token()
    if not token:
        logger.error("MOEX_TOKEN не задан. Укажите в env или settings.ini [MOEX] TOKEN=...")
        return

    if args.tickers:
        tickers = [t.strip().upper() for t in args.tickers.split(",") if t.strip()]
    else:
        tickers = _get_strategy_tickers()
        if not tickers:
            logger.error("Не найдено ни одного тикера в settings.ini [STRATEGY_*]. "
                         "Укажите --tickers SBER,GAZP или добавьте стратегии.")
            return

    logger.info(f"Тикеры: {tickers}")
    backfill(tickers, args.months, token)


if __name__ == "__main__":
    main()
