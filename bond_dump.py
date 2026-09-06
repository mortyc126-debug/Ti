"""bond_dump.py — выгрузка сырья для кредитного PEAD с backend (bondan-backend)
в локальные JSON. Считать анализ потом офлайн (bond_pead_local.py), чтобы D1
НЕ участвовал в вычислениях — он таймаутит на тяжёлых GROUP BY (/analysis/
credit_pead молча отдавал count:0). Тут только лёгкие индексированные чтения:

  /catalog                     один раз (тяжёлый, но кешируется на час у CDN):
                               эмитенты + карта бондов isin→issuerInn
  /issuers/report_years        крошечный: у кого есть отчёты (ограничить объём)
  /issuer/{inn}/reports        по inn (индекс) — годовые РСБУ/МСФО
  /bond/history?secid=X        по secid (индекс) — дневной ряд цены/доходности

Резюмируемо: уже скачанные непустые файлы пропускаются, повторный запуск
дотягивает недостающее. Ретраи с бэкоффом, curl (идёт через системный прокси
как браузер — urllib на антивирус-прокси виснет на крупных телах).

Запуск (на машине с доступом к backend):
    py -3.11 bond_dump.py
    py -3.11 bond_dump.py --only-reported   # только эмитенты с отчётами (быстрее)
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.request

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):
        pass

DEFAULT_BASE = "https://bondan-backend.marginacall.workers.dev"
_UA = "Mozilla/5.0"
_CURL = shutil.which("curl") or shutil.which("curl.exe")


def _fetch_raw(url, timeout):
    if _CURL:
        p = subprocess.run(
            [_CURL, "-s", "-S", "--compressed", "-m", str(timeout), "-A", _UA,
             "-H", "Accept: application/json", url],
            capture_output=True, timeout=timeout + 15)
        if p.returncode != 0:
            raise RuntimeError(f"curl rc={p.returncode}: "
                               f"{(p.stderr or b'')[:150].decode('utf-8','replace')}")
        return p.stdout.decode("utf-8")
    req = urllib.request.Request(url, headers={"Accept": "application/json", "User-Agent": _UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode("utf-8")


def _get_json(base, path, timeout=90, tries=5, nonempty=None):
    url = base.rstrip("/") + path
    for att in range(tries):
        try:
            data = json.loads(_fetch_raw(url, timeout))
            if nonempty and not data.get(nonempty):
                raise RuntimeError(f"пустой {nonempty} (D1 transient?)")
            return data
        except Exception as e:
            if att == tries - 1:
                print(f"[warn] {path}: {e}", file=sys.stderr)
                return None
            time.sleep(1.2 * (att + 1))
    return None


def _save(path, obj):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False)


def _fresh(path):
    """файл есть и непустой (не будем перекачивать)."""
    if not os.path.exists(path) or os.path.getsize(path) < 3:
        return False
    try:
        with open(path, encoding="utf-8") as f:
            d = json.load(f)
        return bool(d) and (d.get("count", 1) != 0 if isinstance(d, dict) else True)
    except Exception:
        return False


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default=DEFAULT_BASE)
    ap.add_argument("--out", default=os.path.join(os.path.dirname(
        os.path.abspath(__file__)), "data", "bond_dump"))
    ap.add_argument("--only-reported", action="store_true",
                     help="бонды тянуть только у эмитентов с ≥1 отчётом (быстрее)")
    ap.add_argument("--sleep", type=float, default=0.25, help="пауза между запросами")
    ap.add_argument("--from", dest="date_from", default="2018-01-01",
                     help="от какой даты тянуть историю бондов")
    args = ap.parse_args()
    out = args.out
    os.makedirs(os.path.join(out, "reports"), exist_ok=True)
    os.makedirs(os.path.join(out, "bonds"), exist_ok=True)

    # 1) каталог (карта бонд→эмитент) — один раз, тяжёлый, но кешируется
    cat_path = os.path.join(out, "catalog.json")
    if _fresh(cat_path):
        with open(cat_path, encoding="utf-8") as f:
            catalog = json.load(f)
        print("[dump] каталог из кэша", file=sys.stderr)
    else:
        print("[dump] тяну /catalog (тяжёлый, до минуты)...", file=sys.stderr)
        catalog = _get_json(args.base, "/catalog", timeout=120, nonempty="issuers")
        if not catalog:
            sys.exit("каталог не получен — повтори запуск (CDN закеширует и отдаст)")
        _save(cat_path, catalog)
    issuers = catalog.get("issuers", [])
    bonds = catalog.get("bonds", [])
    print(f"[dump] эмитентов {len(issuers)}  живых бондов {len(bonds)}", file=sys.stderr)

    # 2) у кого есть отчёты
    ry = _get_json(args.base, "/issuers/report_years", timeout=60) or {}
    reported = set((ry.get("map") or {}).keys())
    print(f"[dump] эмитентов с отчётами: {len(reported)}", file=sys.stderr)

    # какие ИНН обрабатываем
    inns = [str(x.get("inn")) for x in issuers if x.get("inn")]
    if args.only_reported:
        inns = [i for i in inns if i in reported]
    # приоритет — те, у кого есть отчёты (для них и качаем бонды)
    target_inns = set(i for i in inns if i in reported) if reported else set(inns)

    # 3) отчёты по эмитентам
    n_ok = 0
    for k, inn in enumerate(sorted(target_inns)):
        rp = os.path.join(out, "reports", f"{inn}.json")
        if _fresh(rp):
            n_ok += 1; continue
        d = _get_json(args.base, f"/issuer/{inn}/reports", timeout=60)
        if d is not None:
            _save(rp, d); n_ok += 1
        if k % 25 == 0:
            print(f"[dump] отчёты {k+1}/{len(target_inns)} (ок {n_ok})", file=sys.stderr)
        time.sleep(args.sleep)
    print(f"[dump] отчёты готовы: {n_ok}/{len(target_inns)}", file=sys.stderr)

    # 4) история бондов — только у целевых эмитентов
    want_secids = []
    for b in bonds:
        inn = str(b.get("issuerInn") or "")
        secid = (b.get("isin") or "").upper()
        if secid and (not target_inns or inn in target_inns):
            want_secids.append(secid)
    want_secids = sorted(set(want_secids))
    print(f"[dump] бондов к выгрузке: {len(want_secids)}", file=sys.stderr)
    n_b = 0
    for k, secid in enumerate(want_secids):
        bp = os.path.join(out, "bonds", f"{secid}.json")
        if _fresh(bp):
            n_b += 1; continue
        d = _get_json(args.base, f"/bond/history?secid={secid}&from={args.date_from}",
                      timeout=90)
        if d is not None:
            _save(bp, d); n_b += 1
        if k % 50 == 0:
            print(f"[dump] бонды {k+1}/{len(want_secids)} (ок {n_b})", file=sys.stderr)
        time.sleep(args.sleep)
    print(f"[dump] ГОТОВО. отчётов {n_ok}, бондов {n_b}. Папка: {out}", file=sys.stderr)
    print(f"[dump] дальше: py -3.11 bond_pead_local.py --dump \"{out}\"", file=sys.stderr)


if __name__ == "__main__":
    main()
