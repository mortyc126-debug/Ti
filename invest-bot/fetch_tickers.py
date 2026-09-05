"""fetch_tickers.py — докачать ПРОИЗВОЛЬНЫЕ тикеры в candle_cache.

prefetch_candles качает только сконфигурированные (settings/дашборд). Для
парного/кросс-секционного нужен широкий универсум (в т.ч. префы SBERP/TATNP…,
которых в кэше нет). Тут: резолвим FIGI по тикеру (share_by_ticker) и пишем
кэш тем же get_candles_cached, что и prefetch.

Запуск (из invest-bot; нужны те же cert-переменные, что для песочницы):
    py -3.11 fetch_tickers.py "SBERP,TATNP,SNGSP,BANEP,RTKMP" --days 1500
    py -3.11 fetch_tickers.py "PLZL,ALRS,SELG,GMKN,NLMK,MAGN,CHMF" --days 1500

Оговорка: глубина 5-мин свечей у T-Invest ограничена — за очень старые даты
может вернуть меньше, чем --days. Для дневного парного анализа этого обычно
хватает (pairs_lab ресемплит 5-мин → дни).
"""
import argparse
import sys

from candle_archive import get_candles_cached
from dashboard import _config, _db, _market_data
from invest_api.services.instruments_service import InstrumentService


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("tickers", help="через запятую, напр. SBERP,TATNP,SNGSP")
    ap.add_argument("--days", type=int, default=1500)
    args = ap.parse_args()

    inst = InstrumentService(_config.tinkoff_token, _config.tinkoff_app_name)
    want = [t.strip().upper() for t in args.tickers.split(",") if t.strip()]
    print(f"Качаю {len(want)} тикеров на {args.days} дн...")
    ok, fail = 0, []
    for t in want:
        try:
            found = inst.share_by_ticker(t)
        except Exception as e:
            found = None
            print(f"{t:<10} share_by_ticker ошибка: {e}", file=sys.stderr)
        if not found:
            fail.append(t)
            print(f"{t:<10} FIGI не найден (нет на бирже / другой тикер)")
            continue
        _, figi = found
        try:
            candles = get_candles_cached(t, figi, args.days, _market_data, _db)
            print(f"{t:<10} {len(candles)} свечей в кэше")
            ok += 1
        except Exception as e:
            fail.append(t)
            print(f"{t:<10} ОШИБКА: {e}")
    print(f"\nГотово: {ok} ок, {len(fail)} неудач: {fail}")


if __name__ == "__main__":
    main()
