"""bond_span.py — глубина истории цен в выгрузке: сколько месяцев реально есть.
Историческому кредитному PEAD нужны годы цен; если база молодая (недели/месяцы),
события 2020-2024 «повисают» (entry_none). Печатает общий диапазон дат и
распределение по годам.
"""
import glob, json, os, sys
from collections import Counter

d = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "bond_dump", "bonds")
files = glob.glob(os.path.join(d, "*.json"))
allmin, allmax = "9999", "0000"
yr = Counter()
nonempty = 0
maxlen = 0; maxlen_span = ("", "")
for f in files:
    try:
        data = json.load(open(f, encoding="utf-8")).get("data", [])
    except Exception:
        continue
    if not data:
        continue
    nonempty += 1
    ds = [r.get("date", "")[:10] for r in data if r.get("date")]
    if not ds:
        continue
    lo, hi = min(ds), max(ds)
    allmin = min(allmin, lo); allmax = max(allmax, hi)
    for x in ds:
        yr[x[:4]] += 1
    if len(data) > maxlen:
        maxlen = len(data); maxlen_span = (lo, hi)

print(f"файлов бондов: {len(files)}, непустых: {nonempty}")
print(f"ОБЩИЙ диапазон дат: {allmin} .. {allmax}")
print(f"самая длинная история: {maxlen} точек, {maxlen_span[0]}..{maxlen_span[1]}")
print("строк по годам:", dict(sorted(yr.items())))
