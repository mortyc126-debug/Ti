"""
run_pipeline.py — сквозной прогон: наполняет data/history.json бэктестом
(если бот ещё не торговал живьём — history.json пуст), затем считает
калибровку нарратива (calibrate_narrative.py), лассо-веса
(lasso_calibration.py) и майнинг правил (rule_miner.py) на этих данных.

Без этого шага все три калибровки висят без входных данных — на пустом
data/history.json у них просто нечего считать ("слишком мало сделок").
save_backtest_history (dashboard.py) уже существовала для этой же цели
для lasso ("Используется для начальной калибровки lasso без ожидания
живых сделок") — здесь она используется как общий первый шаг для всех трёх.

    python run_pipeline.py SBER --days 180
    python run_pipeline.py --all --days 180
"""
import argparse

from dashboard import _strategy_settings_by_ticker, save_backtest_history

import calibrate_narrative
import lasso_calibration
import rule_miner


def _resolve_tickers(args) -> list[str]:
    if args.all:
        return list(_strategy_settings_by_ticker().keys())
    if args.ticker and "," in args.ticker:
        return [t.strip() for t in args.ticker.split(",") if t.strip()]
    if args.ticker:
        return [args.ticker]
    raise SystemExit("укажи тикер, список через запятую, или --all")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("ticker", nargs="?")
    parser.add_argument("--all", action="store_true")
    parser.add_argument("--days", type=int, default=180)
    parser.add_argument("--skip-backtest", action="store_true",
                        help="не наполнять history.json бэктестом — использовать то, что уже накоплено "
                             "(живой торговлей или предыдущим прогоном)")
    parser.add_argument("--alpha", type=float, default=0.01)
    parser.add_argument("--l1-ratio", type=float, default=0.8)
    parser.add_argument("--group-lasso", action="store_true")
    parser.add_argument("--max-depth", type=int, default=rule_miner._DEFAULT_MAX_DEPTH)
    args = parser.parse_args()

    tickers = _resolve_tickers(args)

    if not args.skip_backtest:
        print(f"=== Шаг 1/4: наполнение data/history.json бэктестом ({len(tickers)} тикеров) ===")
        summary = save_backtest_history(tickers, args.days)
        print(f"  дней записано: {summary.get('saved_days', '?')}, "
              f"сделок: {summary.get('trades', '?')}")
        if summary.get("errors"):
            print(f"  ошибки: {summary['errors']}")
    else:
        print("=== Шаг 1/4: пропущен (--skip-backtest) ===")

    print("\n=== Шаг 2/4: калибровка порогов narrative.py ===")
    existing_thresh = calibrate_narrative._load_existing()
    for ticker in tickers:
        result = calibrate_narrative._calibrate_one(ticker, args.days)
        if result:
            existing_thresh = calibrate_narrative._merge(existing_thresh, result)
    calibrate_narrative._save(existing_thresh)
    print(f"  Сохранено → {calibrate_narrative.NARRATIVE_THRESHOLDS_FILE}")

    print("\n=== Шаг 3/4: lasso_calibration (веса/взаимодействия методов) ===")
    by_ticker = _strategy_settings_by_ticker()
    existing_lasso = lasso_calibration._load_existing()
    for ticker in tickers:
        try:
            result = lasso_calibration._calibrate_one(
                ticker, args.days, args.alpha, args.l1_ratio, args.group_lasso,
            )
        except Exception as e:
            print(f"{ticker}: ошибка lasso ({e}) — пропуск")
            continue
        if result:
            st = by_ticker.get(ticker)
            key = st.figi if st else ticker
            existing_lasso[key] = result
    lasso_calibration._save(existing_lasso)
    print(f"  Сохранено → {lasso_calibration.LASSO_WEIGHTS_FILE}")

    print("\n=== Шаг 4/4: rule_miner (конъюнктивные правила по regime) ===")
    existing_rules = rule_miner._load_existing()
    for ticker in tickers:
        try:
            result = rule_miner._mine_one(ticker, args.days, args.max_depth)
        except Exception as e:
            print(f"{ticker}: ошибка rule_miner ({e}) — пропуск")
            continue
        if result:
            existing_rules[ticker] = result
    rule_miner._save(existing_rules)
    print(f"  Сохранено → {rule_miner.RULES_FILE}")

    print("\nГотово.")


if __name__ == "__main__":
    main()
