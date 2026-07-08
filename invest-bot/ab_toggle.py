"""
ab_toggle.py — A/B чистки МЕТОДОВ: baseline (пустой toggle) vs вариант
(disabled/inverted из data/method_toggle_state.json или пресета).

Гоняет run_backtest_one по каждому тикеру ДВАЖДЫ (baseline и вариант) на
одном периоде/take/stop и пишет per-ticker метрики в CSV ИНКРЕМЕНТАЛЬНО
(flush после каждого тикера, append — не теряется при обрыве, варианты
копятся для сравнения). В конце — пул Δ WR/expectancy/avg_r.

Это про ЧИСТКУ МЕТОДОВ (изменение сигнала), не про баг-фиксы: у последних
метрика — «бот не падает», их A/B не мерит.

    python ab_toggle.py SBER,GAZP,LKOH --days 60
    python ab_toggle.py ALL --days 60 --out data/analysis/ab_toggle.csv
    python ab_toggle.py ALL --days 60 --preset "2. Чистка — текущая (11 инверсий + 7 выкл)"
    python ab_toggle.py SBER,GAZP --days 60 --resume   # догнать (пропустить уже в CSV)
"""
import argparse
import csv
import json
import os
import sys

# UTF-8 консоль — Windows cp1251 падает на минусе/кириллице
for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):
        pass

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

TOGGLE_FILE = os.path.join(HERE, "data", "method_toggle_state.json")
PRESETS_FILE = os.path.join(HERE, "data", "method_presets.json")


def _fmt(x):
    return f"{x:+.3f}" if isinstance(x, (int, float)) else "—"


def _load_variant(preset_name):
    """(disabled, inverted) — из пресета по имени или из method_toggle_state.json."""
    if preset_name:
        d = json.load(open(PRESETS_FILE, encoding="utf-8"))
        if preset_name not in d:
            sys.exit(f"нет пресета {preset_name!r}. Есть: {list(d)}")
        p = d[preset_name]
        return list(p.get("disabled") or []), list(p.get("inverted") or [])
    if os.path.exists(TOGGLE_FILE):
        t = json.load(open(TOGGLE_FILE, encoding="utf-8"))
        return list(t.get("disabled") or []), list(t.get("inverted") or [])
    return [], []


def _tickers(arg):
    if arg.upper() == "ALL":
        from dashboard import _strategy_settings_by_ticker
        return list(_strategy_settings_by_ticker().keys())
    return [t.strip().upper() for t in arg.split(",") if t.strip()]


def _metrics(res):
    """Из результата run_backtest_one достаём метрики fixed-режима.
    run_backtest_one отдаёт (rows, history[, trades]) — берём [0]."""
    rows = res[0] if isinstance(res, tuple) else res
    if not rows:
        return None
    row = next((r for r in rows if r.get("mode") == "fixed"), rows[0])
    if row.get("error"):
        return None
    return {
        "n_trades": row.get("n_trades", 0),
        "win_rate": row.get("win_rate"),
        "expectancy_pct": row.get("expectancy_pct"),
        "avg_r": row.get("avg_r"),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("tickers", help="тикер, список через запятую, или ALL")
    ap.add_argument("--days", type=int, default=60)
    ap.add_argument("--take", type=float, default=2.0, help="ATR take-множитель (default 2.0)")
    ap.add_argument("--stop", type=float, default=1.0, help="ATR stop-множитель (default 1.0)")
    ap.add_argument("--preset", default=None,
                    help="имя пресета из method_presets.json (иначе — текущий method_toggle_state.json)")
    ap.add_argument("--out", default="data/analysis/ab_toggle.csv")
    ap.add_argument("--resume", action="store_true",
                    help="пропустить тикеры, уже записанные в --out (догнать прерванный прогон)")
    args = ap.parse_args()

    dis, inv = _load_variant(args.preset)
    src = f"пресет «{args.preset}»" if args.preset else "method_toggle_state.json"
    print(f"вариант ({src}): disabled={len(dis)} inverted={len(inv)}", file=sys.stderr)

    from dashboard import run_backtest_one

    tickers = _tickers(args.tickers)

    out = args.out
    os.makedirs(os.path.dirname(out) or ".", exist_ok=True)
    done = set()
    if args.resume and os.path.exists(out):
        try:
            for r in csv.DictReader(open(out, encoding="utf-8")):
                done.add(r.get("ticker"))
        except (OSError, csv.Error):
            pass
        tickers = [t for t in tickers if t not in done]
        print(f"resume: пропущено {len(done)} тикеров, осталось {len(tickers)}", file=sys.stderr)

    print(f"тикеров: {len(tickers)}, дней: {args.days}, take={args.take} stop={args.stop}", file=sys.stderr)

    fields = ["ticker", "variant", "n_trades", "win_rate", "expectancy_pct", "avg_r", "preset", "days"]
    append = args.resume and os.path.exists(out) and os.path.getsize(out) > 0
    fp = open(out, "a" if append else "w", encoding="utf-8", newline="")
    w = csv.DictWriter(fp, fieldnames=fields)
    if not append:
        w.writeheader()

    agg = {"baseline": [], "variant": []}
    for i, tk in enumerate(tickers, 1):
        last = {}
        for label, (d, v) in (("baseline", ([], [])), ("variant", (dis, inv))):
            try:
                res = run_backtest_one(tk, args.days, [args.take], [args.stop],
                                       disabled_methods=d, inverted_methods=v)
                m = _metrics(res)
            except Exception as ex:
                print(f"[{i}/{len(tickers)}] {tk} {label}: ошибка {ex!r}", file=sys.stderr)
                m = None
            rec = {"ticker": tk, "variant": label,
                   "preset": (args.preset or "toggle_state"), "days": args.days}
            if m:
                rec.update(m)
                agg[label].append(m)
                last[label] = m
            w.writerow(rec)
            fp.flush()
        b, vv = last.get("baseline"), last.get("variant")
        print(f"[{i}/{len(tickers)}] {tk}: "
              f"WR base={_fmt(b and b.get('win_rate'))} var={_fmt(vv and vv.get('win_rate'))} | "
              f"exp% base={_fmt(b and b.get('expectancy_pct'))} var={_fmt(vv and vv.get('expectancy_pct'))}",
              file=sys.stderr)
    fp.close()

    def pool(lst, k):
        xs = [r[k] for r in lst if r.get(k) is not None]
        return sum(xs) / len(xs) if xs else None

    print(f"\nсводка: {out}", file=sys.stderr)
    print(f"=== ПУЛ (среднее по {len(agg['variant'])} тикерам с результатом) ===")
    for k in ("win_rate", "expectancy_pct", "avg_r"):
        b, v = pool(agg["baseline"], k), pool(agg["variant"], k)
        if b is not None and v is not None:
            print(f"{k:16} baseline={b:+.4f}  variant={v:+.4f}  Δ={v - b:+.4f}")
    nb = sum(r.get("n_trades", 0) for r in agg["baseline"])
    nv = sum(r.get("n_trades", 0) for r in agg["variant"])
    print(f"{'сделок':16} baseline={nb:<8} variant={nv}")
    print("Δ>0 у win_rate/expectancy → чистка ЛУЧШЕ baseline. "
          "Смотри expectancy, не только WR (инверсии меняют направление).")


if __name__ == "__main__":
    main()
