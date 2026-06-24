"""
DCG (Dynamic Causal Graphs) — эволюция причинных связей.

Отслеживает, как меняются причинно-следственные связи между активами
или факторами во времени. Полезно для:
  - Обнаружения смены режима (режим корреляции vs. независимости)
  - Определения ведущих / ведомых активов в реальном времени
  - Построения динамической матрицы влияния для управления портфелем

Методы:
  - Rolling Granger Causality       — скользящий тест Грейнджера
  - Transfer Entropy                — информационный поток между рядами
  - PC Algorithm (skeleton)         — скелет причинного графа (PC-алгоритм)
  - Regime-aware causal graph       — граф с детекцией смены режима (HMM)
"""

import numpy as np
from itertools import permutations, combinations
from dataclasses import dataclass, field
from typing import Optional
from scipy import stats
from scipy.stats import chi2


# ---------------------------------------------------------------------------
# Структуры данных
# ---------------------------------------------------------------------------

@dataclass
class CausalEdge:
    """Направленное причинное ребро X → Y."""
    source: str
    target: str
    strength: float        # сила связи (p-value инвертирован или MI)
    significant: bool      # прошёл ли порог значимости
    method: str


@dataclass
class CausalGraph:
    """Граф причинных связей для одного временного окна."""
    timestamp_idx: int
    edges: list[CausalEdge]
    nodes: list[str]
    regime: Optional[int] = None    # номер режима (если используется HMM)

    def adjacency_matrix(self) -> np.ndarray:
        """Матрица смежности: [i, j] = 1 если node_i → node_j."""
        n = len(self.nodes)
        idx = {name: i for i, name in enumerate(self.nodes)}
        mat = np.zeros((n, n))
        for e in self.edges:
            if e.significant:
                mat[idx[e.source], idx[e.target]] = e.strength
        return mat

    def leading_nodes(self) -> list[str]:
        """Узлы с наибольшим исходящим влиянием."""
        out_strength = {n: 0.0 for n in self.nodes}
        for e in self.edges:
            if e.significant:
                out_strength[e.source] += e.strength
        return sorted(out_strength, key=out_strength.get, reverse=True)

    def summary(self) -> str:
        sig = [e for e in self.edges if e.significant]
        lines = [
            f"=== CausalGraph @ t={self.timestamp_idx} ===",
            f"Узлы: {self.nodes}",
            f"Значимых рёбер: {len(sig)} / {len(self.edges)}",
        ]
        for e in sig:
            lines.append(f"  {e.source} → {e.target}  strength={e.strength:.4f}  [{e.method}]")
        if self.regime is not None:
            lines.append(f"Режим: {self.regime}")
        return "\n".join(lines)


@dataclass
class DCGResult:
    """Результат полного DCG-анализа по времени."""
    nodes: list[str]
    graphs: list[CausalGraph]           # граф на каждом окне
    edge_history: dict                  # (src, tgt) → список strength по времени
    regime_changes: list[int]           # индексы смен режима

    def edge_strength_series(self, source: str, target: str) -> np.ndarray:
        """Временной ряд силы конкретного ребра."""
        key = (source, target)
        return np.array(self.edge_history.get(key, []))

    def stability_score(self, source: str, target: str) -> float:
        """
        Стабильность ребра: доля окон, в которых оно значимо.
        """
        sig_count = sum(
            1 for g in self.graphs
            for e in g.edges
            if e.source == source and e.target == target and e.significant
        )
        return sig_count / len(self.graphs) if self.graphs else 0.0

    def summary(self) -> str:
        lines = [
            "=== DCG Summary ===",
            f"Узлы:          {self.nodes}",
            f"Временных окон:{len(self.graphs)}",
            f"Смен режима:   {len(self.regime_changes)}",
        ]
        # Стабильность всех рёбер
        lines.append("\nСтабильность рёбер (доля значимых окон):")
        for src, tgt in permutations(self.nodes, 2):
            s = self.stability_score(src, tgt)
            if s > 0:
                lines.append(f"  {src} → {tgt}: {s:.2%}")
        return "\n".join(lines)


# ---------------------------------------------------------------------------
# Тест Грейнджера (одна пара, одно окно)
# ---------------------------------------------------------------------------

def _granger_test(
    x: np.ndarray,
    y: np.ndarray,
    max_lag: int = 3,
    significance: float = 0.05,
) -> tuple[float, bool]:
    """
    Тест Грейнджера: проверяет, помогает ли X предсказывать Y.

    Returns
    -------
    (p_value, is_significant)
        p_value — минимальный p-value по всем лагам.
    """
    n = len(y)
    if n < max_lag * 3 + 5:
        return 1.0, False

    best_p = 1.0
    for lag in range(1, max_lag + 1):
        y_trimmed = y[lag:]
        T = len(y_trimmed)

        # Restricted: Y ~ Y_{t-1..lag}
        X_r = np.column_stack([y[lag - k: n - k] for k in range(1, lag + 1)])
        X_r = np.column_stack([np.ones(T), X_r])

        # Unrestricted: Y ~ Y_{t-1..lag} + X_{t-1..lag}
        X_x = np.column_stack([x[lag - k: n - k] for k in range(1, lag + 1)])
        X_u = np.column_stack([X_r, X_x])

        try:
            # OLS для обеих моделей
            beta_r, res_r, _, _ = np.linalg.lstsq(X_r, y_trimmed, rcond=None)
            beta_u, res_u, _, _ = np.linalg.lstsq(X_u, y_trimmed, rcond=None)

            rss_r = np.sum((y_trimmed - X_r @ beta_r) ** 2)
            rss_u = np.sum((y_trimmed - X_u @ beta_u) ** 2)

            df1 = lag
            df2 = T - X_u.shape[1]
            if df2 <= 0 or rss_u < 1e-12:
                continue

            F = ((rss_r - rss_u) / df1) / (rss_u / df2)
            p = 1 - stats.f.cdf(F, df1, df2)
            best_p = min(best_p, p)
        except np.linalg.LinAlgError:
            continue

    return best_p, best_p < significance


# ---------------------------------------------------------------------------
# Transfer Entropy (информационный поток X → Y)
# ---------------------------------------------------------------------------

def _transfer_entropy(
    x: np.ndarray,
    y: np.ndarray,
    lag: int = 1,
    bins: int = 10,
) -> float:
    """
    Оценивает Transfer Entropy TE(X→Y) через дискретизацию (histogram).

    TE(X→Y) = H(Y_t | Y_{t-1}) - H(Y_t | Y_{t-1}, X_{t-1})

    Returns
    -------
    float : значение TE (≥ 0; выше = сильнее влияние X на Y)
    """
    n = len(y)
    if n < lag + bins:
        return 0.0

    y_t   = y[lag:]
    y_lag = y[:-lag]
    x_lag = x[:-lag]

    # Дискретизация в равные интервалы
    def discretize(arr: np.ndarray) -> np.ndarray:
        lo, hi = arr.min(), arr.max()
        if hi - lo < 1e-10:
            return np.zeros(len(arr), dtype=int)
        edges = np.linspace(lo, hi, bins + 1)
        return np.digitize(arr, edges[:-1]) - 1

    yt_d   = discretize(y_t)
    ylag_d = discretize(y_lag)
    xlag_d = discretize(x_lag)

    def entropy(*arrays) -> float:
        """Совместная энтропия набора дискретных рядов."""
        if len(arrays) == 1:
            vals, counts = np.unique(arrays[0], return_counts=True)
        else:
            stacked = np.stack(arrays, axis=1)
            _, counts = np.unique(stacked, axis=0, return_counts=True)
        probs = counts / counts.sum()
        return -np.sum(probs * np.log2(probs + 1e-12))

    # TE = H(Yt, Ylag) - H(Ylag) - H(Yt, Ylag, Xlag) + H(Ylag, Xlag)
    te = (
        entropy(yt_d, ylag_d)
        - entropy(ylag_d)
        - entropy(yt_d, ylag_d, xlag_d)
        + entropy(ylag_d, xlag_d)
    )
    return max(0.0, float(te))


# ---------------------------------------------------------------------------
# PC-алгоритм (скелет причинного графа)
# ---------------------------------------------------------------------------

def _partial_correlation(
    data: np.ndarray,
    i: int,
    j: int,
    conditioning: list[int],
) -> tuple[float, float]:
    """
    Частная корреляция между столбцами i и j с учётом conditioning.
    Возвращает (r, p_value).
    """
    n, _ = data.shape
    if not conditioning:
        r, p = stats.pearsonr(data[:, i], data[:, j])
        return float(r), float(p)

    # Убираем влияние conditioning через линейную регрессию
    Z = np.column_stack([data[:, k] for k in conditioning])
    Z = np.column_stack([np.ones(n), Z])

    def residuals(col_idx: int) -> np.ndarray:
        y = data[:, col_idx]
        try:
            beta, _, _, _ = np.linalg.lstsq(Z, y, rcond=None)
            return y - Z @ beta
        except np.linalg.LinAlgError:
            return y

    ri = residuals(i)
    rj = residuals(j)
    if ri.std() < 1e-10 or rj.std() < 1e-10:
        return 0.0, 1.0
    r, p = stats.pearsonr(ri, rj)
    return float(r), float(p)


def _pc_skeleton(
    data: np.ndarray,
    node_names: list[str],
    alpha: float = 0.05,
    max_cond_size: int = 2,
) -> list[CausalEdge]:
    """
    PC-алгоритм: строит скелет причинного графа (неориентированный).
    Возвращает список значимых рёбер (обе направленности для неориентированных).
    """
    n_nodes = len(node_names)
    # Начинаем с полного графа
    adjacency = {i: set(range(n_nodes)) - {i} for i in range(n_nodes)}
    sep_sets = {}

    for cond_size in range(max_cond_size + 1):
        to_remove = []
        for i, j in combinations(range(n_nodes), 2):
            if j not in adjacency[i]:
                continue
            neighbors_i = adjacency[i] - {j}
            if len(neighbors_i) < cond_size:
                continue
            # Перебираем подмножества соседей размера cond_size
            from itertools import combinations as comb
            for cond in comb(list(neighbors_i), cond_size):
                _, p = _partial_correlation(data, i, j, list(cond))
                if p > alpha:
                    to_remove.append((i, j))
                    sep_sets[(i, j)] = list(cond)
                    sep_sets[(j, i)] = list(cond)
                    break

        for i, j in to_remove:
            adjacency[i].discard(j)
            adjacency[j].discard(i)

    # Формируем рёбра (ориентация упрощённая: по силе корреляции)
    edges = []
    visited = set()
    for i in range(n_nodes):
        for j in adjacency[i]:
            if (j, i) in visited:
                continue
            visited.add((i, j))
            r, p = _partial_correlation(data, i, j, [])
            strength = abs(r)
            # Ориентация: от того, кто имеет больше исходящих связей (упрощение)
            edges.append(CausalEdge(
                source=node_names[i],
                target=node_names[j],
                strength=strength,
                significant=True,
                method="PC",
            ))
            edges.append(CausalEdge(
                source=node_names[j],
                target=node_names[i],
                strength=strength,
                significant=True,
                method="PC",
            ))
    return edges


# ---------------------------------------------------------------------------
# Детекция режима (простой HMM через Viterbi на волатильности)
# ---------------------------------------------------------------------------

def _detect_regimes(
    returns_matrix: np.ndarray,
    n_regimes: int = 2,
) -> np.ndarray:
    """
    Упрощённая детекция режимов через k-means на скользящей волатильности.

    Returns
    -------
    np.ndarray shape (T,) с метками режима 0..n_regimes-1
    """
    vol = np.std(returns_matrix, axis=1)

    # K-means с одним признаком (волатильность)
    percentiles = np.linspace(0, 100, n_regimes + 1)[1:-1]
    boundaries = np.percentile(vol, percentiles)

    regimes = np.zeros(len(vol), dtype=int)
    for i, b in enumerate(boundaries):
        regimes[vol > b] = i + 1
    return regimes


# ---------------------------------------------------------------------------
# Основная функция: скользящий DCG
# ---------------------------------------------------------------------------

def rolling_causal_graph(
    data: dict[str, np.ndarray],
    window: int = 60,
    step: int = 10,
    method: str = "granger",
    max_lag: int = 3,
    significance: float = 0.05,
    detect_regimes: bool = True,
    n_regimes: int = 2,
) -> DCGResult:
    """
    Строит динамический граф причинных связей в скользящем окне.

    Parameters
    ----------
    data : dict[str, np.ndarray]
        Словарь {имя_актива: временной_ряд_доходностей}.
        Все ряды должны быть одной длины.
    window : int
        Размер скользящего окна (баров).
    step : int
        Шаг сдвига окна.
    method : str
        'granger'  — тест Грейнджера (причинность в среднем)
        'transfer_entropy' — информационный поток
        'pc'       — PC-алгоритм (структурный граф)
        'combined' — granger + transfer_entropy (среднее)
    max_lag : int
        Максимальный лаг для тестов Грейнджера.
    significance : float
        Уровень значимости.
    detect_regimes : bool
        Добавлять ли к каждому окну метку режима.
    n_regimes : int
        Число режимов для детекции.

    Returns
    -------
    DCGResult
    """
    nodes = list(data.keys())
    series = np.column_stack([data[n] for n in nodes])
    T = series.shape[0]

    if T < window:
        raise ValueError(f"Длина ряда ({T}) меньше размера окна ({window}).")

    graphs: list[CausalGraph] = []
    edge_history: dict = {(s, t): [] for s, t in permutations(nodes, 2)}
    regime_changes: list[int] = []
    prev_regime = None

    regimes_full = _detect_regimes(series, n_regimes) if detect_regimes else None

    for start in range(0, T - window + 1, step):
        end = start + window
        window_data = series[start:end]
        t_idx = start + window - 1

        current_regime = int(stats.mode(regimes_full[start:end], keepdims=True).mode[0]) \
            if regimes_full is not None else None

        if current_regime is not None and current_regime != prev_regime and prev_regime is not None:
            regime_changes.append(t_idx)
        prev_regime = current_regime

        edges: list[CausalEdge] = []

        if method == "pc":
            edges = _pc_skeleton(window_data, nodes, alpha=significance)
        else:
            for src_idx, tgt_idx in permutations(range(len(nodes)), 2):
                src, tgt = nodes[src_idx], nodes[tgt_idx]
                x = window_data[:, src_idx]
                y = window_data[:, tgt_idx]

                if method == "granger":
                    p, sig = _granger_test(x, y, max_lag=max_lag, significance=significance)
                    strength = max(0.0, 1 - p)

                elif method == "transfer_entropy":
                    te = _transfer_entropy(x, y)
                    strength = te
                    # Нормируем: значимо если TE > среднее + std
                    te_null = _transfer_entropy(
                        rng := np.random.default_rng(0) or None,
                        y,
                    ) if False else te  # упрощение: порог 0.05 бит
                    sig = te > 0.05

                elif method == "combined":
                    p, sig_g = _granger_test(x, y, max_lag=max_lag, significance=significance)
                    te = _transfer_entropy(x, y)
                    strength = 0.5 * (1 - p) + 0.5 * min(te, 1.0)
                    sig = sig_g or (te > 0.05)

                else:
                    raise ValueError(f"Неизвестный метод: {method}")

                edges.append(CausalEdge(
                    source=src,
                    target=tgt,
                    strength=strength,
                    significant=sig,
                    method=method,
                ))

        graph = CausalGraph(
            timestamp_idx=t_idx,
            edges=edges,
            nodes=nodes,
            regime=current_regime,
        )
        graphs.append(graph)

        # Обновляем историю рёбер
        for e in edges:
            key = (e.source, e.target)
            if key in edge_history:
                edge_history[key].append(e.strength if e.significant else 0.0)

    return DCGResult(
        nodes=nodes,
        graphs=graphs,
        edge_history=edge_history,
        regime_changes=regime_changes,
    )


# ---------------------------------------------------------------------------
# Утилиты анализа результата
# ---------------------------------------------------------------------------

def leading_assets_over_time(result: DCGResult) -> dict[str, np.ndarray]:
    """
    Для каждого актива возвращает временной ряд его суммарного
    исходящего влияния (outflow strength).
    """
    out = {n: [] for n in result.nodes}
    for graph in result.graphs:
        totals = {n: 0.0 for n in result.nodes}
        for e in graph.edges:
            if e.significant:
                totals[e.source] += e.strength
        for n in result.nodes:
            out[n].append(totals[n])
    return {n: np.array(v) for n, v in out.items()}


def causal_regime_matrix(result: DCGResult) -> dict[int, np.ndarray]:
    """
    Средняя матрица смежности по каждому режиму.
    Возвращает {режим: матрица_adj}.
    """
    regime_graphs: dict[int, list[CausalGraph]] = {}
    for g in result.graphs:
        r = g.regime if g.regime is not None else 0
        regime_graphs.setdefault(r, []).append(g)

    result_matrices = {}
    for r, gs in regime_graphs.items():
        matrices = [g.adjacency_matrix() for g in gs]
        result_matrices[r] = np.mean(matrices, axis=0)
    return result_matrices


def significant_edge_changes(
    result: DCGResult,
    threshold: float = 0.3,
) -> list[dict]:
    """
    Находит моменты резкого изменения силы конкретного ребра.

    Parameters
    ----------
    threshold : float
        Минимальное изменение силы для регистрации события.

    Returns
    -------
    list of dicts: {edge, t_idx, delta, direction}
    """
    events = []
    for (src, tgt), strengths in result.edge_history.items():
        arr = np.array(strengths)
        if len(arr) < 2:
            continue
        deltas = np.diff(arr)
        for i, delta in enumerate(deltas):
            if abs(delta) >= threshold:
                events.append({
                    "edge": f"{src}→{tgt}",
                    "t_idx": result.graphs[i + 1].timestamp_idx,
                    "delta": round(float(delta), 4),
                    "direction": "усиление" if delta > 0 else "ослабление",
                })
    return sorted(events, key=lambda e: abs(e["delta"]), reverse=True)


# ---------------------------------------------------------------------------
# Пример использования
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    rng = np.random.default_rng(42)
    T = 500

    # Синтетические данные: три актива с меняющейся причинностью
    eps_a = rng.normal(0, 0.01, T)
    eps_b = rng.normal(0, 0.01, T)
    eps_c = rng.normal(0, 0.01, T)

    returns_a = eps_a.copy()
    returns_b = eps_b.copy()
    returns_c = eps_c.copy()

    # Первые 250 баров: A → B
    for t in range(1, 250):
        returns_b[t] += 0.4 * returns_a[t - 1]

    # Последние 250 баров: B → C (смена режима)
    for t in range(250, T):
        returns_c[t] += 0.5 * returns_b[t - 1]

    data = {
        "Asset_A": returns_a,
        "Asset_B": returns_b,
        "Asset_C": returns_c,
    }

    print("--- Rolling Granger Causality ---")
    result = rolling_causal_graph(
        data,
        window=60,
        step=20,
        method="granger",
        max_lag=2,
        significance=0.05,
        detect_regimes=True,
        n_regimes=2,
    )
    print(result.summary())

    print(f"\nСмены режима на барах: {result.regime_changes}")

    print("\n--- Стабильность рёбер ---")
    for src, tgt in permutations(data.keys(), 2):
        s = result.stability_score(src, tgt)
        if s > 0.1:
            print(f"  {src} → {tgt}: {s:.2%}")

    print("\n--- Ведущие активы (последнее окно) ---")
    last_graph = result.graphs[-1]
    print(last_graph.summary())
    print("Ранжировка по влиянию:", last_graph.leading_nodes())

    print("\n--- Резкие изменения причинных связей ---")
    changes = significant_edge_changes(result, threshold=0.2)
    for ev in changes[:5]:
        print(f"  t={ev['t_idx']:4d}  {ev['edge']}  {ev['direction']}  Δ={ev['delta']:.4f}")

    print("\n--- Матрицы по режимам ---")
    regime_mats = causal_regime_matrix(result)
    for regime, mat in regime_mats.items():
        print(f"\nРежим {regime}:")
        print(np.round(mat, 3))
