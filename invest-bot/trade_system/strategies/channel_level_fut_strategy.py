"""ChannelLevelFutStrategy — live-обёртка находки сессии channel_level_fut.

Сигнал: fade от кластер-уровня во флэте (ER<0.35) + гейт 5 методами расширения
(donchian+twiggs+klinger согласны по направлению, liq_sweep+fractional_diff не
против). Брекет 2.0/1.0 ATR (R:R 2:1). Только фьючерсы, 1ч ТФ.

Формулы БИТ-В-БИТ те же, что валидировались: считаем через Node-мост
run_signals_core.js → tv-signals-extension/signals-core.js (метод
M.channel_level_fut), без повторного набора логики в Python — исключает дрейф.
Мост зовётся раз на analyze_candles (в лайве ~раз в час на инструмент — дёшево).

Валидация (channels_lab_validate.py, 22 ликв. фьючерса, agg=12=1ч, train/test
split, ЧЕСТНЫЙ рыночный вход next_open, cost 0.12):
  TRAIN +0.262 / TEST +0.518 ATR/сделку, 14/19 фьючей в плюсе, все свежие
  кварталы плюс. Пережил тот же fill-гейт (§13), что убил уровневый комбо бота.
Оговорка: тонкая выборка (test n≈82, один 2026) — гнать ТОЛЬКО в sandbox до
форвард-подтверждения.

Вход РЫНОЧНЫЙ (entry_price=0): увидели сигнал на close бара — берём по рынку на
след. баре (лимиткой у уровня не зайти). Барьеры от цены входа, интрабар.
Условие полностью backward-looking (метод стартует уровни с lag, на последнем
баре смотрит только закрытые данные) — look-ahead'а нет.
"""
from __future__ import annotations

import json
import logging
import os
import subprocess
from decimal import Decimal
from typing import Optional

from tinkoff.invest import HistoricCandle
from tinkoff.invest.utils import quotation_to_decimal

from trade_system.signal import Signal, SignalType
from trade_system.strategies.base_strategy import IStrategy

__all__ = ("ChannelLevelFutStrategy",)

logger = logging.getLogger(__name__)

# Путь к Node-мосту (invest-bot/run_signals_core.js) от этого файла.
_BRIDGE = os.path.normpath(os.path.join(os.path.dirname(__file__), "..", "..",
                                        "run_signals_core.js"))
_METHOD = "channel_level_fut"
_ATR_PER = 14                 # как в channels_lab (atr_series(bars,14))
_TAKE_ATR = 2.0               # дефолт брекета, если мост не вернул свой
_STOP_ATR = 1.0
# Метод валидирован на 1ч (agg=12 от 5м). Трейдер стримит только 1/5-мин
# (trader._imap), часового нет → агрегируем в 1ч ВНУТРИ по часам стенных
# часов (open=первый, high=max, low=min, close=последний, volume=сумма).
_MIN_HOURLY_BARS = 280        # методу нужно W3=200 + ER(60) + пивоты
_MAX_RAW_BARS = 6000          # сырой 5-мин буфер (~20 торговых дней 1ч истории)


def _candle_to_bar(c: HistoricCandle) -> dict:
    return {
        "t": c.time,
        "o": float(quotation_to_decimal(c.open)),
        "h": float(quotation_to_decimal(c.high)),
        "l": float(quotation_to_decimal(c.low)),
        "c": float(quotation_to_decimal(c.close)),
        "v": float(c.volume),
    }


def _atr_last(bars: list[dict], per: int) -> Optional[float]:
    # ATR = SMA(TR, per) на последнем баре (та же формула, что atr_series в
    # channels_lab). None, если истории не хватает.
    n = len(bars)
    if n < per + 1:
        return None
    tr_sum = 0.0
    for k in range(n - per, n):
        h, l = bars[k]["h"], bars[k]["l"]
        pc = bars[k - 1]["c"]
        tr_sum += max(h - l, abs(h - pc), abs(l - pc))
    return tr_sum / per


def _hourly(raw: list[dict]) -> list[dict]:
    """Агрегация сырых (5-мин) баров в 1ч по стенным часам. Возвращает ТОЛЬКО
    ЗАКРЫТЫЕ часы — последний (текущий формирующийся) час отбрасываем, чтобы не
    торговать по недосформированной свече. Ключ часа = (год,мес,день,час) из t."""
    if not raw:
        return []
    groups = []  # [(key, bar1h)]
    cur_key = None
    for b in raw:
        t = b["t"]
        key = (t.year, t.month, t.day, t.hour)
        if key != cur_key:
            groups.append([key, {"t": t, "o": b["o"], "h": b["h"], "l": b["l"],
                                 "c": b["c"], "v": b["v"]}])
            cur_key = key
        else:
            g = groups[-1][1]
            g["h"] = max(g["h"], b["h"]); g["l"] = min(g["l"], b["l"])
            g["c"] = b["c"]; g["v"] += b["v"]
    # последний час ещё формируется → отбрасываем
    return [g[1] for g in groups[:-1]]


def _bridge_last(bars: list[dict]) -> tuple:
    """Гоним буфер через Node-мост, возвращаем (score, bracket) на ПОСЛЕДНЕМ баре.
    При любой ошибке → (0, None): нет сигнала (безопасный дефолт, не торгуем)."""
    payload = json.dumps([{"open": b["o"], "high": b["h"], "low": b["l"],
                           "close": b["c"], "volume": b["v"]} for b in bars])
    try:
        p = subprocess.run(["node", _BRIDGE], input=payload, capture_output=True,
                           text=True, timeout=60)
        if p.returncode != 0:
            logger.warning("ChannelLevelFut: мост вернул код %d: %s", p.returncode,
                           (p.stderr or "")[:200])
            return 0, None
        out = json.loads(p.stdout)
        sc = out.get("scores", {}).get(_METHOD) or []
        br = out.get("brackets", {}).get(_METHOD) or []
        score = sc[-1] if sc else 0
        bracket = br[-1] if br else None
        return (score or 0), bracket
    except Exception as e:
        logger.warning("ChannelLevelFut: вызов моста не удался (%s)", e)
        return 0, None


class ChannelLevelFutStrategy(IStrategy):
    def __init__(self, settings=None) -> None:
        self._settings = settings
        self._bars: list[dict] = []
        self._short_enabled: bool = getattr(settings, "short_enabled_flag", True) if settings else True
        self._lot: int = 1
        self._hist_provider = None
        self._warmed: bool = False
        self._last_signal_t = None   # один бар-сигнал не эмитим дважды

    @property
    def settings(self):
        return self._settings

    def update_lot_count(self, lot: int) -> None:
        self._lot = lot

    def update_short_status(self, status: bool) -> None:
        self._short_enabled = status

    def set_atr_history_provider(self, provider) -> None:
        # тот же хук прогрева, что у accel/level — торгуем со старта, без тишины
        self._hist_provider = provider

    def _append(self, c: HistoricCandle) -> None:
        b = _candle_to_bar(c)
        if self._bars and b["t"] <= self._bars[-1]["t"]:
            return
        self._bars.append(b)

    def _warmup(self) -> None:
        self._warmed = True
        if not self._hist_provider or not self._settings:
            return
        try:
            hist = self._hist_provider(getattr(self._settings, "ticker", "")) or []
        except Exception as e:
            logger.warning("ChannelLevelFut: прогрев истории не удался (%s)", e)
            return
        for c in sorted(hist, key=lambda x: x.time):
            self._append(c)
        if len(self._bars) > _MAX_RAW_BARS:
            self._bars = self._bars[-_MAX_RAW_BARS:]
        logger.info("ChannelLevelFutStrategy: буфер прогрет историей — %d баров "
                    "(5-мин), 1ч=%d", len(self._bars), len(_hourly(self._bars)))

    def analyze_candles(self, candles: list[HistoricCandle]) -> Optional[Signal]:
        if not self._warmed:
            self._warmup()
        for c in candles:
            self._append(c)
        if len(self._bars) > _MAX_RAW_BARS:
            self._bars = self._bars[-_MAX_RAW_BARS:]

        # агрегируем 5-мин → 1ч (только закрытые часы) — метод валидирован на 1ч
        h1 = _hourly(self._bars)
        if len(h1) < _MIN_HOURLY_BARS:
            return None

        score, bracket = _bridge_last(h1)
        if not score:
            return None
        atr = _atr_last(h1, _ATR_PER)
        if not atr or atr <= 0:
            return None

        i = len(h1) - 1
        t_now = h1[i]["t"]   # время последнего ЗАКРЫТОГО часа
        if self._last_signal_t is not None and t_now <= self._last_signal_t:
            return None

        dir_ = 1 if score > 0 else -1
        side_long = dir_ > 0
        if not side_long and not self._short_enabled:
            return None

        take_atr = float(bracket["take"]) if bracket and "take" in bracket else _TAKE_ATR
        stop_atr = float(bracket["stop"]) if bracket and "stop" in bracket else _STOP_ATR
        entry = Decimal(str(h1[i]["c"]))
        atr_d = Decimal(str(atr))
        take = Decimal(str(take_atr)) * atr_d
        stop = Decimal(str(stop_atr)) * atr_d
        if side_long:
            stype, tp, sl = SignalType.LONG, entry + take, entry - stop
        else:
            stype, tp, sl = SignalType.SHORT, entry - take, entry + stop

        self._last_signal_t = t_now
        figi = getattr(self._settings, "figi", "") if self._settings else ""
        # entry_price=0 (default) → вход РЫНКОМ (лимиткой у уровня не зайти).
        signal = Signal(figi=figi, signal_type=stype,
                        take_profit_level=tp, stop_loss_level=sl)
        logger.info("ChannelLevelFut signal: %s entry=%.6f dir=%d take=%.2f stop=%.2f "
                    "atr=%.6f", signal, h1[i]["c"], dir_, take_atr, stop_atr, atr)
        return signal
