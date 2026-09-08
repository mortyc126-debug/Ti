"""make_macro_cache.py — макро-ряды для драйвер-блока «Карты»/«Финансов».
Пишет web/public/macro-cache.json = {usd:{year:avg}, cny:{...}, brent:{...},
rate:{...}} — среднегодовые ₽/$, ₽/¥, Brent (индикативно, по фьючерсам BR) и
средняя ключевая ставка ЦБ.

Курсы/Brent — из T-Invest (дневные свечи, среднее за год). Ставка ЦБ —
зашитые среднегодовые (не биржевой инструмент). Запуск из invest-bot:
    py -3.11 make_macro_cache.py
"""
from __future__ import annotations

import json
import os
import sys
import time
from datetime import datetime, timezone

from tinkoff.invest import Client, CandleInterval, InstrumentStatus
from invest_api.invest_target import INVEST_TARGET
from dashboard import _config

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PUB = os.path.join(_ROOT, "web", "public")
FROM_YEAR = 2018

# Средняя ключевая ставка ЦБ РФ по годам (приблизительно, %). Не биржевой
# инструмент — зашито; при желании обновляется вручную.
KEY_RATE = {
    "2018": 7.4, "2019": 7.3, "2020": 5.1, "2021": 5.8,
    "2022": 10.6, "2023": 9.9, "2024": 17.5, "2025": 20.5, "2026": 20.0,
}


def _q(qt):
    return qt.units + qt.nano / 1e9


def _yearly_avg(client, figi, from_year, now):
    """среднее close по годам для инструмента."""
    acc = {}   # year -> [sum, n]
    for y in range(from_year, now.year + 1):
        frm = datetime(y, 1, 1, tzinfo=timezone.utc)
        to = min(datetime(y, 12, 31, tzinfo=timezone.utc), now)
        if frm > now:
            break
        try:
            resp = client.market_data.get_candles(
                figi=figi, from_=frm, to=to, interval=CandleInterval.CANDLE_INTERVAL_DAY)
        except Exception as e:
            print(f"[macro] {figi} {y}: {e}", file=sys.stderr)
            continue
        s = n = 0
        for c in resp.candles:
            if c.is_complete:
                s += _q(c.close); n += 1
        if n:
            acc[str(y)] = round(s / n, 3)
        time.sleep(0.2)
    return acc


def _find_currency(client, iso):
    """figi валютной пары к рублю по iso ('usd','cny'); предпочитаем ...TOM."""
    best = None
    for c in client.instruments.currencies(
            instrument_status=InstrumentStatus.INSTRUMENT_STATUS_ALL).instruments:
        if (c.iso_currency_name or "").lower() != iso:
            continue
        if (c.nominal.currency or "").lower() != "rub":
            continue
        if "TOM" in (c.ticker or "").upper():
            return c.figi
        best = best or c.figi
    return best


def _find_brent_figis(client):
    figis = []
    for f in client.instruments.futures(
            instrument_status=InstrumentStatus.INSTRUMENT_STATUS_ALL).instruments:
        ba = (getattr(f, "basic_asset", "") or "").upper()
        tk = (f.ticker or "").upper()
        if ba == "BR" or tk.startswith("BR"):
            figis.append(f.figi)
    return figis


def main():
    os.makedirs(PUB, exist_ok=True)
    now = datetime.now(timezone.utc)
    out = {"usd": {}, "cny": {}, "brent": {}, "rate": KEY_RATE}
    with Client(_config.tinkoff_token, app_name=_config.tinkoff_app_name, target=INVEST_TARGET) as client:
        usd = _find_currency(client, "usd")
        cny = _find_currency(client, "cny")
        if usd:
            out["usd"] = _yearly_avg(client, usd, FROM_YEAR, now)
            print(f"[macro] USD: {out['usd']}", file=sys.stderr)
        if cny:
            out["cny"] = _yearly_avg(client, cny, FROM_YEAR, now)
            print(f"[macro] CNY: {out['cny']}", file=sys.stderr)
        # Brent — индикативно: усредняем close всех фьючерсов BR по году
        brent = {}
        for figi in _find_brent_figis(client):
            for y, v in _yearly_avg(client, figi, max(FROM_YEAR, now.year - 3), now).items():
                brent.setdefault(y, []).append(v)
        out["brent"] = {y: round(sum(vs) / len(vs), 2) for y, vs in brent.items() if vs}
        print(f"[macro] Brent: {out['brent']}", file=sys.stderr)

    path = os.path.join(PUB, "macro-cache.json")
    json.dump(out, open(path, "w", encoding="utf-8"), ensure_ascii=False)
    print(f"[macro] ГОТОВО → {path}", file=sys.stderr)


if __name__ == "__main__":
    main()
