"""channel_v2.py — детектор каналов под спеку пользователя + тестируемые гейты видео.

Отличие от diag_channel_test (наивная версия): канал строится из ДВУХ независимых
линий (хаи↔хаи, лои↔лои) на СТАРШЕМ ТФ (×STRUCT_FACTOR к рабочему), а не из
L-H-L-тройки с параллельным офсетом. Ноги/ATR — per-ticker. Ширина канала —
режим (нитка/узкий/норм/широкий): «нитка» по словам пользователя это не канал, а
накопление/мёртвая ликвидность.

Плюс встроены как ИЗМЕРЯЕМЫЕ факторы гейты из видео-разбора (docx §5), которые
проверяем, а не берём на веру:
  - retest_ratio (§5.3 «точка под запретом»): дошла ли цена до пред. контрольного
    уровня перед касанием. <1 = запрет по трейдеру;
  - номер касания (§5.2 «больше касаний → выше пробой») — наши данные говорят
    обратное, чистый тест рассудит;
  - направление канала (§ «восходящие пробиваются вниз 80/20»);
  - высота канала H% (§5.1) как интересность.

Исход касания меряется относительно ЗАМОРОЖЕННОГО значения границы на баре
касания (иначе наклон линии сам рисует исходы — см. diag_channel_test фикс).

Офлайн из candle_cache, numpy. Запуск:
    python channel_v2.py --tickers SBER,GAZP --struct-factor 4
    python channel_v2.py --all
Вложенность, EMA, OI — отдельным слоем позже.
"""
import argparse
import glob
import json
import os

import numpy as np

TRIGGER_ATR = 0.30
PULLBACK_ATR = 0.15
BREAK_ATR = 0.30
BOUNCE_ATR = 1.00
REARM_ATR = 1.50
ATR_PERIOD = 20

STRUCT_FACTOR_DEFAULT = 4     # старший ТФ = ×4 к рабочему (20м структура для 5м)
SWING_STEP_DEFAULT = 2        # свинг подтверждается ±STEP барами старшего ТФ
CAP_STRUCT_BARS = 120         # горизонт жизни канала (баров старшего ТФ)
RESOLVE_CAP_5M = 48           # тайм-аут эпизода (5м баров)
MIN_HEIGHT_ATR = 0.5          # ниже — «нитка», не торговый канал

# Бакеты ширины канала в 5м-ATR (per-ticker ATR нормирует автоматически).
WIDTH_EDGES = [0.0, 0.5, 1.5, 4.0, np.inf]
WIDTH_LABELS = ["нитка<0.5", "узкий0.5-1.5", "норм1.5-4", "широкий>4"]


def _load(path):
    rows = json.load(open(path, encoding="utf-8"))
    if not rows:
        return None
    rows.sort(key=lambda r: r["time"])
    return (np.array([r["open"] for r in rows], float),
            np.array([r["high"] for r in rows], float),
            np.array([r["low"] for r in rows], float),
            np.array([r["close"] for r in rows], float))


def _aggregate(o, h, l, c, f):
    n = (len(c) // f) * f
    if n < f:
        return None
    O = o[:n:f]
    H = h[:n].reshape(-1, f).max(1)
    L = l[:n].reshape(-1, f).min(1)
    C = c[:n].reshape(-1, f)[:, -1]
    return O, H, L, C


def _atr(h, l, c, period):
    prev = np.concatenate([[c[0]], c[:-1]])
    tr = np.maximum(h - l, np.maximum(np.abs(h - prev), np.abs(l - prev)))
    out = np.full(len(c), np.nan)
    cs = np.cumsum(np.insert(tr, 0, 0.0))
    out[period - 1:] = (cs[period:] - cs[:-period]) / period
    return out


def _swings(sh, sl, step):
    """Свинги старшего ТФ: списки (idx, price) для хаёв и лоёв, время подтв. = idx+step."""
    highs, lows = [], []
    n = len(sh)
    for i in range(step, n - step):
        if sh[i] == sh[i - step:i + step + 1].max():
            highs.append((i, sh[i]))
        if sl[i] == sl[i - step:i + step + 1].min():
            lows.append((i, sl[i]))
    return highs, lows


def _line(p_a, p_b):
    """slope/intercept линии через два пивота (idx, price) в СТАРШЕМ индексе."""
    (xa, ya), (xb, yb) = p_a, p_b
    if xb == xa:
        return None
    k = (yb - ya) / (xb - xa)
    return k, ya - k * xa


def _build_channels(highs, lows):
    """Канал = последние 2 монотонных хая + последние 2 монотонных лоя одного
    направления. Порождаем канал в момент появления нового 4-го пивота (когда
    оба набора готовы и монотонны). born = max индекс из 4 точек."""
    out = []
    for hi in range(1, len(highs)):
        h2, h1 = highs[hi], highs[hi - 1]         # h1 раньше, h2 позже
        # ближайшие 2 лоя, оба подтверждённые не позже h2
        los = [lo for lo in lows if lo[0] <= h2[0]]
        if len(los) < 2:
            continue
        l1, l2 = los[-2], los[-1]
        up = h2[1] > h1[1] and l2[1] > l1[1]
        down = h2[1] < h1[1] and l2[1] < l1[1]
        if not (up or down):
            continue
        upper = _line(h1, h2)
        lower = _line(l1, l2)
        if upper is None or lower is None:
            continue
        born = max(h2[0], l2[0])
        out.append({
            "dir": "up" if up else "down", "upper": upper, "lower": lower,
            "born": born, "highs": (h1, h2), "lows": (l1, l2),
            "prev_low": los[-3][1] if len(los) >= 3 else None,
            "prev_high": highs[hi - 2][1] if hi >= 2 else None,
        })
    # дедуп по (born, dir) — соседние окна дают тот же канал
    seen, uniq = set(), []
    for ch in out:
        key = (ch["born"], ch["dir"], round(ch["upper"][0], 6))
        if key not in seen:
            seen.add(key)
            uniq.append(ch)
    return uniq


def _bval(line, x):
    return line[0] * x + line[1]


def _width_bucket(w_atr):
    for j in range(len(WIDTH_EDGES) - 1):
        if WIDTH_EDGES[j] <= w_atr < WIDTH_EDGES[j + 1]:
            return WIDTH_LABELS[j]
    return WIDTH_LABELS[-1]


def _scan(ch, h5, l5, c5, atr5, f, ticker):
    """Скан касаний обеих границ на 5м. Линия старшего ТФ в точке 5м-бара i:
    x = i/f (позиция в индексе старшего ТФ). Исход — по замороженному уровню."""
    n5 = len(c5)
    start5 = int(ch["born"] * f)
    end5 = min(n5 - 1, start5 + CAP_STRUCT_BARS * f)
    if start5 >= end5:
        return []
    touches = []
    for side in ("upper", "lower"):
        line = ch[side]
        armed, tb, prev_out = True, 0, ""
        i = start5
        while i <= end5:
            a = atr5[i]
            if not np.isfinite(a) or a <= 0:
                i += 1
                continue
            lvl_now = _bval(line, i / f)
            dist = abs(c5[i] - lvl_now) / a
            if not armed:
                if dist > REARM_ATR:
                    armed = True
                i += 1
                continue
            if dist >= TRIGGER_ATR:
                i += 1
                continue
            # касание. роль границы относительно направления канала
            if ch["dir"] == "up":
                role = "extreme" if side == "upper" else "pullback"
            else:
                role = "extreme" if side == "lower" else "pullback"
            sgn = 1.0 if side == "lower" else -1.0   # away = внутрь канала
            lvl = lvl_now                            # ЗАМОРОЗКА
            # высота канала здесь (в ATR) и retest_ratio (§5.3)
            width = abs(_bval(ch["upper"], i / f) - _bval(ch["lower"], i / f))
            w_atr = width / a
            prev_ref = ch["prev_low"] if side == "lower" else ch["prev_high"]
            last_ext = ch["lows"][1][1] if side == "lower" else ch["highs"][1][1]
            if prev_ref is not None and abs(prev_ref - last_ext) > 1e-9:
                retest = (c5[i] - last_ext) / (prev_ref - last_ext)
            else:
                retest = np.nan
            # эпизод (та же машина состояний)
            extreme = l5[i] if side == "lower" else h5[i]
            confirmed = False
            pen = pull = mfe = mae = 0.0
            res = follow = ""
            j = i
            while True:
                to = j >= end5 or (j - i) >= RESOLVE_CAP_5M
                aj = atr5[j]
                if not np.isfinite(aj) or aj <= 0:
                    if to:
                        res = "stall"
                        break
                    j += 1
                    continue
                extreme = min(extreme, l5[j]) if side == "lower" else max(extreme, h5[j])
                away = sgn * (c5[j] - lvl) / aj
                if not confirmed:
                    if away <= -BREAK_ATR:
                        res = "break"
                        break
                    rt = sgn * (c5[j] - extreme) / aj
                    if rt >= PULLBACK_ATR:
                        confirmed = True
                        pull = rt
                        pen = sgn * (lvl - extreme) / aj
                        mfe, mae = away, -away
                    elif to:
                        res = "stall"
                        break
                if confirmed:
                    mfe, mae = max(mfe, away), max(mae, -away)
                    if away >= BOUNCE_ATR:
                        res, follow = "bounce", "win"
                        break
                    if away <= -BREAK_ATR:
                        res, follow = "break", "fail"
                        break
                    if to:
                        res, follow = "stall", "none"
                        break
                j += 1
            touches.append({
                "ticker": ticker, "dir": ch["dir"], "side": side, "role": role,
                "result": res, "follow": follow, "touches_before": tb,
                "prev_outcome": prev_out, "w_atr": round(w_atr, 3),
                "w_bucket": _width_bucket(w_atr),
                "retest": round(float(retest), 3) if np.isfinite(retest) else None,
                "mfe": round(mfe, 3),
            })
            tb += 1
            prev_out = res
            armed = False
            i = j + 1
    return touches


def _process(path, ticker, f, days):
    data = _load(path)
    if data is None:
        return []
    o, h, l, c = data
    if days:
        cut = days * 100
        o, h, l, c = o[-cut:], h[-cut:], l[-cut:], c[-cut:]
    agg = _aggregate(o, h, l, c, f)
    if agg is None:
        return []
    sO, sH, sL, sC = agg
    if len(sC) < 40:
        return []
    atr5 = _atr(h, l, c, ATR_PERIOD)
    highs, lows = _swings(sH, sL, SWING_STEP_DEFAULT)
    if len(highs) < 2 or len(lows) < 2:
        return []
    channels = _build_channels(highs, lows)
    touches = []
    for ch in channels:
        # фильтр «нитка»/минимум по высоте на баре рождения
        a = atr5[int(ch["born"] * f)] if int(ch["born"] * f) < len(atr5) else np.nan
        touches += _scan(ch, h, l, c, atr5, f, ticker)
    return touches


# ── отчёт ────────────────────────────────────────────────────────────────────
def _row(label, rows):
    n = len(rows)
    if not n:
        print(f"{label:<26}{'—':>7}")
        return
    b = sum(1 for r in rows if r["result"] == "bounce")
    k = sum(1 for r in rows if r["result"] == "break")
    s = sum(1 for r in rows if r["result"] == "stall")
    mfe = sum(r["mfe"] for r in rows) / n
    print(f"{label:<26}{n:>7}{100*b/n:>9.1f}{100*k/n:>9.1f}{100*s/n:>9.1f}{mfe:>8.2f}")


def _report(touches):
    hdr = f"{'':<26}{'N':>7}{'bounce%':>9}{'break%':>9}{'stall%':>9}{'MFE':>8}"
    print(f"\n=== Каналы v2: {len(touches)} касаний ===")
    print("\n== Все ==");  print(hdr);  _row("all", touches)
    print("\n== Роль границы (against=extreme/фейд, with=pullback) ==");  print(hdr)
    for role in ("extreme", "pullback"):
        _row(f"role={role}", [t for t in touches if t["role"] == role])
    print("\n== Ширина канала (нитка отдельно) ==");  print(hdr)
    for b in WIDTH_LABELS:
        _row(b, [t for t in touches if t["w_bucket"] == b])
    print("\n== Направление канала (тест 80/20) ==");  print(hdr)
    for d in ("up", "down"):
        _row(f"{d}-канал", [t for t in touches if t["dir"] == d])
    print("\n== Номер касания (тест §5.2 «больше касаний→пробой») ==");  print(hdr)
    _row("первое (tb=0)", [t for t in touches if t["touches_before"] == 0])
    _row("2-3", [t for t in touches if 1 <= t["touches_before"] <= 2])
    _row("4+", [t for t in touches if t["touches_before"] >= 3])
    print("\n== retest_ratio (§5.3 «точка под запретом») ==");  print(hdr)
    rr = [t for t in touches if t["retest"] is not None]
    _row("retest≥1 (разрешено)", [t for t in rr if t["retest"] >= 1])
    _row("retest<1 (запрет)", [t for t in rr if 0 <= t["retest"] < 1])
    _row("retest<0 (без хода)", [t for t in rr if t["retest"] < 0])


def main():
    ap = argparse.ArgumentParser(description="Детектор каналов v2 (спека пользователя + гейты видео)")
    ap.add_argument("--cache", default=os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                                    "data", "candle_cache"))
    ap.add_argument("--tickers", default="")
    ap.add_argument("--all", action="store_true")
    ap.add_argument("--days", type=int, default=0)
    ap.add_argument("--struct-factor", type=int, default=STRUCT_FACTOR_DEFAULT)
    ap.add_argument("--out", default="")
    args = ap.parse_args()

    if args.tickers:
        paths = [os.path.join(args.cache, f"{t.strip()}.json") for t in args.tickers.split(",") if t.strip()]
    elif args.all:
        paths = sorted(p for p in glob.glob(os.path.join(args.cache, "*.json"))
                       if not p.endswith("_1m.json"))
    else:
        raise SystemExit("--tickers СПИСОК или --all")

    touches, n_tk = [], 0
    for p in paths:
        if not os.path.exists(p):
            print(f"нет файла: {p}")
            continue
        ticker = os.path.basename(p)[:-5]
        recs = _process(p, ticker, args.struct_factor, args.days)
        touches += recs
        n_tk += 1
        if args.tickers:
            print(f"{ticker}: касаний {len(recs)}")
    print(f"\nтикеров: {n_tk}, касаний: {len(touches)} (struct ×{args.struct_factor})")
    if not touches:
        raise SystemExit("касаний нет — проверь кэш/параметры")

    if args.out:
        import csv
        cols = list(touches[0].keys())
        with open(args.out, "w", newline="", encoding="utf-8") as fh:
            w = csv.DictWriter(fh, fieldnames=cols)
            w.writeheader()
            w.writerows(touches)
        print(f"CSV: {args.out}")
    _report(touches)


if __name__ == "__main__":
    main()
