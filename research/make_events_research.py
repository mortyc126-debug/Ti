"""make_events_research.py — events.csv для earnings_drift.py.

Собирает события из РУЧНОГО файла дат (releases.csv — для точности available_at)
+ считает признаки f_* из локальных снимков отчётности + прикидывает внимание
по базе новостей.

Вход:
  research/releases.csv — заполняешь вручную:
      event_id,ticker,inn,fy_year,available_at[,low_attention]
    available_at — когда отчёт стал доступен (UTC, ISO). Точность на тебе.
    low_attention — можно оставить пустым: посчитается из news-cache (прокси).
  web/public/reports-cache/<inn>.json — годовые показатели (rev/np/ebitda/…).
  web/public/news-cache.json — для прокси внимания (необязательно).

Признаки (год к году, точка-в-прошлом по факту отчётного года):
  f_revenue_yoy     = rev/rev_prev − 1
  f_margin_change   = np/rev − np_prev/rev_prev
  f_cfo_assets      = cfo/assets           (пусто, если нет CFO в снимке)
  f_leverage_change = debt/assets − (debt/assets)_prev

Запуск:  py -3.11 make_events_research.py   → research/events.csv
"""
from __future__ import annotations

import csv
import json
import os
from datetime import datetime, timedelta, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PUB = os.path.join(ROOT, "web", "public")
REL = os.path.join(ROOT, "research", "releases.csv")
OUT = os.path.join(ROOT, "research", "events.csv")

_ANN = {"", "FY", "ГОД", "YEAR", "ANNUAL", "12M", "Y"}


def _num(v):
    try:
        f = float(v)
        return f if f == f else None   # NaN → None
    except (TypeError, ValueError):
        return None


def _annual_rows(inn):
    """годовые строки эмитента из снимка: {fy_year -> row}, приоритет МСФО."""
    path = os.path.join(PUB, "reports-cache", f"{inn}.json")
    if not os.path.exists(path):
        return {}
    try:
        data = json.load(open(path, encoding="utf-8")).get("data", [])
    except Exception:
        return {}
    out = {}
    for r in data:
        period = str(r.get("period") or "").strip().upper()
        if period not in _ANN and not ("ГОД" in period or period in _ANN):
            continue
        y = r.get("fy_year")
        if y is None:
            continue
        y = int(y)
        std = str(r.get("std") or "")
        pref = 1 if ("МСФО" in std or "IFRS" in std.upper()) else 0
        if y not in out or pref >= out[y][0]:
            out[y] = (pref, r)
    return {y: v[1] for y, v in out.items()}


def _features(cur, prev):
    rev, np_ = _num(cur.get("rev")), _num(cur.get("np"))
    rev0, np0 = _num(prev.get("rev")), _num(prev.get("np"))
    assets, debt = _num(cur.get("assets")), _num(cur.get("debt"))
    assets0, debt0 = _num(prev.get("assets")), _num(prev.get("debt"))
    cfo = _num(cur.get("cfo"))
    f = {}
    f["f_revenue_yoy"] = (rev / rev0 - 1) if (rev is not None and rev0) else ""
    f["f_margin_change"] = (
        (np_ / rev - np0 / rev0)
        if (np_ is not None and rev and np0 is not None and rev0) else ""
    )
    f["f_cfo_assets"] = (cfo / assets) if (cfo is not None and assets) else ""
    f["f_leverage_change"] = (
        (debt / assets - debt0 / assets0)
        if (debt is not None and assets and debt0 is not None and assets0) else ""
    )
    return f


def _news_attention():
    """ticker -> список дат публикаций (для прокси внимания)."""
    path = os.path.join(PUB, "news-cache.json")
    if not os.path.exists(path):
        return {}
    try:
        rows = json.load(open(path, encoding="utf-8"))
    except Exception:
        return {}
    m = {}
    for n in rows:
        tk = str(n.get("ticker") or "").upper()
        d = n.get("published")
        if tk and d:
            m.setdefault(tk, []).append(str(d)[:10])
    return m


def _low_attention(ticker, avail, news):
    """прокси: мало новостей за 90 дней ДО публикации → выше низкое внимание."""
    dates = news.get(str(ticker).upper())
    if not dates:
        return 0.9        # новостей нет вовсе → предположительно низкое внимание
    try:
        t1 = datetime.fromisoformat(avail.replace("Z", "+00:00")).astimezone(timezone.utc)
    except Exception:
        return ""
    t0 = t1 - timedelta(days=90)
    cnt = 0
    for d in dates:
        try:
            dd = datetime.fromisoformat(d).replace(tzinfo=timezone.utc)
        except Exception:
            continue
        if t0 <= dd < t1:
            cnt += 1
    # грубая шкала: 0 нов.→0.9, 1-2→0.6, 3-5→0.35, >5→0.15
    return 0.9 if cnt == 0 else 0.6 if cnt <= 2 else 0.35 if cnt <= 5 else 0.15


def main():
    if not os.path.exists(REL):
        raise SystemExit(
            f"нет {REL} — заполни вручную по образцу releases.example.csv "
            "(event_id,ticker,inn,fy_year,available_at[,low_attention])"
        )
    news = _news_attention()
    rel = list(csv.DictReader(open(REL, encoding="utf-8-sig")))

    out_rows, skipped = [], []
    for r in rel:
        tk = (r.get("ticker") or "").strip()
        inn = (r.get("inn") or "").strip()
        avail = (r.get("available_at") or "").strip()
        try:
            fy = int(r.get("fy_year"))
        except (TypeError, ValueError):
            skipped.append((r.get("event_id"), "плохой fy_year")); continue
        if not (tk and inn and avail):
            skipped.append((r.get("event_id"), "нет ticker/inn/available_at")); continue

        rows = _annual_rows(inn)
        if fy not in rows or (fy - 1) not in rows:
            skipped.append((r.get("event_id"), f"нет отчётов {fy}/{fy-1} в снимке")); continue

        feats = _features(rows[fy], rows[fy - 1])
        la = r.get("low_attention")
        la = float(la) if (la not in (None, "")) else _low_attention(tk, avail, news)

        out_rows.append({
            "event_id": (r.get("event_id") or f"{tk}_{fy}").strip(),
            "ticker": tk,
            "available_at": avail,
            "low_attention": round(float(la), 3) if la != "" else "",
            **feats,
        })

    if not out_rows:
        raise SystemExit(f"нечего писать. Пропущено: {skipped}")

    cols = ["event_id", "ticker", "available_at", "low_attention",
            "f_revenue_yoy", "f_margin_change", "f_cfo_assets", "f_leverage_change"]
    with open(OUT, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=cols)
        w.writeheader()
        for row in out_rows:
            w.writerow({k: (round(v, 6) if isinstance(v, float) else v) for k, v in row.items()})

    print(f"событий записано: {len(out_rows)} → {OUT}")
    if skipped:
        print("пропущены:", skipped)


if __name__ == "__main__":
    main()
