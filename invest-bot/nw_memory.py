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
             t_lo: float = -0.5, p_hi: float = 0.5) -> dict:
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

    if quadrant_only:
        print(f"quadrant-only режим: T̂<{t_lo:+.2f} и P̂>{p_hi:+.2f}", file=sys.stderr)
    print(f"валидных точек для памяти: {len(valid_idx)} из {n}", file=sys.stderr)
    if len(valid_idx) < 100:
        sys.exit("слишком мало валидных точек в квадранте — попробуй ослабить пороги --t-lo/--p-hi или увеличить историю")

    coords = np.column_stack([T[valid_idx], P[valid_idx], C[valid_idx]])
    tree = cKDTree(coords)
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


def _evaluate(result: dict, confidence: float) -> dict:
    """Собирает метрики. Возвращает {brier, base_rate, edge_stats, n_signal,
    n_no_precedent}."""
    p_hold = result["p_hold"]
    fwd = result["fwd"]
    tgt = result["tgt"]
    memory_type = result["memory_type"]

    # Пары (pred, actual) для калибровки: где мы что-то предсказали и знаем факт.
    preds = []; actuals = []
    for i in range(len(p_hold)):
        if memory_type[i] != "population":
            continue
        if np.isnan(tgt[i]):
            continue
        preds.append(float(p_hold[i]))
        actuals.append(1 if tgt[i] > 0 else 0)

    brier = _brier(preds, actuals)
    base_rate = sum(actuals) / len(actuals) if actuals else None
    naive_brier = (base_rate * (1 - base_rate)) if base_rate is not None else None

    # Реализованный edge: |p_hold − 0.5| > confidence → торгуем
    # direction = sign(p_hold − 0.5), realized = direction × fwd_ret_k
    edge_rets = []
    for i in range(len(p_hold)):
        if memory_type[i] != "population":
            continue
        if np.isnan(fwd[i]):
            continue
        gap = float(p_hold[i]) - 0.5
        if abs(gap) < confidence:
            continue
        direction = 1.0 if gap > 0 else -1.0
        edge_rets.append(direction * float(fwd[i]))

    edge_mean = sum(edge_rets) / len(edge_rets) if edge_rets else None
    edge_std = (
        math.sqrt(sum((r - edge_mean) ** 2 for r in edge_rets) / (len(edge_rets) - 1))
        if edge_rets and len(edge_rets) > 1 else None
    )
    win_rate = (sum(1 for r in edge_rets if r > 0) / len(edge_rets)
                if edge_rets else None)

    n_no_precedent = sum(1 for m in memory_type if m == "no_precedent")
    n_population = sum(1 for m in memory_type if m == "population")

    return {
        "brier": brier, "base_rate": base_rate, "naive_brier": naive_brier,
        "n_preds": len(preds),
        "edge_mean_atr": edge_mean, "edge_std_atr": edge_std,
        "edge_win_rate": win_rate, "n_signal": len(edge_rets),
        "n_population": n_population, "n_no_precedent": n_no_precedent,
        "calibration_bins": _calibration_bins(preds, actuals, 10),
    }


def _print_summary(m: dict, ticker: str) -> None:
    print(f"\n=== NW-память §11 — {ticker} ===")
    print(f"баров с предсказанием (population):  {m['n_preds']}")
    print(f"баров без прецедента (no_precedent): {m['n_no_precedent']}")
    print()
    if m["brier"] is None:
        print("не удалось посчитать метрики — недостаточно предсказаний")
        return
    print(f"Brier score      : {m['brier']:.4f}")
    print(f"Naive baseline   : {m['naive_brier']:.4f}  (константа = {m['base_rate']:.3f})")
    print(f"Улучшение к naive: {(1 - m['brier']/m['naive_brier'])*100:+.1f}%")
    print()
    print(f"=== Реализованный edge (|p_hold − 0.5| > threshold) ===")
    if m["edge_mean_atr"] is None:
        print("сигналов не набралось — снизь --confidence")
        return
    print(f"сигналов        : {m['n_signal']}")
    print(f"mean fwd_ret/ATR: {m['edge_mean_atr']:+.4f}  (положит. = система работает)")
    print(f"std             : {m['edge_std_atr']:.4f}")
    print(f"Sharpe-подобный : {m['edge_mean_atr']/m['edge_std_atr']:.3f}"
          if m['edge_std_atr'] else "  Sharpe — /0")
    print(f"win-rate        : {m['edge_win_rate']*100:.1f}%")


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


def main() -> None:
    ap = argparse.ArgumentParser(description="Прототип NW-памяти §11 T/P/color")
    ap.add_argument("csv_in", help="CSV из tpcolor_dataset.py")
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
    args = ap.parse_args()

    data = _load_dataset(args.csv_in)
    ticker = os.path.splitext(os.path.basename(args.csv_in))[0]
    print(f"датасет: {args.csv_in}, {len(data['T_hat'])} баров", file=sys.stderr)

    # Per-ticker процентильный режим: пороги считаем из локального
    # распределения — отвечает на «оси адаптируются, а не применяются
    # одним глобальным z для всех». Пары --t-pctl/--p-pctl задаются
    # совместно; если задан один, sys.exit.
    if (args.t_pctl is None) != (args.p_pctl is None):
        sys.exit("--t-pctl и --p-pctl задаются либо оба, либо ни одного.")
    t_lo, p_hi = args.t_lo, args.p_hi
    if args.t_pctl is not None:
        T_valid = data["T_hat"][~np.isnan(data["T_hat"])]
        P_valid = data["P_hat"][~np.isnan(data["P_hat"])]
        if len(T_valid) == 0 or len(P_valid) == 0:
            sys.exit("нет валидных T̂/P̂ для percentile-расчёта")
        t_lo = float(np.percentile(T_valid, args.t_pctl))
        p_hi = float(np.percentile(P_valid, args.p_pctl))
        print(f"per-ticker percentile: T̂ p{args.t_pctl}={t_lo:+.3f}, "
              f"P̂ p{args.p_pctl}={p_hi:+.3f}", file=sys.stderr)

    result = _run_nw(data, h=args.h, neighbors=args.neighbors,
                      density_min=args.density_min, k=args.k,
                      quadrant_only=args.quadrant_only,
                      t_lo=t_lo, p_hi=p_hi)
    m = _evaluate(result, confidence=args.confidence)
    _print_summary(m, ticker)
    _print_calibration(m["calibration_bins"])

    if args.out:
        _write_out(result, m, args.out)
        print(f"\nсохранено: {args.out}")

    if args.plot:
        _plot_calibration(m["calibration_bins"], ticker)


if __name__ == "__main__":
    main()
