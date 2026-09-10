"""make_daily_research.py — daily.csv для research/earnings_drift.py.

Собирает из T-Invest дневные лог-доходности акций и согласованные по времени
факторы:
  mkt    — лог-доходность индекса МосБиржи (IMOEX);
  fx     — лог-доходность USD/RUB (USD000UTSTOM);
  sector — отраслевой фактор БЕЗ самой компании (leave-one-out среднее по
           сектору из справочника T-Invest).

Формат строки: ticker,close_time,log_ret,mkt,sector,fx  (см. earnings_drift.py).

Запуск из invest-bot (те же токены, что для make_equities_cache):
    py -3.11 make_daily_research.py            # ~3 года истории
    py -3.11 make_daily_research.py 1500        # N дней истории
Пишет в ../research/daily.csv.
"""
from __future__ import annotations

import csv
import math
import os
import sys
import time

from tinkoff.invest import Client, InstrumentStatus
from invest_api.invest_target import INVEST_TARGET
from dashboard import _config
from make_equities_cache import _daily_closes, _index_id   # переиспользуем

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(_ROOT, "research", "daily.csv")


# {date -> log_ret} из {date -> close}
def _log_rets(closes):
    dts = sorted(closes)
    out = {}
    for i in range(1, len(dts)):
        p0, p1 = closes[dts[i - 1]], closes[dts[i]]
        if p0 > 0 and p1 > 0:
            out[dts[i]] = math.log(p1 / p0)
    return out


def _fx_id(client):
    for q in ("USD000UTSTOM", "Доллар США", "USDRUB"):
        try:
            res = client.instruments.find_instrument(query=q)
        except Exception:
            continue
        for it in getattr(res, "instruments", []) or []:
            if getattr(it, "ticker", "") == "USD000UTSTOM":
                return getattr(it, "uid", None) or getattr(it, "figi", None)
    # запасной путь — перебор валют
    try:
        for c in client.instruments.currencies().instruments:
            if c.ticker == "USD000UTSTOM":
                return c.uid or c.figi
    except Exception:
        pass
    return None


def main():
    days = int(sys.argv[1]) if len(sys.argv) > 1 else 1100
    with Client(_config.tinkoff_token, app_name=_config.tinkoff_app_name, target=INVEST_TARGET) as client:
        shares = client.instruments.shares(
            instrument_status=InstrumentStatus.INSTRUMENT_STATUS_BASE).instruments
        rub = [s for s in shares if (s.currency or "").lower() == "rub"]

        # факторы
        idx = _index_id(client)
        mkt = _log_rets(_daily_closes(client, instrument_id=idx, days=days)) if idx else {}
        fx_id = _fx_id(client)
        fx = _log_rets(_daily_closes(client, instrument_id=fx_id, days=days)) if fx_id else {}
        print(f"[daily] IMOEX дней: {len(mkt)}, USDRUB дней: {len(fx)}", file=sys.stderr)

        # доходности по акциям + сектор
        rets = {}       # ticker -> {date -> ret}
        sec = {}        # ticker -> sector
        for i, s in enumerate(rub):
            r = _log_rets(_daily_closes(client, figi=s.figi, days=days))
            if len(r) < 60:
                continue
            rets[s.ticker] = r
            sec[s.ticker] = s.sector or "other"
            if i and i % 50 == 0:
                print(f"[daily] свечи {i}/{len(rub)}", file=sys.stderr)
            time.sleep(0.03)

        # отраслевой фактор без самой компании: по каждой дате среднее по
        # сектору, потом для тикера пересчитываем как (сумма−его)/(n−1)
        by_sec_date = {}   # (sector,date) -> [sum, count]
        for tk, r in rets.items():
            sc = sec[tk]
            for d, v in r.items():
                key = (sc, d)
                acc = by_sec_date.setdefault(key, [0.0, 0])
                acc[0] += v
                acc[1] += 1

        rows = []
        for tk, r in rets.items():
            sc = sec[tk]
            for d, v in r.items():
                if d not in mkt or d not in fx:
                    continue
                s_sum, s_cnt = by_sec_date[(sc, d)]
                sector_loo = (s_sum - v) / (s_cnt - 1) if s_cnt > 1 else 0.0
                rows.append((tk, d + "T15:45:00Z", round(v, 6),
                             round(mkt[d], 6), round(sector_loo, 6), round(fx[d], 6)))

    rows.sort(key=lambda x: (x[0], x[1]))
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["ticker", "close_time", "log_ret", "mkt", "sector", "fx"])
        w.writerows(rows)
    print(f"[daily] строк: {len(rows)}, тикеров: {len(rets)} → {OUT}", file=sys.stderr)


if __name__ == "__main__":
    main()
