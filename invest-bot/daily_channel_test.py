"""daily_channel_test.py — параллельные каналы на СТАРШЕМ ТФ (дневки) по спеке.

Смена масштаба: channel_v2 мерил внутридневные микроканалы (5м/20м) — мёртвы.
Здесь дневные каналы, где движения крупные (дневной ATR), а издержки не грызут.

Спека пользователя:
  - границы ПАРАЛЛЕЛЬНЫЕ (не две независимые линии, как в channel_v2);
  - анкер — 2 значимых экстремума (2 хая ИЛИ 2 лоя), параллель смещена так,
    чтобы ОБА экстремума вошли (противоположную границу кладём на крайний
    противоположный экстремум окна);
  - анкер-точки НЕ слишком далеко по времени (--max-span дней), иначе неторгуемо;
  - walk-forward причинно: свинг подтверждается ±STEP дней, канал скан с
    (born+STEP) — слом узнаём только придя вперёд, без подглядывания;
  - исход касания по ЗАМОРОЖЕННОЙ границе (иначе наклон сам рисует исход).

Барьеры интрабар (дневные H/L) от цены входа, no-overlap, held-out, cost в
дневном ATR. Офлайн из candle_cache (5м → дневки), numpy.

Запуск:  python daily_channel_test.py --all --split-date 2026-04-01
         python daily_channel_test.py --tickers SBER,GAZP --max-span 30
"""
import argparse
import glob
import json
import os
import re
from datetime import datetime

import numpy as np

SWING_STEP = 2         # свинг подтверждается ±STEP дней
MAX_SPAN = 30          # анкер-экстремумы не дальше друг от друга (дней)
TRIGGER_ATR = 0.30
PULLBACK_ATR = 0.15
BREAK_ATR = 0.30
BOUNCE_ATR = 1.00
REARM_ATR = 1.50
ATR_PERIOD = 14
CAP_BARS = 20          # тайм-аут эпизода (дней)
LIFE_BARS = 60         # горизонт жизни канала (дней)
GT_TAKES = (0.5, 0.7, 1.0)
GT_STOPS = (0.3, 0.5)
GT_PORT = (1.0, 0.5)


def _daily(path):
    """5м-кэш → дневные OHLC (по дате MSK-независимо, берём дату из time[:10])."""
    rows = json.load(open(path, encoding="utf-8"))
    if not rows:
        return None
    rows.sort(key=lambda r: r["time"])
    days = {}
    for r in rows:
        d = str(r["time"])[:10]
        g = days.get(d)
        if g is None:
            days[d] = {"o": r["open"], "h": r["high"], "l": r["low"], "c": r["close"]}
        else:
            g["h"] = max(g["h"], r["high"]); g["l"] = min(g["l"], r["low"]); g["c"] = r["close"]
    ds = sorted(days)
    o = np.array([days[d]["o"] for d in ds], float)
    h = np.array([days[d]["h"] for d in ds], float)
    l = np.array([days[d]["l"] for d in ds], float)
    c = np.array([days[d]["c"] for d in ds], float)
    return o, h, l, c, ds


def _atr(h, l, c, period):
    prev = np.concatenate([[c[0]], c[:-1]])
    tr = np.maximum(h - l, np.maximum(np.abs(h - prev), np.abs(l - prev)))
    out = np.full(len(c), np.nan)
    cs = np.cumsum(np.insert(tr, 0, 0.0))
    out[period - 1:] = (cs[period:] - cs[:-period]) / period
    out[out <= 0] = np.nan
    return out


def _swings(h, l, step):
    highs, lows = [], []
    n = len(h)
    for i in range(step, n - step):
        if h[i] == h[i - step:i + step + 1].max():
            highs.append((i, h[i]))
        if l[i] == l[i - step:i + step + 1].min():
            lows.append((i, l[i]))
    return highs, lows


def _line(p_a, p_b):
    (xa, ya), (xb, yb) = p_a, p_b
    if xb == xa:
        return None
    k = (yb - ya) / (xb - xa)
    return k, ya - k * xa


SLOPE_MAX_ATR = 0.35   # наклон границы круче X ATR/день — это не канал, а спайк-линия
WIDTH_MIN_ATR = 0.8    # уже — «нитка»/шум, не торговый коридор
WIDTH_MAX_ATR = 8.0    # шире — не коридор, а полнеба
LIFE_SPAN_MULT = 2.0   # канал живёт ~span*MULT дней (не фиксировано), но не дольше LIFE_BARS


def _build_channels(highs, lows, h, l, atr):
    """Параллельные каналы. Анкер по 2 хаям (верх) / 2 лоям (низ), параллель к
    крайнему противоположному экстремусу окна (оба входят). Отбор по вменяемости:
    наклон не круче SLOPE_MAX_ATR/день, ширина в коридоре, жизнь ~span (не вечный
    луч). Иначе линии-ракеты, которые ничего не значат."""
    out = []
    for anchor, opp_arr in (("high", l), ("low", h)):
        pts = highs if anchor == "high" else lows
        for i in range(1, len(pts)):
            a1, a2 = pts[i - 1], pts[i]
            span = a2[0] - a1[0]
            if span > MAX_SPAN or span < step_min():
                continue
            line = _line(a1, a2)
            if line is None:
                continue
            k, b = line
            born = a2[0]
            a = atr[born] if born < len(atr) and np.isfinite(atr[born]) and atr[born] > 0 else None
            if a is None:
                continue
            if abs(k) > SLOPE_MAX_ATR * a:              # наклон-ракета — не канал
                continue
            xs = np.arange(a1[0], a2[0] + 1)
            base = k * xs + b
            if anchor == "high":
                off = float(np.min(opp_arr[a1[0]:a2[0] + 1] - base))
            else:
                off = float(np.max(opp_arr[a1[0]:a2[0] + 1] - base))
            w = abs(off) / a
            if w < WIDTH_MIN_ATR or w > WIDTH_MAX_ATR:  # слишком узко/широко
                continue
            life = min(LIFE_BARS, int(span * LIFE_SPAN_MULT))
            out.append({"anchor": anchor, "k": k, "b": b, "off": off, "born": born, "life": life})
    seen, uniq = set(), []
    for ch in out:
        key = (ch["born"], ch["anchor"], round(ch["k"], 6))
        if key not in seen:
            seen.add(key); uniq.append(ch)
    return uniq


def step_min():
    return 2   # анкеры хотя бы 2 дня врозь (иначе не канал)


def _barriers(entry, sgn, a, h, l, c, i, end, cap):
    last = min(end, i + cap)
    grid = {}
    for take in GT_TAKES:
        for stop in GT_STOPS:
            pnl, exb = None, last
            for j in range(i + 1, last + 1):
                fav = sgn * ((h[j] if sgn > 0 else l[j]) - entry) / a
                adv = sgn * ((l[j] if sgn > 0 else h[j]) - entry) / a
                if adv <= -stop:
                    pnl, exb = -stop, j; break
                if fav >= take:
                    pnl, exb = take, j; break
            if pnl is None:
                pnl = sgn * (c[last] - entry) / a
            grid[(take, stop)] = (pnl, exb)
    return grid


def _scan(ch, h, l, c, atr, ds, ticker):
    """Скан касаний обеих параллельных границ. Причинно: старт с born+STEP."""
    n = len(c)
    start = ch["born"] + SWING_STEP
    end0 = min(n - 1, ch["born"] + ch["life"])
    if start >= end0:
        return []
    k, b, off = ch["k"], ch["b"], ch["off"]
    touches = []
    # две параллельные границы на баре x: anchor = k*x+b, parallel = k*x+b+off.
    # верх = max, низ = min. Касание верха → resistance (шорт), низа → support (лонг).
    for which in ("upper", "lower"):
        armed, i = True, start
        while i <= end0:
            a = atr[i]
            if not (np.isfinite(a) and a > 0):
                i += 1; continue
            v_anchor = k * i + b
            v_parallel = v_anchor + off
            lvl_now = max(v_anchor, v_parallel) if which == "upper" else min(v_anchor, v_parallel)
            is_upper = which == "upper"
            dist = abs(c[i] - lvl_now) / a
            if not armed:
                if dist > REARM_ATR:
                    armed = True
                i += 1; continue
            if dist >= TRIGGER_ATR:
                i += 1; continue
            side = "resistance" if is_upper else "support"
            sgn = 1.0 if side == "support" else -1.0
            lvl = lvl_now                      # ЗАМОРОЗКА
            extreme = l[i] if side == "support" else h[i]
            confirmed, entry_bar, res = False, -1, ""
            end = min(n - 1, i + CAP_BARS)
            j = i
            while j <= end:
                aj = atr[j]
                if not (np.isfinite(aj) and aj > 0):
                    j += 1; continue
                extreme = min(extreme, l[j]) if side == "support" else max(extreme, h[j])
                away = sgn * (c[j] - lvl) / aj
                if not confirmed:
                    if away <= -BREAK_ATR:
                        res = "break"; break
                    rt = sgn * (c[j] - extreme) / aj
                    if rt >= PULLBACK_ATR:
                        confirmed = True; entry_bar = j
                    elif j >= end:
                        res = "stall"; break
                if confirmed:
                    if away >= BOUNCE_ATR:
                        res = "bounce"; break
                    if away <= -BREAK_ATR:
                        res = "break"; break
                    if j >= end:
                        res = "stall"; break
                j += 1
            rec = {"ticker": ticker, "anchor": ch["anchor"], "which": which, "side": side,
                   "result": res or "stall", "date": ds[i], "confirmed": confirmed,
                   "bar": i, "lvl": lvl}
            if confirmed and entry_bar > 0:
                rec["grid"] = _barriers(c[entry_bar], sgn, atr[entry_bar], h, l, c, entry_bar, end, CAP_BARS)
                rec["entry_bar"] = entry_bar
            touches.append(rec)
            armed, i = False, j + 1
    return touches


def _row(label, rows):
    n = len(rows)
    if not n:
        print(f"{label:<22}{'—':>7}"); return
    b = sum(1 for r in rows if r["result"] == "bounce")
    k = sum(1 for r in rows if r["result"] == "break")
    print(f"{label:<22}{n:>7}{100*b/n:>9.1f}{100*k/n:>9.1f}{100*(n-b-k)/n:>9.1f}")


def _gt_grid(rows, cost, title):
    conf = [r for r in rows if "grid" in r]
    print(f"\n-- {title}: сетка тейк/стоп (N={len(conf)}, cost={cost}) --")
    print(f"{'take/stop':<12}" + "".join(f"{s:>10}" for s in GT_STOPS))
    if not conf:
        print("  пусто"); return
    for take in GT_TAKES:
        cells = []
        for stop in GT_STOPS:
            pnls = [r["grid"][(take, stop)][0] - cost for r in conf]
            exp = sum(pnls) / len(pnls)
            wr = 100 * sum(1 for p in pnls if p > 0) / len(pnls)
            cells.append(f"{exp:+.3f}/{wr:.0f}%")
        print(f"take{take:<8}" + "".join(f"{c:>10}" for c in cells))


def _gt_portfolio(rows, cost, title):
    take, stop = GT_PORT
    by_tk = {}
    for r in rows:
        if "grid" in r:
            by_tk.setdefault(r["ticker"], []).append(r)
    trades, pnl = 0, 0.0
    for rs in by_tk.values():
        rs.sort(key=lambda r: r["entry_bar"])
        free = -1
        for r in rs:
            if r["entry_bar"] <= free:
                continue
            p, exb = r["grid"][(take, stop)]
            pnl += p - cost; free = exb; trades += 1
    if not trades:
        print(f"{title:<28} нет сделок"); return
    print(f"{title:<28} N={trades:<5} exp={pnl/trades:+.3f}  Σ={pnl:+.1f} ATR (тейк{take}/стоп{stop})")


def _plot_svg(ticker, o, h, l, c, ds, channels, touches, out, days):
    """SVG-картинка: цена (close) + границы каналов + точки касаний (зелёный отскок
    / красный пробой). Чтобы глазами оценить, вменяемые ли каналы рисует алго."""
    n = len(c)
    i0 = max(0, n - days); i1 = n - 1
    seg = [(i, c[i]) for i in range(i0, i1 + 1)]
    pmin = min(l[i0:i1 + 1]); pmax = max(h[i0:i1 + 1])
    W, H, m = 1600, 800, 60
    def X(i): return m + (i - i0) / max(i1 - i0, 1) * (W - 2 * m)
    def Y(p): return H - m - (p - pmin) / max(pmax - pmin, 1e-9) * (H - 2 * m)
    parts = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" '
             f'style="background:#0d1117;font-family:monospace">']
    parts.append(f'<text x="{m}" y="30" fill="#c9d1d9" font-size="18">{ticker} — дневки, '
                 f'каналы алго (последние {days}д). Зелёный=отскок, красный=пробой</text>')
    # цена
    pts = " ".join(f"{X(i):.1f},{Y(p):.1f}" for i, p in seg)
    parts.append(f'<polyline points="{pts}" fill="none" stroke="#58a6ff" stroke-width="1.5"/>')
    # каналы в окне
    for ch in channels:
        s = ch["born"] + SWING_STEP; e = min(n - 1, ch["born"] + ch["life"])
        if e < i0 or s > i1:
            continue
        s = max(s, i0); e = min(e, i1)
        k, b, off = ch["k"], ch["b"], ch["off"]
        up = " ".join(f"{X(i):.1f},{Y(max(k*i+b, k*i+b+off)):.1f}" for i in range(s, e + 1))
        lo = " ".join(f"{X(i):.1f},{Y(min(k*i+b, k*i+b+off)):.1f}" for i in range(s, e + 1))
        col = "#d29922" if ch["anchor"] == "high" else "#a371f7"
        parts.append(f'<polyline points="{up}" fill="none" stroke="{col}" stroke-width="0.8" opacity="0.5"/>')
        parts.append(f'<polyline points="{lo}" fill="none" stroke="{col}" stroke-width="0.8" opacity="0.5"/>')
    # касания
    cmap = {"bounce": "#3fb950", "break": "#f85149", "stall": "#8b949e"}
    for t in touches:
        if not (i0 <= t["bar"] <= i1):
            continue
        parts.append(f'<circle cx="{X(t["bar"]):.1f}" cy="{Y(t["lvl"]):.1f}" r="3" '
                     f'fill="{cmap.get(t["result"], "#8b949e")}"/>')
    parts.append("</svg>")
    with open(out, "w", encoding="utf-8") as fh:
        fh.write("<!doctype html><meta charset=utf-8><body style='margin:0'>" + "".join(parts))
    print(f"картинка: {out} (каналов в окне нарисовано; открой в браузере)")


def main():
    global MAX_SPAN
    ap = argparse.ArgumentParser(description="Дневные параллельные каналы (спека пользователя)")
    ap.add_argument("--cache", default=os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                                    "data", "candle_cache"))
    ap.add_argument("--tickers", default="")
    ap.add_argument("--all", action="store_true")
    ap.add_argument("--max-span", type=int, default=MAX_SPAN)
    ap.add_argument("--cost-atr", type=float, default=0.12)
    ap.add_argument("--split-date", default="2026-04-01")
    ap.add_argument("--plot", default="", help="тикер — нарисовать каналы в HTML/SVG")
    ap.add_argument("--plot-out", default="channels.html")
    ap.add_argument("--plot-days", type=int, default=160)
    args = ap.parse_args()
    MAX_SPAN = args.max_span

    if args.plot:
        p = os.path.join(args.cache, f"{args.plot}.json")
        data = _daily(p)
        if data is None:
            raise SystemExit(f"нет данных: {p}")
        o, h, l, c, ds = data
        atr = _atr(h, l, c, ATR_PERIOD)
        highs, lows = _swings(h, l, SWING_STEP)
        chs = _build_channels(highs, lows, h, l, atr)
        tch = []
        for ch in chs:
            tch += _scan(ch, h, l, c, atr, ds, args.plot)
        _plot_svg(args.plot, o, h, l, c, ds, chs, tch, args.plot_out, args.plot_days)
        return

    if args.tickers:
        paths = [os.path.join(args.cache, f"{t.strip()}.json") for t in args.tickers.split(",") if t.strip()]
    elif args.all:
        paths = sorted(p for p in glob.glob(os.path.join(args.cache, "*.json"))
                       if not re.search(r"_\d+m\.json$", p))
    else:
        raise SystemExit("--tickers СПИСОК или --all")

    allt = []
    for p in paths:
        if not os.path.exists(p):
            continue
        data = _daily(p)
        if data is None:
            continue
        o, h, l, c, ds = data
        if len(c) < ATR_PERIOD + 4 * SWING_STEP + 10:
            continue
        atr = _atr(h, l, c, ATR_PERIOD)
        highs, lows = _swings(h, l, SWING_STEP)
        tk = os.path.basename(p)[:-5]
        for ch in _build_channels(highs, lows, h, l, atr):
            allt += _scan(ch, h, l, c, atr, ds, tk)
        if args.tickers:
            print(f"{tk}: дней {len(c)}, касаний {sum(1 for t in allt if t['ticker']==tk)}")

    if not allt:
        raise SystemExit("касаний нет — мало дневных баров? нужен кэш с историей")

    hdr = f"{'':<22}{'N':>7}{'bounce%':>9}{'break%':>9}{'stall%':>9}"
    print(f"\n{'='*70}\nДНЕВНЫЕ ПАРАЛЛЕЛЬНЫЕ КАНАЛЫ (max-span={MAX_SPAN}д) — {len(allt)} касаний\n{'='*70}")
    print("\n== Все ==");  print(hdr);  _row("all", allt)
    print("\n== Роль границы ==");  print(hdr)
    for sd in ("support", "resistance"):
        _row(sd, [r for r in allt if r["side"] == sd])
    print("\n== Тип анкера ==");  print(hdr)
    for an in ("high", "low"):
        _row(f"анкер={an}", [r for r in allt if r["anchor"] == an])

    print(f"\n{'='*70}\nГОНТЛЕТ (интрабар тейк/стоп + no-overlap + held-out)\n{'='*70}")
    _gt_grid(allt, args.cost_atr, "все касания")
    print("\n-- No-overlap портфель --")
    _gt_portfolio(allt, args.cost_atr, "все")
    tr = [r for r in allt if r["date"] < args.split_date]
    te = [r for r in allt if r["date"] >= args.split_date]
    print(f"\n-- HELD-OUT: train<{args.split_date} ({len(tr)}) | test≥ ({len(te)}) --")
    if tr and te:
        _gt_portfolio(tr, args.cost_atr, "TRAIN")
        _gt_portfolio(te, args.cost_atr, "TEST (held-out)")
    else:
        print("одна из половин пуста — сдвинь --split-date")


if __name__ == "__main__":
    main()
