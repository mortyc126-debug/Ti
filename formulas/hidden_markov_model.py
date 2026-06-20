"""
Hidden Markov Model (HMM) — Определение режима рынка
========================================================
HMM моделирует рынок как переключение между N скрытыми состояниями
(режимами), каждое из которых порождает наблюдаемые доходности с
собственным распределением (Гауссовым: μ_k, σ_k).

Скрытые состояния (по умолчанию 3):
    0 — Trend Down  (отрицательный дрейф, повышенная волатильность)
    1 — Range/Flat  (дрейф ≈ 0, низкая волатильность)
    2 — Trend Up    (положительный дрейф, повышенная волатильность)

Модель оценивается на исторических доходностях через EM-алгоритм
(Baum-Welch), текущий режим определяется через Forward-Backward
(сглаженные апостериорные вероятности) или Viterbi (наиболее вероятная
последовательность состояний).

Применение в трейдинге:
    — Классификация текущего рыночного режима без свечных паттернов
    — Вероятность каждого режима → confidence для риск-менеджмента
    — Матрица переходов → ожидаемая устойчивость текущего режима
    — Точки переключения режима → фильтр для входа/выхода
"""

import numpy as np
from typing import Optional


# ---------------------------------------------------------------------------
# Вспомогательные функции
# ---------------------------------------------------------------------------

def log_returns(prices: np.ndarray) -> np.ndarray:
    """Логарифмические доходности из массива цен."""
    return np.diff(np.log(np.asarray(prices, dtype=float)))


def _gaussian_pdf(x: np.ndarray, mean: float, var: float) -> np.ndarray:
    """Плотность нормального распределения (численно устойчивая)."""
    var = max(var, 1e-12)
    coef = 1.0 / np.sqrt(2.0 * np.pi * var)
    return coef * np.exp(-0.5 * (x - mean) ** 2 / var)


def _init_params_by_quantile(obs: np.ndarray, n_states: int) -> tuple[np.ndarray, np.ndarray]:
    """
    Инициализация средних и дисперсий состояний по квантилям наблюдений.
    Для 3 состояний это естественно даёт упорядочивание
    [down, flat, up] по среднему.
    """
    qs = np.linspace(0, 100, n_states + 1)
    edges = np.percentile(obs, qs)
    means = np.zeros(n_states)
    variances = np.zeros(n_states)

    for k in range(n_states):
        lo, hi = edges[k], edges[k + 1]
        mask = (obs >= lo) & (obs <= hi) if k == n_states - 1 else (obs >= lo) & (obs < hi)
        bucket = obs[mask]
        if len(bucket) < 2:
            bucket = obs
        means[k] = np.mean(bucket)
        variances[k] = np.var(bucket) + 1e-8

    return means, variances


# ---------------------------------------------------------------------------
# Baum-Welch (EM) — обучение параметров HMM
# ---------------------------------------------------------------------------

def fit_hmm(
    observations: np.ndarray,
    n_states: int = 3,
    n_iter: int = 100,
    tol: float = 1e-6,
    seed: Optional[int] = 42,
) -> dict:
    """
    Обучает Gaussian HMM на одномерных наблюдениях (доходностях)
    через алгоритм Баума-Велша (EM).

    Parameters
    ----------
    observations : 1-D array наблюдений (обычно log-доходности)
    n_states     : число скрытых состояний (по умолчанию 3)
    n_iter       : максимум итераций EM
    tol          : порог сходимости по log-likelihood
    seed         : seed для воспроизводимости инициализации

    Returns
    -------
    dict:
        means, variances   — параметры Гауссовых распределений по состояниям
        transmat           — матрица переходов (n_states x n_states)
        startprob           — начальное распределение состояний
        loglik_history      — история log-likelihood по итерациям
        state_order         — индексы состояний, отсортированные по mean (down→up)
    """
    obs = np.asarray(observations, dtype=float)
    T = len(obs)

    if T < n_states * 5:
        raise ValueError(f"Слишком мало наблюдений ({T}) для {n_states} состояний.")

    rng = np.random.default_rng(seed)

    means, variances = _init_params_by_quantile(obs, n_states)
    transmat = np.full((n_states, n_states), 1.0 / n_states)
    # Лёгкое смещение к самопереходам — рыночные режимы персистентны
    transmat += np.eye(n_states) * 0.3
    transmat /= transmat.sum(axis=1, keepdims=True)

    startprob = np.full(n_states, 1.0 / n_states)

    loglik_history = []
    prev_ll = -np.inf

    for iteration in range(n_iter):
        # --- E-step: Forward-Backward ---
        B = np.column_stack([_gaussian_pdf(obs, means[k], variances[k]) for k in range(n_states)])
        B = np.clip(B, 1e-300, None)

        alpha = np.zeros((T, n_states))
        c = np.zeros(T)  # масштабирующие коэффициенты

        alpha[0] = startprob * B[0]
        c[0] = alpha[0].sum()
        alpha[0] /= c[0]

        for t in range(1, T):
            alpha[t] = (alpha[t - 1] @ transmat) * B[t]
            c[t] = alpha[t].sum()
            if c[t] < 1e-300:
                c[t] = 1e-300
            alpha[t] /= c[t]

        beta = np.zeros((T, n_states))
        beta[-1] = 1.0
        for t in range(T - 2, -1, -1):
            beta[t] = (transmat @ (B[t + 1] * beta[t + 1])) / c[t + 1]

        loglik = np.sum(np.log(c))
        loglik_history.append(float(loglik))

        gamma = alpha * beta
        gamma /= gamma.sum(axis=1, keepdims=True)

        xi_sum = np.zeros((n_states, n_states))
        for t in range(T - 1):
            denom = c[t + 1]
            xi_t = (alpha[t][:, None] * transmat * B[t + 1][None, :] * beta[t + 1][None, :]) / denom
            xi_sum += xi_t

        # --- M-step ---
        startprob = gamma[0] / gamma[0].sum()

        new_transmat = xi_sum / np.maximum(gamma[:-1].sum(axis=0)[:, None], 1e-300)
        new_transmat /= new_transmat.sum(axis=1, keepdims=True)
        transmat = new_transmat

        gamma_sum = gamma.sum(axis=0)
        new_means = (gamma * obs[:, None]).sum(axis=0) / np.maximum(gamma_sum, 1e-300)
        new_vars = (gamma * (obs[:, None] - new_means[None, :]) ** 2).sum(axis=0) / np.maximum(gamma_sum, 1e-300)
        new_vars = np.maximum(new_vars, 1e-8)

        means, variances = new_means, new_vars

        if abs(loglik - prev_ll) < tol:
            break
        prev_ll = loglik

    # Упорядочивание состояний по среднему (down → flat → up)
    state_order = np.argsort(means)

    return {
        "means":           means,
        "variances":       variances,
        "transmat":        transmat,
        "startprob":       startprob,
        "loglik_history":  loglik_history,
        "state_order":     state_order,
        "n_states":        n_states,
    }


# ---------------------------------------------------------------------------
# Forward-Backward — сглаженные апостериорные вероятности
# ---------------------------------------------------------------------------

def forward_backward(observations: np.ndarray, model: dict) -> np.ndarray:
    """
    Вычисляет сглаженные апостериорные вероятности состояний P(state_t | all obs)
    для каждого момента времени.

    Parameters
    ----------
    observations : 1-D array наблюдений
    model         : dict из fit_hmm()

    Returns
    -------
    gamma : 2-D array (T, n_states) — апостериорные вероятности
    """
    obs = np.asarray(observations, dtype=float)
    T = len(obs)
    n_states = model["n_states"]
    means, variances = model["means"], model["variances"]
    transmat, startprob = model["transmat"], model["startprob"]

    B = np.column_stack([_gaussian_pdf(obs, means[k], variances[k]) for k in range(n_states)])
    B = np.clip(B, 1e-300, None)

    alpha = np.zeros((T, n_states))
    c = np.zeros(T)
    alpha[0] = startprob * B[0]
    c[0] = alpha[0].sum()
    alpha[0] /= max(c[0], 1e-300)

    for t in range(1, T):
        alpha[t] = (alpha[t - 1] @ transmat) * B[t]
        c[t] = alpha[t].sum()
        if c[t] < 1e-300:
            c[t] = 1e-300
        alpha[t] /= c[t]

    beta = np.zeros((T, n_states))
    beta[-1] = 1.0
    for t in range(T - 2, -1, -1):
        beta[t] = (transmat @ (B[t + 1] * beta[t + 1])) / c[t + 1]

    gamma = alpha * beta
    gamma /= gamma.sum(axis=1, keepdims=True)
    return gamma


# ---------------------------------------------------------------------------
# Viterbi — наиболее вероятная последовательность состояний
# ---------------------------------------------------------------------------

def viterbi(observations: np.ndarray, model: dict) -> np.ndarray:
    """
    Алгоритм Витерби — находит наиболее вероятную (жёсткую) последовательность
    скрытых состояний для всего ряда наблюдений.

    Parameters
    ----------
    observations : 1-D array наблюдений
    model         : dict из fit_hmm()

    Returns
    -------
    path : 1-D array длиной T — индекс наиболее вероятного состояния в каждый момент
    """
    obs = np.asarray(observations, dtype=float)
    T = len(obs)
    n_states = model["n_states"]
    means, variances = model["means"], model["variances"]
    transmat, startprob = model["transmat"], model["startprob"]

    log_trans = np.log(np.maximum(transmat, 1e-300))
    log_start = np.log(np.maximum(startprob, 1e-300))

    B = np.column_stack([_gaussian_pdf(obs, means[k], variances[k]) for k in range(n_states)])
    log_B = np.log(np.maximum(B, 1e-300))

    delta = np.zeros((T, n_states))
    psi = np.zeros((T, n_states), dtype=int)

    delta[0] = log_start + log_B[0]

    for t in range(1, T):
        for j in range(n_states):
            scores = delta[t - 1] + log_trans[:, j]
            psi[t, j] = np.argmax(scores)
            delta[t, j] = scores[psi[t, j]] + log_B[t, j]

    path = np.zeros(T, dtype=int)
    path[-1] = np.argmax(delta[-1])
    for t in range(T - 2, -1, -1):
        path[t] = psi[t + 1, path[t + 1]]

    return path


# ---------------------------------------------------------------------------
# Маппинг состояний в человекочитаемые режимы (для n_states=3)
# ---------------------------------------------------------------------------

def map_state_labels(model: dict) -> dict:
    """
    Сопоставляет индексы состояний с метками режима по упорядоченному
    среднему (актуально для n_states=3: down/flat/up).

    Returns
    -------
    dict: {state_index: label}
    """
    n_states = model["n_states"]
    order = model["state_order"]  # индексы, отсортированные по mean (low→high)

    if n_states == 3:
        labels = ["trend_down", "flat", "trend_up"]
    elif n_states == 2:
        labels = ["flat_or_down", "trend_up"]
    else:
        labels = [f"state_{i}" for i in range(n_states)]

    return {int(order[i]): labels[i] for i in range(n_states)}


# ---------------------------------------------------------------------------
# Интерпретация
# ---------------------------------------------------------------------------

def interpret_hmm_state(
    model: dict,
    current_state: int,
    current_probs: np.ndarray,
) -> dict:
    """
    Торговая интерпретация текущего режима рынка.

    Parameters
    ----------
    model          : dict из fit_hmm()
    current_state  : наиболее вероятное текущее состояние (int)
    current_probs  : вектор апостериорных вероятностей для текущего момента

    Returns
    -------
    dict: regime, confidence, signal, expected_persistence,
          state_mean, state_vol, notes
    """
    labels = map_state_labels(model)
    regime = labels.get(current_state, f"state_{current_state}")
    confidence = float(current_probs[current_state])

    state_mean = float(model["means"][current_state])
    state_vol = float(np.sqrt(model["variances"][current_state]))

    # Ожидаемая устойчивость режима: 1 / (1 - P(остаться в том же состоянии))
    p_stay = float(model["transmat"][current_state, current_state])
    expected_persistence = 1.0 / max(1e-6, 1 - p_stay)

    # --- Сигнал ---
    if confidence < 0.50:
        signal = "LOW_CONFIDENCE_NEUTRAL"
    elif regime == "trend_up":
        signal = "TREND_LONG_BIAS"
    elif regime == "trend_down":
        signal = "TREND_SHORT_BIAS"
    elif regime == "flat":
        signal = "RANGE_MEAN_REVERSION"
    else:
        signal = "NEUTRAL"

    notes = []
    if confidence < 0.40:
        notes.append("ambiguous_state: probabilities are spread across regimes")
    if expected_persistence < 3:
        notes.append("low_persistence: regime likely to switch soon")
    if expected_persistence > 30:
        notes.append("high_persistence: regime expected to be sticky")

    return {
        "regime":                regime,
        "confidence":            round(confidence, 4),
        "signal":                signal,
        "expected_persistence":  round(expected_persistence, 2),
        "state_mean":            round(state_mean, 6),
        "state_vol":             round(state_vol, 6),
        "notes":                 notes,
    }


# ---------------------------------------------------------------------------
# Полный пайплайн
# ---------------------------------------------------------------------------

def hmm_signal(
    series: np.ndarray,
    window: Optional[int] = None,
    n_states: int = 3,
    use_returns: bool = True,
    n_iter: int = 100,
    decoding: str = "smoothed",
    seed: Optional[int] = 42,
) -> dict:
    """
    Универсальная точка входа: ряд → HMM-модель + текущий режим + интерпретация.

    Parameters
    ----------
    series      : временной ряд цен (или готовых доходностей, если use_returns=False)
    window      : если задан — берёт последние `window` точек ряда ПЕРЕД расчётом доходностей
    n_states    : число скрытых состояний (по умолчанию 3: down/flat/up)
    use_returns : True = считать series ценами и брать log-доходности;
                  False = series уже является рядом наблюдений
    n_iter      : итерации EM-алгоритма
    decoding    : 'smoothed' (Forward-Backward, апостериорные вероятности) |
                  'viterbi' (наиболее вероятная жёсткая последовательность)
    seed        : seed инициализации

    Returns
    -------
    dict: model summary, current_state, state_probs, path (если viterbi),
          интерпретация текущего режима
    """
    s = np.asarray(series, dtype=float)
    if window is not None:
        s = s[-window:]

    obs = log_returns(s) if use_returns else s

    model = fit_hmm(obs, n_states=n_states, n_iter=n_iter, seed=seed)
    labels = map_state_labels(model)

    if decoding == "viterbi":
        path = viterbi(obs, model)
        current_state = int(path[-1])
        # Псевдо-вероятности (one-hot) для совместимости интерпретации
        probs = np.zeros(n_states)
        probs[current_state] = 1.0
        decoded_path = path
    else:
        gamma = forward_backward(obs, model)
        current_state = int(np.argmax(gamma[-1]))
        probs = gamma[-1]
        decoded_path = None

    interp = interpret_hmm_state(model, current_state, probs)

    state_summary = []
    for k in range(n_states):
        state_summary.append({
            "state_index": k,
            "label":       labels[k],
            "mean":        round(float(model["means"][k]), 6),
            "vol":         round(float(np.sqrt(model["variances"][k])), 6),
            "p_self_transition": round(float(model["transmat"][k, k]), 4),
        })

    result = {
        "n_states":         n_states,
        "decoding":         decoding,
        "current_state":    current_state,
        "state_probs":      {labels[k]: round(float(probs[k]), 4) for k in range(n_states)},
        "state_summary":    state_summary,
        "transmat":         model["transmat"].round(4).tolist(),
        "loglik":           round(model["loglik_history"][-1], 4) if model["loglik_history"] else None,
        **interp,
        "_model": model,  # сырая модель для дальнейшего использования (прогноз, rolling)
    }

    if decoded_path is not None:
        result["_path"] = decoded_path

    return result


# ---------------------------------------------------------------------------
# Rolling HMM (для живого потока — переобучение на скользящем окне)
# ---------------------------------------------------------------------------

def rolling_hmm(
    series: np.ndarray,
    window: int = 300,
    step: int = 20,
    n_states: int = 3,
    n_iter: int = 50,
    seed: Optional[int] = 42,
) -> list[dict]:
    """
    Скользящий HMM: переобучает модель на каждом окне и определяет
    текущий режим. Подходит для живого потока, где параметры режимов
    рынка со временем дрейфуют.

    Parameters
    ----------
    series   : временной ряд цен
    window   : размер окна для обучения (в барах цен)
    step     : шаг сдвига окна
    n_states : число скрытых состояний
    n_iter   : итерации EM на каждом окне (меньше, чем в одиночном вызове —
               для скорости)
    seed     : seed инициализации

    Returns
    -------
    results : список dict-ов (без сырой модели) + индекс конца окна
    """
    series = np.asarray(series, dtype=float)
    n = len(series)
    results = []

    for end in range(window, n + 1, step):
        start = end - window
        try:
            res = hmm_signal(series[start:end], n_states=n_states,
                             n_iter=n_iter, seed=seed)
            results.append({
                "index":               end - 1,
                "regime":              res["regime"],
                "confidence":          res["confidence"],
                "signal":              res["signal"],
                "expected_persistence":res["expected_persistence"],
                "state_probs":         res["state_probs"],
            })
        except (ValueError, np.linalg.LinAlgError):
            pass

    return results


# ---------------------------------------------------------------------------
# Применение готовой модели к новым данным (без переобучения)
# ---------------------------------------------------------------------------

def apply_hmm(
    series: np.ndarray,
    model: dict,
    use_returns: bool = True,
    decoding: str = "smoothed",
) -> dict:
    """
    Применяет уже обученную модель (из fit_hmm() или hmm_signal()['_model'])
    к новым данным без переобучения параметров — быстрее для live-инференса.

    Parameters
    ----------
    series      : новый временной ряд цен (или доходностей)
    model       : dict из fit_hmm()
    use_returns : True = series — цены, считать log-доходности
    decoding    : 'smoothed' | 'viterbi'

    Returns
    -------
    dict: current_state, state_probs, интерпретация
    """
    s = np.asarray(series, dtype=float)
    obs = log_returns(s) if use_returns else s

    labels = map_state_labels(model)
    n_states = model["n_states"]

    if decoding == "viterbi":
        path = viterbi(obs, model)
        current_state = int(path[-1])
        probs = np.zeros(n_states)
        probs[current_state] = 1.0
    else:
        gamma = forward_backward(obs, model)
        current_state = int(np.argmax(gamma[-1]))
        probs = gamma[-1]

    interp = interpret_hmm_state(model, current_state, probs)

    return {
        "current_state": current_state,
        "state_probs":   {labels[k]: round(float(probs[k]), 4) for k in range(n_states)},
        **interp,
    }


# ---------------------------------------------------------------------------
# Пример использования
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    np.random.seed(42)

    # --- Синтетический ряд с явными режимами: up → flat → down → up ---
    def gen_regime(n, mu, sigma):
        return np.random.normal(mu, sigma, n)

    rets = np.concatenate([
        gen_regime(150, 0.0015, 0.006),   # trend up
        gen_regime(150, 0.0000, 0.003),   # flat
        gen_regime(150, -0.0015, 0.007),  # trend down
        gen_regime(150, 0.0012, 0.006),   # trend up снова
    ])
    prices = 100 * np.cumprod(1 + rets)

    # --- Обучение + сглаженное декодирование ---
    res = hmm_signal(prices, n_states=3, decoding="smoothed")

    print("Состояния модели:")
    for st in res["state_summary"]:
        print(f"  {st['label']:12s} | mean={st['mean']:+.5f} | "
              f"vol={st['vol']:.5f} | P(self)={st['p_self_transition']}")

    print(f"\nТекущий режим: {res['regime']} "
          f"(confidence={res['confidence']})")
    print(f"Вероятности: {res['state_probs']}")
    print(f"Ожидаемая устойчивость режима: {res['expected_persistence']} баров")
    print(f"Signal: {res['signal']}")
    print(f"Log-likelihood: {res['loglik']}")

    # --- Viterbi для всей истории — посмотреть смену режимов ---
    res_v = hmm_signal(prices, n_states=3, decoding="viterbi")
    path = res_v["_path"]
    labels = map_state_labels(res_v["_model"])
    label_path = [labels[s] for s in path]

    # Точки смены режима
    switches = [i for i in range(1, len(label_path)) if label_path[i] != label_path[i - 1]]
    print(f"\nТочки смены режима (Viterbi): {switches[:10]}")
    print(f"Финальный режим (Viterbi): {label_path[-1]}")

    # --- Rolling HMM ---
    rolling = rolling_hmm(prices, window=200, step=30, n_iter=40)
    if rolling:
        print("\nRolling HMM (последние 3 окна):")
        for r in rolling[-3:]:
            print(f"  idx={r['index']}: regime={r['regime']}, "
                  f"conf={r['confidence']}, signal={r['signal']}")
