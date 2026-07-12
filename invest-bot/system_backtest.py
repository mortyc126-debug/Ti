"""system_backtest.py — «системный прогон»: оценка ЖИВОЙ раскладки стратегий
(composite + accel + NW) в одном месте, каждый тикер через СВОЮ стратегию.

Зачем: дашборд-бэктест всегда гоняет OICompositeStrategy, а живой бот теперь
раздаёт стратегии per-ticker ([FUTURES_STRATEGY_MAP]: IRAO/PLZL→NW, остальное→
accel по STRATEGY_OVERRIDE). Чтобы оценить систему цельно, тикер надо
прогонять через ту же стратегию, которой он торгует вживую.

Composite умеет свой backtest_barriers (родной путь дашборда). Accel/NW имеют
только analyze_candles+Signal — для них тут обобщённый бар-за-баром симулятор:
прогрев истории → на каждом баре тестового окна analyze_candles → вход по
Signal, выход интрабар по тейк/стопу ИЛИ по CLOSE (срочный выход NW), без
перекрытия (одна позиция на инструмент). Метрика — экспектанси в ATR, winrate,
N. Тест считается на held-out окне (прогрев = train, сигналы = OOS).

Чистый модуль без сети/дашборда: `simulate_analyze_strategy` и
`live_strategy_name` тестируются на синтетике. Оркестрация (грузит свечи,
диспетчерит composite↔generic) — в dashboard.py, зовёт отсюда.
"""
from __future__ import annotations

from typing import Callable, Optional

try:
    from tinkoff.invest.utils import quotation_to_decimal

    def _f(q) -> float:
        return float(quotation_to_decimal(q))
except Exception:  # на всякий: голый Quotation units/nano
    def _f(q) -> float:
        try:
            return float(q.units) + float(q.nano) / 1e9
        except AttributeError:
            return float(q)


def live_strategy_name(ticker: str, base_ticker: Optional[str],
                       strategy_map: dict, strategy_override: str,
                       default: str = "OICompositeStrategy") -> str:
    """Имя стратегии, которой тикер торгует ВЖИВУЮ. Приоритет ровно как в
    trader.__build_futures_strategies: карта(base) > override > дефолт.
    base_ticker — базовый актив фьючерса (для акций = сам ticker)."""
    key = (base_ticker or ticker or "").upper()
    return (strategy_map or {}).get(key) or strategy_override or default


def _atr_series(candles: list, n: int = 20) -> list[float]:
    """ATR (простое скользящее TR) по свечам. [i] = NaN до прогрева окна."""
    highs = [_f(c.high) for c in candles]
    lows = [_f(c.low) for c in candles]
    closes = [_f(c.close) for c in candles]
    trs = []
    for i in range(len(candles)):
        pc = closes[i - 1] if i > 0 else closes[0]
        trs.append(max(highs[i] - lows[i], abs(highs[i] - pc), abs(lows[i] - pc)))
    out = [float("nan")] * len(candles)
    run = 0.0
    for i in range(len(candles)):
        run += trs[i]
        if i >= n:
            run -= trs[i - n]
        if i >= n - 1:
            out[i] = run / n
    return out


# Тип сигнала: 0=LONG 1=SHORT 2=CLOSE (совпадает с trade_system.signal.SignalType)
_LONG, _SHORT, _CLOSE = 0, 1, 2


def simulate_analyze_strategy(
        strategy, candles: list, split_idx: int,
        cost_atr: float = 0.12, atr_period: int = 20,
        history_provider: Optional[Callable] = None,
) -> dict:
    """Бар-за-баром симуляция стратегии на analyze_candles.

    - candles[:split_idx] — прогрев (train): отдаётся стратегии как история
      (set_atr_history_provider), сделки НЕ считаются;
    - candles[split_idx:] — тест (OOS): на каждом баре зовём analyze_candles,
      входим по LONG/SHORT, держим до тейк/стопа (интрабар) или CLOSE, без
      перекрытия. PnL в единицах ATR входа за вычетом cost_atr.

    Возвращает {n, win, exp_atr, wins, trades:[...]}. n=0 если сделок нет.
    """
    from trade_system.signal import SignalType  # локально: тестируется со стабом

    # Прогрев: даём стратегии train-историю. Свой provider (для инъекции OI и
    # т.п.) можно передать снаружи; по умолчанию — срез train.
    if hasattr(strategy, "set_atr_history_provider"):
        prov = history_provider or (lambda _t=None, _c=candles[:split_idx]: _c)
        strategy.set_atr_history_provider(prov)

    atr = _atr_series(candles, atr_period)
    n = len(candles)
    pos = None   # {"dir":+1/-1,"entry":float,"tp":float,"sl":float,"eatr":float,"i":int}
    trades: list[dict] = []

    def _close(exit_price: float, i: int, reason: str):
        nonlocal pos
        eatr = pos["eatr"]
        pnl = pos["dir"] * (exit_price - pos["entry"]) / eatr - cost_atr if eatr > 0 else 0.0
        trades.append({"dir": pos["dir"], "entry": pos["entry"], "exit": exit_price,
                       "pnl_atr": pnl, "bars": i - pos["i"], "reason": reason})
        pos = None

    for i in range(split_idx, n):
        hi, lo, cl = _f(candles[i].high), _f(candles[i].low), _f(candles[i].close)

        # 1) Ведём открытую позицию: интрабар тейк/стоп (стоп проверяем первым —
        #    консервативно, при неоднозначности бар мог сначала прошить стоп).
        if pos is not None:
            if pos["dir"] > 0:
                if lo <= pos["sl"]:
                    _close(pos["sl"], i, "stop")
                elif hi >= pos["tp"]:
                    _close(pos["tp"], i, "take")
            else:
                if hi >= pos["sl"]:
                    _close(pos["sl"], i, "stop")
                elif lo <= pos["tp"]:
                    _close(pos["tp"], i, "take")

        # 2) Скармливаем бар стратегии.
        try:
            sig = strategy.analyze_candles([candles[i]])
        except Exception:
            sig = None
        if sig is None:
            continue
        st = int(sig.signal_type)

        if st == _CLOSE:
            if pos is not None:
                _close(cl, i, "close_signal")
            continue
        if pos is not None:
            continue  # без перекрытия — новые входы игнорируем, пока в позиции
        if st not in (_LONG, _SHORT):
            continue
        eatr = atr[i]
        if not (eatr == eatr and eatr > 0):  # NaN-guard
            continue
        tp = float(sig.take_profit_level)
        sl = float(sig.stop_loss_level)
        if tp <= 0 or sl <= 0:
            continue
        pos = {"dir": 1 if st == _LONG else -1, "entry": cl, "tp": tp, "sl": sl,
               "eatr": eatr, "i": i}

    wins = sum(1 for t in trades if t["pnl_atr"] > 0)
    n_tr = len(trades)
    exp = sum(t["pnl_atr"] for t in trades) / n_tr if n_tr else 0.0
    return {"n": n_tr, "wins": wins,
            "win": (wins / n_tr if n_tr else 0.0),
            "exp_atr": exp, "trades": trades}
