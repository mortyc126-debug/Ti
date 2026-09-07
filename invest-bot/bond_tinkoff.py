"""bond_tinkoff.py — дневная история облигаций из T-Invest API (вглубь на годы),
в формат data/bond_dump/bonds/{secid}.json для bond_pead_local.

Бэкенд-база копит цены только с апреля 2026 (~4 мес) → исторический PEAD не
посчитать. У T-Invest дневные свечи действующих облигаций есть на годы. Тут:
резолвим ISIN(secid)→FIGI одним листингом client.instruments.bonds(ALL), затем
тянем DAY-свечи годовыми кусками (окно DAY большое, few calls/бумага) и пишем
{date, price} — цена в % номинала (для дрейфа масштаб не важен). Доходности в
свечах нет → PEAD будет по цене (bond_pead_local это умеет: yield=None пропускает).

Резюмируемо: файл с историей глубже 2025 не перекачиваем. Пейсинг под лимит API.
Запуск (из invest-bot, нужны те же cert-переменные, что для песочницы):
    py -3.11 bond_tinkoff.py --from-year 2019
    py -3.11 bond_tinkoff.py --only "RU000A106DZ4,RU000A105..."   # точечно
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import sys
import time
from datetime import datetime, timedelta, timezone

from tinkoff.invest import Client, CandleInterval, InstrumentStatus
from invest_api.invest_target import INVEST_TARGET
from dashboard import _config

# выгрузка лежит в КОРНЕ репо (bond_dump.py в корне), а этот скрипт в invest-bot/
_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DUMP = os.path.join(_ROOT, "data", "bond_dump")
BONDS = os.path.join(DUMP, "bonds")


def _q(qt):
    return qt.units + qt.nano / 1e9


def _existing_deep(path):
    """файл уже с глубокой историей (есть дата < 2025) — не перекачивать."""
    if not os.path.exists(path):
        return False
    try:
        d = json.load(open(path, encoding="utf-8")).get("data", [])
        return bool(d) and min(r.get("date", "9999")[:10] for r in d) < "2025-01-01"
    except Exception:
        return False


def _secids():
    """secid'ы из выгрузки: имена файлов bonds/ + issuer_bonds."""
    s = set()
    for f in glob.glob(os.path.join(BONDS, "*.json")):
        s.add(os.path.basename(f)[:-5].upper())
    for f in glob.glob(os.path.join(DUMP, "issuer_bonds", "*.json")):
        try:
            for row in json.load(open(f, encoding="utf-8")).get("data", []):
                sc = (row.get("secid") or "").upper()
                if sc:
                    s.add(sc)
        except Exception:
            pass
    return sorted(s)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--from-year", type=int, default=2019)
    ap.add_argument("--only", default=None, help="точечно: ISIN через запятую")
    ap.add_argument("--sleep", type=float, default=0.25, help="пауза между запросами свечей")
    args = ap.parse_args()
    os.makedirs(BONDS, exist_ok=True)

    want = ([x.strip().upper() for x in args.only.split(",") if x.strip()]
            if args.only else _secids())
    if not want:
        sys.exit("нет secid — сначала bond_dump.py")
    print(f"[tinkoff] бумаг к обработке: {len(want)}", file=sys.stderr)

    # ISIN -> FIGI одним листингом всех облигаций (вкл. неактивные, насколько API даёт)
    isin2figi = {}
    with Client(_config.tinkoff_token, app_name=_config.tinkoff_app_name, target=INVEST_TARGET) as client:
        for b in client.instruments.bonds(instrument_status=InstrumentStatus.INSTRUMENT_STATUS_ALL).instruments:
            if b.isin:
                isin2figi[b.isin.upper()] = b.figi
    print(f"[tinkoff] облигаций в справочнике API: {len(isin2figi)}", file=sys.stderr)

    now = datetime.now(timezone.utc)
    years = list(range(args.from_year, now.year + 1))
    ok = miss = skip = 0
    with Client(_config.tinkoff_token, app_name=_config.tinkoff_app_name, target=INVEST_TARGET) as client:
        for k, secid in enumerate(want):
            bp = os.path.join(BONDS, f"{secid}.json")
            if _existing_deep(bp):
                skip += 1
                continue
            figi = isin2figi.get(secid)
            if not figi:
                miss += 1
                if k % 50 == 0:
                    print(f"[tinkoff] {k+1}/{len(want)} (ок {ok}, нет FIGI {miss}, skip {skip})", file=sys.stderr)
                continue
            rows = []
            try:
                for y in years:
                    frm = datetime(y, 1, 1, tzinfo=timezone.utc)
                    to = min(datetime(y, 12, 31, tzinfo=timezone.utc), now)
                    if frm > now:
                        break
                    resp = client.market_data.get_candles(
                        figi=figi, from_=frm, to=to,
                        interval=CandleInterval.CANDLE_INTERVAL_DAY)
                    for c in resp.candles:
                        if c.is_complete:
                            rows.append({"date": c.time.date().isoformat(),
                                         "price": _q(c.close), "yield": None})
                    time.sleep(args.sleep)
            except Exception as e:
                print(f"[tinkoff] {secid}: {e}", file=sys.stderr)
                continue
            rows.sort(key=lambda r: r["date"])
            json.dump({"secid": secid, "count": len(rows), "data": rows},
                      open(bp, "w", encoding="utf-8"), ensure_ascii=False)
            ok += 1
            if k % 25 == 0:
                span = f"{rows[0]['date']}..{rows[-1]['date']}" if rows else "пусто"
                print(f"[tinkoff] {k+1}/{len(want)} {secid} {len(rows)}т {span} "
                      f"(ок {ok}, нет FIGI {miss}, skip {skip})", file=sys.stderr)

    print(f"[tinkoff] ГОТОВО: обновлено {ok}, без FIGI {miss}, пропущено(глубокие) {skip}",
          file=sys.stderr)
    print(f"[tinkoff] дальше: py -3.11 ../bond_pead_local.py --dump \"{DUMP}\" --horizon 60",
          file=sys.stderr)


if __name__ == "__main__":
    main()
