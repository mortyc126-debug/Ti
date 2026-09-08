"""make_equities_cache.py — снимок котировок акций и фьючерсов из T-Invest
для «Карты» веб-приложения. Пишет:
  web/public/stocks-cache.json  = [{ticker,name,isin,sector,currency,shares,price,div12m,beta}]
  web/public/futures-cache.json = [{ticker,name,basicAsset,basicAssetSize,lot,price,expiration}]

Акции: справочник client.instruments.shares(BASE) → тикер/isin/сектор/число
акций (issue_size), последняя цена — get_last_prices пачками. E/P и капитализацию
считает уже фронт (нужна чистая прибыль эмитента из отчётности).

Запуск из invest-bot (те же cert-переменные, что для песочницы):
    py -3.11 make_equities_cache.py
"""
from __future__ import annotations

import json
import os
import sys
import time
from datetime import datetime, timedelta, timezone

from tinkoff.invest import Client, InstrumentStatus, CandleInterval
from invest_api.invest_target import INVEST_TARGET
from dashboard import _config

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PUB = os.path.join(_ROOT, "web", "public")


def _q(qt):
    return qt.units + qt.nano / 1e9


def _last_prices(client, figis):
    """figi -> последняя цена (в валюте инструмента), пачками по 200."""
    out = {}
    for i in range(0, len(figis), 200):
        chunk = figis[i:i + 200]
        try:
            resp = client.market_data.get_last_prices(figi=chunk)
            for lp in resp.last_prices:
                p = _q(lp.price)
                if p > 0:
                    out[lp.figi] = p
        except Exception as e:
            print(f"[eq] last_prices chunk {i}: {e}", file=sys.stderr)
        time.sleep(0.2)
    return out


# сумма дивидендов (нетто, на акцию) за последние 12 месяцев
def _div12m(client, figi, now):
    try:
        resp = client.instruments.get_dividends(
            figi=figi, from_=now - timedelta(days=365), to=now + timedelta(days=1))
    except Exception:
        return None
    total = 0.0
    got = False
    for d in resp.dividends:
        dt = getattr(d, "payment_date", None) or getattr(d, "record_date", None)
        if dt is not None and dt.replace(tzinfo=timezone.utc) < now - timedelta(days=365):
            continue
        amt = getattr(d, "dividend_net", None)
        if amt is not None:
            total += _q(amt)
            got = True
    return round(total, 4) if got else None


# дневные закрытия за ~days дней: {date_iso -> close}
def _daily_closes(client, figi, days=400):
    out = {}
    now = datetime.now(timezone.utc)
    try:
        for c in client.get_all_candles(
            figi=figi,
            from_=now - timedelta(days=days),
            interval=CandleInterval.CANDLE_INTERVAL_DAY,
        ):
            cl = _q(c.close)
            if cl > 0:
                out[c.time.date().isoformat()] = cl
    except Exception as e:
        print(f"[eq] candles {figi}: {e}", file=sys.stderr)
    return out


# бета акции к индексу по дневным доходностям: cov(r_s, r_m)/var(r_m)
def _beta(stock_closes, idx_closes):
    dates = sorted(set(stock_closes) & set(idx_closes))
    if len(dates) < 40:
        return None
    sr, ir = [], []
    for i in range(1, len(dates)):
        p0, p1 = stock_closes[dates[i - 1]], stock_closes[dates[i]]
        m0, m1 = idx_closes[dates[i - 1]], idx_closes[dates[i]]
        if p0 > 0 and m0 > 0:
            sr.append(p1 / p0 - 1)
            ir.append(m1 / m0 - 1)
    n = len(sr)
    if n < 30:
        return None
    mi = sum(ir) / n
    ms = sum(sr) / n
    cov = sum((ir[k] - mi) * (sr[k] - ms) for k in range(n)) / n
    var = sum((ir[k] - mi) ** 2 for k in range(n)) / n
    if var <= 0:
        return None
    return round(cov / var, 3)


# figi индекса МосБиржи (IMOEX) — для расчёта беты. Ищем по справочнику.
def _index_figi(client):
    for q in ("IMOEX", "Индекс МосБиржи", "MOEX Russia Index"):
        try:
            res = client.instruments.find_instrument(query=q)
            for it in res.instruments:
                itype = (getattr(it, "instrument_type", "") or "").lower()
                if getattr(it, "ticker", "") == "IMOEX" or itype == "index":
                    return it.figi
        except Exception:
            continue
    return None


def dump_shares(client):
    shares = client.instruments.shares(
        instrument_status=InstrumentStatus.INSTRUMENT_STATUS_BASE).instruments
    figis = [s.figi for s in shares if (s.currency or "").lower() == "rub"]
    prices = _last_prices(client, figis)
    now = datetime.now(timezone.utc)

    # индекс для беты — тянем свечи один раз
    idx_figi = _index_figi(client)
    idx_closes = _daily_closes(client, idx_figi) if idx_figi else {}
    if idx_closes:
        print(f"[eq] индекс IMOEX: {len(idx_closes)} дн. свечей → считаю бету", file=sys.stderr)
    else:
        print("[eq] индекс IMOEX не найден — бета не будет посчитана", file=sys.stderr)

    out = []
    for s in shares:
        if (s.currency or "").lower() != "rub":
            continue
        price = prices.get(s.figi)
        if not price:
            continue
        div12m = _div12m(client, s.figi, now)
        # бета: дневные свечи акции vs индекса
        beta = None
        if idx_closes:
            sc = _daily_closes(client, s.figi)
            beta = _beta(sc, idx_closes)
            time.sleep(0.05)
        time.sleep(0.05)
        out.append({
            "ticker": s.ticker,
            "name": s.name,
            "isin": s.isin,
            "sector": s.sector or None,
            "currency": s.currency,
            "shares": int(getattr(s, "issue_size", 0) or 0) or None,
            "price": round(price, 4),
            "div12m": div12m,
            "beta": beta,
        })
    path = os.path.join(PUB, "stocks-cache.json")
    json.dump(out, open(path, "w", encoding="utf-8"), ensure_ascii=False)
    print(f"[eq] акций: {len(out)} → {path}", file=sys.stderr)


def dump_futures(client):
    futs = client.instruments.futures(
        instrument_status=InstrumentStatus.INSTRUMENT_STATUS_BASE).instruments
    figis = [f.figi for f in futs]
    prices = _last_prices(client, figis)
    out = []
    for f in futs:
        price = prices.get(f.figi)
        if not price:
            continue
        exp = getattr(f, "expiration_date", None)
        out.append({
            "ticker": f.ticker,
            "name": f.name,
            "basicAsset": getattr(f, "basic_asset", None),
            "basicAssetSize": _q(f.basic_asset_size) if getattr(f, "basic_asset_size", None) else None,
            "lot": getattr(f, "lot", None),
            "price": round(price, 4),
            "expiration": exp.date().isoformat() if exp else None,
        })
    path = os.path.join(PUB, "futures-cache.json")
    json.dump(out, open(path, "w", encoding="utf-8"), ensure_ascii=False)
    print(f"[eq] фьючерсов: {len(out)} → {path}", file=sys.stderr)


def main():
    os.makedirs(PUB, exist_ok=True)
    with Client(_config.tinkoff_token, app_name=_config.tinkoff_app_name, target=INVEST_TARGET) as client:
        dump_shares(client)
        dump_futures(client)
    print("[eq] ГОТОВО. Обнови веб — на табах «Акции»/«Фьючерсы» появятся реальные точки.", file=sys.stderr)


if __name__ == "__main__":
    main()
