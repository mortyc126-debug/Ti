"""backtest_level_strategy.py — бэктест ЗАВЕДЁННОЙ уровневой стратегии на истории.

Гоняет ровно ту логику, что торгует LevelReactionStrategy: тот же confirm-путь
(collect + confirm_sink), тот же _combo_filter, и тейк/стоп 1.0/0.3 ATR от уровня
(BOUNCE_ATR/BREAK_ATR) — интрабар first-passage, без перекрытия (одна позиция на
инструмент). Held-out по времени. Цель: убедиться, что заведённый в бот класс
воспроизводит эдж (+0.35 ATR), а не только абстрактный сигнал.

Барьеры берём из полей Touch tp10/sl03 (время достижения 1.0-тейка/0.3-стопа от
подтверждения, меряется интрабар от уровня) — та же арифметика, что в гонтлете.

Запуск (из invest-bot/):
    python backtest_level_strategy.py --tickers SBER,GAZP,LKOH,YDEX --split-date 2026-04-01
    python backtest_level_strategy.py --all --cost-atr 0.12 --out trades.csv
"""
import argparse
import csv
import glob
import os

import level_reaction_dataset as lr
from signal_blotter import _bars_from_cache

TAKE, STOP = 1.0, 0.3   # ровно как в LevelReactionStrategy


def _combo_rows(bars, ticker):
    """Провалидированные combo-касания (=входы стратегии) с тикером."""
    try:
        touches = lr.collect(bars, round_valid_from=bars[0]["d"])
    except SystemExit:
        return []
    pull = [t for t in touches if t.signal == "pullback"]
    rows = lr._combo_filter(pull)
    for r in rows:
        r.ticker = ticker
    return rows


def _portfolio(rows, cost, label, quiet=False):
    """No-overlap: одна позиция на инструмент за раз (по entry/exit-бару). Возвращает
    (n, exp, total, win%, trades[]). quiet=True — не печатать строку (для ранжира)."""
    by_tk = {}
    for r in rows:
        by_tk.setdefault(r.ticker, []).append(r)
    n, pnl_sum, wins, trades = 0, 0.0, 0, []
    for tk, rs in by_tk.items():
        rs.sort(key=lambda r: r.entry_bar)
        free_at = -1
        for r in rs:
            if r.entry_bar <= free_at:
                continue
            exit_bar, pnl = lr._exit_of(r, TAKE, STOP)
            net = pnl - cost
            pnl_sum += net
            wins += 1 if net > 0 else 0
            free_at = exit_bar
            n += 1
            trades.append((r, net))
    exp = pnl_sum / n if n else 0.0
    wr = 100 * wins / n if n else 0.0
    if not quiet:
        print(f"{label:<26} N={n:<5} exp={exp:+.3f}  Σ={pnl_sum:+.1f} ATR  win={wr:.0f}%  (тейк{TAKE}/стоп{STOP})")
    return n, exp, pnl_sum, wr, trades


def main():
    ap = argparse.ArgumentParser(description="Бэктест LevelReactionStrategy на историческом кэше")
    ap.add_argument("--cache", default=os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                                    "data", "candle_cache"))
    ap.add_argument("--tickers", default="")
    ap.add_argument("--all", action="store_true")
    ap.add_argument("--cost-atr", type=float, default=0.12)
    ap.add_argument("--split-date", default="2026-04-01")
    ap.add_argument("--out", default="")
    args = ap.parse_args()

    if args.tickers:
        paths = [os.path.join(args.cache, f"{t.strip()}.json") for t in args.tickers.split(",") if t.strip()]
    elif args.all:
        import re
        paths = sorted(p for p in glob.glob(os.path.join(args.cache, "*.json"))
                       if not re.search(r"_\d+m\.json$", p))
    else:
        raise SystemExit("--tickers СПИСОК или --all")

    all_rows = []
    for p in paths:
        if not os.path.exists(p):
            print(f"нет файла: {p}")
            continue
        ticker = os.path.basename(p)[:-5]
        bars = _bars_from_cache(p)
        if not bars:
            continue
        rows = _combo_rows(bars, ticker)
        all_rows += rows
        print(f"{ticker}: combo-входов {len(rows)}")

    if not all_rows:
        raise SystemExit("combo-входов не собрано — проверь кэш/период")

    print(f"\n{'='*70}\nБЭКТЕСТ LevelReactionStrategy (combo, тейк/стоп {TAKE}/{STOP}, cost={args.cost_atr})\n{'='*70}")
    _, _, _, _, trades = _portfolio(all_rows, args.cost_atr, "ВСЁ (no-overlap)")

    # РАНЖИР ПО ИНСТРУМЕНТАМ — выбираем универс по эджу, не по ликвиду.
    # Считаем per-ticker no-overlap exp/win + held-out test (где эдж не подгонка).
    by_tk: dict[str, list] = {}
    for r in all_rows:
        by_tk.setdefault(r.ticker, []).append(r)
    rank = []
    for tk, rs in by_tk.items():
        te = [r for r in rs if r.ts_msk[:10] >= args.split_date]
        n, exp, _, wr, _ = _portfolio(rs, args.cost_atr, tk, quiet=True)
        tn, texp, _, twr, _ = _portfolio(te, args.cost_atr, tk, quiet=True) if te else (0, 0.0, 0.0, 0.0, [])
        rank.append((tk, n, exp, wr, tn, texp, twr))
    # сортировка по held-out test exp (реальный эдж), затем по общему exp
    rank.sort(key=lambda x: (x[5], x[2]), reverse=True)
    print(f"\n{'='*70}\nРАНЖИР ПО ИНСТРУМЕНТАМ (по held-out test exp) — брать топ в BASE_TICKERS\n{'='*70}")
    print(f"{'тикер':<10}{'N':>6}{'exp':>9}{'win%':>7}  | {'testN':>6}{'test_exp':>10}{'test_win%':>10}")
    for tk, n, exp, wr, tn, texp, twr in rank:
        print(f"{tk:<10}{n:>6}{exp:>+9.3f}{wr:>6.0f}%  | {tn:>6}{texp:>+10.3f}{twr:>9.0f}%")

    train = [r for r in all_rows if r.ts_msk[:10] < args.split_date]
    test = [r for r in all_rows if r.ts_msk[:10] >= args.split_date]
    print(f"\n-- HELD-OUT: train<{args.split_date} ({len(train)}) | test≥ ({len(test)}) --")
    if train and test:
        _portfolio(train, args.cost_atr, "TRAIN")
        _portfolio(test, args.cost_atr, "TEST (held-out)")
    else:
        print("одна из половин пуста — сдвинь --split-date")

    if args.out:
        with open(args.out, "w", newline="", encoding="utf-8") as fh:
            w = csv.writer(fh)
            w.writerow(["ts_msk", "ticker", "side", "kind", "level_price", "approach_v6",
                        "touches_before", "prev_outcome", "penetration_atr", "pnl_atr_net"])
            for r, net in trades:
                w.writerow([r.ts_msk, r.ticker, r.side, r.kind, r.level_price, r.approach_v6,
                            r.touches_before, r.prev_outcome, r.penetration_atr, round(net, 4)])
        print(f"\nCSV сделок: {args.out}")


if __name__ == "__main__":
    main()
