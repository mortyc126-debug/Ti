"""
toggle_effect.py — офлайн-оценка эффекта method_toggle_state.json без
запуска реального бэктеста.

Ходить в dashboard.run_backtest_one под Python 3.14 без Tinkoff SDK
получается частично: свечи из candle_cache читаются, но офлайн-версия
композита где-то залипает (последнее наблюдение — 77% скана SBER, потом
процесс висит). Пока композит не починен для оффлайна, оценку эффекта
инверсий/выключений можно посчитать «сверху» — прямо из per-ticker×regime
CSV, которые уже есть от score_methods.py.

Логика:
1. По каждой клетке (метод × режим × тикер) берём n_fires и win_rate.
2. Классифицируем метод по toggle_state:
   - disabled → вклад = 0
   - inverted → вклад пересчитывается: win_rate' = 1 - win_rate
     (инверсия голоса меняет метку победы наоборот)
   - иначе → вклад = win_rate
3. Взвешиваем по n_fires × |d| (сила × частота — то же, что «contribution»
   в score_methods) и агрегируем. Для baseline — то же самое, но без
   применения toggle_state.

Результат — таблица «пул: baseline WR X% → variant WR Y% → Δ = +/-Z п.п.»,
плюс топ-10 методов, у которых Δ WR больше всего (кто реально двигает
среднее).

Это НЕ реальная симуляция bar-by-bar сделок бота (тайм-выходы, R:R,
корреляция голосов). Это оценка «средневзвешенного знака-с-учётом-веса»
— грубая, но воспроизводимая, и та же метрика, по которой score_methods
делил методы на signal/anti/noise. Если Δ WR > 0, значит toggle_state
направляет вес к методам с ЛУЧШИМ индивидуальным win_rate; знак Δ не
врёт даже если абсолют цифр не совпадёт с реальным ботом.

Использование:
  python toggle_effect.py                                # scores_by_regime.csv + toggle_state.json
  python toggle_effect.py --csv data/analysis/scores_by_regime.csv
  python toggle_effect.py --toggle data/method_toggle_state.json --preset "..."
  python toggle_effect.py --scope trending_up            # только один режим
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import statistics
import sys

HERE = os.path.dirname(os.path.abspath(__file__))


def _load_toggle(path: str, preset: str | None) -> tuple[set, set]:
    if preset:
        preset_path = os.path.join(HERE, "data", "method_presets.json")
        try:
            with open(preset_path, "r", encoding="utf-8") as f:
                presets = json.load(f)
            data = presets.get(preset) or {}
        except (OSError, ValueError):
            data = {}
    else:
        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
        except (OSError, ValueError):
            data = {}
    disabled = set(data.get("disabled", []))
    inverted = set(data.get("inverted", []))
    return disabled, inverted


def _load_scores(path: str) -> list:
    rows = []
    with open(path, "r", encoding="utf-8", newline="") as f:
        for r in csv.DictReader(f):
            try:
                nf = int(r["n_fires"] or 0)
                wr = float(r["win_rate"]) if r["win_rate"] not in ("", "n/a") else None
                d = float(r["d"]) if r["d"] not in ("", "n/a") else None
            except (KeyError, ValueError):
                continue
            if nf < 1 or wr is None or d is None:
                continue
            rows.append({"method": r["method"], "regime": r["regime"],
                         "ticker": r.get("ticker", ""), "n_fires": nf,
                         "win_rate": wr, "d": d})
    return rows


def _weighted(rows: list, disabled: set, inverted: set) -> dict:
    """Возвращает {'wr_baseline': ..., 'wr_variant': ..., 'n_agg': ..., 'active': N}.
    wr — среднее win_rate, взвешенное по n_fires × |d|. baseline — без применения
    toggle, variant — метод в disabled даёт вес 0, в inverted → wr' = 1-wr."""
    def _agg(rows_, apply_toggle: bool):
        sw = 0.0  # сумма весов
        swr = 0.0  # сумма win_rate × вес
        n_active = 0
        for r in rows_:
            m = r["method"]
            if apply_toggle and m in disabled:
                continue
            w = r["n_fires"] * abs(r["d"])
            wr = r["win_rate"]
            if apply_toggle and m in inverted:
                wr = 1.0 - wr
            sw += w
            swr += wr * w
            n_active += 1
        return (swr / sw if sw > 0 else None), sw, n_active
    b_wr, b_sw, b_n = _agg(rows, apply_toggle=False)
    v_wr, v_sw, v_n = _agg(rows, apply_toggle=True)
    return {"wr_baseline": b_wr, "wr_variant": v_wr,
             "weight_baseline": b_sw, "weight_variant": v_sw,
             "active_baseline": b_n, "active_variant": v_n}


def main() -> None:
    ap = argparse.ArgumentParser(description="Офлайн-оценка эффекта toggle_state поверх score_methods CSV")
    ap.add_argument("--csv", default=os.path.join("data", "analysis", "scores_by_regime.csv"),
                     help="Per-ticker × regime CSV из score_methods.py --out")
    ap.add_argument("--toggle", default=os.path.join("data", "method_toggle_state.json"))
    ap.add_argument("--preset", default=None,
                     help="Имя пресета из data/method_presets.json (иначе --toggle)")
    ap.add_argument("--scope", default="ALL",
                     help="Режим для анализа: ALL / trending_up / ... (default ALL)")
    args = ap.parse_args()

    csv_path = args.csv if os.path.isabs(args.csv) else os.path.join(HERE, args.csv)
    toggle_path = args.toggle if os.path.isabs(args.toggle) else os.path.join(HERE, args.toggle)
    if not os.path.exists(csv_path):
        sys.exit(f"нет CSV: {csv_path}")

    disabled, inverted = _load_toggle(toggle_path, args.preset)
    src = f"пресет «{args.preset}»" if args.preset else toggle_path
    print(f"вариант ({src}): disabled={len(disabled)} inverted={len(inverted)}", file=sys.stderr)

    rows_all = _load_scores(csv_path)
    print(f"CSV: {csv_path} → {len(rows_all)} строк", file=sys.stderr)

    scope_rows = [r for r in rows_all if r["regime"] == args.scope]
    print(f"scope={args.scope}: {len(scope_rows)} клеток", file=sys.stderr)

    res = _weighted(scope_rows, disabled, inverted)
    b, v = res["wr_baseline"], res["wr_variant"]
    if b is None or v is None:
        sys.exit("пусто в scope")
    delta = (v - b) * 100

    print(f"\n=== ЭФФЕКТ toggle_state (scope={args.scope}) ===")
    print(f"BASELINE (без toggle):   WR = {b*100:5.2f}%   (метрик активных: {res['active_baseline']})")
    print(f"VARIANT (toggle прим.):  WR = {v*100:5.2f}%   (метрик активных: {res['active_variant']})")
    print(f"                    Δ WR = {delta:+5.2f} п.п.")

    print(f"\n=== ВКЛАД ОТДЕЛЬНЫХ МЕТОДОВ (topics of change) ===")
    print(f"метод                    статус   n_fires_wt   wr_base  wr_var  ΔWR × вес")
    per_method: dict = {}
    for r in scope_rows:
        m = r["method"]
        p = per_method.setdefault(m, {"n": 0.0, "swr_b": 0.0, "swr_v": 0.0})
        w = r["n_fires"] * abs(r["d"])
        wr = r["win_rate"]
        p["n"] += w
        p["swr_b"] += w * wr
        if m in disabled:
            wr_v = None
        elif m in inverted:
            wr_v = 1.0 - wr
        else:
            wr_v = wr
        if wr_v is not None:
            p["swr_v"] += w * wr_v
    rows_m = []
    for m, p in per_method.items():
        if p["n"] <= 0:
            continue
        wr_b = p["swr_b"] / p["n"]
        wr_v = p["swr_v"] / p["n"] if m not in disabled else 0.0
        status = "disabled" if m in disabled else ("inverted" if m in inverted else "-")
        contribution = (wr_v - wr_b) * p["n"] if m not in disabled else -wr_b * p["n"]
        rows_m.append((m, status, p["n"], wr_b, wr_v, contribution))
    rows_m.sort(key=lambda x: -abs(x[5]))
    for m, st, n, wb, wv, ctr in rows_m[:20]:
        print(f"{m:<22}  {st:<8} {n:>10.0f}   {wb*100:5.1f}%  {wv*100:5.1f}%  {ctr:+10.0f}")


if __name__ == "__main__":
    main()
