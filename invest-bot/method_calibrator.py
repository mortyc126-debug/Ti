"""
method_calibrator.py — адаптивный подбор параметров индикаторов под тикер.

Идея (из IndLab): один и тот же индикатор с разными периодами даёт разную
точность на разных инструментах. FISHER_RSI(10) хорошо работает на SBER,
но RMI(8) лучше на NGM6 — у фьючерса другой характерный цикл.

Дополнительно: для каждого (метод, период) тестируем alt-интерпретацию
(дивергенция / истощение / чоп-фейд) и фиксируем что лучше на данном
инструменте.

Процесс:
  1. Берём исторические свечи (уже есть через atr_history_provider)
  2. Для каждого метода из TUNABLE_METHODS:
     - вычисляем скоры для каждого кандидата (period, alt_flag)
     - оцениваем accuracy: доля баров где sign(score)==sign(close[i+H]-close[i])
     - запоминаем лучший (period, alt_flag) по accuracy при горизонте H
  3. Результат сохраняется в JSON-файл рядом с history.db
  4. Стратегия подгружает при старте и использует calibrated-функции вместо дефолтных
  5. Пересчёт раз в N дней (по умолчанию 7)

Точность (accuracy) = доля баров где знак скора совпал с направлением цены
через H баров. Базовая ставка = доля баров где цена выросла. Information gain
= accuracy - baseRate. Берём вариант с максимальным IG ≥ 0.03 (3% edge).
"""
import json
import logging
import math
import os
from typing import Callable, Optional

logger = logging.getLogger(__name__)

# Горизонт оценки привязан к периоду индикатора, а не фиксирован: ждать
# реализацию сигнала периода-30 за те же 15 баров, что и период-5 —
# методологически неверно (это половина собственного окна медленного
# индикатора). H = clamp(period * HORIZON_FACTOR, HORIZON_MIN, HORIZON_MAX).
HORIZON_FACTOR = 0.75
HORIZON_MIN = 4
HORIZON_MAX = 20
# Целевая функция отбора — РИСК/ИЗДЕРЖКО-осознанная ожидаемая доходность на
# сигнал (expectancy), а не hit-rate. Для каждого сигнала берём знаковый ход
# цены за горизонт, взвешенный по РАЗМЕРУ (крупная верная сделка ценнее мелкой,
# крупная ошибочная — штрафуется сильнее — чего hit-rate не видит), за вычетом
# издержек. Это же снимает циркулярность (раньше мерили тем же винрейтом).
# CALIB_COST — реальная фрикция (комиссия + половина спреда за сторону), доля.
# Это привязанная к реальности величина, а не абстрактный порог: ход, не
# перекрывающий издержки, для торговли бесполезен и в expectancy уходит в минус.
CALIB_COST = 0.0004
# Стоп в метрике — не фикс-уровень, а КРАТНОЕ локального ATR инструмента на баре
# сигнала (per-signal, per-ticker): на спокойном рынке узкий, на волатильном
# широкий — автоматически, без подгонки под отрезок. Множитель — универсальная
# риск-конвенция, а не рыночный паттерн; его устойчивость проверяется тестом
# чувствительности (ранжирование не должно переворачиваться на 1.0…2.5 ATR).
STOP_ATR_MULT = 1.5
STOP_ATR_WIN = 14      # окно ATR (баров), причинно
# Гейт — по НИЖНЕЙ доверительной границе expectancy (edge-пространство), а не
# по точечной оценке: и сам выбранный > 0 после издержек, и парно > классики.
# Абсолютных «магических» порогов нет — критерий чисто статистический (LCB>0).
# Минимум баров для in-sample оценки на фолде отбора.
CALIB_MIN_BARS = 30
# Минимум реализованных исходов в OOS-тест-фолде, иначе фолд пропускается.
CALIB_FOLD_MIN_OBS = 15
# Целевое число баров на один walk-forward фолд (определяет число фолдов).
CALIB_FOLD_TARGET_LEN = 45
# Границы числа фолдов.
CALIB_FOLDS_MIN = 3
CALIB_FOLDS_MAX = 7
# Z для нижней доверительной границы OOS-IG. 1.6 ≈ ~95% односторонний.
# Проверено multi-seed рандом-уоком: при 1.0 на шуме ложно адаптировалось ~11%
# метод-инстансов (значимость была косметической), при 1.6 + парном тесте
# (см. _finalize_method) — ~0%.
CALIB_LCB_Z = 1.6
# Минимальная доля фолдов, где выбранный обошёл классику (согласованность).
CALIB_MIN_CONSISTENCY = 0.75
# Минимальный эффект — НЕ абсолютный, а в долях собственной H-барной
# волатильности инструмента (vol_ref): нижний предел expectancy выбранного и
# его парного преимущества над классикой должны превышать эти доли σ. Так порог
# осмысленности хода привязан к тому, как двигается сам инструмент, а не к
# универсальной цифре. Подобрано multi-seed шумом (5/96 → ~1/96).
CALIB_EDGE_FRAC = 0.04      # net-edge выбранного ≥ 4% σ (сверх нуля)
CALIB_IMPROVE_FRAC = 0.08   # парное преимущество над классикой ≥ 8% σ
# Пересчёт раз в N дней
CALIB_RECALC_DAYS = 7

# Канонический («классический») набор параметров каждого метода — якорь усадки.
# Адаптация не заменяет дефолт целиком, а сдвигается к нему пропорционально
# силе и стабильности OOS-преимущества (см. calibrate/get_fn). Значения обязаны
# присутствовать в TUNABLE_REGISTRY как один из кандидатов.
CLASSIC_PARAMS = {
    "FISHER_RSI":   {"period": 10},
    "RMI":          {"period": 14, "momentum": 5},
    "ZSCORE":       {"period": 20},
    "ZLEMA_SIGNAL": {"period": 14},
    "T3_SIGNAL":    {"period": 5},
    "TWIGGS":       {"period": 21},
    "KLINGER":      {"fast": 34, "slow": 55},
    "VZO":          {"period": 14},
}


# ─── Параметрические фабрики ──────────────────────────────────────────────────
# Каждая фабрика возвращает функцию (closes, highs, lows, volumes) -> float
# с нужными параметрами. Все принимают raw float-списки, не HistoricCandle.

def _factory_fisher_rsi(period: int):
    # Единый источник с live-стратегией (score_fisher_rsi_candle): родная
    # механика Ehlers (триггер-линия + z-сила спайка + подтверждение ценой),
    # без порога 1.8 и бинарного ±2. Иначе калибровка отбирала бы период по
    # одной формуле, а торговля считала бы Fisher по другой.
    from indicators_ehlers import fisher_score_core

    def fn(closes, highs, lows, volumes):
        return fisher_score_core(closes, highs, lows, period=period)

    return fn


def _factory_rmi(period: int, momentum: int):
    from indicators_volume import rmi as _rmi

    def fn(closes, highs, lows, volumes):
        n = len(closes)
        if n < period + momentum + 5:
            return 0.0
        arr = _rmi(closes, period=period, momentum=momentum)
        if not arr or len(arr) < 3:
            return 0.0
        v = arr[-1]
        prev = arr[-2]
        # oversold/overbought + разворот
        if v < 30 and v > prev:
            return min(1.0, (30 - v) / 30)
        if v > 70 and v < prev:
            return -min(1.0, (v - 70) / 30)
        # нейтраль — момент
        mid = (v - 50) / 50
        return max(-0.5, min(0.5, mid))

    return fn


def _factory_zscore(period: int):
    def fn(closes, highs, lows, volumes):
        n = len(closes)
        if n < period + 5:
            return 0.0
        window = closes[-period:]
        mean = sum(window) / period
        std = (sum((x - mean) ** 2 for x in window) / period) ** 0.5
        if std < 1e-9:
            return 0.0
        z = (closes[-1] - mean) / std
        lb = min(10, n - 1)
        price_move = (closes[-1] - closes[-lb]) / (closes[-lb] + 1e-9)
        moving = abs(price_move) > 0.003
        # разворот от экстремума
        if abs(z) > 2.0:
            return max(-1.0, min(1.0, -z / 3.0))
        # истощение: почти 0 при движущейся цене
        if abs(z) < 0.3 and moving:
            return -1.0 if price_move > 0 else 1.0
        return max(-0.5, min(0.5, -z / 4.0))

    return fn


def _factory_zlema(period: int):
    from indicators import zlema as _zlema

    def fn(closes, highs, lows, volumes):
        n = len(closes)
        if n < period + 5:
            return 0.0
        p = min(period, n - 1)
        line = _zlema(closes, period=p)
        if len(line) < 3:
            return 0.0
        price = closes[-1]
        ma = line[-1]
        ma_prev = line[-2]
        diff_pct = (price - ma) / (ma + 1e-9) * 100
        slope = (ma - ma_prev) / (ma_prev + 1e-9) * 100
        if slope > 0.05 and diff_pct > 0:
            return min(1.0, (slope + diff_pct * 0.5) / 0.5)
        if slope < -0.05 and diff_pct < 0:
            return max(-1.0, (slope + diff_pct * 0.5) / 0.5)
        return max(-0.3, min(0.3, diff_pct / 0.5))

    return fn


def _factory_t3(period: int):
    from indicators import t3 as _t3

    def fn(closes, highs, lows, volumes):
        n = len(closes)
        if n < period * 2 + 5:
            return 0.0
        p = min(period, max(2, n // 4))
        line = _t3(closes, period=p)
        if len(line) < 3:
            return 0.0
        price = closes[-1]
        ma = line[-1]
        ma_prev = line[-2]
        slope = (ma - ma_prev) / (ma_prev + 1e-9) * 100
        diff = (price - ma) / (ma + 1e-9) * 100
        if slope > 0.03:
            return min(1.0, slope / 0.1 + diff / 0.2)
        if slope < -0.03:
            return max(-1.0, slope / 0.1 + diff / 0.2)
        return 0.0

    return fn


def _factory_twiggs(period: int):
    from indicators_volume import twiggs_money_flow as _tmf

    def fn(closes, highs, lows, volumes):
        n = len(closes)
        if n < period + 5:
            return 0.0
        p = min(period, n - 1)
        tmf = _tmf(highs, lows, closes, volumes, period=p)
        if len(tmf) < 5:
            return 0.0
        v, prev = tmf[-1], tmf[-2]
        EXTREME = 0.65
        at_top = v > EXTREME
        at_bottom = v < -EXTREME
        if at_top and v < prev:
            return -min(1.0, abs(v))
        if at_bottom and v > prev:
            return min(1.0, abs(v))
        if at_top:
            return -0.4
        if at_bottom:
            return 0.4
        return max(-0.3, min(0.3, v))

    return fn


def _factory_klinger(fast: int, slow: int):
    from indicators_volume import klinger_oscillator as _kvo

    def fn(closes, highs, lows, volumes):
        n = len(closes)
        if n < slow + 5:
            return 0.0
        f = min(fast, n // 2)
        s = min(slow, n - 1)
        kvo = _kvo(highs, lows, closes, volumes, fast=f, slow=s)
        if len(kvo) < 5:
            return 0.0
        rms = (sum(x * x for x in kvo[-20:]) / min(20, len(kvo))) ** 0.5 or 1.0
        base = math.tanh(kvo[-1] / (rms * 1.5))
        lb = min(20, n - 1)
        price_chg = closes[-1] - closes[-lb]
        kvo_chg = kvo[-1] - kvo[-lb]
        div = 0.0
        if price_chg < -1e-4 and kvo_chg > rms * 0.1:
            div = min(0.6, kvo_chg / (rms + 1e-9) * 0.4)
        elif price_chg > 1e-4 and kvo_chg < -rms * 0.1:
            div = max(-0.6, kvo_chg / (rms + 1e-9) * 0.4)
        return max(-1.0, min(1.0, base * 0.5 + div * 0.5))

    return fn


def _factory_vzo(period: int):
    from indicators_volume import vzo as _vzo

    def fn(closes, highs, lows, volumes):
        n = len(closes)
        if n < period + 5:
            return 0.0
        p = min(period, n - 1)
        arr = _vzo(closes, volumes, period=p)
        if not arr or len(arr) < 3:
            return 0.0
        v = arr[-1]
        # VZO: >5 = bullish zone, >40 = overbought; <-5 = bearish, <-40 = oversold
        if v > 40:
            return -0.6
        if v < -40:
            return 0.6
        return max(-1.0, min(1.0, v / 40))

    return fn


# ─── Реестр настраиваемых методов ─────────────────────────────────────────────
# {method_name: [(label, factory_fn, candidate_kwargs), ...]}
# label используется только для логов

def _build_tunable_registry() -> dict[str, list[tuple[str, Callable, dict]]]:
    reg = {}

    # FISHER_RSI
    reg["FISHER_RSI"] = [
        (f"fisher_rsi(p={p})", _factory_fisher_rsi(p), {"period": p})
        for p in [6, 8, 10, 14, 21]
    ]

    # RMI
    reg["RMI"] = [
        (f"rmi(p={p},m={m})", _factory_rmi(p, m), {"period": p, "momentum": m})
        for p, m in [(8, 3), (10, 4), (14, 5), (20, 5), (14, 3)]
    ]

    # ZSCORE
    reg["ZSCORE"] = [
        (f"zscore(p={p})", _factory_zscore(p), {"period": p})
        for p in [10, 14, 20, 30]
    ]

    # ZLEMA_SIGNAL
    reg["ZLEMA_SIGNAL"] = [
        (f"zlema(p={p})", _factory_zlema(p), {"period": p})
        for p in [8, 10, 14, 20, 30]
    ]

    # T3_SIGNAL
    reg["T3_SIGNAL"] = [
        (f"t3(p={p})", _factory_t3(p), {"period": p})
        for p in [3, 5, 8, 10, 14]
    ]

    # TWIGGS
    reg["TWIGGS"] = [
        (f"twiggs(p={p})", _factory_twiggs(p), {"period": p})
        for p in [10, 14, 21, 30]
    ]

    # KLINGER
    reg["KLINGER"] = [
        (f"klinger(f={f},s={s})", _factory_klinger(f, s), {"fast": f, "slow": s})
        for f, s in [(13, 34), (21, 55), (34, 55), (13, 21)]
    ]

    # VZO
    reg["VZO"] = [
        (f"vzo(p={p})", _factory_vzo(p), {"period": p})
        for p in [10, 14, 21, 30]
    ]

    return reg


TUNABLE_REGISTRY = _build_tunable_registry()


# ─── Alt-трансформация для оценки ─────────────────────────────────────────────

def _apply_alt_to_scores(scores: list[float], closes: list[float],
                          lookback: int = 10) -> list[float]:
    """
    Упрощённая alt-трансформация для calibration: дивергенция + streak-fade.
    Применяется к series скоров чтобы оценить accuracy alt-версии.
    """
    n = len(scores)
    out = list(scores)
    for i in range(lookback, n):
        s = scores[i]
        if s is None or s == 0.0:
            continue
        price_win = closes[max(0, i - lookback):i]
        score_win = [v for v in scores[max(0, i - lookback):i] if v is not None]
        if not score_win or not price_win:
            continue
        # дивергенция
        price_max = max(price_win)
        price_min = min(price_win)
        score_max = max(score_win)
        score_min = min(score_win)
        new_high = closes[i] >= price_max
        new_low = closes[i] <= price_min
        if new_high and s < score_max:
            out[i] = -abs(s)
        elif new_low and s > score_min:
            out[i] = abs(s)
        # streak-fade: 4 бара на максимуме → разворот
        if i >= 4:
            streak_window = scores[i - 4:i + 1]
            if all(v is not None and v >= score_max * 0.95 for v in streak_window):
                out[i] = -abs(s)
            elif all(v is not None and v <= score_min * 0.95 for v in streak_window):
                out[i] = abs(s)
    return out


# ─── Scorer ───────────────────────────────────────────────────────────────────

def _score_series(fn: Callable, candles_raw: list, window: int) -> list[Optional[float]]:
    """
    Прокручивает candles_raw через fn(closes, highs, lows, volumes) на
    скользящем окне window баров. Возвращает список скоров (None если нет данных).
    """
    n = len(candles_raw)
    scores = [None] * n
    for i in range(window, n):
        seg = candles_raw[i - window:i]
        closes = [c["close"] for c in seg]
        highs  = [c["high"]  for c in seg]
        lows   = [c["low"]   for c in seg]
        vols   = [c["vol"]   for c in seg]
        try:
            scores[i] = fn(closes, highs, lows, vols)
        except Exception:
            scores[i] = None
    return scores


def _horizon_for_params(params: dict) -> int:
    """Горизонт оценки, привязанный к периоду индикатора (не фиксированный)."""
    per = params.get("slow") or params.get("period") or params.get("len") or 14
    return int(max(HORIZON_MIN, min(HORIZON_MAX, round(per * HORIZON_FACTOR))))


def _atr_frac_series(highs: list[float], lows: list[float], closes: list[float],
                     win: int = STOP_ATR_WIN) -> list[float]:
    """Причинный ATR как доля цены: atr[i]/close[i], скользящее среднее True Range
    по последним win барам (только прошлое до i включительно)."""
    n = len(closes)
    tr = [0.0] * n
    for j in range(1, n):
        tr[j] = max(highs[j] - lows[j],
                    abs(highs[j] - closes[j - 1]),
                    abs(lows[j] - closes[j - 1]))
    out = [0.0] * n
    run = 0.0
    for i in range(1, n):
        run += tr[i]
        if i > win:
            run -= tr[i - win]
        denom = min(i, win)
        atr = run / denom if denom > 0 else 0.0
        out[i] = atr / closes[i] if closes[i] else 0.0
    return out


def _edge_range(scores: list[Optional[float]], closes: list[float],
                highs: list[float], lows: list[float], atr_frac: list[float],
                horizon: int, lo: int, hi: int,
                stop_mult: float = STOP_ATR_MULT) -> tuple[Optional[float], int]:
    """
    РИСК/ИЗДЕРЖКО-осознанная ожидаемая доходность на сигнал (expectancy) в
    диапазоне [lo, hi), СО СТОПОМ по пути. Для каждого бара с ненулевым скором
    симулируется удержание позиции в сторону знака до H баров:
      • стоп = stop_mult · ATR_local / price — per-signal, per-ticker, из
        собственной волатильности инструмента на этом баре (не фикс-уровень);
      • если по пути [i+1, i+H] неблагоприятный экскурс (low для лонга / high
        для шорта) достигает −стопа — выходим по стопу (−стоп), иначе по close[i+H];
      • pnl = реализованный ход в сторону знака − CALIB_COST.
    Так метрика перестаёт переоценивать сигналы, которые «нырнули на −5% и
    вернулись к H»: реальная сделка со стопом вышла бы в минусе.

    Причинно: путь читает бары только до i+H < hi (капается ниже). ATR — из
    прошлого. Де-бета — парным сравнением с классикой (см. _finalize_method).
    Возвращает (edge | None, число сигналов).
    """
    n = len(closes)
    hi = min(hi, n - horizon)
    pnl_sum = 0.0
    total = 0
    for i in range(max(0, lo), hi):
        c0 = closes[i]
        if c0 == 0:
            continue
        s = scores[i]
        if s is None or s == 0.0:
            continue
        stop_frac = stop_mult * atr_frac[i]
        long_ = s > 0
        exit_ret = None
        if stop_frac > 0:
            for j in range(i + 1, i + horizon + 1):
                if long_:
                    if (lows[j] - c0) / c0 <= -stop_frac:
                        exit_ret = -stop_frac
                        break
                else:
                    if (highs[j] - c0) / c0 >= stop_frac:
                        exit_ret = -stop_frac
                        break
        if exit_ret is None:
            fwd = (closes[i + horizon] - c0) / c0
            exit_ret = fwd if long_ else -fwd
        pnl_sum += exit_ret - CALIB_COST
        total += 1
    if total == 0:
        return None, 0
    return pnl_sum / total, total


def _vol_ref(closes: list[float], horizon: int, lo: int, hi: int) -> float:
    """Собственный H-барный масштаб хода инструмента (std |fwd_return|) — единица
    измерения для усадки λ (чтобы λ была per-ticker, а не в абсолютных долях)."""
    n = len(closes)
    hi = min(hi, n - horizon)
    rets = []
    for i in range(max(0, lo), hi):
        c0 = closes[i]
        if c0:
            rets.append((closes[i + horizon] - c0) / c0)
    if len(rets) < 2:
        return 0.0
    m = sum(rets) / len(rets)
    return (sum((r - m) ** 2 for r in rets) / (len(rets) - 1)) ** 0.5


def _mean_se(xs: list[float]) -> tuple[float, float]:
    """Среднее и стандартная ошибка среднего (SE = std / sqrt(n))."""
    k = len(xs)
    if k == 0:
        return 0.0, 0.0
    m = sum(xs) / k
    if k < 2:
        return m, 0.0
    var = sum((x - m) ** 2 for x in xs) / (k - 1)
    return m, (var ** 0.5) / (k ** 0.5)


def _classic_index(method_name: str, candidates: list) -> int:
    """Индекс канонического («классического») кандидата — якоря усадки."""
    want = CLASSIC_PARAMS.get(method_name)
    if want:
        for idx, (label, fn, params) in enumerate(candidates):
            if all(params.get(k) == v for k, v in want.items()):
                return idx
    return len(candidates) // 2   # фолбэк — средний по сетке


def _make_alt_fn(base_fn: Callable, lookback: int = 10) -> Callable:
    """Оборачивает базовую функцию в причинную alt-трансформацию (буфер прошлого)."""
    _score_buf: list[float] = []
    _close_buf: list[float] = []

    def alt_fn(closes, highs, lows, vols):
        s = base_fn(closes, highs, lows, vols)
        _score_buf.append(s if s is not None else 0.0)
        _close_buf.append(closes[-1] if closes else 0.0)
        if len(_score_buf) < lookback:
            return s or 0.0
        alt_scores = _apply_alt_to_scores(
            _score_buf[-lookback - 1:], _close_buf[-lookback - 1:], lookback=lookback
        )
        return alt_scores[-1]

    return alt_fn


def _blend_fn(chosen_fn: Callable, classic_fn: Callable, lam: float) -> Callable:
    """Усадка к классике: λ·калиброванная + (1−λ)·классическая на уровне СКОРА,
    а не периода — иначе пришлось бы прыгать между дискретными периодами (14↔30)
    от одного случайного бара разницы. λ отражает силу и стабильность OOS-эффекта."""
    def blended(closes, highs, lows, vols):
        a = chosen_fn(closes, highs, lows, vols)
        b = classic_fn(closes, highs, lows, vols)
        a = a if a is not None else 0.0
        b = b if b is not None else 0.0
        return lam * a + (1.0 - lam) * b
    return blended


# ─── Основной класс ───────────────────────────────────────────────────────────

class MethodCalibrator:
    """
    Подбирает оптимальные (period, use_alt) для каждого метода на каждом тикере.
    Результаты хранятся в JSON-файле и обновляются раз в CALIB_RECALC_DAYS дней.

    Использование в стратегии:
        calibrator = MethodCalibrator()
        calibrator.calibrate(ticker, raw_candles)
        fn = calibrator.get_fn(ticker, "FISHER_RSI")  # best parameterized fn
        score = fn(closes, highs, lows, vols)
    """

    def __init__(self, store_path: str = "method_params.json",
                 window: int = 60):
        self._store_path = store_path
        self._window = window          # размер окна (баров) для вычисления скора
        self._data: dict = self._load()
        # {ticker: {method: {params, use_alt, ig, horizon, updated}}}
        # Кэш собранных fn: alt-вариант причинно-буферный (копит прошлое между
        # вызовами), а стратегия дёргает get_fn на каждом баре — без кэша буфер
        # пересоздавался бы каждый бар и alt никогда бы не набирался (тихо
        # деградировал в сырой скор). Ключ инвалидируется при смене записи.
        self._fn_cache: dict = {}

    def _load(self) -> dict:
        if os.path.exists(self._store_path):
            try:
                with open(self._store_path) as f:
                    return json.load(f)
            except Exception:
                pass
        return {}

    def _save(self) -> None:
        try:
            with open(self._store_path, "w") as f:
                json.dump(self._data, f, indent=2)
        except Exception as exc:
            logger.warning(f"MethodCalibrator: не удалось сохранить {exc}")

    def needs_recalc(self, ticker: str) -> bool:
        import datetime
        entry = self._data.get(ticker, {})
        if not entry:
            return True
        # берём дату любого метода
        for v in entry.values():
            updated = v.get("updated", "")
            if not updated:
                return True
            try:
                last = datetime.date.fromisoformat(updated)
                delta = (datetime.date.today() - last).days
                return delta >= CALIB_RECALC_DAYS
            except Exception:
                return True
        return True

    def calibrate(self, ticker: str, candles_raw: list) -> None:
        """
        candles_raw: список dict {"close": float, "high": float, "low": float, "vol": float}

        Walk-forward подбор параметров под конкретный тикер, БЕЗ заглядывания в
        будущее и без подгонки на тех же данных, где применяется:
          • история делится на N_folds последовательных блоков;
          • на каждом тест-фолде вариант выбирается ТОЛЬКО по прошлым барам
            (in-sample IG на [начало, граница фолда));
          • качество выбранного меряется на СЛЕДУЮЩЕМ, невиданном блоке (OOS);
          • адаптация принимается лишь если OOS-IG устойчиво (нижняя доверит.
            граница) превосходит классику — иначе честно откатываемся на дефолт;
          • принятая адаптация не заменяет дефолт целиком, а усаживается к нему
            (λ) пропорционально силе и стабильности OOS-преимущества.
        Для многих тикеров честный ответ — «default»: адаптация не обобщилась.
        """
        import datetime
        from collections import Counter

        n = len(candles_raw)
        min_needed = self._window + HORIZON_MAX + CALIB_MIN_BARS + CALIB_FOLD_TARGET_LEN
        if n < min_needed:
            logger.info(f"{ticker}: мало свечей для method calibration ({n} < {min_needed}), пропуск")
            return

        closes = [c["close"] for c in candles_raw]
        highs  = [c["high"]  for c in candles_raw]
        lows   = [c["low"]   for c in candles_raw]
        atr_frac = _atr_frac_series(highs, lows, closes)   # причинный ATR/цена
        today = datetime.date.today().isoformat()
        result = {}

        eval_start = self._window
        span = n - eval_start
        usable = span - HORIZON_MAX
        n_folds = max(CALIB_FOLDS_MIN, min(CALIB_FOLDS_MAX, usable // CALIB_FOLD_TARGET_LEN))
        bounds = [eval_start + round(span * k / n_folds) for k in range(n_folds + 1)]

        for method_name, candidates in TUNABLE_REGISTRY.items():
            ci = _classic_index(method_name, candidates)

            # Предвычисляем причинные серии всех вариантов один раз (классика+alt).
            variants = []
            for idx, (label, fn, params) in enumerate(candidates):
                scores = _score_series(fn, candles_raw, self._window)
                H = _horizon_for_params(params)
                variants.append({"idx": idx, "label": label, "params": params,
                                 "use_alt": False, "series": scores, "H": H})
                variants.append({"idx": idx, "label": label, "params": params,
                                 "use_alt": True,
                                 "series": _apply_alt_to_scores(scores, closes), "H": H})
            classic = next(v for v in variants if v["idx"] == ci and not v["use_alt"])
            # Масштаб хода инструмента (для per-ticker λ), по классическому H.
            vol_ref = _vol_ref(closes, classic["H"], eval_start, n)

            oos_chosen: list[float] = []
            oos_classic: list[float] = []
            picks: list[tuple] = []
            for k in range(1, n_folds):
                bound = bounds[k]                               # граница прошлое|тест
                test_hi = bounds[k + 1]                         # конец тест-блока
                # Отбор по in-sample expectancy на прошлом. КРИТИЧНО: исход сигнала
                # — closes[i+H], поэтому окно отбора обрезаем на H баров ДО границы
                # (hi = bound − H у каждого варианта его собственным H), иначе
                # исходы последних сигналов залезали бы на H баров в тест-блок —
                # то самое пересечение окна подбора и проверки. Тест-блок,
                # симметрично, начинаем с bound (его первые сигналы дают исход в
                # [bound, ...) — уже строго после границы отбора).
                best = None
                best_edge = -1e9
                for v in variants:
                    ed, tot = _edge_range(v["series"], closes, highs, lows, atr_frac,
                                          v["H"], eval_start, bound - v["H"])
                    if ed is None or tot < CALIB_MIN_BARS:
                        continue
                    if ed > best_edge:
                        best_edge = ed
                        best = v
                if best is None:
                    continue
                ig_ch, tot_ch = _edge_range(best["series"], closes, highs, lows, atr_frac,
                                            best["H"], bound, test_hi)
                ig_bs, tot_bs = _edge_range(classic["series"], closes, highs, lows, atr_frac,
                                            classic["H"], bound, test_hi)
                if ig_ch is None or ig_bs is None or tot_ch < CALIB_FOLD_MIN_OBS:
                    continue
                oos_chosen.append(ig_ch)
                oos_classic.append(ig_bs)
                picks.append((best["idx"], best["use_alt"]))

            result[method_name] = self._finalize_method(
                method_name, candidates, ci, classic,
                oos_chosen, oos_classic, picks, today, Counter, vol_ref,
                n_variants=len(variants),
            )
            e = result[method_name]
            logger.info(
                f"{ticker}/{method_name}: {e['label']} alt={e['use_alt']} "
                f"OOS-edge={e['edge']*1e4:.1f}бп vs классика={e.get('edge_classic', 0)*1e4:.1f}бп "
                f"λ={e.get('shrink', 0):.2f} фолдов={e.get('folds', 0)}"
            )

        self._data[ticker] = result
        self._save()

    def _finalize_method(self, method_name, candidates, ci, classic,
                          oos_chosen, oos_classic, picks, today, Counter, vol_ref,
                          n_variants=8):
        """Решение по методу: адаптировать (с усадкой λ) или откатиться на дефолт.
        Всё в edge-пространстве (expectancy на сигнал, доля). Критерии принятия
        собраны здесь."""
        default_entry = {"params": {}, "use_alt": False, "edge": 0.0, "edge_classic": 0.0,
                         "horizon": 10, "label": "default", "base_label": classic["label"],
                         "shrink": 0.0, "folds": len(oos_chosen),
                         "consistency": 0.0, "updated": today}
        if len(oos_chosen) < 2:
            return default_entry

        mean_ch, se_ch = _mean_se(oos_chosen)
        mean_bs, _ = _mean_se(oos_classic)
        diffs = [a - b for a, b in zip(oos_chosen, oos_classic)]
        mean_d, se_d = _mean_se(diffs)               # ПАРНАЯ разница OOS-edge (по фолдам)
        consistency = sum(1 for d in diffs if d > 0) / len(diffs)
        lcb_chosen = mean_ch - CALIB_LCB_Z * se_ch   # OOS-edge выбранного значимо > 0
        lcb_diff   = mean_d - CALIB_LCB_Z * se_d      # преимущество над классикой значимо > 0
        improvement = mean_d

        # Мода выбора по фолдам — стабильный, walk-forward-подтверждённый вариант.
        (pick_idx, pick_alt), _pick_cnt = Counter(picks).most_common(1)[0]

        # Ключевой гейт — чисто статистический, без абсолютных «магических» порогов:
        #   • парный нижний предел разницы «выбранный − классика» по фолдам > 0
        #     (устойчиво обходит классику вне выборки после издержек), И
        #   • собственный нижний предел expectancy выбранного > 0 (net-положителен
        #     после издержек значимо), И
        #   • согласованность по фолдам ≥ порога.
        # Поправка на множественные сравнения (портировано из indlab): чем больше
        # вариантов в сетке — тем строже порог парного преимущества. У KLINGER 4
        # пары (fast,slow), у RMI 5 пар (period,momentum) + alt-версии = 8–10
        # вариантов; при базовой сетке ~8 mc_mult=1. У методов побольше (например,
        # если добавят двумерную сетку) — порог автоматически ужесточается.
        mc_mult = max(1.0, n_variants / 8.0)
        accept = (
            lcb_diff > CALIB_IMPROVE_FRAC * vol_ref * mc_mult
            and lcb_chosen > CALIB_EDGE_FRAC * vol_ref
            and consistency >= CALIB_MIN_CONSISTENCY
            and not (pick_idx == ci and not pick_alt)   # «выбрали классику» = не адаптация
        )
        if not accept:
            default_entry["edge"] = round(mean_ch, 6)
            default_entry["edge_classic"] = round(mean_bs, 6)
            default_entry["consistency"] = round(consistency, 2)
            return default_entry

        label, _, params = candidates[pick_idx]
        # λ: улучшение в единицах собственной H-барной волатильности инструмента
        # (per-ticker, а не абсолютная доля), приглушённое стабильностью по фолдам.
        scale = max(vol_ref * 0.5, 1e-6)
        lam = max(0.0, min(1.0, improvement / scale)) * consistency
        return {
            "params":      params,
            "use_alt":     pick_alt,
            "edge":        round(mean_ch, 6),
            "edge_classic": round(mean_bs, 6),
            "horizon":     _horizon_for_params(params),
            "label":       label,
            "base_label":  classic["label"],
            "shrink":      round(lam, 3),
            "folds":       len(oos_chosen),
            "consistency": round(consistency, 2),
            "updated":     today,
        }

    def get_fn(self, ticker: str, method_name: str) -> Optional[Callable]:
        """
        Возвращает калиброванную функцию (closes, highs, lows, vols) -> float
        для тикера/метода, УЖЕ усаженную к классике (λ), или None если адаптация
        не принята (стратегия возьмёт дефолт). λ=1 → чистая калибровка,
        0<λ<1 → блендинг калибровки с классикой, λ≤0 → как дефолт (None).
        """
        entry = self._data.get(ticker, {}).get(method_name)
        if entry is None or entry.get("label") == "default":
            return None

        label = entry["label"]
        lam = float(entry.get("shrink", 1.0))
        if lam <= 0.001:
            return None  # усадка увела адаптацию к нулю — это и есть дефолт

        # Кэш стабильной fn: пересобираем только при смене записи (sig).
        sig = (label, bool(entry.get("use_alt")), round(lam, 3), entry.get("base_label"))
        cached = self._fn_cache.get((ticker, method_name))
        if cached is not None and cached[0] == sig:
            return cached[1]

        candidates = TUNABLE_REGISTRY.get(method_name, [])
        by_label = {lbl: fn for lbl, fn, _ in candidates}
        base_fn = by_label.get(label)
        if base_fn is None:
            return None
        chosen_fn = _make_alt_fn(base_fn) if entry.get("use_alt") else base_fn

        classic_fn = by_label.get(entry.get("base_label"))
        if classic_fn is None or lam >= 0.999:
            built = chosen_fn  # некуда усаживать или усадка полная
        else:
            built = _blend_fn(chosen_fn, classic_fn, lam)
        self._fn_cache[(ticker, method_name)] = (sig, built)
        return built

    def get_params(self, ticker: str, method_name: str) -> dict:
        """Только параметры (без fn) — для логов/диагностики."""
        entry = self._data.get(ticker, {}).get(method_name, {})
        return {
            "params":      entry.get("params", {}),
            "use_alt":     entry.get("use_alt", False),
            "edge":        entry.get("edge", 0.0),
            "edge_classic": entry.get("edge_classic", 0.0),
            "horizon":     entry.get("horizon", 10),
            "label":       entry.get("label", "default"),
            "shrink":      entry.get("shrink", 0.0),
            "consistency": entry.get("consistency", 0.0),
            "folds":       entry.get("folds", 0),
        }

    def summary(self, ticker: str) -> dict:
        """Сводка по всем методам для тикера — для диагностики."""
        return {m: self.get_params(ticker, m)
                for m in TUNABLE_REGISTRY
                if ticker in self._data and m in self._data[ticker]}

    def report(self) -> dict:
        """Диагностика калибровки на РЕАЛЬНЫХ данных (из method_params.json):
        по каждому тикеру — что адаптировалось, OOS-edge выбранного vs классики
        (в базисных пунктах), улучшение, усадка λ, согласованность по фолдам,
        горизонт, дата. Для дашборда — чтобы глазами оценить, осмысленны ли
        адаптации на живом рынке. edge* могут отсутствовать у записей старой
        схемы (до перехода на expectancy) — тогда None."""
        out = {}
        for ticker, methods in self._data.items():
            rows = []
            for m, e in methods.items():
                edge = e.get("edge")
                edge_c = e.get("edge_classic")
                improve = (edge - edge_c) * 1e4 if (edge is not None and edge_c is not None) else None
                rows.append({
                    "method":       m,
                    "adapted":      e.get("label", "default") != "default",
                    "label":        e.get("label", "default"),
                    "params":       e.get("params", {}),
                    "use_alt":      e.get("use_alt", False),
                    "edge_bp":      round(edge * 1e4, 1) if edge is not None else None,
                    "edge_classic_bp": round(edge_c * 1e4, 1) if edge_c is not None else None,
                    "improve_bp":   round(improve, 1) if improve is not None else None,
                    "shrink":       e.get("shrink", 0.0),
                    "consistency":  e.get("consistency", 0.0),
                    "folds":        e.get("folds", 0),
                    "horizon":      e.get("horizon", 0),
                    "updated":      e.get("updated", ""),
                })
            # Адаптированные сверху, внутри — по убыванию улучшения над классикой.
            rows.sort(key=lambda r: (not r["adapted"], -(r["improve_bp"] or -1e9)))
            out[ticker] = rows
        return out
