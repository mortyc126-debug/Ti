"""
nw_memory.py — прототип NW-памяти §11 из документа T/P/color.

Читает pre-computed CSV одного тикера, выданный tpcolor_dataset.py (колонки
time, T_hat, P_hat, color_hat, fwd_ret_k, target, outcome_known), и на
каждом баре считает вероятность удержания движения p_hold(i) через
гауссово-ядерное взвешивание исторических соседей в пространстве
(T̂, P̂, color̂).

Реализованы:

- §11.3 фильтр лукахеда: сосед j используется только если j+k ≤ i
  (исход к моменту i уже наступил). Строгий, без хвостов.
- §11.2 dir_match: жёсткий множитель {0, 1}. Точки с
  sign(color̂[i]) ≠ sign(color̂[j]) исключаются из взвешивания.
- §11.4 гауссово ядро: exp(-d²/(2h²)) в нормализованном (уже z-score
  через каузальную нормировку в tpcolor_dataset) пространстве.
- §11.5 честный «no precedent»: если суммарный вес соседей density(i)
  ниже порога, p_hold(i) = None, memory_type = "no precedent". Не
  подменяем средним, документ прямо это оговаривает.

НЕ реализованы (осознанно, для минимального рабочего прототипа):

- §11.4 макро-контекст (D_regime) — сначала посмотрим, работает ли
  чистая версия без него.
- §11.5 дуальная память (case-track) — сначала population NW, потом
  подключим case-track по свечным паттернам отдельным слоем.
- §5.5 условие ключа контекста для case-памяти.

Метрики на выходе:

- Brier score = mean((p_hold − 1{target>0})²) — качество калибровки,
  чем меньше тем лучше; naive baseline (константа = base_rate) даёт
  base_rate·(1-base_rate).
- Calibration diagram: 10 корзин по p_hold, для каждой — средний
  предсказанный vs средний факт. Печатается в консоль.
- Реализованный edge: направление = sign(p_hold − 0.5), доходность в
  единицах ATR = direction × fwd_ret_k. Считаем среднее для баров, где
  |p_hold − 0.5| > confidence_threshold (иначе позиция не открывается).

Зависимости: numpy, scipy.spatial (cKDTree). Оба уже стоят в среде
invest-bot (в oi_composite_strategy используется).

Запуск:
    # 1. Собрать датасет по тикеру:
    python tpcolor_dataset.py CBOM --all --out cbom_tpc.csv

    # 2. Прогнать NW-память:
    python nw_memory.py cbom_tpc.csv --h 0.3 --k 12 --out cbom_nw.csv

    # Быстрая проверка на PLZL с плотностью выше:
    python nw_memory.py plzl_tpc.csv --h 0.25 --neighbors 300

Аргументы:
    csv_in                  CSV из tpcolor_dataset.py (обязательно)
    --h H                   bandwidth ядра (default 0.3)
    --neighbors N           k ближайших для стартового отбора (default 200)
    --density-min D         порог density для «no precedent» (default 3.0)
    --confidence THR        порог |p_hold − 0.5| для «открыть позицию»
                            (default 0.10 → |p_hold| ∈ [0.4, 0.6] пропускаем)
    --k K                   горизонт fwd_ret_k, должен совпадать с тем, что
                            использовался в tpcolor_dataset (default 12)
    --out PATH              CSV с per-bar результатами (append)
    --plot                  показать calibration diagram (matplotlib)
"""
from __future__ import annotations

import argparse
import csv
import math
import os
import sys
from typing import Optional

try:
    import numpy as np
    from scipy.spatial import cKDTree
except ImportError as ex:
    sys.exit(f"нужны numpy + scipy: pip install numpy scipy. текущая ошибка: {ex}")

# sklearn.isotonic — опционально, только для --calibrate. Отдельный try,
# чтобы отсутствие пакета не ломало основной путь.
try:
    from sklearn.isotonic import IsotonicRegression
    _SKLEARN_AVAILABLE = True
except ImportError:
    _SKLEARN_AVAILABLE = False


def _load_dataset(path: str) -> dict:
    """Читает CSV из tpcolor_dataset.py, возвращает numpy-массивы по колонкам.
    Пустые значения (None → '') → NaN. Требуемые колонки: T_hat, P_hat,
    color_hat, fwd_ret_k, target, outcome_known."""
    required = {"T_hat", "P_hat", "color_hat", "fwd_ret_k", "target",
                 "outcome_known"}
    with open(path, "r", encoding="utf-8", newline="") as f:
        reader = csv.DictReader(f)
        if not required.issubset(reader.fieldnames or []):
            missing = required - set(reader.fieldnames or [])
            sys.exit(f"в CSV не хватает колонок: {sorted(missing)}")
        rows = list(reader)
    if not rows:
        sys.exit("CSV пустой")
    def col(name, dtype=float):
        arr = np.full(len(rows), np.nan, dtype=float)
        for i, r in enumerate(rows):
            v = r.get(name, "")
            if v == "" or v is None:
                continue
            try:
                arr[i] = float(v)
            except ValueError:
                pass
        return arr
    return {
        "time": [r["time"] for r in rows],
        "T_hat": col("T_hat"),
        "P_hat": col("P_hat"),
        "color_hat": col("color_hat"),
        "fwd_ret_k": col("fwd_ret_k"),
        "target": col("target"),
        "outcome_known": col("outcome_known"),
    }


def _dataset_from_rows(rows: list[dict]) -> dict:
    """Конвертит выход tpcolor_dataset.build_dataset (список dict-строк) в
    тот же формат numpy-массивов, что _load_dataset. Нужен для batch-режима,
    где датасет считается в памяти, а не читается из CSV."""
    n = len(rows)
    def col(name):
        arr = np.full(n, np.nan, dtype=float)
        for i, r in enumerate(rows):
            v = r.get(name)
            if v is None:
                continue
            try:
                arr[i] = float(v)
            except (ValueError, TypeError):
                pass
        return arr
    return {
        "time": [r["time"] for r in rows],
        "T_hat": col("T_hat"),
        "P_hat": col("P_hat"),
        "color_hat": col("color_hat"),
        "fwd_ret_k": col("fwd_ret_k"),
        "target": col("target"),
        "outcome_known": col("outcome_known"),
    }


def _brier(preds: list[float], actuals: list[int]) -> Optional[float]:
    """(p − y)², среднее. Чем меньше, тем лучше калибровка."""
    if not preds:
        return None
    return sum((p - a) ** 2 for p, a in zip(preds, actuals)) / len(preds)


def _calibration_bins(preds: list[float], actuals: list[int],
                        nbins: int = 10) -> list[dict]:
    """Разбиение [0,1] на nbins равных корзин, для каждой — mean(pred),
    mean(actual), count. Идеальная модель: mean(pred) ≈ mean(actual) во
    всех корзинах."""
    bins = []
    for b in range(nbins):
        lo = b / nbins
        hi = (b + 1) / nbins
        idxs = [i for i, p in enumerate(preds) if lo <= p < (hi if b < nbins - 1 else hi + 1e-9)]
        if not idxs:
            bins.append({"lo": lo, "hi": hi, "n": 0, "mean_pred": None, "mean_actual": None})
            continue
        mp = sum(preds[i] for i in idxs) / len(idxs)
        ma = sum(actuals[i] for i in idxs) / len(idxs)
        bins.append({"lo": lo, "hi": hi, "n": len(idxs),
                      "mean_pred": mp, "mean_actual": ma})
    return bins


def _print_calibration(bins: list[dict]) -> None:
    print(f"\n=== Calibration diagram (10 bins по p_hold) ===")
    print(f"{'корзина':<12} {'n':>6}  {'pred_avg':>10}  {'actual_avg':>10}  Δ")
    print("-" * 52)
    for b in bins:
        if b["n"] == 0:
            print(f"[{b['lo']:.1f}-{b['hi']:.1f}]  {'0':>6}  {'—':>10}  {'—':>10}  —")
            continue
        delta = b["mean_pred"] - b["mean_actual"]
        col = "!!" if abs(delta) > 0.15 else ("!" if abs(delta) > 0.08 else " ")
        print(f"[{b['lo']:.1f}-{b['hi']:.1f}]  {b['n']:>6}  "
              f"{b['mean_pred']:>10.3f}  {b['mean_actual']:>10.3f}  "
              f"{delta:+.3f} {col}")
    print("  Δ = pred − actual. !! — сильно перекос, ! — заметный, «» — норма.")


def _run_nw(data: dict, h: float, neighbors: int, density_min: float,
             k: int, quadrant_only: bool = False,
             t_lo: float = -0.5, p_hi: float = 0.5,
             min_points: int = 100, quiet: bool = False) -> dict:
    """Ядро прогона: для каждой i считает p_hold, density, memory_type.
    Возвращает per-bar массивы + метаинформацию.

    Если quadrant_only=True — и целевая точка, и соседи ограничены
    квадрантом (T̂ < t_lo, P̂ > p_hi). Гипотеза §8.3: эффект концентрируется
    там, а на всём пространстве размывается до нуля. Локализуем поиск —
    NW-память перестаёт усреднять сигнал по baseline'у."""
    T = data["T_hat"]; P = data["P_hat"]; C = data["color_hat"]
    fwd = data["fwd_ret_k"]; tgt = data["target"]
    ok = data["outcome_known"] == 1.0
    n = len(T)

    # Индекс: только точки с outcome_known + все три координаты валидны.
    valid_mask = ok & ~np.isnan(T) & ~np.isnan(P) & ~np.isnan(C) & ~np.isnan(tgt)
    if quadrant_only:
        quadrant_mask = (T < t_lo) & (P > p_hi)
        valid_mask = valid_mask & quadrant_mask
    valid_idx = np.where(valid_mask)[0]

    if not quiet:
        if quadrant_only:
            print(f"quadrant-only режим: T̂<{t_lo:+.2f} и P̂>{p_hi:+.2f}", file=sys.stderr)
        print(f"валидных точек для памяти: {len(valid_idx)} из {n}", file=sys.stderr)
    if len(valid_idx) < min_points:
        sys.exit("слишком мало валидных точек в квадранте — попробуй ослабить пороги --t-lo/--p-hi или увеличить историю")

    coords = np.column_stack([T[valid_idx], P[valid_idx], C[valid_idx]])
    tree = cKDTree(coords)
    if not quiet:
        print(f"KDTree построен, dim=3", file=sys.stderr)

    p_hold = np.full(n, np.nan)
    density = np.full(n, np.nan)
    n_neighbors_used = np.zeros(n, dtype=int)
    memory_type = ["no_query"] * n

    # radius = 3σ ядра — за пределами вклад экспоненциально мал (< 1%).
    radius = 3.0 * h

    for i in range(n):
        # Целевая точка должна иметь валидные координаты; исход у неё сам может
        # быть неизвестен (мы предсказываем будущее), это ок.
        if np.isnan(T[i]) or np.isnan(P[i]) or np.isnan(C[i]):
            continue
        # В quadrant-only режиме предсказываем только для точек в квадранте.
        # Вне квадранта — memory_type="outside_quadrant", p_hold остаётся NaN.
        if quadrant_only and not (T[i] < t_lo and P[i] > p_hi):
            memory_type[i] = "outside_quadrant"
            continue

        # Ищем кандидатов внутри радиуса
        query = np.array([T[i], P[i], C[i]])
        cand_local = tree.query_ball_point(query, r=radius)
        if not cand_local:
            memory_type[i] = "no_precedent"
            continue

        # Из локальных индексов — обратно в глобальные + фильтр лукахеда:
        # j+k ≤ i (исход к моменту i уже реализован).
        cand_global = valid_idx[cand_local]
        keep = cand_global + k <= i
        cand_global = cand_global[keep]
        if len(cand_global) == 0:
            memory_type[i] = "no_precedent"
            continue

        # Веса гауссова ядра
        dT = T[cand_global] - T[i]
        dP = P[cand_global] - P[i]
        dC = C[cand_global] - C[i]
        d2 = dT * dT + dP * dP + dC * dC
        w = np.exp(-d2 / (2 * h * h))

        # §11.2 dir_match: жёсткий множитель {0, 1}. sign(0) = 0 —
        # такие точки в обе стороны не проходят, что справедливо.
        sig_i = np.sign(C[i])
        sig_j = np.sign(C[cand_global])
        dir_match = (sig_i == sig_j).astype(float)
        # Если color̂ ровно 0 (крайне редко на float), считаем «нейтральным» и
        # не участвует — это соответствует «жёсткому» dir_match.
        if sig_i == 0:
            dir_match[:] = 0
        w_eff = w * dir_match

        dens = float(w_eff.sum())
        density[i] = dens

        if dens < density_min:
            memory_type[i] = "no_precedent"
            continue

        # p_hold = Σ w·1{target(j) > 0} / Σ w. target ∈ {-1, 0, 1};
        # «удержание» интерпретируем как «направление угадано» — по документу
        # target — это sign(fwd_ret_k), а fwd_ret_k нормировано на ATR.
        # Для p_hold честнее считать P(fwd_ret_k > 0) без привязки к цвету,
        # потому что «удержание» — это про факт направления вперёд, а знак
        # цвета мы уже отфильтровали через dir_match.
        y = (tgt[cand_global] > 0).astype(float)
        p = float((w_eff * y).sum() / dens)
        p_hold[i] = p
        n_neighbors_used[i] = int(dir_match.sum())
        memory_type[i] = "population"

    return {
        "p_hold": p_hold,
        "density": density,
        "n_neighbors_used": n_neighbors_used,
        "memory_type": memory_type,
        "T": T, "P": P, "C": C,
        "fwd": fwd, "tgt": tgt,
        "time": data["time"],
    }


def _evaluate(result: dict, confidence: float, calibrate: bool = False) -> dict:
    """Собирает метрики. Возвращает {brier, base_rate, edge_stats, n_signal,
    n_no_precedent}. Если calibrate=True — применяет изотоническую регрессию
    к сырым p_hold (in-sample), потом считает метрики по калиброванным."""
    p_hold = result["p_hold"]
    fwd = result["fwd"]
    tgt = result["tgt"]
    memory_type = result["memory_type"]

    # Пары (pred, actual) для калибровки: где мы что-то предсказали и знаем факт.
    preds = []; actuals = []
    valid_idxs = []
    for i in range(len(p_hold)):
        if memory_type[i] != "population":
            continue
        if np.isnan(tgt[i]):
            continue
        preds.append(float(p_hold[i]))
        actuals.append(1 if tgt[i] > 0 else 0)
        valid_idxs.append(i)

    # Калибровка: изотоническая регрессия на всех (pred, actual). In-sample —
    # оптимистичная оценка (в проде нужен walk-forward), но для проверки
    # «маскирует ли плохая калибровка настоящий edge» этого достаточно.
    calibrated = None
    if calibrate and preds and _SKLEARN_AVAILABLE:
        ir = IsotonicRegression(out_of_bounds="clip")
        ir.fit(np.array(preds), np.array(actuals))
        calibrated = ir.predict(np.array(preds)).tolist()
    elif calibrate and not _SKLEARN_AVAILABLE:
        print("⚠ --calibrate требует sklearn (pip install scikit-learn), "
              "калибровка пропущена", file=sys.stderr)

    brier_raw = _brier(preds, actuals)
    base_rate = sum(actuals) / len(actuals) if actuals else None
    naive_brier = (base_rate * (1 - base_rate)) if base_rate is not None else None

    # Метрики edge — сначала на raw, потом (если калибровано) на calibrated.
    def _edge_stats(preds_src):
        rets = []
        for j, i in enumerate(valid_idxs):
            if np.isnan(fwd[i]):
                continue
            gap = preds_src[j] - 0.5
            if abs(gap) < confidence:
                continue
            direction = 1.0 if gap > 0 else -1.0
            rets.append(direction * float(fwd[i]))
        if not rets:
            return {"mean": None, "std": None, "win_rate": None, "n": 0}
        mean = sum(rets) / len(rets)
        std = (math.sqrt(sum((r - mean) ** 2 for r in rets) / (len(rets) - 1))
               if len(rets) > 1 else None)
        wr = sum(1 for r in rets if r > 0) / len(rets)
        return {"mean": mean, "std": std, "win_rate": wr, "n": len(rets)}

    edge_raw = _edge_stats(preds)
    edge_cal = _edge_stats(calibrated) if calibrated is not None else None
    brier_cal = _brier(calibrated, actuals) if calibrated is not None else None

    n_no_precedent = sum(1 for m in memory_type if m == "no_precedent")
    n_population = sum(1 for m in memory_type if m == "population")

    return {
        "brier_raw": brier_raw, "brier_cal": brier_cal,
        "base_rate": base_rate, "naive_brier": naive_brier,
        "n_preds": len(preds),
        "edge_raw": edge_raw, "edge_cal": edge_cal,
        "n_population": n_population, "n_no_precedent": n_no_precedent,
        "calibration_bins_raw": _calibration_bins(preds, actuals, 10),
        "calibration_bins_cal": (_calibration_bins(calibrated, actuals, 10)
                                   if calibrated is not None else None),
    }


def _print_summary(m: dict, ticker: str) -> None:
    print(f"\n=== NW-память §11 — {ticker} ===")
    print(f"баров с предсказанием (population):  {m['n_preds']}")
    print(f"баров без прецедента (no_precedent): {m['n_no_precedent']}")
    print()
    if m["brier_raw"] is None:
        print("не удалось посчитать метрики — недостаточно предсказаний")
        return
    print(f"Brier raw          : {m['brier_raw']:.4f}")
    if m["brier_cal"] is not None:
        print(f"Brier calibrated   : {m['brier_cal']:.4f}  (изотоническая, in-sample)")
    print(f"Naive baseline     : {m['naive_brier']:.4f}  (константа = {m['base_rate']:.3f})")
    print(f"Улучшение raw→naive: {(1 - m['brier_raw']/m['naive_brier'])*100:+.1f}%")
    if m["brier_cal"] is not None:
        print(f"Улучш. cal→naive   : {(1 - m['brier_cal']/m['naive_brier'])*100:+.1f}%")
    print()
    def _print_edge(label, e):
        if e is None or e["mean"] is None:
            print(f"{label}: сигналов не набралось")
            return
        sharpe = (e["mean"] / e["std"]) if e["std"] else 0
        print(f"{label}: n={e['n']}  mean_ret/ATR={e['mean']:+.4f}  "
              f"std={e['std']:.3f}  Sharpe={sharpe:+.3f}  win={e['win_rate']*100:.1f}%")
    print(f"=== Реализованный edge (|p − 0.5| > threshold) ===")
    _print_edge("raw       ", m["edge_raw"])
    if m["edge_cal"] is not None:
        _print_edge("calibrated", m["edge_cal"])


def _write_out(result: dict, m: dict, path: str) -> None:
    with open(path, "w", encoding="utf-8", newline="") as f:
        w = csv.writer(f)
        w.writerow(["i", "time", "T_hat", "P_hat", "color_hat",
                    "p_hold", "density", "n_neighbors", "memory_type",
                    "fwd_ret_k", "target"])
        for i in range(len(result["p_hold"])):
            w.writerow([
                i, result["time"][i],
                f"{result['T'][i]:.4f}" if not np.isnan(result['T'][i]) else "",
                f"{result['P'][i]:.4f}" if not np.isnan(result['P'][i]) else "",
                f"{result['C'][i]:.4f}" if not np.isnan(result['C'][i]) else "",
                f"{result['p_hold'][i]:.4f}" if not np.isnan(result['p_hold'][i]) else "",
                f"{result['density'][i]:.3f}" if not np.isnan(result['density'][i]) else "",
                result["n_neighbors_used"][i],
                result["memory_type"][i],
                f"{result['fwd'][i]:.4f}" if not np.isnan(result['fwd'][i]) else "",
                int(result["tgt"][i]) if not np.isnan(result["tgt"][i]) else "",
            ])


def _plot_calibration(bins: list[dict], ticker: str) -> None:
    try:
        import matplotlib.pyplot as plt
    except ImportError:
        sys.exit("matplotlib не установлен: pip install matplotlib")
    xs = [b["mean_pred"] for b in bins if b["n"] > 0]
    ys = [b["mean_actual"] for b in bins if b["n"] > 0]
    ns = [b["n"] for b in bins if b["n"] > 0]
    fig, ax = plt.subplots(figsize=(7, 7))
    ax.plot([0, 1], [0, 1], "k--", alpha=0.4, label="идеальная калибровка")
    ax.scatter(xs, ys, s=[max(20, n / 5) for n in ns], alpha=0.7)
    for x, y, n in zip(xs, ys, ns):
        ax.annotate(f"n={n}", (x, y), textcoords="offset points",
                     xytext=(6, 6), fontsize=8)
    ax.set_xlabel("средний p_hold в корзине")
    ax.set_ylabel("фактическая доля target=1")
    ax.set_title(f"{ticker} — calibration diagram")
    ax.set_xlim(-0.02, 1.02); ax.set_ylim(-0.02, 1.02)
    ax.grid(True, alpha=0.3)
    plt.tight_layout()
    plt.show()


def _quadrant_thresholds(data: dict, args) -> tuple[float, float]:
    """Возвращает (t_lo, p_hi) с учётом --t-pctl/--p-pctl. Общая для single
    и batch, чтобы percentile считался одинаково."""
    t_lo, p_hi = args.t_lo, args.p_hi
    if args.t_pctl is not None:
        T_valid = data["T_hat"][~np.isnan(data["T_hat"])]
        P_valid = data["P_hat"][~np.isnan(data["P_hat"])]
        if len(T_valid) == 0 or len(P_valid) == 0:
            return t_lo, p_hi
        t_lo = float(np.percentile(T_valid, args.t_pctl))
        p_hi = float(np.percentile(P_valid, args.p_pctl))
    return t_lo, p_hi


def _eval_one_dataset(data: dict, args) -> Optional[dict]:
    """Прогоняет NW+eval на одном датасете (уже в numpy-формате). Возвращает
    метрики _evaluate + n_quad, или None если данных мало. Тихий (без print),
    для batch-режима."""
    t_lo, p_hi = _quadrant_thresholds(data, args)
    # Считаем n_quad до _run_nw, чтобы отфильтровать заранее (иначе _run_nw
    # делает sys.exit при <100 точек — в batch это убило бы весь прогон).
    T = data["T_hat"]; P = data["P_hat"]
    ok = data["outcome_known"] == 1.0
    valid = ok & ~np.isnan(T) & ~np.isnan(P) & ~np.isnan(data["color_hat"]) & ~np.isnan(data["target"])
    if args.quadrant_only:
        valid = valid & (T < t_lo) & (P > p_hi)
    n_quad = int(valid.sum())
    if n_quad < args.batch_min_points:
        return {"n_quad": n_quad, "skipped": True, "t_lo": t_lo, "p_hi": p_hi}
    try:
        result = _run_nw(data, h=args.h, neighbors=args.neighbors,
                          density_min=args.density_min, k=args.k,
                          quadrant_only=args.quadrant_only, t_lo=t_lo, p_hi=p_hi,
                          min_points=args.batch_min_points, quiet=True)
    except SystemExit:
        return {"n_quad": n_quad, "skipped": True, "t_lo": t_lo, "p_hi": p_hi}
    m = _evaluate(result, confidence=args.confidence, calibrate=args.calibrate)
    m["n_quad"] = n_quad
    m["t_lo"] = t_lo
    m["p_hi"] = p_hi
    m["skipped"] = False
    return m


def _run_batch(args) -> None:
    """Batch по всему кэшу (или списку). Для каждого тикера собирает датасет
    через tpcolor_dataset.build_dataset в памяти, прогоняет NW+calibrate,
    печатает одну сводную строку и копит в CSV. Главная проверка: работает
    ли механизм на тикерах ВНЕ отобранного ансамбля — универсальность vs
    подгонка под 25 избранных."""
    # Импортим из tpcolor_dataset — тот же расчёт осей, что в single-режиме.
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import tpcolor_dataset as tpc

    if args.tickers and args.tickers.upper() != "ALL":
        tickers = [t.strip().upper() for t in args.tickers.split(",") if t.strip()]
    else:
        tickers = tpc._list_tickers(args.cache, args.interval)
    print(f"тикеров к прогону: {len(tickers)}", file=sys.stderr)

    fieldnames = ["ticker", "n_hist", "n_quad", "t_lo", "p_hi",
                  "edge_raw", "win_raw", "sharpe_raw",
                  "edge_cal", "win_cal", "sharpe_cal",
                  "brier_raw", "brier_cal", "naive_brier",
                  "improve_cal_pct", "status"]
    out_path = args.out or "nw_batch.csv"
    fp = open(out_path, "w", encoding="utf-8", newline="")
    writer = csv.DictWriter(fp, fieldnames=fieldnames)
    writer.writeheader()

    rows_summary = []
    min_bars = max(args.tpc_n_macro, args.tpc_w_norm) + args.k + 5
    for idx, tk in enumerate(tickers, 1):
        try:
            candles = tpc._load_from_cache(tk, args.cache, args.interval)
        except SystemExit:
            continue
        if len(candles) < min_bars:
            print(f"[{idx:>4}/{len(tickers)}] {tk:<12} skip (мало баров: {len(candles)})",
                  file=sys.stderr)
            continue
        rows = tpc.build_dataset(candles, n=args.tpc_n, n_macro=args.tpc_n_macro,
                                  w_norm=args.tpc_w_norm, k=args.k)
        data = _dataset_from_rows(rows)
        m = _eval_one_dataset(data, args)
        n_hist = len(candles)
        if m is None or m.get("skipped"):
            nq = m["n_quad"] if m else 0
            writer.writerow({"ticker": tk, "n_hist": n_hist, "n_quad": nq,
                             "t_lo": f"{m['t_lo']:.3f}" if m else "",
                             "p_hi": f"{m['p_hi']:.3f}" if m else "",
                             "status": "skip_few_points"})
            fp.flush()
            print(f"[{idx:>4}/{len(tickers)}] {tk:<12} n_quad={nq:<4} — мало точек",
                  file=sys.stderr)
            continue

        er = m["edge_raw"]; ec = m["edge_cal"]
        def sh(e): return (e["mean"] / e["std"]) if (e and e["mean"] is not None and e["std"]) else None
        improve = ((1 - m["brier_cal"] / m["naive_brier"]) * 100
                   if m["brier_cal"] and m["naive_brier"] else None)
        row = {
            "ticker": tk, "n_hist": n_hist, "n_quad": m["n_quad"],
            "t_lo": f"{m['t_lo']:.3f}", "p_hi": f"{m['p_hi']:.3f}",
            "edge_raw": f"{er['mean']:+.4f}" if er and er["mean"] is not None else "",
            "win_raw": f"{er['win_rate']*100:.1f}" if er and er["win_rate"] is not None else "",
            "sharpe_raw": f"{sh(er):+.3f}" if sh(er) is not None else "",
            "edge_cal": f"{ec['mean']:+.4f}" if ec and ec["mean"] is not None else "",
            "win_cal": f"{ec['win_rate']*100:.1f}" if ec and ec["win_rate"] is not None else "",
            "sharpe_cal": f"{sh(ec):+.3f}" if sh(ec) is not None else "",
            "brier_raw": f"{m['brier_raw']:.4f}" if m["brier_raw"] is not None else "",
            "brier_cal": f"{m['brier_cal']:.4f}" if m["brier_cal"] is not None else "",
            "naive_brier": f"{m['naive_brier']:.4f}" if m["naive_brier"] is not None else "",
            "improve_cal_pct": f"{improve:+.1f}" if improve is not None else "",
            "status": "ok",
        }
        writer.writerow(row); fp.flush()
        rows_summary.append((tk, m, er, ec, sh))
        ec_str = (f"edge_cal={ec['mean']:+.3f} win={ec['win_rate']*100:.0f}%"
                  if ec and ec["mean"] is not None else "edge_cal=—")
        print(f"[{idx:>4}/{len(tickers)}] {tk:<12} n_quad={m['n_quad']:<4} {ec_str}",
              file=sys.stderr)

    fp.close()
    print(f"\nсводка: {out_path}", file=sys.stderr)

    # Финальная статистика: сколько тикеров с положительным edge_cal, медианы.
    ok_rows = [(tk, m, er, ec, sh) for (tk, m, er, ec, sh) in rows_summary
               if ec and ec["mean"] is not None]
    if not ok_rows:
        print("нет тикеров с валидной оценкой", file=sys.stderr)
        return
    def med(xs):
        xs = sorted(xs)
        return xs[len(xs)//2] if len(xs) % 2 else 0.5*(xs[len(xs)//2-1]+xs[len(xs)//2])

    # ВАЖНО: edge_cal раздут in-sample калибровкой (на чистом шуме тоже даёт
    # +0.7 ATR — проверено). Для честного сравнения между тикерами смотрим
    # edge_RAW: он без post-hoc подгонки. edge_cal показываем как «потолок».
    raw_edges = [er["mean"] for (_, _, er, _, _) in ok_rows
                 if er and er["mean"] is not None]
    raw_wins = [er["win_rate"] for (_, _, er, _, _) in ok_rows
                if er and er["win_rate"] is not None]
    cal_edges = [ec["mean"] for (_, _, _, ec, _) in ok_rows]
    n_raw_pos = sum(1 for e in raw_edges if e > 0)
    n_raw_strong = sum(1 for (_, _, er, _, _) in ok_rows
                        if er and er["mean"] is not None and er["mean"] > 0.3
                        and er["win_rate"] is not None and er["win_rate"] > 0.55)

    print(f"\n=== ИТОГ по {len(ok_rows)} тикерам с достаточной историей ===")
    print(f"── RAW (честная метрика для сравнения тикеров) ──")
    print(f"edge_raw > 0:                 {n_raw_pos}/{len(raw_edges)} "
          f"({n_raw_pos/max(len(raw_edges),1)*100:.0f}%)")
    print(f"edge_raw > 0.3 И win > 55%:   {n_raw_strong}/{len(ok_rows)} "
          f"({n_raw_strong/len(ok_rows)*100:.0f}%)")
    print(f"медиана edge_raw:             {med(raw_edges):+.4f} ATR")
    print(f"медиана win_raw:              {med(raw_wins)*100:.1f}%")
    print(f"── CAL (in-sample потолок, раздут — НЕ для сравнения) ──")
    print(f"медиана edge_cal:             {med(cal_edges):+.4f} ATR")
    print(f"\nГлавный вопрос: доля edge_RAW > 0 на всём пуле.")
    print(f"  ~50% → механизм не работает вне отобранного ансамбля (подгонка).")
    print(f"  сильно >50% → механизм универсальный.")
    print(f"ВНИМАНИЕ: обе метрики in-sample (нет walk-forward). Настоящая")
    print(f"проверка edge — обучение памяти на train, оценка на holdout.")


def main() -> None:
    ap = argparse.ArgumentParser(description="Прототип NW-памяти §11 T/P/color")
    ap.add_argument("csv_in", nargs="?", default=None,
                     help="CSV из tpcolor_dataset.py (single-режим). "
                          "В batch-режиме (--batch) не нужен.")
    ap.add_argument("--h", type=float, default=0.3, help="bandwidth ядра")
    ap.add_argument("--neighbors", type=int, default=200,
                     help="k ближайших для стартового отбора (не используется, "
                          "оставлено для совместимости; сейчас query_ball_point)")
    ap.add_argument("--density-min", type=float, default=3.0,
                     help="минимальный density для population-предсказания")
    ap.add_argument("--confidence", type=float, default=0.10,
                     help="порог |p_hold − 0.5| для «открыть позицию»")
    ap.add_argument("--k", type=int, default=12,
                     help="горизонт fwd_ret_k (должен совпадать с tpcolor_dataset)")
    ap.add_argument("--quadrant-only", action="store_true",
                     help="§8.3 локализация: искать соседей и предсказывать только "
                          "внутри квадранта (T̂<t_lo, P̂>p_hi). NW-память перестаёт "
                          "размывать сигнал по baseline'у.")
    ap.add_argument("--t-lo", type=float, default=-0.5,
                     help="верхняя граница T̂ для квадранта (default -0.5)")
    ap.add_argument("--p-hi", type=float, default=+0.5,
                     help="нижняя граница P̂ для квадранта (default +0.5)")
    ap.add_argument("--t-pctl", type=float, default=None,
                     help="ЛОКАЛЬНЫЙ порог: нижний процентиль T̂ этого тикера "
                          "(напр. 5 → нижние 5%%). Переопределяет --t-lo. "
                          "Пары --t-pctl/--p-pctl задаются совместно.")
    ap.add_argument("--p-pctl", type=float, default=None,
                     help="ЛОКАЛЬНЫЙ порог: верхний процентиль P̂ этого тикера "
                          "(напр. 90 → верхние 10%%). Переопределяет --p-hi.")
    ap.add_argument("--out", default=None, help="CSV с per-bar предсказаниями")
    ap.add_argument("--plot", action="store_true", help="показать calibration diagram")
    ap.add_argument("--calibrate", action="store_true",
                     help="Изотоническая калибровка (in-sample). Показывает "
                          "верхнюю границу того, что может дать post-hoc "
                          "калибровочный слой. Ставит sklearn — pip install "
                          "scikit-learn.")
    # ── Batch-режим по всему кэшу ──
    ap.add_argument("--batch", action="store_true",
                     help="Прогнать по всему кэшу (или --tickers). Собирает "
                          "датасет каждого тикера в памяти через "
                          "tpcolor_dataset.build_dataset, печатает сводную "
                          "таблицу. Проверка универсальности механизма вне "
                          "отобранного ансамбля.")
    ap.add_argument("--tickers", default="ALL",
                     help="batch: ALL (весь кэш) или список через запятую")
    ap.add_argument("--cache", default=os.path.join(
        os.path.dirname(os.path.abspath(__file__)), "data", "candle_cache"),
                     help="batch: путь к data/candle_cache")
    ap.add_argument("--interval", type=int, default=5, choices=(1, 5),
                     help="batch: интервал свечей")
    ap.add_argument("--batch-min-points", type=int, default=100,
                     help="batch: минимум точек в квадранте для оценки (default 100)")
    ap.add_argument("--tpc-n", type=int, default=20, help="batch: окно T/P/color")
    ap.add_argument("--tpc-n-macro", type=int, default=200, help="batch: макро-окно")
    ap.add_argument("--tpc-w-norm", type=int, default=500, help="batch: окно z-норм")
    args = ap.parse_args()

    if (args.t_pctl is None) != (args.p_pctl is None):
        sys.exit("--t-pctl и --p-pctl задаются либо оба, либо ни одного.")

    if args.batch:
        _run_batch(args)
        return

    if not args.csv_in:
        sys.exit("нужен csv_in (single-режим) или --batch")

    data = _load_dataset(args.csv_in)
    ticker = os.path.splitext(os.path.basename(args.csv_in))[0]
    print(f"датасет: {args.csv_in}, {len(data['T_hat'])} баров", file=sys.stderr)

    t_lo, p_hi = _quadrant_thresholds(data, args)
    if args.t_pctl is not None:
        print(f"per-ticker percentile: T̂ p{args.t_pctl}={t_lo:+.3f}, "
              f"P̂ p{args.p_pctl}={p_hi:+.3f}", file=sys.stderr)

    result = _run_nw(data, h=args.h, neighbors=args.neighbors,
                      density_min=args.density_min, k=args.k,
                      quadrant_only=args.quadrant_only,
                      t_lo=t_lo, p_hi=p_hi)
    m = _evaluate(result, confidence=args.confidence, calibrate=args.calibrate)
    _print_summary(m, ticker)
    _print_calibration(m["calibration_bins_raw"])
    if m.get("calibration_bins_cal") is not None:
        print("\n--- после изотонической калибровки ---")
        _print_calibration(m["calibration_bins_cal"])

    if args.out:
        _write_out(result, m, args.out)
        print(f"\nсохранено: {args.out}")

    if args.plot:
        _plot_calibration(m["calibration_bins_raw"], ticker)


if __name__ == "__main__":
    main()
