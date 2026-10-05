"""make_reports_bundle.py — один файл базы отчётности для быстрой загрузки.

Отчётность раньше тянула базу по файлу на эмитента (reports-cache/<inn>.json)
— сотни запросов, долго. Этот скрипт сводит всё в ОДИН web/public/
reports-bundle.json, который модуль грузит одним запросом:

  { "<inn>": { "name":…, "ind":…, "bondsCount":…, "rows":[ …строки снимка… ] }, … }

Источники: web/public/reports-cache/*.json (строки отчётов, млн ₽),
issuer-names.json (имя), bonds-cache.json (число выпусков + имя-фолбэк),
industry-peers.json (отрасль по ИНН для peer'ов).

Запускать ПОСЛЕДНИМ в сборе данных (после make_bonds_cache и
make_issuer_names):
    py -3.11 tools/make_reports_bundle.py
"""
from __future__ import annotations

import json
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PUB = os.path.join(ROOT, "web", "public")
RC = os.path.join(PUB, "reports-cache")
OUT = os.path.join(PUB, "reports-bundle.json")


def _load(path, default=None):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return default


def main():
    if not os.path.isdir(RC):
        raise SystemExit(f"нет {RC} — сначала прогони tools/make_bonds_cache.py (он зеркалит reports-cache)")

    names = _load(os.path.join(PUB, "issuer-names.json"), {}) or {}

    # inn -> industry key (из peer'ов отраслей)
    peers = _load(os.path.join(PUB, "industry-peers.json"), {}) or {}
    inn_ind = {}
    for key, v in (peers.get("industries") or {}).items():
        for p in (v.get("peers") or []):
            if p.get("inn"):
                inn_ind[str(p["inn"])] = key

    # inn -> число выпусков + имя-фолбэк (из bonds-cache)
    bonds = _load(os.path.join(PUB, "bonds-cache.json"), []) or []
    bcount, bname = {}, {}
    for b in bonds:
        inn = str(b.get("inn") or "")
        if not inn:
            continue
        bcount[inn] = bcount.get(inn, 0) + 1
        if b.get("issuer") and inn not in bname:
            bname[inn] = b["issuer"]

    bundle, n = {}, 0
    for fn in os.listdir(RC):
        if not fn.endswith(".json") or fn.startswith("_"):
            continue
        inn = fn[:-5]
        doc = _load(os.path.join(RC, fn))
        rows = (doc or {}).get("data") or []
        if not rows:
            continue
        bundle[inn] = {
            "name": names.get(inn) or bname.get(inn) or inn,
            "ind": inn_ind.get(inn) or "other",
            "bondsCount": bcount.get(inn, 0),
            "rows": rows,
        }
        n += 1

    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(bundle, f, ensure_ascii=False)
    size_mb = os.path.getsize(OUT) / 1e6
    print(f"reports-bundle.json: {n} эмитентов, {size_mb:.1f} МБ → {OUT}")


if __name__ == "__main__":
    main()
