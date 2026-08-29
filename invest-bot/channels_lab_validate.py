"""channels_lab_validate.py — массовая валидация channels_lab.html на кэше.

Порт логики из channels_lab.html: линейные регрессионные каналы (3 окна) +
кластеризация уровней + сигналы 3 типов (level / channel / combo). Прогон
по всем тикерам data/candle_cache/ с автоматической категоризацией по
ликвидности и волатильности. Для каждой (mode × group) считаются:
  n, win%, exp/сделку, сумма P&L (ATR), max drawdown, разбивки по силе
  уровня (2 / 3 / 4-5 / 6+ касаний) и по числу согласных каналов (0/1/2+).

Зачем: визуальная лаборатория (channels_lab.html) хороша для качественного
разбора одного тикера, но выводы прыгают между инструментами — на HYDR
уровень+микро дал +0.72 на 8 сделках, на SBER другая картина. Нужна
статистическая проверка на много тикеров, с разбиением на группы, чтобы
понять: работает ли комбо-сетап универсально или только на определённом
профиле (например, на низковолатильных ranging-акциях).

Порт формул 1:1 с channels_lab.html — при обновлении логики в HTML нужно
править и здесь (или наоборот). Все параметры в CLI:
  --w1/--w2/--w3 W1=30/W2=80/W3=200 (окна каналов)
  --k 2 (ширина канала в σ)
  --lv-pivot 5 (окно свинга ±N)
  --lv-merge 0.5 (слить в ATR)
  --lv-min 3 (мин касаний)
  --take 1.5 --stop 0.75 --horizon 24 --er-max 0.35 --cost 0.5
  --max-ch 1 (макс каналов на границе прежде чем сигнал = трендовая ловушка)
  --modes level,channel,combo (что считать)

Категоризация:
  Все тикеры сортируются по ликвидности (медианный оборот close·volume) и
  волатильности (median (high-low)/close). Делятся на терцили: top / mid /
  low в каждой оси + тип (акция/фьючерс по регэкспу как в
  elite_preset_validate). Каждый тикер попадает в одну (liq × vol × type)
  ячейку — в отчёте выводится сводка по каждой ячейке.

Прерывание/продолжение: чекпоинт после каждого тикера (--checkpoint).
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import statistics
import sys
from collections import defaultdict

_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)
try:
    import tinkoff.invest  # noqa: F401
except ImportError:
    _stub = os.path.join(_HERE, "_tinkoff_stub")
    if _stub not in sys.path:
        sys.path.insert(0, _stub)

from atomic_json import atomic_write_json  # noqa: E402
from score_methods import _load_from_cache, _list_tickers, _liq_vol  # noqa: E402

_FUT_RE = re.compile(r"^[A-Z]{1,4}[FGHJKMNQUVXZ]\d$")
def _is_future(ticker: str) -> bool:
    return bool(_FUT_RE.match(ticker.upper()))


# ── математика (порт 1:1 с channels_lab.html) ──────────────────────────────
def atr_series(bars, per=14):
    n = len(bars)
    out = [None] * n
    if n < 2:
        return out
    tr = [bars[0]["high"] - bars[0]["low"]]
    for i in range(1, n):
        pc = bars[i - 1]["close"]
        tr.append(max(bars[i]["high"] - bars[i]["low"],
                       abs(bars[i]["high"] - pc), abs(bars[i]["low"] - pc)))
    if n < per:
        return out
    s = sum(tr[:per])
    out[per - 1] = s / per
    for i in range(per, n):
        out[i] = (out[i - 1] * (per - 1) + tr[i]) / per
    return out


def reg_channel(bars, i, W, k):
    if i < W - 1:
        return None
    start = i - W + 1
    sx = sy = sxx = sxy = 0.0
    for j in range(W):
        x = j
        y = bars[start + j]["close"]
        sx += x; sy += y; sxx += x * x; sxy += x * y
    mx = sx / W; my = sy / W
    denom = sxx - sx * mx
    slope = (sxy - sx * my) / denom if denom > 0 else 0.0
    intercept = my - slope * mx
    ss = 0.0
    for j in range(W):
        y = bars[start + j]["close"]
        r = y - (slope * j + intercept)
        ss += r * r
    sigma = math.sqrt(ss / W)
    center_now = slope * (W - 1) + intercept
    return {
        "slope": slope, "intercept": intercept, "sigma": sigma,
        "center_now": center_now,
        "top_now": center_now + k * sigma,
        "bot_now": center_now - k * sigma,
    }


def er_ratio(bars, i, W=60):
    if i < W:
        return None
    d = 0.0
    for j in range(i - W + 1, i + 1):
        d += abs(bars[j]["close"] - bars[j - 1]["close"])
    if d == 0:
        return 0.0
    return abs(bars[i]["close"] - bars[i - W]["close"]) / d


def pivot_points(bars, N):
    n = len(bars)
    out = []
    for i in range(N, n - N):
        hi = True; lo = True
        h_i = bars[i]["high"]; l_i = bars[i]["low"]
        for j in range(i - N, i + N + 1):
            if j == i:
                continue
            if bars[j]["high"] >= h_i:
                hi = False
            if bars[j]["low"] <= l_i:
                lo = False
            if not hi and not lo:
                break
        if hi:
            out.append({"i": i, "price": h_i, "kind": "H"})
        if lo:
            out.append({"i": i, "price": l_i, "kind": "L"})
    return out


def cluster_levels(pivots, atr, merge_atr, min_touches):
    if not pivots:
        return []
    items = sorted(pivots, key=lambda p: p["price"])
    out = []
    cur = None
    for p in items:
        a = atr[p["i"]] or 1.0
        if cur is None:
            cur = {"prices": [p["price"]], "is": [p["i"]]}
            continue
        mid = sum(cur["prices"]) / len(cur["prices"])
        if abs(p["price"] - mid) <= merge_atr * a:
            cur["prices"].append(p["price"]); cur["is"].append(p["i"])
        else:
            if len(cur["is"]) >= min_touches:
                ps = sorted(cur["prices"])
                out.append({
                    "price": ps[len(ps) // 2],
                    "touches": len(cur["is"]),
                    "first": min(cur["is"]),
                    "last": max(cur["is"]),
                })
            cur = {"prices": [p["price"]], "is": [p["i"]]}
    if cur and len(cur["is"]) >= min_touches:
        ps = sorted(cur["prices"])
        out.append({"price": ps[len(ps) // 2], "touches": len(cur["is"]),
                    "first": min(cur["is"]), "last": max(cur["is"])})
    return out


def _run_trade(bars, i, dir_, entry, tp, sl, horizon, atr):
    n = len(bars)
    for j in range(i + 1, min(i + horizon, n - 1) + 1):
        hi = bars[j]["high"]; lo = bars[j]["low"]
        if dir_ > 0:
            if lo <= sl:
                return dir_ * (sl - entry) / atr, j, "stop"
            if hi >= tp:
                return dir_ * (tp - entry) / atr, j, "take"
        else:
            if hi >= sl:
                return dir_ * (sl - entry) / atr, j, "stop"
            if lo <= tp:
                return dir_ * (tp - entry) / atr, j, "take"
    if i + horizon < n:
        return dir_ * (bars[i + horizon]["close"] - entry) / atr, i + horizon, "time"
    return None, None, None


def detect_level_signals(bars, ch_series, levels, atr, params):
    er_max = params["er_max"]; take = params["take"]; stop = params["stop"]
    horizon = params["horizon"]; cost = params.get("cost", 0)
    max_ch = params.get("max_ch", 1)
    signals = []
    n = len(bars)
    for i in range(n):
        a = atr[i]
        if not a or a <= 0:
            continue
        erv = er_ratio(bars, i, 60)
        if erv is None or erv >= er_max:
            continue
        b = bars[i]
        hit_level = None; hit_side = 0
        for lv in levels:
            if lv["last"] >= i:
                continue
            if b["low"] <= lv["price"] + a * 0.3 and b["close"] > lv["price"] and b["open"] >= lv["price"]:
                hit_level = lv; hit_side = 1; break
            if b["high"] >= lv["price"] - a * 0.3 and b["close"] < lv["price"] and b["open"] <= lv["price"]:
                hit_level = lv; hit_side = -1; break
        if not hit_level:
            continue
        dir_ = hit_side
        ch_votes = 0; micro_agree = False
        chs = ch_series[i] if i < len(ch_series) else None
        if chs:
            for key in ("ch1", "ch2", "ch3"):
                ch = chs.get(key)
                if not ch:
                    continue
                if dir_ > 0 and b["low"] <= ch["bot_now"]:
                    ch_votes += 1
                    if key == "ch1":
                        micro_agree = True
                elif dir_ < 0 and b["high"] >= ch["top_now"]:
                    ch_votes += 1
                    if key == "ch1":
                        micro_agree = True
        if ch_votes >= max_ch + 1:
            continue
        entry = b["close"]
        tp = entry + dir_ * take * a
        sl = entry - dir_ * stop * a
        pnl_gross, exit_bar, reason = _run_trade(bars, i, dir_, entry, tp, sl, horizon, a)
        if pnl_gross is None:
            continue
        signals.append({
            "i": i, "dir": dir_, "pnl": pnl_gross - cost,
            "reason": reason, "confluence_channel": micro_agree,
            "ch_votes": ch_votes, "level_strength": hit_level["touches"],
        })
    return signals


def detect_channel_signals(bars, ch_series, atr, params):
    er_max = params["er_max"]; take = params["take"]; stop = params["stop"]
    horizon = params["horizon"]; cost = params.get("cost", 0)
    signals = []
    n = len(bars)
    for i in range(n):
        a = atr[i]
        if not a or a <= 0:
            continue
        erv = er_ratio(bars, i, 60)
        if erv is None or erv >= er_max:
            continue
        chs = ch_series[i] if i < len(ch_series) else None
        if not chs:
            continue
        b = bars[i]
        votes = []
        for key in ("ch1", "ch2", "ch3"):
            ch = chs.get(key)
            if not ch:
                continue
            if b["low"] <= ch["bot_now"] and b["close"] > ch["bot_now"] - a * 0.2:
                votes.append((key, 1))
            elif b["high"] >= ch["top_now"] and b["close"] < ch["top_now"] + a * 0.2:
                votes.append((key, -1))
        if not votes:
            continue
        dir_ = votes[0][1]
        if any(v[1] != dir_ for v in votes):
            continue
        entry = b["close"]
        tp = entry + dir_ * take * a
        sl = entry - dir_ * stop * a
        pnl_gross, exit_bar, reason = _run_trade(bars, i, dir_, entry, tp, sl, horizon, a)
        if pnl_gross is None:
            continue
        signals.append({
            "i": i, "dir": dir_, "pnl": pnl_gross - cost,
            "reason": reason, "n_channels": len(votes),
        })
    return signals


# ── прогон одного тикера ────────────────────────────────────────────────────
def process_ticker(ticker, cache_dir, interval, days, params):
    rows_raw = _load_from_cache(ticker, cache_dir, interval)
    if not rows_raw:
        return None
    if days:
        # bars_per_day для 5-мин ≈ 78, для 1-мин ≈ 390
        bpd = 390 // max(interval, 1)
        rows_raw = rows_raw[-max(days * bpd, 300):]
    n = len(rows_raw)
    if n < max(params["w3"], 300) + params["horizon"]:
        return None
    bars = [{"open": float(r["open"]), "high": float(r["high"]),
              "low": float(r["low"]), "close": float(r["close"]),
              "volume": float(r["volume"]), "time": r["time"]} for r in rows_raw]
    atr = atr_series(bars, 14)
    liq, vol = _liq_vol(rows_raw)

    W1, W2, W3, k = params["w1"], params["w2"], params["w3"], params["k"]
    ch_series = [None] * n
    for i in range(min(W1, W2, W3) - 1, n):
        ch_series[i] = {
            "ch1": reg_channel(bars, i, W1, k) if i >= W1 - 1 else None,
            "ch2": reg_channel(bars, i, W2, k) if i >= W2 - 1 else None,
            "ch3": reg_channel(bars, i, W3, k) if i >= W3 - 1 else None,
        }

    pivots = pivot_points(bars, params["lv_pivot"])
    levels = cluster_levels(pivots, atr, params["lv_merge"], params["lv_min"])

    out = {"ticker": ticker, "is_future": _is_future(ticker),
            "liq_mln": liq, "vol_pct": vol, "n_bars": n}
    p = {
        "er_max": params["er_max"], "take": params["take"], "stop": params["stop"],
        "horizon": params["horizon"], "cost": params["cost"], "max_ch": params["max_ch"],
    }
    for mode in params["modes"]:
        if mode == "channel":
            sigs = detect_channel_signals(bars, ch_series, atr, p)
        elif mode == "combo":
            lvl = detect_level_signals(bars, ch_series, levels, atr, p)
            sigs = [s for s in lvl if s.get("confluence_channel")]
        else:  # level
            sigs = detect_level_signals(bars, ch_series, levels, atr, p)
        out[mode] = _aggregate_signals(sigs, mode)
    return out


def _aggregate_signals(sigs, mode):
    n = len(sigs)
    if not n:
        return {"n": 0}
    pnls = [s["pnl"] for s in sigs]
    longs = [s for s in sigs if s["dir"] > 0]
    shorts = [s for s in sigs if s["dir"] < 0]
    wins = sum(1 for p in pnls if p > 0)
    pnl_sum = sum(pnls)
    # max drawdown
    peak = 0.0; dd = 0.0; cum = 0.0
    for p in pnls:
        cum += p
        if cum > peak:
            peak = cum
        if cum - peak < dd:
            dd = cum - peak
    r = {
        "n": n, "wins": wins, "pnl_sum": pnl_sum, "drawdown": dd,
        "n_long": len(longs), "n_short": len(shorts),
        "wins_long": sum(1 for s in longs if s["pnl"] > 0),
        "wins_short": sum(1 for s in shorts if s["pnl"] > 0),
        "pnl_long": sum(s["pnl"] for s in longs),
        "pnl_short": sum(s["pnl"] for s in shorts),
    }
    if mode in ("level", "combo"):
        # разбивка по силе уровня
        for lo, hi, key in [(2, 2, "lv_2"), (3, 3, "lv_3"), (4, 5, "lv_45"), (6, 999, "lv_6p")]:
            arr = [s for s in sigs if lo <= s.get("level_strength", 0) <= hi]
            if arr:
                r[key + "_n"] = len(arr)
                r[key + "_wins"] = sum(1 for s in arr if s["pnl"] > 0)
                r[key + "_pnl"] = sum(s["pnl"] for s in arr)
        # разбивка по числу голосов каналов
        for k, key in [(0, "cv_0"), (1, "cv_1"), (2, "cv_2p")]:
            if k < 2:
                arr = [s for s in sigs if s.get("ch_votes", 0) == k]
            else:
                arr = [s for s in sigs if s.get("ch_votes", 0) >= k]
            if arr:
                r[key + "_n"] = len(arr)
                r[key + "_wins"] = sum(1 for s in arr if s["pnl"] > 0)
                r[key + "_pnl"] = sum(s["pnl"] for s in arr)
    if mode == "channel":
        for n_ch in (1, 2, 3):
            arr = [s for s in sigs if s.get("n_channels", 0) == n_ch]
            if arr:
                r["nch_%d_n" % n_ch] = len(arr)
                r["nch_%d_wins" % n_ch] = sum(1 for s in arr if s["pnl"] > 0)
                r["nch_%d_pnl" % n_ch] = sum(s["pnl"] for s in arr)
    return r


# ── группировка тикеров ────────────────────────────────────────────────────
def _tercile(values):
    """Возвращает функцию group(v) → 'low'|'mid'|'top' по терцилям values."""
    vs = sorted(v for v in values if v is not None)
    if not vs:
        return lambda v: "?"
    q1 = vs[len(vs) // 3]
    q2 = vs[2 * len(vs) // 3]
    def group(v):
        if v is None:
            return "?"
        if v <= q1:
            return "low"
        if v <= q2:
            return "mid"
        return "top"
    return group


def _bucket_key(row, liq_grp, vol_grp):
    t = "fut" if row["is_future"] else "stk"
    return f"{t}·liq-{liq_grp(row['liq_mln'])}·vol-{vol_grp(row['vol_pct'])}"


# ── печать сводок ──────────────────────────────────────────────────────────
def _fmt_mode(agg):
    if not agg or agg.get("n", 0) == 0:
        return f"{'—':>6} {'':>6} {'':>7} {'':>8}"
    n = agg["n"]
    win = agg["wins"] / n * 100
    exp = agg["pnl_sum"] / n
    total = agg["pnl_sum"]
    return f"{n:>6} {win:>5.1f}% {exp:>+7.3f} {total:>+8.1f}"


def _fmt_split(pref, agg, keys):
    """Форматирует разбивку в одну строку: 'lv-2 0.0%|+0.0(0)  lv-3 ...'"""
    parts = []
    for key, label in keys:
        n = agg.get(key + "_n", 0)
        if not n:
            continue
        w = agg.get(key + "_wins", 0) / n * 100
        e = agg.get(key + "_pnl", 0) / n
        parts.append(f"{label} {w:.0f}%/{e:+.2f}({n})")
    return "  ".join(parts) if parts else "—"


def print_summary(rows, modes):
    if not rows:
        print("нет данных")
        return
    liq_grp = _tercile([r["liq_mln"] for r in rows])
    vol_grp = _tercile([r["vol_pct"] for r in rows])
    buckets = defaultdict(list)
    for r in rows:
        buckets[_bucket_key(r, liq_grp, vol_grp)].append(r)
    buckets["ALL"] = rows

    print()
    for mode in modes:
        print(f"\n═══ MODE: {mode} ═══")
        print(f"  {'bucket':<28} {'тикеров':>7} {'n':>6} {'win%':>6} {'exp':>7} {'sum':>8}")
        # ALL первым, потом по алфавиту
        keys_sorted = ["ALL"] + sorted(k for k in buckets if k != "ALL")
        for bk in keys_sorted:
            group = buckets[bk]
            # агрегируем метрики mode по всем тикерам в bucket
            agg = _sum_aggs([r[mode] for r in group if mode in r and r[mode].get("n")])
            tickers_n = sum(1 for r in group if r.get(mode, {}).get("n"))
            print(f"  {bk:<28} {tickers_n:>7} {_fmt_mode(agg)}")

    # Разбивки: только для ALL по каждому режиму
    print("\n═══ SPLITS (по ALL) ═══")
    for mode in modes:
        agg = _sum_aggs([r[mode] for r in rows if mode in r and r[mode].get("n")])
        if not agg:
            continue
        print(f"\n{mode}:")
        # общая
        print(f"  всего: {_fmt_mode(agg)}   long {_fmt_dir(agg,'long')}   short {_fmt_dir(agg,'short')}")
        if mode in ("level", "combo"):
            print(f"  уровень: {_fmt_split('lv', agg, [('lv_2','2'),('lv_3','3'),('lv_45','4-5'),('lv_6p','6+')])}")
            print(f"  каналов: {_fmt_split('cv', agg, [('cv_0','0'),('cv_1','1'),('cv_2p','2+')])}")
        if mode == "channel":
            print(f"  каналов: {_fmt_split('nch', agg, [('nch_1','1'),('nch_2','2'),('nch_3','3')])}")


def _fmt_dir(agg, side):
    n = agg.get("n_" + side, 0)
    if not n:
        return "—"
    w = agg.get("wins_" + side, 0) / n * 100
    e = agg.get("pnl_" + side, 0) / n
    return f"{w:.0f}%/{e:+.2f}({n})"


def _sum_aggs(aggs):
    """Суммирование словарей агрегатов от нескольких тикеров: числовые поля +=,
    string остаются None. Нужен для сводки по букету."""
    out = {}
    for a in aggs:
        for k, v in a.items():
            if isinstance(v, (int, float)):
                out[k] = out.get(k, 0) + v
    return out


# ── main ───────────────────────────────────────────────────────────────────
def _sig(args, tickers, params):
    payload = {"tickers": sorted(tickers), "interval": args.interval,
                "days": args.days, "params": params}
    return hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()[:16]


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                   formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("tickers", help="ALL или список через запятую")
    ap.add_argument("--cache", default=os.path.join(_HERE, "data", "candle_cache"))
    ap.add_argument("--interval", type=int, default=5, choices=(1, 5))
    ap.add_argument("--days", type=int, default=180)
    ap.add_argument("--top-liq", type=int, default=None,
                     help="топ-N по обороту (только tickers=ALL)")
    ap.add_argument("--w1", type=int, default=30)
    ap.add_argument("--w2", type=int, default=80)
    ap.add_argument("--w3", type=int, default=200)
    ap.add_argument("--k", type=float, default=2.0)
    ap.add_argument("--lv-pivot", type=int, default=5)
    ap.add_argument("--lv-merge", type=float, default=0.5)
    ap.add_argument("--lv-min", type=int, default=3)
    ap.add_argument("--take", type=float, default=1.5)
    ap.add_argument("--stop", type=float, default=0.75)
    ap.add_argument("--horizon", type=int, default=24)
    ap.add_argument("--er-max", type=float, default=0.35)
    ap.add_argument("--cost", type=float, default=0.5)
    ap.add_argument("--max-ch", type=int, default=1)
    ap.add_argument("--modes", default="level,channel,combo")
    ap.add_argument("--checkpoint",
                     default=os.path.join(_HERE, "data", "channels_lab_cp.json"))
    ap.add_argument("--fresh", action="store_true")
    ap.add_argument("--out", default=None, help="CSV per-ticker per-mode")
    args = ap.parse_args()

    modes = [m.strip() for m in args.modes.split(",") if m.strip()]
    params = {
        "w1": args.w1, "w2": args.w2, "w3": args.w3, "k": args.k,
        "lv_pivot": args.lv_pivot, "lv_merge": args.lv_merge, "lv_min": args.lv_min,
        "take": args.take, "stop": args.stop, "horizon": args.horizon,
        "er_max": args.er_max, "cost": args.cost, "max_ch": args.max_ch,
        "modes": modes,
    }

    if args.tickers.upper() == "ALL":
        tickers = _list_tickers(args.cache, args.interval, top_liq=args.top_liq,
                                 liq_days=60, min_vol_pctl=0.0, max_vol_pctl=100.0,
                                 workers=1)
    else:
        tickers = [t.strip().upper() for t in args.tickers.split(",") if t.strip()]
    if not tickers:
        sys.exit("нет тикеров")

    sig = _sig(args, tickers, params)
    rows = []
    done_set = set()
    if not args.fresh and os.path.exists(args.checkpoint):
        try:
            with open(args.checkpoint, encoding="utf-8") as f:
                cp = json.load(f)
            if cp.get("sig") == sig:
                rows = cp.get("rows", [])
                done_set = set(r["ticker"] for r in rows)
                print(f"[checkpoint] продолжаю: {len(done_set)}/{len(tickers)}",
                      file=sys.stderr)
        except (json.JSONDecodeError, OSError):
            pass

    remaining = [t for t in tickers if t not in done_set]
    try:
        for i, t in enumerate(remaining):
            print(f"\r{len(done_set) + i + 1}/{len(tickers)} {t:<12}",
                  end="", file=sys.stderr, flush=True)
            try:
                r = process_ticker(t, args.cache, args.interval, args.days, params)
            except Exception as e:
                print(f"\n[{t}] {e}", file=sys.stderr)
                r = None
            if r:
                rows.append(r)
            atomic_write_json(args.checkpoint, {"sig": sig, "rows": rows})
    except KeyboardInterrupt:
        print("\n[прервано]", file=sys.stderr)
    print(file=sys.stderr)

    if args.out:
        import csv
        with open(args.out, "w", newline="", encoding="utf-8") as f:
            w = csv.writer(f)
            w.writerow(["ticker", "is_future", "liq_mln", "vol_pct", "n_bars",
                        "mode", "n", "wins", "pnl_sum", "drawdown", "n_long", "n_short"])
            for r in rows:
                for m in modes:
                    a = r.get(m, {})
                    w.writerow([r["ticker"], r["is_future"], r.get("liq_mln"),
                                r.get("vol_pct"), r["n_bars"], m,
                                a.get("n", 0), a.get("wins", 0), a.get("pnl_sum", 0),
                                a.get("drawdown", 0), a.get("n_long", 0), a.get("n_short", 0)])
        print(f"[out] {args.out}", file=sys.stderr)

    print_summary(rows, modes)


if __name__ == "__main__":
    main()
