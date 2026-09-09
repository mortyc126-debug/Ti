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


# дневные закрытия за ~days дней: {date_iso -> close}. Принимает figi ИЛИ
# instrument_id (uid) — у индексов надёжнее uid.
def _daily_closes(client, figi=None, instrument_id=None, days=400):
    out = {}
    now = datetime.now(timezone.utc)
    kw = {"instrument_id": instrument_id} if instrument_id else {"figi": figi}
    try:
        for c in client.get_all_candles(
            from_=now - timedelta(days=days),
            interval=CandleInterval.CANDLE_INTERVAL_DAY,
            **kw,
        ):
            cl = _q(c.close)
            if cl > 0:
                out[c.time.date().isoformat()] = cl
    except Exception as e:
        print(f"[eq] candles {figi or instrument_id}: {e}", file=sys.stderr)
    return out


# Прокси-рынок из самих акций: равновзвешенная дневная доходность по всем
# бумагам → синтетический уровень индекса. Работает, когда IMOEX недоступен.
def _proxy_market(share_closes):
    rets = {}
    for closes in share_closes.values():
        dts = sorted(closes)
        for i in range(1, len(dts)):
            p0, p1 = closes[dts[i - 1]], closes[dts[i]]
            if p0 > 0:
                rets.setdefault(dts[i], []).append(p1 / p0 - 1)
    lvl, idx = 100.0, {}
    for d in sorted(rets):
        r = sum(rets[d]) / len(rets[d])
        lvl *= (1 + r)
        idx[d] = lvl
    return idx


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


# id (uid/figi) индекса МосБиржи (IMOEX). Индексы не торгуемые, поэтому
# find_instrument по умолчанию их не отдаёт — просим с api_trade_available_flag=False.
def _index_id(client):
    variants = [
        {"query": "IMOEX", "api_trade_available_flag": False},
        {"query": "Индекс МосБиржи", "api_trade_available_flag": False},
        {"query": "IMOEX"},
    ]
    for kw in variants:
        try:
            res = client.instruments.find_instrument(**kw)
        except TypeError:
            try:
                res = client.instruments.find_instrument(query=kw["query"])
            except Exception:
                continue
        except Exception:
            continue
        for it in getattr(res, "instruments", []) or []:
            itype = (getattr(it, "instrument_type", "") or "").lower()
            if getattr(it, "ticker", "") == "IMOEX" or itype == "index":
                return getattr(it, "uid", None) or getattr(it, "figi", None)
    return None


def dump_shares(client):
    shares = client.instruments.shares(
        instrument_status=InstrumentStatus.INSTRUMENT_STATUS_BASE).instruments
    rub = [s for s in shares if (s.currency or "").lower() == "rub"]
    prices = _last_prices(client, [s.figi for s in rub])
    now = datetime.now(timezone.utc)
    kept = [s for s in rub if prices.get(s.figi)]

    # индекс IMOEX для беты
    idx_id = _index_id(client)
    idx_closes = _daily_closes(client, instrument_id=idx_id) if idx_id else {}
    print(f"[eq] индекс IMOEX: {'найден, ' + str(len(idx_closes)) + ' дн.' if idx_closes else 'НЕ найден → строю прокси-рынок из акций'}", file=sys.stderr)

    # дневные свечи по каждой оставшейся акции — нужны и для беты, и для прокси
    print(f"[eq] тяну свечи по {len(kept)} акциям для беты…", file=sys.stderr)
    share_closes = {}
    for i, s in enumerate(kept):
        share_closes[s.figi] = _daily_closes(client, figi=s.figi)
        if i and i % 50 == 0:
            print(f"[eq]   свечи {i}/{len(kept)}", file=sys.stderr)
        time.sleep(0.03)

    # если индекса нет — синтетический рынок из самих акций
    if not idx_closes:
        idx_closes = _proxy_market(share_closes)
        print(f"[eq] прокси-рынок: {len(idx_closes)} дн. из {len(share_closes)} акций", file=sys.stderr)

    out = []
    nbeta = 0
    for s in kept:
        div12m = _div12m(client, s.figi, now)
        beta = _beta(share_closes.get(s.figi, {}), idx_closes) if idx_closes else None
        if beta is not None:
            nbeta += 1
        time.sleep(0.03)
        out.append({
            "ticker": s.ticker,
            "name": s.name,
            "isin": s.isin,
            "sector": s.sector or None,
            "currency": s.currency,
            "shares": int(getattr(s, "issue_size", 0) or 0) or None,
            "price": round(prices.get(s.figi), 4),
            "div12m": div12m,
            "beta": beta,
        })
    path = os.path.join(PUB, "stocks-cache.json")
    json.dump(out, open(path, "w", encoding="utf-8"), ensure_ascii=False)
    print(f"[eq] акций: {len(out)} (с бетой: {nbeta}) → {path}", file=sys.stderr)


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
