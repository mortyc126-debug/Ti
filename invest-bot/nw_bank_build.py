"""
nw_bank_build.py — сборка кросс-тикерного глобального банка NW-памяти для live.

Валидировано в nw_backtest.py: голос соседей из ЕДИНОГО банка по всем тикерам
(жёсткий радиус 0.12) несёт чистую альфу +0.055 ATR OOS сверх беты и зоны —
и бьёт per-ticker память. Этот скрипт строит банк ОДИН РАЗ офлайн и кладёт в
компактный .npz, который live-класс NWMemoryGlobal грузит и держит в KDTree.

Банк = ВЕСЬ пул точек (T_hat, P_hat, color_hat) с известным исходом по всем
тикерам кэша. Зона и радиус применяются на ЗАПРОСЕ (к живому бару), не к банку.
Оси считает tpcolor_dataset.build_dataset — тот же расчёт, что офлайн и в
nw_memory_live (единый источник осей, без рассинхрона live/offline).

Артефакт НЕ коммитим в git (десятки МБ) — строится локально из candle_cache.

Запуск:
    py -3.11 nw_bank_build.py
    py -3.11 nw_bank_build.py --liquid-only --out data/nw_bank.npz
"""
import os
import sys
import json
import glob
import argparse

import numpy as np

import tpcolor_dataset as tpc

# Параметры осей — ровно как в nw_memory_live (единый источник, без рассинхрона).
_N = 20
_N_MACRO = 200
_W_NORM = 500
_K = 12


def _cache_dir(arg):
    return arg or os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "candle_cache")


def _load_candles(cache_dir, tk):
    fp = os.path.join(cache_dir, f"{tk}.json")
    if not os.path.exists(fp):
        return None
    try:
        with open(fp, encoding="utf-8") as f:
            rows = json.load(f)
    except (json.JSONDecodeError, OSError):
        return None
    if not isinstance(rows, list) or len(rows) < _W_NORM + _N_MACRO + _K:
        return None
    rows.sort(key=lambda r: r["time"])
    return rows


def _ticker_liq(cache_dir):
    # медианный оборот бара (volume*close) — как в nw_backtest, для терциля ликвидности
    liq = {}
    for fp in glob.glob(os.path.join(cache_dir, "*.json")):
        base = os.path.splitext(os.path.basename(fp))[0]
        if base.endswith("_1m"):
            continue
        try:
            with open(fp, encoding="utf-8") as f:
                rows = json.load(f)
        except (json.JSONDecodeError, OSError):
            continue
        if not isinstance(rows, list) or len(rows) < 50:
            continue
        tos = [float(r["volume"]) * float(r["close"]) for r in rows
               if isinstance(r.get("volume"), (int, float)) and isinstance(r.get("close"), (int, float))]
        if tos:
            liq[base.upper()] = float(np.median(tos))
    return liq


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cache", default=None)
    ap.add_argument("--out", default=None, help="куда сохранить банк (.npz)")
    ap.add_argument("--liquid-only", action="store_true",
                    help="в банк только верхний терциль ликвидности (как валидировалось)")
    args = ap.parse_args()
    cache = _cache_dir(args.cache)
    out = args.out or os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "nw_bank.npz")

    tickers = sorted(os.path.splitext(os.path.basename(fp))[0]
                     for fp in glob.glob(os.path.join(cache, "*.json"))
                     if not os.path.basename(fp).endswith("_1m.json"))
    if not tickers:
        sys.exit(f"нет тикеров в {cache}")

    liq_top = None
    if args.liquid_only:
        liq = _ticker_liq(cache)
        present = sorted(liq.values())
        thr = present[2 * len(present) // 3] if present else 0
        liq_top = {k for k, v in liq.items() if v >= thr}
        print(f"ликвид-терциль: {len(liq_top)} тикеров", file=sys.stderr)

    coords_parts, y_parts = [], []
    n_tk = 0
    for tk in tickers:
        if liq_top is not None and tk.upper() not in liq_top:
            continue
        cr = _load_candles(cache, tk)
        if not cr:
            continue
        rows = tpc.build_dataset(cr, n=_N, n_macro=_N_MACRO, w_norm=_W_NORM, k=_K)
        if not rows:
            continue
        T = np.array([r["T_hat"] if r["T_hat"] is not None else np.nan for r in rows])
        P = np.array([r["P_hat"] if r["P_hat"] is not None else np.nan for r in rows])
        C = np.array([r["color_hat"] if r["color_hat"] is not None else np.nan for r in rows])
        tg = np.array([r["target"] if r["target"] is not None else np.nan for r in rows])
        ok = np.array([r["outcome_known"] for r in rows]) == 1
        good = ok & ~np.isnan(T) & ~np.isnan(P) & ~np.isnan(C) & ~np.isnan(tg)
        if not good.any():
            continue
        coords_parts.append(np.column_stack([T[good], P[good], C[good]]).astype(np.float32))
        y_parts.append((tg[good] > 0).astype(np.int8))
        n_tk += 1
        if n_tk % 25 == 0:
            print(f"...{n_tk} тикеров, точек {sum(len(p) for p in coords_parts)}", file=sys.stderr)

    if not coords_parts:
        sys.exit("пустой банк — проверь --cache")
    coords = np.concatenate(coords_parts)
    y = np.concatenate(y_parts)
    os.makedirs(os.path.dirname(out), exist_ok=True)
    np.savez_compressed(out, coords=coords, y=y,
                        meta=np.array([_N, _N_MACRO, _W_NORM, _K], dtype=np.int32),
                        liquid=np.array([1 if args.liquid_only else 0], dtype=np.int8))
    print(f"\nбанк сохранён: {out}")
    print(f"тикеров: {n_tk}, точек: {len(y)}, доля up: {100 * y.mean():.1f}%")
    print(f"размер файла: {os.path.getsize(out) / 1e6:.1f} МБ")


if __name__ == "__main__":
    main()
