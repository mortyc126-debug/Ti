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

# Горизонты для оценки точности (в барах)
CALIB_HORIZONS = [5, 10, 15, 20]
# Минимальный information gain чтобы принять candidate vs default
CALIB_MIN_IG = 0.02
# Минимум баров для оценки
CALIB_MIN_BARS = 30
# Пересчёт раз в N дней
CALIB_RECALC_DAYS = 7


# ─── Параметрические фабрики ──────────────────────────────────────────────────
# Каждая фабрика возвращает функцию (closes, highs, lows, volumes) -> float
# с нужными параметрами. Все принимают raw float-списки, не HistoricCandle.

def _factory_fisher_rsi(period: int):
    from indicators_ehlers import fisher_rsi as _fisher_rsi

    def fn(closes, highs, lows, volumes):
        n = len(closes)
        if n < period + 5:
            return 0.0
        p = min(period, n - 1)
        fr = _fisher_rsi(closes, period=p)
        if len(fr) < 5:
            return 0.0
        v, prev = fr[-1], fr[-2]
        EXTREME = 1.8
        at_top = v > EXTREME
        at_bottom = v < -EXTREME
        turning_down = at_top and v < prev
        turning_up = at_bottom and v > prev
        if turning_down:
            return -min(1.0, abs(v) / 3.0)
        if turning_up:
            return min(1.0, abs(v) / 3.0)
        if at_top:
            return -0.4
        if at_bottom:
            return 0.4
        # дивергенция
        lb = min(p, n - 1)
        price_move = closes[-1] - closes[-lb]
        fr_move = fr[-1] - fr[-lb]
        if price_move > 0 and fr_move < 0:
            return -0.5
        if price_move < 0 and fr_move > 0:
            return 0.5
        return 0.0

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


def _accuracy(scores: list[Optional[float]], closes: list[float],
               horizon: int) -> tuple[float, float, int]:
    """
    accuracy = доля баров где sign(score)==sign(close[i+H]-close[i]).
    Возвращает (accuracy, baseRate, n).
    """
    n = len(closes)
    win = 0
    total = 0
    up_total = 0
    base_n = 0
    for i in range(n - horizon):
        s = scores[i]
        fut = closes[i + horizon] - closes[i]
        if fut == 0:
            continue
        base_n += 1
        if closes[i + horizon] > closes[i]:
            up_total += 1
        if s is None or s == 0.0:
            continue
        total += 1
        if (s > 0 and fut > 0) or (s < 0 and fut < 0):
            win += 1
    acc = win / total if total >= CALIB_MIN_BARS else None
    base = up_total / base_n if base_n > 0 else 0.5
    return acc, base, total


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
        Запускает подбор параметров по всем TUNABLE_REGISTRY методам.
        """
        import datetime
        n = len(candles_raw)
        if n < self._window + max(CALIB_HORIZONS) + CALIB_MIN_BARS:
            logger.info(f"{ticker}: мало свечей для method calibration ({n}), пропуск")
            return

        closes = [c["close"] for c in candles_raw]
        today = datetime.date.today().isoformat()
        result = {}

        for method_name, candidates in TUNABLE_REGISTRY.items():
            best_ig = -1.0
            best_label = None
            best_params = {}
            best_use_alt = False
            best_horizon = CALIB_HORIZONS[0]

            for label, fn, params in candidates:
                scores = _score_series(fn, candles_raw, self._window)
                scores_alt = _apply_alt_to_scores(scores, closes)

                for H in CALIB_HORIZONS:
                    # классика
                    acc, base, n_obs = _accuracy(scores, closes, H)
                    if acc is not None:
                        ig = acc - base
                        if ig > best_ig:
                            best_ig = ig
                            best_label = label
                            best_params = params
                            best_use_alt = False
                            best_horizon = H

                    # alt
                    acc_alt, base_alt, n_alt = _accuracy(scores_alt, closes, H)
                    if acc_alt is not None:
                        ig_alt = acc_alt - base_alt
                        if ig_alt > best_ig:
                            best_ig = ig_alt
                            best_label = label
                            best_params = params
                            best_use_alt = True
                            best_horizon = H

            if best_label is not None and best_ig >= CALIB_MIN_IG:
                result[method_name] = {
                    "params":    best_params,
                    "use_alt":   best_use_alt,
                    "ig":        round(best_ig, 4),
                    "horizon":   best_horizon,
                    "label":     best_label,
                    "updated":   today,
                }
                logger.info(
                    f"{ticker}/{method_name}: best={best_label} alt={best_use_alt} "
                    f"ig={best_ig:.3f} H={best_horizon}"
                )
            else:
                # не нашли ничего лучше дефолта — сохраняем дефолт чтобы не пересчитывать
                result[method_name] = {"params": {}, "use_alt": False,
                                       "ig": 0.0, "horizon": 10,
                                       "label": "default", "updated": today}

        self._data[ticker] = result
        self._save()

    def get_fn(self, ticker: str, method_name: str) -> Optional[Callable]:
        """
        Возвращает лучшую функцию (closes, highs, lows, vols) -> float
        для данного тикера/метода, или None если метод не в реестре.
        """
        entry = self._data.get(ticker, {}).get(method_name)
        if entry is None or entry.get("label") == "default":
            return None  # стратегия будет использовать дефолтную реализацию

        candidates = TUNABLE_REGISTRY.get(method_name, [])
        label = entry["label"]
        for lbl, fn, params in candidates:
            if lbl == label:
                if entry.get("use_alt"):
                    # оборачиваем в alt-трансформацию
                    def make_alt_fn(base_fn, lookback=10):
                        _score_buf: list[float] = []
                        _close_buf: list[float] = []

                        def alt_fn(closes, highs, lows, vols):
                            s = base_fn(closes, highs, lows, vols)
                            _score_buf.append(s if s is not None else 0.0)
                            _close_buf.append(closes[-1] if closes else 0.0)
                            if len(_score_buf) < lookback:
                                return s or 0.0
                            alt_scores = _apply_alt_to_scores(
                                _score_buf[-lookback - 1:], _close_buf[-lookback - 1:],
                                lookback=lookback
                            )
                            return alt_scores[-1]

                        return alt_fn

                    return make_alt_fn(fn)
                return fn
        return None

    def get_params(self, ticker: str, method_name: str) -> dict:
        """Только параметры (без fn) — для логов/диагностики."""
        entry = self._data.get(ticker, {}).get(method_name, {})
        return {
            "params":  entry.get("params", {}),
            "use_alt": entry.get("use_alt", False),
            "ig":      entry.get("ig", 0.0),
            "horizon": entry.get("horizon", 10),
            "label":   entry.get("label", "default"),
        }

    def summary(self, ticker: str) -> dict:
        """Сводка по всем методам для тикера — для диагностики."""
        return {m: self.get_params(ticker, m)
                for m in TUNABLE_REGISTRY
                if ticker in self._data and m in self._data[ticker]}
