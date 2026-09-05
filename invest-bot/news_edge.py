"""news_edge.py — есть ли торгуемый edge в направлении из новостей (Cerebras).

Читает накопленные data/{ticker}/news.jsonl (их пишет NewsCollector: прогноз
expected_direction up/down/neutral + фактический ход pct_{горизонт}, который
дописывает PriceTracker по мере наступления интервалов).

Меряет ЧЕСТНО, не как встроенный direction_correct (тот считает neutral за
попадание и раздувает %). Здесь — только НАПРАВЛЕННЫЕ прогнозы (up/down) с
заполненным pct на горизонте:
    signed = pct · (+1 если up, −1 если down)        # ход в сторону прогноза, %
    hit    = signed > 0
    edge   = mean(signed)                             # средний % в сторону прогноза
Плюс разрез по силе сентимента (very_* против обычных) — сильные новости
должны бить лучше, если сигнал реален.

Это НЕ бэктест стратегии (комиссий/входа нет) — первый фильтр: предсказывает
ли LLM-направление вообще. Если mean signed ≤ 0 или hit ~50% на всех
горизонтах — направление из новостей само по себе не работает, вешать на него
AMIHUD-тайминг смысла нет.

Запуск:
    python news_edge.py                     # все data/*/news.jsonl
    python news_edge.py --tickers SBER,GAZP
    python news_edge.py --strong-only       # только very_positive/very_negative
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import statistics
import sys

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):
        pass

_HERE = os.path.dirname(os.path.abspath(__file__))
HORIZONS = ["5m", "15m", "1h", "4h", "1d", "3d", "7d"]
STRONG = {"very_positive", "very_negative"}


def _load(data_dir: str, tickers: set | None) -> list[dict]:
    rows = []
    for path in glob.glob(os.path.join(data_dir, "*", "news.jsonl")):
        tk = os.path.basename(os.path.dirname(path))
        if tickers and tk not in tickers:
            continue
        try:
            with open(path, encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        e = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    e["_ticker"] = tk
                    rows.append(e)
        except OSError:
            continue
    return rows


def _stat(signed: list[float]) -> str:
    n = len(signed)
    if n == 0:
        return f"n={n:<4} —"
    hit = sum(1 for x in signed if x > 0) / n
    mean = statistics.mean(signed)
    med = statistics.median(signed)
    return f"n={n:<4} hit={hit*100:4.1f}%  ср.ход={mean:+.3f}%  медиана={med:+.3f}%"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default=os.path.join(_HERE, "data"))
    ap.add_argument("--tickers", default=None, help="через запятую (иначе все)")
    ap.add_argument("--strong-only", action="store_true",
                     help="только very_positive/very_negative")
    args = ap.parse_args()

    tickers = ({t.strip().upper() for t in args.tickers.split(",") if t.strip()}
               if args.tickers else None)
    rows = _load(args.data, tickers)
    if not rows:
        sys.exit(f"нет данных в {args.data}/*/news.jsonl")

    # только направленные прогнозы
    dir_rows = [e for e in rows if e.get("expected_direction") in ("up", "down")]
    if args.strong_only:
        dir_rows = [e for e in dir_rows if e.get("sentiment") in STRONG]

    n_neutral = sum(1 for e in rows if e.get("expected_direction") == "neutral")
    print(f"всего записей: {len(rows)}  из них neutral: {n_neutral}  "
          f"направленных: {len([e for e in rows if e.get('expected_direction') in ('up','down')])}")
    if args.strong_only:
        print(f"фильтр: только сильный сентимент (very_*) → {len(dir_rows)} записей")
    print(f"тикеры: {sorted({e['_ticker'] for e in rows})}")
    print("\n=== знаковый edge направления по горизонтам ===")
    print("(signed = ход цены × сторона прогноза; hit>50% и ср.ход>0 = есть сигнал)")

    def signed_for(label, subset):
        out = []
        for e in subset:
            pct = e.get(f"pct_{label}")
            d = e.get("expected_direction")
            if pct is None or d not in ("up", "down"):
                continue
            out.append(pct if d == "up" else -pct)
        return out

    print(f"\n{'горизонт':<8} {'ВСЕ направленные':<48} {'сильные (very_*)':<48}")
    for label in HORIZONS:
        s_all = signed_for(label, dir_rows if args.strong_only else
                           [e for e in rows if e.get("expected_direction") in ("up", "down")])
        s_str = signed_for(label, [e for e in rows if e.get("sentiment") in STRONG
                                   and e.get("expected_direction") in ("up", "down")])
        print(f"{label:<8} {_stat(s_all):<48} {_stat(s_str):<48}")

    print("\nЗаметка: это только предсказательная сила направления, без комиссий и "
          "честного входа. Нужны СОТНИ оценённых записей на горизонт — иначе шум.")


if __name__ == "__main__":
    main()
