"""
prefetch_candles.py — заранее прогревает локальный диск-кэш свечей
(invest-bot/data/candle_cache/<ticker>.json, см. candle_archive.py) на
большую глубину (--days, по умолчанию 400 ≈ 13 месяцев), чтобы дальше
дашборд (run_backtest/run_portfolio_sim) ничего не качал по сети — ни у
Tinkoff, ни даже у D1 — и открывался с прогревшимися тикерами почти
мгновенно.

Тянет всё, что видит дашборд: тикеры из [STRATEGY_*]/settings.ini,
импортированные из OI (oi_tickers.json), и фьючерсы по базовым тикерам из
[FUTURES_TRADING] BASE_TICKERS (если задано) — те же данные, что считает
portfolio_sim в режиме фьючерсов/morning_*_check.py.

Гонять долго (десятки тикеров × --days дней — это часы при холодном
кэше, см. CANDLE_REQUEST_DELAY в market_data_service.py), поэтому скрипт
расчитан на разовый прогон в фоне/на ночь:

    python prefetch_candles.py --days 400
    python prefetch_candles.py --days 400 --workers 3   (по умолчанию 3 —
        больше рискует словить RESOURCE_EXHAUSTED от Tinkoff, см. лимит
        ~600 запросов/60с суммарно на все процессы)

Можно прервать (Ctrl+C) и перезапустить позже тем же способом — уже
скачанные тикеры/дни в кэше останутся, докачаются только недостающие
(инкрементальная логика в get_candles_cached не отличает повторный запуск
от первого).
"""
import argparse
import logging
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

from candle_archive import get_candles_cached
from dashboard import _config, _db, _market_data, _strategy_settings_by_ticker  # noqa: E402 — реюз готовой настройки/тикеров дашборда

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s: %(message)s")
logger = logging.getLogger(__name__)


def _future_targets() -> list[tuple[str, str]]:
    """(тикер_фьюча, figi) по [FUTURES_TRADING] BASE_TICKERS — те же
    инструменты, что использует portfolio_sim в режиме фьючерсов и
    morning_lead_check.py/morning_overshoot_check.py."""
    base_tickers = _config.futures_trading_settings.base_tickers
    if not base_tickers:
        return []
    from invest_api.services.instruments_service import InstrumentService
    instruments = InstrumentService(_config.tinkoff_token, _config.tinkoff_app_name)

    targets = []
    for base_ticker in base_tickers:
        future = instruments.future_by_base_ticker(base_ticker)
        if future is None:
            logger.warning(f"{base_ticker}: фьюч не найден, пропуск")
            continue
        future_settings, figi = future
        targets.append((future_settings.ticker, figi))
    return targets


def _prefetch_one(ticker: str, figi: str, days: int) -> tuple[str, int, str | None]:
    t0 = time.monotonic()
    try:
        candles = get_candles_cached(ticker, figi, days, _market_data, _db)
        return ticker, len(candles), None
    except Exception as ex:
        return ticker, 0, repr(ex)
    finally:
        logger.info(f"{ticker}: готово за {time.monotonic() - t0:.1f}с")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--days", type=int, default=400)
    parser.add_argument("--workers", type=int, default=3)
    parser.add_argument("--tickers", type=str, default="",
                         help="через запятую — ограничиться подмножеством (по умолчанию все из дашборда)")
    args = parser.parse_args()

    targets: list[tuple[str, str]] = [
        (ticker, s.figi) for ticker, s in _strategy_settings_by_ticker().items()
    ]
    targets.extend(_future_targets())

    if args.tickers:
        wanted = {t.strip() for t in args.tickers.split(",") if t.strip()}
        targets = [(t, f) for t, f in targets if t in wanted]

    if not targets:
        print("Нет тикеров для прогрева — проверь settings.ini/oi_tickers.json/--tickers")
        return

    print(f"Прогреваю кэш на {args.days} дн. для {len(targets)} инструментов, "
          f"{args.workers} потока(ов) параллельно...")

    t_start = time.monotonic()
    ok, failed = 0, []
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = {pool.submit(_prefetch_one, ticker, figi, args.days): ticker for ticker, figi in targets}
        for fut in as_completed(futures):
            ticker = futures[fut]
            _, n_candles, error = fut.result()
            if error:
                failed.append((ticker, error))
                print(f"{ticker:<10} ОШИБКА: {error}")
            else:
                ok += 1
                print(f"{ticker:<10} {n_candles} свечей в кэше")

    elapsed = time.monotonic() - t_start
    print(f"\nГотово за {elapsed / 60:.1f} мин: {ok}/{len(targets)} ок"
          + (f", {len(failed)} с ошибками" if failed else ""))


if __name__ == "__main__":
    main()
