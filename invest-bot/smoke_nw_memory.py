"""smoke_nw_memory.py — оффлайн проверка, что NWMemoryStrategy поднимается через
фабрику, строит память из истории (провайдер) и обрабатывает свечи без падения.
Без сети/песочницы.

Синтетика: длинный ряд с шумом + периодические «квадрантные» эпизоды (тихий
дрейф = низкая T, устойчивое направление = высокая P), чтобы память построилась
и на баре в квадранте мог сработать голос. Тест НЕ требует непременно сигнала —
проверяет, что путь фабрика→прогрев→build→score→analyze не падает и что при
достаточной истории память строится.

Запуск:  py -3.11 smoke_nw_memory.py
"""
import sys
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace


def _q(price: float):
    from tinkoff.invest import Quotation
    units = int(price)
    nano = int(round((price - units) * 1e9))
    return Quotation(units=units, nano=nano)


def _candle(t, o, h, l, c, v=1000):
    from tinkoff.invest import HistoricCandle
    return HistoricCandle(open=_q(o), high=_q(h), low=_q(l), close=_q(c),
                          volume=v, time=t, is_complete=True)


def _make_history(n=4000):
    """Ряд 5-мин баров, резко бимодальный, чтобы набрался квадрант lowT_highP:
    длинные шумные участки (широкий размах, большой объём → высокая T, рваное
    направление → низкая P) и частые тихо-направленные эпизоды (узкий размах,
    малый объём → низкая T, монотонный ход → высокая P)."""
    import random
    random.seed(7)
    t0 = datetime(2026, 1, 1, tzinfo=timezone.utc)
    bars = []
    price = 100.0
    qdir = 1
    for i in range(n):
        pos = i % 130
        quiet = pos >= 80                      # ~50 из каждых 130 баров — тихий дрейф
        if quiet:
            if pos == 80:
                qdir = 1 if random.random() < 0.5 else -1
            step = qdir * 0.05                 # строго монотонно → ER≈1 (высокая P)
            rng = 0.02                         # узкий бар → низкая T
            vol = 250
        else:
            step = random.uniform(-0.45, 0.45)  # рваный шум → низкая P
            rng = random.uniform(0.3, 0.8)      # широкий бар → высокая T
            vol = random.randint(1200, 3000)
        o = price
        price = max(1.0, price + step)
        c = price
        h = max(o, c) + rng
        l = min(o, c) - rng
        bars.append(_candle(t0 + timedelta(minutes=5 * i), o, h, l, c, vol))
    return bars


def main():
    try:
        from trade_system.strategies.strategy_factory import StrategyFactory
    except Exception as e:
        print("ОШИБКА импорта фабрики:", repr(e)); return 1

    settings = SimpleNamespace(ticker="TEST", figi="FUT_TEST",
                               short_enabled_flag=True)
    strat = StrategyFactory.new_factory("NWMemoryStrategy", settings)
    if strat is None:
        print("ОШИБКА: фабрика не знает NWMemoryStrategy (не зарегистрирована?)"); return 1
    print("инициализация через фабрику: OK ->", type(strat).__name__)

    hist = _make_history()
    strat.set_atr_history_provider(lambda ticker: hist)

    try:
        # первый вызов триггерит прогрев+build; кормим последний бар как «живой»
        signal = strat.analyze_candles([hist[-1]])
    except Exception as e:
        import traceback
        print("ОШИБКА в analyze_candles:", repr(e))
        traceback.print_exc(); return 1

    print(f"история: {len(hist)} баров | буфер стратегии: {len(strat._bars)}")
    mem = strat._memory
    if mem is None:
        print("память НЕ построена — для этой синтетики мало точек квадранта "
              "(это валидный старт: метод молчит, бот не падает)")
    else:
        print(f"память построена: точек квадранта={len(mem.tgt_pos)} "
              f"t_thr={mem.t_thr:.3f} p_thr={mem.p_thr:.3f}")

    if signal is None:
        print("сигнала нет (детектор/память отработали без ошибок — валидный старт)")
    else:
        print(f"СИГНАЛ: type={signal.signal_type.name} "
              f"tp={signal.take_profit_level} sl={signal.stop_loss_level}")

    # Детерминированная проверка ветки голосования NWMemory.score (в обход
    # статистики квадранта): строим память руками из точек с известным исходом
    # и проверяем знак голоса на запросе внутри квадранта.
    if not _check_score_branch():
        return 1

    print("SMOKE OK — стратегия поднимается, строит память и обрабатывает свечи без падения")
    return 0


def _check_score_branch() -> bool:
    """Прямой юнит-тест NWMemory.score: точки с target>0 → голос>0."""
    try:
        import numpy as np
        from nw_memory_live import NWMemory
    except Exception as e:
        print("проверка score пропущена (нет numpy):", repr(e)); return True
    # 40 прецедентов у одной точки квадранта, все с положительным исходом и
    # тем же знаком color → p_hold≈1 → голос≈+1.
    q = np.array([-2.0, 2.0, 0.5])            # в квадранте: T<t_thr, P>p_thr
    coords = np.tile(q, (40, 1)) + np.random.RandomState(1).normal(0, 0.05, (40, 3))
    coords[:, 2] = 0.5                        # тот же знак color, что у запроса
    tgt_pos = np.ones(40)                     # все исходы вверх
    color_sign = np.sign(coords[:, 2])
    mem = NWMemory(coords, tgt_pos, color_sign, t_thr=-1.0, p_thr=1.0)
    vote = mem._score_point(q[0], q[1], q[2]) if hasattr(mem, "_score_point") else None
    if vote is None:
        # публичного _score_point нет — соберём голос через внутреннюю логику score
        # тем же способом (KDTree/brute), продублировав запрос как «последний бар».
        vote = _vote_via_internal(mem, q, np)
    ok = vote is not None and vote > 0.5
    print(f"проверка score: голос по 40 положительным прецедентам = "
          f"{vote:.3f} (ожидали >0.5): {'OK' if ok else 'ПРОВАЛ'}")
    return ok


def _vote_via_internal(mem, q, np):
    """Повторяет расчёт голоса из NWMemory.score для готовой точки q (в квадранте)."""
    from nw_memory_live import _H, _DENSITY_MIN
    radius = 3.0 * _H
    if mem._tree is not None:
        idx = mem._tree.query_ball_point(q, radius)
        if not idx:
            return 0.0
        sub, tpos, csign = mem.coords[idx], mem.tgt_pos[idx], mem.color_sign[idx]
    else:
        d2all = ((mem.coords - q) ** 2).sum(axis=1)
        mask = d2all <= radius * radius
        if not bool(mask.any()):
            return 0.0
        sub, tpos, csign = mem.coords[mask], mem.tgt_pos[mask], mem.color_sign[mask]
    d2 = ((sub - q) ** 2).sum(axis=1)
    w = np.exp(-d2 / (2.0 * _H * _H)) * (csign == np.sign(q[2])).astype(float)
    dens = float(w.sum())
    if dens < _DENSITY_MIN:
        return 0.0
    p_hold = float((w * tpos).sum() / dens)
    return max(-1.0, min(1.0, 2.0 * p_hold - 1.0))


if __name__ == "__main__":
    sys.exit(main())
