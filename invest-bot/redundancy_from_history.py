"""
redundancy_from_history.py — офлайн-версия redundancy_analysis.py: считает
попарные корреляции методов ВНУТРИ кластера прямо из data/history.json, без
Tinkoff API и без свечей. Нужен, когда живых свечей/токена нет, но есть
накопленная история дневных снэпшотов и/или виртуальных сделок.

Зачем отдельно от redundancy_analysis.py:
  - redundancy_analysis.py гоняет scan_method_scores(candles) → тянет tinkoff,
    dashboard, БД. Здесь ничего этого нет — только json + чистый Pearson/RMT.
  - redundancy_analysis.py печатает лишь СРЕДНИЙ |corr| метода с кластером.
    Здесь выводим именно ПОПАРНЫЕ corr > порога — конкретные кандидаты на
    слияние/удаление одного из пары.

Источник рядов (--source):
  daily  — day["scores"] (дневные снэпшоты; то же, что питает живой
           redundancy_dampen в cluster_models).
  trades — day["trades"][].method_scores (скоры на входе в сделку; сюда
           попадают "виртуальные сделки" бэктеста/песочницы).
  both   — объединяет оба ряда (по умолчанию).

Про фикс режимов: попарная корреляция методов не зависит от того, как
классификатор назвал режим (формулы методов те же). Поэтому большой
до-фиксовый набор пригоден для ПУЛА корреляций. Поразрезная по режимам
картина (--by-regime) на старых данных будет с устаревшими ярлыками —
трактовать осторожно.

    python redundancy_from_history.py                      # data/history.json, все тикеры
    python redundancy_from_history.py path/to/history.json --ticker SBER
    python redundancy_from_history.py --source trades --threshold 0.7 --by-regime
"""
import argparse
import json
import statistics
import sys
from collections import defaultdict

from cluster_models import STRATEGY_CLUSTERS, _rmt_clean_corr, _pearson

MIN_OBS = 15          # минимум ненулевых наблюдений, чтобы corr не был шумом
DEFAULT_THRESHOLD = 0.7

_METHOD_TO_CLUSTER = {mid: cl["label"] for cl in STRATEGY_CLUSTERS for mid in cl["ids"]}


def _load(path: str) -> dict:
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def _series_for_ticker(days: dict, source: str) -> dict[str, list[float]]:
    """{method: [scores]} по всем дням тикера из выбранного источника."""
    series: dict[str, list[float]] = defaultdict(list)
    for _date, day in sorted(days.items()):
        if source in ("daily", "both"):
            for m, s in (day.get("scores") or {}).items():
                series[m].append(s)
        if source in ("trades", "both"):
            for t in day.get("trades", []):
                for m, s in (t.get("method_scores") or {}).items():
                    series[m].append(s)
    # отбрасываем методы, у которых мало ненулевых значений
    return {m: v for m, v in series.items()
            if sum(1 for x in v if x != 0.0) >= MIN_OBS}


def _series_by_regime(days: dict, source: str) -> dict[str, dict[str, list[float]]]:
    out: dict[str, dict[str, list[float]]] = defaultdict(lambda: defaultdict(list))
    for _date, day in sorted(days.items()):
        r_day = day.get("regime", "?")
        if source in ("daily", "both"):
            for m, s in (day.get("scores") or {}).items():
                out[r_day][m].append(s)
        if source in ("trades", "both"):
            for t in day.get("trades", []):
                r = t.get("regime", r_day)
                for m, s in (t.get("method_scores") or {}).items():
                    out[r][m].append(s)
    cleaned: dict[str, dict[str, list[float]]] = {}
    for r, series in out.items():
        s2 = {m: v for m, v in series.items()
              if sum(1 for x in v if x != 0.0) >= MIN_OBS}
        if len(s2) >= 2:
            cleaned[r] = s2
    return cleaned


def _method_quality(days: dict) -> dict[str, dict]:
    """avg_quality по методу из сделок (та же логика, что HistoryStore.method_performance):
    aligned=score в сторону входа → target=quality, иначе 1-quality."""
    per: dict[str, dict] = {}
    for _date, day in days.items():
        for t in day.get("trades", []):
            q = t.get("quality")
            d = t.get("dir")
            if q is None or d not in ("LONG", "SHORT"):
                continue
            for m, s in (t.get("method_scores") or {}).items():
                aligned = (s > 0 and d == "LONG") or (s < 0 and d == "SHORT")
                target = q if aligned else (1.0 - q)
                e = per.setdefault(m, {"total": 0, "sum_q": 0.0})
                e["total"] += 1
                e["sum_q"] += target
    for e in per.values():
        e["avg_quality"] = e["sum_q"] / e["total"] if e["total"] else None
    return per


def _intra_cluster_pairs(corr: dict[tuple, float], present: set[str],
                         threshold: float) -> list[tuple]:
    """Пары (a,b,corr) внутри одного кластера с |corr| > threshold."""
    pairs = []
    for cl in STRATEGY_CLUSTERS:
        ids = [m for m in cl["ids"] if m in present]
        for i in range(len(ids)):
            for j in range(i + 1, len(ids)):
                a, b = ids[i], ids[j]
                c = corr.get((a, b))
                if c is None:
                    continue
                if abs(c) > threshold:
                    pairs.append((cl["label"], a, b, c))
    return sorted(pairs, key=lambda p: abs(p[3]), reverse=True)


def _cross_cluster_pairs(corr: dict[tuple, float], present: set[str],
                         threshold: float) -> list[tuple]:
    """Пары методов из РАЗНЫХ кластеров с |corr| > threshold — скрытое
    дублирование, которое семантическая кластеризация не поймала."""
    ids = sorted(present)
    pairs = []
    for i in range(len(ids)):
        for j in range(i + 1, len(ids)):
            a, b = ids[i], ids[j]
            ca, cb = _METHOD_TO_CLUSTER.get(a), _METHOD_TO_CLUSTER.get(b)
            if ca is None or cb is None or ca == cb:
                continue
            c = corr.get((a, b))
            if c is not None and abs(c) > threshold:
                pairs.append((ca, a, cb, b, c))
    return sorted(pairs, key=lambda p: abs(p[4]), reverse=True)


def _avg_abs_corr(corr: dict[tuple, float], methods: list[str], mid: str) -> float | None:
    others = [n for n in methods if n != mid and (mid, n) in corr]
    if not others:
        return None
    return sum(abs(corr[(mid, n)]) for n in others) / len(others)


def _analyze_ticker(ticker: str, days: dict, source: str, threshold: float,
                    by_regime: bool) -> dict | None:
    series = _series_for_ticker(days, source)
    if len(series) < 2:
        print(f"{ticker}: < 2 методов с достаточной историей — пропуск")
        return None
    n_obs = max(len(v) for v in series.values())
    corr = _rmt_clean_corr(series)
    present = set(series.keys())
    quality = _method_quality(days)

    intra = _intra_cluster_pairs(corr, present, threshold)
    cross = _cross_cluster_pairs(corr, present, threshold)

    print(f"\n{'='*70}\n{ticker}: методов={len(series)}, наблюдений(макс)={n_obs}, "
          f"источник={source}")
    print(f"{'-'*70}")
    if intra:
        print(f"ВНУТРИ КЛАСТЕРА |corr| > {threshold} (кандидаты на слияние/удаление):")
        for label, a, b, c in intra:
            qa = quality.get(a, {}).get("avg_quality")
            qb = quality.get(b, {}).get("avg_quality")
            qs = ""
            if qa is not None and qb is not None:
                # у кого edge слабее (ближе к 0.5) — тот кандидат на удаление
                weaker = a if abs(qa - 0.5) <= abs(qb - 0.5) else b
                qs = f"  q({a})={qa:.3f} q({b})={qb:.3f} → слабее: {weaker}"
            print(f"  [{label:<14}] {a:<16} ~ {b:<16} corr={c:+.3f}{qs}")
    else:
        print(f"ВНУТРИ КЛАСТЕРА: пар |corr| > {threshold} нет.")

    if cross:
        print(f"\nМЕЖДУ КЛАСТЕРАМИ |corr| > {threshold} (скрытое дублирование):")
        for ca, a, cb, b, c in cross:
            print(f"  {a:<16}[{ca}] ~ {b:<16}[{cb}] corr={c:+.3f}")

    if by_regime:
        by_r = _series_by_regime(days, source)
        for r, s in sorted(by_r.items()):
            cr = _rmt_clean_corr(s)
            pr = _intra_cluster_pairs(cr, set(s.keys()), threshold)
            if pr:
                print(f"\n  режим={r} (n={max(len(v) for v in s.values())}):")
                for label, a, b, c in pr:
                    print(f"    [{label:<14}] {a:<16} ~ {b:<16} corr={c:+.3f}")

    return {"corr": corr, "present": present, "quality": quality}


def _aggregate(per_ticker: dict[str, dict], threshold: float) -> None:
    """Медиана corr пары через тикеры — устойчивее к одному окну."""
    pair_corrs: dict[tuple, list[float]] = defaultdict(list)
    for res in per_ticker.values():
        corr = res["corr"]
        present = res["present"]
        for cl in STRATEGY_CLUSTERS:
            ids = [m for m in cl["ids"] if m in present]
            for i in range(len(ids)):
                for j in range(i + 1, len(ids)):
                    a, b = ids[i], ids[j]
                    if (a, b) in corr:
                        pair_corrs[(cl["label"], a, b)].append(corr[(a, b)])

    rows = []
    for (label, a, b), vals in pair_corrs.items():
        med = statistics.median(vals)
        if abs(med) > threshold * 0.85:  # чуть ниже порога, чтобы видеть пограничные
            rows.append((label, a, b, med, len(vals)))
    rows.sort(key=lambda r: abs(r[3]), reverse=True)

    print(f"\n{'='*70}\n=== АГРЕГАТ по {len(per_ticker)} тикерам (медиана попарной corr) ===")
    print(f"{'-'*70}")
    for label, a, b, med, n in rows:
        flag = "  ← дубль" if abs(med) > threshold else ""
        print(f"  [{label:<14}] {a:<16} ~ {b:<16} медиана corr={med:+.3f} (n={n} тик.){flag}")


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("history", nargs="?", default="data/history.json")
    p.add_argument("--ticker", help="один тикер; по умолчанию все")
    p.add_argument("--source", choices=["daily", "trades", "both"], default="both")
    p.add_argument("--threshold", type=float, default=DEFAULT_THRESHOLD)
    p.add_argument("--by-regime", action="store_true", help="дополнительно разрезать по режимам")
    args = p.parse_args()

    try:
        data = _load(args.history)
    except FileNotFoundError:
        print(f"Нет файла {args.history}. Укажи путь к history.json.")
        sys.exit(1)

    tickers = [args.ticker] if args.ticker else list(data.keys())
    per_ticker = {}
    for t in tickers:
        days = data.get(t)
        if not days:
            print(f"{t}: нет в истории — пропуск")
            continue
        res = _analyze_ticker(t, days, args.source, args.threshold, args.by_regime)
        if res:
            per_ticker[t] = res

    if len(per_ticker) > 1:
        _aggregate(per_ticker, args.threshold)


if __name__ == "__main__":
    main()
