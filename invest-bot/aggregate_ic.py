"""
aggregate_ic.py — агрегирует sign-IC методов по ВСЕМ тикерам из history.json.

Запуск:
  python aggregate_ic.py [--days 90] [--min-n 30]

Пишет data/global_ic_prior.json:
{
  "PRICE_TREND": {"sign_ic": 0.41, "n": 847, "invert": true},
  "VOL_MOMENTUM": {"sign_ic": 0.54, "n": 612, "invert": false},
  ...
}

sign_ic = доля сделок где знак скора совпал с «правильным» направлением
(aligned → win, против → lose). Мера того, работает ли метод как предсказатель
или как антипредсказатель. Значение < INVERT_THR при n >= MIN_N → invert=True.

OICompositeStrategy читает этот файл при старте и засевает
ICPrior.__global__ виртуальными обновлениями, чтобы контрарные методы
(напр. PRICE_TREND) сразу получали invert=True, не ожидая 20+ сделок
на каждом тикере по отдельности.
"""
import argparse
import json
import os
import sys
from datetime import datetime, timedelta, timezone

HISTORY_FILE = "data/history.json"
OUTPUT_FILE  = "data/global_ic_prior.json"

MIN_N        = 30     # минимум сделок для вывода метода в файл
INVERT_THR   = 0.45  # sign_ic ниже → метод работает контрарно


def _cutoff(days: int) -> str:
    dt = datetime.now(timezone.utc) - timedelta(days=days)
    return dt.date().isoformat()


def aggregate(history_path: str, days: int, min_n: int) -> dict:
    with open(history_path, "r", encoding="utf-8") as f:
        data = json.load(f)

    cutoff = _cutoff(days)

    # {method: {"aligned": int, "total": int}}
    stats: dict[str, dict] = {}

    for ticker, days_data in data.items():
        for day, ddata in days_data.items():
            if day < cutoff:
                continue
            for trade in ddata.get("trades", []):
                direction = trade.get("dir", "")
                quality   = trade.get("quality", 0.5)
                method_scores = trade.get("method_scores", {})
                win = quality > 0.5

                for method, score in method_scores.items():
                    if abs(score) < 0.05:
                        continue
                    aligned = (
                        (score > 0 and direction == "LONG") or
                        (score < 0 and direction == "SHORT")
                    )
                    # Правильный знак: метод поддержал выигравшую сделку
                    # ИЛИ был против проигравшей (оба случая — метод прав).
                    sign_correct = (aligned == win)

                    s = stats.setdefault(method, {"aligned": 0, "total": 0})
                    s["total"] += 1
                    if sign_correct:
                        s["aligned"] += 1

    result = {}
    for method, s in sorted(stats.items()):
        n = s["total"]
        if n < min_n:
            continue
        sign_ic = s["aligned"] / n
        result[method] = {
            "sign_ic": round(sign_ic, 4),
            "n":        n,
            "invert":   sign_ic < INVERT_THR,
        }

    return result


def main() -> None:
    parser = argparse.ArgumentParser(description="Aggregate sign-IC from history.json")
    parser.add_argument("--days",  type=int, default=90,   help="Rolling window in days")
    parser.add_argument("--min-n", type=int, default=MIN_N, help="Min trades per method")
    parser.add_argument("--history", default=HISTORY_FILE, help="Path to history.json")
    parser.add_argument("--out",     default=OUTPUT_FILE,  help="Output path")
    args = parser.parse_args()

    if not os.path.exists(args.history):
        print(f"ERROR: {args.history} not found", file=sys.stderr)
        sys.exit(1)

    result = aggregate(args.history, days=args.days, min_n=args.min_n)

    from atomic_json import atomic_write_json
    atomic_write_json(args.out, result, indent=2)

    print(f"Wrote {args.out} — {len(result)} methods (window={args.days}d, min_n={args.min_n})")
    print()
    print(f"{'Method':<28} {'sign_ic':>8} {'n':>6}  {'':>6}")
    print("-" * 52)
    for method, v in sorted(result.items(), key=lambda x: x[1]["sign_ic"]):
        flag = " ← INVERT" if v["invert"] else ""
        print(f"{method:<28} {v['sign_ic']:>8.3f} {v['n']:>6}{flag}")


if __name__ == "__main__":
    main()
