"""pairs_lab.py — парный трейдинг (stat-arb) на ликвидных акциях, OOS+косты.

Идея: цены бумаг одного профиля ходят вместе. spread = logP_a − β·logP_b
стационарен (mean-reverting). Расходится → шортим дорогую ногу / лонгим
дешёвую, ждём схождения. Торгуем СПРЕД, не рынок → иммунно к макро-приливу;
это mean-reversion — единственное, что в сессии давало правильный знак.

Честно по конструкции:
  - отбор пар и параметры (β, mean, std, half-life) — ТОЛЬКО на TRAIN;
  - торговля и цифра — на TEST (данные, на которых ничего не крутили);
  - косты вычтены (4 ноги на круг: вход 2 + выход 2).

Отбор пары на train: корреляция дневных лог-доходностей ≥ --min-corr И спред
mean-reverting по AR(1) (φ<0) с half-life в [--hl-min, --hl-max] дней.
Торговля на test: z=(spread−mean)/std по train-статистике; вход при |z|≥
--z-enter (ставка на возврат), выход при |z|≤--z-exit; стоп при |z|≥--z-stop
(структурный слом). Дневной ресемплинг (последний close дня).

Без новых зависимостей (чистый Python). Запуск:
    python pairs_lab.py --top-liq 25 --days 1500
"""
from __future__ import annotations

import argparse
import math
import os
import re
import sys

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):
        pass

import score_methods as sm

_FUT_RE = re.compile(r"^[A-Z]{1,4}[FGHJKMNQUVXZ]\d$")

# Секторы ликвидных РФ-акций — пары ищем ТОЛЬКО внутри сектора (экономическая
# связь), иначе ловится ложная коинтеграция (SMLT/VKCO co-moved случайно).
_SECTOR = {}
for _sec, _names in {
    "oil_gas": "LKOH ROSN TATN TATNP SNGS SNGSP NVTK GAZP BANE BANEP RNFT",
    "banks_fin": "SBER SBERP VTBR TCSG T CBOM BSPB MOEX SVCB RENI SPBE",
    "metals": "GMKN NLMK MAGN CHMF RUAL MTLR MTLRP ALRS PLZL POLY SELG VSMO ENPG",
    "retail_ecom": "MGNT FIVE X5 LENT MVID FIXP OZON BELU BSPB",
    "tech_telecom": "MTSS RTKM YDEX VKCO HHRU POSI ASTR SOFL DIAS",
    "power": "HYDR IRAO FEES UPRO MSNG OGKB TGKA MRKC LSNG ELFV",
    "realestate": "PIKK SMLT LSRG ETLN",
    "transport": "AFLT FLOT NMTP FESH",
    "chem_agri": "PHOR AKRN KAZT AGRO",
}.items():
    for _t in _names.split():
        _SECTOR[_t] = _sec


def _is_future(t):
    return bool(_FUT_RE.match(t.upper()))


def _daily_closes(rows):
    """5-мин бары → {date: последний close дня}."""
    out = {}
    for r in rows:
        out[r["time"][:10]] = r["close"]
    return out


def _ols(y, x):
    """slope, intercept для y = a + b·x (МНК)."""
    n = len(x)
    mx = sum(x) / n; my = sum(y) / n
    sxx = sum((xi - mx) ** 2 for xi in x) or 1e-12
    sxy = sum((x[i] - mx) * (y[i] - my) for i in range(n))
    b = sxy / sxx
    return b, my - b * mx


def _corr(a, b):
    n = len(a)
    ma = sum(a) / n; mb = sum(b) / n
    va = sum((x - ma) ** 2 for x in a); vb = sum((x - mb) ** 2 for x in b)
    if va <= 0 or vb <= 0:
        return 0.0
    cov = sum((a[i] - ma) * (b[i] - mb) for i in range(n))
    return cov / math.sqrt(va * vb)


def _half_life(spread):
    """AR(1): Δs = c + φ·s_{t-1}. half-life = −ln2/φ (φ<0 = mean-reverting)."""
    s_prev = spread[:-1]
    ds = [spread[i + 1] - spread[i] for i in range(len(spread) - 1)]
    if len(s_prev) < 10:
        return None
    phi, _ = _ols(ds, s_prev)
    if phi >= 0:
        return None
    return -math.log(2) / phi


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cache", default=os.path.join(os.path.dirname(
        os.path.abspath(__file__)), "data", "candle_cache"))
    ap.add_argument("--interval", type=int, default=5, choices=(1, 5))
    ap.add_argument("--days", type=int, default=1500)
    ap.add_argument("--top-liq", type=int, default=25)
    ap.add_argument("--min-days", type=int, default=250, help="мин. общих дней у пары")
    ap.add_argument("--split-frac", type=float, default=0.6)
    ap.add_argument("--min-corr", type=float, default=0.6)
    ap.add_argument("--hl-min", type=float, default=2.0)
    ap.add_argument("--hl-max", type=float, default=40.0)
    ap.add_argument("--z-enter", type=float, default=2.0)
    ap.add_argument("--z-exit", type=float, default=0.5)
    ap.add_argument("--z-stop", type=float, default=4.0)
    ap.add_argument("--cost", type=float, default=0.0005, help="кост ОДНОЙ ноги в одну сторону")
    ap.add_argument("--cross-sector", action="store_true",
                     help="разрешить пары из РАЗНЫХ секторов (по умолчанию только "
                          "внутри сектора — убирает ложную коинтеграцию)")
    ap.add_argument("--workers", type=int, default=None)
    args = ap.parse_args()

    from datetime import datetime, timedelta
    date_from = (datetime.now() - timedelta(days=args.days)).strftime("%Y-%m-%d")

    tickers = sm._list_tickers(args.cache, args.interval, top_liq=args.top_liq,
                               workers=args.workers)
    tickers = [t for t in tickers if not _is_future(t)]   # только акции
    # загрузим дневные ряды
    series = {}
    for t in tickers:
        rows = sm._load_from_cache(t, args.cache, args.interval)
        if not rows:
            continue
        rows = sm._filter_by_dates(rows, date_from, None)
        dc = _daily_closes(rows)
        if len(dc) >= args.min_days:
            series[t] = dc
    names = sorted(series)
    print(f"[pairs] акций с историей: {len(names)}  дней~{args.days}", file=sys.stderr)
    if len(names) < 2:
        sys.exit("мало акций")

    COST = args.cost
    RT = 4 * COST   # круговой кост пары: вход(2 ноги)+выход(2 ноги)
    pairs_ok = 0
    all_trades = []   # (pair, pnl_net)
    per_pair = []     # (pair, n, sum_net, wins)

    for i in range(len(names)):
        for j in range(i + 1, len(names)):
            A, B = names[i], names[j]
            if not args.cross_sector:
                sa, sb = _SECTOR.get(A), _SECTOR.get(B)
                if sa is None or sb is None or sa != sb:
                    continue   # только внутрисекторные пары (экономическая связь)
            common = sorted(set(series[A]) & set(series[B]))
            if len(common) < args.min_days:
                continue
            la = [math.log(series[A][d]) for d in common if series[A][d] > 0 and series[B][d] > 0]
            lb = [math.log(series[B][d]) for d in common if series[A][d] > 0 and series[B][d] > 0]
            if len(la) < args.min_days:
                continue
            cut = int(len(la) * args.split_frac)
            la_tr, lb_tr = la[:cut], lb[:cut]
            la_te, lb_te = la[cut:], lb[cut:]
            # отбор на TRAIN
            ra = [la_tr[k+1]-la_tr[k] for k in range(len(la_tr)-1)]
            rb = [lb_tr[k+1]-lb_tr[k] for k in range(len(lb_tr)-1)]
            if _corr(ra, rb) < args.min_corr:
                continue
            beta, alpha = _ols(la_tr, lb_tr)
            if beta <= 0:
                continue
            spr_tr = [la_tr[k] - (alpha + beta * lb_tr[k]) for k in range(len(la_tr))]
            hl = _half_life(spr_tr)
            if hl is None or not (args.hl_min <= hl <= args.hl_max):
                continue
            m = sum(spr_tr) / len(spr_tr)
            sd = (sum((x - m) ** 2 for x in spr_tr) / len(spr_tr)) ** 0.5
            if sd <= 0:
                continue
            pairs_ok += 1
            # торговля на TEST
            pos = 0; entry_spr = 0.0
            n = 0; ssum = 0.0; wins = 0
            for k in range(len(la_te)):
                spr = la_te[k] - (alpha + beta * lb_te[k])
                z = (spr - m) / sd
                if pos == 0:
                    if z >= args.z_enter:
                        pos = -1; entry_spr = spr          # шорт спреда (ждём падения)
                    elif z <= -args.z_enter:
                        pos = 1; entry_spr = spr           # лонг спреда
                else:
                    hit_exit = abs(z) <= args.z_exit
                    hit_stop = abs(z) >= args.z_stop
                    if hit_exit or hit_stop or k == len(la_te) - 1:
                        pnl = pos * (spr - entry_spr) - RT  # доходность спред-позиции нетто
                        n += 1; ssum += pnl; wins += 1 if pnl > 0 else 0
                        pos = 0
            if n:
                per_pair.append((f"{A}/{B}", n, ssum, wins, hl))
                all_trades.append((f"{A}/{B}", ssum, n))

    print(f"[pairs] коинтегрированных пар (train-фильтр): {pairs_ok}", file=sys.stderr)
    if not per_pair:
        sys.exit("нет торгуемых пар на TEST")

    N = sum(p[1] for p in per_pair)
    S = sum(p[2] for p in per_pair)
    W = sum(p[3] for p in per_pair)
    print(f"\n=== ПАРНЫЙ ТРЕЙДИНГ · OOS (TEST) · нетто (кост ноги {COST*100:.3f}%, "
          f"круг {RT*100:.2f}%) ===")
    print(f"пар торговалось: {len(per_pair)}   сделок: {N}   "
          f"средняя доходность/сделку: {S/N*100:+.3f}%   hit: {W/N*100:.1f}%")
    print(f"суммарно (сумма всех сделок, нетто): {S*100:+.1f}%")
    # топ и антитоп пар по суммарному нетто
    per_pair.sort(key=lambda x: -x[2])
    print(f"\n{'пара':<16}{'сделок':>8}{'ср/сд%':>10}{'hit%':>8}{'half-life':>11}")
    for name, n, s, w, hl in per_pair[:12]:
        print(f"{name:<16}{n:>8}{s/n*100:>+10.3f}{w/n*100:>7.1f}%{hl:>10.1f}д")
    if len(per_pair) > 12:
        print("  …")
        for name, n, s, w, hl in per_pair[-5:]:
            print(f"{name:<16}{n:>8}{s/n*100:>+10.3f}{w/n*100:>7.1f}%{hl:>10.1f}д")
    print("\nвердикт: средняя/сделку > 0 и hit > 55% на TEST = рабочий stat-arb "
          "(отбор был на train, косты вычтены). Если ≤0 — пары не держат OOS.")


if __name__ == "__main__":
    main()
