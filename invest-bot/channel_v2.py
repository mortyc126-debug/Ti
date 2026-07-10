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

# Гонтлет: тейк/стоп-сетка (в ATR), барьеры от ЦЕНЫ ВХОДА, интрабар first-passage.
GT_TAKES = (0.5, 0.7, 1.0)
GT_STOPS = (0.3, 0.5)
GT_PORT = (1.0, 0.5)          # комбо для no-overlap портфеля


def _load(path):
    rows = json.load(open(path, encoding="utf-8"))
    if not rows:
        return None
    rows.sort(key=lambda r: r["time"])
    return (np.array([r["open"] for r in rows], float),
            np.array([r["high"] for r in rows], float),
            np.array([r["low"] for r in rows], float),
            np.array([r["close"] for r in rows], float),
            [str(r["time"]) for r in rows])


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


def _barriers(entry, sgn, a, h5, l5, c5, i, end5, cap):
    """Тейк/стоп-сетка для сделки-отскока, барьеры от ЦЕНЫ ВХОДА c5[i] (не от
    уровня — иначе pnl завышен), интрабар first-passage по high/low. sgn: +1 лонг
    (нижняя граница), -1 шорт (верхняя). Возвращает {(take,stop):(pnl_atr, exit_bar)}.
    Тай в одном баре (задело и тейк, и стоп) — консервативно считаем стоп первым."""
    last = min(end5, i + cap)
    grid = {}
    for take in GT_TAKES:
        for stop in GT_STOPS:
            pnl, exb = None, last
            for j in range(i + 1, last + 1):
                fav = sgn * ((h5[j] if sgn > 0 else l5[j]) - entry) / a
                adv = sgn * ((l5[j] if sgn > 0 else h5[j]) - entry) / a
                if adv <= -stop:            # стоп имеет приоритет при тае
                    pnl, exb = -stop, j
                    break
                if fav >= take:
                    pnl, exb = take, j
                    break
            if pnl is None:                 # ни тейк, ни стоп — закрытие по close
                pnl = sgn * (c5[last] - entry) / a
            grid[(take, stop)] = (pnl, exb)
    return grid


def _scan(ch, h5, l5, c5, atr5, f, ticker, times, confirm_lag):
    """Скан касаний обеих границ на 5м. Линия старшего ТФ в точке 5м-бара i:
    x = i/f (позиция в индексе старшего ТФ). Исход — по замороженному уровню.
    confirm_lag: канал ПОДТВЕРЖДЁН только через lag баров старшего ТФ после born
    (пивоты в _swings видны с задержкой ±step) — до этого касания задним числом,
    в реале канал построить нельзя. Скан стартует с (born+lag)*f. Это закрывает
    look-ahead: без сдвига первые касания залезают в неподтверждённое окно."""
    n5 = len(c5)
    start5 = int((ch["born"] + confirm_lag) * f)
    end5 = min(n5 - 1, int(ch["born"] * f) + CAP_STRUCT_BARS * f)
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
                # для гонтлета: интрабар тейк/стоп от цены входа + время/бар входа
                "grid": _barriers(c5[i], sgn, a, h5, l5, c5, i, end5, RESOLVE_CAP_5M),
                "entry_bar": i, "date": times[i][:10] if i < len(times) else "",
            })
            tb += 1
            prev_out = res
            armed = False
            i = j + 1
    return touches


def _process(path, ticker, f, days, confirm_lag=SWING_STEP_DEFAULT):
    data = _load(path)
    if data is None:
        return []
    o, h, l, c, times = data
    if days:
        cut = days * 100
        o, h, l, c, times = o[-cut:], h[-cut:], l[-cut:], c[-cut:], times[-cut:]
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
        touches += _scan(ch, h, l, c, atr5, f, ticker, times, confirm_lag)
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


def _gt_grid(rows, cost, title):
    """Экспектанси тейк/стоп-сетки (avg pnl−cost, ATR) + win%. Барьеры интрабар."""
    print(f"\n-- {title}: сетка тейк/стоп (N={len(rows)}, cost={cost}) --")
    print(f"{'take/stop':<12}" + "".join(f"{s:>10}" for s in GT_STOPS))
    if not rows:
        print("  пусто")
        return
    for take in GT_TAKES:
        cells = []
        for stop in GT_STOPS:
            pnls = [r["grid"][(take, stop)][0] - cost for r in rows]
            exp = sum(pnls) / len(pnls)
            wr = 100 * sum(1 for p in pnls if p > 0) / len(pnls)
            cells.append(f"{exp:+.3f}/{wr:.0f}%")
        print(f"take{take:<8}" + "".join(f"{c:>10}" for c in cells))


def _gt_portfolio(rows, cost, title):
    """No-overlap: одна позиция на инструмент за раз (по entry/exit-бару), комбо
    GT_PORT. Так эпизоды одного канала не считаются как N независимых сделок."""
    take, stop = GT_PORT
    by_tk = {}
    for r in rows:
        by_tk.setdefault(r["ticker"], []).append(r)
    trades, pnl_sum = 0, 0.0
    for tk, rs in by_tk.items():
        rs.sort(key=lambda r: r["entry_bar"])
        free_at = -1
        for r in rs:
            if r["entry_bar"] <= free_at:
                continue
            pnl, exb = r["grid"][(take, stop)]
            pnl_sum += pnl - cost
            free_at = exb
            trades += 1
    if not trades:
        print(f"{title:<30} нет сделок")
        return
    print(f"{title:<30} N={trades:<5} exp={pnl_sum/trades:+.3f}  Σ={pnl_sum:+.1f} ATR "
          f"(тейк{take}/стоп{stop})")


def _gauntlet(touches, cost, split_date):
    """Гонтлет для first-touch сигнала: интрабар тейк/стоп + no-overlap + held-out.
    Тот же критерий, что провалидировал уровневый сигнал — если first-touch реален,
    экспектанси >0 на обеих половинах времени и после схлопывания перекрытий."""
    first = [t for t in touches if t["touches_before"] == 0]
    first_norm = [t for t in first if t["w_bucket"] == "норм1.5-4"]
    print(f"\n{'='*70}\nГОНТЛЕТ first-touch: {len(first)} касаний "
          f"(из них норм-ширина {len(first_norm)})\n{'='*70}")
    _gt_grid(first, cost, "first-touch, все ширины")
    _gt_grid(first_norm, cost, "first-touch, ширина=норм")
    print("\n-- No-overlap портфель (одна позиция/инструмент) --")
    _gt_portfolio(first, cost, "first-touch все")
    _gt_portfolio(first_norm, cost, "first-touch норм")
    # held-out по времени — и на всех, и на норм-ширине (где эдж жирнее): вопрос,
    # держится ли норм-фильтр out-of-sample или это подгонка на train.
    def _split(rows, label):
        tr = [t for t in rows if t["date"] and t["date"] < split_date]
        te = [t for t in rows if t["date"] and t["date"] >= split_date]
        print(f"\n-- HELD-OUT {label}: train<{split_date} ({len(tr)}) | test≥ ({len(te)}) --")
        if tr and te:
            _gt_portfolio(tr, cost, f"TRAIN {label}")
            _gt_portfolio(te, cost, f"TEST  {label}")
        else:
            print("одна из половин пуста — сдвинь --split-date")
    _split(first, "все ширины")
    _split(first_norm, "ширина=норм")
    # коллинеарность first-touch ↔ retest<1: пересечение популяций
    ft = {(t["ticker"], t["entry_bar"]) for t in first}
    r1 = {(t["ticker"], t["entry_bar"]) for t in touches
          if t["retest"] is not None and 0 <= t["retest"] < 1}
    if r1:
        inter = len(ft & r1)
        print(f"\n-- Коллинеарность: retest<1 популяция {len(r1)}, из них first-touch "
              f"{inter} ({100*inter/len(r1):.0f}%) → {'дубль сигнала' if inter/len(r1)>0.6 else 'частично независим'}")


def main():
    ap = argparse.ArgumentParser(description="Детектор каналов v2 (спека пользователя + гейты видео)")
    ap.add_argument("--cache", default=os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                                    "data", "candle_cache"))
    ap.add_argument("--tickers", default="")
    ap.add_argument("--all", action="store_true")
    ap.add_argument("--days", type=int, default=0)
    ap.add_argument("--struct-factor", type=int, default=STRUCT_FACTOR_DEFAULT)
    ap.add_argument("--out", default="")
    ap.add_argument("--gauntlet", action="store_true",
                    help="прогнать first-touch через интрабар тейк/стоп + no-overlap + held-out")
    ap.add_argument("--cost-atr", type=float, default=0.12, help="издержки на сделку в ATR")
    ap.add_argument("--split-date", default="2026-06-01", help="граница train/test для held-out")
    ap.add_argument("--confirm-lag", type=int, default=SWING_STEP_DEFAULT,
                    help="лаг подтверждения канала в барах старшего ТФ (0=утёкшая версия для A/B)")
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
        recs = _process(p, ticker, args.struct_factor, args.days, args.confirm_lag)
        touches += recs
        n_tk += 1
        if args.tickers:
            print(f"{ticker}: касаний {len(recs)}")
    print(f"\nтикеров: {n_tk}, касаний: {len(touches)} (struct ×{args.struct_factor})")
    if not touches:
        raise SystemExit("касаний нет — проверь кэш/параметры")

    if args.out:
        import csv
        cols = [k for k in touches[0].keys() if k != "grid"]   # grid — вложенный dict, не в CSV
        with open(args.out, "w", newline="", encoding="utf-8") as fh:
            w = csv.DictWriter(fh, fieldnames=cols, extrasaction="ignore")
            w.writeheader()
            w.writerows(touches)
        print(f"CSV: {args.out}")
    _report(touches)
    if args.gauntlet:
        _gauntlet(touches, args.cost_atr, args.split_date)


if __name__ == "__main__":
    main()
