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
# короткий UA: длинный Chrome-UA воркер отдавал пустой data (проверено ручным
# curl — short works, long → count:0). "Mozilla/5.0" достаточно, чтобы не 403.
_UA = "Mozilla/5.0"
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
        out = p.stdout.decode("utf-8")
        if os.environ.get("PEAD_DEBUG"):
            print(f"[dbg] {url[-45:]} -> {len(out)}b: {out[:70]!r}", file=sys.stderr)
        return out
    req = urllib.request.Request(url, headers={"Accept": "application/json", "User-Agent": _UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode("utf-8")


def _get(base, path, cache_dir, ttl_days=30, timeout=60, nonempty=None, tries=4):
    """GET c дисковым кэшем (через curl.exe). Возвращает распарсенный JSON или None.
    nonempty: имя ключа, чей пустой список/словарь трактуется как transient-ошибка
    воркера (handleIssuer* при таймауте D1 молча отдаёт count:0) → повтор, НЕ
    кэшируем. Пустой кэш не переиспользуем."""
    safe = path.replace("/", "_").replace("?", "_").replace("&", "_").replace("=", "_")
    cpath = os.path.join(cache_dir, safe + ".json")
    if os.path.exists(cpath):
        age = time.time() - os.path.getmtime(cpath)
        if age < ttl_days * 86400:
            try:
                with open(cpath, encoding="utf-8") as f:
                    cached = json.load(f)
                if not nonempty or cached.get(nonempty):
                    return cached   # непустой кэш ок; пустой — перезапросим
            except Exception:
                pass
    url = base.rstrip("/") + path
    for attempt in range(tries):
        try:
            data = json.loads(_fetch_raw(url, timeout))
            if nonempty and not data.get(nonempty):
                raise RuntimeError(f"пустой {nonempty} (D1 transient?)")
            with open(cpath, "w", encoding="utf-8") as f:
                json.dump(data, f, ensure_ascii=False)
            return data
        except Exception as e:
            if attempt == tries - 1:
                print(f"[warn] {path}: {e}", file=sys.stderr)
                return None
            time.sleep(1.0 * (attempt + 1))
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
    ap.add_argument("--horizon", type=int, default=60, help="горизонт удержания, торг.дн")
    ap.add_argument("--min-vote", type=int, default=2, help="мин.|net голос| из 4 метрик")
    ap.add_argument("--from-year", type=int, default=2019)
    ap.add_argument("--page", type=int, default=40, help="эмитентов на один запрос воркера")
    ap.add_argument("--sleep", type=float, default=0.5, help="пауза между страницами, сек")
    args = ap.parse_args()
    os.makedirs(args.cache_dir, exist_ok=True)

    # Весь event-study считает ВОРКЕР (D1 локально) — /analysis/credit_pead,
    # пагинация по эмитентам (пер-запросная тяга 300+ эмитентов с клиента
    # рвётся/троттлится). Мёржим страницы, печатаем сводку.
    merged = {}   # year -> {np,sp,wp,ny,sy,wy}
    tot = {"n_issuers": 0, "n_events": 0, "n_trades": 0}
    start = 0
    while True:
        path = (f"/analysis/credit_pead?start={start}&count={args.page}"
                f"&horizon={args.horizon}&min_vote={args.min_vote}"
                f"&from_year={args.from_year}")
        # ttl_days=0 — не кэшируем (параметрический расчёт); повторы на transient
        r = _get(args.base, path, args.cache_dir, ttl_days=0, timeout=120)
        if not r:
            print(f"[warn] страница start={start} не получена — стоп", file=sys.stderr)
            break
        for k in tot:
            tot[k] += r.get(k, 0)
        for y, a in (r.get("agg") or {}).items():
            m = merged.setdefault(int(y), {"np":0,"sp":0.0,"wp":0,"ny":0,"sy":0.0,"wy":0})
            for kk in m:
                m[kk] += a.get(kk, 0)
        returned = r.get("returned", 0)
        print(f"[pead] start={start} returned={returned} "
              f"events={tot['n_events']} trades={tot['n_trades']}", file=sys.stderr)
        if returned < args.page:
            break
        start += args.page
        time.sleep(args.sleep)

    if not merged:
        sys.exit("нет данных (agg пуст)")

    print(f"\nэмитентов с сигналом: {tot['n_issuers']}   событий: {tot['n_events']}   "
          f"сделок (×бонд): {tot['n_trades']}")

    def _tbl(kind, label, unit):
        nk, sk, wk = ("np","sp","wp") if kind=="p" else ("ny","sy","wy")
        N = sum(m[nk] for m in merged.values())
        if not N:
            print(f"\n{label}: нет данных"); return
        S = sum(m[sk] for m in merged.values()); W = sum(m[wk] for m in merged.values())
        print(f"\n=== {label} (горизонт {args.horizon} торг.дн, min_vote={args.min_vote}) ===")
        print(f"ВСЕГО: n={N}  hit={W/N*100:.1f}%  ср.={S/N:+.4f}{unit}")
        print(f"{'год события':<12}{'n':>7}{'hit%':>8}{'ср.'+unit:>12}")
        for y in sorted(merged):
            m = merged[y]; n = m[nk]
            if not n: continue
            print(f"{y:<12}{n:>7}{m[wk]/n*100:>7.1f}%{m[sk]/n:>+12.4f}")

    _tbl("p", "signed ЦЕНА бонда (dir · price_ret)", "")
    _tbl("y", "signed -Δ ДОХОДНОСТЬ (dir · -Δyield, п.п.)", "пп")
    print("\nчитать: hit>55% и ср.>0 УСТОЙЧИВО по годам = кредитный PEAD есть. "
          "Плюс в 1-2 годах из N = шум. Доходность (Δyield) чище цены для дюраций.")


if __name__ == "__main__":
    main()
