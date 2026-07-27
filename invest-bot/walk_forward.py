"""
walk_forward.py — стабильность edge методов по времени.

Идея: скользящее окно N дней, K окон подряд (с шагом step_days). В каждом
окне гоняем score_methods.py на одном и том же универсе (топ-N ликвид),
собираем d_median по клеткам метод × режим. Итог — матрица метод × окно
с классификацией устойчивости:
  - stable   — знак d одинаковый во всех окнах И std(d) < mean(|d|)/2
  - drift    — знак одинаковый, но сила гуляет (std > mean/2)
  - noise    — знак пляшет; edge не эдж, а шум периода

Читается плоско: если в списке «stable» есть FVG, ZSCORE, TALIB_ANTISIGNAL
— это реальные эдж-методы, а не переобучение на один период. Если чей-то
статус — «noise», значит его положительный d в BASELINE был случайностью
конкретного окна.

По умолчанию: 8 окон по 90 дней, шаг 45 дней (полу-перекрытие). При
`--windows N --window-days D --step-days S` первое окно кончается сегодня,
дальше сдвигается назад.

Использование:
  python walk_forward.py                                # 8×90д, шаг 45д, топ-50, --stride 10
  python walk_forward.py --windows 12 --window-days 60 --step-days 30
  python walk_forward.py --skip-run                     # только пересчёт по готовым CSV
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
    print(f"[walk_fw] {date_from}..{date_to}", file=sys.stderr)
    subprocess.check_call(cmd, cwd=HERE)


def _load_matrix(csv_path: str, min_fires: int, min_tk: int) -> dict:
    """{(method, regime): d_median} — только по клеткам с достаточным n_tk."""
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
            by.setdefault((row["method"], row["regime"]), []).append(d)
    out = {}
    for k, ds in by.items():
        if len(ds) < min_tk:
            continue
        out[k] = statistics.median(ds)
    return out


def _classify_series(ds: list) -> str:
    """stable / drift / noise / mixed по серии d_median подряд идущих окон."""
    if not ds or len(ds) < 3:
        return "мало окон"
    signs = [(+1 if x > 0.03 else -1 if x < -0.03 else 0) for x in ds]
    nz = [s for s in signs if s != 0]
    if not nz:
        return "noise (все в нейтрали)"
    pos = sum(1 for s in nz if s > 0)
    neg = sum(1 for s in nz if s < 0)
    dominant_share = max(pos, neg) / len(nz)
    if dominant_share < 0.75:
        return "noise (знак пляшет)"
    same_sign = [d for d in ds if (d > 0) == (pos > neg)]
    if not same_sign:
        return "noise (знак пляшет)"
    m = sum(abs(d) for d in same_sign) / len(same_sign)
    if len(same_sign) >= 2:
        sd = statistics.stdev(same_sign)
        if sd > m / 2:
            return "drift (сила гуляет)"
    return "stable"


def _print_matrix(matrices: list, window_labels: list, out_txt: str | None) -> None:
    methods = sorted({m for mx in matrices for (m, _) in mx.keys()})
    lines = []
    lines.append(f"=== walk-forward: {len(matrices)} окон, регион ALL (сначала — свежее) ===")
    lines.append("Классификация: stable — знак и сила стабильны; drift — знак тот же, сила гуляет; noise — знак пляшет между окнами.")
    lines.append("")
    header = f"{'метод':<22}" + "".join(f"{lbl:>10}" for lbl in window_labels) + f"  {'класс':<24}"
    lines.append(header)
    lines.append("-" * len(header))
    stable, drift, noise = [], [], []
    for m in methods:
        series = [mx.get((m, "ALL")) for mx in matrices]
        vals = [x for x in series if x is not None]
        cls = _classify_series(vals)
        cells = "".join(f"{(x if x is not None else 0):>+10.3f}" if x is not None else f"{'—':>10}" for x in series)
        lines.append(f"{m:<22}{cells}  {cls}")
        if cls == "stable":
            stable.append(m)
        elif cls.startswith("drift"):
            drift.append(m)
        elif cls.startswith("noise"):
            noise.append(m)

    lines.append("")
    lines.append("=== СВОДКА (по ALL-разрезу) ===")
    lines.append(f"  stable ({len(stable)}): {', '.join(stable)}")
    lines.append(f"  drift  ({len(drift)}): {', '.join(drift)}")
    lines.append(f"  noise  ({len(noise)}): {', '.join(noise)}")
    lines.append("")
    lines.append("Читай: методы в stable — реальный эдж, живёт во всех окнах. Методы в noise —")
    lines.append("BASELINE-положительный d был случайностью, в бота такой метод тащить нельзя.")

    text = "\n".join(lines)
    print(text)
    if out_txt:
        with open(out_txt, "w", encoding="utf-8") as f:
            f.write(text + "\n")


def main() -> None:
    ap = argparse.ArgumentParser(description="Walk-forward стабильности методов по скользящим окнам")
    ap.add_argument("--windows", type=int, default=8, help="Количество окон (default 8)")
    ap.add_argument("--window-days", type=int, default=90, help="Длина одного окна (default 90 календарных дней)")
    ap.add_argument("--step-days", type=int, default=45, help="Шаг между окнами (default 45 — окна пере полу-перекрываются)")
    ap.add_argument("--top-liq", type=int, default=50)
    ap.add_argument("--min-vol-pctl", type=float, default=10.0)
    ap.add_argument("--max-vol-pctl", type=float, default=95.0)
    ap.add_argument("--stride", type=int, default=10, help="Шаг для score_methods (default 10 — быстрее, точность d в окне 90д всё равно есть)")
    ap.add_argument("--workers", type=int, default=8)
    ap.add_argument("--min-fires", type=int, default=30)
    ap.add_argument("--min-tk", type=int, default=5)
    ap.add_argument("--out-dir", default=os.path.join("data", "analysis", "walk_fw"))
    ap.add_argument("--skip-run", action="store_true", help="Не гонять score_methods заново")
    ap.add_argument("--methods", default=None)
    args = ap.parse_args()

    out_dir = os.path.join(HERE, args.out_dir)
    os.makedirs(out_dir, exist_ok=True)
    latest = _find_latest_date(os.path.join(HERE, "data", "candle_cache"))
    if not latest:
        sys.exit("не нашёл ни одного bar в data/candle_cache/*.json")
    end = datetime.strptime(latest, "%Y-%m-%d").date()

    windows = []
    for i in range(args.windows):
        to = end - timedelta(days=i * args.step_days)
        fr = to - timedelta(days=args.window_days)
        windows.append((fr.isoformat(), to.isoformat(), f"w{i+1}"))

    for (fr, to, lbl) in windows:
        print(f"[walk_fw] окно {lbl}: {fr} .. {to}", file=sys.stderr)

    csvs = [os.path.join(out_dir, f"{lbl}.csv") for (_, _, lbl) in windows]
    extra = []
    if args.methods:
        extra.extend(["--methods", args.methods])

    if not args.skip_run:
        for (fr, to, lbl), csv_path in zip(windows, csvs):
            _run_scores(csv_path, fr, to,
                         args.top_liq, args.stride, args.workers,
                         args.min_vol_pctl, args.max_vol_pctl, extra)

    matrices = [_load_matrix(p, min_fires=args.min_fires, min_tk=args.min_tk) for p in csvs]
    labels = [f"{lbl}({to[5:]})" for (_, to, lbl) in windows]
    _print_matrix(matrices, labels, out_txt=os.path.join(out_dir, "walk_fw.txt"))


if __name__ == "__main__":
    main()
