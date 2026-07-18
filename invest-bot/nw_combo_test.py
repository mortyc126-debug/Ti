"""
nw_combo_test.py — добавляют или убавляют методы бота к NW-сигналу?

NW-память шортит на ценовых признаках (T/P/color). Методы OICompositeStrategy
(свечные/индикаторные: паттерны, ADX, аллигатор, sinewave…) — на тех же барах,
другой взгляд. Вопрос: если на NW-шорт-баре методы ТОЖЕ смотрят вниз — сделка
лучше? Если против — хуже? Это и есть «суммарно добавляют/убавляют».

Механика та же, что в nw_backtest (вход по close, тейк/стоп в ATR интрабар,
no-overlap, каузальный замороженный банк). Но на каждом NW-шорт-баре ещё считаем
АНСАМБЛЬ методов = среднее их скоров (знак = направление, как в score_methods:
score<=-agree → вниз, >=agree → вверх). Сделки NW-шорт делим по согласию
ансамбля и сравниваем экспектанси.

Методы, которым нужен OI (его в свечах нет) — молча падают/возвращают None и в
ансамбль не входят: фактически меряем свечной ансамбль, что и совместимо с NW.

Запуск:
    py -3.11 nw_combo_test.py out/per_ticker --bank data/nw_bank_train.npz \
        --split-date 2026-04-01 --liquid-only --cost 0.05
"""
import sys
import os
import argparse

import numpy as np

from nw_backtest import (_load_tpc, _load_candles, _atr, _epoch_s, _parse_time,
                         _ticker_liq, _stats)
from nw_memory_global import NWMemoryGlobal

_AGREE = 0.15   # порог направления метода (как score_methods --agree-min)
_WINDOW = 300   # окно свечей для методов (как score_methods --window)


def _load_methods():
    """METHODS + METHODS_CLASSIC из oi_composite_strategy (тяжёлый импорт ~минуту)."""
    from trade_system.strategies import oi_composite_strategy as ocs
    from score_methods import _row_to_ns
    methods = list(ocs.METHODS) + list(getattr(ocs, "METHODS_CLASSIC", []))
    return methods, _row_to_ns


def _ensemble_side(methods, window_ns):
    """Среднее скоров методов по окну намспейсов. Возвращает (mean_score, n_valid).
    None-скоры и падения (OI-методы без OI) пропускаем."""
    s = 0.0; k = 0
    for _name, fn in methods:
        try:
            sc = fn(window_ns)
        except Exception:
            continue
        if sc is None:
            continue
        s += float(sc); k += 1
    return (s / k, k) if k else (0.0, 0)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("path")
    ap.add_argument("--bank", required=True, help=".npz банк (NWMemoryGlobal)")
    ap.add_argument("--cache", default=None)
    ap.add_argument("--k", type=int, default=12)
    ap.add_argument("--take", type=float, default=1.0)
    ap.add_argument("--stop", type=float, default=0.5)
    ap.add_argument("--cost", type=float, default=0.05)
    ap.add_argument("--split-date", default=None)
    ap.add_argument("--liquid-only", action="store_true")
    ap.add_argument("--agree", type=float, default=_AGREE)
    ap.add_argument("--window", type=int, default=_WINDOW)
    args = ap.parse_args()
    cache = args.cache or os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "candle_cache")

    memg = NWMemoryGlobal.load(args.bank)
    if memg is None:
        sys.exit(f"не загрузился банк {args.bank}")
    print(f"банк: {len(memg.y)} точек", file=sys.stderr)

    print("импорт методов бота (может занять ~минуту)...", file=sys.stderr)
    methods, _row_to_ns = _load_methods()
    print(f"методов в ансамбле: {len(methods)}", file=sys.stderr)

    rows, nfiles = _load_tpc(args.path)
    n = len(rows)

    def col(key):
        out = np.empty(n)
        for idx, (_, r) in enumerate(rows):
            try:
                out[idx] = float(r.get(key, ""))
            except (TypeError, ValueError):
                out[idx] = np.nan
        return out

    T, P, C = col("T_hat"), col("P_hat"), col("color_hat")
    feat_by_tk = {}
    for idx, (tk, r) in enumerate(rows):
        if np.isnan(T[idx]) or np.isnan(P[idx]) or np.isnan(C[idx]):
            continue
        feat_by_tk.setdefault(tk, {})[r.get("time", "")] = (T[idx], P[idx], C[idx])

    split_ts = None
    if args.split_date:
        d = _parse_time(args.split_date)
        if not d:
            sys.exit("плохой --split-date")
        split_ts = _epoch_s(args.split_date)

    liq_top = None
    if args.liquid_only:
        liq = _ticker_liq(cache)
        present = sorted(liq.values())
        thr = present[2 * len(present) // 3] if present else 0
        liq_top = {k for k, v in liq.items() if v >= thr}

    maxhold = args.k
    # раздельные корзины P&L: NW-шорт по согласию ансамбля
    pnl_all, pnl_agree, pnl_neu, pnl_opp = [], [], [], []
    # только TEST (если split задан) — остальное train, нам важен OOS
    def _bucket(store, pnl, cep_i):
        if split_ts is None or cep_i >= split_ts:
            store.append(pnl)

    n_tk = 0
    for tk in sorted(feat_by_tk):
        if liq_top is not None and tk not in liq_top:
            continue
        cr = _load_candles(cache, tk)
        if not cr:
            continue
        ctime = [r["time"] for r in cr]
        cH = np.array([float(r["high"]) for r in cr])
        cL = np.array([float(r["low"]) for r in cr])
        cC = np.array([float(r["close"]) for r in cr])
        atr = _atr(cH, cL, cC)
        cep = np.array([_epoch_s(t) for t in ctime])
        ns = [_row_to_ns(r) for r in cr]
        feat = feat_by_tk[tk]
        m = len(cC)
        n_tk += 1
        i = max(maxhold, args.window)
        while i < m - 1:
            t = ctime[i]
            f = feat.get(t)
            if f is None or np.isnan(atr[i]) or atr[i] <= 0:
                i += 1; continue
            sc = memg.score_axes(*f)
            if sc >= 0.0:      # только шорт (p_hold<0.5)
                i += 1; continue
            dirn = -1.0
            entry = cC[i]; a0 = atr[i]
            tp = entry + dirn * args.take * a0
            sl = entry - dirn * args.stop * a0
            exit_j = min(i + maxhold, m - 1)
            px = cC[exit_j]
            for j in range(i + 1, min(i + 1 + maxhold, m)):
                if cH[j] >= sl:
                    exit_j = j; px = sl; break
                if cL[j] <= tp:
                    exit_j = j; px = tp; break
            pnl = dirn * (px - entry) / a0 - args.cost
            # ансамбль методов на этом баре
            ens, kv = _ensemble_side(methods, ns[i - args.window:i + 1])
            _bucket(pnl_all, pnl, cep[i])
            if kv > 0 and ens <= -args.agree:        # методы согласны (вниз)
                _bucket(pnl_agree, pnl, cep[i])
            elif kv > 0 and ens >= args.agree:        # методы против (вверх)
                _bucket(pnl_opp, pnl, cep[i])
            else:                                     # нейтрально/нет валидных
                _bucket(pnl_neu, pnl, cep[i])
            i = exit_j + 1

    seg = f"TEST ≥{args.split_date}" if split_ts is not None else "ВСЕ"
    print(f"\n=== NW-шорт × ансамбль методов ({seg}, cost={args.cost}, agree={args.agree}) ===")
    print(f"тикеров: {n_tk}")
    _stats("NW-шорт ВСЕ", pnl_all)
    _stats("методы ЗА (вниз)", pnl_agree)
    _stats("методы нейтр.", pnl_neu)
    _stats("методы ПРОТИВ", pnl_opp)
    print("\nЧитать: если 'методы ЗА' > 'NW-шорт ВСЕ' — методы ДОБАВЛЯЮТ (фильтр-")
    print("подтверждение улучшает). Если 'методы ПРОТИВ' заметно хуже — несогласие")
    print("методов = предупреждение (убавляют, когда против). Близкие числа = методы")
    print("ортогональны NW и как фильтр не помогают.")


if __name__ == "__main__":
    main()
