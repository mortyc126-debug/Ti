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
# Минимальный OOS information gain (acc − baseRate) чтобы вообще принять
# адаптацию вместо дефолта. Порог по НИЖНЕЙ границе (LCB), не по точечной оценке.
CALIB_MIN_IG = 0.02
# Минимальное превышение OOS-IG адаптации над классикой, чтобы менять дефолт.
CALIB_MIN_IMPROVE = 0.01
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
# Масштаб усадки: OOS-улучшение в 5 п.п. над классикой → полная (λ=1) замена.
# Меньшее улучшение → пропорционально меньшая усадка к калиброванной функции.
CALIB_SHRINK_SCALE = 0.05
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


def _ig_range(scores: list[Optional[float]], closes: list[float],
              horizon: int, lo: int, hi: int) -> tuple[Optional[float], int]:
    """
    Information gain (acc − baseRate) в диапазоне баров [lo, hi).
    acc = доля баров с ненулевым скором, где знак совпал с ходом цены через H.
    baseRate = доля баров, где цена вообще выросла за H (защита от тренда: в
    аптренде «всегда покупать» даёт высокий acc без единой закономерности).
    Причинно: исход берётся из close[i+H], i+H строго < hi (капается ниже) —
    никакого заглядывания за границу тест-фолда сверх собственного горизонта.
    Возвращает (ig | None, число сработавших сигналов).
    """
    n = len(closes)
    hi = min(hi, n - horizon)
    win = 0
    total = 0
    up_total = 0
    base_n = 0
    for i in range(max(0, lo), hi):
        fut = closes[i + horizon] - closes[i]
        if fut == 0:
            continue
        base_n += 1
        if fut > 0:
            up_total += 1
        s = scores[i]
        if s is None or s == 0.0:
            continue
        total += 1
        if (s > 0 and fut > 0) or (s < 0 and fut < 0):
            win += 1
    if base_n == 0:
        return None, 0
    base = up_total / base_n
    if total == 0:
        return None, 0
    return (win / total) - base, total


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

            oos_chosen: list[float] = []
            oos_classic: list[float] = []
            picks: list[tuple] = []
            for k in range(1, n_folds):
                bound = bounds[k]                               # граница прошлое|тест
                test_hi = bounds[k + 1]                         # конец тест-блока
                # Отбор по in-sample IG на прошлом. КРИТИЧНО: исход сигнала —
                # closes[i+H], поэтому окно отбора обрезаем на H баров ДО границы
                # (hi = bound − H у каждого варианта его собственным H), иначе
                # исходы последних сигналов залезали бы на H баров в тест-блок —
                # то самое пересечение окна подбора и проверки. Тест-блок,
                # симметрично, начинаем с bound (его первые сигналы дают исход в
                # [bound, ...) — уже строго после границы отбора).
                best = None
                best_ig = -1e9
                for v in variants:
                    ig, tot = _ig_range(v["series"], closes, v["H"], eval_start, bound - v["H"])
                    if ig is None or tot < CALIB_MIN_BARS:
                        continue
                    if ig > best_ig:
                        best_ig = ig
                        best = v
                if best is None:
                    continue
                ig_ch, tot_ch = _ig_range(best["series"], closes, best["H"], bound, test_hi)
                ig_bs, tot_bs = _ig_range(classic["series"], closes, classic["H"], bound, test_hi)
                if ig_ch is None or ig_bs is None or tot_ch < CALIB_FOLD_MIN_OBS:
                    continue
                oos_chosen.append(ig_ch)
                oos_classic.append(ig_bs)
                picks.append((best["idx"], best["use_alt"]))

            result[method_name] = self._finalize_method(
                method_name, candidates, ci, classic,
                oos_chosen, oos_classic, picks, today, Counter,
            )
            e = result[method_name]
            logger.info(
                f"{ticker}/{method_name}: {e['label']} alt={e['use_alt']} "
                f"OOS-IG={e['ig']:.3f} vs классика={e.get('ig_classic', 0):.3f} "
                f"λ={e.get('shrink', 0):.2f} фолдов={e.get('folds', 0)}"
            )

        self._data[ticker] = result
        self._save()

    def _finalize_method(self, method_name, candidates, ci, classic,
                          oos_chosen, oos_classic, picks, today, Counter):
        """Решение по методу: адаптировать (с усадкой λ) или откатиться на дефолт.
        Отдельный метод — чтобы calibrate читался как процесс, а критерии
        принятия были в одном месте."""
        default_entry = {"params": {}, "use_alt": False, "ig": 0.0, "ig_classic": 0.0,
                         "horizon": 10, "label": "default", "base_label": classic["label"],
                         "shrink": 0.0, "folds": len(oos_chosen),
                         "consistency": 0.0, "updated": today}
        if len(oos_chosen) < 2:
            return default_entry

        mean_ch, se_ch = _mean_se(oos_chosen)
        mean_bs, _ = _mean_se(oos_classic)
        diffs = [a - b for a, b in zip(oos_chosen, oos_classic)]
        mean_d, se_d = _mean_se(diffs)               # ПАРНАЯ разница OOS (по фолдам)
        consistency = sum(1 for d in diffs if d > 0) / len(diffs)
        lcb_chosen = mean_ch - CALIB_LCB_Z * se_ch   # OOS-IG выбранного значимо > 0
        lcb_diff   = mean_d - CALIB_LCB_Z * se_d      # преимущество над классикой значимо > 0
        improvement = mean_d

        # Мода выбора по фолдам — стабильный, walk-forward-подтверждённый вариант.
        (pick_idx, pick_alt), _pick_cnt = Counter(picks).most_common(1)[0]

        # Ключевой гейт — ПАРНЫЙ нижний доверит. предел разницы «выбранный минус
        # классика» по фолдам: он должен быть > порога. Это прямо проверяет
        # «выбранный устойчиво обходит классику вне выборки», а не «у обоих
        # средний IG случайно положительный». На multi-seed шуме именно этот
        # тест давит ложные адаптации до ~0 (раздельные средние — нет).
        accept = (
            lcb_diff > CALIB_MIN_IMPROVE
            and lcb_chosen >= CALIB_MIN_IG
            and consistency >= CALIB_MIN_CONSISTENCY
            and not (pick_idx == ci and not pick_alt)   # «выбрали классику» = не адаптация
        )
        if not accept:
            default_entry["ig"] = round(mean_ch, 4)
            default_entry["ig_classic"] = round(mean_bs, 4)
            default_entry["consistency"] = round(consistency, 2)
            return default_entry

        label, _, params = candidates[pick_idx]
        # λ: сила эффекта (парное улучшение/scale), приглушённая его стабильностью.
        lam = max(0.0, min(1.0, improvement / CALIB_SHRINK_SCALE)) * consistency
        return {
            "params":      params,
            "use_alt":     pick_alt,
            "ig":          round(mean_ch, 4),
            "ig_classic":  round(mean_bs, 4),
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
            "ig":          entry.get("ig", 0.0),
            "ig_classic":  entry.get("ig_classic", 0.0),
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
