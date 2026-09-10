"""make_issuer_names.py — словарь имён эмитентов {inn: name} для веб-приложения.

Зачем: снимки (reports-cache, bonds-cache) несут только ИНН, а backend-каталог
имён (catalog) деградировал, поэтому в «Сравнении»/списках эмитенты выглядят
цифрами (ИНН). Этот скрипт тянет из MOEX ISS список облигаций (SECID→SECNAME),
сводит SECNAME к имени эмитента и связывает с ИНН через web/public/bonds-cache.json
(там пары secid↔inn). Пишет:
  web/public/issuer-names.json = {"<inn>": "<Имя эмитента>", ...}

Запуск (нужен интернет к iss.moex.com):
    py -3.11 tools/make_issuer_names.py
"""
from __future__ import annotations

import json
import os
import re
import sys
import time
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BONDS = os.path.join(ROOT, "web", "public", "bonds-cache.json")
OUT = os.path.join(ROOT, "web", "public", "issuer-names.json")
ISS = "https://iss.moex.com/iss/engines/stock/markets/bonds/securities.json"


def _fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode("utf-8"))


# SECNAME → имя эмитента: берём часть до серии выпуска (цифры/БО/00.., дефис).
def _clean(secname):
    s = str(secname or "").strip()
    if not s:
        return ""
    # срез по типичным маркерам серии
    s = re.split(r"[-–—]\s*(?:БО|Б\d|\d{2,}|00|П|выпуск)|,|\bсер\b", s, flags=re.IGNORECASE)[0]
    s = re.split(r"\s\d{2,}", s)[0]
    return s.strip(" -–—.").strip()


def _secid_to_secname():
    out = {}
    start = 0
    while True:
        url = f"{ISS}?iss.only=securities&securities.columns=SECID,SECNAME,SHORTNAME&start={start}"
        try:
            d = _fetch(url)
        except Exception as e:
            print(f"[names] iss start={start}: {e}", file=sys.stderr)
            break
        sec = d.get("securities", {})
        cols = sec.get("columns", [])
        rows = sec.get("data", [])
        if not rows:
            break
        ci = {c: i for i, c in enumerate(cols)}
        for r in rows:
            secid = str(r[ci["SECID"]]).upper()
            nm = r[ci.get("SECNAME", -1)] if "SECNAME" in ci else None
            sn = r[ci.get("SHORTNAME", -1)] if "SHORTNAME" in ci else None
            out[secid] = nm or sn
        start += len(rows)
        time.sleep(0.15)
        if len(rows) < 100:
            break
    return out


def main():
    if not os.path.exists(BONDS):
        sys.exit(f"нет {BONDS} — сначала прогони make_bonds_cache.py")
    bonds = json.load(open(BONDS, encoding="utf-8"))
    secid_inn = {}
    for b in bonds:
        secid = str(b.get("secid") or "").upper()
        inn = b.get("inn")
        if secid and inn:
            secid_inn[secid] = str(inn)

    names_by_secid = _secid_to_secname()
    print(f"[names] MOEX выпусков: {len(names_by_secid)}", file=sys.stderr)

    # inn → лучший (самый длинный/частый) вариант имени
    cand = {}
    for secid, inn in secid_inn.items():
        nm = _clean(names_by_secid.get(secid))
        if not nm:
            continue
        cand.setdefault(inn, {})
        cand[inn][nm] = cand[inn].get(nm, 0) + 1

    result = {}
    for inn, variants in cand.items():
        # берём самое частое, при равенстве — самое длинное
        best = sorted(variants.items(), key=lambda kv: (kv[1], len(kv[0])), reverse=True)[0][0]
        result[inn] = best

    json.dump(result, open(OUT, "w", encoding="utf-8"), ensure_ascii=False)
    print(f"[names] имён эмитентов: {len(result)} → {OUT}", file=sys.stderr)
    print("[names] ГОТОВО. Обнови веб — в «Сравнении» появятся имена вместо ИНН.", file=sys.stderr)


if __name__ == "__main__":
    main()
