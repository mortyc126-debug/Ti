"""verify_limit_signal.py — ЧЕСТНЫЙ P&L живой лимит-стратегии на истории.

Ключевой момент, который #3 упускал: резтинг-лимит по уровню наливается, когда
цена ДОШЛА до уровня — независимо от того, отскочит потом (pullback) или пробьёт
насквозь (straight_break). #3 считал только pullback-исходы, т.е. выкинул
пробойные наливы (цена дошла до уровня и пробила → стоп). Живая лимитка их берёт.

Здесь считаем как реально торгует бот: ВСЕ квалифицированные касания (память +
быстрый подход), где цена дошла до уровня (reach_bar≥0) — ЛЮБОЙ исход, — лимит
от уровня 1.0/0.3, fill на reach_bar, no-overlap, held-out. И рядом — #3
(только pullback), чтобы видеть, сколько оптимизма он добавлял.

Запуск:  python verify_limit_signal.py --all --split-date 2026-04-01
"""
import argparse
import glob
import os
import re

import level_reaction_dataset as lr
from signal_blotter import _bars_from_cache
from backtest_level_strategy import _passes_memory, _precompute_limit, _limit_portfolio


def _run(rows, cost, split_date, title):
    print(f"\n{'='*66}\n{title}\n{'='*66}")
    _limit_portfolio(rows, cost, 1.0, 0.3, label="ВСЁ лимит 1.0/0.3")
    print("-- запас по издержкам --")
    for c in (0.08, 0.12, 0.16):
        _limit_portfolio(rows, c, 1.0, 0.3, label=f"cost={c}")
    tr = [r for r in rows if r.ts_msk[:10] < split_date]
    te = [r for r in rows if r.ts_msk[:10] >= split_date]
    print(f"-- held-out: train ({len(tr)}) | test≥ ({len(te)}) --")
    if tr and te:
        _limit_portfolio(tr, cost, 1.0, 0.3, label="TRAIN")
        _limit_portfolio(te, cost, 1.0, 0.3, label="TEST (held-out)")


def main():
    ap = argparse.ArgumentParser(description="Честный P&L живой лимит-стратегии (все квалиф. наливы)")
    ap.add_argument("--cache", default=os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                                    "data", "candle_cache"))
    ap.add_argument("--tickers", default="")
    ap.add_argument("--all", action="store_true")
    ap.add_argument("--cost-atr", type=float, default=0.12)
    ap.add_argument("--split-date", default="2026-04-01")
    args = ap.parse_args()

    if args.tickers:
        paths = [os.path.join(args.cache, f"{t.strip()}.json") for t in args.tickers.split(",") if t.strip()]
    elif args.all:
        paths = sorted(p for p in glob.glob(os.path.join(args.cache, "*.json"))
                       if not re.search(r"_\d+m\.json$", p))
    else:
        raise SystemExit("--tickers СПИСОК или --all")

    live_rows = []      # как торгует бот: все квалиф. касания с наливом, любой исход
    pull_rows = []      # #3: только pullback-исходы
    by_outcome = {"bounce": 0, "break": 0, "stall": 0}
    for p in paths:
        if not os.path.exists(p):
            continue
        bars = _bars_from_cache(p)
        if not bars:
            continue
        tk = os.path.basename(p)[:-5]
        try:
            touches = lr.collect(bars, round_valid_from=bars[0]["d"])
        except SystemExit:
            continue
        # квалификация как в live limit_sink (память + быстрый подход), налив если дошло
        qual = [t for t in touches if _passes_memory(t) and t.reach_bar >= 0]
        for t in qual:
            t.ticker = tk
            _precompute_limit(bars, t)
            by_outcome[t.result] = by_outcome.get(t.result, 0) + 1
        live_rows += qual
        pull_rows += [t for t in qual if t.signal == "pullback"]

    if not live_rows:
        raise SystemExit("нет квалиф. наливов — проверь кэш/период")

    print(f"наливов лимитки (все квалиф.): {len(live_rows)} | из них pullback (#3): {len(pull_rows)}")
    print(f"исходы наливов: bounce={by_outcome.get('bounce',0)} break={by_outcome.get('break',0)} "
          f"stall={by_outcome.get('stall',0)}")

    _run(live_rows, args.cost_atr, args.split_date,
         "ЖИВАЯ ЛИМИТКА — ВСЕ квалиф. наливы (любой исход) — как торгует бот")
    _run(pull_rows, args.cost_atr, args.split_date,
         "#3 (только pullback-исходы) — для сравнения, сколько оптимизма добавлял")


if __name__ == "__main__":
    main()
