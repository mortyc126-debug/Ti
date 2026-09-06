"""bond_pead_local.py — кредитный PEAD ЛОКАЛЬНО на выгруженном сырье (bond_dump.py).

Весь event-study в Python, D1 не участвует (потому и надёжно — воркерный
/analysis/credit_pead таймаутил на GROUP BY). Гипотеза: улучшились годовые
показатели эмитента → цена его бондов растёт / доходность падает в следующие
месяцы. Как СИГНАЛ ОТБОРА В ПОРТФЕЛЬ (купил-держишь, кейс ВДО), без слиппеджа.

Без look-ahead: отчёт за fy_year раскрыт ~1 апр (fy_year+1) → на эту дату
известны fy_year и fy_year-1 → дельта → вход с 1 апр (fy_year+1).
  vote = sign(Δrev)+sign(Δnp)+sign(Δebitda_marg)−sign(Δnet_debt_eq)
  dir  = +1/−1 при |vote|≥min_vote (иначе смешанно — пропуск)
Исход по каждому бонду эмитента на горизонте H ТОРГОВЫХ дней:
  signed_price =  dir·(p1−p0)/p0     signed_yield = −dir·(y1−y0)  (пп)
Агрегация по году события (устойчивость) + раскол улучшение/ухудшение
(ценность «избегания падающих» = defaltы/просадки у ухудшившихся).

Запуск:
    py -3.11 bond_pead_local.py --dump data/bond_dump --horizon 60
    py -3.11 bond_pead_local.py --horizon 120 --min-vote 3 --std РСБУ
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import date, datetime, timedelta

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):
        pass

ENTRY_WIN = 12   # дней на поиск торгового дня у даты события


def _num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _sign(x):
    if x is None:
        return 0
    return 1 if x > 0 else (-1 if x < 0 else 0)


def _fund_dir(cur, prev, min_vote):
    d = lambda a, b: None if (a is None or b is None) else a - b
    votes = [
        _sign(d(_num(cur.get("rev")),         _num(prev.get("rev")))),
        _sign(d(_num(cur.get("np")),          _num(prev.get("np")))),
        _sign(d(_num(cur.get("ebitda_marg")), _num(prev.get("ebitda_marg")))),
        -_sign(d(_num(cur.get("net_debt_eq")),_num(prev.get("net_debt_eq")))),  # долг↑ = плохо
    ]
    nz = [v for v in votes if v != 0]
    if len(nz) < 2:
        return 0
    s = sum(votes)
    return 0 if abs(s) < min_vote else (1 if s > 0 else -1)


def _parse_series(data):
    """[{date,price,yield}] → отсортированный список (date, price, yield)."""
    out = []
    for row in data.get("data", []):
        try:
            d = datetime.strptime(row["date"][:10], "%Y-%m-%d").date()
        except Exception:
            continue
        p = _num(row.get("price")); y = _num(row.get("yield"))
        out.append((d, p, y))
    out.sort(key=lambda r: r[0])
    return out


def _entry_idx(series, target, win):
    """индекс первой точки с датой ≥ target в окне win дней (иначе None)."""
    hi = target + timedelta(days=win)
    for i, (d, p, y) in enumerate(series):
        if d < target:
            continue
        if d > hi:
            return None
        if p and p > 0:
            return i
    return None


def _annual_by_year(reports, std_pref):
    """{fy_year: report} только годовые; при конфликте std берём предпочтительный."""
    by = {}
    for r in reports:
        if (r.get("period") or "").strip() != "Год":
            continue
        y = r.get("fy_year")
        if y is None:
            continue
        y = int(y)
        cur = by.get(y)
        if cur is None:
            by[y] = r
        else:
            # предпочесть std_pref, иначе оставить с бóльшим числом заполненных полей
            if std_pref and r.get("std") == std_pref and cur.get("std") != std_pref:
                by[y] = r
            elif not std_pref:
                fill = lambda x: sum(1 for k in ("rev","np","ebitda_marg","net_debt_eq")
                                     if _num(x.get(k)) is not None)
                if fill(r) > fill(cur):
                    by[y] = r
    return by


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dump", default=os.path.join(os.path.dirname(
        os.path.abspath(__file__)), "data", "bond_dump"))
    ap.add_argument("--horizon", type=int, default=60, help="горизонт удержания, торг.дн")
    ap.add_argument("--min-vote", type=int, default=2, help="мин |net голос| из 4 метрик")
    ap.add_argument("--from-year", type=int, default=2019)
    ap.add_argument("--std", default=None, help="предпочесть тип отчётности: РСБУ / МСФО")
    args = ap.parse_args()

    cat_path = os.path.join(args.dump, "catalog.json")
    if not os.path.exists(cat_path):
        sys.exit(f"нет {cat_path} — сначала bond_dump.py")
    with open(cat_path, encoding="utf-8") as f:
        catalog = json.load(f)
    # карта inn -> [secid]
    inn_bonds = {}
    for b in catalog.get("bonds", []):
        inn = str(b.get("issuerInn") or "")
        secid = (b.get("isin") or "").upper()
        if inn and secid:
            inn_bonds.setdefault(inn, []).append(secid)

    rep_dir = os.path.join(args.dump, "reports")
    bond_dir = os.path.join(args.dump, "bonds")
    if not os.path.isdir(rep_dir):
        sys.exit(f"нет {rep_dir}")

    H = args.horizon
    # агрегаты по году события
    agg = {}   # year -> {np,sp,wp, ny,sy,wy}
    # раскол по направлению: сырой форвард цены (не signed) — падают ли ухудшившиеся
    dir_split = {1: [0, 0.0], -1: [0, 0.0]}   # dir -> [n, Σ raw price_ret]
    n_issuers = n_events = n_trades = 0
    series_cache = {}

    def _series(secid):
        if secid in series_cache:
            return series_cache[secid]
        bp = os.path.join(bond_dir, f"{secid}.json")
        s = None
        if os.path.exists(bp):
            try:
                with open(bp, encoding="utf-8") as f:
                    s = _parse_series(json.load(f))
            except Exception:
                s = None
        series_cache[secid] = s
        return s

    for fn in os.listdir(rep_dir):
        if not fn.endswith(".json"):
            continue
        inn = fn[:-5]
        try:
            with open(os.path.join(rep_dir, fn), encoding="utf-8") as f:
                reports = json.load(f).get("data", [])
        except Exception:
            continue
        by_year = _annual_by_year(reports, args.std)
        secids = inn_bonds.get(inn, [])
        if not secids:
            continue
        issuer_had_event = False
        for fy in sorted(by_year):
            if fy < args.from_year or (fy - 1) not in by_year:
                continue
            d = _fund_dir(by_year[fy], by_year[fy - 1], args.min_vote)
            if d == 0:
                continue
            ev = date(fy + 1, 4, 1)
            ay = fy + 1
            had_trade = False
            for secid in secids:
                s = _series(secid)
                if not s:
                    continue
                i0 = _entry_idx(s, ev, ENTRY_WIN)
                if i0 is None or i0 + H >= len(s):
                    continue
                p0, y0 = s[i0][1], s[i0][2]
                p1, y1 = s[i0 + H][1], s[i0 + H][2]
                if not p0 or not p1 or p0 <= 0:
                    continue
                raw = (p1 - p0) / p0
                sp = d * raw
                m = agg.setdefault(ay, {"np":0,"sp":0.0,"wp":0,"ny":0,"sy":0.0,"wy":0})
                m["np"] += 1; m["sp"] += sp; m["wp"] += 1 if sp > 0 else 0
                dir_split[d][0] += 1; dir_split[d][1] += raw
                if y0 is not None and y1 is not None:
                    sy = -d * (y1 - y0)
                    m["ny"] += 1; m["sy"] += sy; m["wy"] += 1 if sy > 0 else 0
                n_trades += 1; had_trade = True
            if had_trade:
                n_events += 1; issuer_had_event = True
        if issuer_had_event:
            n_issuers += 1

    if not agg:
        sys.exit("нет событий/сделок — проверь выгрузку (bonds/*.json, reports/*.json)")

    print(f"\nэмитентов с сигналом: {n_issuers}   событий: {n_events}   сделок(×бонд): {n_trades}")

    def _tbl(kind, label, unit):
        nk, sk, wk = ("np","sp","wp") if kind == "p" else ("ny","sy","wy")
        N = sum(m[nk] for m in agg.values())
        if not N:
            print(f"\n{label}: нет данных"); return
        S = sum(m[sk] for m in agg.values()); W = sum(m[wk] for m in agg.values())
        pct = "%" if kind == "p" else "пп"
        print(f"\n=== {label} (горизонт {H} торг.дн, min_vote={args.min_vote}) ===")
        print(f"ВСЕГО: n={N}  hit={W/N*100:.1f}%  ср.={S/N*(100 if kind=='p' else 1):+.4f}{unit}")
        print(f"{'год события':<12}{'n':>7}{'hit%':>8}{'ср.'+unit:>12}")
        for y in sorted(agg):
            m = agg[y]; n = m[nk]
            if not n:
                continue
            v = m[sk]/n*(100 if kind == "p" else 1)
            print(f"{y:<12}{n:>7}{m[wk]/n*100:>7.1f}%{v:>+12.4f}")

    _tbl("p", "signed ЦЕНА бонда (dir · price_ret)", "%")
    _tbl("y", "signed −Δ ДОХОДНОСТЬ (dir · −Δyield)", "пп")

    print(f"\n=== РАСКОЛ по направлению (сырой форвард цены, горизонт {H}) ===")
    for d, name in ((1, "улучшение"), (-1, "ухудшение")):
        n, s = dir_split[d]
        if n:
            print(f"{name:<12} n={n:>6}  ср. цена {s/n*100:+.4f}%")
    print("\nчитать: hit>55% и ср.>0 УСТОЙЧИВО по годам = кредитный PEAD есть. "
          "Плюс в 1-2 годах из N = шум. Раскол: если у 'ухудшения' средняя цена "
          "заметно отрицательна — сигнал ценен хотя бы для ИЗБЕГАНИЯ падающих.")


if __name__ == "__main__":
    main()
