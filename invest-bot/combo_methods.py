"""
combo_methods.py — офлайн-прогон ПАР (и троек) методов OICompositeStrategy по
кэшу свечей. Дополняет score_methods.py: тот меряет каждый метод ПООДИНОЧКЕ
(его win_rate / Cohen's d), а redundancy_analysis.py — только корреляцию
скоров (дубль ли метод). Ни один не отвечает на вопрос «а что дают связки?».

Идея: на каждой позиции истории считаем скоры ВСЕХ методов сразу, у каждого
определяем сторону (bull: score≥AGREE, bear: score≤−AGREE, иначе молчит).
Дальше по каждой паре сработавших методов копим forward-return, приведённый
к направлению сигнала (g = fwd·знак), в двух вёдрах:

  СОГЛАСИЕ (agree)   — оба метода за одну сторону. edge_agree = средний g.
                       Сравниваем с edge каждого метода ПО ОТДЕЛЬНОСТИ на всех
                       его сигналах. lift = edge_agree − max(edge_A, edge_B).
                       lift>0 = связка бьёт лучший из методов поодиночке (есть
                       синергия), lift≈0 при высокой доле согласия = дубль,
                       lift<0 = антагонизм (пересечение — там где каждый врёт).
  КОНФЛИКТ (conflict)— методы спорят (A bull, B bear). edge_conflict (в сторону
                       первого по алфавиту) показывает, КОМУ верить в споре:
                       >0 верь первому, <0 — второму. Если |t| велик — само
                       несогласие информативно.

Всё считается на той же машинерии, что score_methods.py (тот же кэш, ATR,
forward-return, порог AGREE_SCORE_MIN, режимы) — импортируем её функции, чтобы
цифры были прямо сравнимы с baseline вердиктами. g — в единицах ATR за k
баров (как d в score_methods нормирован на ATR), т.е. «сколько ATR прибыли на
одно срабатывание, если торговать в сторону сигнала».

Запуск:
    python combo_methods.py SBER --days 180
    python combo_methods.py ALL --workers 8 --stride 5 --out combos.csv
    python combo_methods.py ALL --workers 8 --stride 3 --by-regime --out combos.csv
    python combo_methods.py ALL --workers 8 --methods PRICE_TREND,VSA,HAWKES_SIGNAL --size 3
    python combo_methods.py ALL --workers 8 --apply-toggle    # как в боте после чистки

Аргументы — как в score_methods.py, плюс комбо-специфичные:
    --size {2,3}        порядок связки: пары (default) или тройки. Для троек
                        считается только СОГЛАСИЕ (все три за одну сторону);
                        разумно сузить пул через --methods, иначе таблица огромна.
    --min-agree N       порог n согласий для попадания в топы (default: single 20, ALL 150)
    --min-cofire R      минимум доли со-срабатываний, чтобы пара вообще
                        показывалась (n_co/позиций; фильтрует случайные пересечения)
    --lift-min L        порог lift для метки СИНЕРГИЯ (default 0.03 ATR)
    --t-min T           порог |t| значимости edge (default 2.0)
    --dup-rate R        доля согласия, выше которой пара — ДУБЛЬ (default 0.85)
    --top N             сколько строк в каждом топе (default 25)
    --apply-toggle      применить data/method_toggle_state.json: выключенные
                        методы пропустить, инвертированные — сменить знак
                        (анализ связок «как в боте после чистки», а не на сыром)
    --toggle-file PATH  путь к toggle_state (default data/method_toggle_state.json)
    --out PATH          CSV со сводкой по каждой паре × режиму
"""
from __future__ import annotations

import argparse
import csv
import itertools
import json
import math
import multiprocessing as mp
import os
import sys
import threading
import time
from datetime import datetime, timedelta

# Windows-консоль cp1251 — форсируем UTF-8 (как в score_methods).
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):
        pass

_here = os.path.dirname(os.path.abspath(__file__))
if _here not in sys.path:
    sys.path.insert(0, _here)

# Вся тяжёлая машинерия (кэш, ATR, forward-return, режимы, список методов) —
# из score_methods. Импортируем её, чтобы не дублировать и гарантировать те же
# цифры, что baseline. Модуль не запускает argparse при импорте (__main__-гард).
import score_methods as sm  # noqa: E402

REGIMES = sm.REGIMES
ALL_LABEL = sm.ALL_LABEL

# Глобальные в воркере: сеты toggle (заполняются в _init_combo_worker).
_WK_DISABLED: set = set()
_WK_INVERTED: set = set()


def _init_combo_worker(disabled: set, inverted: set):
    """Инициализация воркера: поднимаем машинерию score_methods (импорт
    стратегии + numpy + classify_regime — тяжело, один раз на воркер) и
    запоминаем toggle-сеты."""
    global _WK_DISABLED, _WK_INVERTED
    sm._init_worker()             # заполняет sm._WORKER_METHODS / _WORKER_NP / _WORKER_CLASSIFY_REGIME
    _WK_DISABLED = set(disabled or ())
    _WK_INVERTED = set(inverted or ())


# ── Аккумулятор одного ведра: n, сумма g, сумма g², число выигрышей (g>0) ─────
def _new_acc() -> dict:
    return {"n": 0, "s": 0.0, "ss": 0.0, "w": 0}


def _upd(acc: dict, g: float) -> None:
    acc["n"] += 1
    acc["s"] += g
    acc["ss"] += g * g
    if g > 0:
        acc["w"] += 1


def _merge(dst: dict, src: dict) -> None:
    dst["n"] += src["n"]; dst["s"] += src["s"]
    dst["ss"] += src["ss"]; dst["w"] += src["w"]


def _fin(acc: dict) -> dict | None:
    """Ведро → метрики. edge — средний g (ATR/сделку), t — t-стат edge≠0,
    wr — доля g>0. None если данных мало."""
    n = acc["n"]
    if n < 2:
        return None
    mean = acc["s"] / n
    var = (acc["ss"] - n * mean * mean) / (n - 1)
    std = math.sqrt(var) if var > 0 else 0.0
    se = std / math.sqrt(n) if n > 0 else 0.0
    t = mean / se if se > 0 else None
    return {"n": n, "edge": mean, "std": std, "t": t, "wr": acc["w"] / n}


def _run_ticker_combo(job: dict) -> tuple:
    """Один воркер, один тикер, все пары/тройки. Возвращает
    (ticker, payload, (liq, vol)). payload=None если тикер пропущен.
    payload = {"singles": {m:{reg:acc}}, "combos": {members:{reg:{agree,conflict}}}}."""
    np = sm._WORKER_NP
    ticker = job["ticker"]

    rows_raw = sm._load_from_cache(ticker, job["cache_dir"], job["interval"])
    if not rows_raw:
        return ticker, None, (None, None)
    rows_raw = sm._filter_by_dates(rows_raw, job["date_from"], job["date_to"])
    W = job["window"]; S = job["stride"]; K = job["k"]; AGREE = job["agree_min"]
    size = job["size"]
    if len(rows_raw) < W + K + 5:
        return ticker, None, (None, None)
    liqvol = sm._liq_vol(rows_raw)

    candles = [sm._row_to_ns(r) for r in rows_raw]
    closes_arr = np.array([r["close"] for r in rows_raw], dtype=float)
    highs = np.array([r["high"] for r in rows_raw], dtype=float)
    lows = np.array([r["low"] for r in rows_raw], dtype=float)
    vols_arr = np.array([r["volume"] for r in rows_raw], dtype=float)
    atr = sm._atr_sma(highs, lows, job["n_atr"])
    fwd = sm._fwd_ret_bar_native(closes_arr, atr, K)

    by_regime = job.get("by_regime", False)
    regime_win = job.get("regime_window", 60)
    positions = list(range(W, len(candles) - K, S))

    regime_at = {}
    if by_regime:
        closes_list = closes_arr.tolist(); vols_list = vols_arr.tolist()
        for i in positions:
            if not np.isnan(fwd[i]):
                regime_at[i] = sm._compute_regime_at(
                    closes_list[:i + 1], vols_list[:i + 1], regime_win)

    method_filter = job["methods_filter"]
    to_run = [(n, fn) for n, fn in sm._WORKER_METHODS
              if (not method_filter) or n in method_filter]
    # Выключенные toggle-ом методы вообще не считаем (как бот их не спрашивает).
    to_run = [(n, fn) for n, fn in to_run if n not in _WK_DISABLED]
    inverted = _WK_INVERTED

    singles: dict = {}                 # {method: {regime: acc}}
    combos: dict = {}                  # {members_tuple: {regime: {"agree":acc,"conflict":acc}}}
    n_positions_used = 0

    def _reg_labels(i):
        if not by_regime:
            return (ALL_LABEL,)
        return (ALL_LABEL, regime_at.get(i, "ranging"))

    for i in positions:
        if np.isnan(fwd[i]):
            continue
        fr = float(fwd[i])
        n_positions_used += 1
        win = candles[i - W:i + 1]
        # active: [(name, sign, g)] — только сработавшие
        active = []
        for name, fn in to_run:
            try:
                score = fn(win)
            except Exception:
                continue
            if score is None:
                continue
            if name in inverted:
                score = -score
            if score >= AGREE:
                sign = 1
            elif score <= -AGREE:
                sign = -1
            else:
                continue
            active.append((name, sign, fr * sign))

        if not active:
            continue
        active.sort(key=lambda x: x[0])   # стабильный порядок для ключей
        labels = _reg_labels(i)

        # Одиночные (база для lift) — по всем сигналам метода
        for name, _sign, g in active:
            d = singles.setdefault(name, {})
            for lab in labels:
                _upd(d.setdefault(lab, _new_acc()), g)

        # Связки: перебираем сочетания только среди сработавших (их немного →
        # дёшево, C(active,size)). Пары ещё и по конфликту.
        if len(active) < size:
            continue
        for combo in itertools.combinations(active, size):
            members = tuple(m[0] for m in combo)
            signs = [m[1] for m in combo]
            g0 = combo[0][2]              # g в сторону первого участника
            same = all(s == signs[0] for s in signs)
            slot = combos.setdefault(members, {})
            for lab in labels:
                buckets = slot.setdefault(lab, {"agree": _new_acc(),
                                                 "conflict": _new_acc()})
                if same:
                    _upd(buckets["agree"], g0)   # при согласии g одинаков у всех
                elif size == 2:
                    # Конфликт осмыслен только для пары: g в сторону первого.
                    _upd(buckets["conflict"], g0)

    payload = {"singles": singles, "combos": combos,
               "n_positions": n_positions_used}
    return ticker, payload, liqvol


# ── Пуловая агрегация ────────────────────────────────────────────────────────
def _accumulate(pool: dict, payload: dict) -> None:
    """Копит по тикерам. pool = {
        'singles': {(method,reg): {n,s,ss,w,n_tk}},
        'combos':  {(members,reg): {'agree':{...,n_tk}, 'conflict':{...,n_tk}}},
        'positions': int}."""
    ps = pool.setdefault("singles", {})
    pc = pool.setdefault("combos", {})
    pool["positions"] = pool.get("positions", 0) + payload.get("n_positions", 0)

    for method, per_reg in payload["singles"].items():
        for reg, acc in per_reg.items():
            key = (method, reg)
            dst = ps.setdefault(key, {**_new_acc(), "n_tk": 0})
            _merge(dst, acc)
            if acc["n"] > 0:
                dst["n_tk"] += 1

    for members, per_reg in payload["combos"].items():
        for reg, buckets in per_reg.items():
            key = (members, reg)
            dst = pc.setdefault(key, {"agree": {**_new_acc(), "n_tk": 0},
                                      "conflict": {**_new_acc(), "n_tk": 0}})
            for b in ("agree", "conflict"):
                _merge(dst[b], buckets[b])
                if buckets[b]["n"] > 0:
                    dst[b]["n_tk"] += 1


def _single_edges(pool: dict) -> dict:
    """{(method,reg): edge} — средний dir-adjusted return метода по отдельности."""
    out = {}
    for key, acc in pool["singles"].items():
        f = _fin(acc)
        if f:
            out[key] = f
    return out


def _classify(edge_agree, wr_agree, t_agree, lift, agree_rate,
              conflict_fin, n_agree, min_agree, lift_min, t_min, dup_rate) -> str:
    """Метка пары по ALL-разрезу."""
    if n_agree < min_agree:
        return "мало"
    strong = t_agree is not None and abs(t_agree) >= t_min and edge_agree is not None
    if lift is not None and lift >= lift_min and strong and edge_agree > 0:
        return "СИНЕРГИЯ"
    if lift is not None and lift <= -lift_min and strong:
        return "АНТАГОНИЗМ"
    if agree_rate is not None and agree_rate >= dup_rate and (lift is None or abs(lift) < lift_min):
        return "ДУБЛЬ"
    if conflict_fin and conflict_fin["t"] is not None and abs(conflict_fin["t"]) >= t_min \
            and conflict_fin["n"] >= min_agree:
        return "КОНФЛИКТ-ИНФО"
    return "нейтрально"


def _finalize_pairs(pool: dict, single_fin: dict, args) -> list[dict]:
    """Собирает по каждой паре×режиму итоговую строку с lift и меткой."""
    rows = []
    positions = max(pool.get("positions", 0), 1)
    for (members, reg), buckets in pool["combos"].items():
        agree = _fin(buckets["agree"])
        conflict = _fin(buckets["conflict"]) if args.size == 2 else None
        n_agree = buckets["agree"]["n"]
        n_conf = buckets["conflict"]["n"]
        n_co = n_agree + n_conf
        # base rate со-срабатываний: n_co к числу просмотренных позиций.
        cofire = n_co / positions if positions else 0.0

        # lift относительно лучшего из одиночных edge в ТОМ ЖЕ режиме
        member_edges = []
        for m in members:
            f = single_fin.get((m, reg))
            member_edges.append(f["edge"] if f else None)
        known = [e for e in member_edges if e is not None]
        best_single = max(known) if known else None
        edge_agree = agree["edge"] if agree else None
        lift = (edge_agree - best_single) if (edge_agree is not None and best_single is not None) else None
        wr_best = None
        wrs = [single_fin.get((m, reg), {}).get("wr") for m in members]
        wrs = [w for w in wrs if w is not None]
        if agree and wrs:
            wr_best = max(wrs)
        agree_rate = (n_agree / n_co) if n_co else None

        cls = _classify(
            edge_agree, agree["wr"] if agree else None,
            agree["t"] if agree else None, lift, agree_rate, conflict,
            n_agree, args.min_agree, args.lift_min, args.t_min, args.dup_rate) \
            if reg == ALL_LABEL else ""

        rows.append({
            "members": members, "regime": reg, "size": args.size,
            "n_co": n_co, "n_agree": n_agree, "n_conflict": n_conf,
            "cofire": cofire, "agree_rate": agree_rate,
            "edge_agree": edge_agree, "wr_agree": agree["wr"] if agree else None,
            "t_agree": agree["t"] if agree else None,
            "member_edges": member_edges, "best_single": best_single,
            "wr_best": wr_best,
            "lift": lift, "lift_wr": (agree["wr"] - wr_best) if (agree and wr_best is not None) else None,
            "edge_conflict": conflict["edge"] if conflict else None,
            "wr_follow_first": conflict["wr"] if conflict else None,
            "t_conflict": conflict["t"] if conflict else None,
            "n_tk": buckets["agree"]["n_tk"],
            "class": cls,
        })
    return rows


# ── Печать ───────────────────────────────────────────────────────────────────
def _fmt(v, spec=".3f", sign=False):
    if v is None:
        return "—"
    return format(v, ("+" if sign else "") + spec)


def _print_pairs(rows: list[dict], args) -> None:
    all_rows = [r for r in rows if r["regime"] == ALL_LABEL]
    elig = [r for r in all_rows
            if r["n_agree"] >= args.min_agree and r["cofire"] >= args.min_cofire]

    def head(title, extra=""):
        m = "методы" if args.size == 2 else "тройка"
        print(f"\n=== {title} ===")
        if extra:
            print(extra)
        print(f"{m:<40}{'lift':>7}{'edge_a':>8}{'wr_a':>6}{'t_a':>6}"
              f"{'n_agr':>7}{'agr%':>6}{'best1':>7}{'n_tk':>5}")
        print("-" * 92)

    def line(r):
        name = " + ".join(r["members"])
        ar = r["agree_rate"] * 100 if r["agree_rate"] is not None else None
        print(f"{name[:39]:<40}{_fmt(r['lift'], sign=True):>7}"
              f"{_fmt(r['edge_agree'], sign=True):>8}"
              f"{_fmt(r['wr_agree'], '.2f'):>6}{_fmt(r['t_agree'], '.1f'):>6}"
              f"{r['n_agree']:>7}{_fmt(ar, '.0f'):>6}"
              f"{_fmt(r['best_single'], sign=True):>7}{r['n_tk']:>5}")

    # 1) Синергия: lift>0 и значимо
    syn = sorted((r for r in elig if r["class"] == "СИНЕРГИЯ"),
                 key=lambda r: -(r["lift"] or -9))[:args.top]
    head("СИНЕРГИЯ — связка бьёт лучший метод поодиночке (lift>0, значимо)",
         "# lift = edge согласия − edge лучшего из методов на всех его сигналах")
    if syn:
        for r in syn:
            line(r)
    else:
        print("(ни одной значимой синергии при текущих порогах)")

    # 2) Антагонизм: связка ХУЖЕ лучшего одиночного
    ant = sorted((r for r in elig if r["class"] == "АНТАГОНИЗМ"),
                 key=lambda r: (r["lift"] or 9))[:args.top]
    head("АНТАГОНИЗМ — согласие ХУЖЕ лучшего одиночного (lift<0)",
         "# пересечение сигналов — там, где методы вместе ошибаются")
    for r in ant:
        line(r)
    if not ant:
        print("(нет)")

    # 3) Дубли: почти всегда согласны, edge не растёт
    dup = sorted((r for r in elig if r["class"] == "ДУБЛЬ"),
                 key=lambda r: -(r["agree_rate"] or 0))[:args.top]
    head("ДУБЛЬ — почти всегда согласны, связка не добавляет edge",
         "# кандидаты в один кластер / group-lasso (см. redundancy_analysis)")
    for r in dup:
        line(r)
    if not dup:
        print("(нет)")

    # 4) Информативный конфликт (только пары)
    if args.size == 2:
        conf = [r for r in elig if r["class"] == "КОНФЛИКТ-ИНФО"]
        conf.sort(key=lambda r: -(abs(r["t_conflict"]) if r["t_conflict"] is not None else 0))
        conf = conf[:args.top]
        print("\n=== КОНФЛИКТ-ИНФО — в споре методов исход предсказуем ===")
        print("# edge_conf>0 → верь ПЕРВОМУ методу, <0 → второму; wr_follow1 — "
              "winrate если следовать первому")
        print(f"{'A (спорит с) B':<40}{'edge_conf':>10}{'t':>6}{'wr_f1':>7}"
              f"{'n_conf':>7}  вердикт")
        print("-" * 86)
        for r in conf:
            a, b = r["members"]
            ec = r["edge_conflict"]
            verdict = f"верь {a}" if (ec or 0) > 0 else f"верь {b}"
            print(f"{(a + ' ↔ ' + b)[:39]:<40}{_fmt(ec, sign=True):>10}"
                  f"{_fmt(r['t_conflict'], '.1f'):>6}"
                  f"{_fmt(r['wr_follow_first'], '.2f'):>7}{r['n_conflict']:>7}  {verdict}")
        if not conf:
            print("(нет значимых)")

    # Итоговый ответ на вопрос «дают ли связки что-то?»
    n_syn = sum(1 for r in elig if r["class"] == "СИНЕРГИЯ")
    n_ant = sum(1 for r in elig if r["class"] == "АНТАГОНИЗМ")
    n_dup = sum(1 for r in elig if r["class"] == "ДУБЛЬ")
    n_conf = sum(1 for r in elig if r["class"] == "КОНФЛИКТ-ИНФО")
    med_lift = None
    lifts = sorted(r["lift"] for r in elig if r["class"] == "СИНЕРГИЯ" and r["lift"] is not None)
    if lifts:
        med_lift = lifts[len(lifts) // 2]
    print("\n=== ИТОГ: дают ли связки что-то? ===")
    print(f"рассмотрено пар/троек (n_agree≥{args.min_agree}, co-fire≥{args.min_cofire}): {len(elig)}")
    print(f"  СИНЕРГИЯ: {n_syn}" + (f"  (медиана lift {med_lift:+.3f} ATR)" if med_lift is not None else ""))
    print(f"  АНТАГОНИЗМ: {n_ant}   ДУБЛЬ: {n_dup}"
          + (f"   КОНФЛИКТ-ИНФО: {n_conf}" if args.size == 2 else ""))
    if n_syn:
        print("→ Есть связки с реальной синергией — их согласие можно использовать "
              "как усиленный триггер (буст веса при совпадении).")
    else:
        print("→ Значимой синергии не найдено: совместная работа методов не бьёт "
              "лучший одиночный — связки избыточны (edge уже в одиночных).")
    if n_conf:
        print("→ Есть пары с информативным конфликтом — в споре стоит доверять "
              "методу-победителю (см. таблицу КОНФЛИКТ-ИНФО).")


def _print_by_regime(rows: list[dict], args) -> None:
    """Компактно: для топ-синергий по ALL — как lift меняется по режимам."""
    all_rows = {r["members"]: r for r in rows if r["regime"] == ALL_LABEL}
    top = sorted((r for r in all_rows.values()
                  if r["class"] == "СИНЕРГИЯ" and r["n_agree"] >= args.min_agree),
                 key=lambda r: -(r["lift"] or -9))[:args.top]
    if not top:
        print("\n(режимный разрез: значимых синергий по ALL нет — нечего разбивать)")
        return
    by_key = {}
    for r in rows:
        by_key.setdefault(r["members"], {})[r["regime"]] = r
    print(f"\n=== lift по режимам (топ-{len(top)} синергий) ===")
    print(f"{'связка':<34}" + "".join(f"{rg[:9]:>10}" for rg in REGIMES))
    print("-" * (34 + 10 * len(REGIMES)))
    for tr in top:
        parts = [f"{(' + '.join(tr['members']))[:33]:<34}"]
        for rg in REGIMES:
            rr = by_key.get(tr["members"], {}).get(rg)
            if rr and rr["lift"] is not None and rr["n_agree"] >= max(10, args.min_agree // 3):
                parts.append(f"{rr['lift']:+.3f}"[:10].rjust(10))
            else:
                parts.append(f"{'—':>10}")
        print("".join(parts))


def _write_csv(path: str, rows: list[dict]) -> None:
    with open(path, "w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=[
            "members", "size", "regime", "n_co", "n_agree", "n_conflict",
            "cofire", "agree_rate", "edge_agree", "wr_agree", "t_agree",
            "member_edges", "best_single", "lift", "lift_wr",
            "edge_conflict", "wr_follow_first", "t_conflict", "n_tk", "class"])
        w.writeheader()
        for r in sorted(rows, key=lambda r: (r["members"], r["regime"])):
            def g(k, nd=6):
                v = r[k]
                return "" if v is None else (f"{v:.{nd}f}" if isinstance(v, float) else v)
            w.writerow({
                "members": " + ".join(r["members"]), "size": r["size"],
                "regime": r["regime"], "n_co": r["n_co"], "n_agree": r["n_agree"],
                "n_conflict": r["n_conflict"], "cofire": g("cofire"),
                "agree_rate": g("agree_rate"), "edge_agree": g("edge_agree"),
                "wr_agree": g("wr_agree"), "t_agree": g("t_agree", 3),
                "member_edges": ",".join("" if e is None else f"{e:.4f}"
                                          for e in r["member_edges"]),
                "best_single": g("best_single"), "lift": g("lift"),
                "lift_wr": g("lift_wr"), "edge_conflict": g("edge_conflict"),
                "wr_follow_first": g("wr_follow_first"),
                "t_conflict": g("t_conflict", 3), "n_tk": r["n_tk"],
                "class": r["class"],
            })


def _load_toggle(path: str) -> tuple:
    try:
        with open(path, "r", encoding="utf-8") as f:
            st = json.load(f)
        return set(st.get("disabled", [])), set(st.get("inverted", []))
    except (OSError, json.JSONDecodeError, AttributeError):
        return set(), set()


def main() -> None:
    ap = argparse.ArgumentParser(
        description="Прогон ПАР/троек методов OICompositeStrategy: синергия, "
                    "дубли, информативный конфликт")
    ap.add_argument("ticker")
    ap.add_argument("--cache", default=os.path.join(_here, "data", "candle_cache"))
    ap.add_argument("--interval", type=int, default=5, choices=(1, 5))
    ap.add_argument("--days", type=int, default=180)
    ap.add_argument("--from", dest="date_from", default=None)
    ap.add_argument("--to", dest="date_to", default=None)
    ap.add_argument("--all", action="store_true", help="весь кэш")
    ap.add_argument("--workers", type=int, default=max(1, (mp.cpu_count() or 2) - 1))
    ap.add_argument("--window", type=int, default=300)
    ap.add_argument("--stride", type=int, default=5)
    ap.add_argument("--k", type=int, default=12)
    ap.add_argument("--n-atr", type=int, default=20)
    ap.add_argument("--methods", default=None, help="подмножество через запятую")
    ap.add_argument("--agree-min", type=float, default=0.15)
    ap.add_argument("--size", type=int, default=2, choices=(2, 3),
                    help="порядок связки: 2 (пары, default) или 3 (тройки, только согласие)")
    ap.add_argument("--min-agree", type=int, default=None,
                    help="порог n согласий в топах (default: single 20, ALL 150)")
    ap.add_argument("--min-cofire", type=float, default=0.0,
                    help="минимум доли со-срабатываний (n_co/позиций) для показа пары")
    ap.add_argument("--lift-min", type=float, default=0.03, help="порог lift для СИНЕРГИЯ")
    ap.add_argument("--t-min", type=float, default=2.0, help="порог |t| значимости")
    ap.add_argument("--dup-rate", type=float, default=0.85, help="доля согласия для метки ДУБЛЬ")
    ap.add_argument("--top", type=int, default=25)
    ap.add_argument("--by-regime", action="store_true",
                    help="Разбить lift по режимам бота (classify_regime).")
    ap.add_argument("--regime-window", type=int, default=60)
    ap.add_argument("--apply-toggle", action="store_true",
                    help="Применить method_toggle_state.json (выкл+инверсии) — "
                         "анализ связок 'как в боте после чистки'")
    ap.add_argument("--toggle-file",
                    default=os.path.join(_here, "data", "method_toggle_state.json"))
    ap.add_argument("--out", default=None, help="CSV сводки по парам × режимам")
    args = ap.parse_args()

    methods_filter = None
    if args.methods:
        methods_filter = {m.strip().upper() for m in args.methods.split(",") if m.strip()}

    disabled, inverted = (set(), set())
    if args.apply_toggle:
        disabled, inverted = _load_toggle(args.toggle_file)
        print(f"toggle: выключено {len(disabled)}, инвертировано {len(inverted)} "
              f"(из {args.toggle_file})", file=sys.stderr)

    if args.ticker.upper() == "ALL":
        tickers = sm._list_tickers(args.cache, args.interval)
    else:
        tickers = [args.ticker]
    if not tickers:
        sys.exit("нет тикеров")
    n_universe = len(tickers)

    if args.min_agree is None:
        args.min_agree = 20 if n_universe == 1 else 150

    date_from, date_to = args.date_from, args.date_to

    def build_job(tk):
        j = {
            "ticker": tk, "cache_dir": args.cache, "interval": args.interval,
            "date_from": date_from, "date_to": date_to,
            "window": args.window, "stride": args.stride, "k": args.k,
            "n_atr": args.n_atr, "methods_filter": methods_filter,
            "agree_min": args.agree_min, "size": args.size,
            "by_regime": args.by_regime, "regime_window": args.regime_window,
        }
        # --days без явных дат: обрежем по last-bar тикера (как score_methods).
        if not (args.all or date_from or date_to):
            rows = sm._load_from_cache(tk, args.cache, args.interval)
            if not rows:
                j["date_from"] = "9999-01-01"
                return j
            latest = rows[-1]["time"][:10]
            to_d = datetime.strptime(latest, "%Y-%m-%d").date()
            j["date_from"] = (to_d - timedelta(days=args.days)).isoformat()
            j["date_to"] = latest
        return j

    jobs = [build_job(tk) for tk in tickers]
    print(f"тикеров: {len(tickers)}, воркеров: {args.workers}, size={args.size}, "
          f"window={args.window}, stride={args.stride}, k={args.k}", file=sys.stderr)

    pool: dict = {}
    t_start = time.time()
    done = 0

    hb_stop = threading.Event()
    hb_state = {"done": 0, "total": len(tickers)}

    def _heartbeat():
        while not hb_stop.wait(30.0):
            elapsed = time.time() - t_start
            d = hb_state["done"]; tot = hb_state["total"]
            rate = d / elapsed if elapsed > 0 else 0
            eta = (tot - d) / rate if rate > 0 else 0
            print(f"[heartbeat] прошло {elapsed:>5.0f}с | {d}/{tot} | "
                  f"{rate:.2f} тик/с | ETA ~{eta:>4.0f}с", file=sys.stderr, flush=True)
    hb_thread = threading.Thread(target=_heartbeat, daemon=True)
    hb_thread.start()

    init_args = (disabled, inverted)
    if args.workers == 1 or len(tickers) == 1:
        _init_combo_worker(*init_args)
        for job in jobs:
            ticker, payload, _lv = _run_ticker_combo(job)
            done += 1
            hb_state["done"] = done
            if payload is None:
                print(f"[{done}/{len(tickers)}] {ticker}: SKIP", file=sys.stderr)
                continue
            _accumulate(pool, payload)
            print(f"[{done}/{len(tickers)}] {ticker}: пар/троек {len(payload['combos'])}",
                  file=sys.stderr)
    else:
        with mp.Pool(processes=args.workers, initializer=_init_combo_worker,
                     initargs=init_args) as p:
            for ticker, payload, _lv in p.imap_unordered(_run_ticker_combo, jobs):
                done += 1
                hb_state["done"] = done
                if payload is None:
                    print(f"[{done}/{len(tickers)}] {ticker}: SKIP", file=sys.stderr)
                    continue
                _accumulate(pool, payload)

    hb_stop.set()
    hb_thread.join(timeout=1)

    if not pool.get("combos"):
        print("Ни одной связки не набралось (пустой кэш? слишком строгий фильтр?).")
        return

    single_fin = _single_edges(pool)
    rows = _finalize_pairs(pool, single_fin, args)

    total_time = time.time() - t_start
    print(f"\nобработано за {total_time:.1f}с, связок всего: "
          f"{len({r['members'] for r in rows})}", file=sys.stderr)

    _print_pairs(rows, args)
    if args.by_regime:
        _print_by_regime(rows, args)
    if args.out:
        _write_csv(args.out, rows)
        print(f"\nCSV: {args.out}", file=sys.stderr)


if __name__ == "__main__":
    mp.freeze_support()
    main()
