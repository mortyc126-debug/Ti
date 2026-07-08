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

# Windows-консоль по умолчанию cp1251 — падает на типографском минусе (U+2212),
# кириллице в pipe и символах T̂/P̂. Форсируем UTF-8 вывод; на платформах без
# reconfigure (или уже UTF-8) — no-op.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):
        pass

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
             k: int, zone_mask=None,
             min_points: int = 100, quiet: bool = False) -> dict:
    """Ядро прогона: для каждой i считает p_hold, density, memory_type.
    Возвращает per-bar массивы + метаинформацию.

    zone_mask (per-bar bool, True = точка в зоне) — если задан, и целевая
    точка, и соседи ограничены зоной. Гипотеза §8.3: эффект концентрируется
    в углу (T,P)-пространства, а глобально размывается. Локализуем поиск —
    NW-память перестаёт усреднять сигнал по baseline'у. Зона строится
    вызывающим (лоу-T/хай-P квадрант или любой другой, см. ZONES)."""
    T = data["T_hat"]; P = data["P_hat"]; C = data["color_hat"]
    fwd = data["fwd_ret_k"]; tgt = data["target"]
    ok = data["outcome_known"] == 1.0
    n = len(T)

    # Индекс: только точки с outcome_known + все три координаты валидны.
    valid_mask = ok & ~np.isnan(T) & ~np.isnan(P) & ~np.isnan(C) & ~np.isnan(tgt)
    if zone_mask is not None:
        valid_mask = valid_mask & zone_mask
    valid_idx = np.where(valid_mask)[0]

    if not quiet:
        print(f"валидных точек для памяти: {len(valid_idx)} из {n}", file=sys.stderr)
    if len(valid_idx) < min_points:
        sys.exit("слишком мало валидных точек в зоне — ослабь пороги (--t-pctl/--p-pctl) или увеличь историю")

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
        # В зонном режиме предсказываем только для точек в зоне.
        # Вне зоны — memory_type="outside_zone", p_hold остаётся NaN.
        if zone_mask is not None and not zone_mask[i]:
            memory_type[i] = "outside_zone"
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


def _evaluate(result: dict, confidence: float, calibrate: bool = False,
               split_idx: Optional[int] = None) -> dict:
    """Собирает метрики. Если calibrate=True — изотоническая регрессия.

    Walk-forward (split_idx задан): калибровка ОБУЧАЕТСЯ только на барах
    i < split_idx (train), а ВСЕ метрики (Brier, edge, calibration bins)
    считаются только на барах i >= split_idx (holdout). Это честная
    out-of-sample оценка: модель не видела holdout ни при построении
    памяти (лукахед-фильтр j+k≤i уже это гарантирует), ни при калибровке.

    Без split_idx — прежнее in-sample поведение (калибровка и метрики на
    всех предсказаниях)."""
    p_hold = result["p_hold"]
    fwd = result["fwd"]
    tgt = result["tgt"]
    memory_type = result["memory_type"]

    # Пары (pred, actual) с разбивкой train/holdout.
    preds = []; actuals = []; valid_idxs = []
    is_holdout = []       # для каждой валидной точки: True если i >= split_idx
    for i in range(len(p_hold)):
        if memory_type[i] != "population":
            continue
        if np.isnan(tgt[i]):
            continue
        preds.append(float(p_hold[i]))
        actuals.append(1 if tgt[i] > 0 else 0)
        valid_idxs.append(i)
        is_holdout.append(split_idx is not None and i >= split_idx)

    # Калибровка: fit на train (или на всём, если split_idx=None).
    calibrated = None
    if calibrate and preds and _SKLEARN_AVAILABLE:
        if split_idx is not None:
            train_p = [preds[j] for j in range(len(preds)) if not is_holdout[j]]
            train_a = [actuals[j] for j in range(len(preds)) if not is_holdout[j]]
        else:
            train_p, train_a = preds, actuals
        if len(train_p) >= 10:
            ir = IsotonicRegression(out_of_bounds="clip")
            ir.fit(np.array(train_p), np.array(train_a))
            calibrated = ir.predict(np.array(preds)).tolist()
    elif calibrate and not _SKLEARN_AVAILABLE:
        print("⚠ --calibrate требует sklearn (pip install scikit-learn), "
              "калибровка пропущена", file=sys.stderr)

    # Маска точек, по которым СЧИТАЕМ метрики: holdout при walk-forward,
    # иначе все.
    if split_idx is not None:
        metric_js = [j for j in range(len(preds)) if is_holdout[j]]
    else:
        metric_js = list(range(len(preds)))

    m_preds = [preds[j] for j in metric_js]
    m_actuals = [actuals[j] for j in metric_js]
    m_calibrated = ([calibrated[j] for j in metric_js]
                    if calibrated is not None else None)

    brier_raw = _brier(m_preds, m_actuals)
    base_rate = sum(m_actuals) / len(m_actuals) if m_actuals else None
    naive_brier = (base_rate * (1 - base_rate)) if base_rate is not None else None

    def _edge_stats(preds_src, js):
        rets = []
        for local, j in enumerate(js):
            i = valid_idxs[j]
            if np.isnan(fwd[i]):
                continue
            gap = preds_src[local] - 0.5
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

    edge_raw = _edge_stats(m_preds, metric_js)
    edge_cal = _edge_stats(m_calibrated, metric_js) if m_calibrated is not None else None
    brier_cal = _brier(m_calibrated, m_actuals) if m_calibrated is not None else None

    n_no_precedent = sum(1 for mm in memory_type if mm == "no_precedent")
    n_population = sum(1 for mm in memory_type if mm == "population")

    return {
        "brier_raw": brier_raw, "brier_cal": brier_cal,
        "base_rate": base_rate, "naive_brier": naive_brier,
        "n_preds": len(m_preds),
        "n_train": len(preds) - len(metric_js) if split_idx is not None else None,
        "walk_forward": split_idx is not None,
        "edge_raw": edge_raw, "edge_cal": edge_cal,
        "n_population": n_population, "n_no_precedent": n_no_precedent,
        "calibration_bins_raw": _calibration_bins(m_preds, m_actuals, 10),
        "calibration_bins_cal": (_calibration_bins(m_calibrated, m_actuals, 10)
                                   if m_calibrated is not None else None),
    }


def _print_summary(m: dict, ticker: str) -> None:
    wf = m.get("walk_forward")
    tag = " [WALK-FORWARD — holdout]" if wf else ""
    print(f"\n=== NW-память §11 — {ticker}{tag} ===")
    if wf:
        print(f"калибровка обучена на train: {m['n_train']} баров")
        print(f"метрики на holdout:          {m['n_preds']} баров (модель не видела)")
    else:
        print(f"баров с предсказанием (population):  {m['n_preds']}")
    print(f"баров без прецедента (no_precedent): {m['n_no_precedent']}")
    print()
    if m["brier_raw"] is None:
        print("не удалось посчитать метрики — недостаточно предсказаний")
        return
    cal_tag = "(изотоническая, holdout)" if m.get("walk_forward") else "(изотоническая, in-sample)"
    print(f"Brier raw          : {m['brier_raw']:.4f}")
    if m["brier_cal"] is not None:
        print(f"Brier calibrated   : {m['brier_cal']:.4f}  {cal_tag}")
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


def _split_index(data: dict, train_frac: Optional[float]) -> Optional[int]:
    """Индекс раздела train/holdout по времени. None если walk-forward выкл."""
    if not train_frac:
        return None
    n = len(data["T_hat"])
    return int(n * train_frac)


# Зоны (T,P)-пространства для локализации поиска. Каждая — список условий
# (ось, направление): 'lo' = ниже percentile(pctl), 'hi' = выше
# percentile(100-pctl). Документ §3/§8.3 обсуждает разные углы поверхности;
# это позволяет проверить не только «низкая T + высокая P», а все квадранты.
ZONES = {
    "lowT_highP":  [("T", "lo"), ("P", "hi")],   # §8.3 базовый (тонкий грайндинг)
    "lowT_lowP":   [("T", "lo"), ("P", "lo")],   # тихий шум/поглощение
    "highT_highP": [("T", "hi"), ("P", "hi")],   # наполненный направленный рывок
    "highT_lowP":  [("T", "hi"), ("P", "lo")],   # высокая активность без прогресса
    "lowT":        [("T", "lo")],                # только низкая T (P любая)
    "highT":       [("T", "hi")],
    "highP":       [("P", "hi")],
    "lowP":        [("P", "lo")],
}


def _zone_conditions(data: dict, zone: str, t_pctl: Optional[float],
                      p_pctl: Optional[float],
                      split_idx: Optional[int] = None) -> list:
    """Для зоны считает конкретные пороги: [(ось, направление, thr), ...].
    Percentile берётся по train-части при walk-forward (иначе граница
    подглядывает в holdout).

    pctl трактуется БУКВАЛЬНО как линия отреза: thr = percentile(pctl), для
    'lo' берём точки НИЖЕ, для 'hi' — ВЫШЕ. Если pctl не задан (None),
    дефолт по направлению: lo→5 (нижние 5%), hi→95 (верхние 5%) — так для
    любой зоны без ручных порогов берётся симметричный 5% хвост нужной
    стороны. Явный --t-pctl/--p-pctl переопределяет (напр. p_pctl=90 на
    lowT_highP = старое поведение «верхние 10%»)."""
    out = []
    for axis, direction in ZONES[zone]:
        arr = data["T_hat"] if axis == "T" else data["P_hat"]
        user_pctl = t_pctl if axis == "T" else p_pctl
        if user_pctl is None:
            pctl = 5.0 if direction == "lo" else 95.0
        else:
            pctl = user_pctl
        a = arr[:split_idx] if split_idx is not None else arr
        a = a[~np.isnan(a)]
        if len(a) == 0:
            continue
        thr = float(np.percentile(a, pctl))
        out.append((axis, direction, thr))
    return out


def _zone_mask(data: dict, conds: list):
    """Boolean per-bar маска: True где точка удовлетворяет всем условиям зоны."""
    T = data["T_hat"]; P = data["P_hat"]
    mask = np.ones(len(T), dtype=bool)
    for axis, direction, thr in conds:
        arr = T if axis == "T" else P
        with np.errstate(invalid="ignore"):
            mask &= (arr < thr) if direction == "lo" else (arr > thr)
    # NaN в arr даёт False в сравнении — точки с невалидной осью выпадут, ок.
    return mask


def _zone_desc(conds: list) -> str:
    parts = []
    for axis, direction, thr in conds:
        sym = "T̂" if axis == "T" else "P̂"
        op = "<" if direction == "lo" else ">"
        parts.append(f"{sym}{op}{thr:+.2f}")
    return " & ".join(parts)


def _eval_one_dataset(data: dict, args) -> Optional[dict]:
    """Прогоняет NW+eval на одном датасете (уже в numpy-формате). Возвращает
    метрики _evaluate + n_quad, или None если данных мало. Тихий (без print),
    для batch-режима."""
    split_idx = _split_index(data, getattr(args, "train_frac", None))
    zone = getattr(args, "zone", "lowT_highP")
    use_zone = args.quadrant_only
    conds = _zone_conditions(data, zone, args.t_pctl, args.p_pctl,
                              split_idx) if use_zone else []
    # Если зону запросили, но порог удалось задать НЕ для всех осей (train-часть
    # по оси сплошь NaN — короткая история короче окна нормировки w_norm),
    # зона фактически не применится (пустое условие → маска всё-True) и «edge»
    # посчитается по ВСЕМ барам. Такой тикер не сравним с остальными — честнее
    # пропустить, чем пускать в сводку неотфильтрованный шум (короткие фьючерсы
    # давали ±4…13 ATR, одинаковые во всех зонах). См. NW_MEMORY_FINDINGS.
    if use_zone and len(conds) < len(ZONES[zone]):
        return {"n_quad": 0, "skipped": True, "zone_desc": "",
                "zone_undefined": True}
    zmask = _zone_mask(data, conds) if use_zone else None

    T = data["T_hat"]; P = data["P_hat"]
    ok = data["outcome_known"] == 1.0
    valid = ok & ~np.isnan(T) & ~np.isnan(P) & ~np.isnan(data["color_hat"]) & ~np.isnan(data["target"])
    if zmask is not None:
        valid = valid & zmask
    n_quad = int(valid.sum())
    zdesc = _zone_desc(conds) if conds else ""
    if n_quad < args.batch_min_points:
        return {"n_quad": n_quad, "skipped": True, "zone_desc": zdesc}
    try:
        result = _run_nw(data, h=args.h, neighbors=args.neighbors,
                          density_min=args.density_min, k=args.k,
                          zone_mask=zmask,
                          min_points=args.batch_min_points, quiet=True)
    except SystemExit:
        return {"n_quad": n_quad, "skipped": True, "zone_desc": zdesc}
    m = _evaluate(result, confidence=args.confidence, calibrate=args.calibrate,
                   split_idx=split_idx)
    m["n_quad"] = n_quad
    m["zone_desc"] = zdesc
    m["skipped"] = False
    return m


def _liq_vol(candles: list) -> tuple:
    """Грубые прокси ликвидности и волатильности тикера по свечам:
    - liq  = медианный барный оборот close·volume, в млн (единицы volume
      как в кэше — для РАНЖИРОВАНИЯ тикеров между собой этого достаточно);
    - vol  = медианный относительный диапазон бара (high-low)/close, в %.
    Медиана — чтобы не ловить единичные всплески. Нужны, чтобы проверить,
    зависит ли работоспособность метода от ликвидности/волатильности."""
    turn = []
    rng = []
    for c in candles:
        cl = float(c["close"])
        if cl <= 0:
            continue
        turn.append(cl * float(c["volume"]))
        rng.append((float(c["high"]) - float(c["low"])) / cl)
    if not turn:
        return (None, None)
    liq = float(np.median(turn)) / 1e6
    vol = float(np.median(rng)) * 100.0
    return (liq, vol)


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

    fieldnames = ["ticker", "n_hist", "n_quad", "zone", "liq_mln", "vol_pct",
                  "edge_raw", "win_raw", "sharpe_raw",
                  "edge_cal", "win_cal", "sharpe_cal",
                  "brier_raw", "brier_cal", "naive_brier",
                  "improve_cal_pct", "status"]
    out_path = args.out or "nw_batch.csv"
    fp = open(out_path, "w", encoding="utf-8", newline="")
    writer = csv.DictWriter(fp, fieldnames=fieldnames)
    writer.writeheader()

    rows_summary = []
    tk_lv = {}  # ticker -> (liq_mln, vol_pct, n_hist); edge↔ликв/волат/история
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
        liq, vol = _liq_vol(candles)
        liq_s = f"{liq:.2f}" if liq is not None else ""
        vol_s = f"{vol:.3f}" if vol is not None else ""
        rows = tpc.build_dataset(candles, n=args.tpc_n, n_macro=args.tpc_n_macro,
                                  w_norm=args.tpc_w_norm, k=args.k)
        data = _dataset_from_rows(rows)
        m = _eval_one_dataset(data, args)
        n_hist = len(candles)
        if m is None or m.get("skipped"):
            nq = m["n_quad"] if m else 0
            writer.writerow({"ticker": tk, "n_hist": n_hist, "n_quad": nq,
                             "zone": m.get("zone_desc", "") if m else "",
                             "liq_mln": liq_s, "vol_pct": vol_s,
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
            "zone": m.get("zone_desc", ""),
            "liq_mln": liq_s, "vol_pct": vol_s,
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
        tk_lv[tk] = (liq, vol, n_hist)
        # Прогресс по RAW (без --calibrate ec=None) — raw и есть честная
        # OOS-метрика при --train-frac; калибровка OOS не помогает.
        wf = " [holdout]" if m.get("walk_forward") else ""
        raw_str = (f"edge_raw={er['mean']:+.3f} win={er['win_rate']*100:.0f}%"
                   if er and er["mean"] is not None else "edge_raw=—")
        print(f"[{idx:>4}/{len(tickers)}] {tk:<12} n_quad={m['n_quad']:<4} {raw_str}{wf}",
              file=sys.stderr)

    fp.close()
    print(f"\nсводка: {out_path}", file=sys.stderr)

    # Валидные для итога — по edge_RAW (работает и без --calibrate).
    ok_rows = [(tk, m, er, ec, sh) for (tk, m, er, ec, sh) in rows_summary
               if er and er["mean"] is not None]
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
    cal_edges = [ec["mean"] for (_, _, _, ec, _) in ok_rows
                 if ec and ec["mean"] is not None]
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
    if cal_edges:
        print(f"── CAL (in-sample потолок, раздут — НЕ для сравнения) ──")
        print(f"медиана edge_cal:             {med(cal_edges):+.4f} ATR")
    wf_any = any(m.get("walk_forward") for (_, m, _, _, _) in ok_rows)
    print()
    if wf_any:
        print(f"WALK-FORWARD (holdout): доля edge_raw > 0 = {n_raw_pos}/{len(raw_edges)}")
        print(f"  Это ЧЕСТНАЯ out-of-sample метрика. Сильно >50% и медиана")
        print(f"  edge_raw заметно >0 → класс реально работает вне выборки.")
    else:
        print(f"Главный вопрос: доля edge_raw > 0 на пуле.")
        print(f"  ВНИМАНИЕ: метрики in-sample (без --train-frac). Для честной")
        print(f"  оценки добавь --train-frac 0.6.")

    _liq_vol_report(ok_rows, tk_lv)


def _corr(xs, ys):
    """Пирсон + Спирмен (ранговый). Спирмен устойчивее к выбросам/нелинейности.
    None если точек мало или нет разброса."""
    x = np.asarray(xs, float); y = np.asarray(ys, float)
    ok = ~np.isnan(x) & ~np.isnan(y)
    x, y = x[ok], y[ok]
    if len(x) < 5 or np.std(x) == 0 or np.std(y) == 0:
        return (None, None, len(x))
    pear = float(np.corrcoef(x, y)[0, 1])
    rx = np.argsort(np.argsort(x)); ry = np.argsort(np.argsort(y))
    spear = float(np.corrcoef(rx, ry)[0, 1])
    return (pear, spear, len(x))


def _liq_vol_report(ok_rows, tk_lv) -> None:
    """Есть ли связь между ликвидностью/волатильностью тикера и тем, насколько
    работает метод (edge_raw)? Считаем корреляции и режем пул на трети по
    ликвидности — так видно и монотонную зависимость, и нелинейную (напр.
    'работает только на средних, а топ-ликвиды инвертированы' = SBER-класс).

    ВАЖНЫЙ конфаунд: неликвидные тикеры обычно и по истории короче. Если
    edge растёт на неликвиде, надо проверить, не тянет ли это на самом деле
    длина истории (короткая история → шумный edge → более экстремальные
    медианы). Поэтому тут же считаем edge↔история и ликвидность↔история:
    если ликв↔история сильная — эти два фактора неразделимы на этих данных."""
    def _lv(tk):
        v = tk_lv.get(tk, (None, None, None))
        return v if len(v) == 3 else (v[0], v[1], None)
    rows = [(tk, er["mean"], _lv(tk))
            for (tk, m, er, ec, sh) in ok_rows
            if er and er["mean"] is not None and _lv(tk)[0] is not None]
    if len(rows) < 5:
        return
    edges = [e for (_, e, _) in rows]
    liqs = [lv[0] for (_, _, lv) in rows]
    vols = [lv[1] for (_, _, lv) in rows]
    nhs = [lv[2] for (_, _, lv) in rows]
    log_liq = [math.log10(x) for x in liqs]

    print("\n── Зависимость edge_raw от ликвидности / волатильности ──")
    pe, sp, n = _corr(log_liq, edges)
    if pe is not None:
        print(f"edge_raw ↔ log10(ликвидность): Pearson {pe:+.2f}  Spearman {sp:+.2f}  (n={n})")
    pe, sp, n = _corr(vols, edges)
    if pe is not None:
        print(f"edge_raw ↔ волатильность:      Pearson {pe:+.2f}  Spearman {sp:+.2f}  (n={n})")

    # Конфаунд «длина истории»: edge↔история и ликвидность↔история.
    has_nh = all(x is not None for x in nhs)
    if has_nh:
        log_nh = [math.log10(x) for x in nhs]
        pe, sp, n = _corr(log_nh, edges)
        if pe is not None:
            print(f"edge_raw ↔ log10(история): Pearson {pe:+.2f}  Spearman {sp:+.2f}  (n={n})")
        pe, sp, n = _corr(log_nh, log_liq)
        if pe is not None:
            print(f"ликвидность ↔ история:     Pearson {pe:+.2f}  Spearman {sp:+.2f}  (n={n})")
            print("  (если ликв↔история сильная — фактор ликвидности и длины")
            print("   истории на этих данных неразделимы: нужна докачка коротких.)")

    def med(xs):
        xs = sorted(xs); n = len(xs)
        return xs[n//2] if n % 2 else 0.5*(xs[n//2-1]+xs[n//2])

    def _thirds(key_vals, label):
        order = sorted(range(len(rows)), key=lambda i: key_vals[i])
        t = len(order) // 3
        bands = [(f"низкая {label}", order[:t]), ("средняя", order[t:2*t]),
                 (f"высокая {label}", order[2*t:])]
        print(f"  медиана edge_raw по третям ({label}):")
        for name, idxs in bands:
            if not idxs:
                continue
            es = [edges[i] for i in idxs]
            pos = sum(1 for e in es if e > 0)
            mnh = med([nhs[i] for i in idxs]) if has_nh else None
            nh_str = f", медиана истории {mnh:.0f} бар" if mnh is not None else ""
            print(f"    {name:<16} медиана {med(es):+.3f} ATR, "
                  f"edge>0 {pos}/{len(es)} ({pos/len(es)*100:.0f}%){nh_str}")

    # Трети по ликвидности (с медианой истории в каждой — сразу видно конфаунд).
    _thirds(liqs, "ликв.")
    # Трети по истории — если edge так же растёт от короткой к длинной, значит
    # дело в истории, а не в ликвидности.
    if has_nh:
        _thirds(nhs, "история")
    print("  (Spearman ~0 при разной медиане по третям = немонотонная связь,")
    print("   напр. топ-ликвиды инвертированы — SBER-класс.)")


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
                          "внутри зоны (--zone). NW-память перестаёт размывать "
                          "сигнал по baseline'у.")
    ap.add_argument("--zone", default="lowT_highP",
                     choices=list(ZONES.keys()),
                     help="какой угол (T,P)-пространства проверять (при "
                          "--quadrant-only). lowT_highP — базовый §8.3; другие "
                          "квадранты: lowT_lowP, highT_highP, highT_lowP; "
                          "одноосевые: lowT/highT/highP/lowP. default lowT_highP")
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
                     help="Изотоническая калибровка. Без --train-frac — "
                          "in-sample (потолок). С --train-frac — обучается "
                          "на train, применяется к holdout (честно). Ставит "
                          "sklearn.")
    ap.add_argument("--train-frac", type=float, default=None,
                     help="Walk-forward: первые FRAC баров (напр. 0.6) — train "
                          "(память+калибровка+percentile-пороги), последние "
                          "(1-FRAC) — holdout, на котором меряются ВСЕ метрики. "
                          "Честная out-of-sample оценка. Без флага — прежнее "
                          "in-sample поведение.")
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

    split_idx = _split_index(data, args.train_frac)
    if split_idx is not None:
        print(f"walk-forward: train=[0:{split_idx}]  holdout=[{split_idx}:"
              f"{len(data['T_hat'])}]", file=sys.stderr)

    zmask = None
    if args.quadrant_only:
        conds = _zone_conditions(data, args.zone, args.t_pctl, args.p_pctl, split_idx)
        zmask = _zone_mask(data, conds)
        src = " (по train)" if split_idx is not None else ""
        print(f"зона '{args.zone}'{src}: {_zone_desc(conds)}  "
              f"(точек: {int(zmask.sum())})", file=sys.stderr)

    result = _run_nw(data, h=args.h, neighbors=args.neighbors,
                      density_min=args.density_min, k=args.k, zone_mask=zmask)
    m = _evaluate(result, confidence=args.confidence, calibrate=args.calibrate,
                   split_idx=split_idx)
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
