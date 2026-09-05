"""ensemble_oos.py — честный OOS-тест ансамбля «универсал-сигналов».

Идея (после пулового regime-прогона score_methods): 5 методов показали
устойчивый ПОЛОЖИТЕЛЬНЫЙ знак d во ВСЕХ 6 режимах, на сотнях тикеров и
десятках тысяч срабатываний — DFA_REGIME, ZSCORE, AMIHUD_SHOCK,
TALIB_ANTISIGNAL, BIPOWER_JUMP. Это не подгонка под один контракт (в отличие
от channel_level_fut). Но пуловый d — same-period cross-section. Здесь гоним
их КОМБО через ту же гильотину, что убила channel_level_fut:
  - равновесный ГОЛОС (без режимных флипов — проще = меньше переобучения):
    net = Σ sign(score_m) по методам с |score_m|≥AGREE; сделка если |net|≥min_votes;
  - ЧЕСТНЫЙ вход: сигнал на close бара i → вход по open[i+1] (рынком),
    выход по close[i+k]; доходность в ATR, минус cost;
  - TRAIN/TEST split по времени внутри тикера — читаем ТОЛЬКО test;
  - разрез test по терцилям ЛИКВИДНОСТИ тикера: бот торгует ликвидные фью,
    а пул показал, что edge сильнее на неликвиде (sp_liq<0) — проверяем,
    держится ли плюс в верхней трети (d_hi), где реально можем стоять.

Look-ahead нет: методы на баре i видят только candles[:i+1], вход — со след.
бара. Формулы методов — те же, что у живого бота (импорт oi_composite_strategy
через воркер score_methods, бит-в-бит).

Запуск (как пуловый, чтобы сопоставимо):
    python ensemble_oos.py ALL --workers 8 --stride 3 --top-liq 60 --only-fut \
        --split-frac 0.7 --cost 0.12 --out data/ens_oos.csv
"""
from __future__ import annotations

import argparse
import csv
import multiprocessing as mp
import os
import re
import sys
import time

for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):
        pass

import score_methods as sm  # переиспользуем воркер-инфраструктуру (методы, кэш, ATR)

_HERE = os.path.dirname(os.path.abspath(__file__))
_FUT_RE = re.compile(r"^[A-Z]{1,4}[FGHJKMNQUVXZ]\d$")

# Универсал-сигналы из пулового regime-прогона (устойчивый + во всех режимах).
DEFAULT_ENSEMBLE = ["DFA_REGIME", "ZSCORE", "AMIHUD_SHOCK",
                    "TALIB_ANTISIGNAL", "BIPOWER_JUMP"]


def _is_future(ticker: str) -> bool:
    return bool(_FUT_RE.match(ticker.upper()))


def _run_ticker(job: dict) -> tuple:
    """Один тикер: ансамблевый голос по барам + честная доходность.
    Возвращает (ticker, rec|None). rec = {liq, vol, is_fut, train/test/all:(n,sum,wins)}."""
    np = sm._WORKER_NP
    ticker = job["ticker"]
    rows = sm._load_from_cache(ticker, job["cache_dir"], job["interval"])
    if not rows:
        return ticker, None
    rows = sm._filter_by_dates(rows, job["date_from"], job["date_to"])
    W = job["window"]; S = job["stride"]; K = job["k"]; AGREE = job["agree_min"]
    MINV = job["min_votes"]; COST = job["cost"]; FRAC = job["split_frac"]
    if len(rows) < W + K + 5:
        return ticker, None

    liq, vol = sm._liq_vol(rows)
    candles = [sm._row_to_ns(r) for r in rows]
    closes = np.array([r["close"] for r in rows], dtype=float)
    opens  = np.array([r["open"]  for r in rows], dtype=float)
    highs  = np.array([r["high"]  for r in rows], dtype=float)
    lows   = np.array([r["low"]   for r in rows], dtype=float)
    atr = sm._atr_sma(highs, lows, job["n_atr"])

    methods = [(n, fn) for n, fn in sm._WORKER_METHODS if n in job["methods"]]
    per_method = job.get("per_method", False)
    entry_mode = job.get("entry", "next_open")
    brackets = job.get("brackets") or []   # [(take, stop), ...]; пусто → fixed-k
    H = job.get("horizon", 24)             # макс. держание для брекета (баров)
    folds = job.get("folds", 1)
    n = len(candles)
    # для брекета нужен запас H баров вперёд; для fixed-k — K.
    fwd_need = (H if brackets else K) + 1
    positions = range(W, n - fwd_need - 1, S)
    split_i = int(n * FRAC)   # бары до split_i — train, после — test

    # M[key][bucket] = [n,sum,wins]. key = метод (или ENS) + @take/stop.
    # bucket: при folds>1 — "f0".."f{N-1}"; иначе train/test. Плюс "all".
    def _bkt(i):
        if folds > 1:
            return f"f{min(folds - 1, int(i * folds / n))}"
        return "train" if i < split_i else "test"
    M = {}

    def _entry_price(i):
        return closes[i] if entry_mode == "close" else opens[i + 1]

    def _bracket_ret(dirn, entry, i, a, take, stop):
        """Симуляция брекета от entry: интрабар TP/SL, иначе тайм-стоп по close.
        Возвращает доходность в ATR (без cost). При одновременном касании
        TP и SL в одном баре считаем СТОП (консервативно)."""
        tp = entry + dirn * take * a
        sl = entry - dirn * stop * a
        start = i if entry_mode == "close" else i + 1
        end = min(i + H, n - 1)
        for j in range(start, end + 1):
            hi, lo = highs[j], lows[j]
            if dirn > 0:
                if lo <= sl:
                    return -stop
                if hi >= tp:
                    return take
            else:
                if hi >= sl:
                    return -stop
                if lo <= tp:
                    return take
        return dirn * (closes[end] - entry) / a   # тайм-стоп

    def _push(key, ret, i):
        d = M.setdefault(key, {})
        for b in (_bkt(i), "all"):
            acc = d.setdefault(b, [0, 0.0, 0])
            acc[0] += 1; acc[1] += ret; acc[2] += (1 if ret > 0 else 0)

    market_neutral = job.get("market_neutral", False)
    mn = []   # market-neutral: [(ym, dir, raw_ret_pct)] честный вход, fixed-K

    def _record(base, dirn, i, a):
        entry = _entry_price(i)
        if brackets:
            for take, stop in brackets:
                r = _bracket_ret(dirn, entry, i, a, take, stop) - COST
                _push(f"{base}@{take:g}/{stop:g}", r, i)
        else:
            r = dirn * (closes[i + K] - entry) / a - COST
            _push(base, r, i)
        if market_neutral:
            # цена входа/выхода в %: доходность, сравнимая между тикерами; месяц
            # входа для кросс-секционной демеанизации (снятие макро-прилива)
            ep = closes[i] if entry_mode == "close" else opens[i + 1]
            if ep > 0:
                raw = (closes[i + K] - ep) / ep
                ym = rows[i + 1]["time"][:7]
                mn.append((ym, dirn, raw))

    for i in positions:
        a = atr[i]
        if np.isnan(a) or a <= 0:
            continue
        if per_method:
            # каждый метод — своя направленная сделка
            for name, fn in methods:
                try:
                    sc = fn(candles[i - W:i + 1])
                except Exception:
                    continue
                if sc is None:
                    continue
                if sc >= AGREE:
                    _record(name, 1, i, a)
                elif sc <= -AGREE:
                    _record(name, -1, i, a)
        else:
            votes = 0
            for _name, fn in methods:
                try:
                    sc = fn(candles[i - W:i + 1])
                except Exception:
                    continue
                if sc is None:
                    continue
                if sc >= AGREE:
                    votes += 1
                elif sc <= -AGREE:
                    votes -= 1
            if abs(votes) >= MINV:
                _record("ENS", 1 if votes > 0 else -1, i, a)

    if not M:
        return ticker, None
    # tuple-ify для пикла
    M = {k: {b: tuple(v) for b, v in d.items()} for k, d in M.items()}
    rec = {"liq": liq, "vol": vol, "is_fut": _is_future(ticker), "M": M}
    if market_neutral:
        rec["mn"] = mn
    return ticker, rec


def _agg(recs, mkey, split):
    """Пул по списку rec для метода mkey и сплита split: n, exp (sum/n), win%."""
    n = s = w = 0
    for r in recs:
        d = r["M"].get(mkey)
        if not d:
            continue
        sd = d.get(split)
        if not sd:
            continue
        n += sd[0]; s += sd[1]; w += sd[2]
    if n == 0:
        return (0, None, None)
    return (n, s / n, w / n)


def _fmt(t):
    n, exp, win = t
    if not n:
        return f"n={n:<6} —"
    return f"n={n:<6} exp={exp:+.3f} ATR  win={win*100:.1f}%"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("tickers", help="ALL или список через запятую")
    ap.add_argument("--cache", default=os.path.join(_HERE, "data", "candle_cache"))
    ap.add_argument("--interval", type=int, default=5, choices=(1, 5))
    ap.add_argument("--days", type=int, default=180)
    ap.add_argument("--from", dest="date_from", default=None)
    ap.add_argument("--to", dest="date_to", default=None)
    ap.add_argument("--window", type=int, default=300)
    ap.add_argument("--stride", type=int, default=3)
    ap.add_argument("--k", type=int, default=12, help="горизонт (баров) от входа")
    ap.add_argument("--n-atr", type=int, default=20)
    ap.add_argument("--agree-min", type=float, default=0.15)
    ap.add_argument("--min-votes", type=int, default=2,
                     help="мин. |net голос| для сделки (из 5 методов)")
    ap.add_argument("--cost", type=float, default=0.12, help="кост в ATR/сделку")
    ap.add_argument("--split-frac", type=float, default=0.7,
                     help="доля истории в train (читаем test)")
    ap.add_argument("--methods", default=None,
                     help="переопределить ансамбль (через запятую)")
    ap.add_argument("--top-liq", type=int, default=None)
    ap.add_argument("--only-fut", action="store_true")
    ap.add_argument("--only-stk", action="store_true", help="только акции (не фьючерсы)")
    ap.add_argument("--workers", type=int, default=None)
    ap.add_argument("--out", default=None, help="CSV per-ticker")
    ap.add_argument("--per-method", action="store_true",
                     help="вместо ансамбля — каждый метод соло (диагностика: "
                          "какой держит честный вход)")
    ap.add_argument("--entry", default="next_open", choices=("next_open", "close"),
                     help="next_open=честно (рынком на след. баре); close=«нечестно» "
                          "(по close сигнала) — измерить, сколько альфы съедает gap")
    ap.add_argument("--bracket", default=None,
                     help="сетка брекетов TP/SL в ATR вместо fixed-k выхода: "
                          "'2.0/1.0,3.0/1.0,1.5/1.0'. Интрабар TP/SL + тайм-стоп "
                          "по --horizon. Судить ТОЛЬКО по TEST (иначе подгон брекета).")
    ap.add_argument("--horizon", type=int, default=24,
                     help="макс. держание брекета в барах (тайм-стоп)")
    ap.add_argument("--folds", type=int, default=1,
                     help="N последовательных окон вместо train/test: печатает exp "
                          "по каждому окну. Плюс на БОЛЬШИНСТВЕ окон = робастно; "
                          "плюс на одном = мираж (тест устойчивости во времени).")
    ap.add_argument("--market-neutral", action="store_true",
                     help="Снять макро-прилив: abnormal = доходность − кросс-секц. "
                          "средняя по всем тикерам за тот же месяц. Печатает raw vs "
                          "neutral по состоянию рынка + нетто/OOS (ансамбль, honest, fixed-k).")
    ap.add_argument("--mn-cost", type=float, default=0.001,
                     help="кост round-trip в ДОЛЯХ для market-neutral нетто (0.001=0.1%)")
    args = ap.parse_args()

    brackets = []
    if args.bracket:
        for pair in args.bracket.split(","):
            pair = pair.strip()
            if not pair:
                continue
            tk, st = pair.split("/")
            brackets.append((float(tk), float(st)))

    ens = ([m.strip() for m in args.methods.split(",") if m.strip()]
           if args.methods else DEFAULT_ENSEMBLE)
    ens_set = set(ens)

    if args.date_from or args.date_to:
        date_from, date_to = args.date_from, args.date_to
    else:
        from datetime import datetime, timedelta
        date_to = None
        date_from = (datetime.now() - timedelta(days=args.days)).strftime("%Y-%m-%d")

    if args.tickers.upper() == "ALL":
        tickers = sm._list_tickers(args.cache, args.interval, top_liq=args.top_liq,
                                   workers=args.workers)
    else:
        tickers = [t.strip().upper() for t in args.tickers.split(",") if t.strip()]
    if args.only_fut:
        tickers = [t for t in tickers if _is_future(t)]
    if args.only_stk:
        tickers = [t for t in tickers if not _is_future(t)]
    if not tickers:
        sys.exit("нет тикеров после фильтров")

    mode = "per-method" if args.per_method else f"ансамбль(min_votes={args.min_votes})"
    exit_str = (f"bracket[{args.bracket}] H={args.horizon}" if brackets
                else f"fixed-k={args.k}")
    print(f"[ens] методы: {ens}", file=sys.stderr)
    print(f"[ens] тикеров: {len(tickers)}  режим={mode}  entry={args.entry}  "
          f"exit={exit_str}  cost={args.cost}  split={args.split_frac}", file=sys.stderr)

    jobs = [{"ticker": t, "cache_dir": args.cache, "interval": args.interval,
             "date_from": date_from, "date_to": date_to, "window": args.window,
             "stride": args.stride, "k": args.k, "n_atr": args.n_atr,
             "agree_min": args.agree_min, "min_votes": args.min_votes,
             "cost": args.cost, "split_frac": args.split_frac,
             "methods": ens_set, "per_method": args.per_method,
             "entry": args.entry, "brackets": brackets,
             "horizon": args.horizon, "folds": args.folds,
             "market_neutral": args.market_neutral} for t in tickers]

    n_wk = args.workers or max(1, (mp.cpu_count() or 2) - 1)
    recs = {}
    t0 = time.time()
    done = 0
    if n_wk > 1 and len(jobs) > 1:
        with mp.Pool(processes=n_wk, initializer=sm._init_worker) as pool:
            for ticker, rec in pool.imap_unordered(_run_ticker, jobs, chunksize=1):
                done += 1
                if rec:
                    recs[ticker] = rec
                if done % 10 == 0 or done == len(jobs):
                    print(f"[{done}/{len(jobs)}] {time.time()-t0:.0f}s  "
                          f"с сделками: {len(recs)}", file=sys.stderr)
    else:
        sm._init_worker()
        for j in jobs:
            ticker, rec = _run_ticker(j)
            done += 1
            if rec:
                recs[ticker] = rec

    if not recs:
        sys.exit("нет ни одной сделки на всём наборе")

    rl = list(recs.values())
    print(f"\n=== вход={args.entry}  тикеров со сделками: {len(rl)} "
          f"({sum(r['is_fut'] for r in rl)} фью) ===")

    if args.market_neutral:
        # Все сделки: (ym, dir, raw_ret). Рыночный ход месяца = средняя raw_ret
        # по ВСЕМ сделкам этого месяца (кросс-секц.). abnormal = raw − market.
        allt = [t for r in rl for t in r.get("mn", [])]
        if not allt:
            sys.exit("market-neutral: нет сделок")
        mkt = {}
        for ym, _d, ret in allt:
            mkt.setdefault(ym, []).append(ret)
        mkt_mean = {ym: (sum(v) / len(v)) for ym, v in mkt.items()}
        # Разрез по СОСТОЯНИЮ РЫНКА: месяцы в терцили по рыночному ходу
        # (худшие/средние/лучшие). Прямой тест гипотезы: кратерит ли RAW в плохой
        # фон, пока NEU держится. Год слишком крупен — берём месяц как единицу.
        months = sorted(mkt_mean, key=lambda m: mkt_mean[m])
        t = max(1, len(months) // 3)
        tier = {}
        for idx, m in enumerate(months):
            tier[m] = ("1_плохой_рынок" if idx < t else
                       "3_хороший_рынок" if idx >= 2 * t else "2_средний")
        buckets = {}
        for ym, d, ret in allt:
            b = tier[ym]
            a = buckets.setdefault(b, {"n": 0, "rs": 0.0, "rw": 0, "ns": 0.0, "nw": 0})
            rs = d * ret                       # raw signed
            ns = d * (ret - mkt_mean[ym])      # neutral signed (макро снят)
            a["n"] += 1
            a["rs"] += rs; a["rw"] += 1 if rs > 0 else 0
            a["ns"] += ns; a["nw"] += 1 if ns > 0 else 0
        print(f"\n=== MARKET-NEUTRAL по состоянию рынка (ансамбль "
              f"{DEFAULT_ENSEMBLE if not args.methods else ens}, k={args.k}, gross %) ===")
        print(f"(месяцы в терцили по рыночному ходу; {len(months)} мес всего)")
        print(f"{'бакет':<18}{'n':>7}{'RAW hit':>9}{'RAW ср%':>9}{'NEU hit':>9}{'NEU ср%':>9}")
        tot = {"n": 0, "rs": 0.0, "rw": 0, "ns": 0.0, "nw": 0}
        for b in sorted(buckets):
            a = buckets[b]
            for kk in tot: tot[kk] += a[kk]
            print(f"{b:<18}{a['n']:>7}{a['rw']/a['n']*100:>8.1f}%{a['rs']/a['n']*100:>+9.3f}"
                  f"{a['nw']/a['n']*100:>8.1f}%{a['ns']/a['n']*100:>+9.3f}")
        N = tot["n"]
        print(f"{'ВСЕГО':<18}{N:>7}{tot['rw']/N*100:>8.1f}%{tot['rs']/N*100:>+9.3f}"
              f"{tot['nw']/N*100:>8.1f}%{tot['ns']/N*100:>+9.3f}")
        print("\nчитать: если в '1_плохой_рынок' RAW уходит в минус, а NEU держит "
              "плюс — макро маскировал сигнал (твоя гипотеза). Если NEU≈RAW во всех "
              "терцилях — нейтрализация ничего не добавляет. cost не вычтен (gross).")

        # ── НЕТТО + OOS: хронологический train/test по месяцам ──
        chrono = sorted(mkt_mean)               # месяцы по времени
        cut = int(len(chrono) * 0.7)
        train_ms = set(chrono[:cut]); test_ms = set(chrono[cut:])
        C = args.mn_cost
        def _split(ms):
            n = ns = nw = ns_net = nwnet = 0
            for ym, d, ret in allt:
                if ym not in ms:
                    continue
                s = d * (ret - mkt_mean[ym])    # neutral signed
                n += 1
                ns += s; nw += 1 if s > 0 else 0
                ns_net += s - C; nwnet += 1 if (s - C) > 0 else 0
            if not n:
                return None
            return (n, ns/n, nw/n, ns_net/n, nwnet/n)
        print(f"\n=== NEU нетто/OOS (cost round-trip {C*100:.2f}%, "
              f"train {len(train_ms)}мес / test {len(test_ms)}мес) ===")
        print(f"{'сплит':<8}{'n':>8}{'NEU gross%':>12}{'NEU net%':>11}{'net hit':>9}")
        for lbl, ms in (("TRAIN", train_ms), ("TEST", test_ms)):
            r = _split(ms)
            if not r:
                print(f"{lbl:<8} —"); continue
            n, g, _hg, net, hnet = r
            print(f"{lbl:<8}{n:>8}{g*100:>+12.4f}{net*100:>+11.4f}{hnet*100:>8.1f}%")
        print("\nвердикт: TEST NEU net% > 0 и net hit > 50% → живой торгуемый "
              "рыночно-нейтральный сигнал на акциях. ≤0 → съедается костами (near-miss).")
        return

    keys = sorted({k for r in rl for k in r["M"].keys()})

    if args.folds > 1:
        # Режим устойчивости: exp по каждому окну. Ключи (методы/брекеты) —
        # строки, окна f0..fN — колонки. n_pos справа = сколько окон в плюсе.
        fold_labels = [f"f{j}" for j in range(args.folds)]
        head = f"{'метод/брекет':<22}" + "".join(f"{fl:>9}" for fl in fold_labels) + "   +окон"
        print(head)
        rows = []
        for k in keys:
            exps = [_agg(rl, k, fl)[1] for fl in fold_labels]
            npos = sum(1 for e in exps if e is not None and e > 0)
            allexp = _agg(rl, k, "all")[1]
            rows.append((npos, allexp if allexp is not None else -9, k, exps))
        # сортировка: сперва по числу плюсовых окон, потом по общей exp
        for npos, _ae, k, exps in sorted(rows, key=lambda x: (x[0], x[1]), reverse=True):
            cells = "".join(f"{e:>+9.3f}" if e is not None else f"{'—':>9}" for e in exps)
            print(f"{k:<22}{cells}   {npos}/{args.folds}")
        print("\nробастно = плюс на большинстве окон; плюс на 1-2 из N = мираж")
    elif args.per_method:
        # каждый метод соло: train/test exp/win. Сортировка по test-exp.
        print(f"{'метод':<20} {'TRAIN':>28}   {'TEST (судим)':>28}")
        rows = []
        for k in keys:
            tr = _agg(rl, k, "train"); te = _agg(rl, k, "test")
            rows.append((te[1] if te[1] is not None else -9, k, tr, te))
        for _s, k, tr, te in sorted(rows, reverse=True):
            print(f"{k:<20} {_fmt(tr):>28}   {_fmt(te):>28}")
    else:
        print(f"АНСАМБЛЬ {ens}")
        print(f"TRAIN : {_fmt(_agg(rl, 'ENS', 'train'))}")
        print(f"TEST  : {_fmt(_agg(rl, 'ENS', 'test'))}   ← судим по нему")
        print(f"ALL   : {_fmt(_agg(rl, 'ENS', 'all'))}")
        n_all = _agg(rl, "ENS", "all")[0]
        print(f"частота: {n_all/max(len(rl),1):.1f} сделок/тикер за период")
        # Разрез TEST по терцилям ликвидности (бот торгует верхнюю треть).
        liq_recs = [r for r in rl if r["liq"] is not None
                    and r["M"].get("ENS", {}).get("test", (0,))[0] > 0]
        if len(liq_recs) >= 6:
            liq_recs.sort(key=lambda r: r["liq"])
            t = len(liq_recs) // 3
            lo, mid, hi = liq_recs[:t], liq_recs[t:2 * t], liq_recs[2 * t:]
            print("\n=== TEST по ликвидности тикера (терцили) ===")
            print(f"низкая  : {_fmt(_agg(lo, 'ENS', 'test'))}")
            print(f"средняя : {_fmt(_agg(mid, 'ENS', 'test'))}")
            print(f"ВЫСОКАЯ : {_fmt(_agg(hi, 'ENS', 'test'))}   ← где бот реально стоит")

    if args.out:
        os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
        with open(args.out, "w", newline="", encoding="utf-8") as f:
            wr = csv.writer(f)
            wr.writerow(["ticker", "method", "is_fut", "liq_mln", "vol_pct",
                         "test_n", "test_exp", "test_win",
                         "all_n", "all_exp", "all_win"])
            for tk, r in sorted(recs.items()):
                for mk, d in sorted(r["M"].items()):
                    tn, ts, tw = d.get("test", (0, 0.0, 0)); an, as_, aw = d.get("all", (0, 0.0, 0))
                    wr.writerow([tk, mk, int(r["is_fut"]),
                                 f"{r['liq']:.2f}" if r['liq'] else "",
                                 f"{r['vol']:.3f}" if r['vol'] else "",
                                 tn, f"{ts/tn:+.4f}" if tn else "",
                                 f"{tw/tn:.4f}" if tn else "",
                                 an, f"{as_/an:+.4f}" if an else "",
                                 f"{aw/an:.4f}" if an else ""])
        print(f"\n[out] {args.out}", file=sys.stderr)


if __name__ == "__main__":
    main()
