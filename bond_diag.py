"""bond_diag.py — разовая диагностика: достижимы ли облигации эмитентов с
отчётностью? Прямой ИНН даёт 0 бумаг (развязка отчёт-ИНН vs bond.emitent_inn).
Проверяем: (1) версию воркера, (2) прямой /issuer/{inn}/bonds, (3) мостик через
аффилированность — дочки/родители (SPV «ХХХ-Финанс» выпускают бонды под своим
ИНН, а отчётность у материнской). Печатает, сколько эмитентов достижимо прямо,
через мостик, никак — этого хватит, чтобы решить, чинить ли путь.

Запуск (на машине с доступом к backend, после bond_dump — нужны reports/):
    py -3.11 bond_diag.py
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):
        pass

BASE = "https://bondan-backend.marginacall.workers.dev"
_UA = "Mozilla/5.0"
_CURL = shutil.which("curl") or shutil.which("curl.exe")


def _get(path, timeout=45):
    url = BASE + path
    try:
        p = subprocess.run([_CURL, "-s", "-S", "--compressed", "-m", str(timeout),
                            "-A", _UA, url], capture_output=True, timeout=timeout + 15)
        if p.returncode != 0:
            return None
        return json.loads(p.stdout.decode("utf-8"))
    except Exception:
        return None


def _bonds_count(inn):
    d = _get(f"/issuer/{inn}/bonds")
    if d and isinstance(d.get("data"), list) and "issuer" not in d:
        return len(d["data"])
    # старый эндпоинт (если новый не задеплоен)
    d2 = _get(f"/bond/issuer?inn={inn}")
    if d2 and isinstance(d2.get("data"), list):
        return len(d2["data"])
    return 0


def main():
    dump = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "bond_dump")
    rep_dir = os.path.join(dump, "reports")
    if not os.path.isdir(rep_dir):
        sys.exit("нет data/bond_dump/reports — сначала bond_dump.py")

    st = _get("/status")
    ver = (st or {}).get("version", "??")
    print(f"версия воркера: {ver}  (нужна 0.9.14+ для нового эндпоинта)")
    if st and "db" in st:
        print(f"bonds_with_inn_today: {st['db'].get('bonds_with_inn_today')}")

    inns = [f[:-5] for f in sorted(os.listdir(rep_dir)) if f.endswith(".json")][:20]
    print(f"\nпроверяю {len(inns)} эмитентов с отчётностью:\n")
    print(f"{'ИНН':<14}{'прямых':>8}{'дочек/род':>11}{'через мостик':>14}")
    direct_ok = bridge_ok = none_ok = 0
    for inn in inns:
        nd = _bonds_count(inn)
        aff = _get(f"/issuer/{inn}/affiliations") or {}
        kids = set()
        for row in (aff.get("children") or []):
            if row.get("child_inn"):
                kids.add(str(row["child_inn"]))
        for row in (aff.get("succession") or []):
            if row.get("parent_inn"):
                kids.add(str(row["parent_inn"]))
        nb = 0
        for k in list(kids)[:8]:
            nb += _bonds_count(k)
        print(f"{inn:<14}{nd:>8}{len(kids):>11}{nb:>14}")
        if nd > 0:
            direct_ok += 1
        elif nb > 0:
            bridge_ok += 1
        else:
            none_ok += 1

    print(f"\nИТОГ по {len(inns)}: прямо {direct_ok}, через мостик {bridge_ok}, никак {none_ok}")
    print("читать: прямо>0 → развязки нет, чиним выгрузку; мостик>0 при прямо=0 → "
          "нужен bridge parent↔SPV (построю); всё в 'никак' → в bond_daily нет бумаг "
          "этих эмитентов (enrichment/D1 сломаны) → путь через этот бэкенд закрыт.")


if __name__ == "__main__":
    main()
