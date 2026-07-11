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
import webbrowser
from datetime import datetime

import numpy as np

SWING_STEP = 2         # свинг подтверждается ±STEP дней
MAX_SPAN = 20          # анкер-экстремумы не дальше друг от друга (дней)
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

# Режим --fade: цель = ПРОТИВОПОЛОЖНАЯ граница канала, стоп = пробой входной
# границы на FADE_STOP ATR. MOM_LOOKBACK — фильтр «двигалась к границе до касания».
FADE_STOP_ATR = 0.5
MOM_LOOKBACK = 5
FADE_HORIZON = 40      # сколько дней ждать доход до противоположной границы


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


def _bounds(ch, x):
    """Верх и низ канала на баре x. Канал = две линии (могут быть с РАЗНЫМ наклоном
    у трендового билдера): ku/bu — верхняя, kl/bl — нижняя."""
    return ch["ku"] * x + ch["bu"], ch["kl"] * x + ch["bl"]


SLOPE_MAX_ATR = 0.28   # наклон границы круче X ATR/день — это не канал, а спайк-линия
WIDTH_MIN_ATR = 0.8    # уже — «нитка»/шум, не торговый коридор
WIDTH_MAX_ATR = 4.0    # шире — не коридор, а полнеба (одна граница улетает за экран)
PIERCE_TOL = 0.25      # линия анкера может протыкаться промежуточной ценой не глубже X ATR
BREAK_OUT_ATR = 0.50   # цена ушла за границу глубже X ATR → канал умер (перестаём рисовать)
FWD_SPAN_MULT = 0.75   # проекция вперёд не длиннее формирования*MULT — иначе луч в пустоту
TREND_FWD_MULT = 0.6   # трендовые линии тянем вперёд (в этом смысл канала), но не в пустоту
TREND_FWD_MAX_D = 14   # абсолютный потолок проекции вперёд (дней) — чтобы не улетало лучом
SLOPE_PAIR_TOL = 0.08  # верх и низ образуют канал, только если наклоны БЛИЗКИ (ATR/день)
CONTAIN_MIN = 0.72     # доля close между линиями в окне формирования — иначе не коридор
MIN_TOUCHES = 2        # цена должна ПОДХОДИТЬ к КАЖДОЙ границе ≥ этого числа раз (подтверждённый коридор)
TOUCH_TOL_ATR = 0.40   # «подход к границе» = экстремум ближе X ATR к линии


def _touch_events(arr, k, b, x0, x1, atr, tol=TOUCH_TOL_ATR):
    """Сколько РАЗ ряд (high для верха / low для низа) подходил к линии k*i+b ближе
    tol*ATR. Соседние бары-касания схлопываем в одно событие — это и есть «отскок
    от границы». Мало событий на границе → это не коридор, а случайная параллель."""
    ev, inside_prev = 0, False
    for i in range(x0, x1 + 1):
        a = atr[i]
        if not (np.isfinite(a) and a > 0):
            inside_prev = False
            continue
        near = abs(arr[i] - (k * i + b)) <= tol * a
        if near and not inside_prev:
            ev += 1
        inside_prev = near
    return ev


def _death_bar(ch, h, l, c, atr, n, mult=FWD_SPAN_MULT, cap=None):
    """Бар, где канал перестал существовать: цена вышла за границу глубже BREAK_OUT
    ИЛИ линии сошлись (верх ниже низа). Горизонт проекции вперёд — span*mult (не
    больше cap дней, если задан)."""
    fwd = max(step_min(), int(ch["span"] * mult))
    if cap is not None:
        fwd = min(fwd, cap)
    end = min(n - 1, ch["born"] + fwd)
    for x in range(ch["born"] + 1, end + 1):
        a = atr[x]
        if not (np.isfinite(a) and a > 0):
            continue
        upper, lower = _bounds(ch, x)
        if upper <= lower:                       # линии пересеклись — канал схлопнулся
            return x - 1
        if h[x] > upper + BREAK_OUT_ATR * a or l[x] < lower - BREAK_OUT_ATR * a:
            return x
    return end


def _build_channels(highs, lows, h, l, c, atr):
    """Параллельные каналы, ПРИВЯЗАННЫЕ к цене. Анкер по 2 хаям (верх)/2 лоям (низ);
    ключевое: линия анкера не должна протыкаться промежуточной ценой глубже
    PIERCE_TOL — иначе это не трендовая линия, а случайная палка через свечи.
    Параллель кладём на крайний противоположный экстремум окна (оба входят). Канал
    живёт от born до бара пробоя (_death_bar), а не вечным лучом."""
    n = len(h)
    out = []
    for anchor in ("high", "low"):
        pts = highs if anchor == "high" else lows
        pierce_arr = h if anchor == "high" else l   # что не должно протыкать линию анкера
        opp_arr = l if anchor == "high" else h       # куда кладём параллель
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
            # (1) линия анкера чистая: промежуточная цена не протыкает её глубже tol
            if anchor == "high":
                pierce = float(np.max(pierce_arr[a1[0]:a2[0] + 1] - base))   # хай над линией
            else:
                pierce = float(np.min(pierce_arr[a1[0]:a2[0] + 1] - base))   # лой под линией
                pierce = -pierce
            if pierce > PIERCE_TOL * a:                  # линия рвётся серединой — палка, не канал
                continue
            # (2) параллель на крайнем противоположном экстремуме окна
            if anchor == "high":
                off = float(np.min(opp_arr[a1[0]:a2[0] + 1] - base))
            else:
                off = float(np.max(opp_arr[a1[0]:a2[0] + 1] - base))
            w = abs(off) / a
            if w < WIDTH_MIN_ATR or w > WIDTH_MAX_ATR:  # слишком узко/широко
                continue
            # (3) ПОДТВЕРЖДЁННЫЙ коридор: цена подходила к ОБЕИМ границам ≥ MIN_TOUCHES
            if anchor == "high":
                nt_up = _touch_events(h, k, b, a1[0], a2[0], atr)
                nt_lo = _touch_events(l, k, b + off, a1[0], a2[0], atr)
            else:
                nt_lo = _touch_events(l, k, b, a1[0], a2[0], atr)
                nt_up = _touch_events(h, k, b + off, a1[0], a2[0], atr)
            if nt_up < MIN_TOUCHES or nt_lo < MIN_TOUCHES:
                continue
            ch = {"anchor": anchor, "born": born, "x0": a1[0], "span": span,
                  "ku": k, "bu": b + max(off, 0.0), "kl": k, "bl": b + min(off, 0.0)}
            ch["death"] = _death_bar(ch, h, l, c, atr, n)
            ch["life"] = ch["death"] - born
            if ch["life"] < step_min():                  # умер сразу — не жил
                continue
            out.append(ch)
    return _suppress_dupes(out)


def _extreme_lines(pts, arr, atr, n, is_high):
    """Линии по парам последовательных экстремумов (2 хая → линия / 2 лоя → линия).
    Линия должна ОГИБАТЬ экстремумы: промежуточные хаи не выше линии (для верха) /
    лои не ниже (для низа) глубже PIERCE_TOL — иначе это палка через свечи, не
    трендовая. Возвращает [(k, b, x0, born)]."""
    out = []
    for i in range(1, len(pts)):
        a1, a2 = pts[i - 1], pts[i]
        span = a2[0] - a1[0]
        if span > MAX_SPAN or span < step_min():
            continue
        ln = _line(a1, a2)
        if ln is None:
            continue
        k, b = ln
        born = a2[0]
        a = atr[born] if born < n and np.isfinite(atr[born]) and atr[born] > 0 else None
        if a is None or abs(k) > SLOPE_MAX_ATR * a:
            continue
        base = k * np.arange(a1[0], a2[0] + 1) + b
        seg = arr[a1[0]:a2[0] + 1] - base
        pierce = float(np.max(seg)) if is_high else -float(np.min(seg))
        if pierce > PIERCE_TOL * a:            # линия рвётся серединой — не трендовая
            continue
        out.append((k, b, a1[0], born))
    return out


def _build_trend_channels(highs, lows, h, l, c, atr):
    """Каналы по ДВУМ трендовым линиям: верх по 2 хаям, низ по 2 лоям. Пара образует
    канал, ТОЛЬКО если линии почти параллельны (наклоны близки), верх выше низа, и
    цена реально держится МЕЖДУ ними (>= CONTAIN_MIN). Иначе это не коридор, а две
    случайные палки — что и давало отрыв от реальности."""
    n = len(c)
    hl = _extreme_lines(highs, h, atr, n, True)
    ll = _extreme_lines(lows, l, atr, n, False)
    out = []
    for kh, bh, xh, bornh in hl:
        for kl, bl, xl, bornl in ll:
            born = max(bornh, bornl)
            x0 = max(xh, xl)          # с этого бара ОБЕ линии уже реальны — не экстраполируем назад
            if born - x0 < step_min() or born >= n:
                continue
            a = atr[born] if np.isfinite(atr[born]) and atr[born] > 0 else None
            if a is None:
                continue
            if abs(kh - kl) > SLOPE_PAIR_TOL * a:        # не параллельны — не канал
                continue
            up_b, lo_b = kh * born + bh, kl * born + bl
            w = (up_b - lo_b) / a
            if up_b <= lo_b or w < WIDTH_MIN_ATR or w > WIDTH_MAX_ATR:
                continue
            xs = np.arange(x0, born + 1)
            up_line, lo_line = kh * xs + bh, kl * xs + bl
            cc = c[x0:born + 1]
            inside = float(np.mean((cc >= lo_line - TOUCH_TOL_ATR * a)
                                   & (cc <= up_line + TOUCH_TOL_ATR * a)))
            if inside < CONTAIN_MIN:                     # цена не держится в коридоре
                continue
            ch = {"anchor": "trend", "born": born, "x0": x0, "span": max(born - x0, step_min()),
                  "ku": kh, "bu": bh, "kl": kl, "bl": bl}
            ch["death"] = _death_bar(ch, h, l, c, atr, n, mult=TREND_FWD_MULT, cap=TREND_FWD_MAX_D)
            ch["life"] = ch["death"] - born
            if ch["life"] < step_min():
                continue
            out.append(ch)
    return _suppress_dupes(out)


def _mid_at(ch, x):
    up, lo = _bounds(ch, x)
    return (up + lo) / 2.0


def _suppress_dupes(chans):
    """Глушим near-дубли: десятки почти одинаковых каналов внахлёст → спагетти.
    Оставляем дольше живущий; выкидываем канал, если он того же анкера, перекрыт
    по времени >70% и его средняя линия ближе 0.5 ширины к уже принятому. Разные
    по масштабу/наклону вложенные каналы остаются — их пользователь как раз хочет."""
    kept = []
    for ch in sorted(chans, key=lambda c: c["life"], reverse=True):
        s, e = ch["x0"], ch["death"]
        dup = False
        for k in kept:
            if k["anchor"] != ch["anchor"]:
                continue
            ov = min(e, k["death"]) - max(s, k["x0"])
            if ov <= 0:
                continue
            if ov < 0.5 * min(e - s, k["death"] - k["x0"]):
                continue
            xm = (max(s, k["x0"]) + min(e, k["death"])) // 2
            u1, l1 = _bounds(ch, xm); u2, l2 = _bounds(k, xm)
            wid = max(u1 - l1, u2 - l2)
            if abs(_mid_at(ch, xm) - _mid_at(k, xm)) < 0.8 * wid:
                dup = True; break
        if not dup:
            kept.append(ch)
    return kept


REG_WINDOWS = (10, 15, 21)   # окна регрессии (вложенность: несколько масштабов)
REG_PCTL = 90                # полосы по 90/10 перцентилю отклонения — одиночный
                             # выброс не раздувает канал («выброс не больше ещё ширины»)
REG_INSIDE_MIN = 0.80        # доля close внутри полос (перцентиль допускает края)
REG_STEP = 2                 # анкер регрессии через каждые STEP баров (меньше дублей)


def _build_reg_channels(h, l, c, atr):
    """Регрессионные каналы: линия наименьших квадратов по close в окне + две
    ПАРАЛЛЕЛЬНЫЕ полосы по перцентилю отклонения хай/лой. По построению обнимает
    цену, наклон = реальный тренд окна. Несколько окон дают вложенность. Форма
    записи та же (k,b,off,x0,born,span,death) — работают _scan/_death/_plot."""
    n = len(c)
    out = []
    for W in REG_WINDOWS:
        for i in range(W - 1 + ATR_PERIOD, n, REG_STEP):
            x0 = i - W + 1
            born = i
            a = atr[born]
            if not (np.isfinite(a) and a > 0):
                continue
            xs = np.arange(x0, i + 1)
            k, b0 = np.polyfit(xs, c[x0:i + 1], 1)
            if abs(k) > SLOPE_MAX_ATR * a:                 # трендовая нога, не коридор
                continue
            base = k * xs + b0
            up = h[x0:i + 1] - base
            dn = l[x0:i + 1] - base
            up_dev = float(np.percentile(up, REG_PCTL))
            dn_dev = float(np.percentile(dn, 100 - REG_PCTL))
            if up_dev <= 0 or dn_dev >= 0:                  # вырожденный
                continue
            off = up_dev - dn_dev
            w = off / a
            if w < WIDTH_MIN_ATR or w > WIDTH_MAX_ATR:
                continue
            lo_band = base + dn_dev
            up_band = base + up_dev
            cc = c[x0:i + 1]
            inside = float(np.mean((cc >= lo_band) & (cc <= up_band)))
            if inside < REG_INSIDE_MIN:                     # цена не держится в полосах
                continue
            # подтверждённый коридор: подходы к обеим полосам ≥ MIN_TOUCHES
            nt_lo = _touch_events(l, k, b0 + dn_dev, x0, i, atr)
            nt_up = _touch_events(h, k, b0 + up_dev, x0, i, atr)
            if nt_up < MIN_TOUCHES or nt_lo < MIN_TOUCHES:
                continue
            ch = {"anchor": "high" if k >= 0 else "low", "born": born, "x0": x0, "span": W,
                  "ku": float(k), "bu": float(b0 + up_dev), "kl": float(k), "bl": float(b0 + dn_dev)}
            ch["death"] = _death_bar(ch, h, l, c, atr, n)
            ch["life"] = ch["death"] - born
            if ch["life"] < step_min():
                continue
            out.append(ch)
    return _suppress_dupes(out)


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


def _fade_barriers(ch, entry, side, h, l, c, atr, i, end, target="far", use_stop=True):
    """Отскок от границы. target='far' — цель на ПРОТИВОПОЛОЖНОЙ границе (полный
    проход канала), 'mid' — на СРЕДНЕЙ линии (полширины). use_stop=False — без
    стопа (чистая проверка: доходит ли цель в принципе за жизнь канала). Стоп =
    пробой входной границы на FADE_STOP ATR. Интрабар first-passage, тай → стоп.
    P&L в ATR от цены входа. Возвращает (pnl, exit_bar, reached_target, exit_price)."""
    sgn = 1.0 if side == "support" else -1.0
    a0 = atr[i]
    if not (np.isfinite(a0) and a0 > 0):
        return 0.0, i, False, entry
    for j in range(i + 1, end + 1):
        aj = atr[j]
        if not (np.isfinite(aj) and aj > 0):
            continue
        upper, lower = _bounds(ch, j)
        mid = (upper + lower) / 2.0
        if side == "support":               # лонг от низа: цель выше, стоп под низом
            tp_price = mid if target == "mid" else upper
            sl_price = lower - FADE_STOP_ATR * aj
            hit_sl, hit_tp = (use_stop and l[j] <= sl_price), h[j] >= tp_price
        else:                                # шорт от верха: цель ниже, стоп над верхом
            tp_price = mid if target == "mid" else lower
            sl_price = upper + FADE_STOP_ATR * aj
            hit_sl, hit_tp = (use_stop and h[j] >= sl_price), l[j] <= tp_price
        if hit_sl:
            return sgn * (sl_price - entry) / a0, j, False, sl_price
        if hit_tp:
            return sgn * (tp_price - entry) / a0, j, True, tp_price
    return sgn * (c[end] - entry) / a0, end, False, c[end]   # таймаут — по закрытию


def _scan(ch, h, l, c, atr, ds, ticker, breakout=False, fade=False, mom=MOM_LOOKBACK,
          target="far", use_stop=True):
    """Скан касаний обеих параллельных границ. Причинно: старт с born+STEP.
    breakout=True — торгуем ПРОБОЙ по тренду (вход на закрытии за границей на
    BREAK_ATR, тейк в сторону пробоя), а не отскок. Раз рынок ломает каналы чаще
    (break 52.6% > bounce 44.3%) — проверяем обратную ставку."""
    n = len(c)
    start = ch["born"] + SWING_STEP
    end0 = min(n - 1, ch.get("death", ch["born"] + ch["life"]))
    if start >= end0:
        return []
    touches = []
    # две границы на баре x берём из _bounds (у трендового билдера наклоны разные).
    # Касание верха → resistance (шорт), низа → support (лонг).
    for which in ("upper", "lower"):
        armed, i = True, start
        while i <= end0:
            a = atr[i]
            if not (np.isfinite(a) and a > 0):
                i += 1; continue
            up_i, lo_i = _bounds(ch, i)
            lvl_now = up_i if which == "upper" else lo_i
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
            if breakout:
                # ждём ПРОБОЙ границы (away ≤ −BREAK): вход по тренду пробоя, sgn_b=−sgn.
                # если раньше отскочило (away ≥ BOUNCE) — пробоя нет, сделки нет.
                while j <= end:
                    aj = atr[j]
                    if not (np.isfinite(aj) and aj > 0):
                        j += 1; continue
                    away = sgn * (c[j] - lvl) / aj
                    if away <= -BREAK_ATR:
                        entry_bar = j; res = "break"; break
                    if away >= BOUNCE_ATR:
                        res = "bounce"; break
                    if j >= end:
                        res = "stall"; break
                    j += 1
                rec = {"ticker": ticker, "anchor": ch["anchor"], "which": which, "side": side,
                       "result": res or "stall", "date": ds[i], "confirmed": res == "break",
                       "bar": i, "lvl": lvl}
                if res == "break" and entry_bar > 0:
                    sgn_b = -sgn   # продолжение пробоя: support-пробой → шорт, resist-пробой → лонг
                    rec["grid"] = _barriers(c[entry_bar], sgn_b, atr[entry_bar], h, l, c, entry_bar, end, CAP_BARS)
                    rec["entry_bar"] = entry_bar
                touches.append(rec)
                armed, i = False, (entry_bar if entry_bar > 0 else j) + 1
                continue
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
                if fade:
                    # фильтр «двигалась к границе до касания»: вверх — если это верх
                    # (resistance), вниз — если низ (support). mom<=0 отключает фильтр.
                    prev = c[max(0, i - mom)]
                    mom_ok = (mom <= 0) or (c[i] > prev if side == "resistance" else c[i] < prev)
                    if mom_ok:
                        fend = min(n - 1, ch.get("death", i + FADE_HORIZON), entry_bar + FADE_HORIZON)
                        p, exb, reached, xpx = _fade_barriers(ch, c[entry_bar], side, h, l, c, atr,
                                                              entry_bar, fend, target=target, use_stop=use_stop)
                        rec["fade"] = (p, exb, reached)
                        rec["entry_bar"] = entry_bar
                        rec["entry_price"] = c[entry_bar]
                        rec["exit_bar"] = exb
                        rec["exit_price"] = xpx
                        rec["pnl"] = p
                else:
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


def _fade_portfolio(rows, cost, label, quiet=False, rlab="против"):
    """No-overlap по entry_bar. Возвращает (n, exp, win%, reach%) — reach% = доля,
    где отскок реально дошёл до цели (противоположной границы или середины)."""
    by_tk = {}
    for r in rows:
        if "fade" in r:
            by_tk.setdefault(r["ticker"], []).append(r)
    n, pnl, wins, reach = 0, 0.0, 0, 0
    for rs in by_tk.values():
        rs.sort(key=lambda r: r["entry_bar"])
        free = -1
        for r in rs:
            if r["entry_bar"] <= free:
                continue
            p, exb, reached = r["fade"]
            net = p - cost
            pnl += net
            wins += 1 if net > 0 else 0
            reach += 1 if reached else 0
            free = exb
            n += 1
    exp = pnl / n if n else 0.0
    wr = 100 * wins / n if n else 0.0
    rr = 100 * reach / n if n else 0.0
    if not quiet:
        print(f"{label:<28} N={n:<5} exp={exp:+.3f}  Σ={pnl:+.1f} ATR  win={wr:.0f}%  дошло-до-{rlab}={rr:.0f}%")
    return n, exp, wr, rr


def _fade_report(allt, args):
    fr = [r for r in allt if "fade" in r]
    rlab = "середины" if args.fade_target == "mid" else "против"
    tgt = "СРЕДНЕЙ ЛИНИИ (полширины)" if args.fade_target == "mid" else "ПРОТИВОПОЛОЖНОЙ границы"
    stp = "без стопа (чистый проход)" if args.no_stop else f"стоп = пробой входной границы на {FADE_STOP_ATR} ATR"
    print(f"\n{'='*74}\nFADE: отскок от границы → {tgt} (mom={args.mom_lookback})")
    print(f"канал={args.channel}, подтв.касаний≥{args.min_touches}; {stp}; {len(fr)} входов\n{'='*74}")
    if not fr:
        print("нет входов — проверь кэш/период (или ослабь фильтр --mom-lookback 0)")
        return
    _fade_portfolio(fr, args.cost_atr, "ВСЁ", rlab=rlab)
    for sd in ("support", "resistance"):
        _fade_portfolio([r for r in fr if r["side"] == sd], args.cost_atr,
                        f"  {'низ→верх (лонг)' if sd == 'support' else 'верх→низ (шорт)'}", rlab=rlab)
    print("-- запас прочности по издержкам --")
    for cst in (0.08, 0.12, 0.16, 0.20):
        _fade_portfolio(fr, cst, f"cost={cst}", rlab=rlab)
    tr = [r for r in fr if r["date"] < args.split_date]
    te = [r for r in fr if r["date"] >= args.split_date]
    print(f"-- held-out: train ({len(tr)}) | test≥{args.split_date} ({len(te)}) --")
    if tr and te:
        _fade_portfolio(tr, args.cost_atr, "TRAIN", rlab=rlab)
        _fade_portfolio(te, args.cost_atr, "TEST (held-out)", rlab=rlab)
    # ранжир по тикерам (по held-out test exp)
    by = {}
    for r in fr:
        by.setdefault(r["ticker"], []).append(r)
    rk = []
    for tk, rs in by.items():
        te2 = [r for r in rs if r["date"] >= args.split_date]
        n, exp, wr, rr = _fade_portfolio(rs, args.cost_atr, tk, quiet=True)
        tn, texp, twr, trr = _fade_portfolio(te2, args.cost_atr, tk, quiet=True) if te2 else (0, 0.0, 0.0, 0.0)
        if n:
            rk.append((tk, n, exp, wr, rr, tn, texp))
    rk.sort(key=lambda x: (x[6], x[2]), reverse=True)
    print(f"\n-- ранжир по тикерам (топ-30 из {len(rk)}, по held-out test exp) --")
    print(f"{'тикер':<10}{'N':>5}{'exp':>8}{'win%':>6}{'reach%':>8}  |{'testN':>6}{'test_exp':>10}")
    for tk, n, exp, wr, rr, tn, texp in rk[:30]:
        print(f"{tk:<10}{n:>5}{exp:>+8.3f}{wr:>5.0f}%{rr:>7.0f}%  |{tn:>6}{texp:>+10.3f}")


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
    parts = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" '
             f'width="100%" style="max-width:100%;height:auto;background:#0d1117;font-family:monospace">']
    fades = [t for t in touches if "fade" in t]
    if fades:
        legend = ("fade-сделки: ▲=лонг(низ→верх) ▼=шорт(верх→низ); линия вход→выход "
                  "зелёная=дошёл до цели, красная=не дошёл. Наведи на маркер — детали.")
    else:
        legend = "Зелёный=отскок, красный=пробой"
    parts.append(f'<text x="{m}" y="30" fill="#c9d1d9" font-size="16">{ticker} — дневки, '
                 f'каналы алго (последние {days}д). {legend}</text>')
    # цена
    pts = " ".join(f"{X(i):.1f},{Y(p):.1f}" for i, p in seg)
    parts.append(f'<polyline points="{pts}" fill="none" stroke="#58a6ff" stroke-width="1.5"/>')
    # каналы в окне
    for ch in channels:
        s = ch.get("x0", ch["born"]); e = min(n - 1, ch.get("death", ch["born"] + ch["life"]))
        if e < i0 or s > i1:
            continue
        s = max(s, i0); e = min(e, i1)
        bnd = [_bounds(ch, i) for i in range(s, e + 1)]
        up = " ".join(f"{X(s+j):.1f},{Y(u):.1f}" for j, (u, _) in enumerate(bnd))
        lo = " ".join(f"{X(s+j):.1f},{Y(d):.1f}" for j, (_, d) in enumerate(bnd))
        parts.append(f'<polyline points="{up}" fill="none" stroke="#d29922" stroke-width="1.4" opacity="0.8"/>')
        parts.append(f'<polyline points="{lo}" fill="none" stroke="#a371f7" stroke-width="1.4" opacity="0.8"/>')
    if fades:
        # каждая fade-сделка: маркер входа (направление) + линия вход→выход (цвет=дошёл ли до цели)
        for t in fades:
            eb = t["entry_bar"]
            if not (i0 <= eb <= i1):
                continue
            ep, xb, xp = t["entry_price"], min(t["exit_bar"], i1), t["exit_price"]
            reached = t["fade"][2]
            seg_col = "#3fb950" if reached else "#f85149"
            parts.append(f'<line x1="{X(eb):.1f}" y1="{Y(ep):.1f}" x2="{X(xb):.1f}" y2="{Y(xp):.1f}" '
                         f'stroke="{seg_col}" stroke-width="1.3" opacity="0.85"/>')
            is_long = t["side"] == "support"
            ecol = "#58a6ff" if is_long else "#d29922"
            cx, cy = X(eb), Y(ep)
            tri = (f"{cx:.1f},{cy-8:.1f} {cx-5:.1f},{cy+4:.1f} {cx+5:.1f},{cy+4:.1f}" if is_long
                   else f"{cx:.1f},{cy+8:.1f} {cx-5:.1f},{cy-4:.1f} {cx+5:.1f},{cy-4:.1f}")
            tt = (f'{t["date"]} {"LONG низ→верх" if is_long else "SHORT верх→низ"} '
                  f'pnl={t["pnl"]:+.2f}ATR {"ДОШЁЛ до цели" if reached else "НЕ дошёл"}')
            parts.append(f'<polygon points="{tri}" fill="{ecol}"><title>{tt}</title></polygon>')
            parts.append(f'<circle cx="{X(xb):.1f}" cy="{Y(xp):.1f}" r="3" fill="{seg_col}"/>')
    else:
        cmap = {"bounce": "#3fb950", "break": "#f85149", "stall": "#8b949e"}
        for t in touches:
            if not (i0 <= t["bar"] <= i1):
                continue
            parts.append(f'<circle cx="{X(t["bar"]):.1f}" cy="{Y(t["lvl"]):.1f}" r="3" '
                         f'fill="{cmap.get(t["result"], "#8b949e")}"/>')
    parts.append("</svg>")
    with open(out, "w", encoding="utf-8") as fh:
        fh.write("<!doctype html><meta charset=utf-8><body style='margin:0'>" + "".join(parts))
    full = os.path.abspath(out)
    tail = f" ({len(fades)} fade-сделок в окне)" if fades else ""
    print(f"\n>>> ОТКРОЙ: {full}{tail}")
    try:                       # сразу открыть в браузере по умолчанию
        webbrowser.open("file:///" + full.replace("\\", "/"))
    except Exception:
        pass


def _channels_for(h, l, c, atr, args):
    """Выбор билдера по --channel/--reg."""
    if args.channel == "trend":
        highs, lows = _swings(h, l, SWING_STEP)
        return _build_trend_channels(highs, lows, h, l, c, atr)
    if args.reg:
        return _build_reg_channels(h, l, c, atr)
    highs, lows = _swings(h, l, SWING_STEP)
    return _build_channels(highs, lows, h, l, c, atr)


def main():
    global MAX_SPAN, SLOPE_MAX_ATR, MIN_TOUCHES
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
    ap.add_argument("--reg", action="store_true",
                    help="регрессионные каналы (МНК + перцентильные полосы) вместо свинг-анкеров")
    ap.add_argument("--breakout", action="store_true",
                    help="торговать ПРОБОЙ канала по тренду, а не отскок")
    ap.add_argument("--fade", action="store_true",
                    help="отскок от границы с целью на ПРОТИВОПОЛОЖНОЙ границе (гипотеза юзера)")
    ap.add_argument("--mom-lookback", type=int, default=MOM_LOOKBACK,
                    help="фильтр 'двигалась к границе' за N дней (0 = выключить)")
    ap.add_argument("--fade-target", choices=("far", "mid"), default="far",
                    help="цель отскока: far=противоположная граница, mid=средняя линия")
    ap.add_argument("--no-stop", action="store_true",
                    help="без стопа — чистая проверка, доходит ли цель за жизнь канала")
    ap.add_argument("--channel", choices=("flat", "gentle", "any", "trend"), default="trend",
                    help="flat/gentle/any=параллельные (порог наклона); "
                         "trend=две независимые трендовые линии (2 хая + 2 лоя), зазор=канал")
    ap.add_argument("--min-touches", type=int, default=MIN_TOUCHES,
                    help="цена должна подходить к КАЖДОЙ границе >= N раз (подтверждённый коридор)")
    args = ap.parse_args()
    MAX_SPAN = args.max_span
    SLOPE_MAX_ATR = {"flat": 0.06, "gentle": 0.15, "any": 0.30, "trend": 0.60}[args.channel]
    MIN_TOUCHES = args.min_touches

    if args.plot:
        p = os.path.join(args.cache, f"{args.plot}.json")
        data = _daily(p)
        if data is None:
            raise SystemExit(f"нет данных: {p}")
        o, h, l, c, ds = data
        atr = _atr(h, l, c, ATR_PERIOD)
        chs = _channels_for(h, l, c, atr, args)
        tch = []
        for ch in chs:
            tch += _scan(ch, h, l, c, atr, ds, args.plot, breakout=args.breakout,
                         fade=args.fade, mom=args.mom_lookback,
                         target=args.fade_target, use_stop=not args.no_stop)
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
        tk = os.path.basename(p)[:-5]
        built = _channels_for(h, l, c, atr, args)
        for ch in built:
            allt += _scan(ch, h, l, c, atr, ds, tk, breakout=args.breakout,
                          fade=args.fade, mom=args.mom_lookback,
                          target=args.fade_target, use_stop=not args.no_stop)
        if args.tickers:
            print(f"{tk}: дней {len(c)}, касаний {sum(1 for t in allt if t['ticker']==tk)}")

    if not allt:
        raise SystemExit("касаний нет — мало дневных баров? нужен кэш с историей")

    if args.fade:
        _fade_report(allt, args)
        return

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
