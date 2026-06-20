import numpy as np
from scipy.optimize import minimize


def hawkes_processes(
    event_times: list | np.ndarray,
    T: float | None = None,
    decay_init: float = 1.0,
    alpha_init: float = 0.5,
    mu_init: float = 0.1,
) -> dict:
    """
    Фитирует одномерный процесс Хокса (Hawkes Process) на поток событий
    и определяет: настоящий ли это каскад или одиночный всплеск.

    Модель:
        λ(t) = μ + Σ_{t_i < t} α * exp(-decay * (t - t_i))

        μ     — базовая интенсивность (фоновый шум)
        α     — сила самовозбуждения (насколько одно событие порождает следующие)
        decay — скорость затухания влияния прошлых событий
        n     = α / decay — среднее число дочерних событий на одно родительское

    Интерпретация:
        n < 1  — процесс стационарный, всплески затухают → одиночный всплеск
        n ≥ 1  — процесс взрывной, каскад нарастает → настоящий каскад
        branching_ratio (n) — ключевой параметр: чем ближе к 1, тем опаснее каскад

    Args:
        event_times: Временные метки событий (в секундах или любых единицах).
                     Должны быть отсортированы по возрастанию.
        T:           Конец окна наблюдения. Если None — берётся max(event_times).
        decay_init:  Начальное значение decay для оптимизатора.
        alpha_init:  Начальное значение alpha для оптимизатора.
        mu_init:     Начальное значение mu для оптимизатора.

    Returns:
        dict с ключами:
            'mu'               — базовая интенсивность
            'alpha'            — сила самовозбуждения
            'decay'            — скорость затухания
            'branching_ratio'  — n = alpha/decay; <1 затухает, ≥1 каскад
            'classification'   — 'cascade' или 'isolated_spike'
            'confidence'       — уверенность классификации (0.0–1.0)
            'log_likelihood'   — значение лог-правдоподобия (качество фита)
    """
    times = np.sort(np.array(event_times, dtype=float))

    if len(times) < 5:
        raise ValueError("Слишком мало событий. Минимум 5.")

    if T is None:
        T = float(times[-1])

    def log_likelihood(params: np.ndarray) -> float:
        mu, alpha, decay = params
        if mu <= 0 or alpha <= 0 or decay <= 0:
            return 1e10

        n = len(times)
        # Рекурсивное вычисление вспомогательной переменной R
        # R[i] = Σ_{j<i} exp(-decay*(t_i - t_j))
        R = np.zeros(n)
        for i in range(1, n):
            R[i] = np.exp(-decay * (times[i] - times[i - 1])) * (1.0 + R[i - 1])

        # Интенсивности в моменты событий: λ(t_i) = μ + α*R[i]
        intensities = mu + alpha * R
        if np.any(intensities <= 0):
            return 1e10

        # Интеграл интенсивности ∫₀ᵀ λ(t)dt
        integral_R = np.sum((1.0 - np.exp(-decay * (T - times))) / decay)
        integral = mu * T + alpha * integral_R

        ll = np.sum(np.log(intensities)) - integral
        return -ll  # минимизируем отрицательное лог-правдоподобие

    result = minimize(
        log_likelihood,
        x0=[mu_init, alpha_init, decay_init],
        method="L-BFGS-B",
        bounds=[(1e-6, None), (1e-6, None), (1e-6, None)],
        options={"maxiter": 1000, "ftol": 1e-12},
    )

    mu_fit, alpha_fit, decay_fit = result.x
    branching_ratio = alpha_fit / decay_fit

    # Классификация
    if branching_ratio >= 1.0:
        classification = "cascade"
        # Уверенность растёт с ростом n выше 1
        confidence = round(min((branching_ratio - 1.0) / 1.0, 1.0), 4)
    else:
        classification = "isolated_spike"
        # Уверенность растёт по мере приближения n к 0
        confidence = round(1.0 - branching_ratio, 4)

    return {
        "mu": round(mu_fit, 6),
        "alpha": round(alpha_fit, 6),
        "decay": round(decay_fit, 6),
        "branching_ratio": round(branching_ratio, 4),
        "classification": classification,
        "confidence": round(confidence, 4),
        "log_likelihood": round(-result.fun, 4),
    }


# ---------------------------------------------------------------------------
# Пример использования
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    rng = np.random.default_rng(42)

    # Одиночный всплеск: редкие независимые события (пуассоновский процесс)
    isolated = np.sort(rng.uniform(0, 100, 30))
    res = hawkes_processes(isolated)
    print("Одиночный всплеск:")
    for k, v in res.items():
        print(f"  {k}: {v}")

    print()

    # Каскад: кластеризованные события с нарастающей активностью
    base = np.sort(rng.uniform(0, 100, 10))
    children = []
    for t in base:
        n_children = rng.integers(3, 8)
        children.extend(t + rng.exponential(0.5, n_children))
    cascade = np.sort(np.concatenate([base, children]))
    cascade = cascade[cascade <= 100]

    res = hawkes_processes(cascade)
    print("Каскад:")
    for k, v in res.items():
        print(f"  {k}: {v}")
