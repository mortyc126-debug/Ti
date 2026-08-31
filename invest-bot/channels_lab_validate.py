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
import subprocess
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

NODE_BRIDGE = os.path.join(_HERE, "run_signals_core.js")


def _extension_method_signs(bars_raw, sig_bar_indices, agg_factor, node_bin):
    """Вызов run_signals_core.js на ИСХОДНЫХ 5-мин барах — получаем сигналы всех
    32 методов расширения для каждого исходного бара. Затем для каждого
    агрегированного сигнала channels_lab (индекс j в агрегированных барах)
    берём знак метода на ПОСЛЕДНЕМ исходном баре в чанке (j*agg + agg-1) —
    т.к. агрегация берёт close с последнего бара, знак метода тоже "как виден
    в конце чанка". Возвращает {method_name: [sign for each sig]}.

    Причинность: методы signals-core.js сами по себе причинны (окно только в
    прошлое), + мы берём знак на баре СИГНАЛА, не позже — look-ahead нет."""
    if not sig_bar_indices:
        return {}
    try:
        p = subprocess.run(
            [node_bin, NODE_BRIDGE, "0"],
            input=json.dumps(bars_raw), capture_output=True, text=True,
        )
    except FileNotFoundError:
        return {}
    if p.returncode != 0:
        return {}
    try:
        data = json.loads(p.stdout)
    except json.JSONDecodeError:
        return {}
    scores = data.get("scores", {})
    n_raw = len(bars_raw)
    out = {}
    for name, series in scores.items():
        signs = []
        for j in sig_bar_indices:
            raw_i = min(j * agg_factor + agg_factor - 1, n_raw - 1)
            v = series[raw_i] if 0 <= raw_i < n_raw else None
            if v is None or v == 0:
                signs.append(0)
            elif v > 0:
                signs.append(1)
            else:
                signs.append(-1)
        out[name] = signs
    return out


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


def _vol_sma(bars, per=20):
    # Скользящее среднее объёма — для оценки всплеска/затишья в точке входа.
    n = len(bars); out = [None] * n; s = 0.0
    for i in range(n):
        s += bars[i]["volume"]
        if i >= per:
            s -= bars[i - per]["volume"]
        if i >= per - 1:
            out[i] = s / per
    return out


def _ctx_features(bars, i, chs, atr, vol_sma, w2, dir_):
    # Контекст сделки: положение внутри канала ch2, наклон канала, его ширина,
    # объём в точке входа. Сырые числа — бакетизация позже, в _aggregate_signals.
    a = atr[i] or 1.0
    ch = chs.get("ch2") if chs else None
    out = {}
    if ch and ch["sigma"] > 0:
        out["cz"] = (bars[i]["close"] - ch["center_now"]) / ch["sigma"]
        # дрейф центра за окно W2 в ATR — сила тренда канала (флэт ≈ 0)
        out["ctrend"] = ch["slope"] * w2 / a
        out["cwidth"] = ch["sigma"] / a
        # fade идёт ПО тренду (+1) или ПРОТИВ (-1, классич. mean-revert)
        sl = ch["slope"]
        out["cwith"] = dir_ * (1 if sl > 0 else -1 if sl < 0 else 0)
    vs = vol_sma[i] if i < len(vol_sma) else None
    if vs and vs > 0:
        out["cvol"] = bars[i]["volume"] / vs
    return out


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
        sig = {
            "i": i, "dir": dir_, "pnl": pnl_gross - cost,
            "reason": reason, "confluence_channel": micro_agree,
            "ch_votes": ch_votes, "level_strength": hit_level["touches"],
            "time": b.get("time", ""),
        }
        sig.update(_ctx_features(bars, i, chs, atr,
                                 params.get("vol_sma", []), params.get("w2", 80), dir_))
        signals.append(sig)
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
        sig = {
            "i": i, "dir": dir_, "pnl": pnl_gross - cost,
            "reason": reason, "n_channels": len(votes),
            "time": b.get("time", ""),
        }
        sig.update(_ctx_features(bars, i, chs, atr,
                                 params.get("vol_sma", []), params.get("w2", 80), dir_))
        signals.append(sig)
    return signals


def _quarter(time_iso):
    """'2026-03-15T14:20:00' → '2026-Q1'. Пустая строка → 'unknown'."""
    if not time_iso or len(time_iso) < 7:
        return "unknown"
    try:
        y = time_iso[:4]; m = int(time_iso[5:7])
        return f"{y}-Q{(m - 1) // 3 + 1}"
    except (ValueError, IndexError):
        return "unknown"


# ── агрегация: N последовательных баров сливаются в один ───────────────────
# open первого, close последнего, high/low крайние, volume суммируется.
# Позволяет из 5-мин кэша получить 30-мин (agg=6), 1ч (agg=12), 4ч (agg=48),
# дневки (agg=78) без перекачки данных. На большем ТФ ATR растёт в абсолюте,
# а комиссия остаётся той же в % цены → cost в единицах ATR падает
# пропорционально (5м→30м = cost упадёт в ~2.5-3 раза).
def aggregate_bars(bars, factor):
    if factor <= 1:
        return bars
    out = []
    for i in range(0, len(bars) - factor + 1, factor):
        chunk = bars[i:i + factor]
        out.append({
            "time": chunk[0]["time"],
            "open": chunk[0]["open"],
            "high": max(b["high"] for b in chunk),
            "low": min(b["low"] for b in chunk),
            "close": chunk[-1]["close"],
            "volume": sum(b.get("volume", 0) for b in chunk),
        })
    return out


def _apply_method_filter(sigs, agree_list, disagree_list, strict=False):
    """Фильтр сделок по знакам методов на баре сделки.

    Мягкий режим (default): требуем "нет противоречия".
      - agree_list: каждый метод должен НЕ голосовать против (sign * dir >= 0);
                     нейтральный знак разрешён.
      - disagree_list: каждый метод должен НЕ голосовать ЗА (sign * dir <= 0);
                       нейтральный знак разрешён.
    Так фильтр отсекает противоречия, не срезая выборку при молчащем методе
    (многие anti-методы вроде liq_sweep активны только в 10-20% баров).

    Строгий режим (--strict-filter):
      - agree: метод АКТИВЕН И согласен (sign * dir > 0), молчит = отсеять
      - disagree: метод АКТИВЕН И против (sign * dir < 0), молчит = отсеять
    Даёт меньше сделок, но каждая с реальным confluence."""
    if not agree_list and not disagree_list:
        return sigs
    out = []
    for s in sigs:
        mth = s.get("mth", {})
        dir_ = s["dir"]
        ok = True
        for name in agree_list:
            v = mth.get(name, 0) * dir_
            if (strict and v <= 0) or (not strict and v < 0):
                ok = False
                break
        if ok:
            for name in disagree_list:
                v = mth.get(name, 0) * dir_
                if (strict and v >= 0) or (not strict and v > 0):
                    ok = False
                    break
        if ok:
            out.append(s)
    return out


def _apply_ctx_filter(sigs, contra, zmax, volmax, zmin=None, volmin=None):
    # Ценовые фильтры пакета A. Разрез показал ПОЛОСОВУЮ структуру, а не порог:
    #   contra — брать только контр-трендовый fade (cwith<0), по-тренду убыточен;
    #   |z| ∈ [zmin, zmax] — z<1 (в теле канала) убыточен, z>2 (пробой) убыточен,
    #                         рабочая зона [1,2];
    #   объём ∈ [volmin, volmax] — тишина (<0.8) и climax (>1.5) убыточны, зона
    #                              [0.8,1.5].
    # Если у сигнала нет нужного поля (нет ch2/объёма), не отсекаем по нему —
    # кроме contra, где отсутствие наклона = не подтверждён контр-тренд → отсекаем.
    if (not contra and zmax is None and volmax is None
            and zmin is None and volmin is None):
        return sigs
    out = []
    for s in sigs:
        if contra and s.get("cwith", 0) >= 0:
            continue
        if "cz" in s:
            az = abs(s["cz"])
            if zmax is not None and az > zmax:
                continue
            if zmin is not None and az < zmin:
                continue
        if "cvol" in s:
            cv = s["cvol"]
            if volmax is not None and cv > volmax:
                continue
            if volmin is not None and cv < volmin:
                continue
        out.append(s)
    return out


# ── прогон одного тикера ────────────────────────────────────────────────────
def process_ticker(ticker, cache_dir, interval, days, params):
    rows_raw = _load_from_cache(ticker, cache_dir, interval)
    if not rows_raw:
        return None
    if days:
        # bars_per_day для 5-мин ≈ 78, для 1-мин ≈ 390. Отсекаем ПЕРЕД
        # агрегацией, иначе последний неполный кусок съест лишнее.
        bpd = 390 // max(interval, 1)
        rows_raw = rows_raw[-max(days * bpd, 300 * params.get("agg", 1)):]
    liq, vol = _liq_vol(rows_raw)  # ликв/вол считаем на исходных 5-мин барах
    bars = [{"open": float(r["open"]), "high": float(r["high"]),
              "low": float(r["low"]), "close": float(r["close"]),
              "volume": float(r["volume"]), "time": r["time"]} for r in rows_raw]
    agg = params.get("agg", 1)
    if agg > 1:
        bars = aggregate_bars(bars, agg)
    n = len(bars)
    if n < max(params["w3"], 300) + params["horizon"]:
        return None
    atr = atr_series(bars, 14)
    vol_sma = _vol_sma(bars, 20)

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
        "w2": W2, "vol_sma": vol_sma,
    }
    for mode in params["modes"]:
        if mode == "channel":
            sigs = detect_channel_signals(bars, ch_series, atr, p)
        elif mode == "combo":
            lvl = detect_level_signals(bars, ch_series, levels, atr, p)
            sigs = [s for s in lvl if s.get("confluence_channel")]
        else:  # level
            sigs = detect_level_signals(bars, ch_series, levels, atr, p)
        # Обогащаем сигналы знаками методов расширения (если включено). Дорогой
        # вызов Node bridge — один раз на тикер, cache отсутствует (пересчёт при
        # каждом --fresh).
        if params.get("methods") and sigs:
            sig_bar_idx = [s["i"] for s in sigs]
            method_signs = _extension_method_signs(rows_raw, sig_bar_idx, agg, params.get("node", "node"))
            for name, signs in method_signs.items():
                for s, sn in zip(sigs, signs):
                    s.setdefault("mth", {})[name] = sn
        # Фильтр по методам-соучастникам: оставляем только сделки, где ВСЕ
        # методы из filter_agree согласны с направлением, И ВСЕ методы из
        # filter_disagree — ПРОТИВ направления. Нейтральный знак (=0) для
        # метода в filter_agree/filter_disagree трактуется как несоответствие
        # (сделка исключается) — иначе фильтр был бы бесполезен на баре, где
        # метод молчит.
        # Контекст-фильтры пакета A (ценовые, без расширения): применяем ДО
        # method-фильтра, чтобы стекались.
        sigs = _apply_ctx_filter(sigs, params.get("ctx_contra", False),
                                 params.get("ctx_zmax"), params.get("ctx_volmax"),
                                 params.get("ctx_zmin"), params.get("ctx_volmin"))
        fa = params.get("filter_agree") or []
        fd = params.get("filter_disagree") or []
        if fa or fd:
            sigs = _apply_method_filter(sigs, fa, fd, strict=params.get("strict_filter", False))
        agg = _aggregate_signals(sigs, mode)
        # Train/test split по времени: сделки первой доли истории (train) vs
        # хвост (test). Честная проверка: фильтр выбираем глядя только в train,
        # цифру доверия читаем в test (данные, на которых ничего не крутили).
        frac = params.get("split_frac")
        if frac and 0 < frac < 1:
            cutoff = int(n * frac)
            train = [s for s in sigs if s["i"] < cutoff]
            test = [s for s in sigs if s["i"] >= cutoff]
            agg["split"] = {"train": _aggregate_signals(train, mode),
                            "test": _aggregate_signals(test, mode)}
        out[mode] = agg
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
    # Разбивка по кварталам — увидеть, был ли период когда edge держался и
    # сломался, или это стабильное поведение
    by_q = defaultdict(lambda: {"n": 0, "wins": 0, "pnl": 0.0})
    for s in sigs:
        q = _quarter(s.get("time", ""))
        bq = by_q[q]
        bq["n"] += 1
        bq["pnl"] += s["pnl"]
        if s["pnl"] > 0:
            bq["wins"] += 1
    r["by_q"] = dict(by_q)

    # Разбивка по методам расширения (если сигналы обогащены знаками методов).
    # Для каждой сделки sig.dir × sig.mth[method] ∈ {-1, 0, +1}:
    #   +1 = метод согласен с направлением сделки (лонг+лонг или шорт+шорт)
    #    0 = метод молчит (нейтрален)
    #   -1 = метод против направления сделки
    # Считаем n/wins/pnl отдельно для agrees/disagrees/neutral → это позволяет
    # найти confluence-фильтры и anti-фильтры.
    by_method = {}
    if sigs and "mth" in sigs[0]:
        method_names = set()
        for s in sigs:
            method_names.update(s["mth"].keys())
        for name in method_names:
            bm = {"agr_n": 0, "agr_w": 0, "agr_p": 0.0,
                  "dis_n": 0, "dis_w": 0, "dis_p": 0.0,
                  "neu_n": 0, "neu_w": 0, "neu_p": 0.0}
            for s in sigs:
                sn = s["mth"].get(name, 0)
                bucket = "neu"
                if sn * s["dir"] > 0:
                    bucket = "agr"
                elif sn * s["dir"] < 0:
                    bucket = "dis"
                bm[bucket + "_n"] += 1
                bm[bucket + "_p"] += s["pnl"]
                if s["pnl"] > 0:
                    bm[bucket + "_w"] += 1
            by_method[name] = bm
    r["by_method"] = by_method
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

    # ═══ Контекст (пакет A): наклон / позиция в канале / ширина / объём ═══
    # Каждая ось бьётся на бакеты, exp по бакету показывает где fade сильнее.
    ctx = {"trend": {}, "zpos": {}, "width": {}, "vol": {}}
    def _acc(axis, key, s):
        d = ctx[axis].setdefault(key, {"n": 0, "wins": 0, "pnl": 0.0})
        d["n"] += 1; d["pnl"] += s["pnl"]
        if s["pnl"] > 0:
            d["wins"] += 1
    for s in sigs:
        if "ctrend" in s:
            t = s["ctrend"]; w = s.get("cwith", 0)
            if abs(t) < 0.3:
                key = "флэт"
            elif w > 0:
                key = "по-тренду"
            elif w < 0:
                key = "против"
            else:
                key = "флэт"
            _acc("trend", key, s)
        if "cz" in s:
            az = abs(s["cz"])
            key = "z<1" if az < 1 else ("z1-2" if az < 2 else "z2+")
            _acc("zpos", key, s)
        if "cwidth" in s:
            cw = s["cwidth"]
            key = "узк<1.5" if cw < 1.5 else ("ср1.5-3" if cw < 3 else "шир3+")
            _acc("width", key, s)
        if "cvol" in s:
            cv = s["cvol"]
            key = "vlo<0.8" if cv < 0.8 else ("vmid0.8-1.5" if cv < 1.5 else "vhi1.5+")
            _acc("vol", key, s)
    r["ctx"] = ctx
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

    # ═══ Per-ticker распределение ═══
    # Средневзвешенное exp по всем сделкам ссыпает вместе тикеры где +0.5(30 сд)
    # и тикеры где -0.5(1000 сд) — плохие с массой сделок топят хорошие. Считаем
    # exp per-ticker (равновзвешенно по тикеру), медиану, % в плюсе — сразу
    # видно, edge универсальный или сидит в 2-3 тикерах.
    print("\n═══ PER-TICKER (равновзвешенно) ═══")
    for mode in modes:
        per = []
        for r in rows:
            a = r.get(mode, {})
            if not a.get("n"):
                continue
            exp = a["pnl_sum"] / a["n"]
            per.append((r["ticker"], a["n"], a["wins"] / a["n"] * 100, exp, a["pnl_sum"]))
        if not per:
            print(f"\n{mode}: нет сигналов")
            continue
        per.sort(key=lambda t: t[3], reverse=True)
        n_total = len(per)
        n_pos = sum(1 for t in per if t[3] > 0)
        exps = sorted(t[3] for t in per)
        median_exp = exps[n_total // 2]
        mean_exp = sum(exps) / n_total  # среднее по тикерам, а не по сделкам
        print(f"\n{mode}: {n_total} тикеров с сигналами · в плюсе {n_pos} ({n_pos/n_total*100:.0f}%) "
               f"· медианный exp {median_exp:+.3f} · среднее по тикерам {mean_exp:+.3f}")
        print(f"  TOP-10:")
        for t in per[:10]:
            print(f"    {t[0]:<10} n={t[1]:>4}  win={t[2]:>5.1f}%  exp={t[3]:>+6.3f}  sum={t[4]:>+7.2f}")
        print(f"  BOTTOM-10:")
        for t in per[-10:]:
            print(f"    {t[0]:<10} n={t[1]:>4}  win={t[2]:>5.1f}%  exp={t[3]:>+6.3f}  sum={t[4]:>+7.2f}")

    # ═══ По кварталам ═══
    print("\n═══ ПО КВАРТАЛАМ (все тикеры) ═══")
    for mode in modes:
        by_q_global = defaultdict(lambda: {"n": 0, "wins": 0, "pnl": 0.0})
        for r in rows:
            for q, v in r.get(mode, {}).get("by_q", {}).items():
                bq = by_q_global[q]
                bq["n"] += v["n"]; bq["wins"] += v["wins"]; bq["pnl"] += v["pnl"]
        if not by_q_global:
            continue
        print(f"\n{mode}:")
        print(f"  {'квартал':<10} {'n':>7} {'win%':>6} {'exp':>7} {'sum':>8}")
        for q in sorted(by_q_global):
            v = by_q_global[q]
            if not v["n"]:
                continue
            print(f"  {q:<10} {v['n']:>7} {v['wins']/v['n']*100:>5.1f}% "
                   f"{v['pnl']/v['n']:>+7.3f} {v['pnl']:>+8.1f}")

    # ═══ Контекст (пакет A): наклон / позиция / ширина / объём ═══
    # Разрез exp по контекстным осям — ищем где fade реально работает: во флэте
    # или тренде, у какой границы канала, при каком объёме.
    print("\n═══ КОНТЕКСТ: наклон / позиция / ширина / объём (все тикеры) ═══")
    axes_order = [("trend", "наклон канала"), ("zpos", "позиция |z| ch2"),
                  ("width", "ширина σ/ATR"), ("vol", "объём/SMA20")]
    # порядок бакетов внутри оси для читаемости (не по алфавиту)
    bucket_order = {
        "trend": ["против", "флэт", "по-тренду"],
        "zpos": ["z<1", "z1-2", "z2+"],
        "width": ["узк<1.5", "ср1.5-3", "шир3+"],
        "vol": ["vlo<0.8", "vmid0.8-1.5", "vhi1.5+"],
    }
    for mode in modes:
        glob = {ax: {} for ax, _ in axes_order}
        any_data = False
        for r in rows:
            c = r.get(mode, {}).get("ctx")
            if not c:
                continue
            for ax, _ in axes_order:
                for key, v in c.get(ax, {}).items():
                    d = glob[ax].setdefault(key, {"n": 0, "wins": 0, "pnl": 0.0})
                    d["n"] += v["n"]; d["wins"] += v["wins"]; d["pnl"] += v["pnl"]
                    any_data = True
        if not any_data:
            continue
        print(f"\n{mode}:")
        for ax, label in axes_order:
            keys = [k for k in bucket_order[ax] if k in glob[ax]]
            keys += [k for k in sorted(glob[ax]) if k not in bucket_order[ax]]
            parts = []
            for key in keys:
                v = glob[ax][key]
                if not v["n"]:
                    continue
                parts.append(f"{key} {v['wins']/v['n']*100:.0f}%/{v['pnl']/v['n']:+.2f}({v['n']})")
            if parts:
                print(f"  {label:<18} " + "  ".join(parts))

    # ═══ Train/test split ═══
    # Суммируем train- и test-агрегаты по всем тикерам. Если edge реальный, а
    # не подгонка — exp на test близок к train. Провал test при плюсовом train =
    # переобучение.
    has_split = any(r.get(m, {}).get("split") for r in rows for m in modes)
    if has_split:
        print("\n═══ TRAIN/TEST SPLIT (все тикеры) ═══")
        print("  Реальный edge → test ≈ train. test≈0 при train>0 = переобучение.")
        for mode in modes:
            tr = _sum_aggs([r[mode]["split"]["train"] for r in rows
                            if r.get(mode, {}).get("split") and r[mode]["split"]["train"].get("n")])
            te = _sum_aggs([r[mode]["split"]["test"] for r in rows
                            if r.get(mode, {}).get("split") and r[mode]["split"]["test"].get("n")])
            if not tr and not te:
                continue
            print(f"\n{mode}:")
            print(f"  train: {_fmt_mode(tr)}")
            print(f"  test:  {_fmt_mode(te)}")

    # ═══ Confluence с методами расширения ═══
    # Для каждого метода: exp сделок channels_lab когда метод СОГЛАСЕН по
    # направлению vs когда ПРОТИВ. Ищем "разделяющие" методы — те, где
    # разница exp_agree − exp_disagree большая по модулю. Положительный lift =
    # метод-фильтр (следуй ему), отрицательный = anti-фильтр (делай наоборот).
    for mode in modes:
        by_m_global = defaultdict(lambda: {"agr_n": 0, "agr_w": 0, "agr_p": 0.0,
                                             "dis_n": 0, "dis_w": 0, "dis_p": 0.0,
                                             "neu_n": 0, "neu_w": 0, "neu_p": 0.0})
        has_data = False
        for r in rows:
            bym = r.get(mode, {}).get("by_method", {})
            if bym:
                has_data = True
            for name, v in bym.items():
                bg = by_m_global[name]
                for k in bg:
                    bg[k] += v.get(k, 0)
        if not has_data:
            continue
        # Считаем lift = exp_agree − exp_disagree для каждого метода (только
        # где обе стороны имеют статистически значимую выборку, ≥30 сд).
        MIN_N = 30
        rows_m = []
        for name, v in by_m_global.items():
            if v["agr_n"] < MIN_N or v["dis_n"] < MIN_N:
                continue
            exp_a = v["agr_p"] / v["agr_n"]
            exp_d = v["dis_p"] / v["dis_n"]
            exp_n = v["neu_p"] / v["neu_n"] if v["neu_n"] else float("nan")
            rows_m.append((name, exp_a, v["agr_n"], v["agr_w"] / v["agr_n"] * 100,
                            exp_d, v["dis_n"], v["dis_w"] / v["dis_n"] * 100,
                            exp_n, v["neu_n"], exp_a - exp_d))
        if not rows_m:
            continue
        rows_m.sort(key=lambda t: t[-1], reverse=True)  # по lift
        print(f"\n═══ CONFLUENCE С МЕТОДАМИ РАСШИРЕНИЯ ({mode}) ═══")
        print(f"  Топ методов, где сделки channels_lab работают ЛУЧШЕ когда метод СОГЛАСЕН")
        print(f"  {'method':<22} {'agree':>16} {'disagree':>16} {'neutral':>10} {'lift':>7}")
        for t in rows_m[:10]:
            print(f"  {t[0]:<22} {t[2]:>4} {t[3]:>4.0f}% {t[1]:>+6.3f}   "
                   f"{t[5]:>4} {t[6]:>4.0f}% {t[4]:>+6.3f}   "
                   f"{t[8]:>4} {t[7]:>+6.3f}   {t[9]:>+6.3f}")
        print(f"  ─── ANTI-фильтры (сделки лучше когда метод ПРОТИВ) ───")
        for t in rows_m[-10:][::-1]:
            print(f"  {t[0]:<22} {t[2]:>4} {t[3]:>4.0f}% {t[1]:>+6.3f}   "
                   f"{t[5]:>4} {t[6]:>4.0f}% {t[4]:>+6.3f}   "
                   f"{t[8]:>4} {t[7]:>+6.3f}   {t[9]:>+6.3f}")


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
    ap.add_argument("--agg", type=int, default=1,
                     help="Агрегировать N исходных баров в один. Для 5-мин кэша: "
                          "6=30мин, 12=1ч, 48=4ч, 78=дневки. На большем ТФ ATR больше "
                          "в абсолюте → снижай --cost пропорционально (5м cost 0.5 → "
                          "30м cost 0.2 → 1ч cost 0.12).")
    ap.add_argument("--methods", action="store_true",
                     help="Считать confluence с методами расширения (все 32 из "
                          "signals-core.js). Для каждой сделки channels_lab на баре "
                          "фиксируем знак каждого метода → в отчёте видим топ "
                          "confluence-фильтров и anti-фильтров. Дорого: +1 Node "
                          "вызов на тикер, +5-10 сек на 50 тикеров/1ч.")
    ap.add_argument("--filter-agree", default=None,
                     help="Оставить только сделки, где ВСЕ перечисленные методы "
                          "СОГЛАСНЫ с направлением сделки (dir и sign одного знака). "
                          "Пример: --filter-agree donchian,order_block,hawkes. Требует "
                          "--methods.")
    ap.add_argument("--filter-disagree", default=None,
                     help="Оставить только сделки, где ВСЕ перечисленные методы "
                          "ПРОТИВ направления сделки (dir и sign разных знаков). "
                          "Пример: --filter-disagree liq_sweep,fractional_diff. "
                          "Требует --methods.")
    ap.add_argument("--strict-filter", action="store_true",
                     help="Строгий режим фильтра: метод должен быть АКТИВЕН (нейтрал "
                          "не проходит). По умолчанию — мягкий (нейтрал считается "
                          "неконфликтом). Строгий даёт меньше сделок, но каждая с "
                          "реальным confluence.")
    ap.add_argument("--ctx-contra", action="store_true",
                     help="Пакет A: брать только контр-трендовый fade (наклон "
                          "канала ch2 против направления сделки). Разрез показал: "
                          "по-тренду убыточен, работает только возврат против наклона.")
    ap.add_argument("--ctx-zmax", type=float, default=None,
                     help="Пакет A: выкинуть сделки где |z| в канале ch2 > zmax "
                          "(далеко за σ = пробой, fade гибнет). Разумно ~2.0.")
    ap.add_argument("--ctx-zmin", type=float, default=None,
                     help="Пакет A: выкинуть сделки где |z| < zmin (в теле канала "
                          "fade мёртв). Разрез: рабочая зона |z| ∈ [1,2].")
    ap.add_argument("--ctx-volmax", type=float, default=None,
                     help="Пакет A: выкинуть сделки где объём > volmax·SMA20 "
                          "(всплеск = climax-пробой). Разумно ~1.5.")
    ap.add_argument("--ctx-volmin", type=float, default=None,
                     help="Пакет A: выкинуть сделки где объём < volmin·SMA20 "
                          "(тишина). Разрез: рабочая зона объём ∈ [0.8,1.5].")
    ap.add_argument("--split-frac", type=float, default=None,
                     help="Train/test split по времени: доля истории для train "
                          "(напр. 0.6 = первые 60%% баров — train, хвост 40%% — "
                          "test). Честная OOS-проверка: фильтр подбираешь глядя "
                          "ТОЛЬКО в train, доверяешь цифре test. В отчёте секция "
                          "TRAIN/TEST по каждому режиму.")
    ap.add_argument("--node", default="node", help="путь к node (для --methods)")
    ap.add_argument("--modes", default="level,channel,combo")
    ap.add_argument("--checkpoint",
                     default=os.path.join(_HERE, "data", "channels_lab_cp.json"))
    ap.add_argument("--fresh", action="store_true")
    ap.add_argument("--out", default=None, help="CSV per-ticker per-mode")
    args = ap.parse_args()

    modes = [m.strip() for m in args.modes.split(",") if m.strip()]
    filter_agree = [m.strip().lower() for m in (args.filter_agree or "").split(",") if m.strip()]
    filter_disagree = [m.strip().lower() for m in (args.filter_disagree or "").split(",") if m.strip()]
    # Активные фильтры требуют --methods (иначе mth пусто → всё отсеется)
    if (filter_agree or filter_disagree) and not args.methods:
        args.methods = True
        print("[filter] --filter-* требует --methods, включаю автоматически", file=sys.stderr)

    params = {
        "w1": args.w1, "w2": args.w2, "w3": args.w3, "k": args.k,
        "lv_pivot": args.lv_pivot, "lv_merge": args.lv_merge, "lv_min": args.lv_min,
        "take": args.take, "stop": args.stop, "horizon": args.horizon,
        "er_max": args.er_max, "cost": args.cost, "max_ch": args.max_ch,
        "agg": args.agg, "modes": modes,
        "methods": args.methods, "node": args.node,
        "filter_agree": filter_agree, "filter_disagree": filter_disagree,
        "strict_filter": args.strict_filter,
        "ctx_contra": args.ctx_contra, "ctx_zmax": args.ctx_zmax,
        "ctx_volmax": args.ctx_volmax, "ctx_zmin": args.ctx_zmin,
        "ctx_volmin": args.ctx_volmin, "split_frac": args.split_frac,
    }
    if args.split_frac:
        print(f"[split] train={args.split_frac:.0%} / test={1-args.split_frac:.0%} "
              f"по времени", file=sys.stderr)
    if (args.ctx_contra or args.ctx_zmax is not None or args.ctx_volmax is not None
            or args.ctx_zmin is not None or args.ctx_volmin is not None):
        print(f"[ctx] пакет A фильтр: contra={args.ctx_contra} "
              f"z∈[{args.ctx_zmin},{args.ctx_zmax}] "
              f"vol∈[{args.ctx_volmin},{args.ctx_volmax}]", file=sys.stderr)
    if filter_agree or filter_disagree:
        mode_lbl = "строгий (метод активен)" if args.strict_filter else "мягкий (нейтрал ок)"
        print(f"[filter] {mode_lbl}  agree={filter_agree or '—'}  "
              f"disagree={filter_disagree or '—'}", file=sys.stderr)
    if args.agg > 1:
        print(f"[agg] баров сливаем ×{args.agg}: {args.interval}-мин → "
               f"{args.interval * args.agg}-мин", file=sys.stderr)

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
