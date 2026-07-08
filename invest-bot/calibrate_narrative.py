"""
calibrate_narrative.py — калибрует пороги тегов narrative.py (bullish_thresh,
accum_thresh, climax_spread) по перцентилям РЕАЛЬНОГО распределения
кластерных скоров, ОТДЕЛЬНО для каждого regime (то, что бычье в trending_up,
может быть медианой в ranging — общий порог на все режимы смазывает это).

Без этого скрипта classify_directional/classify_volume используют
захардкоженные дефолты (0.2 / 1.0) — рабочие на старте, но угаданные.
Здесь пороги выводятся из data/history.json: для каждого (cluster, regime)
берём дневные скоры всех методов кластера, считаем кластерное среднее
(direction) и разброс (volume) за каждый день, и берём перцентили этого
распределения как порог "явно бычий"/"явно climax".

Источник данных — data/history.json (HistoryStore), который наполняется
либо живой торговлей, либо dashboard.save_backtest_history(tickers, days)
(см. run_pipeline.py — он делает это автоматически перед калибровкой).

    python calibrate_narrative.py SBER
    python calibrate_narrative.py --all
"""
import argparse
import json
import os

from dashboard import _strategy_settings_by_ticker
from history import HistoryStore
from narrative import (
    MIN_TRADES_PER_REGIME,
    NARRATIVE_THRESHOLDS_FILE,
    fit_narrative_thresholds as fit_thresholds,
)


def _calibrate_one(ticker: str, days: int) -> dict | None:
    store = HistoryStore()
    trades_by_regime = store.trades_by_regime(ticker, window_days=days)
    if not trades_by_regime:
        print(f"{ticker}: нет сделок в истории — пропуск")
        return None

    result = fit_thresholds(trades_by_regime)
    if not result:
        print(f"{ticker}: ни одного (кластер, режим) с >= {MIN_TRADES_PER_REGIME} сделок — пропуск")
        return None

    n_pairs = sum(len(v) for v in result.values())
    print(f"{ticker}: калибровано {n_pairs} пар (кластер, режим)")
    for label, regimes in result.items():
        for reg, vals in regimes.items():
            print(f"  {label}/{reg}: thr={vals['bullish']:.3f} acc={vals.get('accuracy', 0):.2%} n={vals.get('n_trades', '?')}")
    return result


def _load_existing() -> dict:
    if os.path.exists(NARRATIVE_THRESHOLDS_FILE):
        try:
            with open(NARRATIVE_THRESHOLDS_FILE, encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            pass
    return {}


def _save(data: dict) -> None:
    from atomic_json import atomic_write_json
    atomic_write_json(NARRATIVE_THRESHOLDS_FILE, data, indent=2)


def _merge(existing: dict, ticker_result: dict) -> dict:
    """Калибровка ОБЩАЯ по тикеру (не per-ticker файл, в отличие от lasso) —
    narrative.py читает один файл без привязки к тикеру/figi, т.к. NarrativeState
    у каждого инстанса OICompositeStrategy свой, но пороги общие по кластеру/
    режиму. При нескольких тикерах — последний прогон побеждает по
    пересекающимся (cluster, regime) парам (не усредняем, чтобы не размывать
    калибровку конкретного инструмента шумом другого)."""
    for label, regimes in ticker_result.items():
        existing.setdefault(label, {}).update(regimes)
    return existing


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("ticker", nargs="?",
                        help="один тикер, список через запятую, или --all")
    parser.add_argument("--all", action="store_true",
                        help="прогнать по всем тикерам из settings.ini/oi_tickers.json")
    parser.add_argument("--days", type=int, default=180, help="окно дневной истории")
    args = parser.parse_args()

    if args.all:
        tickers = list(_strategy_settings_by_ticker().keys())
    elif args.ticker and "," in args.ticker:
        tickers = [t.strip() for t in args.ticker.split(",") if t.strip()]
    elif args.ticker:
        tickers = [args.ticker]
    else:
        parser.error("укажи тикер, список через запятую, или --all")
        return

    existing = _load_existing()
    for ticker in tickers:
        result = _calibrate_one(ticker, args.days)
        if result:
            existing = _merge(existing, result)

    _save(existing)
    print(f"\nСохранено → {NARRATIVE_THRESHOLDS_FILE}")


if __name__ == "__main__":
    main()
