"""bond_forward.py — ФОРВАРДНЫЙ сбор кредитного PEAD (без survivorship).

Ретроспективно PEAD не проверить (нет истории по мёртвым бумагам, а живые дают
смещение в плюс). Тут наоборот: фиксируем сигнал и цену СЕЙЧАС, дрейф меряем
ВПЕРЁД. Вселенная замораживается в момент записи — если бумага потом
дефолтнёт/провалится, она останется в выборке как крах цены (честно).

record  — по свежим годовым отчётам (dump reports/) считает направление
          (fy vs fy-1, тот же vote, что в bond_pead_local), берёт цену КАЖДОЙ
          живой бумаги эмитента сейчас (T-Invest, дневная свеча) и дописывает в
          журнал data/pead_forward/journal.jsonl. Дедуп по (inn,fy,secid) —
          повторный запуск не задваивает; новые отчёты (новый fy) добавит.
measure — по журналу тянет ТЕКУЩУЮ цену, считает signed = dir·(now/entry−1),
          market-neutral (минус средний ход всех бумаг журнала), разрез по
          «сколько дней держим» и по стороне. Гонять через 1-2 месяца.

Запуск (из invest-bot, cert-переменные песочницы):
    py -3.11 bond_forward.py record          # сейчас — заморозить базу t0
    py -3.11 bond_forward.py measure          # через месяцы — дрейф вперёд
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import sys
import time
from datetime import datetime, timedelta, timezone

from tinkoff.invest import Client, CandleInterval, InstrumentStatus
from invest_api.invest_target import INVEST_TARGET
from dashboard import _config

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DUMP = os.path.join(_ROOT, "data", "bond_dump")
FWD = os.path.join(_ROOT, "data", "pead_forward")
JOURNAL = os.path.join(FWD, "journal.jsonl")
_ANNUAL = {"FY", "ГОД", "12М", "12M", "Y"}


def _num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _sign(x):
    return 0 if x is None else (1 if x > 0 else (-1 if x < 0 else 0))


def _fund_dir(cur, prev, min_vote):
    d = lambda a, b: None if (a is None or b is None) else a - b
    votes = [
        _sign(d(_num(cur.get("rev")),         _num(prev.get("rev")))),
        _sign(d(_num(cur.get("np")),          _num(prev.get("np")))),
        _sign(d(_num(cur.get("ebitda_marg")), _num(prev.get("ebitda_marg")))),
        -_sign(d(_num(cur.get("net_debt_eq")), _num(prev.get("net_debt_eq")))),
    ]
    nz = [v for v in votes if v != 0]
    if len(nz) < 2:
        return 0
    s = sum(votes)
    return 0 if abs(s) < min_vote else (1 if s > 0 else -1)


def _annual(reports):
    by = {}
    for r in reports:
        if (r.get("period") or "").strip().upper() not in _ANNUAL:
            continue
        y = r.get("fy_year")
        if y is None:
            continue
        by[int(y)] = r          # последняя запись по году (source-порядок не важен)
    return by


def _isin2figi(client):
    m = {}
    for b in client.instruments.bonds(instrument_status=InstrumentStatus.INSTRUMENT_STATUS_ALL).instruments:
        if b.isin:
            m[b.isin.upper()] = b.figi
    return m


def _last_price(client, figi):
    now = datetime.now(timezone.utc)
    resp = client.market_data.get_candles(
        figi=figi, from_=now - timedelta(days=20), to=now,
        interval=CandleInterval.CANDLE_INTERVAL_DAY)
    cs = [c for c in resp.candles if c.is_complete]
    if not cs:
        return None, None
    c = cs[-1]
    return c.time.date().isoformat(), c.close.units + c.close.nano / 1e9


def _inn_bonds():
    m = {}
    for f in glob.glob(os.path.join(DUMP, "issuer_bonds", "*.json")):
        inn = os.path.basename(f)[:-5]
        try:
            for row in json.load(open(f, encoding="utf-8")).get("data", []):
                sc = (row.get("secid") or "").upper()
                if sc:
                    m.setdefault(inn, []).append(sc)
        except Exception:
            pass
    return m


def _load_journal():
    rows = []
    if os.path.exists(JOURNAL):
        for line in open(JOURNAL, encoding="utf-8"):
            line = line.strip()
            if line:
                try:
                    rows.append(json.loads(line))
                except Exception:
                    pass
    return rows


def cmd_record(args):
    os.makedirs(FWD, exist_ok=True)
    rep_dir = os.path.join(DUMP, "reports")
    if not os.path.isdir(rep_dir):
        sys.exit("нет dump/reports — сначала bond_dump.py")
    inn_bonds = _inn_bonds()
    existing = {(r["inn"], r["fy_year"], r["secid"]) for r in _load_journal()}

    # собираем сигналы (только самый свежий год с дельтой)
    sigs = []   # (inn, fy, dir)
    for f in glob.glob(os.path.join(rep_dir, "*.json")):
        inn = os.path.basename(f)[:-5]
        if inn not in inn_bonds:
            continue
        try:
            reports = json.load(open(f, encoding="utf-8")).get("data", [])
        except Exception:
            continue
        by = _annual(reports)
        if not by:
            continue
        fy = max(by)
        if (fy - 1) not in by:
            continue
        d = _fund_dir(by[fy], by[fy - 1], args.min_vote)
        if d != 0:
            sigs.append((inn, fy, d))
    print(f"[record] эмитентов с сигналом: {len(sigs)}", file=sys.stderr)

    ts = datetime.now(timezone.utc).date().isoformat()
    added = skipped = nofigi = 0
    with Client(_config.tinkoff_token, app_name=_config.tinkoff_app_name, target=INVEST_TARGET) as client:
        i2f = _isin2figi(client)
        print(f"[record] облигаций в справочнике API: {len(i2f)}", file=sys.stderr)
        out = open(JOURNAL, "a", encoding="utf-8")
        for k, (inn, fy, d) in enumerate(sigs):
            for secid in inn_bonds.get(inn, []):
                if (inn, fy, secid) in existing:
                    skipped += 1
                    continue
                figi = i2f.get(secid)
                if not figi:
                    nofigi += 1
                    continue
                try:
                    edate, eprice = _last_price(client, figi)
                except Exception:
                    edate, eprice = None, None
                if not eprice or eprice <= 0:
                    continue
                out.write(json.dumps({
                    "logged_at": ts, "inn": inn, "fy_year": fy, "dir": d,
                    "secid": secid, "figi": figi,
                    "entry_date": edate, "entry_price": eprice,
                }, ensure_ascii=False) + "\n")
                added += 1
                time.sleep(args.sleep)
            if k % 25 == 0:
                print(f"[record] {k+1}/{len(sigs)} (записано {added}, пропущено {skipped}, "
                      f"нет FIGI {nofigi})", file=sys.stderr)
        out.close()
    print(f"[record] ГОТОВО: +{added} записей (было уникальных {len(existing)}), "
          f"пропущено {skipped}, нет FIGI {nofigi}. Журнал: {JOURNAL}", file=sys.stderr)
    print("[record] через 1-2 месяца: py -3.11 bond_forward.py measure", file=sys.stderr)


def cmd_measure(args):
    rows = _load_journal()
    if not rows:
        sys.exit("журнал пуст — сначала bond_forward.py record")
    today = datetime.now(timezone.utc).date()
    recs = []   # (days_held, dir, raw)
    with Client(_config.tinkoff_token, app_name=_config.tinkoff_app_name, target=INVEST_TARGET) as client:
        cache = {}
        for k, r in enumerate(rows):
            figi = r.get("figi")
            if figi not in cache:
                try:
                    cache[figi] = _last_price(client, figi)
                except Exception:
                    cache[figi] = (None, None)
                time.sleep(args.sleep)
            _, price = cache[figi]
            if not price or not r.get("entry_price"):
                continue
            raw = price / r["entry_price"] - 1.0
            try:
                held = (today - datetime.strptime(r["entry_date"], "%Y-%m-%d").date()).days
            except Exception:
                held = (today - datetime.strptime(r["logged_at"], "%Y-%m-%d").date()).days
            recs.append((held, r["dir"], raw))
            if k % 50 == 0:
                print(f"[measure] {k+1}/{len(rows)}", file=sys.stderr)
    if not recs:
        sys.exit("нет замеров")

    mean_raw = sum(x[2] for x in recs) / len(recs)   # market-neutral базис (весь пул)
    def _stat(sub):
        n = len(sub)
        if not n:
            return None
        sp = sum(d * raw for _, d, raw in sub) / n
        sn = sum(d * (raw - mean_raw) for _, d, raw in sub) / n
        hit = sum(1 for _, d, raw in sub if d * raw > 0) / n
        return n, sp, sn, hit

    print(f"\n=== ФОРВАРД PEAD · нетто по цене (без survivorship), замер {today} ===")
    print(f"записей в журнале: {len(rows)}, с ценой: {len(recs)}, "
          f"средний ход пула: {mean_raw*100:+.3f}%")
    print(f"\n{'мин.дней держим':<18}{'n':>7}{'RAW signed%':>13}{'NEU signed%':>13}{'hit%':>8}")
    for thr in (30, 60, 90, 120, 180, 250):
        sub = [x for x in recs if x[0] >= thr]
        st = _stat(sub)
        if st:
            n, sp, sn, hit = st
            print(f"≥{thr:<17}{n:>7}{sp*100:>+13.4f}{sn*100:>+13.4f}{hit*100:>7.1f}%")
    print(f"\n— по стороне (весь пул) —")
    for dd, name in ((1, "улучшение"), (-1, "ухудшение")):
        st = _stat([x for x in recs if x[1] == dd])
        if st:
            n, sp, sn, hit = st
            print(f"{name:<12} n={n:>5}  RAW {sp*100:+.3f}%  NEU {sn*100:+.3f}%  hit {hit*100:.1f}%")
    print("\nвердикт: NEU signed%>0 на горизонте ≥60-90 дней И на обеих сторонах, "
          "устойчиво при следующих замерах = форвардный фундаментальный сигнал есть "
          "(это уже без survivorship и без ретро-подгонки).")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=("record", "measure"))
    ap.add_argument("--min-vote", type=int, default=2)
    ap.add_argument("--sleep", type=float, default=0.2)
    args = ap.parse_args()
    (cmd_record if args.cmd == "record" else cmd_measure)(args)


if __name__ == "__main__":
    main()
