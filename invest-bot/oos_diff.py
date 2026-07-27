"""
oos_diff.py — валидация edge методов через out-of-sample сравнение.

Идея простая: гоняем score_methods.py дважды на непересекающихся временных
окнах (train — прошлое, test — свежее) на одном и том же универсе (топ-N
по ликвидности). Смотрим по клеткам метод × режим:
  - aligned  — знак d и в train, и в test сохранился, сила близка → надёжный edge
  - stronger — знак тот же, в test даже сильнее → устойчивый / усилился
  - weaker   — знак тот же, но в test слабее → возможно теряет силу
  - DIVERGE  — знак тот же, |Δd|>threshold → нестабильная сила
  - ★FLIP★   — знак поменялся → переобучение in-sample ИЛИ смена режима

Если ★FLIP★ мало (≤10% клеток) — методы в целом честные. Если много —
BASELINE-вердикты сильно завязаны на конкретный период и в бота их лучше
не тащить без пересчёта.

По умолчанию: --top-liq 50, окна берутся от последней даты в кэше:
  train = [end - train_days - test_days, end - test_days]
  test  = [end - test_days, end]
train_days=365, test_days=120 → полтора года истории на 4-месячный OOS.

Использование:
  python oos_diff.py                          # дефолт: 365 train / 120 test
  python oos_diff.py --train-days 540 --test-days 180 --stride 5
  python oos_diff.py --top-liq 30 --stride 10 --skip-run   # только пересчёт, если CSV уже есть
"""

from __future__ import annotations

import argparse
import csv
import os
import statistics
import subprocess
import sys
from datetime import datetime, timedelta

HERE = os.path.dirname(os.path.abspath(__file__))
REGIMES = ["ALL", "trending_up", "trending_down", "ranging", "high_vol", "low_vol", "stress"]


def _find_latest_date(cache_dir: str) -> str | None:
    """Ищет самый свежий bar[-1].time среди всех json'ов в кэше (5-мин)."""
    if not os.path.isdir(cache_dir):
        return None
    import json
    latest = None
    for name in os.listdir(cache_dir):
        if not name.endswith(".json") or name.endswith("_1m.json"):
            continue
        p = os.path.join(cache_dir, name)
        try:
            with open(p, "r", encoding="utf-8") as f:
                rows = json.load(f)
            if not rows:
                continue
            t = rows[-1]["time"][:10]
            if latest is None or t > latest:
                latest = t
        except Exception:
            continue
    return latest


def _run_scores(out_csv: str, date_from: str, date_to: str,
                top_liq: int, stride: int, workers: int,
                min_vol: float, max_vol: float, extra: list) -> None:
    cmd = [
        sys.executable, os.path.join(HERE, "score_methods.py"),
        "ALL", "--by-regime",
        "--top-liq", str(top_liq),
        "--min-vol-pctl", str(min_vol),
        "--max-vol-pctl", str(max_vol),
        "--stride", str(stride),
        "--workers", str(workers),
        "--from", date_from, "--to", date_to,
        "--out", out_csv,
    ]
    cmd.extend(extra)
    print(f"[oos_diff] запуск: {' '.join(cmd[len(cmd)-11:])}", file=sys.stderr)
    subprocess.check_call(cmd, cwd=HERE)


def _load_cells(csv_path: str, min_fires: int) -> dict:
    """Из per-ticker CSV собирает {(method, regime): {'d': [...], 'nf_sum': int}}
    только по клеткам с n_fires >= min_fires."""
    if not os.path.exists(csv_path):
        return {}
    by = {}
    with open(csv_path, "r", encoding="utf-8", newline="") as f:
        for row in csv.DictReader(f):
            try:
                d = float(row["d"]) if row["d"] not in ("", "n/a") else None
                nf = int(row["n_fires"] or 0)
            except Exception:
                continue
            if d is None or nf < min_fires:
                continue
            key = (row["method"], row["regime"])
            slot = by.setdefault(key, {"d": [], "nf": 0})
            slot["d"].append(d)
            slot["nf"] += nf
    return by


def _cell(store: dict, m: str, r: str, min_tk: int):
    slot = store.get((m, r))
    if not slot:
        return None, 0, 0
    ds = slot["d"]
    if len(ds) < min_tk:
        return None, len(ds), slot["nf"]
    return statistics.median(ds), len(ds), slot["nf"]


def _classify(train_d: float, test_d: float, flip_min: float, diverge_min: float, aligned_slack: float) -> str:
    if train_d * test_d < 0 and abs(train_d) > flip_min and abs(test_d) > flip_min:
        return "★FLIP★"
    dd = test_d - train_d
    if abs(dd) > diverge_min:
        return "DIVERGE"
    if abs(test_d) > abs(train_d) + aligned_slack:
        return "stronger"
    if abs(train_d) > abs(test_d) + aligned_slack:
        return "weaker"
    return "aligned"


def _print_diff(train: dict, test: dict, min_tk: int, out_txt: str | None) -> None:
    methods = sorted({m for m, _ in train.keys()} | {m for m, _ in test.keys()})
    lines = []
    lines.append("=== OOS-дифф train vs test (по клеткам с n_tk >= %d в обоих) ===" % min_tk)
    lines.append("флаги: FLIP = знак другой; DIVERGE = |Δd|>0.10; STRONGER/WEAKER — сохранил знак; ALIGNED — стабилен")
    lines.append("")
    lines.append(f"{'метод':<22} {'режим':<14} {'TRN d':>7} {'TRN tk':>4}  {'TST d':>7} {'TST tk':>4}  {'Δd':>7}  {'nf(t)':>7} {'nf(T)':>7}  флаг")
    lines.append("-" * 108)

    cnt = {"aligned": 0, "stronger": 0, "weaker": 0, "DIVERGE": 0, "★FLIP★": 0}
    flips, diverges = [], []
    for m in methods:
        for reg in REGIMES:
            if reg == "ALL":
                continue
            td, ttk, tnf = _cell(train, m, reg, min_tk)
            xd, xtk, xnf = _cell(test, m, reg, min_tk)
            if td is None or xd is None:
                continue
            flag = _classify(td, xd, flip_min=0.03, diverge_min=0.10, aligned_slack=0.03)
            cnt[flag] += 1
            if flag in ("★FLIP★", "DIVERGE", "stronger", "weaker"):
                lines.append(f"{m:<22} {reg:<14} {td:+7.3f} {ttk:>4}  {xd:+7.3f} {xtk:>4}  {xd-td:+7.3f}  {tnf:>7} {xnf:>7}  {flag}")
                if flag == "★FLIP★":
                    flips.append((m, reg, td, xd))
                elif flag == "DIVERGE":
                    diverges.append((m, reg, td, xd, xd-td))

    total = sum(cnt.values()) or 1
    lines.append("")
    lines.append("=== ИТОГ ===")
    for k in ["aligned", "stronger", "weaker", "DIVERGE", "★FLIP★"]:
        lines.append(f"  {k:<10} {cnt[k]:>4}  ({100.0*cnt[k]/total:5.1f}%)")
    flip_share = 100.0 * cnt["★FLIP★"] / total
    lines.append("")
    if flip_share <= 5:
        lines.append(f"вывод: FLIP-доля {flip_share:.1f}% ≤ 5% — методы устойчивы, BASELINE можно применять в боте.")
    elif flip_share <= 15:
        lines.append(f"вывод: FLIP-доля {flip_share:.1f}% в зоне 5-15% — большинство методов устойчиво, но перечисленные FLIP-клетки не тащить в MODS.")
    else:
        lines.append(f"вывод: FLIP-доля {flip_share:.1f}% > 15% — BASELINE сильно завязан на train-период, MODS без пересчёта опасно.")

    text = "\n".join(lines)
    print(text)
    if out_txt:
        with open(out_txt, "w", encoding="utf-8") as f:
            f.write(text + "\n")


def main() -> None:
    ap = argparse.ArgumentParser(description="OOS-дифф методов через два прогона score_methods по разным датам")
    ap.add_argument("--train-days", type=int, default=365, help="Длина train-окна в календарных днях (default 365)")
    ap.add_argument("--test-days", type=int, default=120, help="Длина test-окна в календарных днях (default 120)")
    ap.add_argument("--top-liq", type=int, default=50, help="Универс: топ-N ликвидных тикеров (default 50)")
    ap.add_argument("--min-vol-pctl", type=float, default=10.0, help="Нижний перцентиль по vol (default 10)")
    ap.add_argument("--max-vol-pctl", type=float, default=95.0, help="Верхний перцентиль по vol (default 95)")
    ap.add_argument("--stride", type=int, default=5, help="Шаг для score_methods (default 5)")
    ap.add_argument("--workers", type=int, default=8)
    ap.add_argument("--min-fires", type=int, default=30, help="Порог n_fires на тикере для попадания клетки в дифф")
    ap.add_argument("--min-tk", type=int, default=5, help="Порог n_tickers в клетке для сравнения (default 5)")
    ap.add_argument("--out-dir", default=os.path.join("data", "analysis", "oos"))
    ap.add_argument("--skip-run", action="store_true", help="Не запускать score_methods заново, взять готовые CSV из out-dir")
    ap.add_argument("--methods", default=None, help="Подмножество методов через запятую (проброс в score_methods)")
    args = ap.parse_args()

    out_dir = os.path.join(HERE, args.out_dir)
    os.makedirs(out_dir, exist_ok=True)
    train_csv = os.path.join(out_dir, "train.csv")
    test_csv = os.path.join(out_dir, "test.csv")
    diff_txt = os.path.join(out_dir, "diff.txt")

    latest = _find_latest_date(os.path.join(HERE, "data", "candle_cache"))
    if not latest:
        sys.exit("не нашёл ни одного bar в data/candle_cache/*.json")
    end = datetime.strptime(latest, "%Y-%m-%d").date()
    test_from = (end - timedelta(days=args.test_days)).isoformat()
    train_to = test_from
    train_from = (end - timedelta(days=args.test_days + args.train_days)).isoformat()

    print(f"[oos_diff] end={latest}", file=sys.stderr)
    print(f"[oos_diff] train: {train_from} .. {train_to}   ({args.train_days} дн)", file=sys.stderr)
    print(f"[oos_diff] test:  {test_from} .. {latest}   ({args.test_days} дн)", file=sys.stderr)

    extra = []
    if args.methods:
        extra.extend(["--methods", args.methods])

    if not args.skip_run:
        _run_scores(train_csv, train_from, train_to,
                     args.top_liq, args.stride, args.workers,
                     args.min_vol_pctl, args.max_vol_pctl, extra)
        _run_scores(test_csv, test_from, latest,
                     args.top_liq, args.stride, args.workers,
                     args.min_vol_pctl, args.max_vol_pctl, extra)
    elif not (os.path.exists(train_csv) and os.path.exists(test_csv)):
        sys.exit(f"--skip-run требует {train_csv} и {test_csv}")

    train = _load_cells(train_csv, min_fires=args.min_fires)
    test = _load_cells(test_csv, min_fires=args.min_fires)
    _print_diff(train, test, min_tk=args.min_tk, out_txt=diff_txt)


if __name__ == "__main__":
    main()
