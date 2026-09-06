"""bond_dump.py — выгрузка сырья для кредитного PEAD с backend (bondan-backend)
в локальные JSON. Анализ потом офлайн (bond_pead_local.py), чтобы D1 НЕ
участвовал в вычислениях.

ВАЖНО про сеть: антивирус-прокси на машине стопорит крупные тела (~24КБ
получено → таймаут). Поэтому НЕ дёргаем тяжёлый /catalog и держим каждый
ответ маленьким:
  /issuers/report_years        крошечный: у кого есть отчёты
  /issuer/{inn}/reports        по inn (индекс) — годовые показатели
  /issuer/{inn}/bonds          по inn (индекс) — ВСЕ secid эмитента (нужен
                               свежий воркер с этим эндпоинтом)
  /bond/history?secid=X        по secid, КУСКАМИ ПО ГОДАМ (тело маленькое)

Резюмируемо: непустые файлы пропускаются, повторный запуск дотягивает.
Ретраи с бэкоффом, curl (идёт через системный прокси как браузер).

Запуск (на машине с доступом к backend):
    py -3.11 bond_dump.py
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
from datetime import datetime

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


def _get_json(base, path, timeout=45, tries=5, nonempty=None):
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


def _fetch_issuer_bonds(base, inn):
    """secid'ы эмитента. Сначала новый лёгкий /issuer/{inn}/bonds; если воркер
    не задеплоен (вернул карточку — есть ключ 'issuer', нет 'data') — фолбэк на
    старый /bond/issuer?inn=X (живые бумаги; работает в текущем воркере)."""
    d = _get_json(base, f"/issuer/{inn}/bonds", timeout=45)
    if d and isinstance(d.get("data"), list) and "issuer" not in d:
        return {"inn": inn, "count": len(d["data"]),
                "data": [{"secid": (r.get("secid") or "").upper(),
                          "mat_date": r.get("mat_date")} for r in d["data"] if r.get("secid")]}
    # фолбэк — старый эндпоинт
    d2 = _get_json(base, f"/bond/issuer?inn={inn}", timeout=45)
    if d2 and isinstance(d2.get("data"), list):
        return {"inn": inn, "count": len(d2["data"]),
                "data": [{"secid": (r.get("secid") or "").upper(),
                          "mat_date": r.get("mat_date")} for r in d2["data"] if r.get("secid")]}
    return None


def _save(path, obj):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False)


def _fresh(path):
    if not os.path.exists(path) or os.path.getsize(path) < 3:
        return False
    try:
        with open(path, encoding="utf-8") as f:
            d = json.load(f)
        if isinstance(d, dict):
            return "count" in d   # даже count:0 — валидный «нет данных», не тянем снова
        return bool(d)
    except Exception:
        return False


def _fresh_nonempty(path):
    """как _fresh, но count:0 считается НЕ готовым — перезапросим (транзиентный
    таймаут D1 мог записать пустой список бондов). Для issuer_bonds."""
    if not os.path.exists(path) or os.path.getsize(path) < 3:
        return False
    try:
        with open(path, encoding="utf-8") as f:
            d = json.load(f)
        return isinstance(d, dict) and d.get("count", 0) > 0
    except Exception:
        return False


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default=DEFAULT_BASE)
    ap.add_argument("--out", default=os.path.join(os.path.dirname(
        os.path.abspath(__file__)), "data", "bond_dump"))
    ap.add_argument("--from-year", type=int, default=2018, help="от какого года тянуть историю")
    ap.add_argument("--sleep", type=float, default=0.2, help="пауза между запросами")
    args = ap.parse_args()
    out = args.out
    for sub in ("reports", "issuer_bonds", "bonds"):
        os.makedirs(os.path.join(out, sub), exist_ok=True)

    # 1) у кого есть отчёты (крошечный ответ)
    ry = _get_json(args.base, "/issuers/report_years", timeout=45)
    if not ry or not ry.get("map"):
        sys.exit("не получил /issuers/report_years — повтори запуск")
    inns = sorted((ry.get("map") or {}).keys())
    print(f"[dump] эмитентов с отчётами: {len(inns)}", file=sys.stderr)

    # 2) отчёты + список бондов по каждому эмитенту
    all_secids = {}   # secid -> inn (для истории)
    n_rep = n_ib = 0
    for k, inn in enumerate(inns):
        rp = os.path.join(out, "reports", f"{inn}.json")
        if not _fresh(rp):
            d = _get_json(args.base, f"/issuer/{inn}/reports", timeout=45)
            if d is not None:
                _save(rp, d)
        if _fresh(rp):
            n_rep += 1
        ib = os.path.join(out, "issuer_bonds", f"{inn}.json")
        if not _fresh_nonempty(ib):
            d = _fetch_issuer_bonds(args.base, inn)
            if d is not None:
                _save(ib, d)
        if _fresh_nonempty(ib):
            n_ib += 1
            try:
                with open(ib, encoding="utf-8") as f:
                    for row in json.load(f).get("data", []):
                        sc = (row.get("secid") or "").upper()
                        if sc:
                            all_secids[sc] = inn
            except Exception:
                pass
        if k % 25 == 0:
            print(f"[dump] эмитенты {k+1}/{len(inns)} (отчёты {n_rep}, списки бондов {n_ib})",
                  file=sys.stderr)
        time.sleep(args.sleep)
    print(f"[dump] отчётов {n_rep}, списков бондов {n_ib}, уникальных бондов {len(all_secids)}",
          file=sys.stderr)

    # 3) история бондов — КУСКАМИ ПО ГОДАМ (маленькое тело), мёржим
    cur_year = datetime.now().year
    years = list(range(args.from_year, cur_year + 1))
    secids = sorted(all_secids)
    n_b = 0
    for k, secid in enumerate(secids):
        bp = os.path.join(out, "bonds", f"{secid}.json")
        if _fresh(bp):
            n_b += 1
            if k % 50 == 0:
                print(f"[dump] бонды {k+1}/{len(secids)} (ок {n_b})", file=sys.stderr)
            continue
        merged = []
        ok = True
        for y in years:
            d = _get_json(args.base,
                          f"/bond/history?secid={secid}&from={y}-01-01&to={y}-12-31",
                          timeout=45)
            if d is None:
                ok = False; break
            merged.extend(d.get("data", []))
            time.sleep(args.sleep)
        if ok:
            merged.sort(key=lambda r: r.get("date", ""))
            _save(bp, {"secid": secid, "count": len(merged), "data": merged})
            n_b += 1
        if k % 50 == 0:
            print(f"[dump] бонды {k+1}/{len(secids)} (ок {n_b})", file=sys.stderr)
    print(f"[dump] ГОТОВО. отчётов {n_rep}, бондов {n_b}. Папка: {out}", file=sys.stderr)
    print(f"[dump] дальше: py -3.11 bond_pead_local.py --dump \"{out}\"", file=sys.stderr)


if __name__ == "__main__":
    main()
