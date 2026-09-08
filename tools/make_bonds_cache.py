"""make_bonds_cache.py — снимок цен для «Карты» веб-приложения.

Собирает из локального дампа (data/bond_dump) один файл
web/public/bonds-cache.json = [{secid, inn, mat_date, ytm}], который карта
читает офлайн (не завися от деградировавшей D1). ytm = последняя доступная
доходность из истории бонда, mat_date — из списка бондов эмитента.

Запуск из корня репозитория (там, где index.html):
    py -3.11 tools/make_bonds_cache.py

По умолчанию читает data/bond_dump, пишет web/public/bonds-cache.json.
"""
from __future__ import annotations

import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DUMP = os.path.join(ROOT, "data", "bond_dump")
OUT = os.path.join(ROOT, "web", "public", "bonds-cache.json")


def _num(v):
    try:
        if v is None or v == "":
            return None
        return float(v)
    except (TypeError, ValueError):
        return None


def _robust_yield(secid):
    """устойчивая доходность: медиана последних валидных котировок. Одиночная
    последняя цена бывает битой (дефолт/неликвид → YTM в тысячи %), поэтому
    берём медиану последних до 7 значений в разумном диапазоне 0..100%."""
    path = os.path.join(DUMP, "bonds", f"{secid}.json")
    if not os.path.exists(path):
        return None
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f).get("data", [])
    except Exception:
        return None
    vals = []
    for row in reversed(data):
        y = _num(row.get("yield"))
        if y is not None and 0 < y <= 100:   # >100% = битая цена дефолтной бумаги
            vals.append(y)
        if len(vals) >= 7:
            break
    if not vals:
        return None
    vals.sort()
    return vals[len(vals) // 2]


def main():
    ib_dir = os.path.join(DUMP, "issuer_bonds")
    if not os.path.isdir(ib_dir):
        sys.exit(f"нет папки {ib_dir} — сначала прогони bond_dump.py")

    out = []
    seen = set()
    files = [f for f in os.listdir(ib_dir) if f.endswith(".json")]
    for k, fn in enumerate(files):
        inn = fn[:-5]
        try:
            with open(os.path.join(ib_dir, fn), encoding="utf-8") as f:
                doc = json.load(f)
        except Exception:
            continue
        real_inn = str(doc.get("inn") or inn)
        for b in doc.get("data", []):
            secid = (b.get("secid") or "").upper()
            mat = b.get("mat_date")
            if not secid or not mat or secid in seen:
                continue
            ytm = _last_yield(secid)
            if ytm is None:
                continue
            seen.add(secid)
            out.append({"secid": secid, "inn": real_inn, "mat_date": mat, "ytm": round(ytm, 3)})
        if k % 50 == 0:
            print(f"[cache] эмитенты {k+1}/{len(files)} (бондов с ценой {len(out)})", file=sys.stderr)

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False)
    print(f"[cache] ГОТОВО: {len(out)} выпусков → {OUT}", file=sys.stderr)


if __name__ == "__main__":
    main()
