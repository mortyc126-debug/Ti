"""bond_pead.py — event-study: изменение годовой отчётности → дрейф облигации.

Гипотеза (кредитный аналог PEAD): у эмитента улучшились показатели год-к-году
→ спред сужается / цена бонда растёт в следующие месяцы; ухудшились → наоборот.
Как СИГНАЛ ОТБОРА В ПОРТФЕЛЬ (купил-держишь), без HFT и слиппеджа — ровно
кейс ВДО-инвестора.

Данные — из backend-воркера (bondan-backend), публичные GET-эндпоинты:
  /catalog                     эмитенты (inn, bonds_count) + карта бондов isin→inn
  /issuer/{inn}/reports        годовые РСБУ: fy_year, rev, np, ebitda_marg, net_debt_eq…
  /bond/history?secid=X        ряд по дням: date, price, yield, …

Логика (без look-ahead):
  отчёт за fy_year раскрывается ~1 апр (fy_year+1) → на эту дату известны
  fy_year и fy_year-1 → дельта(fy_year vs fy_year-1) → вход с ~1 апр (fy_year+1).
    vote = sign(Δrev)+sign(Δnp)+sign(Δebitda_marg)−sign(Δnet_debt_eq)
    direction = +1/−1, если |vote| ≥ min_vote (иначе смешанный сигнал — пропуск)
  исход по каждому бонду эмитента на горизонте H торговых дней:
    signed_price =  direction · (p1−p0)/p0        (улучшение → цена растёт)
    signed_yield = −direction · (y1−y0)            (улучшение → доходность падает)
  hit = signed>0. Агрегация: n, ср., hit%. Разрез по году события (устойчивость).

Дата раскрытия точная в БД отсутствует (есть только fy_year) — берём 1 апреля
fy_year+1; бонды реагируют медленно, поэтому аппроксимация приемлема. Ищем
ближайший торговый день ≥ даты события (окно ENTRY_WIN дней).

Сырые ответы API кэшируются в --cache-dir (JSON), повторные прогоны мгновенны.

Запуск (на машине с доступом к backend):
    python bond_pead.py --horizon 60
    python bond_pead.py --horizon 120 --min-vote 3 --limit-issuers 50
"""
from __future__ import annotations

import argparse
import json
import os
import statistics
import sys
import time
import shutil
import subprocess
import urllib.request
from datetime import date, datetime, timedelta

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):
        pass

DEFAULT_BASE = "https://bondan-backend.marginacall.workers.dev"
ENTRY_WIN = 10   # дней на поиск торгового дня у даты события
_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
       "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")
# curl.exe (Win10+/*nix) идёт через системный прокси+сертификаты КАК браузер.
# urllib на этой машине виснет на крупных телах (антивирус-прокси сканирует TLS),
# а curl — нет. Поэтому качаем через curl, urllib оставлен фолбэком.
_CURL = shutil.which("curl") or shutil.which("curl.exe")


def _fetch_raw(url, timeout):
    if _CURL:
        p = subprocess.run(
            [_CURL, "-s", "-S", "--compressed", "-m", str(timeout), "-A", _UA,
             "-H", "Accept: application/json", url],
            capture_output=True, timeout=timeout + 15)
        if p.returncode != 0:
            raise RuntimeError(f"curl rc={p.returncode}: {(p.stderr or b'')[:150].decode('utf-8','replace')}")
        return p.stdout.decode("utf-8")
    req = urllib.request.Request(url, headers={"Accept": "application/json", "User-Agent": _UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode("utf-8")


def _get(base, path, cache_dir, ttl_days=30, timeout=60):
    """GET c дисковым кэшем (через curl.exe). Возвращает распарсенный JSON или None."""
    safe = path.replace("/", "_").replace("?", "_").replace("&", "_").replace("=", "_")
    cpath = os.path.join(cache_dir, safe + ".json")
    if os.path.exists(cpath):
        age = time.time() - os.path.getmtime(cpath)
        if age < ttl_days * 86400:
            try:
                with open(cpath, encoding="utf-8") as f:
                    return json.load(f)
            except Exception:
                pass
    url = base.rstrip("/") + path
    for attempt in range(3):
        try:
            data = json.loads(_fetch_raw(url, timeout))
            with open(cpath, "w", encoding="utf-8") as f:
                json.dump(data, f, ensure_ascii=False)
            return data
        except Exception as e:
            if attempt == 2:
                print(f"[warn] {path}: {e}", file=sys.stderr)
                return None
            time.sleep(1.5 * (attempt + 1))
    return None


def _sign(x):
    if x is None:
        return 0
    return 1 if x > 0 else (-1 if x < 0 else 0)


def _num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _delta(cur, prev):
    """Знак изменения (cur−prev), None если чего-то нет."""
    if cur is None or prev is None:
        return None
    return cur - prev


def _fund_direction(cur, prev, min_vote):
    """Направление фундамента по дельте год-к-году. +1 улучшение, −1 ухудшение,
    0 — смешанно/мало данных (пропуск)."""
    d_rev  = _delta(_num(cur.get("rev")),         _num(prev.get("rev")))
    d_np   = _delta(_num(cur.get("np")),          _num(prev.get("np")))
    d_marg = _delta(_num(cur.get("ebitda_marg")), _num(prev.get("ebitda_marg")))
    d_lev  = _delta(_num(cur.get("net_debt_eq")), _num(prev.get("net_debt_eq")))
    # долг вверх — плохо, поэтому минус sign(Δlev)
    votes = [_sign(d_rev), _sign(d_np), _sign(d_marg), -_sign(d_lev)]
    nonzero = [v for v in votes if v != 0]
    if len(nonzero) < 2:
        return 0
    s = sum(votes)
    if abs(s) < min_vote:
        return 0
    return 1 if s > 0 else -1


def _find_at(series, target: date, win: int):
    """Первая точка series (list of {date,price,yield}) с датой ≥ target в окне
    win дней. Возвращает (price, yield) или None."""
    lo = target
    hi = target + timedelta(days=win)
    for row in series:
        try:
            d = datetime.strptime(row["date"][:10], "%Y-%m-%d").date()
        except Exception:
            continue
        if lo <= d <= hi:
            p = _num(row.get("price"))
            y = _num(row.get("yield"))
            if p and p > 0:
                return (p, y)
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default=DEFAULT_BASE)
    ap.add_argument("--cache-dir", default=os.path.join(os.path.dirname(
        os.path.abspath(__file__)), "data", "pead_cache"))
    ap.add_argument("--horizon", type=int, default=60,
                     help="горизонт удержания в ТОРГОВЫХ днях")
    ap.add_argument("--min-vote", type=int, default=2,
                     help="мин. |net голос| из 4 метрик для сигнала")
    ap.add_argument("--from-year", type=int, default=2019,
                     help="мин. fy_year события (нужен предыдущий год для дельты)")
    ap.add_argument("--limit-issuers", type=int, default=None)
    args = ap.parse_args()
    os.makedirs(args.cache_dir, exist_ok=True)

    # Универсум эмитентов — из /issuers/report_years (компактная карта
    # {inn: max_year}, ~8КБ на 324 эмитента). Крупные эндпоинты (/catalog 252КБ,
    # /reports/latest) на этой сети рвутся после ~24КБ (антивирус-прокси душит
    # большое TLS-тело), поэтому берём только мелкие ответы: карту ИНН здесь,
    # далее по одному эмитенту и по узкому окну цен бонда.
    ry = _get(args.base, "/issuers/report_years", args.cache_dir, ttl_days=7, timeout=60)
    if not ry:
        sys.exit("не удалось получить /issuers/report_years")
    inns = list((ry.get("map") or {}).keys())
    if args.limit_issuers:
        inns = inns[:args.limit_issuers]
    inn_bonds = {}
    print(f"[pead] эмитентов с отчётами (из /issuers/report_years): {len(inns)}", file=sys.stderr)

    # events[event_year] = list of signed outcomes
    ev_price = {}   # year -> list signed price-return
    ev_yield = {}   # year -> list signed -Δyield
    n_events = 0    # (issuer,year) с валидным направлением
    n_trades = 0    # (issuer,year,bond) с валидным исходом
    dbg = {"no_rep": 0, "lt2yr": 0, "no_bonds": 0, "dir0": 0, "no_price": 0}
    HZ = args.horizon

    for k, inn in enumerate(inns):
        if k % 25 == 0:
            print(f"[{k}/{len(inns)}] events={n_events} trades={n_trades} drops={dbg}", file=sys.stderr)
        rep = _get(args.base, f"/issuer/{inn}/reports", args.cache_dir)
        if not rep:
            dbg["no_rep"] += 1
            continue
        rows = rep.get("data") or []
        by_year = {}
        for r in rows:
            y = r.get("fy_year")
            if y is not None:
                by_year[int(y)] = r      # если period-дубли — берём последний
        years = sorted(by_year)
        if len(years) < 2:
            dbg["lt2yr"] += 1
            continue
        # бонды эмитента — запрос по одному ИНН (быстрый, в отличие от /catalog)
        if inn not in inn_bonds:
            bl = _get(args.base, f"/bond/issuer?inn={inn}", args.cache_dir)
            inn_bonds[inn] = [b.get("secid") for b in ((bl.get("data") if bl else []) or [])
                              if b.get("secid")]
        if not inn_bonds[inn]:
            dbg["no_bonds"] += 1
            continue
        # ряды цен бондов — УЗКИМ окном вокруг события (крупные тела рвёт прокси).
        # Ключ кэша (isin, yr): для каждого года события своё окно.
        series_cache = {}
        for yr in years:
            if yr - 1 not in by_year or yr < args.from_year:
                continue
            direction = _fund_direction(by_year[yr], by_year[yr - 1], args.min_vote)
            if direction == 0:
                dbg["dir0"] += 1
                continue
            n_events += 1
            trades_before = n_trades
            entry_dt = date(yr + 1, 4, 1)   # ~раскрытие РСБУ за yr
            frm = f"{yr + 1}-03-01"          # окно: март..декабрь года раскрытия
            to  = f"{yr + 1}-12-31"          # покрывает вход ~1 апр + горизонт до ~120 дн
            for isin in inn_bonds.get(inn, []):
                ck = (isin, yr)
                if ck not in series_cache:
                    h = _get(args.base,
                             f"/bond/history?secid={isin}&from={frm}&to={to}",
                             args.cache_dir)
                    series_cache[ck] = (h.get("data") if h else []) or []
                series = series_cache[ck]
                if not series:
                    continue
                p0 = _find_at(series, entry_dt, ENTRY_WIN)
                if not p0:
                    continue
                # выход: HZ торговых дней спустя — берём HZ-ю точку ≥ entry
                after = [row for row in series
                         if row.get("date", "")[:10] >= entry_dt.isoformat()]
                if len(after) <= HZ:
                    continue
                exit_row = after[HZ]
                p1 = _num(exit_row.get("price"))
                y1 = _num(exit_row.get("yield"))
                if not p1 or p1 <= 0:
                    continue
                price_ret = (p1 - p0[0]) / p0[0]
                signed_p = direction * price_ret
                ev_price.setdefault(yr, []).append(signed_p)
                if p0[1] is not None and y1 is not None:
                    signed_y = -direction * (y1 - p0[1])   # улучшение → yield падает → +
                    ev_yield.setdefault(yr, []).append(signed_y)
                n_trades += 1
            if n_trades == trades_before:
                dbg["no_price"] += 1   # событие было, но ни одного бонда с ценой в окне
        time.sleep(0.02)

    def _report(dct, label, unit):
        allv = [x for lst in dct.values() for x in lst]
        if not allv:
            print(f"\n{label}: нет данных")
            return
        hit = sum(1 for x in allv if x > 0) / len(allv)
        print(f"\n=== {label} (горизонт {HZ} торг.дн, min_vote={args.min_vote}) ===")
        print(f"ВСЕГО: n={len(allv)}  hit={hit*100:.1f}%  ср.={statistics.mean(allv):+.4f}{unit}  "
              f"медиана={statistics.median(allv):+.4f}{unit}")
        print(f"{'год события':<12}{'n':>7}{'hit%':>8}{'ср.'+unit:>12}")
        for yr in sorted(dct):
            v = dct[yr]
            h = sum(1 for x in v if x > 0) / len(v)
            print(f"{yr:<12}{len(v):>7}{h*100:>7.1f}%{statistics.mean(v):>+12.4f}")

    print(f"\nсобытий (эмитент×год с направлением): {n_events}   сделок (×бонд×исход): {n_trades}")
    print(f"отсев: {dbg}")
    _report(ev_price, "signed ЦЕНА бонда (dir · price_ret)", "")
    _report(ev_yield, "signed −Δ ДОХОДНОСТЬ (dir · −Δyield, п.п.)", "пп")
    print("\nчитать: hit>55% и ср.>0 УСТОЙЧИВО по годам = кредитный PEAD есть. "
          "Плюс в 1-2 годах из N = шум. Доходность (Δyield) чище цены для разных дюраций.")


if __name__ == "__main__":
    main()
