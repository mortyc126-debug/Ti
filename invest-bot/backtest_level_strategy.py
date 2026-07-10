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


def _all_pull_rows(bars, ticker):
    """Все pullback-касания с тикером (до combo-фильтра) — нужно для вариантов ниже."""
    try:
        touches = lr.collect(bars, round_valid_from=bars[0]["d"])
    except SystemExit:
        return []
    pull = [t for t in touches if t.signal == "pullback"]
    for r in pull:
        r.ticker = ticker
    return pull


def _passes_memory(r):
    """Общая часть combo-фильтра (быстрый подход + память), без условия на пенетрацию."""
    return r.approach_v6 >= 0.6 and (r.touches_before >= 1 or r.prev_outcome == "break")


# Сетки для перебора барьеров (в ATR)
GRID_TAKES = [0.5, 0.7, 1.0, 1.5, 2.0]
GRID_STOPS = [0.3, 0.5, 0.7, 1.0]


def _precompute_grid(bars, r):
    """Один проход по барам эпизода: для каждого тейка/стопа сетки запоминаем бар
    первого достижения — от ЦЕНЫ ВХОДА (закрытие бара подтверждения) и от УРОВНЯ.
    Кладём на row, чтобы дальше не держать бары в памяти (иначе --all съедает RAM).
    Тейк меряется по интрабар-экстремуму в свою сторону, стоп — против (реальный
    ордер, не по close)."""
    if r.entry_bar < 0 or r.atr <= 0 or r.day_end_bar >= len(bars):
        r._gE = r._gL = None
        return
    sgn = 1.0 if r.side == "support" else -1.0
    atr = r.atr
    entry = bars[r.entry_bar]["c"]
    lvl = r.level_price
    end = r.day_end_bar
    etp = {t: -1 for t in GRID_TAKES}; esl = {s: -1 for s in GRID_STOPS}
    ltp = {t: -1 for t in GRID_TAKES}; lsl = {s: -1 for s in GRID_STOPS}
    for j in range(r.entry_bar + 1, end + 1):
        hi, lo = bars[j]["h"], bars[j]["l"]
        fav = (hi if sgn > 0 else lo)   # экстремум в сторону сделки
        adv = (lo if sgn > 0 else hi)   # экстремум против
        favE = sgn * (fav - entry) / atr; advE = sgn * (adv - entry) / atr
        favL = sgn * (fav - lvl) / atr;   advL = sgn * (adv - lvl) / atr
        for t in GRID_TAKES:
            if etp[t] < 0 and favE >= t: etp[t] = j
            if ltp[t] < 0 and favL >= t: ltp[t] = j
        for s in GRID_STOPS:
            if esl[s] < 0 and advE <= -s: esl[s] = j
            if lsl[s] < 0 and advL <= -s: lsl[s] = j
    r._gE = (etp, esl, sgn * (bars[end]["c"] - entry) / atr, end)
    r._gL = (ltp, lsl, sgn * (bars[end]["c"] - lvl) / atr, end)


def _exit_grid(r, take, stop, anchor):
    """Выход (exit_bar, pnl_atr) по предпосчитанным барьерам. Тай в одном баре → стоп."""
    g = r._gE if anchor == "entry" else r._gL
    if g is None:
        return None
    tp_bar, sl_bar = g[0][take], g[1][stop]
    if sl_bar >= 0 and (tp_bar < 0 or sl_bar <= tp_bar):
        return sl_bar, -stop
    if tp_bar >= 0:
        return tp_bar, take
    return g[3], g[2]   # тайм-стоп на закрытии дня


def _grid_portfolio(rows, cost, take, stop, anchor):
    """No-overlap портфель для (take, stop, anchor). Возвращает (n, exp, win%)."""
    by_tk = {}
    for r in rows:
        by_tk.setdefault(r.ticker, []).append(r)
    n, tot, wins = 0, 0.0, 0
    for rs in by_tk.values():
        rs.sort(key=lambda r: r.entry_bar)
        free_at = -1
        for r in rs:
            if r.entry_bar <= free_at:
                continue
            res = _exit_grid(r, take, stop, anchor)
            if res is None:
                continue
            ebar, pnl = res
            net = pnl - cost
            tot += net
            wins += 1 if net > 0 else 0
            free_at = ebar
            n += 1
    exp = tot / n if n else 0.0
    wr = 100 * wins / n if n else 0.0
    return n, exp, wr


def _print_grid(rows, cost, anchor, title):
    """Матрица exp/win% по сетке тейк×стоп для заданной базы (вход/уровень)."""
    print(f"\n{'='*70}\n{title}\n{'='*70}")
    hdr = "тейк\\стоп"
    print(f"{hdr:<10}" + "".join(f"{'S='+str(s):>14}" for s in GRID_STOPS))
    n0 = 0
    for take in GRID_TAKES:
        cells = []
        for stop in GRID_STOPS:
            n, exp, wr = _grid_portfolio(rows, cost, take, stop, anchor)
            n0 = max(n0, n)
            cells.append(f"{exp:+.2f}/{wr:.0f}%")
        print(f"    T={take:<6}" + "".join(f"{c:>14}" for c in cells))
    print(f"    (N≈{n0}; ячейка = exp ATR / win%, за вычетом cost={cost})")


# ── ЧЕСТНЫЙ ЛИМИТ У УРОВНЯ: fill на баре касания, барьеры от уровня ────────────
def _precompute_limit(bars, r):
    """Лимит по уровню: fill на баре первого касания (reach_bar). Барьеры тейк/стоп
    от УРОВНЯ, first-passage считаем с бара ПОСЛЕ филла (интрабар-путь филл-бара
    неизвестен, поэтому его пропускаем — так честнее). Кладём на row."""
    if r.reach_bar < 0 or r.atr <= 0 or r.day_end_bar >= len(bars):
        r._gLim = None
        return
    sgn = 1.0 if r.side == "support" else -1.0
    atr = r.atr
    lvl = r.level_price
    end = r.day_end_bar
    ltp = {t: -1 for t in GRID_TAKES}; lsl = {s: -1 for s in GRID_STOPS}
    for j in range(r.reach_bar + 1, end + 1):
        hi, lo = bars[j]["h"], bars[j]["l"]
        fav = sgn * ((hi if sgn > 0 else lo) - lvl) / atr
        adv = sgn * ((lo if sgn > 0 else hi) - lvl) / atr
        for t in GRID_TAKES:
            if ltp[t] < 0 and fav >= t: ltp[t] = j
        for s in GRID_STOPS:
            if lsl[s] < 0 and adv <= -s: lsl[s] = j
    r._gLim = (ltp, lsl, sgn * (bars[end]["c"] - lvl) / atr, end)


def _limit_exit(r, take, stop):
    """(exit_bar, pnl_atr) для лимит-входа. Тай в баре → стоп."""
    g = getattr(r, "_gLim", None)
    if g is None:
        return None
    tp_bar, sl_bar = g[0][take], g[1][stop]
    if sl_bar >= 0 and (tp_bar < 0 or sl_bar <= tp_bar):
        return sl_bar, -stop
    if tp_bar >= 0:
        return tp_bar, take
    return g[3], g[2]


def _limit_portfolio(rows, cost, take, stop, quiet=False, label=""):
    """No-overlap по reach_bar (одна лимит-позиция на инструмент). Возвращает
    (n, exp, total, win%, trades)."""
    by_tk = {}
    for r in rows:
        if getattr(r, "_gLim", None) is None:
            continue
        by_tk.setdefault(r.ticker, []).append(r)
    n, tot, wins, trades = 0, 0.0, 0, []
    for rs in by_tk.values():
        rs.sort(key=lambda r: r.reach_bar)
        free_at = -1
        for r in rs:
            if r.reach_bar <= free_at:
                continue
            res = _limit_exit(r, take, stop)
            if res is None:
                continue
            ebar, pnl = res
            net = pnl - cost
            tot += net
            wins += 1 if net > 0 else 0
            free_at = ebar
            n += 1
            trades.append((r, net))
    exp = tot / n if n else 0.0
    wr = 100 * wins / n if n else 0.0
    if not quiet:
        print(f"{label:<26} N={n:<5} exp={exp:+.3f}  Σ={tot:+.1f} ATR  win={wr:.0f}%  (тейк{take}/стоп{stop})")
    return n, exp, tot, wr, trades


def _print_limit_grid(rows, cost, title):
    """Сетка тейк×стоп для честного лимит-входа."""
    print(f"\n{'='*70}\n{title}\n{'='*70}")
    hdr = "тейк\\стоп"
    print(f"{hdr:<10}" + "".join(f"{'S='+str(s):>14}" for s in GRID_STOPS))
    n0 = 0
    for take in GRID_TAKES:
        cells = []
        for stop in GRID_STOPS:
            n, exp, _, wr, _ = _limit_portfolio(rows, cost, take, stop, quiet=True)
            n0 = max(n0, n)
            cells.append(f"{exp:+.2f}/{wr:.0f}%")
        print(f"    T={take:<6}" + "".join(f"{c:>14}" for c in cells))
    print(f"    (N≈{n0}; ячейка = exp ATR / win%, за вычетом cost={cost})")


def _portfolio(rows, cost, label, quiet=False, from_level=False):
    """No-overlap: одна позиция на инструмент за раз (по entry/exit-бару). Возвращает
    (n, exp, total, win%, trades[]). quiet=True — не печатать строку (для ранжира).
    from_level=True — старый расчёт (P&L от цены уровня, завышает); по умолчанию
    книжим от РЕАЛЬНОГО входа: вычитаем entry_offset_atr (сдвиг филла от уровня)."""
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
            if not from_level:
                pnl -= r.entry_offset_atr   # барьеры мерятся от уровня → переводим в P&L от филла
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
    ap.add_argument("--no-grid", action="store_true", help="не считать сетки #1/#2 (быстрее)")
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

    all_rows = []          # combo (penetration<0) — как торгует бот
    reached_rows = []      # тот же сигнал, но цена ДОШЛА до уровня (penetration>=0)
    for p in paths:
        if not os.path.exists(p):
            print(f"нет файла: {p}")
            continue
        ticker = os.path.basename(p)[:-5]
        bars = _bars_from_cache(p)
        if not bars:
            continue
        pull = _all_pull_rows(bars, ticker)
        combo = [r for r in pull if _passes_memory(r) and r.penetration_atr < 0]
        reached = [r for r in pull if _passes_memory(r) and r.penetration_atr >= 0]
        if not args.no_grid:  # предпосчитать барьеры, пока бары в памяти
            for r in combo + reached:
                _precompute_grid(bars, r)
            for r in reached:   # честный лимит-вход (fill на баре касания)
                _precompute_limit(bars, r)
        all_rows += combo
        reached_rows += reached
        print(f"{ticker}: combo-входов {len(combo)} (дошло-до-уровня {len(reached)})")

    if not all_rows:
        raise SystemExit("combo-входов не собрано — проверь кэш/период")

    print(f"\n{'='*70}\nБЭКТЕСТ LevelReactionStrategy (combo, тейк/стоп {TAKE}/{STOP}, cost={args.cost_atr})")
    print(f"P&L от РЕАЛЬНОЙ цены входа (закрытие бара подтверждения), не от уровня\n{'='*70}")
    _portfolio(all_rows, args.cost_atr, "ВСЁ (от уровня, старый)", from_level=True)
    _, _, _, _, trades = _portfolio(all_rows, args.cost_atr, "ВСЁ (от входа, честный)")

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

    if not args.no_grid:
        # #1 — TP/SL переякорены на ЦЕНУ ВХОДА (а не уровень). Если хоть одна ячейка
        # стабильно плюсовая — у combo-сигнала есть эдж при своём соотношении барьеров.
        _print_grid(all_rows, args.cost_atr, "entry",
                    "#1 TP/SL ОТ ЦЕНЫ ВХОДА — сетка тейк×стоп (combo, вход по рынку)")

        # #2 — ПРИБЛИЖЁННЫЙ лимит: выход считается от бара подтверждения (быстрая прикидка).
        print(f"\n-- #2: касаний 'дошло до уровня' (penetration>=0): {len(reached_rows)} "
              f"против combo {len(all_rows)} --")
        if reached_rows:
            _portfolio(reached_rows, args.cost_atr, "ЛИМИТ (приближ., от confirm)", from_level=True)
            _print_grid(reached_rows, args.cost_atr, "level",
                        "#2 ЛИМИТ У УРОВНЯ (ПРИБЛИЖ.) — сетка тейк×стоп")

        # #3 — ЧЕСТНЫЙ лимит: fill на баре первого касания уровня (reach_bar), барьеры
        # от уровня, выход с бара ПОСЛЕ филла. Held-out + запас по издержкам + ранжир.
        if reached_rows:
            print(f"\n{'='*70}\n#3 ЧЕСТНЫЙ ЛИМИТ У УРОВНЯ (fill на баре касания)\n{'='*70}")
            _limit_portfolio(reached_rows, args.cost_atr, 1.0, 0.3, label="ВСЁ лимит 1.0/0.3")

            print("-- запас прочности по издержкам (1.0/0.3) --")
            for c in (0.08, 0.12, 0.16, 0.20):
                _limit_portfolio(reached_rows, c, 1.0, 0.3, label=f"cost={c}")

            ltrain = [r for r in reached_rows if r.ts_msk[:10] < args.split_date]
            ltest = [r for r in reached_rows if r.ts_msk[:10] >= args.split_date]
            print(f"-- held-out: train ({len(ltrain)}) | test≥{args.split_date} ({len(ltest)}) --")
            if ltrain and ltest:
                _limit_portfolio(ltrain, args.cost_atr, 1.0, 0.3, label="TRAIN лимит")
                _limit_portfolio(ltest, args.cost_atr, 1.0, 0.3, label="TEST лимит (held-out)")

            _print_limit_grid(reached_rows, args.cost_atr,
                              "#3 ЧЕСТНЫЙ ЛИМИТ — сетка тейк×стоп (fill на касании)")

            # ранжир по тикерам (по held-out test exp) — где эдж реально живёт
            lby: dict[str, list] = {}
            for r in reached_rows:
                lby.setdefault(r.ticker, []).append(r)
            lrank = []
            for tk, rs in lby.items():
                te = [r for r in rs if r.ts_msk[:10] >= args.split_date]
                n, exp, _, wr, _ = _limit_portfolio(rs, args.cost_atr, 1.0, 0.3, quiet=True)
                tn, texp, _, twr, _ = (_limit_portfolio(te, args.cost_atr, 1.0, 0.3, quiet=True)
                                       if te else (0, 0.0, 0.0, 0.0, []))
                lrank.append((tk, n, exp, wr, tn, texp, twr))
            lrank.sort(key=lambda x: (x[5], x[2]), reverse=True)
            print(f"\n#3 РАНЖИР ЛИМИТ по held-out test exp (топ-40 из {len(lrank)}):")
            print(f"{'тикер':<10}{'N':>6}{'exp':>9}{'win%':>7}  | {'testN':>6}{'test_exp':>10}{'test_win%':>10}")
            for tk, n, exp, wr, tn, texp, twr in lrank[:40]:
                print(f"{tk:<10}{n:>6}{exp:>+9.3f}{wr:>6.0f}%  | {tn:>6}{texp:>+10.3f}{twr:>9.0f}%")

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
