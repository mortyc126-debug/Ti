"""ab_toggle_diag.py — одноразовая диагностика: почему ab_toggle.py даёт 0
тикеров с результатом. Гоняет run_backtest_one на одном тикере и печатает
СЫРЫЕ rows, чтобы понять — там пусто, error, или просто mode != 'fixed'."""

import argparse
import json
import os
import sys as _sys

# stub — как в dashboard.py, чтобы работало без установленного tinkoff
try:
    import tinkoff.invest  # noqa: F401
except ImportError:
    _stub = os.path.join(os.path.dirname(os.path.abspath(__file__)), "_tinkoff_stub")
    if _stub not in _sys.path:
        _sys.path.insert(0, _stub)

from dashboard import run_backtest_one


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("ticker")
    ap.add_argument("--days", type=int, default=60)
    ap.add_argument("--take", type=float, default=2.0)
    ap.add_argument("--stop", type=float, default=1.0)
    args = ap.parse_args()

    print(f"=== run_backtest_one({args.ticker!r}, days={args.days}, "
          f"take={args.take}, stop={args.stop}, disabled=[], inverted=[]) ===",
          file=_sys.stderr)
    res = run_backtest_one(args.ticker, args.days, [args.take], [args.stop],
                            disabled_methods=[], inverted_methods=[])
    print(f"type(res)={type(res).__name__}", file=_sys.stderr)
    if isinstance(res, tuple):
        print(f"len(tuple)={len(res)}", file=_sys.stderr)
        rows = res[0]
    else:
        rows = res
    print(f"type(rows)={type(rows).__name__}", file=_sys.stderr)
    if rows is None:
        print("rows is None — пусто", file=_sys.stderr); return
    try:
        n = len(rows)
    except TypeError:
        n = "?"
    print(f"len(rows)={n}", file=_sys.stderr)
    for i, r in enumerate(rows if isinstance(rows, list) else []):
        print(f"--- rows[{i}] ---", file=_sys.stderr)
        print(json.dumps(r, indent=2, default=str, ensure_ascii=False), file=_sys.stderr)


if __name__ == "__main__":
    main()
