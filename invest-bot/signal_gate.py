"""
signal_gate.py — гейт качества сигнала по эмпирической точности КОНКРЕТНОГО
триггера на КОНКРЕТНОМ тикере. Порт labSignalScreener/computeIndicator из
oi_lab.html (не путать с oi-signal-v10.html, который уже портирован в
oi_layers.py/tradestats.py — это другой, более новый инструмент).

Отличие от остальных 29 методов OICompositeStrategy: там взвешенный
composite-скор, здесь — жёсткий гейт "не входить", основанный не на текущем
значении индикатора, а на том, СКОЛЬКО РАЗ этот же триггер УЖЕ срабатывал на
ЭТОМ тикере и как часто оказывался прав.

Три триггера ("подтверждённые на чистых данных" — комментарий из oi_lab.html,
роллы фьючерса исключены из статистики) — по формулировке автора все три
шортовые, для лонга гейт молчит:
  - trendDown — тренд-истощение вниз (цена росла N баров, лонг физлиц у
    исторического экстремума) → ждём коррекцию, шорт
  - exh       — истощение после выброса вверх (пробой диапазона накопления
    ПО позиции физлиц, не против неё) → шорт
  - longAggr  — лонг физлиц набирался агрессивно (давление у нижнего края
    перцентильного ранга) → шорт

Четвёртый ("сетап+истощение") в oi_lab.html помечен НЕ подтверждённым после
чистки данных (EV −3.3) и оставлен только для наблюдения — сюда сознательно
не включён, гейт по нему никогда не блокирует.

Данные — то же дневное окно data/oi_daily.json, которое уже собирает
oi_layers.py (физ/юр контракты по FutOI), новых сетевых запросов не нужно.
Пересчёт (recalibrate) — раз в торговый день, не на каждый тик.

ВАЖНО про урезание порта: в computeIndicator из oi_lab.html помимо полей,
которые реально используются тремя триггерами выше, считаются ещё force/
conviction/velocity_decel/liquidity_conf/weighted_imbalance — они не влияют
ни на trend_exhaust, ни на breakout_dir/phase_aligned, ни на
squeeze_pressure_rank (проверено по исходнику: обе ветки imbalanceScore и
accum_flag читают только imbalance_z/net_phys_pct/squeeze_pressure). Здесь
их сознательно не считаем — это не приближение формул, а честный пропуск
мёртвого для гейта кода. Если понадобится (напр. для отчётности в Telegram),
дорасчёт добавляется рядом, ничего не переписывая.
"""
from __future__ import annotations

import json
import logging
import math
import os
import statistics
from dataclasses import dataclass, field

logger = logging.getLogger(__name__)

__all__ = ("SignalGate", "compute_indicator", "DEFAULT_CFG", "oi_regime_instability")

GATE_FILE = "data/signal_gate.json"
OI_HISTORY_FILE = "data/oi_daily.json"  # тот же файл, что читает/пишет oi_layers.py

MIN_N = 8              # своя история тикера, ниже которой доверять нельзя (как в oi_lab)
ACC_THRESHOLD = 60.0    # порог точности "торгуемое" на 3-дневном горизонте, %
HORIZONS = (1, 3)
MIN_ROWS_FOR_CALC = 20  # меньше — percentile-ранги ещё не набрали смысла

DEFAULT_CFG = {
    "z_window": 60,
    "accum_window": 10,
    "liquidity_window": 60,
    "range_window": 15,
    "range_percentile": 0.40,
    "phase_confirm_bars": 1,
    "phase_range_ttl": 20,
    "use_adaptive_confirm": True,
    "atr_window": 14,
    "atr_percentile_window": 60,
    "n_volatility_buckets": 5,
    "adaptive_confirm_quantile": 0.5,
    "min_phase_samples_per_bucket": 2,
    "adaptive_confirm_floor": 1,
    "trend_exhaust_window": 5,
    "trend_exhaust_move_pctl_short": 0.78,
    "trend_exhaust_move_pctl_long": 0.86,
    "trend_exhaust_pctl_short": 0.9,
    "trend_exhaust_pctl_long": 0.9,
    "spike_setup_dd_window": 20,
    "spike_setup_dd_pctl": 0.8,
    "spike_setup_flow_max": 0.35,
}


# ========== rolling-хелперы (порт _rollingMean/_rollingStd/_rollingQuantile/_percentileRank) ==========

def _fin(v) -> bool:
    return v is not None and math.isfinite(v)


def _rolling_mean(arr: list[float], w: int) -> list[float]:
    n = len(arr)
    out = [math.nan] * n
    s, cnt = 0.0, 0
    for i in range(n):
        v = arr[i]
        if _fin(v):
            s += v
            cnt += 1
        if i >= w:
            old = arr[i - w]
            if _fin(old):
                s -= old
                cnt -= 1
        if cnt >= max(1, w // 2):
            out[i] = s / cnt
    return out


def _rolling_std(arr: list[float], w: int) -> list[float]:
    n = len(arr)
    out = [math.nan] * n
    for i in range(w - 1, n):
        s = s2 = 0.0
        cnt = 0
        for j in range(i - w + 1, i + 1):
            v = arr[j]
            if _fin(v):
                s += v
                s2 += v * v
                cnt += 1
        if cnt >= max(1, w // 2):
            mean = s / cnt
            out[i] = math.sqrt(max(0.0, s2 / cnt - mean * mean))
    return out


def _rolling_quantile(arr: list[float], w: int, q: float) -> list[float]:
    n = len(arr)
    out = [math.nan] * n
    for i in range(w - 1, n):
        win = sorted(v for v in arr[i - w + 1:i + 1] if _fin(v))
        if win:
            idx = min(len(win) - 1, int(len(win) * q))
            out[i] = win[idx]
    return out


def _percentile_rank(arr: list[float], w: int) -> list[float]:
    """Причинный (без заглядывания вперёд) перцентильный ранг — окно строго назад."""
    n = len(arr)
    out = [math.nan] * n
    min_per = max(20, w // 10)
    for i in range(n):
        start = max(0, i - w + 1)
        win = [v for v in arr[start:i + 1] if _fin(v)]
        if len(win) < min_per:
            continue
        cur = arr[i]
        # cur может быть NaN — тогда `v <= cur` всегда False (как в JS), ранг = 0,
        # это не баг, а точное повторение поведения оригинала.
        out[i] = sum(1 for v in win if v <= cur) / len(win)
    return out


def _apply_phase_hysteresis(raw: list[bool], confirm_bars) -> list[bool]:
    n = len(raw)
    is_arr = isinstance(confirm_bars, list)
    out = [False] * n
    state = False
    true_run = false_run = 0
    for i in range(n):
        cb = max(1, (confirm_bars[i] or 1) if is_arr else confirm_bars)
        if raw[i]:
            true_run += 1
            false_run = 0
        else:
            false_run += 1
            true_run = 0
        if not state and true_run >= cb:
            state = True
        elif state and false_run >= cb:
            state = False
        out[i] = state
    return out


def _compute_atr_proxy(close: list[float], window: int) -> list[float]:
    """Без H/L в data/oi_daily.json всегда идём по close-only веткой (как в oi_lab
    для инструментов без свечей — тот же fallback, не отдельная формула)."""
    n = len(close)
    tr = [math.nan] * n
    for i in range(n):
        prev_c = close[i - 1] if i > 0 else close[i]
        tr[i] = abs(close[i] - prev_c)
    out = [math.nan] * n
    for i in range(window - 1, n):
        s = sum(tr[j] for j in range(i - window + 1, i + 1) if _fin(tr[j]))
        out[i] = s / window
    return out


def _extract_raw_phase_durations(raw_flag: list[bool]) -> list[dict]:
    phases = []
    in_phase = False
    start = dur = 0
    for i, v in enumerate(raw_flag):
        if v and not in_phase:
            in_phase, start, dur = True, i, 1
        elif v and in_phase:
            dur += 1
        elif not v and in_phase:
            phases.append({"start_pos": start, "duration": dur})
            in_phase = False
    if in_phase:
        phases.append({"start_pos": start, "duration": dur})
    return phases


def _calibrate_confirm_bars_by_volatility(raw_flag, atr_pctl, cfg) -> dict | None:
    phases = _extract_raw_phase_durations(raw_flag)
    if not phases:
        return None
    valid = [p for p in phases if p["start_pos"] < len(atr_pctl) and _fin(atr_pctl[p["start_pos"]])]
    if not valid:
        return None
    nb = cfg["n_volatility_buckets"]
    buckets = [[] for _ in range(nb)]
    for p in valid:
        b = min(nb - 1, int(atr_pctl[p["start_pos"]] * nb))
        buckets[b].append(p["duration"])
    bucket_confirm = {}
    for b in range(nb):
        durs = sorted(buckets[b])
        if len(durs) >= cfg["min_phase_samples_per_bucket"]:
            q = durs[int(len(durs) * cfg["adaptive_confirm_quantile"])]
            bucket_confirm[b] = max(cfg["adaptive_confirm_floor"], math.ceil(q))
        else:
            bucket_confirm[b] = cfg["phase_confirm_bars"]
    return {"bucket_confirm": bucket_confirm}


def _map_confirm_bars(atr_pctl, calibration, cfg) -> list[int]:
    bucket_confirm = calibration["bucket_confirm"]
    nb = cfg["n_volatility_buckets"]
    out = []
    for v in atr_pctl:
        if not _fin(v):
            out.append(cfg["phase_confirm_bars"])
            continue
        b = min(nb - 1, int(v * nb))
        out.append(bucket_confirm.get(b, cfg["phase_confirm_bars"]))
    return out


def _median(arr: list[float]) -> float:
    s = sorted(v for v in arr if _fin(v))
    if not s:
        return math.nan
    return statistics.median(s)


# ========== основной пайплайн (порт computeIndicator, урезанный до полей гейта) ==========

def compute_indicator(rows: list[dict], cfg: dict = None) -> list[dict]:
    """
    rows — по возрастанию даты: {date, close, phys_long_contracts,
    phys_short_contracts, legal_long_contracts, legal_short_contracts, ref_switch}.
    Возвращает список тех же по длине словарей с добавленными полями:
    accum_flag, breakout_dir, phase_aligned, trend_exhaust,
    squeeze_pressure_rank, spike_setup.
    """
    cfg = {**DEFAULT_CFG, **(cfg or {})}
    n = len(rows)
    close = [float(r.get("close") or 0) for r in rows]
    phys_l = [float(r.get("phys_long_contracts") or 0) for r in rows]
    phys_s = [float(r.get("phys_short_contracts") or 0) for r in rows]
    legal_l = [float(r.get("legal_long_contracts") or 0) for r in rows]
    legal_s = [float(r.get("legal_short_contracts") or 0) for r in rows]
    has_legal = any(v > 0 for v in legal_l)

    total_oi = [0.0] * n
    for i in range(n):
        if has_legal:
            total_oi[i] = ((phys_l[i] + legal_l[i]) + (phys_s[i] + legal_s[i])) / 2
        else:
            total_oi[i] = phys_l[i] + phys_s[i]

    net_phys_pct = [((phys_l[i] - phys_s[i]) / total_oi[i]) if total_oi[i] > 0 else math.nan for i in range(n)]

    d_long = [math.nan] * n
    d_short = [math.nan] * n
    for i in range(1, n):
        d_long[i] = phys_l[i] - phys_l[i - 1]
        d_short[i] = phys_s[i] - phys_s[i - 1]

    aw = max(1, round(cfg["accum_window"]))
    roll_d_long = [math.nan] * n
    roll_d_short = [math.nan] * n
    for i in range(aw, n):
        sl = sum(d_long[j] for j in range(i - aw + 1, i + 1) if _fin(d_long[j]))
        ss = sum(d_short[j] for j in range(i - aw + 1, i + 1) if _fin(d_short[j]))
        roll_d_long[i] = sl
        roll_d_short[i] = ss

    flow_diff = [math.nan] * n
    for i in range(n):
        sl, ss = roll_d_long[i], roll_d_short[i]
        if _fin(sl) and _fin(ss):
            flow_diff[i] = ss - sl
    flow_mean = _rolling_mean(flow_diff, cfg["z_window"])
    flow_std = _rolling_std(flow_diff, cfg["z_window"])
    squeeze_pressure_z = [
        (flow_diff[i] - flow_mean[i]) / flow_std[i] if _fin(flow_diff[i]) and flow_std[i] > 0 else math.nan
        for i in range(n)
    ]
    squeeze_pressure = [math.tanh(z / 2) if _fin(z) else math.nan for z in squeeze_pressure_z]
    squeeze_pressure_rank = _percentile_rank(squeeze_pressure, cfg["liquidity_window"])

    roll_mean = _rolling_mean(net_phys_pct, cfg["z_window"])
    roll_std = _rolling_std(net_phys_pct, cfg["z_window"])
    imbalance_z = [
        (net_phys_pct[i] - roll_mean[i]) / roll_std[i] if roll_std[i] > 0 else math.nan
        for i in range(n)
    ]

    # narrowRange: H/L недоступен в data/oi_daily.json → всегда close-only
    # ветка (тот же fallback, что в oi_lab для инструментов без свечей).
    price_range = [math.nan] * n
    rw = cfg["range_window"]
    for i in range(rw - 1, n):
        win = close[i - rw + 1:i + 1]
        avg = sum(win) / len(win)
        if avg > 0:
            price_range[i] = (max(win) - min(win)) / avg
    range_thresh = _rolling_quantile(price_range, rw, cfg["range_percentile"])
    narrow_range = [
        _fin(price_range[i]) and _fin(range_thresh[i]) and price_range[i] <= range_thresh[i]
        for i in range(n)
    ]

    imbalance_score = [0.0] * n
    for i in range(n):
        z = min(abs(imbalance_z[i]) / 1.5, 1) if _fin(imbalance_z[i]) else 0.0
        npv = min(abs(net_phys_pct[i]) / 0.20, 1) if _fin(net_phys_pct[i]) else 0.0
        sp = min(abs(squeeze_pressure[i]) / 0.3, 1) if _fin(squeeze_pressure[i]) else 0.0
        imbalance_score[i] = max(z, npv, sp)

    raw_flag = [narrow_range[i] and imbalance_score[i] >= 0.5 for i in range(n)]

    if cfg["use_adaptive_confirm"]:
        atr = _compute_atr_proxy(close, cfg["atr_window"])
        atr_pctl = _percentile_rank(atr, cfg["atr_percentile_window"])
        calibration = _calibrate_confirm_bars_by_volatility(raw_flag, atr_pctl, cfg)
        if calibration:
            confirm_arr = _map_confirm_bars(atr_pctl, calibration, cfg)
            accum_flag = _apply_phase_hysteresis(raw_flag, confirm_arr)
        else:
            accum_flag = _apply_phase_hysteresis(raw_flag, cfg["phase_confirm_bars"])
    else:
        accum_flag = _apply_phase_hysteresis(raw_flag, cfg["phase_confirm_bars"])

    ttl = cfg["phase_range_ttl"]
    phase_high = [math.nan] * n
    phase_low = [math.nan] * n
    bars_since_phase_arr = [math.inf] * n
    run_h = run_l = math.nan
    last_h = last_l = math.nan
    bars_since_phase = math.inf
    for i in range(n):
        prev_flag = accum_flag[i - 1] if i > 0 else False
        if accum_flag[i] and not prev_flag:
            run_h = run_l = math.nan
        if accum_flag[i]:
            c = close[i]
            run_h = c if math.isnan(run_h) else max(run_h, c)
            run_l = c if math.isnan(run_l) else min(run_l, c)
            last_h, last_l = run_h, run_l
            bars_since_phase = 0
        else:
            bars_since_phase += 1
        bars_since_phase_arr[i] = bars_since_phase
        if bars_since_phase <= ttl:
            phase_high[i] = run_h if _fin(run_h) else last_h
            phase_low[i] = run_l if _fin(run_l) else last_l

    breakout_dir = [0] * n
    for i in range(n):
        c, ref_h, ref_l = close[i], phase_high[i], phase_low[i]
        if not (_fin(ref_h) and _fin(ref_l)) or ref_h <= 0:
            continue
        up = (c - ref_h) / ref_h if c > ref_h else 0.0
        down = (ref_l - c) / ref_l if c < ref_l else 0.0
        if up >= down:
            breakout_dir[i] = 1 if up > 0 else 0
        else:
            breakout_dir[i] = -1

    # phase_anchor: перекос OI на момент НАЧАЛА фазы, forward-fill не дольше
    # ttl баров после конца фазы — тот же барьер свежести, что у phase_high/low
    # (иначе якорь тянулся бы месяцами после того, как диапазон устарел).
    phase_anchor = [math.nan] * n
    last_anchor = math.nan
    for i in range(n):
        prev_flag = accum_flag[i - 1] if i > 0 else False
        if accum_flag[i] and not prev_flag:
            last_anchor = net_phys_pct[i]
        phase_anchor[i] = last_anchor if bars_since_phase_arr[i] <= ttl else math.nan

    phase_aligned = [math.nan] * n
    for i in range(n):
        a, d = phase_anchor[i], breakout_dir[i]
        if not _fin(a) or d == 0 or a == 0:
            continue
        phase_aligned[i] = 1 if (a > 0) == (d > 0) else -1

    # totalShort/totalLong (физ+юр) — сквиз давит на того, кто реально
    # передержал позицию, независимо юрлицо это или физлицо (см. docstring oi_lab).
    total_short_arr = [phys_s[i] + legal_s[i] for i in range(n)] if has_legal else phys_s
    total_long_arr = [phys_l[i] + legal_l[i] for i in range(n)] if has_legal else phys_l
    total_short_pctl = _percentile_rank(total_short_arr, cfg["liquidity_window"])
    total_long_pctl = _percentile_rank(total_long_arr, cfg["liquidity_window"])

    tew = max(1, round(cfg["trend_exhaust_window"]))
    trend_return = [math.nan] * n
    for i in range(tew, n):
        if close[i - tew] > 0:
            trend_return[i] = (close[i] - close[i - tew]) / close[i - tew]
    trend_return_pctl = _percentile_rank(trend_return, cfg["liquidity_window"])
    trend_exhaust = [0] * n
    for i in range(n):
        tr, trp = trend_return[i], trend_return_pctl[i]
        if not (_fin(tr) and _fin(trp)):
            continue
        if trp <= (1 - cfg["trend_exhaust_move_pctl_short"]) and _fin(total_short_pctl[i]) and total_short_pctl[i] >= cfg["trend_exhaust_pctl_short"]:
            trend_exhaust[i] = 1
        elif trp >= cfg["trend_exhaust_move_pctl_long"] and _fin(total_long_pctl[i]) and total_long_pctl[i] >= cfg["trend_exhaust_pctl_long"]:
            trend_exhaust[i] = -1

    ddw = max(2, round(cfg["spike_setup_dd_window"]))
    drawdown = [math.nan] * n
    for i in range(n):
        if not (close[i] > 0):
            continue
        mx = max((close[j] for j in range(max(0, i - ddw + 1), i + 1) if close[j] > 0), default=-math.inf)
        if mx > 0:
            drawdown[i] = (close[i] - mx) / mx
    drawdown_rank = _percentile_rank(drawdown, cfg["liquidity_window"])
    dd_thr = 1 - cfg["spike_setup_dd_pctl"]
    flow_max = cfg["spike_setup_flow_max"]
    spike_setup = [
        _fin(drawdown_rank[i]) and drawdown_rank[i] <= dd_thr
        and _fin(squeeze_pressure_rank[i]) and squeeze_pressure_rank[i] <= flow_max
        for i in range(n)
    ]

    out = []
    for i, r in enumerate(rows):
        out.append({
            "date": r.get("date"),
            "close": close[i],
            "ref_switch": bool(r.get("ref_switch")),
            "accum_flag": accum_flag[i],
            "breakout_dir": breakout_dir[i],
            "phase_aligned": phase_aligned[i],
            "trend_exhaust": trend_exhaust[i],
            "squeeze_pressure_rank": squeeze_pressure_rank[i],
            "spike_setup": spike_setup[i],
        })
    return out


def _fwd_returns(result: list[dict], horizons=HORIZONS) -> dict[int, list[float]]:
    n = len(result)
    fwd: dict[int, list[float]] = {}
    for h in horizons:
        col = [math.nan] * n
        for i in range(n):
            if i + h >= n:
                continue
            # Окно, пересекающее ролл контракта, содержит нерыночный скачок — вырезаем.
            if any(result[j]["ref_switch"] for j in range(i + 1, i + h + 1)):
                continue
            c0, c1 = result[i]["close"], result[i + h]["close"]
            if c0 > 0 and c1 > 0:
                col[i] = (c1 - c0) / c0 * 100
        fwd[h] = col
    return fwd


# ========== триггеры (порт _SCREEN_SIGNALS, без 4-го "не для входа") ==========

SCREEN_SIGNALS = [
    {
        "id": "trendDown", "dir": -1,
        "name": "Лонг-коррекция (шорт)",
        "match": lambda r: r["trend_exhaust"] == -1,
    },
    {
        "id": "exh", "dir": -1,
        "name": "Истощение после выброса вверх (шорт)",
        "match": lambda r: (not r["accum_flag"]) and r["breakout_dir"] == 1 and r["phase_aligned"] == 1,
    },
    {
        "id": "longAggr", "dir": -1,
        "name": "Лонг набирали агрессивно (шорт)",
        "match": lambda r: _fin(r["squeeze_pressure_rank"]) and r["squeeze_pressure_rank"] <= 0.2,
    },
]


# ========== калибровка (порт labSignalScreener, без HTML) ==========

@dataclass
class _TickerStat:
    n3: int = 0
    acc3: float = math.nan
    fav3: float = math.nan
    adv3: float = math.nan
    active: bool = False


@dataclass
class GateCalibration:
    per_ticker: dict[str, dict[str, _TickerStat]] = field(default_factory=dict)
    pool_acc3: dict[str, float] = field(default_factory=dict)
    computed_at: str = ""

    def to_json(self) -> dict:
        return {
            "computed_at": self.computed_at,
            "pool_acc3": self.pool_acc3,
            "per_ticker": {
                t: {did: vars(s) for did, s in defs.items()}
                for t, defs in self.per_ticker.items()
            },
        }

    @classmethod
    def from_json(cls, data: dict) -> "GateCalibration":
        per_ticker = {
            t: {did: _TickerStat(**s) for did, s in defs.items()}
            for t, defs in (data.get("per_ticker") or {}).items()
        }
        return cls(per_ticker=per_ticker, pool_acc3=data.get("pool_acc3") or {},
                    computed_at=data.get("computed_at") or "")


def oi_regime_instability(raw_rows: list[dict], cfg: dict = None) -> float:
    """ОИ как НЕ-направленный индикатор нестабильности РЕЖИМА, [0,1].

    Отдельная роль от гейта (SignalGate.evaluate — жёсткий «не входить») и от
    направленных OI-методов композита: здесь только «оцепенеть» — насколько
    позиционирование перегрето и рынок склонён к резкому выбросу. Результат идёт
    в regime.oi_instability_adjust (подмешивает в stress). Считаем по последней
    строке того же организованного compute_indicator (порт oi_lab), что и гейт —
    не изобретаем свою метрику, а берём edge-осмысленные ранг-нормированные поля:

      flow_extremity — насколько ОДНА сторона агрессивно набирает поток ΔОИ.
        Берём НЕ линейное |rank−0.5|·2 (перцентильный ранг одного дня почти
        равномерен на [0,1] → шумит около 0.5 и давал бы ложный базовый уровень),
        а рамп ТОЛЬКО в хвостах: ранг ≤0.2 или ≥0.8 (тот же порог, что у oi_lab
        longAggr) → от 0 до 1. Середина [0.2,0.8] = 0. Чистый OI-поток, робастен
        даже без цены (close в oi_daily может быть 0, если price_getter молчал).
      reversal_setup = 1, если trend_exhaust ≠ 0 — edge-валидированный сетап
        разворота (перекос позиций у исторического экстремума + истощение хода).
        Требует цены; без неё тихо 0 — тогда несёт только flow_extremity, мягкая
        деградация вместо мусора.

    0.6·flow + 0.4·reversal. Мало истории (<MIN_ROWS_FOR_CALC) или нет
    squeeze_pressure_rank → 0.0 (no-op: режим считается по цене/объёму как раньше).
    Направление отброшено сознательно — им заведуют OI-методы, режим лишь
    повышает общую осторожность (потому нет спора с методом OI_SQUEEZE)."""
    if len(raw_rows) < MIN_ROWS_FOR_CALC:
        return 0.0
    try:
        result = compute_indicator(_prepare_rows(raw_rows), cfg)
    except Exception:
        logger.exception("oi_regime_instability: расчёт индикатора упал")
        return 0.0
    if not result:
        return 0.0
    last = result[-1]
    spr = last.get("squeeze_pressure_rank")
    if not _fin(spr):
        return 0.0
    d = abs(spr - 0.5) * 2.0                       # 0 в центре, 1 на краях ранга
    # рамп только в хвостах: 0 при ранге в [0.2,0.8] (d<=0.6), 1 при ранге 0/1.
    flow_extremity = max(0.0, min(1.0, (d - 0.6) / 0.4))
    reversal_setup = 1.0 if last.get("trend_exhaust", 0) != 0 else 0.0
    return max(0.0, min(1.0, 0.6 * flow_extremity + 0.4 * reversal_setup))


def _prepare_rows(raw_rows: list[dict]) -> list[dict]:
    """data/oi_daily.json (формат oi_layers.py) -> вход compute_indicator."""
    rows = []
    prev_contract = None
    for r in raw_rows:
        contract = r.get("contract")
        ref_switch = bool(prev_contract and contract and contract != prev_contract)
        if contract:
            prev_contract = contract
        rows.append({
            "date": r.get("tradedate"),
            "close": r.get("price") or 0,
            "phys_long_contracts": r.get("fiz_long") or 0,
            "phys_short_contracts": r.get("fiz_short") or 0,
            "legal_long_contracts": r.get("yur_long") or 0,
            "legal_short_contracts": r.get("yur_short") or 0,
            "ref_switch": ref_switch,
        })
    return rows


def calibrate(history_by_ticker: dict[str, list[dict]], cfg: dict = None) -> GateCalibration:
    """
    history_by_ticker — {ticker: [сырые дневные снэпшоты oi_layers.py]}, обычно
    OiLayersService._history или содержимое data/oi_daily.json целиком (для
    пуловой статистики выгоднее считать по ВСЕМ тикерам с данными, не только
    сегодняшним settings.ini — как labCalibratePool по всему пулу).
    """
    pool_agg = {d["id"]: {"c3": 0, "n3": 0} for d in SCREEN_SIGNALS}
    per_ticker: dict[str, dict[str, _TickerStat]] = {}

    for ticker, raw_rows in history_by_ticker.items():
        if len(raw_rows) < MIN_ROWS_FOR_CALC:
            continue
        try:
            result = compute_indicator(_prepare_rows(raw_rows), cfg)
        except Exception:
            logger.exception(f"signal_gate: расчёт индикатора для {ticker} упал")
            continue
        fwd = _fwd_returns(result)
        last_row = result[-1] if result else None
        per_ticker[ticker] = {}
        for d in SCREEN_SIGNALS:
            n3 = c3 = 0
            wins, loses = [], []
            for i, r in enumerate(result):
                if not d["match"](r):
                    continue
                b = fwd[3][i]
                if not _fin(b):
                    continue
                n3 += 1
                right = (b > 0) if d["dir"] > 0 else (b < 0)
                if right:
                    c3 += 1
                    wins.append(abs(b))
                else:
                    loses.append(abs(b))
            pool_agg[d["id"]]["c3"] += c3
            pool_agg[d["id"]]["n3"] += n3
            active_now = bool(last_row and d["match"](last_row))
            per_ticker[ticker][d["id"]] = _TickerStat(
                n3=n3,
                acc3=(c3 / n3 * 100) if n3 else math.nan,
                fav3=_median(wins),
                adv3=_median(loses),
                active=active_now,
            )

    pool_acc3 = {
        did: (agg["c3"] / agg["n3"] * 100 if agg["n3"] else math.nan)
        for did, agg in pool_agg.items()
    }
    from datetime import datetime, timezone
    return GateCalibration(per_ticker=per_ticker, pool_acc3=pool_acc3,
                            computed_at=datetime.now(timezone.utc).isoformat())


def _classify(stat: _TickerStat) -> str:
    if stat.n3 >= MIN_N and _fin(stat.acc3):
        return "tradeable" if stat.acc3 >= ACC_THRESHOLD else "against_statistics"
    return "thin_history"


class SignalGate:
    """
    Держит последнюю калибровку в памяти + на диске (data/signal_gate.json),
    переживает рестарт бота между recalibrate() (раз в торговый день).
    """

    def __init__(self, path: str = GATE_FILE):
        self._path = path
        self._calib = GateCalibration()
        self._load()

    def _load(self) -> None:
        if not os.path.exists(self._path):
            return
        try:
            with open(self._path, encoding="utf-8") as f:
                self._calib = GateCalibration.from_json(json.load(f))
        except (json.JSONDecodeError, OSError) as e:
            logger.warning(f"signal_gate: не удалось загрузить {self._path}: {e}")

    def _save(self) -> None:
        os.makedirs(os.path.dirname(self._path) or ".", exist_ok=True)
        try:
            tmp = self._path + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(self._calib.to_json(), f, ensure_ascii=False)
            os.replace(tmp, self._path)
        except OSError as e:
            logger.warning(f"signal_gate: не удалось сохранить {self._path}: {e}")

    def recalibrate(self, history_by_ticker: dict[str, list[dict]], cfg: dict = None) -> None:
        try:
            self._calib = calibrate(history_by_ticker, cfg)
            self._save()
            logger.info(
                f"signal_gate: калибровка обновлена, тикеров с данными: {len(self._calib.per_ticker)}"
            )
        except Exception:
            logger.exception("signal_gate: recalibrate упал — оставляю прежнюю калибровку")

    @classmethod
    def recalibrate_from_file(cls, gate_path: str = GATE_FILE, oi_history_path: str = OI_HISTORY_FILE,
                               cfg: dict = None) -> "SignalGate":
        """Утилита для разового пересчёта из data/oi_daily.json без живого OiLayersService."""
        gate = cls(gate_path)
        history = {}
        if os.path.exists(oi_history_path):
            try:
                with open(oi_history_path, encoding="utf-8") as f:
                    history = json.load(f)
            except (json.JSONDecodeError, OSError) as e:
                logger.warning(f"signal_gate: не удалось загрузить {oi_history_path}: {e}")
        gate.recalibrate(history, cfg)
        return gate

    def evaluate(self, ticker: str, direction: str) -> tuple[bool, str]:
        """
        direction: "long" | "short". Возвращает (ok, reason) — ok=False только
        если активный СЕЙЧАС триггер на ЭТОМ тикере исторически (N>=8, точность
        <60%) НЕ работал в направлении direction. Нет калибровки/сигнал не
        активен/мало своей истории — ok=True (гейт не мешает при отсутствии
        доказательств, ничего не запрещает "на всякий случай").
        """
        stats = self._calib.per_ticker.get(ticker)
        if not stats:
            return True, "нет калибровки сигнал-гейта для тикера"
        req_dir = 1 if direction == "long" else -1
        for d in SCREEN_SIGNALS:
            if d["dir"] != req_dir:
                continue
            stat = stats.get(d["id"])
            if not stat or not stat.active:
                continue
            verdict = _classify(stat)
            if verdict == "against_statistics":
                return False, (
                    f"«{d['name']}» активен, но на {ticker} исторически не работает "
                    f"(точность {stat.acc3:.0f}% при N={stat.n3}, "
                    f"прав +{stat.fav3:.1f}% / неправ −{stat.adv3:.1f}%)"
                )
        return True, "гейт пройден"
